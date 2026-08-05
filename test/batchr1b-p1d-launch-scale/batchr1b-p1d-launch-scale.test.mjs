import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
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

async function hashTree(relativeDirectory, excludedPaths = new Set()) {
  const rootPath = path.join(root, relativeDirectory);
  const files = [];

  async function visit(currentPath, relativePath = '') {
    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries.sort((first, second) => first.name.localeCompare(second.name))) {
      if (entry.name === 'node_modules' || entry.name === 'lib') {
        continue;
      }

      const childPath = path.join(currentPath, entry.name);
      const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

      if (excludedPaths.has(childRelativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        await visit(childPath, childRelativePath);
      } else if (entry.isFile()) {
        files.push({ path: childPath, relativePath: childRelativePath });
      }
    }
  }

  await visit(rootPath);
  const digest = createHash('sha256');

  for (const file of files) {
    const metadata = await stat(file.path);
    const bytes = await readFile(file.path);
    const pathBytes = Buffer.from(file.relativePath);

    digest.update(Buffer.from(Uint32Array.of(pathBytes.length).buffer).reverse());
    digest.update(pathBytes);
    digest.update(Buffer.from(BigUint64Array.of(BigInt(metadata.size)).buffer).reverse());
    digest.update(bytes);
  }

  return digest.digest('hex');
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
    releaseManifest: {
      schemaVersion: 1,
      releaseLabel: 'Release Candidate 6',
      buildId: 'build-a',
      builtAt: '2026-08-05T12:00:00.000Z',
      sourceRevision: 'abcdef123456',
      packageVersion: '0.0.0',
      scoringRulesVersion: 3,
      projectionVersion: 11,
    },
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
  assert.match(template, /App Check client/);
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
    finding.severity === 'red' && finding.area === 'Scheduled League Scoring'
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

test('R1B-P1D verification, Release Candidate 6, and documentation links are wired', async () => {
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
  assert.match(developmentConfig, /Release Candidate 6/);
  assert.match(productionConfig, /Release Candidate 6/);
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

  assert.equal(createHash('sha256').update(rules).digest('hex'), 'd0ba8838c17737b00cdc5f0dea5e24ffb4e1af2154c2575baf28c3aa83de4901');
  assert.equal(createHash('sha256').update(engine).digest('hex'), 'f9cdb69372437c4cf4e70e678d98227d8777ccc13d37b7ef000ac71ba36d4e15');
  assert.equal(createHash('sha256').update(projection).digest('hex'), 'e6f3111b1feccc7107e857aa24c5317451c65a84a36c71f8158947636f20d80a');
  assert.equal(createHash('sha256').update(firestoreRules).digest('hex'), 'a37d7c47e9ffcb6a4549e5ad078a918b812619c014fcf01373025bacfa9c1a8c');
  assert.equal(createHash('sha256').update(indexes).digest('hex'), 'c18738f1fe9547da2c59fbcd6b3d725db8ea8ff1f190ca82cc0c1b27ebc0d8a0');
  assert.equal(
    await hashTree(
      'functions',
      new Set([
        'src/draft-authority.ts',
        'src/draft-automation.ts',
        'src/shared/core/draft/draft.models.ts',
      ]),
    ),
    '8d278968d163577207e39a5dee7ee542e657850fdd827fd54cbe2de42f8d30fe',
  );
});
