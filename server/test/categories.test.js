'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function freshEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openskill-cat-'));
  process.env.DB_PATH = path.join(tmp, 'test.db');
  process.env.STORAGE_DIR = path.join(tmp, 'storage');
  process.env.JWT_SECRET = 'test-jwt-secret';
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

async function loginAs(fastify, username, password) {
  const r = await fastify.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  assert.strictEqual(r.statusCode, 200, `login failed: ${r.body}`);
  return r.json().token;
}

async function registerUser(fastify, username, password = 'pa$$w0rd1') {
  const r = await fastify.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, email: `${username}@test.com`, password },
  });
  assert.strictEqual(r.statusCode, 201);
  return r.json().token;
}

test('slug helper edge cases', () => {
  const { slugify } = require('../src/utils/slug');
  assert.strictEqual(slugify('Productivity & Tools'), 'productivity-tools');
  assert.strictEqual(slugify('  AI / ML  '), 'ai-ml');
  assert.strictEqual(slugify('--foo--'), 'foo');
  assert.strictEqual(slugify('中文'), null);
  assert.strictEqual(slugify(''), null);
});

test('categories: list is public, create/patch/delete admin only', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);

  // public list works without auth
  const list1 = await fastify.inject({ method: 'GET', url: '/api/categories' });
  assert.strictEqual(list1.statusCode, 200);
  assert.deepStrictEqual(list1.json().categories, []);

  // user cannot create
  const userTok = await registerUser(fastify, 'alice');
  const userCreate = await fastify.inject({
    method: 'POST',
    url: '/api/admin/categories',
    headers: { authorization: `Bearer ${userTok}` },
    payload: { name: 'Productivity' },
  });
  assert.strictEqual(userCreate.statusCode, 403);
  assert.strictEqual(userCreate.json().code, 'FORBIDDEN');

  // admin creates
  const adminTok = await loginAs(fastify, 'rootadmin', 'rootpass');
  const create = await fastify.inject({
    method: 'POST',
    url: '/api/admin/categories',
    headers: { authorization: `Bearer ${adminTok}` },
    payload: { name: 'Productivity & Tools' },
  });
  assert.strictEqual(create.statusCode, 201);
  const cat = create.json().category;
  assert.strictEqual(cat.slug, 'productivity-tools');
  assert.strictEqual(cat.name, 'Productivity & Tools');

  // duplicate
  const dup = await fastify.inject({
    method: 'POST',
    url: '/api/admin/categories',
    headers: { authorization: `Bearer ${adminTok}` },
    payload: { name: 'Productivity & Tools' },
  });
  assert.strictEqual(dup.statusCode, 409);
  assert.strictEqual(dup.json().code, 'CATEGORY_EXISTS');

  // patch
  const patch = await fastify.inject({
    method: 'PATCH',
    url: '/api/admin/categories/productivity-tools',
    headers: { authorization: `Bearer ${adminTok}` },
    payload: { description: 'Tools that boost productivity' },
  });
  assert.strictEqual(patch.statusCode, 200);
  assert.strictEqual(patch.json().category.description, 'Tools that boost productivity');

  // delete
  const del = await fastify.inject({
    method: 'DELETE',
    url: '/api/admin/categories/productivity-tools',
    headers: { authorization: `Bearer ${adminTok}` },
  });
  assert.strictEqual(del.statusCode, 204);

  const list2 = await fastify.inject({ method: 'GET', url: '/api/categories' });
  assert.deepStrictEqual(list2.json().categories, []);
});

test('tags: full CRUD with admin permissions', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);

  const adminTok = await loginAs(fastify, 'rootadmin', 'rootpass');

  const create = await fastify.inject({
    method: 'POST',
    url: '/api/admin/tags',
    headers: { authorization: `Bearer ${adminTok}` },
    payload: { name: 'Writing' },
  });
  assert.strictEqual(create.statusCode, 201);
  assert.strictEqual(create.json().tag.slug, 'writing');

  // explicit slug overrides derived
  const create2 = await fastify.inject({
    method: 'POST',
    url: '/api/admin/tags',
    headers: { authorization: `Bearer ${adminTok}` },
    payload: { name: 'Code Review', slug: 'code-rev' },
  });
  assert.strictEqual(create2.statusCode, 201);
  assert.strictEqual(create2.json().tag.slug, 'code-rev');

  const list = await fastify.inject({ method: 'GET', url: '/api/tags' });
  assert.strictEqual(list.statusCode, 200);
  const tags = list.json().tags;
  assert.strictEqual(tags.length, 2);
  // every tag has skill_count = 0
  assert.ok(tags.every((t) => t.skill_count === 0));

  const userTok = await registerUser(fastify, 'bob');
  const userDel = await fastify.inject({
    method: 'DELETE',
    url: '/api/admin/tags/writing',
    headers: { authorization: `Bearer ${userTok}` },
  });
  assert.strictEqual(userDel.statusCode, 403);

  const adminDel = await fastify.inject({
    method: 'DELETE',
    url: '/api/admin/tags/writing',
    headers: { authorization: `Bearer ${adminTok}` },
  });
  assert.strictEqual(adminDel.statusCode, 204);
});

test('category: invalid slug from name throws INVALID_SLUG', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);
  const adminTok = await loginAs(fastify, 'rootadmin', 'rootpass');

  const r = await fastify.inject({
    method: 'POST',
    url: '/api/admin/categories',
    headers: { authorization: `Bearer ${adminTok}` },
    payload: { name: '中文分类' },
  });
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(r.json().code, 'INVALID_SLUG');
});
