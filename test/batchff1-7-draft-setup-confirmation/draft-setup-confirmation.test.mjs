import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  draftSettingsMatchExpectation,
} from '../../src/app/features/draft/draft-setup/draft-settings-confirmation.util.ts';

test('Draft Setup confirms a committed Firestore Timestamp with its receiver intact', () => {
  const scheduledStartAtMilliseconds = Date.parse('2026-09-20T19:00:00.000Z');
  const expectation = {
    submissionId: 'settings_firestore_timestamp',
    roundOneOrder: ['manager-a', 'manager-b'],
    scheduledStartAtMilliseconds,
    pickSeconds: 60,
    status: 'scheduled',
  };
  const firestoreTimestamp = {
    toMillis() {
      return scheduledStartAtMilliseconds;
    },
    toDate() {
      return new Date(this.toMillis());
    },
  };

  assert.equal(
    draftSettingsMatchExpectation(
      {
        status: 'scheduled',
        roundOneOrder: ['manager-a', 'manager-b'],
        scheduledStartAt: firestoreTimestamp,
        pickSeconds: 60,
        nextOverallPick: 1,
        draftedAssetKeys: [],
        lastSettingsSubmissionId: 'settings_firestore_timestamp',
      },
      expectation,
    ),
    true,
  );
});

test('the FF1.23 repair stays client-only and remains in the inherited release gate', async () => {
  const [utility, packageJson] = await Promise.all([
    readFile(
      new URL(
        '../../src/app/features/draft/draft-setup/draft-settings-confirmation.util.ts',
        import.meta.url,
      ),
      'utf8',
    ),
    readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  ]);

  assert.match(utility, /\.call\(value\)/);
  assert.doesNotMatch(utility, /\(toDate as \(\) => Date\)\(\)/);
  assert.match(packageJson, /"test:batchff1-7:run"/);
  assert.match(packageJson, /"verify:batchff1-7:core"[\s\S]*verify:batchff1-6:core/);
});
