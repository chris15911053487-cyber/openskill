'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Compute the SHA-256 of a buffer.
 * @param {Buffer} buffer
 * @returns {string} hex digest
 */
function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Persist a skill ZIP buffer under {skillsDir}/{slug}.zip atomically.
 *
 * Atomicity strategy: write to a sibling temp file then rename. Avoids
 * leaving partial writes if the process crashes mid-write.
 *
 * @param {string} skillsDir   absolute path to the directory holding skill ZIPs
 * @param {string} slug        url-safe identifier (used as the filename stem)
 * @param {Buffer} buffer      complete ZIP contents
 * @returns {{ filePath: string, fileSize: number, sha256: string, relPath: string }}
 *          relPath is relative to skillsDir, suitable for storing in the DB.
 */
function saveSkillZip(skillsDir, slug, buffer) {
  if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true });

  const fileName = `${slug}.zip`;
  const finalPath = path.join(skillsDir, fileName);
  const tempPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;

  fs.writeFileSync(tempPath, buffer);
  fs.renameSync(tempPath, finalPath);

  return {
    filePath: finalPath,
    fileSize: buffer.length,
    sha256: sha256(buffer),
    relPath: fileName,
  };
}

/**
 * Delete a skill ZIP file. No-op if it does not exist.
 * @param {string} skillsDir
 * @param {string} slug
 */
function deleteSkillZip(skillsDir, slug) {
  const p = path.join(skillsDir, `${slug}.zip`);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

/**
 * Resolve the absolute filesystem path of a stored skill ZIP.
 * @param {string} skillsDir
 * @param {string} slug
 * @returns {string}
 */
function skillZipPath(skillsDir, slug) {
  return path.join(skillsDir, `${slug}.zip`);
}

module.exports = { saveSkillZip, deleteSkillZip, skillZipPath, sha256 };
