'use strict';

/**
 * Python runtime tests (Phase 1 of TODO-python-agent-mode.md).
 *
 * Mirrors the patterns in run.test.js but builds a skill whose entry is
 * `scripts/run.py`. We do NOT exercise the full LibreOffice / pandas
 * stack here — that lives in the example skill end-to-end test. These
 * cover the runtime-dispatch contract:
 *
 *  - detectExecutionMode picks the right mode for python entry / manifest
 *  - the runner spawns python3, exposes OPENSKILL_OUTPUT_DIR/_INPUT_FILE
 *  - the HTTP /run path streams the produced file back
 *  - script failures + timeouts surface as the expected error codes
 *  - openpyxl works through PYTHONPATH (when available on the host)
 *
 * Most assertions also work on a host that doesn't have python3 — see the
 * `t.skip()` guard at the top of each Python-spawning test.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const AdmZip = require('adm-zip');

// ---------------------------------------------------------------------------
// Capability detection — only run python tests when the interpreter exists.
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
// Fixtures
// ---------------------------------------------------------------------------

function freshEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openskill-pyrun-'));
  process.env.DB_PATH = path.join(tmp, 'test.db');
  process.env.STORAGE_DIR = path.join(tmp, 'storage');
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.LOG_LEVEL = 'silent';
  process.env.ADMIN_INITIAL_USERNAME = 'rootadmin';
  process.env.ADMIN_INITIAL_EMAIL = 'root@example.com';
  process.env.ADMIN_INITIAL_PASSWORD = 'rootpass';
  process.env.MAX_UPLOAD_MB = '20';
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
  assert.strictEqual(r.statusCode, 200);
  return r.json().token;
}

const BOUNDARY = '----openskillPyRunTest1234567890';

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

/**
 * Build a Python skill ZIP.
 * @param {object} opts
 * @param {string} opts.name
 * @param {string} opts.runPy
 * @param {object|null} [opts.manifest]
 */
function buildPythonSkill({
  name,
  description = 'A Python test skill',
  runPy,
  manifest = null,
}) {
  const zip = new AdmZip();
  zip.addFile(
    'SKILL.md',
    Buffer.from(
      `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n# ${name}\n`,
    ),
  );
  zip.addFile('scripts/run.py', Buffer.from(runPy, 'utf8'));
  if (manifest) {
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest), 'utf8'));
  }
  return zip.toBuffer();
}

async function uploadAsAdmin(fastify, token, slug, zipBuffer) {
  const body = multipartBody([
    { name: 'slug', value: slug },
    {
      name: 'file',
      filename: `${slug}.zip`,
      contentType: 'application/zip',
      value: zipBuffer,
    },
  ]);
  const res = await fastify.inject({
    method: 'POST',
    url: '/api/skills',
    headers: { ...multipartHeaders(), authorization: `Bearer ${token}` },
    payload: body,
  });
  assert.strictEqual(res.statusCode, 201, `upload failed: ${res.statusCode} ${res.body}`);
  return res.json().skill.slug;
}

// ---------------------------------------------------------------------------
// detectExecutionMode unit tests (no python interpreter required)
// ---------------------------------------------------------------------------

test('detectExecutionMode: scripts/run.py present → python mode', () => {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/server/src/')) delete require.cache[key];
  }
  const { detectExecutionMode } = require('../src/skill-runner');

  const tree = [
    { path: 'SKILL.md', type: 'file' },
    { path: 'scripts', type: 'dir' },
    { path: 'scripts/run.py', type: 'file' },
  ];
  const r = detectExecutionMode(tree, null);
  assert.deepStrictEqual(r, { mode: 'python', entry: 'scripts/run.py' });
});

test('detectExecutionMode: scripts/run.js wins over scripts/run.py when both present', () => {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/server/src/')) delete require.cache[key];
  }
  const { detectExecutionMode } = require('../src/skill-runner');
  const tree = [
    { path: 'SKILL.md', type: 'file' },
    { path: 'scripts/run.js', type: 'file' },
    { path: 'scripts/run.py', type: 'file' },
  ];
  const r = detectExecutionMode(tree, null);
  assert.deepStrictEqual(r, { mode: 'node', entry: 'scripts/run.js' });
});

