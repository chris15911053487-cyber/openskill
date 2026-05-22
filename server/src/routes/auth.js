'use strict';

const { z } = require('zod');
const { hashPassword, verifyPassword } = require('../auth');
const { badRequest, conflict, unauthorized, notFound } = require('../errors');

const usernameSchema = z
  .string()
  .min(3, 'username must be at least 3 characters')
  .max(32, 'username must be at most 32 characters')
  .regex(/^[a-zA-Z0-9_-]+$/, 'username may only contain letters, numbers, _ and -');

const passwordSchema = z
  .string()
  .min(8, 'password must be at least 8 characters')
  .max(128, 'password must be at most 128 characters');

const registerSchema = z.object({
  username: usernameSchema,
  email: z.string().email('invalid email'),
  password: passwordSchema,
});

// Login accepts either a username or an email in the same `username` field
// to keep the UI simple. Validate as non-empty string.
const loginSchema = z.object({
  username: z.string().min(1, 'username is required'),
  password: z.string().min(1, 'password is required'),
});

/**
 * Parse a zod schema, throwing an HttpError(400, 'INVALID_INPUT') with the
 * collected issues as the detail field.
 */
function parseOrThrow(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }));
    throw badRequest('INVALID_INPUT', 'Invalid input', issues);
  }
  return result.data;
}

/**
 * Build the user payload returned to clients (never includes password_hash).
 */
function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    created_at: row.created_at,
  };
}

/**
 * Sign a JWT for the given user.
 */
function signToken(fastify, user) {
  return fastify.jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    { expiresIn: fastify.config.jwtExpiresIn },
  );
}

async function authRoutes(fastify) {
  const db = fastify.db;

  // POST /auth/register
  fastify.post('/auth/register', async (req, reply) => {
    const body = parseOrThrow(registerSchema, req.body);
    const username = body.username.toLowerCase();
    const email = body.email.toLowerCase();

    const existing = db
      .prepare('SELECT id FROM users WHERE username = ? OR email = ?')
      .get(username, email);
    if (existing) {
      throw conflict('USER_EXISTS', 'Username or email already registered');
    }

    const passwordHash = await hashPassword(body.password);

    const result = db
      .prepare(
        `INSERT INTO users (username, email, password_hash, role)
         VALUES (?, ?, ?, 'user')`,
      )
      .run(username, email, passwordHash);

    const user = db
      .prepare('SELECT id, username, email, role, created_at FROM users WHERE id = ?')
      .get(result.lastInsertRowid);

    const token = signToken(fastify, user);
    return reply.code(201).send({ token, user: publicUser(user) });
  });

  // POST /auth/login
  fastify.post('/auth/login', async (req) => {
    const body = parseOrThrow(loginSchema, req.body);
    const id = body.username.toLowerCase();

    const user = db
      .prepare(
        `SELECT id, username, email, password_hash, role, created_at
         FROM users WHERE username = ? OR email = ?`,
      )
      .get(id, id);

    if (!user) throw unauthorized('INVALID_CREDENTIALS', 'Invalid username or password');

    const ok = await verifyPassword(body.password, user.password_hash);
    if (!ok) throw unauthorized('INVALID_CREDENTIALS', 'Invalid username or password');

    const token = signToken(fastify, user);
    return { token, user: publicUser(user) };
  });

  // GET /auth/me
  fastify.get(
    '/auth/me',
    { onRequest: [fastify.authenticate] },
    async (req) => {
      const user = db
        .prepare('SELECT id, username, email, role, created_at FROM users WHERE id = ?')
        .get(req.user.id);
      if (!user) throw notFound('USER_NOT_FOUND', 'User no longer exists');
      return { user: publicUser(user) };
    },
  );
}

module.exports = authRoutes;
