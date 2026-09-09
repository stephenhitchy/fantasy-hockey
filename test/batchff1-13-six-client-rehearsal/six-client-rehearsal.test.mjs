import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertExistingFf1SixClientFixtureSafety,
  assertFf1SixClientStagingSafety,
  buildPublicFf1SixClientEvidence,
  FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
  FF1_SIX_CLIENT_FIXTURE_TYPE,
  FF1_SIX_CLIENT_MANAGER_COUNT,
  FF1_SIX_CLIENT_STAGING_ACKNOWLEDGEMENT,
  FF1_SIX_CLIENT_TOTAL_PICKS,
} from '../../scripts/capacity/run-ff1-six-client-draft-rehearsal.mjs';

const ROOT = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), 'utf8');
const STAGING_PROJECT_ID = 'rinkrat-staging-d1nc-2026';
const RELEASE_REVISION = 'a'.repeat(40);

function validEnvironment(overrides = {}) {
  return {
    FF1_SIX_CLIENT_STAGING_PROJECT_ID: STAGING_PROJECT_ID,
    FF1_SIX_CLIENT_STAGING_ACK: FF1_SIX_CLIENT_STAGING_ACKNOWLEDGEMENT,
    FF1_SIX_CLIENT_DEPLOYED_RELEASE_REVISION: RELEASE_REVISION,
    ...overrides,
  };
}

test('the six-client runner is hard-locked to the isolated billed staging project', () => {
  const safety = assertFf1SixClientStagingSafety(validEnvironment());

  assert.equal(safety.deployedReleaseRevision, RELEASE_REVISION);
  assert.equal(safety.readinessTimeoutMilliseconds, 900_000);
  assert.throws(
    () => assertFf1SixClientStagingSafety(validEnvironment({
      FF1_SIX_CLIENT_STAGING_PROJECT_ID: 'nhl-fantasy-app-ab673',
    })),
    /must equal rinkrat-staging-d1nc-2026/,
  );
  assert.throws(
    () => assertFf1SixClientStagingSafety(validEnvironment({
      FF1_SIX_CLIENT_STAGING_ACK: 'yes',
    })),
    /does not authorize/,
  );
  assert.throws(
    () => assertFf1SixClientStagingSafety(validEnvironment({
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    })),
    /refuses every Emulator Suite environment/,
  );
  assert.throws(
    () => assertFf1SixClientStagingSafety(validEnvironment({
      FF1_SIX_CLIENT_DEPLOYED_RELEASE_REVISION: 'main',
    })),
    /full Git revision/,
  );
});

test('fixture replacement is allowed only for the exact bounded synthetic identity', () => {
  assert.doesNotThrow(() => assertExistingFf1SixClientFixtureSafety({
    exists: false,
    data: undefined,
    pickCount: 0,
  }));
  assert.doesNotThrow(() => assertExistingFf1SixClientFixtureSafety({
    exists: true,
    data: {
      fixtureType: FF1_SIX_CLIENT_FIXTURE_TYPE,
      id: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      name: 'FF1 Six-Client Draft Rehearsal',
      maxTeams: FF1_SIX_CLIENT_MANAGER_COUNT,
      teamCount: FF1_SIX_CLIENT_MANAGER_COUNT,
    },
    pickCount: FF1_SIX_CLIENT_TOTAL_PICKS,
  }));
  assert.throws(() => assertExistingFf1SixClientFixtureSafety({
    exists: true,
    data: {
      fixtureType: 'family-league',
      id: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      name: 'FF1 Six-Client Draft Rehearsal',
      maxTeams: FF1_SIX_CLIENT_MANAGER_COUNT,
      teamCount: FF1_SIX_CLIENT_MANAGER_COUNT,
    },
    pickCount: 0,
  }));
  assert.throws(() => assertExistingFf1SixClientFixtureSafety({
    exists: true,
    data: {
      fixtureType: FF1_SIX_CLIENT_FIXTURE_TYPE,
      id: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      name: 'FF1 Six-Client Draft Rehearsal',
      maxTeams: FF1_SIX_CLIENT_MANAGER_COUNT,
      teamCount: FF1_SIX_CLIENT_MANAGER_COUNT,
    },
    pickCount: FF1_SIX_CLIENT_TOTAL_PICKS + 1,
  }), /more Draft picks/);
});

