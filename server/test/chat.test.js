'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const AdmZip = require('adm-zip');

// ---------------------------------------------------------------------------
// Test environment helpers (mirrors the patterns in skills.test.js)
// ---------------------------------------------------------------------------

function freshEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openskill-chat-'));
  process.env.DB_PATH = path.join(tmp, 'test.db');
  process.env.STORAGE_DIR = path.join(tmp, 'storage');
  process.env.JWT_SECRET = 'test-jwt';
  process.env.LOG_LEVEL = 'silent';
  process.env.ADMIN_INITIAL_USERNAME = 'rootadmin';
  process.env.ADMIN_INITIAL_EMAIL = 'root@example.com';
  process.env.ADMIN_INITIAL_PASSWORD = 'rootpass';
  process.env.MAX_UPLOAD_MB = '20';
  // Required by llm.js — mocked fetch will not actually contact the URL.
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

async function registerUser(fastify, username) {
  const r = await fastify.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, email: `${username}@test.com`, password: 'pa$$w0rd1' },
  });
  assert.strictEqual(r.statusCode, 201);
  return r.json().token;
}

// ---------------------------------------------------------------------------
// LLM mock helpers — every call to the LLM URL is intercepted; consecutive
// calls return successive "turns". Each turn is an array of SSE strings.
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
 * Install a fake global fetch that replies with `turns[i]` on the i-th
 * call to the mocked LLM URL, and forwards anything else to the real fetch.
 * Returns the cleanup function.
 */
function installMockFetch(t, turns) {
  const realFetch = globalThis.fetch;
  let i = 0;
  globalThis.fetch = async (url, init) => {
    if (typeof url === 'string' && url === process.env.LLM_API_URL) {
      const chunks = turns[i++];
      if (!chunks) throw new Error(`mock LLM ran out of turns at index ${i}`);
      return makeSseResponse(chunks);
    }
    return realFetch(url, init);
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });
}

// SSE chunk builders — keep tests readable.
function dataChunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}
function doneChunk() {
  return `data: [DONE]\n\n`;
}

// ---------------------------------------------------------------------------
// Skill ZIP fixture builders
// ---------------------------------------------------------------------------

function buildEchoSkill() {
  const zip = new AdmZip();
  zip.addFile(
    'SKILL.md',
    Buffer.from(
      `---\nname: echo-text\ndescription: "Writes the input.text into a .txt file."\n---\n# echo-text\n`,
    ),
  );
  zip.addFile(
    'manifest.json',
    Buffer.from(
      JSON.stringify({
        name: 'echo-text',
        version: '1.0.0',
        run: { entry: 'scripts/run.js' },
      }),
    ),
  );
  zip.addFile(
    'scripts/run.js',
    Buffer.from(`
      const fs = require('fs');
      const path = require('path');
      const data = JSON.parse(fs.readFileSync(process.env.OPENSKILL_INPUT_FILE, 'utf8'));
      fs.writeFileSync(
        path.join(process.env.OPENSKILL_OUTPUT_DIR, 'message.txt'),
        String(data.text || ''),
      );
    `),
  );
  return zip.toBuffer();
}

const BOUNDARY = '----openskillChatTest1234567890';
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

