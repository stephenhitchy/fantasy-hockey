import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertD1lReplayStagingSafety,
  buildD1lReplayStagingDocuments,
  D1L_REPLAY_STAGING_COMMISSIONER_ID,
  D1L_REPLAY_STAGING_FIXTURE_MARKER,
  D1L_REPLAY_STAGING_LEAGUE_ID,
  D1L_REPLAY_STAGING_PROJECT_ID,
  D1L_REPLAY_STAGING_SEED_ACKNOWLEDGEMENT,
  D1L_REPLAY_TRADED_ASSET,
} from '../../scripts/capacity/seed-d1l-replay-staging-fixture.mjs';
import {
  assertD1lReplayStagingRunSafety,
  D1L_REPLAY_STAGING_FIREBASE_OPTIONS,
  D1L_REPLAY_STAGING_RUN_ACKNOWLEDGEMENT,
} from '../../scripts/capacity/run-d1l-replay-staging-evidence.mjs';

const ROOT = new URL('../../', import.meta.url);
const read = (relativePath) => readFile(new URL(relativePath, ROOT), 'utf8');

function validEnvironment() {
  return {
    D1L_REPLAY_STAGING_PROJECT_ID,
    D1L_REPLAY_STAGING_ACK: D1L_REPLAY_STAGING_SEED_ACKNOWLEDGEMENT,
    D1L_REPLAY_STAGING_RUN_ACK: D1L_REPLAY_STAGING_RUN_ACKNOWLEDGEMENT,
    D1L_REPLAY_STAGING_FIXTURE_PASSWORD: 'D1L-Staging-Fixture-2026!',
  };
}

test('D1L replay staging tools require the exact project and explicit operation acknowledgements', () => {
  const environment = validEnvironment();

  assert.deepEqual(assertD1lReplayStagingSafety(environment), {
    password: environment.D1L_REPLAY_STAGING_FIXTURE_PASSWORD,
  });
  assert.deepEqual(assertD1lReplayStagingRunSafety(environment), {
    password: environment.D1L_REPLAY_STAGING_FIXTURE_PASSWORD,
    timeoutMilliseconds: 720_000,
  });
  const { D1L_REPLAY_STAGING_ACK: _seedResetAcknowledgement, ...runOnlyEnvironment } =
    environment;
  assert.deepEqual(assertD1lReplayStagingRunSafety(runOnlyEnvironment), {
    password: environment.D1L_REPLAY_STAGING_FIXTURE_PASSWORD,
    timeoutMilliseconds: 720_000,
  });
  assert.throws(
    () => assertD1lReplayStagingSafety({
      ...environment,
      D1L_REPLAY_STAGING_PROJECT_ID: 'nhl-fantasy-app-ab673',
    }),
    /must equal/,
  );
  assert.throws(
    () => assertD1lReplayStagingSafety({
      ...environment,
      D1L_REPLAY_STAGING_ACK: 'wrong',
    }),
    /does not authorize/,
  );
  assert.throws(
    () => assertD1lReplayStagingRunSafety({
      ...environment,
      D1L_REPLAY_STAGING_RUN_ACK: 'wrong',
    }),
    /does not authorize/,
  );
  assert.throws(
    () => assertD1lReplayStagingRunSafety({
      ...environment,
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    }),
    /refuses every Emulator Suite environment/,
  );
  assert.throws(
    () => assertD1lReplayStagingRunSafety({
      ...environment,
      D1L_REPLAY_STAGING_TIMEOUT_MILLISECONDS: '42',
    }),
    /60000 through 900000/,
  );
});

