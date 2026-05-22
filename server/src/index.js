'use strict';

// Note: .env loading is intentionally deferred to start() so tests can fully
// control process.env without it being clobbered by reading .env at import.
const path = require('path');
const fs = require('fs');

const Fastify = require('fastify');
const { openDb } = require('./db');
const { runMigrations } = require('./migrate');
const { seedAdmin } = require('./auth');

async function buildServer() {
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
  });

  // Resolve & ensure data directories exist
  const dbPath = path.resolve(__dirname, '..', process.env.DB_PATH || '../data/openskill.db');
  const storageDir = path.resolve(__dirname, '..', process.env.STORAGE_DIR || '../data/storage');
  const skillsDir = path.join(storageDir, 'skills');

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });

  // Open DB and apply migrations
  const db = openDb(dbPath);
  const sqlDir = path.resolve(__dirname, '..', 'sql');
  if (fs.existsSync(sqlDir)) {
    const { applied, skipped } = runMigrations(db, sqlDir);
    fastify.log.info(
      { applied, skipped: skipped.length },
      `migrations: applied=${applied.length} skipped=${skipped.length}`,
    );
  }

  // Seed initial admin user if none exists (idempotent)
  try {
    const seedResult = await seedAdmin(db);
    if (seedResult.seeded) {
      fastify.log.info({ username: seedResult.username }, 'seeded initial admin user');
    }
  } catch (err) {
    fastify.log.error({ err: err.message }, 'admin seed failed');
    throw err;
  }

  // Decorate so routes can access them
  fastify.decorate('db', db);
  fastify.decorate('config', {
    dbPath,
    storageDir,
    skillsDir,
    jwtSecret: process.env.JWT_SECRET || 'dev-only-insecure-secret',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
    maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 20),
  });

  // CORS — allow frontend dev server on :5173 by default
  await fastify.register(require('@fastify/cors'), {
    origin: true,
    credentials: true,
  });

  // Multipart uploads (skills are uploaded as ZIPs)
  await fastify.register(require('@fastify/multipart'), {
    limits: {
      fileSize: Number(process.env.MAX_UPLOAD_MB || 20) * 1024 * 1024,
      files: 1,
    },
  });

  // JWT plugin
  await fastify.register(require('@fastify/jwt'), {
    secret: process.env.JWT_SECRET || 'dev-only-insecure-secret',
  });

  // authenticate decorator: verifies JWT, populates req.user
  fastify.decorate('authenticate', async function (req, reply) {
    try {
      await req.jwtVerify();
    } catch (err) {
      reply.code(401).send({
        error: 'Authentication required',
        code: 'UNAUTHORIZED',
        detail: err.message,
      });
    }
  });

  // requireAdmin decorator: chained after authenticate, ensures admin role
  fastify.decorate('requireAdmin', async function (req, reply) {
    try {
      await req.jwtVerify();
    } catch (err) {
      return reply.code(401).send({
        error: 'Authentication required',
        code: 'UNAUTHORIZED',
        detail: err.message,
      });
    }
    if (req.user?.role !== 'admin') {
      return reply.code(403).send({
        error: 'Admin role required',
        code: 'FORBIDDEN',
      });
    }
  });

  // Global error handler — convert HttpError + zod errors to {error, code, detail?}
  fastify.setErrorHandler((err, req, reply) => {
    if (err.statusCode && err.code && typeof err.code === 'string') {
      // Our HttpError or fastify-attached structured error
      return reply.code(err.statusCode).send({
        error: err.message,
        code: err.code,
        ...(err.detail !== undefined ? { detail: err.detail } : {}),
      });
    }
    if (err.validation) {
      // Fastify schema validation error
      return reply.code(400).send({
        error: 'Invalid input',
        code: 'INVALID_INPUT',
        detail: err.validation,
      });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(err.statusCode || 500).send({
      error: err.message || 'Internal Server Error',
      code: err.code || 'INTERNAL_ERROR',
    });
  });

  // Health check (also verifies DB readability)
  fastify.get('/health', async () => {
    const row = db.prepare('SELECT 1 AS ok').get();
    return { ok: true, db: row?.ok === 1 ? 'ok' : 'fail', ts: new Date().toISOString() };
  });

  // Routes — all under /api so the frontend can use /api/* in both dev and prod
  await fastify.register(async function apiRoutes(app) {
    await app.register(require('./routes/auth'));
    await app.register(require('./routes/categories'));
    await app.register(require('./routes/tags'));
    await app.register(require('./routes/skills'));
    await app.register(require('./routes/admin'));
    await app.register(require('./routes/chat').chatRoutes);
  }, { prefix: '/api' });

  // Serve the built frontend (production). In dev, vite handles its own server
  // and proxies /api to us, so the dist may not exist locally — that's fine.
  const frontendDist = path.resolve(__dirname, '..', '..', 'frontend', 'dist');
  if (fs.existsSync(path.join(frontendDist, 'index.html'))) {
    await fastify.register(require('@fastify/static'), {
      root: frontendDist,
      prefix: '/',
      decorateReply: true,
    });
    // SPA fallback: any non-/api path that didn't match a static asset returns
    // the SPA shell so client-side routing keeps working on direct URL hits.
    fastify.setNotFoundHandler((req, reply) => {
      const url = req.raw.url || '';
      if (url.startsWith('/api/') || req.method !== 'GET') {
        return reply
          .code(404)
          .send({ error: 'Not found', code: 'NOT_FOUND' });
      }
      return reply.sendFile('index.html');
    });
    fastify.log.info(`serving frontend from ${frontendDist}`);
  }

  // Graceful shutdown
  const shutdown = async () => {
    try {
      await fastify.close();
    } finally {
      db.close();
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return fastify;
}

async function start() {
  // Load env only when running standalone (not under tests).
  const localEnv = path.resolve(__dirname, '../.env');
  const rootEnv = path.resolve(__dirname, '../../.env');
  if (fs.existsSync(localEnv)) {
    require('dotenv').config({ path: localEnv });
  } else if (fs.existsSync(rootEnv)) {
    require('dotenv').config({ path: rootEnv });
  }

  const fastify = await buildServer();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  try {
    await fastify.listen({ port, host });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

if (require.main === module) {
  start();
}

module.exports = { buildServer };