test('public rehearsal evidence is aggregate and contains no account or player identity', () => {
  const evidence = buildPublicFf1SixClientEvidence({
    deployedReleaseRevision: RELEASE_REVISION,
    toolingRevision: 'b'.repeat(40),
    authenticatedClientCount: 6,
    independentListenerCount: 6,
    projectionVersion: 11,
    scoringRulesVersion: 4,
    serverSnapshotVerified: true,
    duplicateSubmissionStable: true,
    staleSubmissionRejected: true,
    queueTimeoutPickCount: 1,
    emptyQueueAutoPickCount: 1,
    pausePreservedPickCount: true,
    reconnectConverged: true,
    snakeBoundaryVerified: true,
    completedPickCount: 102,
    uniqueAssetCount: 102,
    completedRosterCount: 6,
    postDraftRemovalRejected: true,
    exactOnceOutcome: true,
    fixtureAccountsDisabled: true,
    password: 'must-not-leak',
    managerEmail: 'must-not-leak@example.com',
    assetKey: 'must-not-leak',
  });
  const serialized = JSON.stringify(evidence);

  assert.equal(evidence.authenticatedClientCount, 6);
  assert.equal(evidence.completedPickCount, 102);
  assert.equal(evidence.uniqueAssetCount, 102);
  assert.equal(evidence.fixtureRetainedForAudit, true);
  assert.doesNotMatch(serialized, /must-not-leak|@|assetKey|password|managerEmail/);
});

test('the rehearsal uses six authenticated clients and ordinary Draft authorities', async () => {
  const source = await read('scripts/capacity/run-ff1-six-client-draft-rehearsal.mjs');

  assert.match(source, /signInWithEmailAndPassword/);
  assert.match(source, /makeSecureDraftPick/);
  assert.match(source, /executeDraftCommand/);
  assert.match(source, /removeLeagueMemberSecure/);
  assert.match(source, /setDoc\([\s\S]*queues/);
  assert.match(source, /disableNetwork/);
  assert.match(source, /enableNetwork/);
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /timer-expired/);
  assert.match(source, /manager-auto-mode/);
  assert.match(source, /status, 'complete'/);
  assert.doesNotMatch(source, /firebase deploy|nhl-fantasy-app-ab673/);
});

test('FF1.29 documents the acceptance boundary without weakening physical UI evidence', async () => {
  const [runbook, handoff, packageSource] = await Promise.all([
    read('docs/RINKRAT_FF1_DRAFT_GATE_RUNBOOK.md'),
    read('docs/RINKRAT_CODEX_HANDOFF.md'),
    read('package.json'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.match(runbook, /guarded six-client staging rehearsal/i);
  assert.match(runbook, /Admin SDK is limited to fixture provisioning/i);
  assert.match(runbook, /does not replace physical-device/i);
  assert.match(runbook, /two-manager supported-UI rehearsal/i);
  assert.match(handoff, /FF1\.29/);
  assert.equal(
    packageJson.scripts['staging:ff1:exercise-six-client'],
    'node scripts/capacity/run-ff1-six-client-draft-rehearsal.mjs',
  );
  assert.equal(
    packageJson.scripts['verify:batchff1-13:core'],
    'npm run verify:batchff1-12:core && npm run test:batchff1-13:run && npm run validate:release-manifest',
  );
});

test('the harness changes no protected runtime, Rules, indexes, TTL, or rollout mode', async () => {
  const source = await read('scripts/capacity/run-ff1-six-client-draft-rehearsal.mjs');

  assert.match(source, /projectionVersion, 11/);
  assert.match(source, /scoringRulesVersion, 4/);
  assert.doesNotMatch(source, /scoringRules\s*=|requiredGamesPerCycle\s*=|queue.*maxConcurrent/i);
  assert.doesNotMatch(
    source,
    /firestore\.rules|firestore\.indexes|ttlPolicies|app.?check.*enforce/i,
  );
});
