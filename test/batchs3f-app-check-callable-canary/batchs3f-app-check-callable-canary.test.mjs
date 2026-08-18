import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  APP_CHECK_CALLABLE_CANARY_MAXIMUM_LEAGUES,
  APP_CHECK_CALLABLE_CANARY_OPTIONS,
  DEFAULT_APP_CHECK_CALLABLE_CANARY_CONTROL,
  buildAppCheckCallableCanaryDecision,
  normalizeAppCheckCallableCanaryControl,
  normalizeAppCheckCallableCanaryLeagueIds,
} from '../../functions/src/shared/security/app-check-callable-canary.util.ts';

const ROOT = new URL('../../', import.meta.url);
async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function canaryControl(overrides = {}) {
  return {
    ...DEFAULT_APP_CHECK_CALLABLE_CANARY_CONTROL,
    mode: 'canary',
    revision: 4,
    approvedBuildId: 'release-candidate-26-test-build',
    approvedAppId: '1:721213878690:web:1c5ba29562b332f84e02fb',
    selectedCallables: ['requestProjectionSnapshotGeneration'],
    canaryLeagueIds: ['league-test-123'],
    reason: 'Test one recoverable callable first.',
    ...overrides,
  };
}

test('the default selected-callable control never enforces automatically', () => {
  const decision = buildAppCheckCallableCanaryDecision(
    DEFAULT_APP_CHECK_CALLABLE_CANARY_CONTROL,
    {
      callableName: 'requestProjectionSnapshotGeneration',
      leagueId: 'league-test-123',
      appId: null,
    },
  );

  assert.equal(DEFAULT_APP_CHECK_CALLABLE_CANARY_CONTROL.mode, 'monitor');
  assert.equal(DEFAULT_APP_CHECK_CALLABLE_CANARY_CONTROL.automaticPromotion, false);
  assert.equal(decision.selectedForCanary, false);
  assert.equal(decision.shouldReject, false);
});

test('canary enforcement requires both the exact callable and exact league', () => {
  const valid = buildAppCheckCallableCanaryDecision(canaryControl(), {
    callableName: 'requestProjectionSnapshotGeneration',
    leagueId: 'league-test-123',
    appId: '1:721213878690:web:1c5ba29562b332f84e02fb',
  });
  const differentLeague = buildAppCheckCallableCanaryDecision(canaryControl(), {
    callableName: 'requestProjectionSnapshotGeneration',
    leagueId: 'friend-league-456',
    appId: null,
  });
  const differentCallable = buildAppCheckCallableCanaryDecision(canaryControl(), {
    callableName: 'makeSecureDraftPick',
    leagueId: 'league-test-123',
    appId: null,
  });

  assert.equal(valid.selectedForCanary, true);
  assert.equal(valid.shouldReject, false);
  assert.equal(differentLeague.selectedForCanary, false);
  assert.equal(differentLeague.shouldReject, false);
  assert.equal(differentCallable.selectedForCanary, false);
  assert.equal(differentCallable.shouldReject, false);
});

test('a selected canary request rejects missing or mismatched App Check context', () => {
  const missing = buildAppCheckCallableCanaryDecision(canaryControl(), {
    callableName: 'requestProjectionSnapshotGeneration',
    leagueId: 'league-test-123',
  });
  const mismatched = buildAppCheckCallableCanaryDecision(canaryControl(), {
    callableName: 'requestProjectionSnapshotGeneration',
    leagueId: 'league-test-123',
    appId: 'different-app',
  });

  assert.equal(missing.requestStatus, 'missing');
  assert.equal(missing.shouldReject, true);
  assert.equal(mismatched.requestStatus, 'missing');
  assert.equal(mismatched.shouldReject, true);
});

test('persisted canary data is normalized and bounded to five safe leagues', () => {
  const ids = normalizeAppCheckCallableCanaryLeagueIds([
    'league-five',
    'league-one',
    '../unsafe',
    'league-two',
    'league-three',
    'league-four',
    'league-six',
    'league-one',
  ]);
  const control = normalizeAppCheckCallableCanaryControl({
    mode: 'canary',
    revision: 3.9,
    selectedCallables: [
      'makeSecureDraftPick',
      'not-a-callable',
      'makeSecureDraftPick',
    ],
    canaryLeagueIds: ids,
    automaticPromotion: true,
  });

  assert.equal(ids.length, APP_CHECK_CALLABLE_CANARY_MAXIMUM_LEAGUES);
  assert.equal(ids.includes('../unsafe'), false);
  assert.deepEqual(control.selectedCallables, ['makeSecureDraftPick']);
  assert.equal(control.revision, 3);
  assert.equal(control.automaticPromotion, false);
});

