'use strict';

/**
 * Artifact storage: persists files produced by skill runs (driven by an LLM
 * tool call) under data/storage/artifacts/, and links them to chat messages
 * via the `artifacts` table.
 *
 * On-disk layout:
 *   data/storage/artifacts/{yyyymmdd}/{uuid}{ext}
 *
 * The yyyymmdd subdir is a tiny ergonomic — keeps `ls` manageable when many
 * artifacts accumulate. The {uuid} keeps filenames unique while preserving
 * the original extension (which both the OS file dialog and our
 * Content-Type derivation rely on).
 *
 * `filename` in the DB is the *display* name; the on-disk path is opaque.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ARTIFACTS_SUBDIR = 'artifacts';

function ensureArtifactsDir(storageDir) {
  const root = path.join(storageDir, ARTIFACTS_SUBDIR);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function dateBucket(d = new Date()) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function safeExt(filename) {
  const ext = path.extname(filename || '');
  // Only keep recognisable, short extensions; otherwise drop it.
  if (!ext || ext.length > 12 || /[^a-zA-Z0-9.]/.test(ext)) return '';
  return ext.toLowerCase();
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Persist an artifact buffer to disk + DB row. Atomic write (tmp + rename).
 *
 * @param {object} args
 * @param {object} args.db                — better-sqlite3 instance
 * @param {string} args.storageDir        — absolute, the same dir skills/ lives under
 * @param {number} args.messageId         — assistant message id this artifact belongs to
 * @param {string|null} args.skillSlug    — which skill produced it (audit)
 * @param {string} args.filename          — display name (e.g. "report.xlsx")
 * @param {string} args.contentType       — MIME type
 * @param {Buffer} args.data              — file bytes
 *
 * @returns {{
 *   id: number, message_id: number, skill_slug: string|null,
 *   filename: string, content_type: string, size_bytes: number,
 *   sha256: string, file_path: string, created_at: string
 * }}
 */
function saveArtifact({ db, storageDir, messageId, skillSlug, filename, contentType, data }) {
  if (!Buffer.isBuffer(data)) {
    throw new Error('saveArtifact: data must be a Buffer');
  }
  if (!filename || typeof filename !== 'string') {
    throw new Error('saveArtifact: filename is required');
  }

  const root = ensureArtifactsDir(storageDir);
  const bucket = dateBucket();
  const bucketDir = path.join(root, bucket);
  fs.mkdirSync(bucketDir, { recursive: true });

  const ext = safeExt(filename);
  const uuid = crypto.randomUUID();
  const relPath = path.posix.join(bucket, `${uuid}${ext}`);
  const finalPath = path.join(root, relPath);
  const tempPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;

  fs.writeFileSync(tempPath, data);
  fs.renameSync(tempPath, finalPath);

  const digest = sha256(data);
  const result = db
    .prepare(
      `INSERT INTO artifacts
         (message_id, skill_slug, filename, content_type, size_bytes, sha256, file_path)
       VALUES (@message_id, @skill_slug, @filename, @content_type, @size_bytes, @sha256, @file_path)`,
    )
    .run({
      message_id: messageId,
      skill_slug: skillSlug ?? null,
      filename,
      content_type: contentType,
      size_bytes: data.length,
      sha256: digest,
      file_path: relPath,
    });

  return db
    .prepare(
      `SELECT id, message_id, skill_slug, filename, content_type,
              size_bytes, sha256, file_path, created_at
       FROM artifacts WHERE id = ?`,
    )
    .get(result.lastInsertRowid);
}

/**
 * Resolve the absolute filesystem path for an artifact row, with path-traversal
 * defense (refuse anything outside storage/artifacts/).
 */
function resolveArtifactPath(storageDir, relPath) {
  const root = path.resolve(storageDir, ARTIFACTS_SUBDIR);
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`refused to resolve artifact path outside ${root}: ${relPath}`);
  }
  return abs;
}

/**
 * Best-effort cleanup of artifact files after the parent message/conversation
 * is deleted. The DB rows go via ON DELETE CASCADE; this only chases the
 * files. Caller must pass in the rows to delete (we don't query the DB here).
 */
function deleteArtifactFiles(storageDir, rows) {
  for (const row of rows) {
    try {
      const abs = resolveArtifactPath(storageDir, row.file_path);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch {
      /* swallow — best effort */
    }
  }
}

module.exports = {
  saveArtifact,
  resolveArtifactPath,
  deleteArtifactFiles,
  ensureArtifactsDir,
  ARTIFACTS_SUBDIR,
};
