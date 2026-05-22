'use strict';

/**
 * Agent-mode chat tests (Phase 2 of TODO-python-agent-mode.md).
 *
 * The skill under test (`agent-only`) has a SKILL.md but NO scripts/run.{js,py}.
 * In this mode the chat tool exposed to the LLM is `run_python_code`, the
 * LLM writes Python on-the-fly, and the produced file becomes a real
 * downloadable artifact in the assistant message.
 *
 * Most tests need python3; the unit-style "tools schema" test does not.
 * They all skip cleanly when openpyxl is unavailable.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const AdmZip = require('adm-zip');

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

function hasPython() {
  try {
    const r = spawnSync('python3', ['-c', 'print(1)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return r.status === 0;
  } catch {
    return false;
  }
}
function hasPythonModule(modName) {
  try {
    const r = spawnSync('python3', ['-c', `import ${modName}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

const PYTHON_AVAILABLE = hasPython();
const OPENPYXL_AVAILABLE = PYTHON_AVAILABLE && hasPythonModule('openpyxl');

// ---------------------------------------------------------------------------
// Test environment helpers (mirrors chat.test.js)
// ---------------------------------------------------------------------------

function freshEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openskill-chat-agent-'));
  process.env.DB_PATH = path.join(tmp, 'test.db');
  process.env.STORAGE_DIR = path.join(tmp, 'storage');
  process.env.JWT_SECRET = 'test-jwt';
  process.env.LOG_LEVEL = 'silent';
  process.env.ADMIN_INITIAL_USERNAME = 'rootadmin';
  process.env.ADMIN_INITIAL_EMAIL = 'root@example.com';
  process.env.ADMIN_INITIAL_PASSWORD = 'rootpass';
  process.env.MAX_UPLOAD_MB = '20';
  process.env.LLM_API_KEY = 'sk-test-mock';
  process.env.LLM_API_URL = 'https://mock.invalid/v1/chat/completions';
  process.env.LLM_MODEL = 'mock-model';
  return tmp;
}

async function bootServer(t, tmp) {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/server/src/')) delete require.cache[key];
  }
  const { buildServer } = require('../src/index');
  const fastify = await buildServer();
  t.after(async () => {
    await fastify.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  return fastify;
}

async function loginAs(fastify, username, password) {
  const r = await fastify.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  assert.strictEqual(r.statusCode, 200, `login failed: ${r.body}`);
  return r.json().token;
}

// ---------------------------------------------------------------------------
// LLM mock helpers
// ---------------------------------------------------------------------------

function makeSseResponse(chunks) {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/**
 * Install a fake fetch that returns `turns[i]` for the i-th call to the
 * mocked LLM URL. Captures the request bodies so tests can assert on
 * the tools / system prompt sent to the model.
 */
function installMockFetch(t, turns, captured = []) {
  const realFetch = globalThis.fetch;
  let i = 0;
  globalThis.fetch = async (url, init) => {
    if (typeof url === 'string' && url === process.env.LLM_API_URL) {
      try {
        captured.push(JSON.parse(init.body));
      } catch {
        captured.push({ _raw: init.body });
      }
      const chunks = turns[i++];
      if (!chunks) throw new Error(`mock LLM ran out of turns at index ${i}`);
      return makeSseResponse(chunks);
    }
    return realFetch(url, init);
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  return captured;
}

function dataChunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}
function doneChunk() {
  return `data: [DONE]\n\n`;
}

// ---------------------------------------------------------------------------
// Skill ZIP fixture (agent-mode: SKILL.md only, no entry script)
// ---------------------------------------------------------------------------

function buildAgentOnlySkill() {
  const zip = new AdmZip();
  zip.addFile(
    'SKILL.md',
    Buffer.from(
      `---\nname: agent-only\ndescription: "Generates simple xlsx files via Python at runtime"\n---\n` +
        `# agent-only\n\n` +
        `When the user asks for an xlsx, write Python that uses openpyxl to assemble the workbook ` +
        `and save it under \`os.environ['OPENSKILL_OUTPUT_DIR']\`.\n`,
    ),
  );
  // A template file the LLM can reference if it wants — confirms CWD setup
  zip.addFile('templates/note.txt', Buffer.from('agent-mode template', 'utf8'));
  return zip.toBuffer();
}

