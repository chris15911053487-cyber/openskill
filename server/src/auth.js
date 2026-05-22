'use strict';

const bcrypt = require('bcrypt');

const BCRYPT_ROUNDS = 12;

/**
 * Hash a plaintext password with bcrypt.
 * @param {string} plain
 * @returns {Promise<string>}
 */
function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

/**
 * Verify a plaintext password against a bcrypt hash.
 * @param {string} plain
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

/**
 * Idempotently seed an initial admin user if no admin exists.
 *
 * Reads ADMIN_INITIAL_USERNAME / EMAIL / PASSWORD from env. If any admin user
 * already exists, this is a no-op. Designed to run on every startup.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Promise<{ seeded: boolean, username?: string }>}
 */
async function seedAdmin(db) {
  const existing = db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")
    .get();
  if (existing.n > 0) return { seeded: false };

  const username = process.env.ADMIN_INITIAL_USERNAME || 'admin';
  const email = process.env.ADMIN_INITIAL_EMAIL || 'admin@example.com';
  const password = process.env.ADMIN_INITIAL_PASSWORD;

  if (!password) {
    throw new Error(
      'No admin user exists and ADMIN_INITIAL_PASSWORD is not set. ' +
        'Set ADMIN_INITIAL_PASSWORD in your env to seed the initial admin.',
    );
  }

  const hash = await hashPassword(password);
  db.prepare(
    `INSERT INTO users (username, email, password_hash, role)
     VALUES (?, ?, ?, 'admin')`,
  ).run(username, email, hash);

  return { seeded: true, username };
}

module.exports = { hashPassword, verifyPassword, seedAdmin };