test('the bounded fixture creates one complete-Draft league with one traded skater window', () => {
  const commissionerId = 'synthetic-commissioner';
  const fixture = buildD1lReplayStagingDocuments(
    commissionerId,
    new Date('2026-09-02T20:00:00.000Z'),
    'd1lreplay_fixture-run-001',
  );
  const paths = [...fixture.documents.keys()];
  const league = fixture.documents.get(`leagues/${D1L_REPLAY_STAGING_LEAGUE_ID}`);
  const draft = fixture.documents.get(
    `leagues/${D1L_REPLAY_STAGING_LEAGUE_ID}/draft/current`,
  );
  const cycle = fixture.documents.get(
    `leagues/${D1L_REPLAY_STAGING_LEAGUE_ID}/cycles/cycle-1`,
  );
  const rosterPick = fixture.documents.get(
    `leagues/${D1L_REPLAY_STAGING_LEAGUE_ID}/cycles/cycle-1/rosterPicks/${commissionerId}__LW-1`,
  );

  assert.ok(fixture.documents.size <= 14);
  assert.ok(paths.every((path) =>
    path.startsWith(`leagues/${D1L_REPLAY_STAGING_LEAGUE_ID}`) ||
    path === `users/${commissionerId}` ||
    path === `publicProfiles/${commissionerId}` ||
    path === `platformAdmins/${commissionerId}`
  ));
  assert.ok([...fixture.documents.values()].every(
    (document) => document.fixtureMarker === D1L_REPLAY_STAGING_FIXTURE_MARKER,
  ));
  assert.equal(league.fixtureMarker, D1L_REPLAY_STAGING_FIXTURE_MARKER);
  assert.equal(league.scoringRulesVersion, 4);
  assert.equal(draft.status, 'complete');
  assert.deepEqual(draft.draftedAssetKeys, [D1L_REPLAY_TRADED_ASSET.assetKey]);
  assert.equal(cycle.status, 'active');
  assert.deepEqual(cycle.expectedRosterSlotIdsByOwner, {
    [commissionerId]: ['LW-1'],
  });
  assert.equal(rosterPick.asset.assetKey, D1L_REPLAY_TRADED_ASSET.assetKey);
  assert.equal(rosterPick.asset.player.id, 8_480_801);
  assert.equal(rosterPick.asset.player.nhlTeamAbbreviation, 'FLA');
  assert.equal(
    D1L_REPLAY_STAGING_COMMISSIONER_ID,
    'd1l-replay-source-team-commissioner',
  );
});

test('the evidence runner checks source-team completeness and duplicate-delivery stability', async () => {
  const [seedSource, runnerSource, stagingConfig, packageSource] = await Promise.all([
    read('scripts/capacity/seed-d1l-replay-staging-fixture.mjs'),
    read('scripts/capacity/run-d1l-replay-staging-evidence.mjs'),
    read('src/environments/firebase-config.staging.ts'),
    read('package.json'),
  ]);
  const scripts = JSON.parse(packageSource).scripts;

  assert.doesNotMatch(seedSource, /firebase\s+deploy/);
  assert.doesNotMatch(runnerSource, /firebase\s+deploy/);
  assert.doesNotMatch(seedSource, /nhl-fantasy-app-ab673/);
  assert.doesNotMatch(runnerSource, /nhl-fantasy-app-ab673/);
  assert.match(seedSource, /existingAuthUser\.uid !== D1L_REPLAY_STAGING_COMMISSIONER_ID/);
  assert.match(seedSource, /previousRequestData\?\.requestedBy !== D1L_REPLAY_STAGING_COMMISSIONER_ID/);
  assert.match(runnerSource, /sourceTeams\[0\], 'OTT'/);
  assert.match(runnerSource, /firstGameCompleteness\.complete, true/);
  assert.match(runnerSource, /firstGameCompleteness\.reusableFinal, true/);
  assert.match(runnerSource, /duplicateDeliveryStable: true/);
  assert.match(runnerSource, /requestAttemptCount, 1/);
  assert.match(runnerSource, /duplicateEvidence\.dataFingerprint, evidence\.dataFingerprint/);
  assert.match(stagingConfig, new RegExp(D1L_REPLAY_STAGING_FIREBASE_OPTIONS.apiKey));
  assert.match(stagingConfig, new RegExp(D1L_REPLAY_STAGING_FIREBASE_OPTIONS.appId));
  assert.equal(
    scripts['staging:d1l:seed-replay'],
    'node scripts/capacity/seed-d1l-replay-staging-fixture.mjs',
  );
  assert.equal(
    scripts['staging:d1l:exercise-replay'],
    'node scripts/capacity/run-d1l-replay-staging-evidence.mjs',
  );
  assert.match(
    scripts['verify:batchd1n-staging:core'],
    /test:batchd1l-staging:run/,
  );
});