const BOUNDARY = '----openskillChatAgentTest1234567890';
function multipartHeaders() {
  return { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };
}
function multipartBody(parts) {
  const chunks = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\n`));
    if ('filename' in p) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n` +
            `Content-Type: ${p.contentType || 'application/octet-stream'}\r\n\r\n`,
        ),
      );
      chunks.push(p.value);
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}`,
        ),
      );
    }
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

async function uploadAgentOnlyAsAdmin(fastify, token) {
  const body = multipartBody([
    { name: 'slug', value: 'agent-only' },
    {
      name: 'file',
      filename: 'agent-only.zip',
      contentType: 'application/zip',
      value: buildAgentOnlySkill(),
    },
  ]);
  const res = await fastify.inject({
    method: 'POST',
    url: '/api/skills',
    headers: { ...multipartHeaders(), authorization: `Bearer ${token}` },
    payload: body,
  });
  assert.strictEqual(res.statusCode, 201, `upload failed: ${res.body}`);
  return res.json().skill;
}

function parseClientSse(body) {
  const events = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') {
      events.push({ done: true });
      continue;
    }
    try {
      events.push(JSON.parse(data));
    } catch {
      /* skip */
    }
  }
  return events;
}

// ===========================================================================
// Tests
// ===========================================================================

test('agent-mode: tools array exposes run_python_code (not run_skill)', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const token = await loginAs(fastify, 'rootadmin', 'rootpass');
  const skill = await uploadAgentOnlyAsAdmin(fastify, token);

  // Single plain-text turn so we can capture what tools were sent
  const captured = [];
  installMockFetch(
    t,
    [
      [
        dataChunk({ choices: [{ delta: { content: 'I will use python.' } }] }),
        dataChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        doneChunk(),
      ],
    ],
    captured,
  );

  const conv = await fastify.inject({
    method: 'POST',
    url: '/api/chat/conversations',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ skill_id: skill.id }),
  });
  assert.strictEqual(conv.statusCode, 201);
  const convId = conv.json().id;

  const res = await fastify.inject({
    method: 'POST',
    url: `/api/chat/conversations/${convId}/messages`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ content: 'hello' }),
  });
  assert.strictEqual(res.statusCode, 200);

  const llmReq = captured[0];
  assert.ok(llmReq.tools && Array.isArray(llmReq.tools));
  assert.strictEqual(llmReq.tools.length, 1);
  assert.strictEqual(llmReq.tools[0].function.name, 'run_python_code');
  assert.ok(llmReq.tools[0].function.parameters.required.includes('code'));
  // System prompt must include the agent-mode hint AND the SKILL.md body
  const sys = llmReq.messages.find((m) => m.role === 'system');
  assert.ok(sys);
  assert.match(sys.content, /run_python_code/);
  assert.match(sys.content, /OPENSKILL_OUTPUT_DIR/);
  assert.match(sys.content, /openpyxl/);
});

test('agent-mode: model calls run_python_code, real .xlsx is produced and downloadable', {
  skip: !OPENPYXL_AVAILABLE,
}, async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const token = await loginAs(fastify, 'rootadmin', 'rootpass');
  const skill = await uploadAgentOnlyAsAdmin(fastify, token);

  // The Python code the "model" emits — uses openpyxl to write an .xlsx
  const llmCode = [
    'import os',
    'import openpyxl',
    'wb = openpyxl.Workbook()',
    'ws = wb.active',
    'ws.title = "Issues"',
    'ws.append(["id", "title", "status"])',
    'ws.append([1, "first issue", "open"])',
    'ws.append([2, "second issue", "closed"])',
    'wb.save(os.path.join(os.environ["OPENSKILL_OUTPUT_DIR"], "issues.xlsx"))',
  ].join('\n');

  installMockFetch(t, [
    // Turn 1: the model decides to call run_python_code
    [
      dataChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_py_1',
                  type: 'function',
                  function: { name: 'run_python_code', arguments: '' },
                },
              ],
            },
          },
        ],
      }),
      dataChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: JSON.stringify({ code: llmCode }) },
                },
              ],
            },
          },
        ],
      }),
      dataChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      doneChunk(),
    ],
    // Turn 2: model wraps up
    [
      dataChunk({ choices: [{ delta: { content: 'Your issues.xlsx is ready.' } }] }),
      dataChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      doneChunk(),
    ],
  ]);

  const conv = await fastify.inject({
    method: 'POST',
    url: '/api/chat/conversations',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ skill_id: skill.id }),
  });
  const convId = conv.json().id;

  const res = await fastify.inject({
    method: 'POST',
    url: `/api/chat/conversations/${convId}/messages`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ content: 'export the issues as xlsx' }),
  });
  assert.strictEqual(res.statusCode, 200);

  const events = parseClientSse(res.body);
  const toolCallEv = events.find((e) => e.tool_call);
  assert.ok(toolCallEv);
  assert.strictEqual(toolCallEv.tool_call.name, 'run_python_code');

  const toolDoneEv = events.find((e) => e.tool_done);
  assert.ok(toolDoneEv, 'tool_done missing');
  assert.strictEqual(toolDoneEv.tool_done.filename, 'issues.xlsx');
  assert.strictEqual(
    toolDoneEv.tool_done.content_type,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );

  const finalEv = events.find((e) => e.message);
  assert.ok(finalEv);
  assert.strictEqual(finalEv.message.content, 'Your issues.xlsx is ready.');
  assert.strictEqual(finalEv.message.artifacts.length, 1);
  const artifact = finalEv.message.artifacts[0];
  assert.strictEqual(artifact.filename, 'issues.xlsx');
  assert.strictEqual(artifact.skill_slug, 'agent-only');

  // Download the artifact, confirm it's a real .xlsx (PK magic bytes)
  const dl = await fastify.inject({
    method: 'GET',
    url: `/api/chat/artifacts/${artifact.id}/download`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.strictEqual(dl.statusCode, 200);
  assert.strictEqual(
    dl.headers['content-type'],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  const buf = dl.rawPayload;
  assert.strictEqual(buf.subarray(0, 2).toString('hex'), '504b');
  assert.ok(buf.length > 1000);
});

test('agent-mode: bad python code surfaces SCRIPT_FAILED via tool_error', {
  skip: !PYTHON_AVAILABLE,
}, async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const token = await loginAs(fastify, 'rootadmin', 'rootpass');
  const skill = await uploadAgentOnlyAsAdmin(fastify, token);

  installMockFetch(t, [
    [
      dataChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_bad',
                  type: 'function',
                  function: {
                    name: 'run_python_code',
                    arguments: JSON.stringify({
                      code: 'raise RuntimeError("boom from agent")',
                    }),
                  },
                },
              ],
            },
          },
        ],
      }),
      dataChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      doneChunk(),
    ],
    [
      dataChunk({ choices: [{ delta: { content: 'sorry, that failed.' } }] }),
      dataChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      doneChunk(),
    ],
  ]);

  const conv = await fastify.inject({
    method: 'POST',
    url: '/api/chat/conversations',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ skill_id: skill.id }),
  });
  const convId = conv.json().id;

  const res = await fastify.inject({
    method: 'POST',
    url: `/api/chat/conversations/${convId}/messages`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ content: 'go' }),
  });
  assert.strictEqual(res.statusCode, 200);

  const events = parseClientSse(res.body);
  const toolError = events.find((e) => e.tool_error);
  assert.ok(toolError);
  assert.strictEqual(toolError.tool_error.code, 'SCRIPT_FAILED');

  const finalEv = events.find((e) => e.message);
  assert.ok(finalEv);
  assert.strictEqual(finalEv.message.content, 'sorry, that failed.');
  assert.strictEqual(finalEv.message.artifacts.length, 0);
});

test('agent-mode: python code that produces nothing → EMPTY_OUTPUT tool_error', {
  skip: !PYTHON_AVAILABLE,
}, async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const token = await loginAs(fastify, 'rootadmin', 'rootpass');
  const skill = await uploadAgentOnlyAsAdmin(fastify, token);

  installMockFetch(t, [
    [
      dataChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'silent',
                  type: 'function',
                  function: {
                    name: 'run_python_code',
                    arguments: JSON.stringify({ code: 'print("nothing written")' }),
                  },
                },
              ],
            },
          },
        ],
      }),
      dataChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      doneChunk(),
    ],
    [
      dataChunk({ choices: [{ delta: { content: 'no file produced' } }] }),
      dataChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      doneChunk(),
    ],
  ]);

  const conv = await fastify.inject({
    method: 'POST',
    url: '/api/chat/conversations',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ skill_id: skill.id }),
  });
  const convId = conv.json().id;
  const res = await fastify.inject({
    method: 'POST',
    url: `/api/chat/conversations/${convId}/messages`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ content: 'go' }),
  });
  assert.strictEqual(res.statusCode, 200);

  const events = parseClientSse(res.body);
  const toolError = events.find((e) => e.tool_error);
  assert.ok(toolError);
  assert.strictEqual(toolError.tool_error.code, 'EMPTY_OUTPUT');

  const finalEv = events.find((e) => e.message);
  assert.strictEqual(finalEv.message.artifacts.length, 0);
});

test('agent-mode: empty `code` argument → BAD_ARGUMENTS tool_error', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const token = await loginAs(fastify, 'rootadmin', 'rootpass');
  const skill = await uploadAgentOnlyAsAdmin(fastify, token);

  installMockFetch(t, [
    [
      dataChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'empty',
                  type: 'function',
                  function: {
                    name: 'run_python_code',
                    arguments: JSON.stringify({ code: '   ' }),
                  },
                },
              ],
            },
          },
        ],
      }),
      dataChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      doneChunk(),
    ],
    [
      dataChunk({ choices: [{ delta: { content: 'oops, empty code' } }] }),
      dataChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      doneChunk(),
    ],
  ]);

  const conv = await fastify.inject({
    method: 'POST',
    url: '/api/chat/conversations',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ skill_id: skill.id }),
  });
  const convId = conv.json().id;
  const res = await fastify.inject({
    method: 'POST',
    url: `/api/chat/conversations/${convId}/messages`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ content: 'go' }),
  });
  assert.strictEqual(res.statusCode, 200);

  const events = parseClientSse(res.body);
  const toolError = events.find((e) => e.tool_error);
  assert.ok(toolError);
  assert.strictEqual(toolError.tool_error.code, 'BAD_ARGUMENTS');
});

test('agent-mode: model wrongly calls run_skill → UNKNOWN_TOOL', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const token = await loginAs(fastify, 'rootadmin', 'rootpass');
  const skill = await uploadAgentOnlyAsAdmin(fastify, token);

  installMockFetch(t, [
    [
      dataChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'wrong',
                  type: 'function',
                  function: {
                    name: 'run_skill',
                    arguments: JSON.stringify({ input: {} }),
                  },
                },
              ],
            },
          },
        ],
      }),
      dataChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      doneChunk(),
    ],
    [
      dataChunk({ choices: [{ delta: { content: 'Tool not available' } }] }),
      dataChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      doneChunk(),
    ],
  ]);

  const conv = await fastify.inject({
    method: 'POST',
    url: '/api/chat/conversations',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ skill_id: skill.id }),
  });
  const convId = conv.json().id;
  const res = await fastify.inject({
    method: 'POST',
    url: `/api/chat/conversations/${convId}/messages`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ content: 'go' }),
  });
  assert.strictEqual(res.statusCode, 200);

  const events = parseClientSse(res.body);
  const toolError = events.find((e) => e.tool_error);
  assert.ok(toolError);
  assert.strictEqual(toolError.tool_error.code, 'UNKNOWN_TOOL');
  assert.match(toolError.tool_error.message, /run_python_code/);
});

// ===========================================================================
// Regression: SKILL.md authored for Claude Code (declares foreign tool
// names, references absolute Windows paths) must not derail the agent.
//
// This is the failure mode we hit in production with the `text-to-issuelist`
// skill: a 7 KB SKILL.md that says "Tool: run_python_with_write", points at
// `D:\chris.li\skill\foo.zip`, and writes to `WORKSPACE_DIR/artifacts/`. With
// the hint appended AFTER that prose, the model gave up on tool-calling and
// answered with empty promises like "好的，我来整理".
//
// Contract verified here:
//   1. AGENT_TOOL_HINT comes BEFORE the SKILL.md content in the system prompt
//   2. The hint contains the explicit Claude-Code tool-name translation table
//   3. The hint forbids the "好的，我来处理" empty-promise pattern
//   4. The model still emits a real tool_call against this skill, producing
//      an artifact end-to-end (mocked LLM)
// ===========================================================================

function buildClaudeCodeStyleSkill() {
  // SKILL.md that mimics the real-world `text-to-issuelist` failure case.
  // Importantly: declares Claude-Code-only tool names and Windows paths.
  const skillMd =
    `---\n` +
    `name: claude-style\n` +
    `description: "Generates an issue-list xlsx. Originally written for Claude Code."\n` +
    `tools: [run_python, run_python_with_write, open_in_session_tab, fdfind, folder_list, file_read, file_read_docx, file_read_pdf, file_read_pptx, file_type]\n` +
    `---\n\n` +
    `# claude-style\n\n` +
    `## Workflow\n\n` +
    `### Step 1: locate template\n` +
    `- **Tool**: \`run_python\`\n` +
    `- Search for \`D:\\\\chris.li\\\\skill\\\\claude-style.zip\` and unzip it.\n\n` +
    `### Step 2: write output\n` +
    `- **Tool**: \`run_python_with_write\`\n` +
    `- Save the file to \`WORKSPACE_DIR/artifacts/issuelist.xlsx\`.\n\n` +
    `### Step 3: present\n` +
    `- **Tool**: \`open_in_session_tab\`\n` +
    `- Open the file for the user.\n`;

  const zip = new AdmZip();
  zip.addFile('SKILL.md', Buffer.from(skillMd, 'utf8'));
  // A template — confirms CWD is set up so the LLM can read it.
  zip.addFile('templates/note.txt', Buffer.from('claude-style template body', 'utf8'));
  return zip.toBuffer();
}