test('all five approved callables use the shared exact-league guard before authority work', async () => {
  const expectations = new Map([
    ['functions/src/projection-authority.ts', 'requestProjectionSnapshotGeneration'],
    ['functions/src/league-automation.ts', 'advanceHistoricalReplayDay'],
    ['functions/src/draft-authority.ts', 'makeSecureDraftPick'],
    ['functions/src/roster-moves.ts', 'applyImmediateRosterMove'],
    ['functions/src/roster-authority.ts', 'executeSecureRosterAction'],
  ]);

  assert.equal(APP_CHECK_CALLABLE_CANARY_OPTIONS.length, 5);
  for (const [relativePath, callableName] of expectations) {
    const source = await read(relativePath);
    assert.match(
      source,
      new RegExp(`enforceAppCheckCallableCanaryForLeague\\([\\s\\S]{0,220}'${callableName}'`),
    );
  }
});

test('server activation is evidence-gated, recently authenticated, audited, and reversible without App Check', async () => {
  const source = await read('functions/src/app-check-canary-authority.ts');

  assert.match(source, /requireVerifiedRecentAuthentication/);
  assert.match(source, /readiness\.canaryEligible/);
  assert.match(source, /request\.app\?\.appId/);
  assert.match(source, /app-check-callable-canary-started/);
  assert.match(source, /app-check-callable-canary-returned-to-monitor/);
  assert.match(source, /appData\/leagueAutomationQueueConfig/);
  assert.match(source, /Internal Test in the Scoring Queue Control Center/);
  assert.match(source, /let approvedBuildId: string \| null = null/);
  assert.match(source, /let approvedAppId: string \| null = null/);
  assert.match(source, /mode === 'canary'/);
  assert.doesNotMatch(source, /enforceAppCheck\s*:\s*true/);
});

test('Admin Center exposes deliberate exact-league activation, proof, and monitor rollback', async () => {
  const [template, component, service] = await Promise.all([
    read('src/app/features/admin/admin-center/admin-center.html'),
    read('src/app/features/admin/admin-center/admin-center.ts'),
    read('src/app/core/admin/platform-admin.service.ts'),
  ]);

  assert.match(template, /Exact-league App Check canary/);
  assert.match(template, /Start Selected Canary/);
  assert.match(template, /Return Everything to Monitor/);
  assert.match(template, /Emergency rollback does not depend on App Check/);
  assert.match(template, /Only leagues already marked Internal/);
  assert.match(template, /league\.isInternalTest/);
  assert.match(component, /canStartAppCheckCanary/);
  assert.match(component, /startAppCheckCanary/);
  assert.match(component, /returnAppCheckCanaryToMonitor/);
  assert.match(service, /getAppCheckCallableCanaryControl/);
  assert.match(service, /updateAppCheckCallableCanaryControl/);
});

test('source-controlled policy stays monitor-first and corrects the real callable names', async () => {
  const [canaryConfig, readinessConfig] = await Promise.all([
    read('config/app-check-callable-canary.json').then(JSON.parse),
    read('config/app-check-enforcement-readiness.json').then(JSON.parse),
  ]);

  assert.equal(canaryConfig.defaultMode, 'monitor');
  assert.equal(canaryConfig.automaticPromotion, false);
  assert.equal(canaryConfig.emergencyMonitorRollbackRequiresAppCheck, false);
  assert.equal(canaryConfig.maximumCanaryLeagues, 5);
  assert.equal(canaryConfig.leagueEligibility, 'internal-test-only');
  assert.deepEqual(
    readinessConfig.firstEnforcementScope,
    canaryConfig.candidateCallables.map((item) => item.name),
  );
  assert.equal(readinessConfig.firstEnforcementScope.includes('secureDraftPick'), false);
  assert.equal(readinessConfig.firstEnforcementScope.includes('makeSecureDraftPick'), true);
});

test('S3F remains intact under RC34 without changing Scoring V3 or Projection V11', async () => {
  const [
    runtime,
    productionRuntime,
    scoringRules,
    projectionSnapshot,
    roadmap,
    runbook,
    packageJson,
  ] = await Promise.all([
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/projection/projection-snapshot.service.ts'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_SECURITY_S3F_APP_CHECK_CALLABLE_CANARY.md'),
    read('package.json').then(JSON.parse),
  ]);

  assert.match(runtime, /Release Candidate 40/);
  assert.match(productionRuntime, /Release Candidate 40/);
  assert.match(scoringRules, /CURRENT_SCORING_RULES_VERSION\s*=\s*3/);
  assert.match(projectionSnapshot, /SHARED_PROJECTION_VERSION\s*=\s*11/);
  assert.match(roadmap, /S3\.23/);
  assert.match(roadmap, /Security Batch S3F/);
  assert.match(runbook, /exact set of callable Functions/i);
  assert.match(runbook, /exact set of league IDs/i);
  assert.match(packageJson.scripts['verify:batchs3f:core'], /verify:batch(?:s3e-1-1|s3f|d1a|d1a-1):core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batch(?:s3f|d1a|d1a-1|d1b|d1c|c1a|c1b|c1c|c1d|c1e|c1f|c1g|c1h|c1i|c1j|c1k|c1l|c1m|a1a|a1b):core/);
});
