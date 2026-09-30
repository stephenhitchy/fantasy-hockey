import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

test('large live-scoring results are excluded from automatic single-field indexes', async () => {
  const indexConfig = JSON.parse(await read('firestore.indexes.json'));
  const resultOverride = indexConfig.fieldOverrides.find(
    (override) =>
      override.collectionGroup === 'liveScoring' &&
      override.fieldPath === 'result',
  );

  assert.deepEqual(
    resultOverride,
    {
      collectionGroup: 'liveScoring',
      fieldPath: 'result',
      indexes: [],
    },
    'The bounded liveScoring/cycle-* result map must not generate one index entry per nested score field.',
  );
});

test('live-scoring snapshots remain direct-document reads and never query result fields', async () => {
  const [browserService, serverAutomation] = await Promise.all([
    read('src/app/core/live-scoring/live-scoring.service.ts'),
    read('functions/src/league-automation.ts'),
  ]);

  assert.match(browserService, /doc\(db, 'leagues', leagueId, 'liveScoring', `cycle-\$\{cycleNumber\}`\)/);
  assert.match(serverAutomation, /db\.doc\(`leagues\/\$\{leagueId\}\/liveScoring\/cycle-\$\{cycleNumber\}`\)/);
  assert.doesNotMatch(browserService, /where\([^\n]*result\./);
  assert.doesNotMatch(serverAutomation, /where\([^\n]*result\./);
});
