'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const AdmZip = require('adm-zip');

function freshEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openskill-skills-'));
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
    url: '/auth/login',
    payload: { username, password },
  });
  assert.strictEqual(r.statusCode, 200);
  return r.json().token;
}

async function registerUser(fastify, username) {
  const r = await fastify.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { username, email: `${username}@test.com`, password: 'pa$$w0rd1' },
  });
  assert.strictEqual(r.statusCode, 201);
  return r.json().token;
}

// ---------- Multipart body helpers ----------

const BOUNDARY = '----openskillTest1234567890';

function multipartHeaders() {
  return { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };
}

/**
 * Build a multipart/form-data body. Supports text fields and a single file.
 * @param {Array<{name: string, value: string} | {name: string, filename: string, contentType?: string, value: Buffer}>} parts
 */
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

// ---------- Skill fixture builders ----------

function buildSkillZip({
  withSkillMd = true,
  frontmatter = { name: 'pdf-helper', description: 'Helps process PDF files.' },
  body = '# PDF Helper\n\nUse this skill to extract text from PDFs.\n',
  withWrapper = false,
  withManifest = null,
  extraFiles = {},
  rawSkillMd = null,
} = {}) {
  const zip = new AdmZip();
  const prefix = withWrapper ? 'pdf-helper/' : '';

  if (withSkillMd) {
    const fmText = frontmatter
      ? `---\n${Object.entries(frontmatter)
          .map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`)
          .join('\n')}\n---\n`
      : '';
    const content = rawSkillMd ?? fmText + body;
    zip.addFile(`${prefix}SKILL.md`, Buffer.from(content, 'utf8'));
  }

  if (withManifest) {
    zip.addFile(`${prefix}manifest.json`, Buffer.from(JSON.stringify(withManifest), 'utf8'));
  }

  for (const [p, content] of Object.entries(extraFiles)) {
    zip.addFile(`${prefix}${p}`, Buffer.from(content, 'utf8'));
  }

  return zip.toBuffer();
}

// ---------- Tests ----------

test('upload: happy path as admin → status=published', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const adminTok = await loginAs(fastify, 'rootadmin', 'rootpass');

  const zip = buildSkillZip({
    frontmatter: { name: 'pdf-helper', description: 'Process PDF files' },
    body: '# PDF Helper\n\nDetailed instructions...\n',
    extraFiles: {
      'scripts/extract.py': '#!/usr/bin/env python3\nprint("extract")\n',
      'references/PDF-spec.md': '# PDF Spec ref\n',
    },
  });

  const res = await fastify.inject({
    method: 'POST',
    url: '/skills',
    headers: { ...multipartHeaders(), authorization: `Bearer ${adminTok}` },
    payload: multipartBody([
      { name: 'file', filename: 'pdf-helper.zip', contentType: 'application/zip', value: zip },
    ]),
  });

  assert.strictEqual(res.statusCode, 201, `got ${res.statusCode} body=${res.body}`);
  const body = res.json();
  assert.strictEqual(body.skill.slug, 'pdf-helper');
  assert.strictEqual(body.skill.status, 'published');
  assert.ok(body.skill.published_at);
  assert.strictEqual(body.skill.file_size, zip.length);
  assert.match(body.skill.sha256, /^[0-9a-f]{64}$/);

  // File actually exists on disk
  const filePath = path.join(tmp, 'storage/skills/pdf-helper.zip');
  assert.ok(fs.existsSync(filePath));
  assert.strictEqual(fs.statSync(filePath).size, zip.length);

  // File tree was cached
  const tree = JSON.parse(
    fastify.db.prepare('SELECT file_tree_json FROM skills WHERE slug = ?').get('pdf-helper')
      .file_tree_json,
  );
  assert.ok(tree.some((n) => n.path === 'SKILL.md'));
  assert.ok(tree.some((n) => n.path === 'scripts/extract.py'));
});

test('upload: as regular user → status=pending', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const userTok = await registerUser(fastify, 'alice');

  const zip = buildSkillZip();
  const res = await fastify.inject({
    method: 'POST',
    url: '/skills',
    headers: { ...multipartHeaders(), authorization: `Bearer ${userTok}` },
    payload: multipartBody([
      { name: 'file', filename: 's.zip', contentType: 'application/zip', value: zip },
    ]),
  });
  assert.strictEqual(res.statusCode, 201, res.body);
  assert.strictEqual(res.json().skill.status, 'pending');
  assert.strictEqual(res.json().skill.published_at, null);
});

test('upload: requires auth', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const zip = buildSkillZip();
  const res = await fastify.inject({
    method: 'POST',
    url: '/skills',
    headers: multipartHeaders(),
    payload: multipartBody([
      { name: 'file', filename: 's.zip', contentType: 'application/zip', value: zip },
    ]),
  });
  assert.strictEqual(res.statusCode, 401);
});

test('upload: missing SKILL.md → MISSING_SKILL_MD', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const tok = await loginAs(fastify, 'rootadmin', 'rootpass');
  const zip = buildSkillZip({
    withSkillMd: false,
    extraFiles: { 'README.md': '# Wrong file\n' },
  });
  const res = await fastify.inject({
    method: 'POST',
    url: '/skills',
    headers: { ...multipartHeaders(), authorization: `Bearer ${tok}` },
    payload: multipartBody([
      { name: 'file', filename: 'bad.zip', contentType: 'application/zip', value: zip },
    ]),
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.json().code, 'MISSING_SKILL_MD');
});

test('upload: missing name in frontmatter → MISSING_NAME', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const tok = await loginAs(fastify, 'rootadmin', 'rootpass');
  const zip = buildSkillZip({
    rawSkillMd: '---\ndescription: "no name here"\n---\nbody',
  });
  const res = await fastify.inject({
    method: 'POST',
    url: '/skills',
    headers: { ...multipartHeaders(), authorization: `Bearer ${tok}` },
    payload: multipartBody([
      { name: 'file', filename: 'bad.zip', contentType: 'application/zip', value: zip },
    ]),
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.json().code, 'MISSING_NAME');
});

test('upload: missing description → MISSING_DESCRIPTION', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const tok = await loginAs(fastify, 'rootadmin', 'rootpass');
  const zip = buildSkillZip({
    rawSkillMd: '---\nname: foo\n---\nbody',
  });
  const res = await fastify.inject({
    method: 'POST',
    url: '/skills',
    headers: { ...multipartHeaders(), authorization: `Bearer ${tok}` },
    payload: multipartBody([
      { name: 'file', filename: 'bad.zip', contentType: 'application/zip', value: zip },
    ]),
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.json().code, 'MISSING_DESCRIPTION');
});

test('upload: corrupt ZIP → ZIP_CORRUPT', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const tok = await loginAs(fastify, 'rootadmin', 'rootpass');
  const res = await fastify.inject({
    method: 'POST',
    url: '/skills',
    headers: { ...multipartHeaders(), authorization: `Bearer ${tok}` },
    payload: multipartBody([
      {
        name: 'file',
        filename: 'bad.zip',
        contentType: 'application/zip',
        value: Buffer.from('this is not a zip'),
      },
    ]),
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.json().code, 'ZIP_CORRUPT');
});

test('upload: invalid frontmatter YAML → INVALID_FRONTMATTER', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const tok = await loginAs(fastify, 'rootadmin', 'rootpass');
  const zip = buildSkillZip({
    rawSkillMd: '---\nname: ok\ndescription: ":\n---\nbody',
  });
  const res = await fastify.inject({
    method: 'POST',
    url: '/skills',
    headers: { ...multipartHeaders(), authorization: `Bearer ${tok}` },
    payload: multipartBody([
      { name: 'file', filename: 's.zip', contentType: 'application/zip', value: zip },
    ]),
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.json().code, 'INVALID_FRONTMATTER');
});

test('upload: wrapper directory is unwrapped transparently', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const tok = await loginAs(fastify, 'rootadmin', 'rootpass');
  const zip = buildSkillZip({ withWrapper: true });
  const res = await fastify.inject({
    method: 'POST',
    url: '/skills',
    headers: { ...multipartHeaders(), authorization: `Bearer ${tok}` },
    payload: multipartBody([
      { name: 'file', filename: 's.zip', contentType: 'application/zip', value: zip },
    ]),
  });
  assert.strictEqual(res.statusCode, 201, res.body);
  const tree = JSON.parse(
    fastify.db.prepare('SELECT file_tree_json FROM skills WHERE slug = ?').get('pdf-helper')
      .file_tree_json,
  );
  // Wrapper prefix stripped
  assert.ok(tree.some((n) => n.path === 'SKILL.md'));
  assert.ok(!tree.some((n) => n.path.startsWith('pdf-helper/')));
});

test('upload: duplicate slug → SKILL_EXISTS', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const tok = await loginAs(fastify, 'rootadmin', 'rootpass');
  const zip = buildSkillZip();
  const r1 = await fastify.inject({
    method: 'POST',
    url: '/skills',
    headers: { ...multipartHeaders(), authorization: `Bearer ${tok}` },
    payload: multipartBody([
      { name: 'file', filename: 's.zip', contentType: 'application/zip', value: zip },
    ]),
  });
  assert.strictEqual(r1.statusCode, 201);

  const r2 = await fastify.inject({
    method: 'POST',
    url: '/skills',
    headers: { ...multipartHeaders(), authorization: `Bearer ${tok}` },
    payload: multipartBody([
      { name: 'file', filename: 's.zip', contentType: 'application/zip', value: zip },
    ]),
  });
  assert.strictEqual(r2.statusCode, 409);
  assert.strictEqual(r2.json().code, 'SKILL_EXISTS');
});

test('upload: with category and tags', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const tok = await loginAs(fastify, 'rootadmin', 'rootpass');

  // Create category and tags
  await fastify.inject({
    method: 'POST',
    url: '/admin/categories',
    headers: { authorization: `Bearer ${tok}` },
    payload: { name: 'Productivity' },
  });
  await fastify.inject({
    method: 'POST',
    url: '/admin/tags',
    headers: { authorization: `Bearer ${tok}` },
    payload: { name: 'writing' },
  });
  await fastify.inject({
    method: 'POST',
    url: '/admin/tags',
    headers: { authorization: `Bearer ${tok}` },
    payload: { name: 'pdf' },
  });

  const zip = buildSkillZip();
  const res = await fastify.inject({
    method: 'POST',
    url: '/skills',
    headers: { ...multipartHeaders(), authorization: `Bearer ${tok}` },
    payload: multipartBody([
      { name: 'categorySlug', value: 'productivity' },
      { name: 'tagSlugs', value: JSON.stringify(['writing', 'pdf']) },
      { name: 'file', filename: 's.zip', contentType: 'application/zip', value: zip },
    ]),
  });
  assert.strictEqual(res.statusCode, 201, res.body);

  const skill = fastify.db
    .prepare('SELECT id, category_id FROM skills WHERE slug = ?')
    .get('pdf-helper');
  assert.ok(skill.category_id);

  const tagRows = fastify.db
    .prepare(
      'SELECT t.slug FROM skill_tags st JOIN tags t ON t.id=st.tag_id WHERE st.skill_id=? ORDER BY t.slug',
    )
    .all(skill.id);
  assert.deepStrictEqual(
    tagRows.map((r) => r.slug),
    ['pdf', 'writing'],
  );
});

test('upload: unknown category → CATEGORY_NOT_FOUND', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const tok = await loginAs(fastify, 'rootadmin', 'rootpass');
  const zip = buildSkillZip();
  const res = await fastify.inject({
    method: 'POST',
    url: '/skills',
    headers: { ...multipartHeaders(), authorization: `Bearer ${tok}` },
    payload: multipartBody([
      { name: 'categorySlug', value: 'nonexistent' },
      { name: 'file', filename: 's.zip', contentType: 'application/zip', value: zip },
    ]),
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.json().code, 'CATEGORY_NOT_FOUND');
});

test('upload: with manifest.json captures version', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const tok = await loginAs(fastify, 'rootadmin', 'rootpass');
  const zip = buildSkillZip({
    withManifest: { name: '@me/pdf-helper', version: '1.2.3', schemaVersion: '1.0' },
  });
  const res = await fastify.inject({
    method: 'POST',
    url: '/skills',
    headers: { ...multipartHeaders(), authorization: `Bearer ${tok}` },
    payload: multipartBody([
      { name: 'file', filename: 's.zip', contentType: 'application/zip', value: zip },
    ]),
  });
  assert.strictEqual(res.statusCode, 201, res.body);
  const row = fastify.db
    .prepare('SELECT version, manifest_json FROM skills WHERE slug = ?')
    .get('pdf-helper');
  assert.strictEqual(row.version, '1.2.3');
  const parsed = JSON.parse(row.manifest_json);
  assert.strictEqual(parsed.manifest.version, '1.2.3');
});
