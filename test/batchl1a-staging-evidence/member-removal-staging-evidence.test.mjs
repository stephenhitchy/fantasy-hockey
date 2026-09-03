import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertL1aStagingSeedSafety,
  buildL1aStagingDocuments,
  L1A_STAGING_COMMISSIONER_ID,
  L1A_STAGING_FIXTURE_MARKER,
  L1A_STAGING_LEAGUE_ID,
  L1A_STAGING_PROJECT_ID,
  L1A_STAGING_SEED_ACKNOWLEDGEMENT,
  L1A_STAGING_TARGET_ID,
  L1A_STAGING_TARGET_TEAM_NAME,
} from '../../scripts/capacity/seed-l1a-member-removal-staging-fixture.mjs';
import {
  assertL1aStagingRunSafety,
  buildPublicL1aEvidence,
  L1A_STAGING_FIREBASE_OPTIONS,
  L1A_STAGING_RUN_ACKNOWLEDGEMENT,
} from '../../scripts/capacity/run-l1a-member-removal-staging-evidence.mjs';

const ROOT = new URL('../../', import.meta.url);
const read = (relativePath) => readFile(new URL(relativePath, ROOT), 'utf8');

function validEnvironment() {
  return {
    L1A_STAGING_PROJECT_ID,
    L1A_STAGING_ACK: L1A_STAGING_SEED_ACKNOWLEDGEMENT,
    L1A_STAGING_RUN_ACK: L1A_STAGING_RUN_ACKNOWLEDGEMENT,
    L1A_STAGING_FIXTURE_PASSWORD: 'L1A-Staging-Fixture-2026!',
  };
}

test('L1A tools require the exact staging project and explicit operation acknowledgements', () => {
  const environment = validEnvironment();

  assert.deepEqual(assertL1aStagingSeedSafety(environment), {
    password: environment.L1A_STAGING_FIXTURE_PASSWORD,
  });
  assert.deepEqual(assertL1aStagingRunSafety(environment), {
    password: environment.L1A_STAGING_FIXTURE_PASSWORD,
    timeoutMilliseconds: 120_000,
  });
  const { L1A_STAGING_ACK: _seedAcknowledgement, ...runOnlyEnvironment } =
    environment;
  assert.deepEqual(assertL1aStagingRunSafety(runOnlyEnvironment), {
    password: environment.L1A_STAGING_FIXTURE_PASSWORD,
    timeoutMilliseconds: 120_000,
  });
  assert.throws(
    () => assertL1aStagingSeedSafety({
      ...environment,
      L1A_STAGING_PROJECT_ID: 'not-the-approved-staging-project',
    }),
    /must equal/,
  );
  assert.throws(
    () => assertL1aStagingSeedSafety({
      ...environment,
      L1A_STAGING_ACK: 'wrong',
    }),
    /does not authorize/,
  );
  assert.throws(
    () => assertL1aStagingRunSafety({
      ...environment,
      L1A_STAGING_RUN_ACK: 'wrong',
    }),
    /does not authorize/,
  );
  assert.throws(
    () => assertL1aStagingRunSafety({
      ...environment,
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    }),
    /refuses every Emulator Suite environment/,
  );
  assert.throws(
    () => assertL1aStagingRunSafety({
      ...environment,
      L1A_STAGING_TIMEOUT_MILLISECONDS: '42',
    }),
    /30000 through 300000/,
  );
});

