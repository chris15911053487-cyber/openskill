'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function freshEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openskill-auth-'));
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

test('register: happy path returns token and user', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'alice', email: 'alice@test.com', password: 'pa$$w0rd1' },
  });

  assert.strictEqual(res.statusCode, 201);
  const body = res.json();
  assert.ok(body.token, 'token returned');
  assert.strictEqual(body.user.username, 'alice');
  assert.strictEqual(body.user.email, 'alice@test.com');
  assert.strictEqual(body.user.role, 'user');
  assert.strictEqual(body.user.password_hash, undefined, 'no password leak');
});

test('register: rejects invalid input with INVALID_INPUT', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);

  const cases = [
    { username: 'ab', email: 'a@b.com', password: 'pa$$w0rd1' }, // username too short
    { username: 'alice!', email: 'a@b.com', password: 'pa$$w0rd1' }, // bad chars
    { username: 'alice', email: 'not-an-email', password: 'pa$$w0rd1' },
    { username: 'alice', email: 'a@b.com', password: 'short' },
  ];
  for (const payload of cases) {
    const res = await fastify.inject({ method: 'POST', url: '/api/auth/register', payload });
    assert.strictEqual(res.statusCode, 400, `expected 400 for ${JSON.stringify(payload)}`);
    const body = res.json();
    assert.strictEqual(body.code, 'INVALID_INPUT');
    assert.ok(Array.isArray(body.detail));
  }
});

test('register: duplicate username/email returns USER_EXISTS', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);

  const ok = await fastify.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'alice', email: 'alice@test.com', password: 'pa$$w0rd1' },
  });
  assert.strictEqual(ok.statusCode, 201);

  const dup = await fastify.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'alice', email: 'other@test.com', password: 'pa$$w0rd2' },
  });
  assert.strictEqual(dup.statusCode, 409);
  assert.strictEqual(dup.json().code, 'USER_EXISTS');
});

test('login: works with username and email; wrong password returns 401', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);

  await fastify.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'bob', email: 'bob@test.com', password: 'pa$$w0rd1' },
  });

  // by username
  const r1 = await fastify.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'bob', password: 'pa$$w0rd1' },
  });
  assert.strictEqual(r1.statusCode, 200);
  assert.ok(r1.json().token);

  // by email
  const r2 = await fastify.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'bob@test.com', password: 'pa$$w0rd1' },
  });
  assert.strictEqual(r2.statusCode, 200);

  // wrong password
  const r3 = await fastify.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'bob', password: 'wrong-password' },
  });
  assert.strictEqual(r3.statusCode, 401);
  assert.strictEqual(r3.json().code, 'INVALID_CREDENTIALS');

  // unknown user
  const r4 = await fastify.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'nobody', password: 'whatever1' },
  });
  assert.strictEqual(r4.statusCode, 401);
});

test('GET /auth/me requires JWT and returns user', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);

  // no token
  const noTok = await fastify.inject({ method: 'GET', url: '/api/auth/me' });
  assert.strictEqual(noTok.statusCode, 401);
  assert.strictEqual(noTok.json().code, 'UNAUTHORIZED');

  // with token
  const reg = await fastify.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'carol', email: 'carol@test.com', password: 'pa$$w0rd1' },
  });
  const { token } = reg.json();

  const me = await fastify.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.strictEqual(me.statusCode, 200);
  const body = me.json();
  assert.strictEqual(body.user.username, 'carol');
  assert.strictEqual(body.user.role, 'user');
});

test('seeded admin can login and gets admin role in JWT', async (t) => {
  const tmp = freshEnv();
  const fastify = await bootServer(t, tmp);

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'rootadmin', password: 'rootpass' },
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json();
  assert.strictEqual(body.user.role, 'admin');

  const me = await fastify.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { authorization: `Bearer ${body.token}` },
  });
  assert.strictEqual(me.statusCode, 200);
  assert.strictEqual(me.json().user.role, 'admin');
});
