'use strict';

/**
 * Skill execution module.
 *
 * Given a skill ZIP (path or buffer) and a JSON input, this module:
 *   1. Extracts the ZIP to a fresh temp directory.
 *   2. Detects + strips a single-folder wrapper if present.
 *   3. Spawns `node <entry>` with controlled env (OPENSKILL_OUTPUT_DIR, NODE_PATH).
 *   4. Pipes the JSON input to stdin.
 *   5. Captures stdout/stderr, enforces a wall-clock timeout, enforces an
 *      output-size cap.
 *   6. Returns either a single file (path/contentType/fileName/buffer) or a
 *      ZIP of multiple files. Always cleans up the temp dir before returning.
 *
 * No Fastify dependencies — this is a pure node module so it can be unit
 * tested in isolation.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const AdmZip = require('adm-zip');

// --- Defaults / limits ---------------------------------------------------

const DEFAULTS = Object.freeze({
  timeoutMs: 60_000,
  maxInputBytes: 1 * 1024 * 1024, // 1 MB JSON input cap
  maxOutputBytes: 50 * 1024 * 1024, // 50 MB total output cap
  maxStdioBytes: 256 * 1024, // 256 KB stdout / stderr each
});

const ENTRY_DEFAULT = 'scripts/run.js';

// Map of file extensions -> Content-Type. Extensible; falls back to
// application/octet-stream if unknown.
const CONTENT_TYPES = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

function contentTypeFor(filename) {
  const ext = path.extname(filename).toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

// --- Single-flight lock --------------------------------------------------

// Module-level mutex. The intended deployment is single-user, so we don't
// queue: a second concurrent request gets RUN_BUSY (409) and the user can
// retry. Exposed for tests.
let _busy = false;
function isBusy() {
  return _busy;
}
function _acquire() {
  if (_busy) return false;
  _busy = true;
  return true;
}
function _release() {
  _busy = false;
}

// --- Errors --------------------------------------------------------------

class RunnerError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

// --- Helpers -------------------------------------------------------------

/**
 * Extract a ZIP to `destDir`. Returns the canonical "skill root" — that is,
 * the directory inside which `SKILL.md` lives. If the archive has a single
 * top-level wrapper directory we descend into it; otherwise destDir itself
 * is the root.
 *
 * Filters __MACOSX / .DS_Store junk and refuses entries that try to escape
 * destDir (zip-slip defense).
 */
function extractZipToDir(zipBuffer, destDir) {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  if (entries.length === 0) {
    throw new RunnerError('ZIP_CORRUPT', 'Skill archive is empty');
  }

  const destAbs = path.resolve(destDir);
  for (const e of entries) {
    const rawName = e.entryName.replace(/\\/g, '/');
    if (rawName.startsWith('__MACOSX/')) continue;
    if (rawName.endsWith('/.DS_Store') || rawName === '.DS_Store') continue;

    const targetPath = path.resolve(destAbs, rawName);
    // Defense in depth against zip-slip — refuse entries whose resolved
    // path escapes destDir.
    if (
      targetPath !== destAbs &&
      !targetPath.startsWith(destAbs + path.sep)
    ) {
      throw new RunnerError(
        'ZIP_UNSAFE_PATH',
        `Refusing to extract entry outside destination: ${rawName}`,
      );
    }

    if (e.isDirectory) {
      fs.mkdirSync(targetPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, e.getData());
    }
  }

  return findSkillRoot(destAbs);
}

/**
 * Find the directory holding SKILL.md. If destDir contains SKILL.md
 * directly, that's the root. Otherwise expect exactly one subdirectory
 * containing SKILL.md.
 */
function findSkillRoot(destDir) {
  if (fs.existsSync(path.join(destDir, 'SKILL.md'))) return destDir;
  const items = fs
    .readdirSync(destDir, { withFileTypes: true })
    .filter((d) => !d.name.startsWith('__MACOSX') && d.name !== '.DS_Store');
  const dirs = items.filter((d) => d.isDirectory());
  if (dirs.length === 1) {
    const candidate = path.join(destDir, dirs[0].name);
    if (fs.existsSync(path.join(candidate, 'SKILL.md'))) return candidate;
  }
  // No SKILL.md found, but allow runner to proceed — entry resolution will
  // fail with a clearer error.
  return destDir;
}

/**
 * Recursively list files under a directory, returning relative paths +
 * sizes. Stops early once the cumulative byte total exceeds `cap`.
 */
function listOutputFiles(dir, cap) {
  const out = [];
  let totalBytes = 0;

  function walk(rel, abs) {
    const items = fs.readdirSync(abs, { withFileTypes: true });
    for (const item of items) {
      const childAbs = path.join(abs, item.name);
      const childRel = rel ? path.posix.join(rel, item.name) : item.name;
      if (item.isDirectory()) {
        walk(childRel, childAbs);
      } else if (item.isFile()) {
        const stat = fs.statSync(childAbs);
        totalBytes += stat.size;
        if (totalBytes > cap) {
          throw new RunnerError(
            'OUTPUT_TOO_LARGE',
            `Skill output exceeds the ${cap}-byte cap`,
          );
        }
        out.push({ rel: childRel, abs: childAbs, size: stat.size });
      }
      // symlinks etc. are ignored
    }
  }

  if (fs.existsSync(dir)) walk('', dir);
  return { files: out, totalBytes };
}

