import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertD1mStagingConnectionSafety,
  assertD1mStagingSeedSafety,
  buildD1mStagingDocuments,
  D1M_STAGING_ADMIN_ID,
  D1M_STAGING_FIXTURE_MARKER,
  D1M_STAGING_GAME_IDS,
  D1M_STAGING_LEAGUE_ID,
  D1M_STAGING_PROJECT_ID,
  D1M_STAGING_SEED_ACKNOWLEDGEMENT,
} from '../../scripts/capacity/seed-d1m-final-score-reconciliation-staging-fixture.mjs';
import {
  assertD1mStagingRunSafety,
  buildPublicD1mEvidence,
  D1M_STAGING_RUN_ACKNOWLEDGEMENT,
} from '../../scripts/capacity/run-d1m-final-score-reconciliation-staging-evidence.mjs';

const ROOT = new URL('../../', import.meta.url);
const read = (relativePath) => readFile(new URL(relativePath, ROOT), 'utf8');
const STRONG_PASSWORD = 'D1m!SyntheticFixturePassword2099';

function baseEnvironment() {
  return {
    D1M_STAGING_PROJECT_ID,
    D1M_STAGING_FIXTURE_PASSWORD: STRONG_PASSWORD,
  };
}

test('D1M staging safety permits only the exact billed project and explicit operation', () => {
  assert.deepEqual(assertD1mStagingConnectionSafety(baseEnvironment()), {
    password: STRONG_PASSWORD,
  });
  assert.deepEqual(assertD1mStagingSeedSafety({
    ...baseEnvironment(),
    D1M_STAGING_ACK: D1M_STAGING_SEED_ACKNOWLEDGEMENT,
  }), { password: STRONG_PASSWORD });
  assert.deepEqual(assertD1mStagingRunSafety({
    ...baseEnvironment(),
    D1M_STAGING_RUN_ACK: D1M_STAGING_RUN_ACKNOWLEDGEMENT,
    D1M_STAGING_TIMEOUT_MILLISECONDS: '60000',
  }), {
    password: STRONG_PASSWORD,
    timeoutMilliseconds: 60_000,
  });

  assert.throws(
    () => assertD1mStagingConnectionSafety({
      ...baseEnvironment(),
      D1M_STAGING_PROJECT_ID: 'nhl-fantasy-app-ab673',
    }),
    /must equal rinkrat-staging-d1nc-2026/,
  );
  assert.throws(
    () => assertD1mStagingConnectionSafety({
      ...baseEnvironment(),
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    }),
    /refuses every Emulator Suite environment/,
  );
  assert.throws(
    () => assertD1mStagingConnectionSafety({
      D1M_STAGING_PROJECT_ID,
      D1M_STAGING_FIXTURE_PASSWORD: 'weak',
    }),
    /20–128 characters/,
  );
  assert.throws(
    () => assertD1mStagingSeedSafety({
      ...baseEnvironment(),
      D1M_STAGING_ACK: 'wrong',
    }),
    /does not authorize/,
  );
  assert.throws(
    () => assertD1mStagingRunSafety({
      ...baseEnvironment(),
      D1M_STAGING_RUN_ACK: 'wrong',
    }),
    /does not authorize/,
  );
});

test('the bounded fixture represents verified, mismatch, missing canonical, and missing saved evidence', () => {
  const fixture = buildD1mStagingDocuments(new Date('2099-09-01T00:00:00Z'));
  const prefix = `leagues/${D1M_STAGING_LEAGUE_ID}`;
  const teamWindowPath =
    `${prefix}/cycles/cycle-1/teamWindows/${D1M_STAGING_ADMIN_ID}`;
  const teamWindows = fixture.documents.get(teamWindowPath);

  assert.equal(fixture.documents.size, 13);
  assert.equal(fixture.windowCount, 4);
  assert.deepEqual(
    teamWindows.expectedRosterSlotIds,
    ['C-1', 'LW-1', 'RW-1', 'D-1'],
  );
  assert.equal(teamWindows.windows.length, 4);
  assert.equal(
    teamWindows.windows.filter(
      (window) => Object.keys(window.gameInputCompleteness).length === 0,
    ).length,
    1,
  );

  const zeroCanonical = fixture.documents.get(
    `nhlCanonicalGameFacts/${D1M_STAGING_GAME_IDS.verifiedZero}`,
  );
  const mismatchCanonical = fixture.documents.get(
    `nhlCanonicalGameFacts/${D1M_STAGING_GAME_IDS.mismatch}`,
  );

  assert.deepEqual(zeroCanonical.facts.skaters, []);
  assert.deepEqual(zeroCanonical.facts.finalSettlements, []);
  assert.equal(mismatchCanonical.facts.skaters[0].goals, 1);
  assert.equal(mismatchCanonical.facts.finalSettlements[0].goals, 1);
  assert.equal(
    fixture.documents.has(
      `nhlCanonicalGameFacts/${D1M_STAGING_GAME_IDS.missingCanonical}`,
    ),
    false,
  );

  for (const data of fixture.documents.values()) {
    assert.equal(data.fixtureMarker, D1M_STAGING_FIXTURE_MARKER);
  }
});

