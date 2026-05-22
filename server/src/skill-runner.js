'use strict';

/**
 * Skill execution module.
 *
 * Given a skill ZIP (path or buffer) and a JSON input, this module:
 *   1. Extracts the ZIP to a fresh temp directory.
 *   2. Detects + strips a single-folder wrapper if present.
 *   3. Spawns the entry script (Node or Python) with controlled env
 *      (OPENSKILL_OUTPUT_DIR, NODE_PATH or PYTHONPATH).
 *   4. Pipes the JSON input to stdin.
 *   5. Captures stdout/stderr, enforces a wall-clock timeout, enforces an
 *      output-size cap.
 *   6. Returns either a single file (path/contentType/fileName/buffer) or a
 *      ZIP of multiple files. Always cleans up the temp dir before returning.
 *
 * Two runtimes are supported:
 *   - "node":    spawns `process.execPath`, exposes server's node_modules
 *                via NODE_PATH so skills can `require('docx')`.
 *   - "python":  spawns `python3` (override via OPENSKILL_PYTHON env var),
 *                with PYTHONPATH set to the system dist-packages so skills
 *                can `import openpyxl`, `import pandas`, etc.
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

const ENTRY_DEFAULT_NODE = 'scripts/run.js';
const ENTRY_DEFAULT_PYTHON = 'scripts/run.py';

// Python interpreter; overridable for tests or unusual hosts.
const PYTHON_BIN = process.env.OPENSKILL_PYTHON || 'python3';

// Default PYTHONPATH segments that expose the host-installed libraries
// (Debian / Docker image installs to /usr/lib/python3/dist-packages and
// pip --break-system-packages writes to /usr/local/lib/python3.*/dist-packages).
const DEFAULT_PYTHONPATH = [
  '/usr/local/lib/python3.12/dist-packages',
  '/usr/lib/python3/dist-packages',
  '/usr/local/lib/python3/dist-packages',
];

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
 * Decide which runtime + entry to use for a skill.
 *
 * Returns one of:
 *   { mode: 'node',    entry: '...' }       - has scripts/run.js or .js entry
 *   { mode: 'python',  entry: '...' }       - has scripts/run.py or .py entry
 *   { mode: 'agent' }                        - has SKILL.md but no entry
 *   { mode: 'unsupported', reason: '...' }  - manifest declared bad runtime/suffix
 *   { mode: 'none',    reason: '...' }      - not even a SKILL.md
 *
 * @param {Array<{path: string, type: string}>} fileTree
 * @param {object|null} manifest
 */
function detectExecutionMode(fileTree, manifest) {
  const hasFile = (p) =>
    fileTree.some((f) => f && f.type === 'file' && f.path === p);

  // Honour an explicit manifest declaration first.
  const declaredEntry =
    manifest && manifest.run && typeof manifest.run.entry === 'string'
      ? manifest.run.entry.replace(/\\/g, '/')
      : null;
  const declaredRuntime =
    manifest && manifest.run && typeof manifest.run.runtime === 'string'
      ? manifest.run.runtime
      : null;

  if (declaredRuntime && declaredRuntime !== 'node' && declaredRuntime !== 'python') {
    return {
      mode: 'unsupported',
      reason: `runtime "${declaredRuntime}" is not supported`,
    };
  }

  if (declaredEntry) {
    if (declaredEntry.endsWith('.js')) {
      return { mode: 'node', entry: declaredEntry };
    }
    if (declaredEntry.endsWith('.py')) {
      return { mode: 'python', entry: declaredEntry };
    }
    return {
      mode: 'unsupported',
      reason: `unknown entry suffix: ${declaredEntry}`,
    };
  }

  // Fall back to file presence
  if (declaredRuntime === 'node' || (!declaredRuntime && hasFile(ENTRY_DEFAULT_NODE))) {
    if (hasFile(ENTRY_DEFAULT_NODE)) {
      return { mode: 'node', entry: ENTRY_DEFAULT_NODE };
    }
  }
  if (declaredRuntime === 'python' || (!declaredRuntime && hasFile(ENTRY_DEFAULT_PYTHON))) {
    if (hasFile(ENTRY_DEFAULT_PYTHON)) {
      return { mode: 'python', entry: ENTRY_DEFAULT_PYTHON };
    }
  }

  // No entry, but a SKILL.md → agent mode (LLM writes the code)
  if (hasFile('SKILL.md')) return { mode: 'agent' };

  return { mode: 'none', reason: 'no SKILL.md and no entry script' };
}

/**
 * Resolve manifest.run config from a parsed manifest.json.
 * Returns: { entry, timeoutMs, runtime, inputExample }
 *
 * @param {object|null} manifest
 * @param {object} [opts]
 * @param {'node'|'python'} [opts.modeHint]  — override default entry/runtime
 *        when the caller has already detected the execution mode.
 */
