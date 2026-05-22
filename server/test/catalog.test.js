'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const AdmZip = require('adm-zip');

const BOUNDARY = '----openskillCatalogTest';
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
        Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}`),
      );
    }
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

function buildZip(name, description = 'desc') {
  const zip = new AdmZip();
  zip.addFile(
    'SKILL.md',
    Buffer.from(
      `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\nbody\n`,
      'utf8',
    ),
  );
  return zip.toBuffer();
}

function freshEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openskill-cat-list-'));
  process.env.DB_PATH = path.join(tmp, 'test.db');
  process.env.STORAGE_DIR = path.join(tmp, 'storage');
  process.env.JWT_SECRET = 'test';
  process.env.LOG_LEVEL = 'silent';
  process.env.ADMIN_INITIAL_USERNAME = 'rootadmin';
  process.env.ADMIN_INITIAL_EMAIL = 'root@example.com';
  process.env.ADMIN_INITIAL_PASSWORD = 'rootpass';
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

async function loginAdmin(fastify) {
  const r = await fastify.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'rootadmin', password: 'rootpass' },
  });
  return r.json().token;
}

async function uploadSkill(fastify, tok, name, opts = {}) {
  const zip = buildZip(name, opts.description || 'desc');
  return fastify.inject({
    method: 'POST',
    url: '/api/skills',
    headers: { ...multipartHeaders(), authorization: `Bearer ${tok}` },
    payload: multipartBody([
      ...(opts.categorySlug ? [{ name: 'categorySlug', value: opts.categorySlug }] : []),
      ...(opts.tagSlugs
        ? [{ name: 'tagSlugs', value: JSON.stringify(opts.tagSlugs) }]
        : []),
      { name: 'file', filename: `${name}.zip`, contentType: 'application/zip', value: zip },
    ]),
  });
}

test('GET /skills — public list, filters, sort, pagination', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const tok = await loginAdmin(fastify);

  // Seed: 3 published skills (admin uploads = published) + 1 pending (regular user)
  await uploadSkill(fastify, tok, 'alpha', { description: 'Sorts data' });
  await uploadSkill(fastify, tok, 'bravo', { description: 'Charts and plots' });
  await uploadSkill(fastify, tok, 'charlie', { description: 'CSV utilities' });

  // Pending skill from regular user should NOT appear in public list
  const userR = await fastify.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'joe', email: 'joe@x.com', password: 'pa$$w0rd1' },
  });
  await uploadSkill(fastify, userR.json().token, 'pending-one');

  const list = await fastify.inject({ method: 'GET', url: '/api/skills' });
  assert.strictEqual(list.statusCode, 200);
  const body = list.json();
  assert.strictEqual(body.total, 3);
  assert.strictEqual(body.items.length, 3);
  assert.ok(body.items.every((s) => s.status === 'published'));

  // Search
  const q = await fastify.inject({ method: 'GET', url: '/api/skills?q=csv' });
  assert.strictEqual(q.json().total, 1);
  assert.strictEqual(q.json().items[0].slug, 'charlie');

  // Pagination
  const p1 = await fastify.inject({ method: 'GET', url: '/api/skills?limit=2&page=1&sort=name' });
  assert.strictEqual(p1.json().items.length, 2);
  assert.strictEqual(p1.json().pages, 2);

  // Admin can list pending via status= param
  const adminPending = await fastify.inject({
    method: 'GET',
    url: '/api/skills?status=pending',
    headers: { authorization: `Bearer ${tok}` },
  });
  assert.strictEqual(adminPending.json().total, 1);
  assert.strictEqual(adminPending.json().items[0].slug, 'pending-one');
});

test('GET /skills/:slug — detail, hides pending from non-author', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const adminTok = await loginAdmin(fastify);
  const userR = await fastify.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'alice', email: 'alice@x.com', password: 'pa$$w0rd1' },
  });
  const userTok = userR.json().token;

  await uploadSkill(fastify, adminTok, 'public-one');
  await uploadSkill(fastify, userTok, 'private-one'); // pending

  // Public can fetch published
  const r1 = await fastify.inject({ method: 'GET', url: '/api/skills/public-one' });
  assert.strictEqual(r1.statusCode, 200);
  assert.strictEqual(r1.json().skill.status, 'published');

  // Anonymous cannot see pending
  const r2 = await fastify.inject({ method: 'GET', url: '/api/skills/private-one' });
  assert.strictEqual(r2.statusCode, 404);

  // Author can see own pending
  const r3 = await fastify.inject({
    method: 'GET',
    url: '/api/skills/private-one',
    headers: { authorization: `Bearer ${userTok}` },
  });
  assert.strictEqual(r3.statusCode, 200);
  assert.strictEqual(r3.json().skill.status, 'pending');

  // Admin can see any pending
  const r4 = await fastify.inject({
    method: 'GET',
    url: '/api/skills/private-one',
    headers: { authorization: `Bearer ${adminTok}` },
  });
  assert.strictEqual(r4.statusCode, 200);

  // Other user cannot
  const otherR = await fastify.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'bob', email: 'bob@x.com', password: 'pa$$w0rd1' },
  });
  const r5 = await fastify.inject({
    method: 'GET',
    url: '/api/skills/private-one',
    headers: { authorization: `Bearer ${otherR.json().token}` },
  });
  assert.strictEqual(r5.statusCode, 404);
});