async function uploadEchoAsAdmin(fastify, token) {
  const body = multipartBody([
    { name: 'slug', value: 'echo-text' },
    {
      name: 'file',
      filename: 'echo-text.zip',
      contentType: 'application/zip',
      value: buildEchoSkill(),
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

// ---------------------------------------------------------------------------
// Parse the SSE response body that the chat route streams back. Returns
// the structured events the client would see.
// ---------------------------------------------------------------------------

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
// llm.js — tool_call parser unit test (no chat route, no DB)
// ===========================================================================

test('llmTurn: accumulates tool_call arguments across streaming chunks', async () => {
  freshEnv();
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/server/src/')) delete require.cache[key];
  }
  const { llmTurn } = require('../src/llm');

  const chunks = [
    dataChunk({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_abc',
                type: 'function',
                function: { name: 'run_skill', arguments: '' },
              },
            ],
          },
        },
      ],
    }),
    dataChunk({
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { arguments: '{"input"' } }] } },
      ],
    }),
    dataChunk({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: ':{"text":"hello"}}' } },
            ],
          },
        },
      ],
    }),
    dataChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    doneChunk(),
  ];

  const fakeFetch = async () => makeSseResponse(chunks);

  const events = [];
  for await (const ev of llmTurn({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'run_skill', parameters: {} } }],
    deps: { fetch: fakeFetch },
  })) {
    events.push(ev);
  }

  // Expect exactly one tool_call event whose accumulated arguments parse to
  // the original input, then a 'done'.
  const toolCallEvents = events.filter((e) => e.type === 'tool_call');
  assert.strictEqual(toolCallEvents.length, 1);
  assert.strictEqual(toolCallEvents[0].tool_call.id, 'call_abc');
  assert.strictEqual(toolCallEvents[0].tool_call.name, 'run_skill');
  assert.deepStrictEqual(JSON.parse(toolCallEvents[0].tool_call.arguments), {
    input: { text: 'hello' },
  });

  const doneEvent = events.find((e) => e.type === 'done');
  assert.ok(doneEvent);
  assert.strictEqual(doneEvent.finishReason, 'tool_calls');
});

test('llmTurn: streams text deltas as they arrive', async () => {
  freshEnv();
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/server/src/')) delete require.cache[key];
  }
  const { llmTurn } = require('../src/llm');

  const chunks = [
    dataChunk({ choices: [{ delta: { content: 'Hel' } }] }),
    dataChunk({ choices: [{ delta: { content: 'lo' } }] }),
    dataChunk({ choices: [{ delta: { content: ', world' } }] }),
    dataChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    doneChunk(),
  ];

  const events = [];
  for await (const ev of llmTurn({
    messages: [{ role: 'user', content: 'hi' }],
    deps: { fetch: async () => makeSseResponse(chunks) },
  })) {
    events.push(ev);
  }

  const text = events
    .filter((e) => e.type === 'text')
    .map((e) => e.delta)
    .join('');
  assert.strictEqual(text, 'Hello, world');
});

// ===========================================================================
// Chat route: end-to-end with mocked LLM
// ===========================================================================

