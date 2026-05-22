'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { llmTurn } = require('../llm');
const { runSkill, detectExecutionMode } = require('../skill-runner');
const { runPythonCode } = require('../python-exec');
const { saveArtifact, resolveArtifactPath } = require('../artifact-storage');

const DEFAULT_SYSTEM_PROMPT = 'You are a helpful AI assistant.';

// Cap how many tool calls a single user message can trigger. Prevents a
// runaway loop if the model decides to keep calling the tool forever.
//
// Layout for agent-mode interactions:
//   iter 0..MAX-2 → may force tool_choice='required' to defeat
//                   DeepSeek's prose-instead-of-tool habit
//   iter MAX-1    → always 'auto' so the model has a chance to write
//                   a natural-language clarifying question or summary
//                   (e.g. "I need the company name to fill the template").
// 4 lets a recon → recon → generate chain finish AND still leaves one
// auto turn at the end for the wrap-up / clarifying message.
const MAX_TOOL_ITERATIONS = 4;

// Cap on stdout/stderr we ship back to the LLM in tool_result. Big enough
// to carry useful recon output (file lists, sheet names, etc.) but small
// enough that we don't blow the model's context window.
const MAX_STDIO_FOR_MODEL = 4 * 1024;

function truncateForModel(s) {
  if (typeof s !== 'string' || s.length === 0) return '';
  if (s.length <= MAX_STDIO_FOR_MODEL) return s;
  return s.slice(0, MAX_STDIO_FOR_MODEL) + '\n…[truncated]';
}

// Appended to the system prompt when the conversation has a runnable skill
// attached (Node OR Python entry script). Critical to prevent the model
// from hallucinating "I created the file" instead of actually invoking
// the tool.
const RUNNABLE_TOOL_HINT = `
=== OpenSkill agent runtime — runnable skill ===

You are running inside the OpenSkill server, NOT Claude Code, NOT a local IDE. The ONLY tool available to you is "run_skill". It takes the skill's structured input and executes its entry script server-side; the produced file is automatically attached to your reply as a downloadable artifact.

The SKILL.md content that follows below was written for some other runtime (Claude Code, local file system, etc.) and may reference other tool names or absolute filesystem paths. You must mentally translate / ignore those:

- Any tool name like \`run_python\`, \`run_python_with_write\`, \`bash\`, \`open_in_session_tab\`, \`fdfind\`, \`folder_list\`, \`file_read*\`, \`file_type\` → there is exactly one tool here: **run_skill**. Use it.
- Any absolute filesystem path (e.g. \`D:\\chris.li\\skill\\...\`, \`/Users/...\`, \`WORKSPACE_DIR/artifacts/\`) → ignore. The skill's bundle is already loaded server-side; you do not need to locate or unzip it.

RULES:
1. When the user asks for a deliverable (a Word/Excel/PDF/etc. file), you MUST call run_skill with the appropriate JSON input. Do NOT describe the file in prose without calling the tool first.
2. Never claim a file has been created if you have not received a successful tool result for that file in this turn. Pretending an "artifacts/" directory exists or that you have "saved" a file without calling the tool is forbidden.
3. After run_skill returns successfully, write a short reply telling the user the file is ready. The OpenSkill UI will render a download button automatically — do NOT invent download links.
4. If the tool returns ok=false, briefly explain the failure and suggest a fix; do not retry blindly.
`.trim();

