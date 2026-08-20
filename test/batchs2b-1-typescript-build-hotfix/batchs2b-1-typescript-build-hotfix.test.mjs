import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function read(relativePath) {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

const [
  draftAutomationSource,
  snapshotHashSource,
  packageSource,
  documentationSource,
  readmeSource,
  roadmapRootSource,
  roadmapDocsSource,
] = await Promise.all([
  read('functions/src/draft-automation.ts'),
  read('functions/src/shared/core/projection/projection-snapshot-hash.util.ts'),
  read('package.json'),
  read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
  read('README.md'),
  read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
  read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
]);

test('Draft verification narrows to a strict verified subtype instead of narrowing the false branch to never', () => {
  assert.match(
    draftAutomationSource,
    /type VerifiedDraftProjectionMetadata = SharedProjectionSnapshot\['metadata'\] & \{/,
  );
  assert.match(
    draftAutomationSource,
    /interface VerifiedDraftProjectionSnapshot extends SharedProjectionSnapshot \{[\s\S]*?metadata: VerifiedDraftProjectionMetadata;/,
  );
  assert.match(
    draftAutomationSource,
    /function isVerifiedDraftProjection\([\s\S]*?\): snapshot is VerifiedDraftProjectionSnapshot \{/,
  );
  assert.doesNotMatch(
    draftAutomationSource,
    /\): snapshot is SharedProjectionSnapshot \{/,
    'using the input type itself as a predicate makes TypeScript narrow the false branch to never after null checks',
  );
  assert.match(draftAutomationSource, /snapshot\.metadata\.generatedByAuthority !== 'server'/);
  assert.match(draftAutomationSource, /current\?\.metadata\.activeSnapshotId/);
});

test('projection chunk verification captures the optional manifest in a stable narrowed constant', () => {
  assert.match(
    snapshotHashSource,
    /const expectedChunkHashes = metadata\.snapshotChunkHashes;/,
  );
  assert.match(
    snapshotHashSource,
    /!Array\.isArray\(expectedChunkHashes\)/,
  );
  assert.match(
    snapshotHashSource,
    /actualHash !== expectedChunkHashes\[index\]/,
  );
  assert.doesNotMatch(
    snapshotHashSource,
    /actualHash !== metadata\.snapshotChunkHashes\[index\]/,
    'capturing the manifest prevents TypeScript from losing the undefined check inside the map callback',
  );
});

test('S2B.1 verification, documentation, and permanent roadmap remain synchronized', () => {
  const packageJson = JSON.parse(packageSource);

  assert.equal(
    packageJson.scripts['test:batchs2b-1:run'],
    'node --no-warnings --experimental-strip-types --test --test-concurrency=1 test/batchs2b-1-typescript-build-hotfix/*.test.mjs',
  );
  assert.match(packageJson.scripts['verify:batchs2b-1'], /verify:batchs2b/);
  assert.match(packageJson.scripts['verify:batchs2b-1'], /test:batchs2b-1:run/);
  assert.match(packageJson.scripts['verify:batchs2b-1'], /validate:release-manifest/);
  assert.match(documentationSource, /Batch S2B\.1 — TypeScript Projection Integrity Build Hotfix/);
  assert.match(readmeSource, /Release Candidate \d+ \/ (?:S2B\.1 hotfix|Security S3A(?:\.\d+)?|Security S3B(?:\.\d+)?|Onboarding Batch B1A|Security Batch S3C|Security Batch S3D|Security Batch S3E|Security Batch S3F|Beta Operations Batch B1B|Data Quality Batch D1A|Data Quality Batch D1B|Social Batch C1A|Social Batch C1B|Social Batch C1C|Social Batch C1D|Social Batch C1E|Social Batch C1F|Social Batch C1G|Social Batch C1H|Social Batch C1I|Social Batch C1J|Social Batch C1K|Product Batch A1A|Product Batch A1B|Product Batch A1C|Product Batch A1E|Product Batch A1F|Product Batch A1H|Product Batch A1I|Mobile Batch N1B|Scoring Batch V4A|Operations Batch O1B|Operations Batch O1C)/);
  assert.equal(roadmapRootSource, roadmapDocsSource);
  assert.match(roadmapRootSource, /Version 1\.\d+(?:\.\d+)?/);
  assert.match(roadmapRootSource, /LOG\.8 .*S2B\.1.*TypeScript/);
});