async function uploadClaudeStyleAsAdmin(fastify, token) {
  const body = multipartBody([
    { name: 'slug', value: 'claude-style' },
    {
      name: 'file',
      filename: 'claude-style.zip',
      contentType: 'application/zip',
      value: buildClaudeCodeStyleSkill(),
    },
  ]);
  const res = await fastify.inject({
    method: 'POST',
    url: '/api/skills',
    headers: { ...multipartHeaders(), authorization: `Bearer ${token}` },
    payload: body,
  });
  assert.strictEqual(res.statusCode, 201, `upload failed: ${res.body}`);
  return res.json().skill;
}

test('agent-mode regression: SKILL.md hard-coded for Claude Code — hint sits in front, translation present, model still tool-calls', {
  skip: !PYTHON_AVAILABLE,
}, async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const token = await loginAs(fastify, 'rootadmin', 'rootpass');
  const skill = await uploadClaudeStyleAsAdmin(fastify, token);

  // Mocked model emits a real run_python_code tool_call (proves the prompt
  // didn't mislead it into a different tool name) followed by a wrap-up.
  // The captured request body lets us assert system-prompt structure.
  const captured = [];
  installMockFetch(
    t,
    [
      [
        dataChunk({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_regression',
                    type: 'function',
                    function: { name: 'run_python_code', arguments: '' },
                  },
                ],
              },
            },
          ],
        }),
        dataChunk({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      arguments: JSON.stringify({
                        code:
                          "import os\n" +
                          "with open(os.path.join(os.environ['OPENSKILL_OUTPUT_DIR'], 'out.txt'), 'w', encoding='utf-8') as f:\n" +
                          "    f.write('regression ok')\n",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        dataChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        doneChunk(),
      ],
      [
        dataChunk({ choices: [{ delta: { content: 'Done.' } }] }),
        dataChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        doneChunk(),
      ],
    ],
    captured,
  );

  const conv = await fastify.inject({
    method: 'POST',
    url: '/api/chat/conversations',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ skill_id: skill.id }),
  });
  const convId = conv.json().id;

  const res = await fastify.inject({
    method: 'POST',
    url: `/api/chat/conversations/${convId}/messages`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ content: '生成一个 issue list' }),
  });
  assert.strictEqual(res.statusCode, 200);

  // ---- 1. System-prompt structure ----
  const llmReq = captured[0];
  const sys = llmReq.messages.find((m) => m.role === 'system');
  assert.ok(sys, 'system message missing');

  // The OpenSkill runtime block must come before the SKILL.md content
  const runtimeAnchorIdx = sys.content.indexOf('OpenSkill agent runtime');
  const skillMdAnchorIdx = sys.content.indexOf('Skill domain context');
  // Pick a string that ONLY exists in the demoted SKILL.md body (not in
  // the runtime hint translation table). The SKILL.md uses a section
  // header that we know our hint does not contain.
  const skillBodyMarkerIdx = sys.content.indexOf('Step 1: locate template');
  assert.ok(runtimeAnchorIdx >= 0, 'agent runtime block missing from system prompt');
  assert.ok(skillMdAnchorIdx > runtimeAnchorIdx, 'SKILL.md must follow runtime hint, not precede it');
  assert.ok(
    skillBodyMarkerIdx > skillMdAnchorIdx,
    `expected the demoted SKILL.md body to follow the domain-context header. ` +
      `runtimeIdx=${runtimeAnchorIdx} skillMdIdx=${skillMdAnchorIdx} bodyIdx=${skillBodyMarkerIdx}`,
  );

  // ---- 2. Translation table is present ----
  // We don't lock the exact wording, but a few critical strings must be there.
  assert.match(sys.content, /run_python_code/);
  assert.match(sys.content, /OPENSKILL_OUTPUT_DIR/);
  // Translation entries
  assert.match(sys.content, /run_python_with_write/);
  assert.match(sys.content, /open_in_session_tab/);
  assert.match(sys.content, /WORKSPACE_DIR/);
  // Anti-prose-promise rule
  assert.match(sys.content, /好的，我来处理|FORBIDDEN/);

  // ---- 3. Tool exposed to LLM is run_python_code (not run_skill) ----
  assert.ok(Array.isArray(llmReq.tools));
  assert.strictEqual(llmReq.tools.length, 1);
  assert.strictEqual(llmReq.tools[0].function.name, 'run_python_code');

  // ---- 4. Model still actually tool-called and produced an artifact ----
  const events = parseClientSse(res.body);
  const toolCallEv = events.find((e) => e.tool_call);
  assert.ok(toolCallEv, 'expected tool_call SSE event');
  assert.strictEqual(toolCallEv.tool_call.name, 'run_python_code');
  const toolDoneEv = events.find((e) => e.tool_done);
  assert.ok(toolDoneEv, 'expected tool_done SSE event');
  assert.strictEqual(toolDoneEv.tool_done.filename, 'out.txt');

  const finalEv = events.find((e) => e.message);
  assert.ok(finalEv);
  assert.strictEqual(finalEv.message.artifacts.length, 1);
  assert.strictEqual(finalEv.message.artifacts[0].filename, 'out.txt');
});