// Appended to the system prompt for "agent mode" skills — the ones that
// have a SKILL.md but no entry script. These are the Anthropic-style
// declarative skills (xlsx, text-to-issuelist, ...). The LLM writes Python
// 3 against the bundled templates / assets at runtime.
const AGENT_TOOL_HINT = `
=== OpenSkill agent runtime — Python execution ===

You are running inside the OpenSkill server, NOT Claude Code, NOT a local IDE. The ONLY tool available to you is **run_python_code**, which takes \`{ code: string, stdin?: string }\` and executes Python 3 server-side against this skill's already-unzipped bundle.

Environment when your code runs:
- CWD = the root of the unzipped skill bundle. Templates, assets, scripts/ etc. are at their original relative paths inside the bundle (e.g. \`模板/foo.xlsx\`, \`scripts/recalc.py\`).
- \`os.environ['OPENSKILL_OUTPUT_DIR']\` = the directory you MUST write output files into. Anything written there becomes a downloadable artifact in your reply.
- Pre-installed libraries on PYTHONPATH: openpyxl, pandas, python-docx, pdfplumber, Pillow, lxml.
- LibreOffice (\`soffice\` / \`libreoffice\`) is on PATH for spreadsheet formula recalc / PDF conversion.

The SKILL.md content that follows below was authored for the original Anthropic Claude Code / Agent SDK runtime and references tool names and filesystem paths that DO NOT EXIST here. Translate them as you read:

| What SKILL.md says                                              | What you should actually do here                          |
|-----------------------------------------------------------------|-----------------------------------------------------------|
| Tool: \`run_python\`                                             | Call \`run_python_code\` with that python in \`code\`.       |
| Tool: \`run_python_with_write\`                                  | Same — \`run_python_code\` already has full write access.    |
| Tools: \`bash\`, \`fdfind\`, \`folder_list\`, \`file_type\`            | Do the equivalent in Python (\`subprocess\`, \`pathlib\`, \`os\`). |
| Tools: \`file_read\`, \`file_read_docx\`, \`file_read_pdf\`, \`file_read_pptx\` | Read the file directly in Python (python-docx, pdfplumber, openpyxl, etc.). |
| Tool: \`open_in_session_tab\`                                    | Just save the file to \`OPENSKILL_OUTPUT_DIR\` — the UI handles the rest. |
| Path: \`D:\\chris.li\\skill\\foo.zip\` (or any absolute Windows / *nix path) | Ignore. The skill is already unzipped at your CWD.        |
| Path: \`WORKSPACE_DIR/artifacts/...\`                             | Use \`os.environ['OPENSKILL_OUTPUT_DIR']\` instead.          |
| Path: \`attached_files/...\`                                     | Not present here. Ask the user if you really need an upload. |
| Skill self-extracts a zip from disk                             | Skip — the skill's files are already at CWD.              |

RULES:
1. When the user asks for a deliverable, you MUST call \`run_python_code\` with real Python that produces the file. Do NOT just promise to do it in prose. "好的，我来处理" / "let me start working on it" with no tool call is FORBIDDEN.
2. Write output files to \`os.environ['OPENSKILL_OUTPUT_DIR']\`. Do NOT invent download URLs or claim a file was saved unless the tool returned ok=true with a non-empty filename.
3. Tool results include \`stdout\` and \`stderr\` (truncated). Use them. If you ran a reconnaissance script first (e.g. \`os.listdir(...)\`, \`get_workbook_summary\`), the results come back via stdout — read them and adapt your next call.
4. If a tool result has \`no_file: true\`, that means your code ran successfully but didn't write anything. This is fine for recon, but your NEXT call MUST write the actual deliverable to OPENSKILL_OUTPUT_DIR.
5. After a tool call returns ok=true with a real filename, send a short reply telling the user the file is ready (the UI will render the download chip automatically).
6. If the tool returns ok=false, briefly explain the failure based on stderr and try a corrected version once. Do not retry blindly more than once.
7. If you genuinely need information from the user before you can run code (e.g. company name to fill into a template), ask ONCE concisely; once they answer, immediately call the tool.
`.trim();

/**
 * Build the OpenAI-shape `tools` array for an attached skill.
 *
 * Decides between three exclusive shapes:
 *   - 'node' / 'python' entry → one tool named "run_skill"
 *   - 'agent' (no entry)      → one tool named "run_python_code"
 *   - 'none' / unsupported    → []
 *
 * Returns { tools, hint, mode } so the caller can apply the matching
 * system-prompt addendum.
 */