test('detectExecutionMode: only SKILL.md → agent mode', () => {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/server/src/')) delete require.cache[key];
  }
  const { detectExecutionMode } = require('../src/skill-runner');
  const tree = [{ path: 'SKILL.md', type: 'file' }];
  const r = detectExecutionMode(tree, null);
  assert.deepStrictEqual(r, { mode: 'agent' });
});

test('detectExecutionMode: manifest.run.entry = scripts/foo.py → python mode', () => {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/server/src/')) delete require.cache[key];
  }
  const { detectExecutionMode } = require('../src/skill-runner');
  const tree = [
    { path: 'SKILL.md', type: 'file' },
    { path: 'scripts/foo.py', type: 'file' },
  ];
  const r = detectExecutionMode(tree, { run: { entry: 'scripts/foo.py' } });
  assert.deepStrictEqual(r, { mode: 'python', entry: 'scripts/foo.py' });
});

test('detectExecutionMode: manifest.run.runtime = ruby → unsupported', () => {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/server/src/')) delete require.cache[key];
  }
  const { detectExecutionMode } = require('../src/skill-runner');
  const tree = [{ path: 'SKILL.md', type: 'file' }];
  const r = detectExecutionMode(tree, { run: { runtime: 'ruby' } });
  assert.strictEqual(r.mode, 'unsupported');
});

test('checkRunnable: python skill returns null (runnable)', () => {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/server/src/')) delete require.cache[key];
  }
  const { checkRunnable } = require('../src/skill-runner');
  const tree = [
    { path: 'SKILL.md', type: 'file' },
    { path: 'scripts/run.py', type: 'file' },
  ];
  assert.strictEqual(checkRunnable(tree, null), null);
});

test('checkRunnable: agent-mode skill is NOT runnable through Run tab', () => {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/server/src/')) delete require.cache[key];
  }
  const { checkRunnable } = require('../src/skill-runner');
  const tree = [{ path: 'SKILL.md', type: 'file' }];
  const reason = checkRunnable(tree, null);
  assert.ok(typeof reason === 'string' && reason.length > 0);
});

// ---------------------------------------------------------------------------
// Pure runner tests — require a python3 interpreter on PATH
// ---------------------------------------------------------------------------

test('runner(python): happy path produces a single text file', { skip: !PYTHON_AVAILABLE }, async () => {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/server/src/')) delete require.cache[key];
  }
  const { runSkill } = require('../src/skill-runner');

  const zipBuffer = buildPythonSkill({
    name: 'py-echo',
    runPy: `
import json, os, sys

with open(os.environ['OPENSKILL_INPUT_FILE'], 'r', encoding='utf-8') as f:
    data = json.load(f)

out = os.path.join(os.environ['OPENSKILL_OUTPUT_DIR'], 'greeting.txt')
with open(out, 'w', encoding='utf-8') as f:
    f.write('hello, ' + str(data.get('who', 'world')))
`,
  });

  const r = await runSkill({ zipBuffer, input: { who: 'Alice' } });
  assert.strictEqual(r.runtime, 'python');
  assert.strictEqual(r.filename, 'greeting.txt');
  assert.strictEqual(r.contentType, 'text/plain; charset=utf-8');
  assert.strictEqual(r.data.toString('utf8'), 'hello, Alice');
  assert.ok(r.durationMs >= 0);
});

test('runner(python): non-zero exit → SCRIPT_FAILED with stderr', { skip: !PYTHON_AVAILABLE }, async () => {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/server/src/')) delete require.cache[key];
  }
  const { runSkill, RunnerError } = require('../src/skill-runner');

  const zipBuffer = buildPythonSkill({
    name: 'py-broken',
    runPy: `
import sys
sys.stderr.write('boom from python\\n')
sys.exit(3)
`,
  });

  await assert.rejects(
    runSkill({ zipBuffer, input: {} }),
    (err) => {
      if (!(err instanceof RunnerError) || err.code !== 'SCRIPT_FAILED') return false;
      assert.strictEqual(err.detail.exitCode, 3);
      assert.match(err.detail.stderr, /boom from python/);
      return true;
    },
  );
});