/**
 * Pack multiple output files into a single ZIP buffer.
 */
function zipOutputFiles(files) {
  const zip = new AdmZip();
  for (const f of files) {
    zip.addFile(f.rel, fs.readFileSync(f.abs));
  }
  return zip.toBuffer();
}

/**
 * Capture-with-cap helper: collects buffers up to `cap` bytes, dropping
 * anything past that. Returns { append(chunk), value() }.
 */
function makeCapturer(cap) {
  const chunks = [];
  let total = 0;
  let truncated = false;
  return {
    append(chunk) {
      if (total >= cap) {
        truncated = true;
        return;
      }
      const remaining = cap - total;
      if (chunk.length <= remaining) {
        chunks.push(chunk);
        total += chunk.length;
      } else {
        chunks.push(chunk.subarray(0, remaining));
        total += remaining;
        truncated = true;
      }
    },
    value() {
      const buf = Buffer.concat(chunks, total);
      return truncated ? buf.toString('utf8') + '\n…[truncated]' : buf.toString('utf8');
    },
  };
}

/**
 * Resolve manifest.run config from a parsed manifest.json.
 * Returns: { entry, timeoutMs, runtime, inputExample }
 */
function resolveRunConfig(manifest) {
  const r = (manifest && manifest.run) || {};
  let entry = typeof r.entry === 'string' ? r.entry : ENTRY_DEFAULT;

  // Normalise + validate entry path: must be relative, no .. segments, no abs.
  entry = entry.replace(/\\/g, '/');
  if (
    path.isAbsolute(entry) ||
    entry.split('/').some((seg) => seg === '..' || seg === '')
  ) {
    throw new RunnerError(
      'INVALID_ENTRY',
      `manifest.run.entry must be a clean relative path; got "${entry}"`,
    );
  }

  let timeoutMs = DEFAULTS.timeoutMs;
  if (Number.isFinite(r.timeout_ms)) {
    timeoutMs = Math.max(1_000, Math.min(300_000, r.timeout_ms));
  }

  const runtime = typeof r.runtime === 'string' ? r.runtime : 'node';
  if (runtime !== 'node') {
    throw new RunnerError(
      'UNSUPPORTED_RUNTIME',
      `Only "node" runtime is supported; manifest declares "${runtime}"`,
    );
  }

  return {
    entry,
    timeoutMs,
    runtime,
    inputExample: r.input_example !== undefined ? r.input_example : null,
  };
}

// --- Public: probe whether a skill is runnable --------------------------

/**
 * Return null if this skill is runnable, or an error string explaining
 * why not. Cheap check used by the route to decide whether to even
 * attempt extraction.
 *
 * @param {Array<{path: string, type: string}>} fileTree
 * @param {object|null} manifest                — parsed manifest.json (or null)
 */
function checkRunnable(fileTree, manifest) {
  let entry = ENTRY_DEFAULT;
  if (manifest && manifest.run && typeof manifest.run.entry === 'string') {
    entry = manifest.run.entry.replace(/\\/g, '/');
  }
  const found = fileTree.some(
    (f) => f.type === 'file' && f.path === entry,
  );
  if (!found) {
    return `entry "${entry}" not found in skill files`;
  }
  if (manifest && manifest.run && manifest.run.runtime &&
      manifest.run.runtime !== 'node') {
    return `runtime "${manifest.run.runtime}" is not supported`;
  }
  return null;
}

// --- Public: run a skill ------------------------------------------------

/**
 * Run a skill from its ZIP buffer.
 *
 * @param {Object} args
 * @param {Buffer} args.zipBuffer        — the skill ZIP contents
 * @param {object|null} args.manifest    — parsed manifest.json (or null)
 * @param {*} args.input                 — JSON-serialisable input
 * @param {string[]=} args.extraNodePaths
 *      — extra directories to prepend to NODE_PATH (server's node_modules,
 *        so skills can `require('docx')` etc.). Resolved absolute paths.
 * @param {Partial<typeof DEFAULTS>=} args.limits
 *
 * @returns {Promise<{
 *   filename: string,
 *   contentType: string,
 *   data: Buffer,
 *   stdout: string,
 *   stderr: string,
 *   durationMs: number
 * }>}
 *
 * Throws RunnerError on any failure (including BUSY, OUTPUT_TOO_LARGE,
 * SCRIPT_FAILED, TIMEOUT, …). The caller should translate to an HTTP
 * status. The temp dir is always cleaned up.
 */