function buildTools(skill, manifest, fileTree) {
  if (!skill) return { tools: [], hint: null, mode: 'none' };
  const detected = detectExecutionMode(fileTree, manifest);

  if (detected.mode === 'node' || detected.mode === 'python') {
    let parameters;
    const declared = manifest?.run?.input_schema;
    if (declared && typeof declared === 'object' && !Array.isArray(declared)) {
      parameters = declared;
    } else {
      parameters = { type: 'object', additionalProperties: true };
    }

    const desc = `Execute the "${skill.name}" skill on the server and attach the produced file to your reply.\n\nSkill description: ${skill.description || ''}`.trim();

    return {
      tools: [
        {
          type: 'function',
          function: {
            name: 'run_skill',
            description: desc,
            parameters,
          },
        },
      ],
      hint: RUNNABLE_TOOL_HINT,
      mode: detected.mode,
    };
  }

  if (detected.mode === 'agent') {
    const desc =
      `Execute Python 3 code inside the "${skill.name}" skill bundle. ` +
      `The skill's scripts/, templates and other files are available at the current working directory. ` +
      `Output files written under $OPENSKILL_OUTPUT_DIR will be attached to your reply as downloadable artifacts.\n\n` +
      `Skill description: ${skill.description || ''}`.trim();

    return {
      tools: [
        {
          type: 'function',
          function: {
            name: 'run_python_code',
            description: desc,
            parameters: {
              type: 'object',
              required: ['code'],
              properties: {
                code: {
                  type: 'string',
                  description:
                    "Python 3 code to execute. Use openpyxl/pandas/python-docx/pdfplumber as needed. " +
                    "Write outputs to os.environ['OPENSKILL_OUTPUT_DIR'].",
                },
                stdin: {
                  type: 'string',
                  description: "Optional: text fed to the script's stdin.",
                },
              },
            },
          },
        },
      ],
      hint: AGENT_TOOL_HINT,
      mode: 'agent',
    };
  }

  return { tools: [], hint: null, mode: detected.mode };
}

/**
 * Read the conversation history from DB and reshape into OpenAI-style
 * messages. Tool-call rounds are not persisted as DB rows (they live only
 * inside one user-message turn), so we just emit role+content for each row.
 */
