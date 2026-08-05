import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  GENERATED_RELEASE_IGNORE_ENTRIES,
  ensureReleaseManifestGitignore,
} from '../../scripts/release-manifest-gitignore.mjs';

const PROJECT_ROOT = new URL('../../', import.meta.url);

async function readProject(relativePath) {
  return readFile(new URL(relativePath, PROJECT_ROOT), 'utf8');
}

function directoryUrl(path) {
  return pathToFileURL(path.endsWith(sep) ? path : `${path}${sep}`);
}

test('release-manifest generator repairs an older visible project copy that kept the old .gitignore', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'rinkrat-release-ignore-'));

  try {
    const original = '# Existing project rules\n/dist\n/node_modules\n';
    await writeFile(join(temporaryRoot, '.gitignore'), original, 'utf8');

    const firstResult = await ensureReleaseManifestGitignore(directoryUrl(temporaryRoot));
    const repaired = await readFile(join(temporaryRoot, '.gitignore'), 'utf8');

    assert.equal(firstResult.changed, true);
    assert.deepEqual(firstResult.addedEntries, [...GENERATED_RELEASE_IGNORE_ENTRIES]);
    assert.ok(repaired.startsWith(original));
    assert.match(repaired, /# Generated deployment fingerprints/);

    for (const entry of GENERATED_RELEASE_IGNORE_ENTRIES) {
      assert.equal(repaired.split(entry).length - 1, 1, `${entry} should be present exactly once`);
    }

    const secondResult = await ensureReleaseManifestGitignore(directoryUrl(temporaryRoot));
    const secondPass = await readFile(join(temporaryRoot, '.gitignore'), 'utf8');

    assert.equal(secondResult.changed, false);
    assert.deepEqual(secondResult.addedEntries, []);
    assert.equal(secondPass, repaired);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('release-manifest generator can recreate a missing hidden .gitignore file', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'rinkrat-release-ignore-missing-'));

  try {
    const result = await ensureReleaseManifestGitignore(directoryUrl(temporaryRoot));
    const source = await readFile(join(temporaryRoot, '.gitignore'), 'utf8');

    assert.equal(result.changed, true);
    assert.match(source, /^# Generated deployment fingerprints/m);

    for (const entry of GENERATED_RELEASE_IGNORE_ENTRIES) {
      assert.match(source, new RegExp(entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('the normal manifest command runs the ignore repair before calculating the Git fingerprint', async () => {
  const generator = await readProject('scripts/generate-release-manifest.mjs');
  const repairIndex = generator.indexOf('await ensureReleaseManifestGitignore(ROOT)');
  const revisionIndex = generator.indexOf('const sourceRevision = await resolveSourceRevision()');

  assert.ok(repairIndex >= 0, 'generator must invoke the .gitignore repair');
  assert.ok(revisionIndex > repairIndex, 'repair must run before the source revision is calculated');
  assert.match(generator, /Restored generated release-manifest ignore rules/);
});

test('R1A.1 verification keeps the original release-safety suite and adds the self-healing regression suite', async () => {
  const [packageSource, documentation] = await Promise.all([
    readProject('package.json'),
    readProject('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.match(packageJson.scripts['test:batchr1a-1:run'], /batchr1a-1-release-manifest-gitignore/);
  assert.match(packageJson.scripts['verify:batchr1a-1'], /verify:batchr1a/);
  assert.match(packageJson.scripts['verify:batchr1a-1'], /test:batchr1a-1:run/);
  assert.match(documentation, /^## Batch R1A\.1 — Release Manifest Ignore Hotfix/m);
  assert.match(documentation, /macOS Finder/i);
  assert.match(documentation, /manual project replacement/i);
  assert.match(documentation, /self-healing/i);
});