test('POST /messages: with no skill attached, plain text turn, no tools, no artifacts', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const token = await loginAs(fastify, 'rootadmin', 'rootpass');

  installMockFetch(t, [
    [
      dataChunk({ choices: [{ delta: { content: 'plain reply' } }] }),
      dataChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      doneChunk(),
    ],
  ]);

  // Create conversation (no skill)
  const conv = await fastify.inject({
    method: 'POST',
    url: '/api/chat/conversations',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: '{}',
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

  const events = parseClientSse(res.body);
  const text = events.filter((e) => e.content).map((e) => e.content).join('');
  assert.strictEqual(text, 'plain reply');
  // No tool events
  assert.strictEqual(events.some((e) => e.tool_call), false);
  assert.strictEqual(events.some((e) => e.tool_done), false);
  // Final message arrives with no artifacts
  const finalMsg = events.find((e) => e.message);
  assert.ok(finalMsg);
  assert.deepStrictEqual(finalMsg.message.artifacts, []);
});

test('POST /messages: with runnable skill, model calls run_skill, artifact persisted, download works', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const token = await loginAs(fastify, 'rootadmin', 'rootpass');

  // Upload the echo-text skill
  const skill = await uploadEchoAsAdmin(fastify, token);

  // Mock LLM: turn 1 = tool_call(run_skill, {input:{text:"hi from chat"}}),
  //          turn 2 = "done!"
  installMockFetch(t, [
    [
      dataChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'run_skill', arguments: '' },
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
                  function: { arguments: '{"input":{"text":"hi from chat"}}' },
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
      dataChunk({ choices: [{ delta: { content: 'done!' } }] }),
      dataChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      doneChunk(),
    ],
  ]);

  // Create conversation with that skill
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
    payload: JSON.stringify({ content: 'please make me a file' }),
  });
  assert.strictEqual(res.statusCode, 200);

  const events = parseClientSse(res.body);

  // Tool call lifecycle is reported
  const toolCallEv = events.find((e) => e.tool_call);
  assert.ok(toolCallEv, 'tool_call event missing');
  assert.strictEqual(toolCallEv.tool_call.name, 'run_skill');

  const toolDoneEv = events.find((e) => e.tool_done);
  assert.ok(toolDoneEv, 'tool_done event missing');
  assert.strictEqual(toolDoneEv.tool_done.filename, 'message.txt');
  assert.strictEqual(toolDoneEv.tool_done.content_type, 'text/plain; charset=utf-8');
  assert.ok(toolDoneEv.tool_done.size_bytes > 0);

  // Final assistant message text + persisted artifact metadata
  const finalEv = events.find((e) => e.message);
  assert.ok(finalEv);
  assert.strictEqual(finalEv.message.content, 'done!');
  assert.strictEqual(finalEv.message.artifacts.length, 1);
  const artifact = finalEv.message.artifacts[0];
  assert.strictEqual(artifact.filename, 'message.txt');
  assert.strictEqual(artifact.content_type, 'text/plain; charset=utf-8');
  assert.strictEqual(artifact.skill_slug, 'echo-text');

  // GET /messages echoes the artifact too
  const msgsRes = await fastify.inject({
    method: 'GET',
    url: `/api/chat/conversations/${convId}/messages`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.strictEqual(msgsRes.statusCode, 200);
  const msgs = msgsRes.json().items;
  const assistantRow = msgs.find((m) => m.role === 'assistant');
  assert.ok(assistantRow);
  assert.strictEqual(assistantRow.artifacts.length, 1);
  assert.strictEqual(assistantRow.artifacts[0].id, artifact.id);

  // Download the artifact
  const dl = await fastify.inject({
    method: 'GET',
    url: `/api/chat/artifacts/${artifact.id}/download`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.strictEqual(dl.statusCode, 200);
  assert.strictEqual(dl.headers['content-type'], 'text/plain; charset=utf-8');
  assert.match(dl.headers['content-disposition'], /filename="message\.txt"/);
  assert.strictEqual(dl.rawPayload.toString('utf8'), 'hi from chat');
});

test('POST /messages: tool failure surfaces as tool_error and assistant continues', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const token = await loginAs(fastify, 'rootadmin', 'rootpass');

  // Upload a skill whose script intentionally exits non-zero
  const zip = new AdmZip();
  zip.addFile(
    'SKILL.md',
    Buffer.from(`---\nname: broken\ndescription: "fails"\n---\n# broken\n`),
  );
  zip.addFile('scripts/run.js', Buffer.from('process.exit(7)'));
  const upload = await fastify.inject({
    method: 'POST',
    url: '/api/skills',
    headers: { ...multipartHeaders(), authorization: `Bearer ${token}` },
    payload: multipartBody([
      { name: 'slug', value: 'broken' },
      {
        name: 'file',
        filename: 'broken.zip',
        contentType: 'application/zip',
        value: zip.toBuffer(),
      },
    ]),
  });
  assert.strictEqual(upload.statusCode, 201);
  const skillId = upload.json().skill.id;

  installMockFetch(t, [
    [
      dataChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_x',
                  type: 'function',
                  function: { name: 'run_skill', arguments: '{"input":{}}' },
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
      dataChunk({ choices: [{ delta: { content: 'sorry, that failed' } }] }),
      dataChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      doneChunk(),
    ],
  ]);

  const conv = await fastify.inject({
    method: 'POST',
    url: '/api/chat/conversations',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ skill_id: skillId }),
  });
  const convId = conv.json().id;

  const res = await fastify.inject({
    method: 'POST',
    url: `/api/chat/conversations/${convId}/messages`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ content: 'go!' }),
  });
  assert.strictEqual(res.statusCode, 200);

  const events = parseClientSse(res.body);
  const toolError = events.find((e) => e.tool_error);
  assert.ok(toolError);
  assert.strictEqual(toolError.tool_error.code, 'SCRIPT_FAILED');

  // Assistant still produced a final message; no artifacts
  const finalEv = events.find((e) => e.message);
  assert.ok(finalEv);
  assert.strictEqual(finalEv.message.content, 'sorry, that failed');
  assert.strictEqual(finalEv.message.artifacts.length, 0);
});

