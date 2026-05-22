# TODO: Python agent-mode runtime（让 OpenSkill 真的能跑 Anthropic 格式的 skill）

> 状态：待开工
> 创建：2026-05-22
> 上一次会话里和用户对齐了 B 路线的设计，这份文档是给"新会话冷启动"用的——读完它就能直接动手，不依赖任何对话上下文。

---

## 一、背景

当前的 OpenSkill 已经能：
- 上传/审核/订阅 Anthropic 格式的 skill（commit `074ffa8` 起的 MVP）
- 在浏览器里点 **Run** 跑 `scripts/run.js` 输出文件（commit `9b4cb75`）
- 在 Chat 里让 LLM 通过 `run_skill` 工具调用同一个 runner，artifact 真的落盘并返给前端下载（commit `88d0098`）

但**只能跑自带 `scripts/run.js` 的 skill**。社区里大量按 Anthropic 标准格式写的 skill —— 比如官方的 `xlsx`、用户自己写的 `text-to-issuelist` —— 它们的 ZIP 里**根本没有 `scripts/run.*`**，因为它们的设计前提是"被一个 agent runtime 执行"：

```
SKILL.md 里写的是给 LLM 看的指引（"用 pandas / openpyxl / 调 scripts/recalc.py"），
真正的代码由 LLM 在运行时临场写 Python，靠 agent runtime 提供的 run_python 工具执行。
```

OpenSkill 目前不是 agent runtime —— 上传这类 skill 后，前端没有 Run tab，Chat 里也不会暴露任何工具，LLM 只能编"已生成 xxxxx.xlsx"的幻觉。

---

## 二、目标

**让 OpenSkill 自动识别"agent-mode skill"并能执行**。具体地：

| 输入                                     | OpenSkill 的行为                                       |
|------------------------------------------|--------------------------------------------------------|
| skill 包含 `scripts/run.js`              | 走当前的 Node skill-runner（向后兼容，不变）           |
| skill 包含 `scripts/run.py`（新）        | 走 Python skill-runner（直接执行入口）                 |
| skill 既无 `run.js` 也无 `run.py`        | **自动进 agent mode**：LLM 拿到 `run_python_code` 工具，临场写代码完成任务 |

完成后，用户当前已上传的两个 skill 都能直接用：
- `xlsx`（Anthropic 官方的 spreadsheet skill，纯 SKILL.md + Python helpers，无 entry）
- `text-to-issuelist`（用户自己的，带 `模板/*.xlsx` 资源，无 entry）

---

## 三、设计决策

### 3.1 Python sandbox 范围

最小可用版（后期可继续收紧）：

| 维度       | 决策                                                                    |
|------------|-------------------------------------------------------------------------|
| 进程       | `child_process.spawn('python3', [...])`，复用现在的 timeout / output 上限 |
| 工作目录   | 每次执行新建 `/tmp/openskill-pyrun-{uuid}/` ， skill ZIP 解压到 `skill/` 子目录 |
| 输出目录   | `OPENSKILL_OUTPUT_DIR=/tmp/.../output/`（沿用现在的约定）              |
| 环境变量   | 白名单：PATH, HOME, LANG, OPENSKILL_INPUT_FILE, OPENSKILL_OUTPUT_DIR, PYTHONPATH |
| 网络       | 默认允许（本地部署、可信用户）；后期可以加 unshare/firewall            |
| 用户 ID    | 同进程用户（不切 uid）；和现在的 Node runner 一样                      |
| 文件系统   | cwd 限定 tmp 目录；不允许逃逸（路径校验）                              |
| 超时       | 默认 60 秒，manifest.run.timeout_ms 可覆盖（夹紧 [1s, 300s]）          |
| 输出上限   | 50 MB 总产物                                                            |
| 单 flight  | 沿用现有进程级锁（同一时刻只跑一个 skill）                             |

### 3.2 镜像里要装什么