test('public evidence is bounded and excludes raw staging identities', () => {
  const page = {
    authority: 'detect-only',
    writesPerformed: 0,
    scanComplete: true,
    teamDocumentCoverageChecked: true,
    summary: {
      teamDocumentCount: 1,
      windowCount: 4,
      finalizedGameCount: 4,
      verifiedGameCount: 1,
      candidateGameCount: 1,
      unverifiableGameCount: 2,
      integrityIssueCount: 0,
      findingCount: 3,
    },
    findings: [
      { code: 'stored-final-evidence-missing' },
      { code: 'score-and-appearance-mismatch' },
      { code: 'canonical-game-missing' },
    ],
  };
  const evidence = buildPublicD1mEvidence(page, {
    nonAdminRejected: true,
    repeatedDeliveryStable: true,
    latestCycleStable: true,
    competitiveStateUnchanged: true,
  });
  const serialized = JSON.stringify(evidence);

  assert.equal(evidence.nonAdminRejected, true);
  assert.equal(evidence.repeatedDeliveryStable, true);
  assert.equal(evidence.competitiveStateUnchanged, true);
  assert.doesNotMatch(serialized, /@d1m\.rinkrat\.test/i);
  assert.doesNotMatch(serialized, new RegExp(D1M_STAGING_ADMIN_ID, 'i'));
  assert.doesNotMatch(serialized, /209902000[1-4]/);
  assert.doesNotMatch(serialized, /[a-f0-9]{64}/i);
});

test('the live evidence runner authenticates both roles and fingerprints read-only state', async () => {
  const [seedSource, runSource] = await Promise.all([
    read('scripts/capacity/seed-d1m-final-score-reconciliation-staging-fixture.mjs'),
    read('scripts/capacity/run-d1m-final-score-reconciliation-staging-evidence.mjs'),
  ]);

  assert.match(seedSource, /recursiveDelete\(leagueRef\)/);
  assert.match(seedSource, /fixtureMarker/);
  assert.match(seedSource, /ownedGlobalPaths/);
  assert.doesNotMatch(seedSource, /firebase deploy/);
  assert.match(runSource, /getFinalScoreReconciliationPage/);
  assert.match(runSource, /permission-denied/);
  assert.match(runSource, /readBoundedAuthorityFingerprint/);
  assert.match(runSource, /writesPerformed/);
  assert.match(runSource, /Repeated delivery changed bounded competitive state/);
  assert.doesNotMatch(runSource, /nhl-fantasy-app-ab673/);
  assert.doesNotMatch(runSource, /firebase deploy/);
});

test('D1M inherits the staging proof and documents the exact non-production boundary', async () => {
  const [packageSource, design] = await Promise.all([
    read('package.json'),
    read('docs/RINKRAT_DATA_D1M_DETECT_ONLY_FINAL_SCORE_RECONCILIATION.md'),
  ]);
  const scripts = JSON.parse(packageSource).scripts;

  assert.match(
    scripts['staging:d1m:seed-reconciliation'],
    /seed-d1m-final-score-reconciliation-staging-fixture/,
  );
  assert.match(
    scripts['staging:d1m:exercise-reconciliation'],
    /run-d1m-final-score-reconciliation-staging-evidence/,
  );
  assert.match(scripts['verify:batchd1m:core'], /test:batchd1m-staging:run/);
  assert.match(design, /rinkrat-staging-d1nc-2026/);
  assert.match(design, /verified zero/i);
  assert.match(design, /non-admin/i);
  assert.match(design, /competitive-document fingerprint/i);
  assert.match(design, /functions:getFinalScoreReconciliationPage/);
  assert.match(design, /No Production write/i);
});