test('runner(python): exceeding timeout → TIMEOUT', { skip: !PYTHON_AVAILABLE }, async () => {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/server/src/')) delete require.cache[key];
  }
  const { runSkill, RunnerError } = require('../src/skill-runner');

  const zipBuffer = buildPythonSkill({
    name: 'py-slow',
    runPy: `
import time
time.sleep(60)
`,
  });

  await assert.rejects(
    runSkill({ zipBuffer, input: {}, limits: { timeoutMs: 1000 } }),
    (err) => err instanceof RunnerError && err.code === 'TIMEOUT',
  );
});

test('runner(python): manifest.run.entry override is respected', { skip: !PYTHON_AVAILABLE }, async () => {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/server/src/')) delete require.cache[key];
  }
  const { runSkill } = require('../src/skill-runner');

  const zip = new AdmZip();
  zip.addFile(
    'SKILL.md',
    Buffer.from(`---\nname: py-custom\ndescription: "uses a custom entry"\n---\n# x\n`),
  );
  zip.addFile(
    'manifest.json',
    Buffer.from(
      JSON.stringify({
        name: 'py-custom',
        version: '1.0.0',
        run: { entry: 'scripts/main.py', timeout_ms: 10_000 },
      }),
    ),
  );
  zip.addFile(
    'scripts/main.py',
    Buffer.from(
      `
import os, pathlib
out = pathlib.Path(os.environ['OPENSKILL_OUTPUT_DIR']) / 'r.txt'
out.write_text('custom-py-ok', encoding='utf-8')
`,
    ),
  );

  const r = await runSkill({
    zipBuffer: zip.toBuffer(),
    manifest: {
      name: 'py-custom',
      version: '1.0.0',
      run: { entry: 'scripts/main.py', timeout_ms: 10_000 },
    },
    input: {},
  });
  assert.strictEqual(r.runtime, 'python');
  assert.strictEqual(r.data.toString('utf8'), 'custom-py-ok');
});

test('runner(python): can import openpyxl from PYTHONPATH and write a real .xlsx', {
  skip: !OPENPYXL_AVAILABLE,
}, async () => {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/server/src/')) delete require.cache[key];
  }
  const { runSkill } = require('../src/skill-runner');

  const zipBuffer = buildPythonSkill({
    name: 'py-xlsx',
    runPy: `
import json, os
import openpyxl

with open(os.environ['OPENSKILL_INPUT_FILE'], 'r', encoding='utf-8') as f:
    data = json.load(f)

wb = openpyxl.Workbook()
ws = wb.active
ws.title = data.get('sheet', 'Sheet1')
for row in data.get('rows', [['hello']]):
    ws.append(row)

wb.save(os.path.join(os.environ['OPENSKILL_OUTPUT_DIR'], 'data.xlsx'))
`,
  });

  const r = await runSkill({
    zipBuffer,
    input: { sheet: 'Demo', rows: [['name', 'count'], ['apples', 3], ['oranges', 5]] },
  });
  assert.strictEqual(r.runtime, 'python');
  assert.strictEqual(
    r.contentType,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  // PK magic bytes confirm a real Office Open XML file
  assert.strictEqual(r.data.subarray(0, 2).toString('hex'), '504b');
  assert.ok(r.data.length > 1000);
});

// ---------------------------------------------------------------------------
// HTTP /run route tests for python entries
// ---------------------------------------------------------------------------

test('POST /api/skills/:slug/run — python entry returns produced file', {
  skip: !PYTHON_AVAILABLE,
}, async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const adminToken = await loginAs(fastify, 'rootadmin', 'rootpass');

  const zipBuffer = buildPythonSkill({
    name: 'py-greeter',
    runPy: `
import json, os
with open(os.environ['OPENSKILL_INPUT_FILE'], 'r', encoding='utf-8') as f:
    data = json.load(f)
inp = data.get('input', data)  # accept both {input:{...}} and {...}
who = inp.get('who', 'world')
with open(os.path.join(os.environ['OPENSKILL_OUTPUT_DIR'], 'hi.txt'), 'w', encoding='utf-8') as f:
    f.write('Hi from Python, ' + str(who))
`,
  });
  const slug = await uploadAsAdmin(fastify, adminToken, 'py-greeter', zipBuffer);

  const res = await fastify.inject({
    method: 'POST',
    url: `/api/skills/${slug}/run`,
    headers: {
      authorization: `Bearer ${adminToken}`,
      'content-type': 'application/json',
    },
    payload: JSON.stringify({ input: { who: 'OpenSkill' } }),
  });

  assert.strictEqual(res.statusCode, 200, `body: ${res.body}`);
  assert.strictEqual(res.headers['content-type'], 'text/plain; charset=utf-8');
  assert.match(res.headers['content-disposition'], /attachment; filename="hi\.txt"/);
  assert.strictEqual(res.rawPayload.toString('utf8'), 'Hi from Python, OpenSkill');
});

