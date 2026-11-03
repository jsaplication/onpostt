'use strict';

/**
 * Checagem de sintaxe de todos os arquivos JavaScript do projeto.
 *
 * Uso:
 *   npm run check
 *
 * Ignora dependências, bundles minificados e o vendor.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TARGETS = ['src', 'scripts', 'examples', 'test', 'public'];
const SKIP_DIRS = new Set(['node_modules', 'vendor', '.git']);

function collect(dir, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      collect(full, files);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    if (entry.name.endsWith('.min.js')) continue;
    files.push(full);
  }
}

const files = [];
for (const target of TARGETS) {
  const full = path.join(ROOT, target);
  if (fs.existsSync(full)) collect(full, files);
}

files.sort();

for (const file of files) {
  const relative = path.relative(ROOT, file);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    process.stderr.write(`[check] falhou: ${relative}\n`);
    if (error.stderr) process.stderr.write(error.stderr.toString());
    process.exit(1);
  }
}

process.stdout.write(`[check] ${files.length} arquivos JavaScript OK\n`);
