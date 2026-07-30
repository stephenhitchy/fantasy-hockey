import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

async function exists(relativePath) {
  try {
    await access(path.join(root, relativePath), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

test('project root contains no loose update text files or batch checklist files', async () => {
  const entries = await readdir(root, { withFileTypes: true });
  const looseFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter(
      (name) =>
        name.endsWith('.txt') ||
        /^BATCH_.*_MANUAL_TEST_CHECKLIST\.md$/i.test(name),
    );

  assert.deepEqual(looseFiles, []);
});

test('combined documentation and root README are present', async () => {
  assert.equal(await exists('docs/RINKRAT_PROJECT_DOCUMENTATION.md'), true);
  assert.equal(await exists('README.md'), true);

  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /docs\/RINKRAT_PROJECT_DOCUMENTATION\.md/);
});

test('documentation consolidation command remains available', async () => {
  assert.equal(await exists('scripts/consolidate-project-docs.mjs'), true);

  const packageJson = JSON.parse(
    await readFile(path.join(root, 'package.json'), 'utf8'),
  );
  assert.equal(
    packageJson.scripts?.['docs:consolidate'],
    'node scripts/consolidate-project-docs.mjs',
  );
});
