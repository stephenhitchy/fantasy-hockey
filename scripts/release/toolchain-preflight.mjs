#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  expectedPackageManagerVersion,
  inspectToolchain,
  normalizeVersion,
} from './toolchain-preflight.util.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function npmVersionFromUserAgent() {
  const match = String(process.env.npm_config_user_agent ?? '').match(/(?:^|\s)npm\/([^\s]+)/);
  return match?.[1] ?? '';
}

function actualNpmVersion() {
  const fromUserAgent = npmVersionFromUserAgent();
  if (fromUserAgent) {
    return normalizeVersion(fromUserAgent);
  }

  return normalizeVersion(
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], {
      cwd: projectRoot,
      encoding: 'utf8',
      windowsHide: true,
    }),
  );
}

async function main() {
  const strict = process.argv.includes('--strict');
  const json = process.argv.includes('--json');
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const expectedNode = normalizeVersion(await readFile(path.join(projectRoot, '.nvmrc'), 'utf8'));
  const expectedNpm = expectedPackageManagerVersion(packageJson.packageManager);
  const result = inspectToolchain({
    expectedNode,
    expectedNpm,
    actualNode: process.version,
    actualNpm: actualNpmVersion(),
  });

  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (result.ok) {
    console.log(`RinkRat release toolchain is ready: Node ${result.actual.node}, npm ${result.actual.npm}.`);
  } else {
    console.error('RinkRat release toolchain needs attention:');
    result.issues.forEach((issue) => console.error(`- ${issue}`));
    console.error('Ignore npm major-version notices unless the project packageManager pin is deliberately updated in a tested maintenance release.');
  }

  if (strict && !result.ok) {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