test('agent-mode regression: with no SKILL.md content the hint still appears alone', async (t) => {
  // Defensive: if a skill somehow has empty SKILL.md content (shouldn't
  // happen because the validator requires frontmatter, but defensive
  // belts-and-braces), the runtime hint must still drive the model.
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const token = await loginAs(fastify, 'rootadmin', 'rootpass');
  const skill = await uploadAgentOnlyAsAdmin(fastify, token);

  // Wipe skill_md_content directly in DB for this conversation's skill
  fastify.db
    .prepare('UPDATE skills SET skill_md_content = ? WHERE id = ?')
    .run('', skill.id);

  const captured = [];
  installMockFetch(
    t,
    [
      [
        dataChunk({ choices: [{ delta: { content: 'ok' } }] }),
        dataChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        doneChunk(),
      ],
    ],
    captured,
  );

  const conv = await fastify.inject({
    method: 'POST',
    url: '/api/chat/conversations',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ skill_id: skill.id }),
  });
  const convId = conv.json().id;

  const res = await fastify.inject({
    method: 'POST',
    url: `/api/chat/conversations/${convId}/messages`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ content: 'hi' }),
  });
  assert.strictEqual(res.statusCode, 200);

  const sys = captured[0].messages.find((m) => m.role === 'system');
  assert.ok(sys);
  assert.match(sys.content, /OpenSkill agent runtime/);
  assert.match(sys.content, /run_python_code/);
  // No "domain context" header since SKILL.md is empty
  assert.doesNotMatch(sys.content, /Skill domain context/);
});