`Dockerfile` 改动（Debian/Ubuntu 基础镜像）：

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip \
      libreoffice-core libreoffice-calc libreoffice-writer \
    && rm -rf /var/lib/apt/lists/*

# 一份给所有 skill 共享的 Python 库
COPY server/requirements.txt /tmp/req.txt
RUN pip3 install --no-cache-dir --break-system-packages -r /tmp/req.txt
```

`server/requirements.txt`（最小集，按需加）：

```
openpyxl==3.1.5
python-docx==1.1.2
pandas==2.2.3
pdfplumber==0.11.4
Pillow==11.0.0
lxml==5.3.0
```

`PYTHONPATH` 暴露给 skill，让 skill 自己 `import openpyxl` 不用 vendor。

> **代价**：镜像从 ~600MB 涨到 ~1.2GB，构建时间 ~5min → ~10min。可接受。

### 3.3 LLM 新工具：`run_python_code`

只有当 skill 处于 agent mode（即没有 `scripts/run.js`）时才暴露。

```jsonc
// 暴露给 LLM 的工具定义
{
  "type": "function",
  "function": {
    "name": "run_python_code",
    "description": "Execute Python 3 code inside this skill's bundle. The skill's `scripts/`, templates and other files are available at the current working directory. Output files written under $OPENSKILL_OUTPUT_DIR will be attached to your reply as downloadable artifacts.",
    "parameters": {
      "type": "object",
      "required": ["code"],
      "properties": {
        "code": {
          "type": "string",
          "description": "Python 3 code to execute. Use openpyxl/pandas/python-docx/pdfplumber as needed. Write outputs to os.environ['OPENSKILL_OUTPUT_DIR']."
        },
        "stdin": {
          "type": "string",
          "description": "Optional: text fed to the script's stdin."
        }
      }
    }
  }
}
```

注意：`run_skill`（现在那个，调 `scripts/run.js`）和 `run_python_code`**互斥**。一个对话里一个 skill 只暴露一个工具，避免歧义。

### 3.4 系统提示要扩展

agent-mode 的 system prompt = `SKILL.md` 完整内容 + 一段固定追加：

```text
---

You are running INSIDE an OpenSkill agent runtime. The tool `run_python_code` lets
you execute arbitrary Python 3 against this skill's bundle. The bundle's `scripts/`
directory is at your CWD; templates / assets the skill ships are in their original
relative paths.

Pre-installed libraries: openpyxl, pandas, python-docx, pdfplumber, Pillow, lxml.
LibreOffice (`soffice` / `libreoffice`) is on PATH for formula recalc / format conversion.

RULES:
1. When the user asks for a deliverable, you MUST call run_python_code instead of
   describing the result in prose. Do NOT pretend a file was generated unless the
   tool returned a successful result for it in this turn.
2. Write output files to os.environ['OPENSKILL_OUTPUT_DIR']. The runtime will
   attach them to your reply automatically — do NOT invent download URLs.
3. The skill's CWD is the unzipped skill bundle. Read templates with relative
   paths (e.g. `openpyxl.load_workbook('模板/foo.xlsx')`).
4. After run_python_code returns, briefly tell the user the file is ready.
5. If the tool returns ok=false, briefly explain the failure; don't blindly retry.
```

### 3.5 检测逻辑（决定是否进 agent mode）

`server/src/skill-runner.js` 已经有 `checkRunnable(fileTree, manifest)`。新增一个：

```js
// 返回该 skill 的执行模式
function detectExecutionMode(fileTree, manifest) {
  // 显式 manifest.run.entry 优先
  if (manifest?.run?.entry) {
    const ent = manifest.run.entry;
    if (ent.endsWith('.js')) return { mode: 'node', entry: ent };
    if (ent.endsWith('.py')) return { mode: 'python', entry: ent };
    return { mode: 'unsupported', reason: `unknown entry suffix: ${ent}` };
  }
  // 默认按文件存在性
  if (fileTree.some(f => f.path === 'scripts/run.js' && f.type === 'file'))
    return { mode: 'node', entry: 'scripts/run.js' };
  if (fileTree.some(f => f.path === 'scripts/run.py' && f.type === 'file'))
    return { mode: 'python', entry: 'scripts/run.py' };
  // 没有任何入口但有 SKILL.md → agent mode
  if (fileTree.some(f => f.path === 'SKILL.md' && f.type === 'file'))
    return { mode: 'agent' };
  return { mode: 'none' };
}
```

前端的 `isSkillRunnable` 也跟着扩展：mode != 'none' 都视为 runnable，但 Run tab 只对 `node` / `python` 显示（agent 模式没有"用户填表单直接跑"的概念，因为 LLM 才知道要写什么代码）。

---

## 四、实现步骤（按顺序）

### Phase 1 —— Python 直接执行（无 LLM）

> 目标：让带 `scripts/run.py` 的 skill 能像 `scripts/run.js` 一样在 Run tab 上点击执行。
> 不涉及 LLM。1~2 小时。

1. **Dockerfile**：apt-get install python3 + libreoffice-* ；pip install requirements.txt
2. **新建 `server/requirements.txt`**：上面那一行
3. **`server/src/skill-runner.js` 改造**：
   - 抽出 `detectExecutionMode(fileTree, manifest)`（见 3.5）
   - `runSkill()` 多支持一个 `mode='python'` 分支：spawn `python3 <entry>`，同样的 env / cwd / 超时
   - 给跑 Python 的进程额外注入 `PYTHONPATH=/usr/lib/python3/dist-packages`（让 skill 能 `import pandas` 等预装库）
4. **`server/src/routes/skills.js` POST /run**：把当前的 `checkRunnable()` 调用替换成 `detectExecutionMode()`，根据 mode 派发
5. **新增测试** `server/test/run-python.test.js`：跑一个写 `scripts/run.py` 的小 skill，断言输出文件返回正确
6. **frontend `isSkillRunnable`**：加 `manifest.run.runtime === 'python'` 或 file_tree 含 `scripts/run.py` 都返回 true

**验收：** 上传一个最小 Python skill（`SKILL.md` + `scripts/run.py` 写一行 `pandas.DataFrame(...).to_excel('$OPENSKILL_OUTPUT_DIR/x.xlsx')`），Run tab 点击 → 浏览器下载到 xlsx，能用 Excel 打开。

### Phase 2 —— Agent mode（LLM 临场写代码）

> 目标：让既无 `run.js` 也无 `run.py` 的 skill（`xlsx`、`text-to-issuelist`）也能在 Chat 里被调用。
> 半天到一天。

1. **新建 `server/src/python-exec.js`**：导出 `runPythonCode({ code, stdin?, zipBuffer, manifest, limits })`
   - 解压 ZIP 到 tmp 目录（复用现有的 `extractZipToDir`）
   - 把 `code` 写进 `_run.py` 文件（避免命令行长度问题）
   - spawn python3 ，cwd=skillRoot ，env 同上
   - 收集 OUTPUT_DIR 产物：1 个文件→直接返回；多个→打 zip
   - 同样的 try/finally 清理
2. **`server/src/routes/chat.js` 重构**：
   - 计算 `mode = detectExecutionMode(...)`
   - mode=='node' → 现状不变，工具叫 `run_skill`，调 `runSkill(...)`
   - mode=='python' → 工具仍叫 `run_skill`，但内部走 Python 路径
   - mode=='agent' → 工具叫 `run_python_code`，参数 `{code, stdin?}`，调 `runPythonCode(...)`
   - mode=='none' → 不暴露工具（plain LLM chat）
3. **system prompt 扩展**：agent mode 时追加 3.4 的固定段落到 SKILL.md 后面
4. **artifact 落盘 + SSE 事件**：和现在的 `run_skill` 路径一致（saveArtifact / tool_done / tool_error / message），不需要新逻辑
5. **`run_python_code` 的 LLM-side 工具描述**：见 3.3
6. **前端 `ChatView.tsx`**：
   - SSE 已经能处理 `{ tool_call: { name } }`，自动适配新工具名 `run_python_code`
   - i18n key `chat.toolCalling` 已支持 `{name}` 占位，无需改动
   - artifact chip 也无需改动
7. **新增测试** `server/test/chat-agent-mode.test.js`：mock LLM 让它调 `run_python_code` 写一段 openpyxl 代码，断言 artifact 落盘 + 下载内容是合法 xlsx

**验收：** 把 `text-to-issuelist` 重新挂上对话，让 LLM "把这些问题填到模板里导出"，浏览器收到一个**真正按模板格式填好**的 .xlsx 文件。

### Phase 3 —— 文档 + commit + push

1. README.md / README.zh-CN.md 加一节 "Agent mode (Python)"，说明：
   - 装了哪些 Python 库
   - 触发条件（无 entry → agent）
   - LLM 暴露的 `run_python_code` 工具
   - 安全模型的更新（同 OS 用户，同沙箱强度）
2. `examples/` 下加一个 Phase 1 的 Python 示例：`examples/csv-cleaner/`（用 pandas 清洗 csv → xlsx），同步 `scripts/build-examples.js` 输出
3. Bump tests badge（应该到 50+N）
4. 单个 commit `feat(runtime): Python + agent mode for declarative Anthropic skills`
5. push origin main

---

## 五、风险 / 兼容性

| 风险                                             | 处理                                                  |
|--------------------------------------------------|-------------------------------------------------------|
| 镜像变大，部署慢                                 | 接受。文档里写明                                      |
| LibreOffice headless 在某些 host 上启动慢/卡死   | 调 `recalc.py` 时给独立超时；首次运行后会缓存 user profile |
| LLM 写出有副作用的 Python（删文件、写 /etc）     | 非 root + tmp cwd 限制 + 超时；后期可换 nsjail        |
| pip 装的库版本和 skill 期望不一致                | 文档列出确切版本；skill 可在 ZIP 自带 `requirements.txt` 我们用 venv 装（Phase 4） |
| 现有 Node skill 回归                             | Phase 1 不动 Node 分支；新增完整 Node skill 测试用例覆盖 |
| 单 flight 锁让两个对话排队                       | 沿用现状；写文档说明小团队场景                        |

---

## 六、新会话冷启动 checklist

下次启会话直接开干，按这个清单走：

1. `cd /home/ubuntu/project/openskill && git pull && git log --oneline -3`
   预期看到最新 commit 含 `88d0098`（chat tool-calling）
2. `npm --prefix server test` 应该 50/50 绿
3. `docker ps` 看 openskill 容器是否还在跑（端口 8088）
4. 阅读这个文件的 §三 §四，按 §四 的 Phase 1 → Phase 2 → Phase 3 顺序推进
5. 每个 Phase 完成 → 跑测试 → commit → 不 push（最后一起 push 节省 CI）
6. Phase 3 全部完成才 push origin main

---

## 七、参考：当前已有的关键文件

- `server/src/skill-runner.js` —— Node 执行器（要在这里加 mode 分发）
- `server/src/routes/chat.js` —— Chat 工具调用循环（要在这里加 agent 模式分支）
- `server/src/artifact-storage.js` —— artifact 落盘（不需要改）
- `server/src/llm.js` —— `llmTurn` 异步生成器（不需要改）
- `frontend/src/views/ChatView.tsx` —— SSE 解析 + 下载芯片（基本不改）
- `frontend/src/views/SkillDetailView.tsx` —— `isSkillRunnable` 要扩展
- `Dockerfile` —— 加 Python + LibreOffice
- `server/requirements.txt` —— 新建
- `examples/xlsx-generator/` —— 现有的 Node 示例，可作 Python 示例的参照

---

## 八、不在本次范围里的事

明确**不做**，避免范围爆炸：

- ❌ Java / Go / Ruby 等其它运行时
- ❌ 真正的 kernel 沙箱（gVisor / Firecracker / nsjail）—— 本机/小团队前提下不需要
- ❌ 多 sheet / 自定义样式以外的 xlsx 高级功能
- ❌ skill 自己声明 `requirements.txt` 时 OpenSkill 自动 venv install —— 这是好功能但放后续
- ❌ tool-calling 多工具（除 `run_skill` / `run_python_code` 之外）
- ❌ 流式输出 Python 进程的 stdout 给前端（产物到了再说）
- ❌ Anthropic Skill `tools:` 字段的精确语义（`file_read_docx` 等）—— 我们只提供通用 `run_python_code`，不模拟 Claude Code 的全套工具

---

> EOF
