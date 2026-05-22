'use strict';

const path = require('path');
const AdmZip = require('adm-zip');
const yaml = require('js-yaml');
const { badRequest } = require('./errors');

const MAX_README_EXCERPT_CHARS = 500;
const MAX_FILE_TREE_ENTRIES = 1000;

/**
 * Split a SKILL.md text into YAML frontmatter object + markdown body.
 *
 * Anthropic Agent Skills mandate frontmatter with at minimum `name` and
 * `description`. Frontmatter is delimited by `---` on its own line at the
 * start of the file.
 *
 * @param {string} text
 * @returns {{ frontmatter: object, body: string }}
 */
function parseFrontmatter(text) {
  // Normalise line endings — some Windows-zipped skills have CRLF.
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r')) {
    throw badRequest(
      'INVALID_FRONTMATTER',
      'SKILL.md must begin with YAML frontmatter delimited by ---',
    );
  }
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) {
    throw badRequest('INVALID_FRONTMATTER', 'SKILL.md frontmatter is not closed by ---');
  }
  const yamlText = normalized.slice(4, end);
  let bodyStart = end + 4; // skip "\n---"
  // Skip following newline
  if (normalized[bodyStart] === '\n') bodyStart += 1;
  const body = normalized.slice(bodyStart);

  let parsed;
  try {
    parsed = yaml.load(yamlText);
  } catch (err) {
    throw badRequest('INVALID_FRONTMATTER', `Invalid YAML frontmatter: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('INVALID_FRONTMATTER', 'Frontmatter must be a YAML mapping');
  }
  return { frontmatter: parsed, body };
}

/**
 * Open a buffer as a ZIP and return its entries. Throws ZIP_CORRUPT on parse
 * failure.
 *
 * @param {Buffer} buffer
 * @returns {AdmZip}
 */
function openZip(buffer) {
  try {
    return new AdmZip(buffer);
  } catch (err) {
    throw badRequest('ZIP_CORRUPT', `Could not read ZIP archive: ${err.message}`);
  }
}

/**
 * Detect whether the archive's contents are wrapped in a single top-level
 * directory. Many zipped skills look like:
 *   my-skill/
 *     SKILL.md
 *     scripts/...
 * We strip that wrapper for storage so the on-disk layout is consistent.
 *
 * @param {AdmZip.IZipEntry[]} entries
 * @returns {string|null} the wrapper prefix (with trailing slash), or null
 */
function detectWrapperPrefix(entries) {
  const tops = new Set();
  for (const e of entries) {
    const name = e.entryName.replace(/\\/g, '/');
    if (name.startsWith('__MACOSX/') || name === '.DS_Store') continue;
    const slash = name.indexOf('/');
    if (slash === -1) {
      // top-level file -> no wrapper
      return null;
    }
    tops.add(name.slice(0, slash + 1));
    if (tops.size > 1) return null;
  }
  if (tops.size === 1) {
    const [only] = tops;
    return only;
  }
  return null;
}

/**
 * Build the structured file tree (sans wrapper prefix), filter out junk files.
 *
 * @returns {Array<{ path: string, size: number, type: 'dir'|'file' }>}
 */
function buildFileTree(entries, wrapperPrefix) {
  const tree = [];
  for (const e of entries) {
    let name = e.entryName.replace(/\\/g, '/');
    if (name.startsWith('__MACOSX/')) continue;
    if (name.endsWith('/.DS_Store') || name === '.DS_Store') continue;
    if (wrapperPrefix && name === wrapperPrefix) continue;
    if (wrapperPrefix && name.startsWith(wrapperPrefix)) {
      name = name.slice(wrapperPrefix.length);
    }
    if (!name) continue;
    tree.push({
      path: name,
      size: e.header.size,
      type: e.isDirectory ? 'dir' : 'file',
    });
    if (tree.length > MAX_FILE_TREE_ENTRIES) {
      throw badRequest(
        'TOO_MANY_FILES',
        `Skill archive contains more than ${MAX_FILE_TREE_ENTRIES} entries`,
      );
    }
  }
  // Stable sort: directories first, then alpha
  tree.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  return tree;
}

/**
 * Validate an Anthropic Agent Skills ZIP buffer.
 *
 * Required:
 *   - root SKILL.md (or {wrapper}/SKILL.md)
 *   - YAML frontmatter with `name` and `description`
 *
 * Optional:
 *   - manifest.json at root (AFPS-style metadata)
 *
 * @param {Buffer} buffer
 * @returns {{
 *   skillMdContent: string,
 *   frontmatter: { name: string, description: string, [k: string]: any },
 *   readmeExcerpt: string,
 *   fileTree: Array<{ path: string, size: number, type: string }>,
 *   manifest: object | null,
 *   wrapperPrefix: string | null
 * }}
 */
function validateSkillZip(buffer) {
  const zip = openZip(buffer);
  const entries = zip.getEntries();
  if (entries.length === 0) throw badRequest('ZIP_CORRUPT', 'ZIP archive is empty');

  const wrapperPrefix = detectWrapperPrefix(entries);

  // Find SKILL.md
  const skillMdName = wrapperPrefix ? `${wrapperPrefix}SKILL.md` : 'SKILL.md';
  let skillMdEntry = entries.find(
    (e) => e.entryName.replace(/\\/g, '/') === skillMdName && !e.isDirectory,
  );
  // Some tools name it SKILL.MD or skill.md; be tolerant on case
  if (!skillMdEntry) {
    skillMdEntry = entries.find((e) => {
      const n = e.entryName.replace(/\\/g, '/');
      return (
        !e.isDirectory &&
        (n === 'SKILL.md' ||
          n.toLowerCase() === skillMdName.toLowerCase() ||
          n.toLowerCase() === 'skill.md')
      );
    });
  }
  if (!skillMdEntry) {
    throw badRequest(
      'MISSING_SKILL_MD',
      'Required SKILL.md not found at the root of the archive',
    );
  }

  const skillMdContent = skillMdEntry.getData().toString('utf8');
  const { frontmatter, body } = parseFrontmatter(skillMdContent);

  if (!frontmatter.name || typeof frontmatter.name !== 'string') {
    throw badRequest('MISSING_NAME', 'Frontmatter must include a `name` field');
  }
  if (!frontmatter.description || typeof frontmatter.description !== 'string') {
    throw badRequest('MISSING_DESCRIPTION', 'Frontmatter must include a `description` field');
  }
  if (frontmatter.name.length > 64) {
    throw badRequest('INVALID_FRONTMATTER', '`name` must be 64 characters or fewer');
  }
  if (frontmatter.description.length > 1024) {
    throw badRequest('INVALID_FRONTMATTER', '`description` must be 1024 characters or fewer');
  }

  // Extract optional manifest.json
  const manifestName = wrapperPrefix ? `${wrapperPrefix}manifest.json` : 'manifest.json';
  const manifestEntry = entries.find(
    (e) => e.entryName.replace(/\\/g, '/') === manifestName && !e.isDirectory,
  );
  let manifest = null;
  if (manifestEntry) {
    try {
      manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
    } catch (err) {
      throw badRequest('INVALID_MANIFEST', `manifest.json is not valid JSON: ${err.message}`);
    }
  }

  const fileTree = buildFileTree(entries, wrapperPrefix);

  // README excerpt = first MAX_README_EXCERPT_CHARS of the markdown body
  const readmeExcerpt = body.trim().slice(0, MAX_README_EXCERPT_CHARS);

  return {
    skillMdContent,
    frontmatter,
    readmeExcerpt,
    fileTree,
    manifest,
    wrapperPrefix,
  };
}

module.exports = { validateSkillZip, parseFrontmatter, MAX_README_EXCERPT_CHARS };
// Exposed for testing
module.exports._internal = { detectWrapperPrefix, buildFileTree, openZip };
// path is required only for downstream use; eslint placation
void path;
