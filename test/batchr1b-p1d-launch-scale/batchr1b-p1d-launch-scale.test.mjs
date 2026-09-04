import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { hashFunctionsRuntimeIntegrity } from '../shared/functions-runtime-integrity.mjs';
import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import { fileURLToPath } from 'node:url';

import { buildCapacityReport } from '../../scripts/capacity/rinkrat-capacity-model.mjs';
import {
  buildInviteBetaValidationGroups,
  calculateInviteBetaLaunchGate,
  createInviteBetaValidationReport,
  createInviteBetaValidationSession,
  INVITE_BETA_VALIDATION_DEFINITIONS,
  INVITE_BETA_VALIDATION_GROUPS,
  normalizeInviteBetaValidationSession,
  updateInviteBetaValidationItem,
} from '../../src/app/core/release/invite-beta-validation.util.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');

async function read(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

function simulation(passed = true) {
  return {
    passed,
    passedCount: passed ? 2 : 1,
    totalCount: 2,
    checks: [
      { id: 'one', stage: 'league', label: 'First', expected: 'yes', actual: 'yes', passed: true },
      { id: 'two', stage: 'playoffs', label: 'Second', expected: 'yes', actual: passed ? 'yes' : 'no', passed },
    ],
    milestones: [],
    simulatedTeamCount: 4,
    simulatedRegularSeasonCycleCount: 11,
    simulatedRosterSlotsPerTeam: 14,
    simulatedGamesPerWindow: 6,
  };
}

function passEveryRequiredItem(session) {
  let current = session;
  for (const definition of INVITE_BETA_VALIDATION_DEFINITIONS) {
    if (definition.required) {
      current = updateInviteBetaValidationItem(current, definition.id, { status: 'pass' });
    }
  }
  return current;
}

const automatedPass = {
  id: 'safe-production',
  category: 'configuration',
  label: 'Safe production configuration',
  detail: 'Production settings are safe.',
  level: 'pass',
  requiredForLiveLaunch: true,
};

const cleanReleaseManifest = {
  schemaVersion: 1,
  releaseLabel: 'Release Candidate 6',
  buildId: 'build-a',
  builtAt: '2026-08-05T12:00:00.000Z',
  sourceRevision: 'abcdef1234567890abcdef1234567890abcdef12',
  packageVersion: '0.0.0',
  scoringRulesVersion: 3,
  projectionVersion: 11,
};

test('invite-beta board covers the fresh-league launch workflow and preserves the scale boundary', () => {
  assert.equal(INVITE_BETA_VALIDATION_GROUPS.length, 6);
  assert.ok(INVITE_BETA_VALIDATION_DEFINITIONS.length >= 25);
  assert.equal(
    new Set(INVITE_BETA_VALIDATION_DEFINITIONS.map((definition) => definition.id)).size,
    INVITE_BETA_VALIDATION_DEFINITIONS.length,
  );

  const requiredIds = new Set(
    INVITE_BETA_VALIDATION_DEFINITIONS
      .filter((definition) => definition.required)
      .map((definition) => definition.id),
  );

  for (const id of [
    'complete-mobile-draft',
    'independent-window-rollover',
    'scheduled-add-drop',
    'goalie-unit-roundtrip',
    'overlay-viewport',
    'app-check-monitoring',
    'injury-email-flow',
    'deletion-safety',
    'fresh-league-lifecycle',
  ]) {
    assert.ok(requiredIds.has(id), `${id} should be required`);
  }

  assert.ok(
    INVITE_BETA_VALIDATION_DEFINITIONS.some(
      (definition) => definition.id === 'capacity-boundary-recorded' && !definition.required,
    ),
  );
});

test('manual validation is isolated to the exact generated build rather than a reusable release label', () => {
  const first = createInviteBetaValidationSession(
    'release-candidate-6-build-a',
    'Release Candidate 6',
    '2026-08-05T12:00:00.000Z',
  );
  const changed = updateInviteBetaValidationItem(first, 'goalie-unit-roundtrip', {
    status: 'attention',
    note: '  Safari\u0000 remained fuzzy after close.  ',
  }, '2026-08-05T12:01:00.000Z');

  const restored = normalizeInviteBetaValidationSession(
    changed,
    'release-candidate-6-build-a',
    'Release Candidate 6',
    '2026-08-05T12:02:00.000Z',
  );
  assert.equal(restored.items['goalie-unit-roundtrip'].status, 'attention');
  assert.equal(restored.items['goalie-unit-roundtrip'].note, 'Safari remained fuzzy after close.');

  const nextBuild = normalizeInviteBetaValidationSession(
    restored,
    'release-candidate-6-build-b',
    'Release Candidate 6',
  );
  assert.equal(nextBuild.releaseKey, 'release-candidate-6-build-b');
  assert.equal(nextBuild.items['goalie-unit-roundtrip'].status, 'untested');
});

test('launch gate combines automated checks, simulation, manual workflows, connection, active actions, and build freshness', () => {
  const emptySession = createInviteBetaValidationSession('build-a', 'Release Candidate 6');
  const testingGate = calculateInviteBetaLaunchGate({
    automatedChecks: [automatedPass],
    simulation: null,
    releaseManifest: cleanReleaseManifest,
    manualSession: emptySession,
    connectionOnline: true,
    activeActionCount: 0,
    actionErrorCount: 0,
    actionUncertainCount: 0,
    releaseUpdateAvailable: false,
    releaseCheckStatus: 'current',
  });

  assert.equal(testingGate.status, 'testing');
  assert.ok(testingGate.manualUntestedCount > 0);
  assert.match(testingGate.blockers.join(' '), /full-season simulator/i);

  const readyGate = calculateInviteBetaLaunchGate({
    automatedChecks: [automatedPass],
    simulation: simulation(true),
    releaseManifest: cleanReleaseManifest,
    manualSession: passEveryRequiredItem(emptySession),
    connectionOnline: true,
    activeActionCount: 0,
    actionErrorCount: 0,
    actionUncertainCount: 0,
    releaseUpdateAvailable: false,
    releaseCheckStatus: 'current',
  });

  assert.equal(readyGate.status, 'ready');
  assert.equal(readyGate.blockers.length, 0);

  const staleGate = calculateInviteBetaLaunchGate({
    automatedChecks: [automatedPass],
    simulation: simulation(true),
    releaseManifest: cleanReleaseManifest,
    manualSession: passEveryRequiredItem(emptySession),
    connectionOnline: true,
    activeActionCount: 0,
    actionErrorCount: 0,
    actionUncertainCount: 0,
    releaseUpdateAvailable: true,
    releaseCheckStatus: 'update-available',
  });

  assert.equal(staleGate.status, 'blocked');
  assert.match(staleGate.blockers.join(' '), /currently deployed build/i);
});

test('validation reports retain manual evidence and build identity without automatic fantasy identifiers', () => {
  let session = passEveryRequiredItem(
    createInviteBetaValidationSession('build-a', 'Release Candidate 6'),
  );
  session = updateInviteBetaValidationItem(session, 'goalie-unit-roundtrip', {
    note: 'Passed on iPhone after build-a.',
  });
  const gate = calculateInviteBetaLaunchGate({
    automatedChecks: [automatedPass],
    simulation: simulation(true),
    releaseManifest: cleanReleaseManifest,
    manualSession: session,
    connectionOnline: true,
    activeActionCount: 0,
    actionErrorCount: 0,
    actionUncertainCount: 0,
    releaseUpdateAvailable: false,
    releaseCheckStatus: 'current',
  });
  const report = createInviteBetaValidationReport({
    releaseLabel: 'Release Candidate 6',
    generatedAt: '2026-08-05T12:02:00.000Z',
    session,
    gate,
    automatedChecks: [automatedPass],
    simulation: simulation(true),
    clientPerformance: null,
    competitiveActions: null,
    releaseManifest: cleanReleaseManifest,
    viewport: '390x844 @ 3x',
    browser: 'Mobile Safari',
  });
  const serialized = JSON.stringify(report);

  assert.doesNotMatch(serialized, /leagueId|playerId|matchupId|emailAddress/);
  assert.match(serialized, /Passed on iPhone/);
  assert.match(serialized, /build-a/);
  assert.equal(report.privacy.manualNotesIncluded, true);
});

test('Release Readiness mounts the build-specific launch board and exposes App Check readiness', async () => {
  const [source, template, readinessService, models, styles, store] = await Promise.all([
    read('src/app/features/release/release-readiness/release-readiness.ts'),
    read('src/app/features/release/release-readiness/release-readiness.html'),
    read('src/app/core/release/release-readiness.service.ts'),
    read('src/app/core/release/release-readiness.models.ts'),
    read('src/app/features/release/invite-beta-validation/invite-beta-validation.css'),
    read('src/app/core/release/invite-beta-validation.store.ts'),
  ]);

  assert.match(source, /InviteBetaValidation/);
  assert.match(source, /validationReleaseKey/);
  assert.match(template, /<app-invite-beta-validation/);
  assert.match(template, /releaseUpdateAvailable/);
  assert.match(template, /current\.security\.appCheckClientStatus|App Check client/);
  assert.match(readinessService, /app-check-client/);
  assert.match(models, /appCheckClientEnabled: boolean/);
  assert.match(styles, /invite-beta-gate--ready/);
  assert.match(styles, /invite-beta-scale-note/);
  assert.match(store, /rinkrat:invite-beta-validation/);
  assert.match(store, /encodeURIComponent\(releaseKey\)/);
  assert.doesNotMatch(store, /firebase\/firestore|getDoc|setDoc|updateDoc/);
});

test('capacity model recognizes exact draft tasks and identifies league scoring as the primary red automation risk', async () => {
  const report = await buildCapacityReport({
    users: 100_000,
    managersPerLeague: 10,
    scenario: 'balanced',
    format: 'json',
  });

  assert.equal(report.architecture.draftDeadlineTaskQueuePresent, true);
  assert.equal(report.architecture.draftDeadlineTaskDeterministicIds, true);
  assert.equal(report.architecture.draftDeadlineTaskMaxConcurrentDispatches, 10);
  assert.equal(report.architecture.draftAutomationScanLimit, 250);
  assert.equal(report.architecture.leagueAutomationParallelism, 2);
  assert.equal(report.estimates.scoringConcurrencyTargets['10s'], 142);
  assert.ok(report.findings.some((finding) =>
    finding.severity === 'amber' && finding.area === 'Draft Deadline Task Queue'
  ));
  assert.ok(report.findings.some((finding) =>
    finding.severity === 'amber' && finding.area === 'Draft Recovery Sweeper'
  ));
  assert.ok(report.findings.some((finding) =>
    finding.severity === 'amber' && finding.area === 'League Scoring Queue Foundation'
  ));
  assert.ok(report.findings.some((finding) =>
    finding.severity === 'red' && finding.area === 'League Scoring Queue Cutover'
  ));
  assert.ok(!report.findings.some((finding) =>
    finding.severity === 'red' && finding.area.includes('Draft')
  ));
});

test('high-scale blueprint names the exact concern areas, target task design, staged migration, and rollback', async () => {
  const documentation = await read('docs/RINKRAT_HIGH_SCALE_AUTOMATION_BLUEPRINT.md');

  for (const text of [
    'functions/src/league-automation.ts',
    'MAX_PARALLEL_LEAGUES',
    'processLeagueAutomationTask',
    'deterministic idempotency key',
    'shadow mode',
    'functions/src/draft-automation.ts',
    'processDraftClockDeadline',
    'functions/src/index.ts',
    'NHL API Proxy',
    'Staged load-test plan',
    'Rollback',
  ]) {
    assert.match(documentation, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
});

test('R1B-P1D verification, the current release candidate, and documentation links are wired', async () => {
  const [packageSource, developmentConfig, productionConfig, readme, projectDocs] = await Promise.all([
    read('package.json'),
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('README.md'),
    read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.match(packageJson.scripts['test:batchr1b-p1d:run'], /batchr1b-p1d-launch-scale/);
  assert.match(packageJson.scripts['verify:batchr1b-p1d'], /verify:batchp1c/);
  assert.match(packageJson.scripts['verify:batchr1b-p1d'], /audit:invite-beta-release/);
  assert.match(developmentConfig, /^.*Release Candidate \d+.*$/m);
  assert.match(productionConfig, /^.*Release Candidate \d+.*$/m);
  assert.match(readme, /RINKRAT_HIGH_SCALE_AUTOMATION_BLUEPRINT/);
  assert.match(projectDocs, /^## Batch R1B-P1D — Invite Beta Launch Gate and High-Scale Handoff/m);
});

test('R1B-P1D preserves Production Scoring V3, Projection V11, Firestore authority, and Functions unrelated to later draft recovery', async () => {
  const [rules, engine, projection, firestoreRules, indexes] = await Promise.all([
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/scoring/scoring-engine.ts'),
    read('src/app/core/projection/projection-v11.util.ts'),
    read('firestore.rules'),
    read('firestore.indexes.json'),
  ]);

  assert.equal(createHash('sha256').update(rules).digest('hex'), '74107aa688b4a3825c52fe14003cd824485197fd3559822fab4134bff940e2da');
  assert.equal(createHash('sha256').update(engine).digest('hex'), '6f36cf76c72f8199c6a3891692844c9c830103ed618be50497b5270e259da3d3');
  assert.equal(createHash('sha256').update(projection).digest('hex'), 'e6f3111b1feccc7107e857aa24c5317451c65a84a36c71f8158947636f20d80a');
  assert.equal(createHash('sha256').update(firestoreRules).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreRules);
  assert.equal(createHash('sha256').update(indexes).digest('hex'), '62f09a69e4e487eb9bfa1935e874d32a07e8fa0cddba48205903d62e19261a13');
  assert.equal(
    await hashFunctionsRuntimeIntegrity({
      excludedPaths: new Set([
        'src/index.ts',
        'src/league-lifecycle-authority.ts',
    'src/league-lifecycle-authority.util.ts',
        'src/league-automation.ts',
        // D1D intentionally changes only the measured near-live scoring path.
        'src/shared/core/cycle/cycle-scoring.service.ts',
        'src/shared/core/nhl/nhl-api.service.ts',
        'src/shared/core/live-scoring/live-scoring-cadence.util.ts',
        // D1F adds isolated canonical facts and affected-league routing.
        'src/nhl-canonical-impact-feed.ts',
        'src/shared/core/nhl/nhl-canonical-facts.util.ts',
        // D1G adds isolated direct-versus-canonical shadow scoring parity.
        'src/shared/core/nhl/nhl-canonical-scoring-parity.util.ts',
        // D1H adds an isolated same-task authority decision and circuit-breaker helper.
        'src/shared/core/nhl/nhl-canonical-scoring-authority.util.ts',
        // D1I adds isolated automatic fallback and measured-capacity decisions.
        'src/shared/core/live-scoring/league-automation-season-safety.util.ts',
        // D1F.2 adds isolated queue-version helpers and scoring phase instrumentation.
        'src/shared/core/live-scoring/canonical-request-completion.util.ts',
        'src/shared/core/nhl/nhl-canonical-impact-routing.util.ts',
        'src/shared/core/observability/scoring-phase-timing.util.ts',
        'src/draft-authority.ts',
        'src/draft-automation.ts',
        // FF1.19 adds isolated scheduled-Draft readiness evidence decisions.
        'src/draft-readiness.util.ts',
        'src/shared/core/draft/draft.models.ts',
        'src/projection-authority.ts',
        'src/shared/core/projection/projection-asset-catalog.service.ts',
        'src/shared/core/projection/projection-asset-catalog.util.ts',
        'src/shared/core/projection/projection-snapshot.service.ts',
        'src/shared/core/projection/projection-snapshot-hash.util.ts',
        'package.json',
        'scripts/auth-security-baseline.cjs',
        'src/security-authority.ts',
        'src/security-operations.ts',
        'src/shared/security/auth-security.util.ts',

        // S3B intentionally hardens these public security boundaries.

        'src/email-notifications.ts',

        'src/manager-profile-authority.ts',

        'src/roster-authority.ts',

        'src/roster-moves.ts',

        'src/shared/core/replay/roster-move-replay-context.util.ts',

        'src/shared/security/firestore-document-id-core.util.ts',

        'src/shared/security/firestore-document-id.util.ts',
        'src/shared/security/firestore-document-id-policies.ts',

        'src/shared/security/nhl-proxy-security.util.ts',
        // S3E adds isolated monitor-only App Check readiness aggregation.
        'src/shared/security/app-check-enforcement-readiness.util.ts',
        // S3F adds guarded exact-league selected-callable App Check canary controls.
        'src/app-check-canary-authority.ts',
        'src/shared/security/app-check-callable-canary.util.ts',
        // B1B adds isolated beta evidence and aggregate operations helpers.
        'src/beta-operations.ts',
        'src/shared/core/observability/beta-operations.util.ts',
        // D1B adds isolated shared injury identity diagnostics.
        'src/shared/core/player/injury-match-quality.util.ts',
        'src/shared/core/player/injury-player-aliases.ts',
        'src/shared/core/player/player-availability.models.ts',
        // C1A adds isolated server-sanitized League Wire projections.
        'src/league-activity.ts',
        'src/shared/core/league/league-activity.util.ts',
        'src/shared/core/league/league-activity-reaction.util.ts',
        'scripts/league-matchup-activity-inspect.cjs',
        // C1B adds guarded additive migration and inspection commands.
        'scripts/transaction-privacy-backfill.cjs',
        'scripts/transaction-privacy-inspect.cjs',
        // C1K adds isolated cosmetic challenge reconciliation authority.
        'src/team-identity-challenges.ts',
        'src/shared/core/user/team-identity-challenge.util.ts',
        // A1A adds isolated account-wide watchlist authority.
        'src/player-watchlist.ts',
        'src/shared/core/user/player-watchlist.util.ts',
        // A1D adds isolated replay alignment and private player-note authority.
        'src/shared/core/draft/historical-replay-player-data.util.ts',
        'src/player-note.ts',
        'src/shared/core/user/player-note.util.ts',
        // O1B adds isolated platform-admin tester-season planning authority.
        'src/private-season-authority.ts',
        'src/shared/core/operations/private-season.util.ts',
        // O1C adds isolated private-season health and engagement authority.
        'src/private-season-health.ts',
        'src/shared/core/operations/private-season-health.util.ts',
        // O1D adds isolated incident/status authority.
        'src/service-incident-authority.ts',
        'src/shared/core/operations/service-incident.util.ts',
        // O1E adds isolated tester-research authority.
        'src/private-season-research.ts',
        'src/shared/core/operations/private-season-research.util.ts',
        // O1F adds isolated privacy-request and export authority.
        'src/privacy-request-authority.ts',
        'src/shared/core/privacy/privacy-request.util.ts',
        // O1G adds isolated versioned compatibility for operational callables.
        'src/shared/core/operations/operations-client-compatibility.util.ts',
        // D1L explicitly changes these additional final-input and durable-outbox paths.
        'src/shared/core/cycle/asset-cycle-window.service.ts',
        'src/shared/core/cycle/cycle.models.ts',
        'src/shared/core/nhl/nhl-canonical-publication-outbox.service.ts',
        'src/shared/core/nhl/nhl-final-input-completeness.util.ts',
        'src/shared/core/playoffs/playoff-window-bank.service.ts',
        // D1M adds an isolated, detect-only final-score reconciliation classifier.
        'src/shared/core/nhl/final-score-reconciliation.util.ts',
      ]),
    }),
    '5494f2b953dafe66e3341e282f821af8b87b8e8aa776cf917cbc7d9f1c5641a5',
  );
});
