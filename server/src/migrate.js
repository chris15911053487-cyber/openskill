'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Apply pending SQL migrations from server/sql/*.sql in alphabetical order.
 * Tracks applied migrations in the `migrations` table so it is safe to call
 * repeatedly (idempotent).
 *
 * Migration filenames must follow the pattern NNN_description.sql (e.g.
 * 001_init.sql). The numeric prefix is used as the migration id.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} sqlDir - directory containing .sql files
 * @returns {{applied: string[], skipped: string[]}}
 */
function runMigrations(db, sqlDir) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const files = fs
    .readdirSync(sqlDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const appliedRows = db.prepare('SELECT name FROM migrations').all();
  const appliedSet = new Set(appliedRows.map((r) => r.name));

  const applied = [];
  const skipped = [];

  for (const file of files) {
    if (appliedSet.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = fs.readFileSync(path.join(sqlDir, file), 'utf8');
    const trx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO migrations (name) VALUES (?)').run(file);
    });
    trx();
    applied.push(file);
  }

  return { applied, skipped };
}

module.exports = { runMigrations };