test('the bounded fixture contains only empty pre-Draft member-removal authority', () => {
  const fixture = buildL1aStagingDocuments(
    new Date('2026-09-03T16:00:00.000Z'),
  );
  const leaguePrefix = `leagues/${L1A_STAGING_LEAGUE_ID}`;
  const paths = [...fixture.documents.keys()];
  const league = fixture.documents.get(leaguePrefix);
  const targetTeam = fixture.documents.get(
    `${leaguePrefix}/teams/${L1A_STAGING_TARGET_ID}`,
  );
  const targetRoster = fixture.documents.get(
    `${leaguePrefix}/teams/${L1A_STAGING_TARGET_ID}/roster/current`,
  );
  const targetLifecycle = fixture.documents.get(
    `leagueLifecycleState/${L1A_STAGING_TARGET_ID}`,
  );

  assert.ok(fixture.documents.size <= 14);
  assert.equal(fixture.commissionerId, L1A_STAGING_COMMISSIONER_ID);
  assert.equal(fixture.targetId, L1A_STAGING_TARGET_ID);
  assert.ok(paths.every((path) =>
    path.startsWith(leaguePrefix) ||
    path.startsWith('users/l1a-removal-') ||
    path.startsWith('publicProfiles/l1a-removal-') ||
    path === 'leagueInvites/L1ASTG' ||
    path === `leagueLifecycleState/${L1A_STAGING_TARGET_ID}`
  ));
  assert.ok([...fixture.documents.values()].every(
    (document) => document.fixtureMarker === L1A_STAGING_FIXTURE_MARKER,
  ));
  assert.equal(paths.some((path) => path.includes('/cycles/')), false);
  assert.equal(paths.some((path) => path.includes('/picks/')), false);
  assert.equal(paths.some((path) => path.includes('/transactions/')), false);
  assert.equal(paths.some((path) => path.includes('/waivers/')), false);
  assert.equal(paths.includes(`${leaguePrefix}/draft/current`), false);
  assert.equal(league.authoritySchemaVersion, 2);
  assert.equal(league.scoringRulesVersion, 4);
  assert.equal(league.requiredGamesPerCycle, 6);
  assert.equal(league.competitionSettingsLocked, false);
  assert.equal(targetTeam.teamName, L1A_STAGING_TARGET_TEAM_NAME);
  assert.deepEqual(
    [
      targetTeam.wins,
      targetTeam.losses,
      targetTeam.ties,
      targetTeam.pointsFor,
      targetTeam.pointsAgainst,
    ],
    [0, 0, 0, 0, 0],
  );
  assert.ok([
    ...targetRoster.activeSlots,
    ...targetRoster.benchSlots,
    ...targetRoster.irSlots,
  ].every((slot) => slot.asset === null && slot.pendingMove === null));
  assert.equal(targetLifecycle.activeLeagueCount, 1);
});

test('public evidence is bounded and excludes account, request, and audit identifiers', () => {
  const publicEvidence = buildPublicL1aEvidence({
    duplicateDeliveryStable: true,
    payloadReuseRejected: true,
    auditPublished: true,
    teamCount: 1,
    joinStatus: 'open',
    inviteActive: true,
    inviteJoinCount: 1,
    activeLeagueCount: 0,
    memberExists: false,
    teamExists: false,
    rosterExists: false,
    queueExists: false,
    auditCount: 1,
    activityCount: 1,
    requestId: 'private-request-id',
    auditId: 'private-audit-id',
    targetOwnerId: L1A_STAGING_TARGET_ID,
  });
  const serialized = JSON.stringify(publicEvidence);

  assert.deepEqual(publicEvidence, {
    projectId: L1A_STAGING_PROJECT_ID,
    leagueLabel: 'l1a-member-removal-fixture',
    requestStatus: 'completed',
    duplicateDeliveryStable: true,
    payloadReuseRejected: true,
    auditPublished: true,
    teamCount: 1,
    joinStatus: 'open',
    inviteActive: true,
    inviteJoinCount: 1,
    activeLeagueCount: 0,
    removedAuthorityDocumentCount: 4,
    auditCount: 1,
    activityCount: 1,
  });
  assert.doesNotMatch(serialized, /private-|l1a-removal-member/);
});

test('the runner proves exact-once removal and deterministic audit publication without deployment', async () => {
  const [seedSource, runnerSource, stagingConfig, packageSource] =
    await Promise.all([
      read('scripts/capacity/seed-l1a-member-removal-staging-fixture.mjs'),
      read('scripts/capacity/run-l1a-member-removal-staging-evidence.mjs'),
      read('src/environments/firebase-config.staging.ts'),
      read('package.json'),
    ]);
  const scripts = JSON.parse(packageSource).scripts;

  assert.doesNotMatch(seedSource, /firebase\s+deploy/);
  assert.doesNotMatch(runnerSource, /firebase\s+deploy/);
  assert.match(seedSource, /leagueSnapshot\.data\(\)\?\.fixtureMarker/);
  assert.match(seedSource, /nestedCollections\.length > 0/);
  assert.match(seedSource, /activeLeagueCount: 1/);
  assert.match(runnerSource, /idempotentReplay, false/);
  assert.match(runnerSource, /idempotentReplay, true/);
  assert.match(runnerSource, /'already-exists'/);
  assert.match(runnerSource, /auditCount: 1/);
  assert.match(runnerSource, /activityCount: 1/);
  assert.match(runnerSource, /duplicateDeliveryStable: true/);
  assert.match(stagingConfig, new RegExp(L1A_STAGING_FIREBASE_OPTIONS.apiKey));
  assert.match(stagingConfig, new RegExp(L1A_STAGING_FIREBASE_OPTIONS.appId));
  assert.equal(
    scripts['staging:l1a:seed-member-removal'],
    'node scripts/capacity/seed-l1a-member-removal-staging-fixture.mjs',
  );
  assert.equal(
    scripts['staging:l1a:exercise-member-removal'],
    'node scripts/capacity/run-l1a-member-removal-staging-evidence.mjs',
  );
  assert.match(
    scripts['verify:batchl1a:core'],
    /test:batchl1a-staging:run/,
  );
});
