'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Setup isolated test data dir
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openskill-test-'));
process.env.DB_PATH = path.join(tmpRoot, 'test.db');
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage');
process.env.JWT_SECRET = 'test-secret';
process.env.LOG_LEVEL = 'silent';
process.env.ADMIN_INITIAL_PASSWORD = 'testpass';

const { buildServer } = require('../src/index');

test('GET /health returns ok with db status', async (t) => {
  const fastify = await buildServer();
  t.after(async () => {
    await fastify.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const res = await fastify.inject({ method: 'GET', url: '/health' });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json();
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.db, 'ok');
  assert.ok(typeof body.ts === 'string');
});
