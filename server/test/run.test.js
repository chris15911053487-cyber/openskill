'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const AdmZip = require('adm-zip');

// ---------------------------------------------------------------------------
// Fixtures and helpers (mirrors skills.test.js patterns)
// ---------------------------------------------------------------------------

function freshEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openskill-run-'));
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

const BOUNDARY = '----openskillRunTest1234567890';

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
 * Build a runnable skill ZIP.
 * @param {object} opts
 * @param {string} opts.name
 * @param {string} opts.runJs       — body of scripts/run.js
 * @param {object|null} opts.manifest — optional manifest.json contents
 */
function buildRunnableSkill({ name, description = 'A test skill', runJs, manifest = null }) {
  const zip = new AdmZip();
  zip.addFile(
    'SKILL.md',
    Buffer.from(`---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n# ${name}\n`),
  );
  zip.addFile('scripts/run.js', Buffer.from(runJs, 'utf8'));
  if (manifest) {
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest), 'utf8'));
  }
  return zip.toBuffer();
}

/** Build a non-runnable skill ZIP (no scripts/run.js). */
function buildPlainSkill({ name }) {
  const zip = new AdmZip();
  zip.addFile(
    'SKILL.md',
    Buffer.from(`---\nname: ${JSON.stringify(name)}\ndescription: "Plain skill"\n---\n# ${name}\n`),
  );
  return zip.toBuffer();
}

/**
 * Upload a skill as the seeded admin so it goes straight to status='published'.
 * Returns the resulting slug.
 */
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
// Pure runner unit tests (no HTTP layer)
// ---------------------------------------------------------------------------

test('runner: happy path produces a single text file', async () => {
  // Bust caches to load the runner against current server/src copy
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/server/src/')) delete require.cache[key];
  }
  const { runSkill } = require('../src/skill-runner');

  const zipBuffer = buildRunnableSkill({
    name: 'echo',
    runJs: `
      const fs = require('fs');
      const path = require('path');
      const input = JSON.parse(fs.readFileSync(process.env.OPENSKILL_INPUT_FILE, 'utf8'));
      fs.writeFileSync(
        path.join(process.env.OPENSKILL_OUTPUT_DIR, 'out.txt'),
        'echo: ' + (input.msg || ''),
      );
    `,
  });

  const r = await runSkill({ zipBuffer, input: { msg: 'hi' } });
  assert.strictEqual(r.filename, 'out.txt');
  assert.strictEqual(r.contentType, 'text/plain; charset=utf-8');
  assert.strictEqual(r.data.toString('utf8'), 'echo: hi');
  assert.ok(r.durationMs >= 0);
});

test('runner: multiple files are bundled into a ZIP', async () => {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/server/src/')) delete require.cache[key];
  }
  const { runSkill } = require('../src/skill-runner');

  const zipBuffer = buildRunnableSkill({
    name: 'multi',
    runJs: `
      const fs = require('fs');
      const path = require('path');
      const dir = process.env.OPENSKILL_OUTPUT_DIR;
      fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
      fs.writeFileSync(path.join(dir, 'b.txt'), 'B');
    `,
    manifest: { name: 'multi', version: '1.0.0' },
  });

  const r = await runSkill({ zipBuffer, input: {}, manifest: { name: 'multi', version: '1.0.0' } });
  assert.strictEqual(r.contentType, 'application/zip');
  assert.match(r.filename, /^multi-\d+\.zip$/);

  // Sanity: parse the returned ZIP and confirm both files are inside
  const out = new AdmZip(r.data);
  const names = out.getEntries().map((e) => e.entryName).sort();
  assert.deepStrictEqual(names, ['a.txt', 'b.txt']);
});

test('runner: empty output → EMPTY_OUTPUT', async () => {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/server/src/')) delete require.cache[key];
  }
  const { runSkill, RunnerError } = require('../src/skill-runner');

  const zipBuffer = buildRunnableSkill({
    name: 'silent',
    runJs: `console.log('I do nothing on purpose')`,
  });

  await assert.rejects(
    runSkill({ zipBuffer, input: {} }),
    (err) => err instanceof RunnerError && err.code === 'EMPTY_OUTPUT',
  );
});

