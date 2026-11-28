'use strict';

const { execFileSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function* javascriptFiles(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* javascriptFiles(file);
    else if (entry.isFile() && entry.name.endsWith('.js')) yield file;
  }
}

function check(args) {
  try {
    execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  } catch (error) {
    if (error.status == null) throw error;
    process.exitCode = 1;
  }
}

for (const directory of ['src', 'test', 'scripts']) {
  for (const file of javascriptFiles(path.join(root, directory))) {
    check(['--check', file]);
  }
}
check([require.resolve('typescript/bin/tsc'), '--noEmit', '-p', 'jsconfig.json']);
