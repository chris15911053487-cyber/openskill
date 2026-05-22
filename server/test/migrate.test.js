'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Each test gets its own scratch dir to keep them isolated.
function freshEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openskill-mig-'));
  process.env.DB_PATH = path.join(tmp, 'test.db');
  process.env.STORAGE_DIR = path.join(tmp, 'storage');
  process.env.JWT_SECRET = 'test-secret';
  process.env.LOG_LEVEL = 'silent';
  process.env.ADMIN_INITIAL_USERNAME = 'rootadmin';
  process.env.ADMIN_INITIAL_EMAIL = 'root@example.com';
  process.env.ADMIN_INITIAL_PASSWORD = 'testpass';
  return tmp;
}

test('migrations apply once and create all expected tables', async (t) => {
  const tmp = freshEnv();
  // bust the require cache so each test gets a clean module instance
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/server/src/')) delete require.cache[key];
  }
  const { buildServer } = require('../src/index');

  const fastify = await buildServer();
  t.after(async () => {
    await fastify.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const tables = fastify.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);

  assert.ok(tables.includes('users'));
  assert.ok(tables.includes('skills'));
  assert.ok(tables.includes('subscriptions'));
  assert.ok(tables.includes('skill_tags'));
  assert.ok(tables.includes('categories'));
  assert.ok(tables.includes('tags'));
  assert.ok(tables.includes('download_logs'));
  assert.ok(tables.includes('audit_logs'));
  assert.ok(tables.includes('migrations'));

  const migRows = fastify.db.prepare('SELECT name FROM migrations ORDER BY name').all();
  // Expect every NNN_*.sql file under sql/ to have been applied
  const sqlFiles = fs
    .readdirSync(path.resolve(__dirname, '..', 'sql'))
    .filter((n) => /^\d+_.*\.sql$/.test(n))
    .sort();
  assert.strictEqual(migRows.length, sqlFiles.length);
  assert.deepStrictEqual(
    migRows.map((r) => r.name),
    sqlFiles,
  );
});

test('admin seed is idempotent and respects env vars', async (t) => {
  const tmp = freshEnv();
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/server/src/')) delete require.cache[key];
  }
  const { buildServer } = require('../src/index');

  const fastify = await buildServer();
  const admins = fastify.db
    .prepare("SELECT id, username, email, role FROM users WHERE role='admin'")
    .all();
  assert.strictEqual(admins.length, 1);
  assert.strictEqual(admins[0].username, 'rootadmin');
  assert.strictEqual(admins[0].email, 'root@example.com');

  await fastify.close();

  // Restart on the SAME db file: should NOT add another admin
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/server/src/')) delete require.cache[key];
  }
  const { buildServer: buildAgain } = require('../src/index');
  const fastify2 = await buildAgain();
  t.after(async () => {
    await fastify2.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const admins2 = fastify2.db
    .prepare("SELECT id, username FROM users WHERE role='admin'")
    .all();
  assert.strictEqual(admins2.length, 1);
  assert.strictEqual(admins2[0].id, admins[0].id);

  // And no migration was re-applied
  const migRows = fastify2.db.prepare('SELECT name FROM migrations').all();
  const sqlFiles = fs
    .readdirSync(path.resolve(__dirname, '..', 'sql'))
    .filter((n) => /^\d+_.*\.sql$/.test(n));
  assert.strictEqual(migRows.length, sqlFiles.length);
});

test('admin seed throws when no admin exists and no password set', async (t) => {
  const tmp = freshEnv();
  delete process.env.ADMIN_INITIAL_PASSWORD;
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/server/src/')) delete require.cache[key];
  }
  const { buildServer } = require('../src/index');

  await assert.rejects(buildServer(), /ADMIN_INITIAL_PASSWORD/);

  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