async function runSkill({
  zipBuffer,
  manifest = null,
  input = {},
  extraNodePaths = [],
  limits = {},
}) {
  if (!_acquire()) {
    throw new RunnerError(
      'RUN_BUSY',
      'Another skill execution is in progress; please retry',
    );
  }

  const lim = { ...DEFAULTS, ...limits };
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openskill-run-'));
  const extractDir = path.join(tmpRoot, 'skill');
  const outputDir = path.join(tmpRoot, 'output');
  fs.mkdirSync(extractDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  try {
    // 1. Extract ZIP, find skill root
    const skillRoot = extractZipToDir(zipBuffer, extractDir);

    // 2. Resolve run config + entry path
    const cfg = resolveRunConfig(manifest);
    const entryAbs = path.resolve(skillRoot, cfg.entry);

    // Defense in depth: entry must be inside skillRoot
    const skillRootAbs = path.resolve(skillRoot);
    if (
      entryAbs !== skillRootAbs &&
      !entryAbs.startsWith(skillRootAbs + path.sep)
    ) {
      throw new RunnerError(
        'INVALID_ENTRY',
        'Resolved entry escapes the skill directory',
      );
    }
    if (!fs.existsSync(entryAbs)) {
      throw new RunnerError(
        'ENTRY_NOT_FOUND',
        `Entry script not found: ${cfg.entry}`,
      );
    }

    // 3. Serialise input + cap
    const inputJson = JSON.stringify(input ?? {});
    if (Buffer.byteLength(inputJson, 'utf8') > lim.maxInputBytes) {
      throw new RunnerError(
        'INPUT_TOO_LARGE',
        `Input exceeds ${lim.maxInputBytes}-byte cap`,
      );
    }

    // 4. Build env. Whitelist a handful of vars; expose OPENSKILL_OUTPUT_DIR,
    // OPENSKILL_INPUT_FILE, NODE_PATH.
    const inputFile = path.join(tmpRoot, 'input.json');
    fs.writeFileSync(inputFile, inputJson);

    const nodePathParts = [
      // Skill's own node_modules (if any) wins
      path.join(skillRootAbs, 'node_modules'),
      // Then the server's pre-installed modules (docx, exceljs, ...)
      ...extraNodePaths.map((p) => path.resolve(p)),
    ];
    const env = {
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: tmpRoot,
      LANG: process.env.LANG || 'C.UTF-8',
      OPENSKILL_OUTPUT_DIR: outputDir,
      OPENSKILL_INPUT_FILE: inputFile,
      NODE_PATH: nodePathParts.join(path.delimiter),
    };

    // 5. Spawn node.
    const startedAt = Date.now();
    const stdoutCap = makeCapturer(lim.maxStdioBytes);
    const stderrCap = makeCapturer(lim.maxStdioBytes);

    const child = spawn(process.execPath, [entryAbs], {
      cwd: skillRootAbs,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // We enforce timeout manually to give a clearer error code.
    });

    child.stdout.on('data', (chunk) => stdoutCap.append(chunk));
    child.stderr.on('data', (chunk) => stderrCap.append(chunk));

    // Pipe input as stdin too (some scripts will prefer stdin over reading
    // OPENSKILL_INPUT_FILE; both work).
    child.stdin.end(inputJson);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, lim.timeoutMs);

    const { code, signal } = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timer);

    const stdout = stdoutCap.value();
    const stderr = stderrCap.value();

    if (timedOut) {
      throw new RunnerError(
        'TIMEOUT',
        `Skill execution exceeded ${lim.timeoutMs}ms`,
        { stdout, stderr },
      );
    }
    if (code !== 0) {
      throw new RunnerError(
        'SCRIPT_FAILED',
        `Skill script exited with code ${code}${signal ? ` (signal=${signal})` : ''}`,
        { stdout, stderr, exitCode: code, signal },
      );
    }

    // 6. Collect output
    const { files } = listOutputFiles(outputDir, lim.maxOutputBytes);
    if (files.length === 0) {
      throw new RunnerError(
        'EMPTY_OUTPUT',
        'Skill did not produce any output files',
        { stdout, stderr },
      );
    }

    let result;
    if (files.length === 1) {
      const f = files[0];
      result = {
        filename: path.basename(f.rel),
        contentType: contentTypeFor(f.rel),
        data: fs.readFileSync(f.abs),
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      };
    } else {
      const zipBuf = zipOutputFiles(files);
      const stem = manifest?.name && typeof manifest.name === 'string'
        ? manifest.name
        : 'skill-output';
      result = {
        filename: `${stem}-${Date.now()}.zip`,
        contentType: 'application/zip',
        data: zipBuf,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      };
    }
    return result;
  } finally {
    // Always clean up the temp dir, but never let cleanup throw.
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    _release();
  }
}

module.exports = {
  runSkill,
  checkRunnable,
  resolveRunConfig,
  contentTypeFor,
  isBusy,
  RunnerError,
  DEFAULTS,
  // exposed for tests
  _internal: { extractZipToDir, listOutputFiles, zipOutputFiles, findSkillRoot },
};

// suppress unused-binding noise from `crypto` import (kept for future use)
void crypto;