test('runner: non-zero exit → SCRIPT_FAILED includes stderr', async () => {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/server/src/')) delete require.cache[key];
  }
  const { runSkill, RunnerError } = require('../src/skill-runner');

  const zipBuffer = buildRunnableSkill({
    name: 'broken',
    runJs: `process.stderr.write('boom!'); process.exit(7);`,
  });

  await assert.rejects(
    runSkill({ zipBuffer, input: {} }),
    (err) => {
      if (!(err instanceof RunnerError) || err.code !== 'SCRIPT_FAILED') return false;
      assert.strictEqual(err.detail.exitCode, 7);
      assert.match(err.detail.stderr, /boom!/);
      return true;
    },
  );
});

test('runner: exceeding timeout → TIMEOUT', async () => {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/server/src/')) delete require.cache[key];
  }
  const { runSkill, RunnerError } = require('../src/skill-runner');

  const zipBuffer = buildRunnableSkill({
    name: 'slow',
    runJs: `setTimeout(()=>{}, 60_000);`, // sleep forever
  });

  await assert.rejects(
    runSkill({
      zipBuffer,
      input: {},
      // Note runner clamps to >= 1000ms; this is the lowest value possible
      limits: { timeoutMs: 1000 },
    }),
    (err) => err instanceof RunnerError && err.code === 'TIMEOUT',
  );
});

test('runner: missing entry → ENTRY_NOT_FOUND', async () => {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/server/src/')) delete require.cache[key];
  }
  const { runSkill, RunnerError } = require('../src/skill-runner');

  // Plain skill has no scripts/run.js; runner should refuse cleanly.
  const zipBuffer = buildPlainSkill({ name: 'plain' });

  await assert.rejects(
    runSkill({ zipBuffer, input: {} }),
    (err) => err instanceof RunnerError && err.code === 'ENTRY_NOT_FOUND',
  );
});

test('runner: input over cap → INPUT_TOO_LARGE', async () => {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/server/src/')) delete require.cache[key];
  }
  const { runSkill, RunnerError } = require('../src/skill-runner');

  const zipBuffer = buildRunnableSkill({
    name: 'echo',
    runJs: `require('fs').writeFileSync(require('path').join(process.env.OPENSKILL_OUTPUT_DIR,'x.txt'),'ok')`,
  });

  await assert.rejects(
    runSkill({
      zipBuffer,
      input: { huge: 'x'.repeat(200) },
      limits: { maxInputBytes: 50 }, // tiny cap
    }),
    (err) => err instanceof RunnerError && err.code === 'INPUT_TOO_LARGE',
  );
});

// ---------------------------------------------------------------------------
// HTTP route tests
// ---------------------------------------------------------------------------

test('POST /api/skills/:slug/run — happy path returns the produced file', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const adminToken = await loginAs(fastify, 'rootadmin', 'rootpass');

  const zipBuffer = buildRunnableSkill({
    name: 'echo-skill',
    runJs: `
      const fs = require('fs');
      const path = require('path');
      const input = JSON.parse(fs.readFileSync(process.env.OPENSKILL_INPUT_FILE, 'utf8'));
      fs.writeFileSync(
        path.join(process.env.OPENSKILL_OUTPUT_DIR, 'greeting.txt'),
        'Hello, ' + (input.who || 'world') + '!',
      );
    `,
  });
  const slug = await uploadAsAdmin(fastify, adminToken, 'echo-skill', zipBuffer);

  const res = await fastify.inject({
    method: 'POST',
    url: `/api/skills/${slug}/run`,
    headers: {
      authorization: `Bearer ${adminToken}`,
      'content-type': 'application/json',
    },
    payload: JSON.stringify({ input: { who: 'Alice' } }),
  });

  assert.strictEqual(res.statusCode, 200, `body: ${res.body}`);
  assert.strictEqual(res.headers['content-type'], 'text/plain; charset=utf-8');
  assert.match(res.headers['content-disposition'], /attachment; filename="greeting\.txt"/);
  assert.strictEqual(res.rawPayload.toString('utf8'), 'Hello, Alice!');
  assert.ok(Number(res.headers['x-openskill-run-duration-ms']) >= 0);
});

