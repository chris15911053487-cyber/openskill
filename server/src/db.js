'use strict';

const path = require('path');
const Database = require('better-sqlite3');

let _db = null;

/**
 * Open the SQLite database (singleton). Sets pragmas tuned for a single-process
 * Fastify server with WAL mode + foreign keys.
 *
 * @param {string} dbPath - absolute path to the .db file
 * @returns {Database.Database}
 */
function openDb(dbPath) {
  if (_db) return _db;

  const absPath = path.resolve(dbPath);
  const db = new Database(absPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  _db = db;
  return _db;
}

/**
 * @returns {Database.Database} the open db (must call openDb first)
 */
function getDb() {
  if (!_db) throw new Error('Database not initialized. Call openDb(path) first.');
  return _db;
}

function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

module.exports = { openDb, getDb, closeDb };
