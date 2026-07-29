#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const functionsRoot = path.resolve(__dirname, '..');
const force = process.argv.includes('--force');

const requiredPackages = [
  { name: 'firebase-admin', file: 'node_modules/firebase-admin/package.json' },
  { name: 'firebase-functions', file: 'node_modules/firebase-functions/package.json' },
  { name: '@types/node', file: 'node_modules/@types/node/package.json' },
  { name: 'typescript', file: 'node_modules/typescript/package.json' },
];

function missingPackages() {
  return requiredPackages
    .filter(({ file }) => !fs.existsSync(path.join(functionsRoot, file)))
    .map(({ name }) => name);
}

const missingBefore = missingPackages();
if (!force && missingBefore.length === 0) {
  console.log('Functions dependencies are ready.');
  process.exit(0);
}

if (force) {
  console.log('Reinstalling Functions dependencies from functions/package-lock.json...');
} else {
  console.log(
    `Functions dependencies are missing (${missingBefore.join(', ')}). Running npm ci automatically...`,
  );
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const install = spawnSync(npmCommand, ['ci'], {
  cwd: functionsRoot,
  stdio: 'inherit',
  env: process.env,
});

if (install.error) {
  console.error(`Unable to start npm ci: ${install.error.message}`);
  process.exit(1);
}

if (install.status !== 0) {
  console.error(`npm ci failed with exit code ${install.status ?? 'unknown'}.`);
  process.exit(install.status ?? 1);
}

const missingAfter = missingPackages();
if (missingAfter.length > 0) {
  console.error(
    `Functions dependencies are still missing after npm ci: ${missingAfter.join(', ')}`,
  );
  process.exit(1);
}

console.log('Functions dependencies were restored successfully.');