test('POST /api/skills/:slug/run — produces a real .xlsx via exceljs from server node_modules', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const adminToken = await loginAs(fastify, 'rootadmin', 'rootpass');

  const zipBuffer = buildRunnableSkill({
    name: 'xlsx-skill',
    runJs: `
      const ExcelJS = require('exceljs');
      const path = require('path');
      const fs = require('fs');
      const input = JSON.parse(fs.readFileSync(process.env.OPENSKILL_INPUT_FILE, 'utf8'));
      (async () => {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet(input.sheet || 'Sheet1');
        for (const row of input.rows || [['hello']]) ws.addRow(row);
        await wb.xlsx.writeFile(path.join(process.env.OPENSKILL_OUTPUT_DIR, 'data.xlsx'));
      })().catch((e) => { console.error(e); process.exit(1); });
    `,
  });
  const slug = await uploadAsAdmin(fastify, adminToken, 'xlsx-skill', zipBuffer);

  const res = await fastify.inject({
    method: 'POST',
    url: `/api/skills/${slug}/run`,
    headers: {
      authorization: `Bearer ${adminToken}`,
      'content-type': 'application/json',
    },
    payload: JSON.stringify({
      input: { sheet: 'Demo', rows: [['name', 'count'], ['apples', 3], ['oranges', 5]] },
    }),
  });

  assert.strictEqual(res.statusCode, 200, `body: ${res.body}`);
  assert.strictEqual(
    res.headers['content-type'],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  assert.match(res.headers['content-disposition'], /filename="data\.xlsx"/);

  // PK magic bytes confirm a real Office Open XML file
  const buf = res.rawPayload;
  assert.strictEqual(buf.subarray(0, 2).toString('hex'), '504b');
  assert.ok(buf.length > 1000);
});

test('POST /api/skills/:slug/run — non-runnable skill returns 422 NOT_RUNNABLE', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const adminToken = await loginAs(fastify, 'rootadmin', 'rootpass');

  const slug = await uploadAsAdmin(
    fastify,
    adminToken,
    'plain-skill',
    buildPlainSkill({ name: 'plain-skill' }),
  );

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
  assert.strictEqual(res.json().code, 'NOT_RUNNABLE');
});

test('POST /api/skills/:slug/run — script error returns 422 SCRIPT_FAILED with stderr', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const adminToken = await loginAs(fastify, 'rootadmin', 'rootpass');

  const zipBuffer = buildRunnableSkill({
    name: 'broken-skill',
    runJs: `process.stderr.write('explicit failure'); process.exit(2);`,
  });
  const slug = await uploadAsAdmin(fastify, adminToken, 'broken-skill', zipBuffer);

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
  assert.match(body.detail.stderr, /explicit failure/);
  assert.strictEqual(body.detail.exitCode, 2);
});

test('POST /api/skills/:slug/run — requires auth', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);

  const res = await fastify.inject({
    method: 'POST',
    url: `/api/skills/anything/run`,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ input: {} }),
  });

  assert.strictEqual(res.statusCode, 401);
});

test('POST /api/skills/:slug/run — unknown slug returns 404', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const adminToken = await loginAs(fastify, 'rootadmin', 'rootpass');

  const res = await fastify.inject({
    method: 'POST',
    url: `/api/skills/does-not-exist/run`,
    headers: {
      authorization: `Bearer ${adminToken}`,
      'content-type': 'application/json',
    },
    payload: JSON.stringify({ input: {} }),
  });

  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(res.json().code, 'SKILL_NOT_FOUND');
});

test('POST /api/skills/:slug/run — manifest.run.entry override is respected', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const adminToken = await loginAs(fastify, 'rootadmin', 'rootpass');

  // Build a skill where the entry lives at scripts/main.js, not the default
  const zip = new AdmZip();
  zip.addFile(
    'SKILL.md',
    Buffer.from(`---\nname: custom-entry\ndescription: "uses scripts/main.js"\n---\n# x\n`),
  );
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    name: 'custom-entry',
    version: '1.0.0',
    run: { entry: 'scripts/main.js', timeout_ms: 10_000 },
  })));
  zip.addFile('scripts/main.js', Buffer.from(`
    const fs = require('fs');
    const path = require('path');
    fs.writeFileSync(path.join(process.env.OPENSKILL_OUTPUT_DIR, 'r.txt'), 'custom-ok');
  `));

  const slug = await uploadAsAdmin(fastify, adminToken, 'custom-entry', zip.toBuffer());

  const res = await fastify.inject({
    method: 'POST',
    url: `/api/skills/${slug}/run`,
    headers: {
      authorization: `Bearer ${adminToken}`,
      'content-type': 'application/json',
    },
    payload: JSON.stringify({ input: {} }),
  });

  assert.strictEqual(res.statusCode, 200, res.body);
  assert.strictEqual(res.rawPayload.toString('utf8'), 'custom-ok');
});