test('GET /chat/artifacts/:id/download: another user cannot access', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const adminToken = await loginAs(fastify, 'rootadmin', 'rootpass');
  const skill = await uploadEchoAsAdmin(fastify, adminToken);

  installMockFetch(t, [
    [
      dataChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'c',
                  type: 'function',
                  function: {
                    name: 'run_skill',
                    arguments: '{"input":{"text":"secret"}}',
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
      dataChunk({ choices: [{ delta: { content: 'ok' } }] }),
      dataChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      doneChunk(),
    ],
  ]);

  // Admin creates a chat with the skill and produces an artifact
  const conv = await fastify.inject({
    method: 'POST',
    url: '/api/chat/conversations',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ skill_id: skill.id }),
  });
  const convId = conv.json().id;
  const res = await fastify.inject({
    method: 'POST',
    url: `/api/chat/conversations/${convId}/messages`,
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ content: 'go' }),
  });
  const finalEv = parseClientSse(res.body).find((e) => e.message);
  const artifactId = finalEv.message.artifacts[0].id;

  // Register an unrelated user; she should NOT be able to download
  const aliceToken = await registerUser(fastify, 'alice');

  // Anonymous → 401
  const anon = await fastify.inject({
    method: 'GET',
    url: `/api/chat/artifacts/${artifactId}/download`,
  });
  assert.strictEqual(anon.statusCode, 401);

  // Alice → 403
  const aliceRes = await fastify.inject({
    method: 'GET',
    url: `/api/chat/artifacts/${artifactId}/download`,
    headers: { authorization: `Bearer ${aliceToken}` },
  });
  assert.strictEqual(aliceRes.statusCode, 403);

  // Owner → 200
  const okRes = await fastify.inject({
    method: 'GET',
    url: `/api/chat/artifacts/${artifactId}/download`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.strictEqual(okRes.statusCode, 200);
  assert.strictEqual(okRes.rawPayload.toString('utf8'), 'secret');
});

test('DELETE /chat/conversations/:id: cascades artifact rows + cleans files from disk', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const token = await loginAs(fastify, 'rootadmin', 'rootpass');
  const skill = await uploadEchoAsAdmin(fastify, token);

  installMockFetch(t, [
    [
      dataChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'c',
                  type: 'function',
                  function: {
                    name: 'run_skill',
                    arguments: '{"input":{"text":"bye"}}',
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
      dataChunk({ choices: [{ delta: { content: 'ok' } }] }),
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
  const finalEv = parseClientSse(res.body).find((e) => e.message);
  const artifactId = finalEv.message.artifacts[0].id;

  // Locate the on-disk artifact path through the DB
  const row = fastify.db
    .prepare('SELECT file_path FROM artifacts WHERE id = ?')
    .get(artifactId);
  assert.ok(row);
  const absPath = path.join(process.env.STORAGE_DIR, 'artifacts', row.file_path);
  assert.ok(fs.existsSync(absPath));

  // Delete the conversation
  const del = await fastify.inject({
    method: 'DELETE',
    url: `/api/chat/conversations/${convId}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.strictEqual(del.statusCode, 204);

  // DB row gone (CASCADE)
  const after = fastify.db
    .prepare('SELECT id FROM artifacts WHERE id = ?')
    .get(artifactId);
  assert.strictEqual(after, undefined);

  // File gone
  assert.strictEqual(fs.existsSync(absPath), false);
});
