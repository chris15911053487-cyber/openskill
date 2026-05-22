#!/usr/bin/env node
/**
 * Build runnable example skills into ZIP files under examples/dist/.
 *
 * Each top-level directory in examples/ (other than dist/) is treated as
 * one skill. We pack everything except node_modules and *.zip.
 *
 * Usage:  node scripts/build-examples.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
// Pulled from server's node_modules — keeps the repo root deps minimal.
const AdmZip = require(path.resolve(__dirname, '..', 'server', 'node_modules', 'adm-zip'));

const repoRoot = path.resolve(__dirname, '..');
const examplesDir = path.join(repoRoot, 'examples');
const outDir = path.join(examplesDir, 'dist');
fs.mkdirSync(outDir, { recursive: true });

const skip = new Set(['dist']);

function* walk(dir, base = dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, item.name);
    if (item.isDirectory()) {
      if (item.name === 'node_modules' || item.name.startsWith('.')) continue;
      yield* walk(abs, base);
    } else if (item.isFile()) {
      if (item.name.endsWith('.zip')) continue;
      yield { abs, rel: path.relative(base, abs).split(path.sep).join('/') };
    }
  }
}

for (const entry of fs.readdirSync(examplesDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || skip.has(entry.name)) continue;
  const skillDir = path.join(examplesDir, entry.name);
  const skillMd = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) {
    console.warn(`skip ${entry.name}: no SKILL.md`);
    continue;
  }
  const zip = new AdmZip();
  for (const f of walk(skillDir)) {
    zip.addFile(f.rel, fs.readFileSync(f.abs));
  }
  const outPath = path.join(outDir, `${entry.name}.zip`);
  zip.writeZip(outPath);
  const size = fs.statSync(outPath).size;
  console.log(`built ${path.relative(repoRoot, outPath)} (${size} bytes)`);
}