test('POST /api/skills/:slug/run — python script error → 422 SCRIPT_FAILED with stderr', {
  skip: !PYTHON_AVAILABLE,
}, async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const adminToken = await loginAs(fastify, 'rootadmin', 'rootpass');

  const zipBuffer = buildPythonSkill({
    name: 'py-broken-route',
    runPy: `
import sys
sys.stderr.write('explicit python failure\\n')
sys.exit(2)
`,
  });
  const slug = await uploadAsAdmin(fastify, adminToken, 'py-broken-route', zipBuffer);

  const res = await fastify.inject({
    method: 'POST',
    url: `/api/skills/${slug}/run`,
    headers: {
      authorization: `Bearer ${adminToken}`,
      'content-type': 'application/json',
    },
    payload: JSON.stringify({ input: {} }),
  });

  assert.strictEqual(res.statusCode, 422);
  const body = res.json();
  assert.strictEqual(body.code, 'SCRIPT_FAILED');
  assert.match(body.detail.stderr, /explicit python failure/);
  assert.strictEqual(body.detail.exitCode, 2);
});

test('POST /api/skills/:slug/run — python skill that produces nothing → EMPTY_OUTPUT', {
  skip: !PYTHON_AVAILABLE,
}, async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const adminToken = await loginAs(fastify, 'rootadmin', 'rootpass');

  const zipBuffer = buildPythonSkill({
    name: 'py-silent',
    runPy: `print('I make no files on purpose')`,
  });
  const slug = await uploadAsAdmin(fastify, adminToken, 'py-silent', zipBuffer);

  const res = await fastify.inject({
    method: 'POST',
    url: `/api/skills/${slug}/run`,
    headers: {
      authorization: `Bearer ${adminToken}`,
      'content-type': 'application/json',
    },
    payload: JSON.stringify({ input: {} }),
  });

  assert.strictEqual(res.statusCode, 422);
  assert.strictEqual(res.json().code, 'EMPTY_OUTPUT');
});

test('POST /api/skills/:slug/run — agent-mode skill (no entry) → 422 NOT_RUNNABLE', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const adminToken = await loginAs(fastify, 'rootadmin', 'rootpass');

  // Skill with only SKILL.md + a template, no scripts/run.{js,py}
  const zip = new AdmZip();
  zip.addFile(
    'SKILL.md',
    Buffer.from(
      `---\nname: agent-only\ndescription: "Agent-mode only — no entry script"\n---\n# agent-only\n`,
    ),
  );
  zip.addFile('templates/dummy.txt', Buffer.from('hi', 'utf8'));

  const body = multipartBody([
    { name: 'slug', value: 'agent-only' },
    {
      name: 'file',
      filename: 'agent-only.zip',
      contentType: 'application/zip',
      value: zip.toBuffer(),
    },
  ]);
  const upload = await fastify.inject({
    method: 'POST',
    url: '/api/skills',
    headers: { ...multipartHeaders(), authorization: `Bearer ${adminToken}` },
    payload: body,
  });
  assert.strictEqual(upload.statusCode, 201, upload.body);

  const res = await fastify.inject({
    method: 'POST',
    url: `/api/skills/agent-only/run`,
    headers: {
      authorization: `Bearer ${adminToken}`,
      'content-type': 'application/json',
    },
    payload: JSON.stringify({ input: {} }),
  });

  assert.strictEqual(res.statusCode, 422);
  assert.strictEqual(res.json().code, 'NOT_RUNNABLE');
});