function resolveRunConfig(manifest, { modeHint } = {}) {
  const r = (manifest && manifest.run) || {};

  const defaultEntry =
    modeHint === 'python' ? ENTRY_DEFAULT_PYTHON : ENTRY_DEFAULT_NODE;
  let entry = typeof r.entry === 'string' ? r.entry : defaultEntry;

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

  // Determine runtime: explicit manifest.run.runtime wins, else infer from
  // entry suffix, else fall back to modeHint or 'node'.
  let runtime = typeof r.runtime === 'string' ? r.runtime : null;
  if (!runtime) {
    if (entry.endsWith('.py')) runtime = 'python';
    else if (entry.endsWith('.js')) runtime = 'node';
    else runtime = modeHint || 'node';
  }
  if (runtime !== 'node' && runtime !== 'python') {
    throw new RunnerError(
      'UNSUPPORTED_RUNTIME',
      `Only "node" and "python" runtimes are supported; manifest declares "${runtime}"`,
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
 * Return null if this skill is runnable (Node OR Python), or an error
 * string explaining why not. Cheap check used by the route to decide
 * whether to even attempt extraction.
 *
 * Agent-mode (no entry, but SKILL.md present) is **not** considered
 * "runnable" by this function — that path does not have a direct
 * `POST /run` form-submit affordance; it surfaces through the chat tool
 * `run_python_code` instead.
 *
 * @param {Array<{path: string, type: string}>} fileTree
 * @param {object|null} manifest                — parsed manifest.json (or null)
 */
function checkRunnable(fileTree, manifest) {
  const mode = detectExecutionMode(fileTree, manifest);
  if (mode.mode === 'node' || mode.mode === 'python') return null;
  if (mode.mode === 'agent') {
    return 'skill has no entry script (agent mode is exposed via chat, not Run)';
  }
  if (mode.mode === 'unsupported') return mode.reason;
  // 'none'
  return mode.reason || 'skill has no entry script';
}

// --- Public: run a skill ------------------------------------------------

/**
 * Run a skill from its ZIP buffer.
 *
 * @param {Object} args
 * @param {Buffer} args.zipBuffer        — the skill ZIP contents
 * @param {object|null} args.manifest    — parsed manifest.json (or null)
 * @param {Array<{path:string, type:string}>=} args.fileTree
 *      — pre-computed file tree (from validator). If omitted we re-walk
 *        the extracted directory.
 * @param {*} args.input                 — JSON-serialisable input
 * @param {string[]=} args.extraNodePaths
 *      — extra directories to prepend to NODE_PATH (server's node_modules,
 *        so skills can `require('docx')` etc.). Resolved absolute paths.
 * @param {string[]=} args.extraPythonPaths
 *      — extra directories to prepend to PYTHONPATH. Defaults already
 *        include the host's system site-packages.
 * @param {Partial<typeof DEFAULTS>=} args.limits
 *
 * @returns {Promise<{
 *   filename: string,
 *   contentType: string,
 *   data: Buffer,
 *   stdout: string,
 *   stderr: string,
 *   durationMs: number,
 *   runtime: 'node'|'python',
 * }>}
 *
 * Throws RunnerError on any failure (including BUSY, OUTPUT_TOO_LARGE,
 * SCRIPT_FAILED, TIMEOUT, …). The caller should translate to an HTTP
 * status. The temp dir is always cleaned up.
 */
async function runSkill({
  zipBuffer,
  manifest = null,
  fileTree = null,
  input = {},
  extraNodePaths = [],
  extraPythonPaths = [],
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

    // 2. Decide mode (preferring caller-provided fileTree if any). If the
    // caller didn't supply one we cheaply recompute by listing the skill
    // root recursively.
    let tree = fileTree;
    if (!Array.isArray(tree)) tree = walkRelativeFileTree(skillRoot);
    const mode = detectExecutionMode(tree, manifest);
    if (mode.mode !== 'node' && mode.mode !== 'python') {
      // The HTTP layer should have caught this before extraction, but
      // double-check defensively. For backwards compat with the original
      // runner contract (a missing scripts/run.js was ENTRY_NOT_FOUND), we
      // map both 'agent' and 'none' to ENTRY_NOT_FOUND. Agent mode is
      // surfaced through the chat tool runtime, never through runSkill().
      if (mode.mode === 'unsupported') {
        throw new RunnerError(
          'UNSUPPORTED_RUNTIME',
          mode.reason || 'unsupported runtime declared in manifest',
        );
      }
      throw new RunnerError(
        'ENTRY_NOT_FOUND',
        `Entry script not found: ${ENTRY_DEFAULT_NODE} or ${ENTRY_DEFAULT_PYTHON}`,
      );
    }

    // 3. Resolve run config + entry path
    const cfg = resolveRunConfig(manifest, { modeHint: mode.mode });
    // If the manifest didn't declare an entry, prefer the auto-detected one
    // (matters when the manifest exists but only carries timeout_ms).
    if (!manifest?.run?.entry && mode.entry) cfg.entry = mode.entry;

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

    // 4. Serialise input + cap
    const inputJson = JSON.stringify(input ?? {});
    if (Buffer.byteLength(inputJson, 'utf8') > lim.maxInputBytes) {
      throw new RunnerError(
        'INPUT_TOO_LARGE',
        `Input exceeds ${lim.maxInputBytes}-byte cap`,
      );
    }

    const inputFile = path.join(tmpRoot, 'input.json');
    fs.writeFileSync(inputFile, inputJson);

    // 5. Build env. Whitelist a handful of vars; expose OPENSKILL_OUTPUT_DIR,
    // OPENSKILL_INPUT_FILE, plus runtime-specific module path.
    const envBase = {
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: tmpRoot,
      LANG: process.env.LANG || 'C.UTF-8',
      OPENSKILL_OUTPUT_DIR: outputDir,
      OPENSKILL_INPUT_FILE: inputFile,
    };

    let argv;
    let interpreter;
    const env = { ...envBase };
    if (cfg.runtime === 'node') {
      const nodePathParts = [
        path.join(skillRootAbs, 'node_modules'),
        ...extraNodePaths.map((p) => path.resolve(p)),
      ].filter(Boolean);
      env.NODE_PATH = nodePathParts.join(path.delimiter);
      interpreter = process.execPath;
      argv = [entryAbs];
    } else {
      // python
      const pyPathParts = [
        path.join(skillRootAbs),
        ...extraPythonPaths.map((p) => path.resolve(p)),
        ...DEFAULT_PYTHONPATH,
      ].filter((p, i, arr) => p && arr.indexOf(p) === i);
      env.PYTHONPATH = pyPathParts.join(path.delimiter);
      env.PYTHONDONTWRITEBYTECODE = '1';
      env.PYTHONUNBUFFERED = '1';
      interpreter = PYTHON_BIN;
      argv = [entryAbs];
    }

    // 6. Spawn the interpreter.
    const startedAt = Date.now();
    const stdoutCap = makeCapturer(lim.maxStdioBytes);
    const stderrCap = makeCapturer(lim.maxStdioBytes);

    const child = spawn(interpreter, argv, {
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

    let spawnErr = null;
    const { code, signal } = await new Promise((resolve) => {
      child.on('error', (err) => {
        spawnErr = err;
        resolve({ code: null, signal: null });
      });
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timer);

    const stdout = stdoutCap.value();
    const stderr = stderrCap.value();

    if (spawnErr) {
      // Common case: ENOENT for python3 on a host that doesn't have it.
      const code = spawnErr.code === 'ENOENT' && cfg.runtime === 'python'
        ? 'PYTHON_NOT_INSTALLED'
        : 'SPAWN_FAILED';
      throw new RunnerError(code, spawnErr.message, { stdout, stderr });
    }
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

    // 7. Collect output
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
        runtime: cfg.runtime,
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
        runtime: cfg.runtime,
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

/**
 * Walk a directory and return a `[ {path, type} ]` list compatible with
 * the cached file_tree shape used by the validator. Used by runSkill when
 * the caller doesn't pass one.
 */
function walkRelativeFileTree(rootDir) {
  const out = [];
  function walk(rel, abs) {
    const items = fs.readdirSync(abs, { withFileTypes: true });
    for (const item of items) {
      const childAbs = path.join(abs, item.name);
      const childRel = rel ? path.posix.join(rel, item.name) : item.name;
      if (item.isDirectory()) {
        out.push({ path: childRel, type: 'dir' });
        walk(childRel, childAbs);
      } else if (item.isFile()) {
        out.push({ path: childRel, type: 'file' });
      }
    }
  }
  if (fs.existsSync(rootDir)) walk('', rootDir);
  return out;
}

module.exports = {
  runSkill,
  checkRunnable,
  detectExecutionMode,
  resolveRunConfig,
  contentTypeFor,
  isBusy,
  RunnerError,
  DEFAULTS,
  // exposed for tests
  _internal: {
    extractZipToDir,
    listOutputFiles,
    zipOutputFiles,
    findSkillRoot,
    walkRelativeFileTree,
  },
};

// suppress unused-binding noise from `crypto` import (kept for future use)
void crypto;
