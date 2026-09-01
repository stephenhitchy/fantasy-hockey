import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  FUNCTIONS_RUNTIME_INTEGRITY_INVENTORY,
  hashFunctionsRuntimeIntegrity,
  listFunctionsRuntimeIntegrityFiles,
} from '../shared/functions-runtime-integrity.mjs';

async function createFunctionsFixture(testContext) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'rinkrat-functions-integrity-'));
  testContext.after(() => rm(fixtureRoot, { force: true, recursive: true }));

  await Promise.all([
    mkdir(path.join(fixtureRoot, 'scripts'), { recursive: true }),
    mkdir(path.join(fixtureRoot, 'src'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(fixtureRoot, 'package-lock.json'), '{"lockfileVersion":3}\n'),
    writeFile(path.join(fixtureRoot, 'package.json'), '{"main":"lib/index.js"}\n'),
    writeFile(path.join(fixtureRoot, 'tsconfig.json'), '{"compilerOptions":{}}\n'),
    writeFile(path.join(fixtureRoot, 'scripts', 'ensure-dependencies.cjs'), 'module.exports = {};\n'),
    writeFile(path.join(fixtureRoot, 'src', 'index.ts'), 'export const runtimeValue = 1;\n'),
  ]);

  return fixtureRoot;
}

test('the Functions fingerprint inventory protects runtime, package, build, and operational inputs', async (testContext) => {
  const fixtureRoot = await createFunctionsFixture(testContext);
  const files = await listFunctionsRuntimeIntegrityFiles({ functionsRoot: fixtureRoot });

  assert.deepEqual(FUNCTIONS_RUNTIME_INTEGRITY_INVENTORY, {
    files: ['package-lock.json', 'package.json', 'tsconfig.json'],
    directories: ['scripts', 'src'],
  });
  assert.deepEqual(files, [
    'package-lock.json',
    'package.json',
    'scripts/ensure-dependencies.cjs',
    'src/index.ts',
    'tsconfig.json',
  ]);
});

test('repository instruction metadata does not change the protected Functions runtime fingerprint', async (testContext) => {
  const fixtureRoot = await createFunctionsFixture(testContext);
  const baseline = await hashFunctionsRuntimeIntegrity({ functionsRoot: fixtureRoot });

  await writeFile(path.join(fixtureRoot, 'AGENTS.md'), '# Initial Functions instructions\n');
  await writeFile(path.join(fixtureRoot, 'src', 'AGENTS.md'), '# Source instructions\n');
  await writeFile(path.join(fixtureRoot, 'scripts', 'AGENTS.md'), '# Script instructions\n');
  assert.equal(await hashFunctionsRuntimeIntegrity({ functionsRoot: fixtureRoot }), baseline);

  await writeFile(path.join(fixtureRoot, 'AGENTS.md'), '# Changed Functions instructions\n');
  await writeFile(path.join(fixtureRoot, 'src', 'AGENTS.md'), '# Changed source instructions\n');
  await writeFile(path.join(fixtureRoot, 'scripts', 'AGENTS.md'), '# Changed script instructions\n');
  assert.equal(await hashFunctionsRuntimeIntegrity({ functionsRoot: fixtureRoot }), baseline);
});

test('a TypeScript runtime-source change alters the protected Functions fingerprint', async (testContext) => {
  const fixtureRoot = await createFunctionsFixture(testContext);
  const baseline = await hashFunctionsRuntimeIntegrity({ functionsRoot: fixtureRoot });

  await writeFile(path.join(fixtureRoot, 'src', 'index.ts'), 'export const runtimeValue = 2;\n');

  assert.notEqual(await hashFunctionsRuntimeIntegrity({ functionsRoot: fixtureRoot }), baseline);
});

test('Functions package, dependency, compiler, and operational inputs remain protected', async (testContext) => {
  const mutations = [
    ['package.json', '{"main":"lib/other.js"}\n'],
    ['package-lock.json', '{"lockfileVersion":3,"packages":{"changed":{}}}\n'],
    ['tsconfig.json', '{"compilerOptions":{"strict":true}}\n'],
    ['scripts/ensure-dependencies.cjs', 'module.exports = { changed: true };\n'],
  ];

  for (const [relativePath, changedSource] of mutations) {
    const fixtureRoot = await createFunctionsFixture(testContext);
    const baseline = await hashFunctionsRuntimeIntegrity({ functionsRoot: fixtureRoot });
    await writeFile(path.join(fixtureRoot, relativePath), changedSource);
    assert.notEqual(
      await hashFunctionsRuntimeIntegrity({ functionsRoot: fixtureRoot }),
      baseline,
      `${relativePath} should remain protected`,
    );
  }
});

test('generated dependencies, build output, caches, and debug files do not affect the fingerprint', async (testContext) => {
  const fixtureRoot = await createFunctionsFixture(testContext);
  const baseline = await hashFunctionsRuntimeIntegrity({ functionsRoot: fixtureRoot });

  await Promise.all([
    mkdir(path.join(fixtureRoot, 'node_modules', 'example'), { recursive: true }),
    mkdir(path.join(fixtureRoot, 'lib'), { recursive: true }),
    mkdir(path.join(fixtureRoot, 'coverage'), { recursive: true }),
    mkdir(path.join(fixtureRoot, '.firebase'), { recursive: true }),
    mkdir(path.join(fixtureRoot, 'src', '.cache'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(fixtureRoot, 'node_modules', 'example', 'index.js'), 'generated\n'),
    writeFile(path.join(fixtureRoot, 'lib', 'index.js'), 'generated\n'),
    writeFile(path.join(fixtureRoot, 'coverage', 'coverage.json'), '{}\n'),
    writeFile(path.join(fixtureRoot, '.firebase', 'cache.json'), '{}\n'),
    writeFile(path.join(fixtureRoot, 'src', '.cache', 'typescript'), 'generated\n'),
    writeFile(path.join(fixtureRoot, 'firebase-debug.log'), 'debug\n'),
    writeFile(path.join(fixtureRoot, 'src', 'runtime-debug.log'), 'debug\n'),
  ]);

  assert.equal(await hashFunctionsRuntimeIntegrity({ functionsRoot: fixtureRoot }), baseline);
});
