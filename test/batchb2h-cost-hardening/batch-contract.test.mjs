import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

test('the B2H gate inherits B2G and keeps only the two changed release surfaces', async () => {
  const [packageSource, implementationDoc, indexCapacityDoc] = await Promise.all([
    read('package.json').then(JSON.parse),
    read('docs/RINKRAT_OPERATIONS_B2H_COST_HARDENING.md'),
    read('docs/RINKRAT_DATA_D1A_2_LIVE_SCORING_INDEX_CAPACITY.md'),
  ]);

  assert.match(
    packageSource.scripts['verify:batchb2h:core'],
    /^npm run verify:batchb2g:core && npm run test:batchb2h:run/,
  );
  assert.match(
    packageSource.scripts['verify:batchb2h'],
    /toolchain:verify[\s\S]*verify:batchb2h:core[\s\S]*security:dependency-audit/,
  );
  assert.doesNotMatch(implementationDoc, /--only "firestore:indexes"/);
  assert.match(implementationDoc, /must not deploy `firestore:indexes`/);
  assert.match(implementationDoc, /ten protected TTL\s+fields/);
  assert.doesNotMatch(indexCapacityDoc, /firebase deploy[^\n]*firestore:indexes/);
  assert.doesNotMatch(indexCapacityDoc, /requires an index deployment/);
  assert.match(indexCapacityDoc, /exemption is already active/);
  assert.match(indexCapacityDoc, /change 30 unrelated/);
  assert.match(
    implementationDoc,
    /--only "functions:runScheduledLeagueAutomation,functions:runScheduledDraftAutomation"/,
  );
  assert.match(implementationDoc, /--only "hosting:app"/);
  assert.match(implementationDoc, /B2H does not contain scoring-skip enforcement/);
});

test('the source-controlled scoring-result exemption remains exact and isolated', async () => {
  const configuration = JSON.parse(await read('firestore.indexes.json'));
  const resultOverrides = configuration.fieldOverrides.filter((entry) =>
    entry.collectionGroup === 'liveScoring' && entry.fieldPath === 'result'
  );

  assert.equal(resultOverrides.length, 1);
  assert.deepEqual(resultOverrides[0].indexes, []);
  assert.equal(resultOverrides[0].ttl, undefined);
});

test('cost hardening preserves the protected version and cadence constants', async () => {
  const [projectionSource, leagueAutomationSource, draftAutomationSource] =
    await Promise.all([
      read('src/app/core/projection/projection-snapshot.service.ts'),
      read('functions/src/league-automation.ts'),
      read('functions/src/draft-automation.ts'),
    ]);

  assert.match(projectionSource, /SHARED_PROJECTION_VERSION = 11/);
  assert.match(projectionSource, /SNAPSHOT_READ_CACHE_MILLISECONDS = 15_000/);
  assert.match(leagueAutomationSource, /schedule: 'every 10 minutes'/);
  assert.match(draftAutomationSource, /schedule: '\* \* \* \* \*'/);
});