function loadHistory(db, conversationId) {
  return db
    .prepare(
      `SELECT role, content FROM messages
       WHERE conversation_id = ? ORDER BY created_at ASC, id ASC`,
    )
    .all(conversationId)
    .map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Format a tool result for the model. Keep it compact JSON; the model only
 * needs the filename + a hint that the UI will render a download button.
 */
function formatToolResult(payload) {
  return JSON.stringify(payload);
}

async function chatRoutes(app) {
  const db = app.db;
  const { storageDir, skillsDir } = app.config;

  // -------------------------------------------------------------------------
  // GET /chat/conversations — list current user's conversations
  // -------------------------------------------------------------------------
  app.get('/chat/conversations', { preHandler: [app.authenticate] }, async (req) => {
    const rows = db
      .prepare(
        `SELECT c.*, s.name as skill_name, s.slug as skill_slug
         FROM conversations c
         LEFT JOIN skills s ON s.id = c.skill_id
         WHERE c.user_id = ? ORDER BY c.updated_at DESC`,
      )
      .all(req.user.id);
    return { items: rows };
  });

  // -------------------------------------------------------------------------
  // POST /chat/conversations — create
  // -------------------------------------------------------------------------
  app.post('/chat/conversations', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { skill_id } = req.body || {};

    let title = 'New chat';
    let resolvedSkillId = null;

    if (skill_id) {
      const skill = db
        .prepare('SELECT id, name FROM skills WHERE id = ? AND status = ?')
        .get(skill_id, 'published');
      if (!skill) return reply.code(404).send({ error: 'Skill not found', code: 'NOT_FOUND' });
      resolvedSkillId = skill.id;
      title = `Chat with ${skill.name}`;
    }

    const result = db
      .prepare('INSERT INTO conversations (user_id, skill_id, title) VALUES (?, ?, ?)')
      .run(req.user.id, resolvedSkillId, title);

    const conv = db
      .prepare(
        `SELECT c.*, s.name as skill_name, s.slug as skill_slug
         FROM conversations c
         LEFT JOIN skills s ON s.id = c.skill_id
         WHERE c.id = ?`,
      )
      .get(result.lastInsertRowid);
    return reply.code(201).send(conv);
  });

  // -------------------------------------------------------------------------
  // PATCH /chat/conversations/:id — change skill / title
  // -------------------------------------------------------------------------
  app.patch('/chat/conversations/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const conv = db
      .prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    if (!conv) return reply.code(404).send({ error: 'Conversation not found', code: 'NOT_FOUND' });

    const body = req.body || {};
    const updates = [];
    const params = [];

    if ('skill_id' in body) {
      if (body.skill_id === null) {
        updates.push('skill_id = NULL');
      } else {
        const skill = db
          .prepare('SELECT id FROM skills WHERE id = ? AND status = ?')
          .get(body.skill_id, 'published');
        if (!skill) return reply.code(404).send({ error: 'Skill not found', code: 'NOT_FOUND' });
        updates.push('skill_id = ?');
        params.push(skill.id);
      }
    }

    if (typeof body.title === 'string' && body.title.trim()) {
      updates.push('title = ?');
      params.push(body.title.trim());
    }

    if (updates.length === 0) {
      return reply.code(400).send({ error: 'No updates provided', code: 'INVALID_INPUT' });
    }

    updates.push("updated_at = datetime('now')");
    params.push(conv.id);
    db.prepare(`UPDATE conversations SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    const updated = db
      .prepare(
        `SELECT c.*, s.name as skill_name, s.slug as skill_slug
         FROM conversations c
         LEFT JOIN skills s ON s.id = c.skill_id
         WHERE c.id = ?`,
      )
      .get(conv.id);
    return updated;
  });

  // -------------------------------------------------------------------------
  // GET /chat/conversations/:id/messages — list with attached artifacts
  // -------------------------------------------------------------------------
  app.get(
    '/chat/conversations/:id/messages',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const conv = db
        .prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
        .get(req.params.id, req.user.id);
      if (!conv) {
        return reply.code(404).send({ error: 'Conversation not found', code: 'NOT_FOUND' });
      }

      const messages = db
        .prepare(
          `SELECT id, conversation_id, role, content, created_at
           FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC`,
        )
        .all(conv.id);

      // Pull all artifacts for this conversation in one go
      const artifacts = db
        .prepare(
          `SELECT a.id, a.message_id, a.skill_slug, a.filename,
                  a.content_type, a.size_bytes, a.created_at
           FROM artifacts a
           JOIN messages m ON m.id = a.message_id
           WHERE m.conversation_id = ?
           ORDER BY a.id ASC`,
        )
        .all(conv.id);

      const byMessage = new Map();
      for (const a of artifacts) {
        const list = byMessage.get(a.message_id) || [];
        list.push(a);
        byMessage.set(a.message_id, list);
      }
      for (const m of messages) {
        m.artifacts = byMessage.get(m.id) || [];
      }

      return { items: messages };
    },
  );

  // -------------------------------------------------------------------------
  // POST /chat/conversations/:id/messages — main user-turn handler.
  // Streams SSE events back. Drives a tool-call loop when the model decides
  // to invoke the attached skill.
  // -------------------------------------------------------------------------
  app.post(
    '/chat/conversations/:id/messages',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const conv = db
        .prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
        .get(req.params.id, req.user.id);
      if (!conv) {
        return reply.code(404).send({ error: 'Conversation not found', code: 'NOT_FOUND' });
      }

      const { content } = req.body || {};
      if (!content) {
        return reply.code(400).send({ error: 'content required', code: 'INVALID_INPUT' });
      }

      // Save user message first; this is part of the persisted history.
      db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(
        conv.id,
        'user',
        content,
      );
      db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(
        conv.id,
      );

      // Resolve attached skill (if any) and decide whether we expose tools.
      let skillRow = null;
      let manifest = null;
      let fileTree = [];
      if (conv.skill_id) {
        skillRow = db
          .prepare(
            `SELECT id, slug, name, description, skill_md_content,
                    manifest_json, file_tree_json, file_path, status
             FROM skills WHERE id = ?`,
          )
          .get(conv.skill_id);
        if (skillRow) {
          if (skillRow.manifest_json) {
            try {
              const merged = JSON.parse(skillRow.manifest_json);
              manifest = merged.manifest || null;
            } catch {
              /* ignore */
            }
          }
          if (skillRow.file_tree_json) {
            try {
              fileTree = JSON.parse(skillRow.file_tree_json);
            } catch {
              /* ignore */
            }
          }
        }
      }

      const { tools, hint: toolHint, mode: skillMode } = buildTools(
        skillRow,
        manifest,
        fileTree,
      );

      // Build the system prompt with the runtime hint FIRST so it has primacy
      // over a long SKILL.md that may have been authored for Claude Code /
      // local IDE and references unrelated tool names + absolute filesystem
      // paths. The SKILL.md follows under a clearly-labelled "domain context"
      // header so the model treats it as task-domain knowledge, not as
      // authoritative runtime instructions.
      let systemPrompt;
      if (toolHint) {
        let body = toolHint;
        if (skillRow?.skill_md_content) {
          body +=
            '\n\n=== Skill domain context (SKILL.md, authored for a different runtime — read for task knowledge, ignore tool names + absolute paths) ===\n\n' +
            skillRow.skill_md_content;
        }
        systemPrompt = body;
      } else if (skillRow?.skill_md_content) {
        systemPrompt = skillRow.skill_md_content;
      } else {
        systemPrompt = DEFAULT_SYSTEM_PROMPT;
      }

      // Build the OpenAI-shape history. We pass {role, content} pairs from
      // the DB; tool exchanges are appended in-memory inside the loop and
      // never persisted (we only persist the final assistant text).
      const history = loadHistory(db, conv.id);

      // Open SSE response
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const send = (obj) => reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
      const close = () => {
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
      };

      // Carry artifact metadata across loop iterations so we can link them
      // to the final assistant DB row at the end.
      const pendingArtifacts = []; // { filename, contentType, data, skillSlug }
      let finalAssistantText = '';

      try {
        let zipBuffer = null;
        if (skillRow && tools.length > 0) {
          const filePath = path.resolve(skillsDir, skillRow.file_path);
          if (fs.existsSync(filePath)) {
            zipBuffer = fs.readFileSync(filePath);
          }
        }

        for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter += 1) {
          let turnText = '';
          const turnToolCalls = [];

          // tool_choice escalation:
          //   - First iteration: force a tool call (defeats DeepSeek's
          //     habit of replying in prose for clear deliverable requests).
          //   - Subsequent iterations except the last: keep forcing while
          //     no artifact has been collected yet (allows recon-then-
          //     generate chains).
          //   - Last iteration (iter === MAX-1): always 'auto'. This is
          //     the model's escape valve — if it has been recon'ing for
          //     N rounds and still can't produce a file (typically
          //     because it needs information from the user, e.g. a
          //     company name to fill into a template), this gives it a
          //     chance to ask the user via natural-language text instead
          //     of silently exiting the loop.
          let toolChoice = 'auto';
          const isLastIter = iter === MAX_TOOL_ITERATIONS - 1;
          if (tools.length > 0 && !isLastIter) {
            if (iter === 0) toolChoice = 'required';
            else if (pendingArtifacts.length === 0) toolChoice = 'required';
          }

          for await (const ev of llmTurn({
            systemPrompt,
            messages: history,
            tools,
            toolChoice,
          })) {
            if (ev.type === 'text') {
              turnText += ev.delta;
              send({ content: ev.delta });
            } else if (ev.type === 'tool_call') {
              turnToolCalls.push(ev.tool_call);
            }
            // 'done' is implicit when the iterator ends
          }

          if (turnText) finalAssistantText += turnText;

          if (turnToolCalls.length === 0) break;

          // Append assistant message with tool_calls into the LLM history
          // (this is OpenAI's required shape for the next request)
          history.push({
            role: 'assistant',
            content: turnText || null,
            tool_calls: turnToolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.arguments },
            })),
          });

          // Execute each tool call sequentially
          for (const tc of turnToolCalls) {
            send({ tool_call: { id: tc.id, name: tc.name } });

            let toolResultPayload;

            // Allowed tool names are gated by skillMode:
            //   node | python → run_skill
            //   agent         → run_python_code
            const expectedTool =
              skillMode === 'agent' ? 'run_python_code' : 'run_skill';

            if (tc.name !== expectedTool) {
              toolResultPayload = {
                ok: false,
                code: 'UNKNOWN_TOOL',
                message: `Unknown tool: ${tc.name} (expected ${expectedTool})`,
              };
              send({ tool_error: toolResultPayload });
            } else if (!skillRow || !zipBuffer) {
              toolResultPayload = {
                ok: false,
                code: 'NO_SKILL',
                message: 'No runnable skill is attached to this conversation',
              };
              send({ tool_error: toolResultPayload });
            } else {
              let parsedArgs = {};
              try {
                parsedArgs = tc.arguments ? JSON.parse(tc.arguments) : {};
              } catch (e) {
                toolResultPayload = {
                  ok: false,
                  code: 'BAD_ARGUMENTS',
                  message: `Tool arguments were not valid JSON: ${e.message}`,
                };
                send({ tool_error: toolResultPayload });
              }

              if (!toolResultPayload) {
                try {
                  const limits = {};
                  if (manifest?.run && Number.isFinite(manifest.run.timeout_ms)) {
                    limits.timeoutMs = manifest.run.timeout_ms;
                  }
                  const serverNodeModules = path.resolve(
                    __dirname,
                    '..',
                    '..',
                    'node_modules',
                  );

                  let runResult;
                  if (tc.name === 'run_skill') {
                    // Some tool callers (Claude-style or DeepSeek) wrap the
                    // user-facing input under a top-level `input` key.
                    // Accept either shape.
                    const skillInput =
                      parsedArgs && typeof parsedArgs === 'object' && 'input' in parsedArgs
                        ? parsedArgs.input
                        : parsedArgs;
                    runResult = await runSkill({
                      zipBuffer,
                      manifest,
                      fileTree,
                      input: skillInput ?? {},
                      extraNodePaths: [serverNodeModules],
                      limits,
                    });
                  } else {
                    // run_python_code
                    const code =
                      parsedArgs && typeof parsedArgs.code === 'string'
                        ? parsedArgs.code
                        : '';
                    const stdin =
                      parsedArgs && typeof parsedArgs.stdin === 'string'
                        ? parsedArgs.stdin
                        : '';
                    if (!code.trim()) {
                      throw Object.assign(new Error('`code` parameter is required'), {
                        code: 'BAD_ARGUMENTS',
                      });
                    }
                    runResult = await runPythonCode({
                      zipBuffer,
                      manifest,
                      code,
                      stdin,
                      limits,
                    });
                  }

                  // Buffer artifact in memory; we'll persist after we know
                  // the assistant message_id at the end of the turn.
                  pendingArtifacts.push({
                    filename: runResult.filename,
                    contentType: runResult.contentType,
                    data: runResult.data,
                    skillSlug: skillRow.slug,
                  });

                  toolResultPayload = {
                    ok: true,
                    filename: runResult.filename,
                    content_type: runResult.contentType,
                    size_bytes: runResult.data.length,
                    duration_ms: runResult.durationMs,
                    // Pipe stdout/stderr (truncated) back so the model can
                    // confirm what its code observed during this turn —
                    // critical for chained calls (recon → real run).
                    stdout: truncateForModel(runResult.stdout),
                    stderr: truncateForModel(runResult.stderr),
                    note:
                      'The file has been attached to your reply. The user will see ' +
                      'a download button automatically — do not invent links.',
                  };
                  send({
                    tool_done: {
                      filename: runResult.filename,
                      content_type: runResult.contentType,
                      size_bytes: runResult.data.length,
                      duration_ms: runResult.durationMs,
                    },
                  });
                } catch (err) {
                  // EMPTY_OUTPUT is special: the script ran successfully, it
                  // just didn't produce a file. Common, legitimate case is
                  // a "recon" run (the model wants to look at the bundle
                  // before generating output). Surface it as ok=true with a
                  // hint that no file was produced; otherwise the model
                  // sees a bare "failure" with no info and tends to give up.
                  if (err.code === 'EMPTY_OUTPUT') {
                    toolResultPayload = {
                      ok: true,
                      no_file: true,
                      message:
                        'Code executed successfully but produced no file. ' +
                        'If this was a reconnaissance run, the next call should ' +
                        'write the deliverable to OPENSKILL_OUTPUT_DIR.',
                      stdout: truncateForModel(err.detail?.stdout),
                      stderr: truncateForModel(err.detail?.stderr),
                    };
                    send({
                      tool_done: {
                        filename: null,
                        content_type: null,
                        size_bytes: 0,
                        duration_ms: 0,
                        no_file: true,
                      },
                    });
                  } else {
                    toolResultPayload = {
                      ok: false,
                      code: err.code || 'RUN_FAILED',
                      message: err.message,
                      stdout: truncateForModel(err.detail?.stdout),
                      stderr: truncateForModel(err.detail?.stderr),
                    };
                    send({ tool_error: toolResultPayload });
                  }
                }
              }
            }

            history.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: formatToolResult(toolResultPayload),
            });
          }
        }
      } catch (err) {
        req.log.error({ err }, 'chat turn failed');
        send({ error: err.message || 'LLM error' });
      }

      // Persist the assistant's final reply + link artifacts to it.
      //
      // Fallback: if the LLM returned absolutely nothing (no text, no tool
      // calls, no artifacts) — typically a transient DeepSeek issue or
      // context-window edge case — persist a visible placeholder so the
      // user doesn't see a blank turn and silently lose their question.
      let assistantId = null;
      const persistedArtifacts = [];
      let contentToPersist = finalAssistantText;
      if (!finalAssistantText && pendingArtifacts.length === 0) {
        req.log.warn(
          {
            convId: conv.id,
            skillId: conv.skill_id,
            skillMode,
            toolsExposed: tools.length,
          },
          'chat turn produced no text and no artifacts — persisting placeholder',
        );
        contentToPersist =
          'The model did not return any content for this turn. ' +
          'This is usually a transient upstream issue; please try sending the message again.';
      }
      if (contentToPersist || pendingArtifacts.length > 0) {
        const result = db
          .prepare(
            'INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)',
          )
          .run(conv.id, 'assistant', contentToPersist || '');
        assistantId = result.lastInsertRowid;

        for (const art of pendingArtifacts) {
          try {
            const row = saveArtifact({
              db,
              storageDir,
              messageId: assistantId,
              skillSlug: art.skillSlug,
              filename: art.filename,
              contentType: art.contentType,
              data: art.data,
            });
            persistedArtifacts.push({
              id: row.id,
              message_id: row.message_id,
              filename: row.filename,
              content_type: row.content_type,
              size_bytes: row.size_bytes,
              skill_slug: row.skill_slug,
              created_at: row.created_at,
            });
          } catch (e) {
            req.log.error({ err: e }, 'artifact save failed');
          }
        }
      }

      send({
        message: {
          id: assistantId,
          content: contentToPersist,
          artifacts: persistedArtifacts,
        },
      });
      close();
    },
  );

  // -------------------------------------------------------------------------
  // GET /chat/artifacts/:id/download — stream a persisted artifact.
  // Authorization: caller must own the conversation that owns the artifact.
  // -------------------------------------------------------------------------
  app.get(
    '/chat/artifacts/:id/download',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const row = db
        .prepare(
          `SELECT a.id, a.filename, a.content_type, a.size_bytes,
                  a.file_path,
                  c.user_id AS owner_id
           FROM artifacts a
           JOIN messages m ON m.id = a.message_id
           JOIN conversations c ON c.id = m.conversation_id
           WHERE a.id = ?`,
        )
        .get(req.params.id);
      if (!row) {
        return reply
          .code(404)
          .send({ error: 'Artifact not found', code: 'ARTIFACT_NOT_FOUND' });
      }
      if (row.owner_id !== req.user.id && req.user.role !== 'admin') {
        return reply.code(403).send({ error: 'Forbidden', code: 'FORBIDDEN' });
      }

      let abs;
      try {
        abs = resolveArtifactPath(storageDir, row.file_path);
      } catch {
        return reply.code(400).send({ error: 'Bad path', code: 'INVALID_PATH' });
      }
      if (!fs.existsSync(abs)) {
        return reply
          .code(404)
          .send({ error: 'Artifact file is missing on disk', code: 'ARTIFACT_FILE_MISSING' });
      }

      const safeAscii = row.filename
        .replace(/"/g, '')
        .replace(/[^\x20-\x7E]/g, '_'); // ASCII fallback for clients without RFC 5987
      const utf8Encoded = encodeURIComponent(row.filename);
      reply
        .header('Content-Type', row.content_type)
        .header(
          'Content-Disposition',
          `attachment; filename="${safeAscii}"; filename*=UTF-8''${utf8Encoded}`,
        )
        .header('Content-Length', String(row.size_bytes));
      return reply.send(fs.createReadStream(abs));
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /chat/conversations/:id — also drops messages + artifacts via
  // CASCADE, and best-effort cleans the artifact files from disk.
  // -------------------------------------------------------------------------
  app.delete(
    '/chat/conversations/:id',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const conv = db
        .prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
        .get(req.params.id, req.user.id);
      if (!conv) {
        return reply.code(404).send({ error: 'Conversation not found', code: 'NOT_FOUND' });
      }

      const artifactRows = db
        .prepare(
          `SELECT a.file_path FROM artifacts a
           JOIN messages m ON m.id = a.message_id
           WHERE m.conversation_id = ?`,
        )
        .all(conv.id);

      db.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id);

      // File cleanup is best-effort and runs after the DB rows are gone.
      try {
        const { deleteArtifactFiles } = require('../artifact-storage');
        deleteArtifactFiles(storageDir, artifactRows);
      } catch {
        /* ignore */
      }

      return reply.code(204).send();
    },
  );
}

module.exports = { chatRoutes };
