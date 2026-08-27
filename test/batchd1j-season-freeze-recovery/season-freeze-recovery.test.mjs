import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import { runPreseasonScoringCertification } from '../../scripts/certification/run-preseason-scoring-certification.mjs';
import {
  buildSeasonKitFiles,
  formatSeasonIncidentGuide,
  formatSeasonRollbackPlan,
  validateSeasonFreezeEvidence,
} from '../../scripts/release/season-freeze.util.mjs';
import {
  createPrivateSeasonFreezeEvidenceReport,
} from '../../src/app/core/release/private-season-freeze-evidence.util.ts';
import {
  createSeasonLaunchScoringEvidenceReport,
} from '../../src/app/core/release/season-launch-evidence.util.ts';

const ROOT = new URL('../../', import.meta.url);
const read = (relativePath) => readFile(new URL(relativePath, ROOT), 'utf8');

async function sha256(relativePath) {
  return createHash('sha256').update(await read(relativePath)).digest('hex');
}

function build() {
  return {
    schemaVersion: 1,
    releaseLabel: 'Release Candidate 65',
    buildId: 'release-candidate-65-season-freeze-test-aabbccddeeff',
    builtAt: '2026-08-27T18:00:00.000Z',
    sourceRevision: 'a'.repeat(40),
    packageVersion: '0.0.0',
    scoringRulesVersion: 4,
    projectionVersion: 11,
  };
}

function queueSnapshot(now = '2026-08-27T18:00:00.000Z') {
  return {
    generatedAt: now,
    projectId: 'nhl-fantasy-app-ab673',
    environment: 'production',
    production: true,
    mode: 'shadow',
    canaryLeagueIds: [],
    internalTestLeagueIds: [],
    canonicalAuthorityLeagueIds: [],
    canonicalAuthorityConfirmationPhrase: 'ENABLE CANONICAL READ CANARY',
    canonicalAuthorityMaximumLeagueCount: 1,
    canonicalAuthorityMinimumParityStreak: 3,
    seasonSafetyStatus: 'observing',
    seasonSafetyAlerts: [],
    seasonSafetyWatchdog: {
      status: 'observing',
      lastAttemptAt: now,
      lastSuccessfulAt: now,
      queueBlockingStreak: 0,
      canonicalBlockingStreak: 0,
      requiredBlockingStreak: 2,
      lastAction: 'none',
      lastActionAt: null,
      lastActionReason: '',
      automaticShadowFallbackCount: 0,
      automaticCanonicalFallbackCount: 0,
      consecutiveFailureCount: 0,
      lastError: '',
      lastQueueBlockingAlertIds: [],
      lastCanonicalBlockingAlertIds: [],
    },
    capacityEvidence: {
      status: 'healthy',
      consecutiveFailureCount: 0,
      lastError: '',
      lastAttemptAt: now,
      evidenceLevel: 'insufficient',
      queueTaskSampleCount: 0,
      queueTaskSuccessCount: 0,
      queueTaskErrorCount: 0,
      queueTaskSkippedCount: 0,
      queueTaskReliabilityRate: 1,
      sampledDayCount: 0,
      averageDurationMilliseconds: 0,
      p95DurationMilliseconds: 0,
      maximumDurationMilliseconds: 0,
      workerCount: 4,
      refreshIntervalMilliseconds: 120000,
      headroomRatio: 0.7,
      safeAffectedLeagueCapacity: 0,
      recommendedWorkersFor25Leagues: 0,
      recommendedWorkersFor50Leagues: 0,
      promotionEvidenceReady: false,
      p95WithinPrimaryTarget: false,
      reliabilityWithinPrimaryTarget: false,
      supportsActiveLeagueTarget: false,
      primaryCapacityReady: false,
      windowDays: 14,
      dateFrom: '2026-08-14',
      dateTo: '2026-08-27',
      lastRefreshedAt: now,
      source: 'queue-task',
      allScoringSampleCount: 0,
      allScoringAverageDurationMilliseconds: 0,
      allScoringP95DurationMilliseconds: 0,
      allScoringMaximumDurationMilliseconds: 0,
    },
    maxEnqueuePerRun: 100,
    canarySuccessBaseline: 0,
    successfulTasksSinceCanary: 0,
    revision: 7,
    updatedAt: now,
    updatedBy: 'server:season-safety-watchdog',
    changeReason: 'Shadow baseline before season freeze.',
    primaryApproval: {
      enabled: false,
      valid: false,
      expiresAt: null,
      note: '',
    },
    primaryPromotionAllowed: false,
    primaryConfirmationPhrase: 'ENABLE PRIMARY IN PRODUCTION',
    promotionGates: [],
    health: {
      queueLastDispatchAt: now,
      queueLastDispatchStatus: 'shadow',
      queueScheduleCoverageCount: 2,
      queueScheduleCoverageCompletedDraftCount: 2,
      queueActivePendingTaskCount: 0,
      queueTaskMaxPendingTasks: 24,
      queueFailedEnqueueCount: 0,
      queueLastRecoveryCount: 0,
      queueOldestDueAgeMilliseconds: 0,
      canonicalParityCohortPassing: false,
      canonicalParityMismatchLeagueCount: 0,
      canonicalParityIncompleteLeagueCount: 0,
      canonicalParityMissingLeagueCount: 0,
      canonicalParityStaleLeagueCount: 0,
    },
    leagues: [],
    truncated: false,
    audit: [],
  };
}

function privateSeasonSnapshot(now = '2026-08-27T18:00:00.000Z') {
  const decision = {
    decisionId: 'decision-1',
    gate: 'private-season',
    outcome: 'approved',
    reason: 'The exact release, tester cohort, support coverage, and rollback evidence are ready.',
    planRevision: 4,
    planHash: 'b'.repeat(64),
    releaseLabel: build().releaseLabel,
    buildId: build().buildId,
    recordedAt: now,
    recordedBy: 'platform-admin',
  };

  return {
    plan: {
      schemaVersion: 1,
      seasonLabel: '2026-27',
      revision: 4,
      status: 'approved',
      leagueSlots: [],
      testers: [],
      support: {
        primaryOwner: 'Stephen',
        deputyAlias: 'Deputy',
        supportChannelReady: true,
        knownIssuesReady: true,
        rollbackRehearsed: true,
        deputyConfirmed: true,
        coverageConfirmed: true,
      },
      freeze: {
        featureFreezeConfirmed: true,
        approvedReleaseLabel: build().releaseLabel,
        approvedBuildId: build().buildId,
        nonGoals: ['No noncritical feature changes after the freeze.'],
      },
      latestDecision: decision,
      updatedAt: now,
      updatedBy: 'platform-admin',
    },
    readiness: {
      status: 'ready',
      headline: 'Ready for exact-build private-season approval',
      blockers: [],
      advisories: [],
      leagueCount: 2,
      testerCount: 12,
      nonFounderCommissionerCount: 1,
      experienceCoverage: {
        'hockey-expert': true,
        'casual-fan': true,
        'fantasy-beginner': true,
      },
      deviceCoverage: {
        iphone: true,
        android: true,
        desktop: true,
      },
      liveLeagueEvidence: [],
      exactBuildFrozen: true,
      currentDecisionValid: true,
      readyForApproval: false,
    },
    policy: {
      minimumLeagues: 2,
      maximumLeagues: 4,
      minimumManagersPerLeague: 6,
      minimumTesters: 10,
      maximumTesters: 30,
      requiredExperiences: [
        'hockey-expert',
        'casual-fan',
        'fantasy-beginner',
      ],
      requiredDevices: ['iphone', 'android', 'desktop'],
      requiresNonFounderCommissioner: true,
      decisionReasonMinimumLength: 12,
      noContactDetails: true,
    },
    build: {
      operationsApiVersion: 1,
      releaseLabel: build().releaseLabel,
      buildId: build().buildId,
      scoringRulesVersion: 4,
      projectionVersion: 11,
    },
  };
}

function validationReport() {
  return {
    schemaVersion: 4,
    reportType: 'rinkrat-invite-beta-validation',
    build: build(),
    launchGate: {
      status: 'ready',
      blockers: [],
      automatedPassedCount: 30,
      automatedRequiredCount: 30,
      manualPassedCount: 34,
      manualRequiredCount: 34,
      manualAttentionCount: 0,
      manualUntestedCount: 0,
      simulationStatus: 'passed',
    },
    lifecycleSimulation: {
      passed: true,
      passedCount: 40,
      totalCount: 40,
      failedChecks: [],
    },
  };
}

test('Shadow scoring evidence is ready only with fresh, drained, failure-free production health', () => {
  const report = createSeasonLaunchScoringEvidenceReport({
    snapshot: queueSnapshot(),
    build: build(),
    generatedAt: '2026-08-27T18:00:00.000Z',
    expectedProjectId: 'nhl-fantasy-app-ab673',
  });

  assert.equal(report.gate.readyForFreeze, true);
  assert.equal(report.gate.blockers.length, 0);
  assert.match(report.gate.advisories.join('\n'), /capacity evidence/i);

  const unsafe = createSeasonLaunchScoringEvidenceReport({
    snapshot: {
      ...queueSnapshot(),
      mode: 'canary',
      seasonSafetyWatchdog: {
        ...queueSnapshot().seasonSafetyWatchdog,
        lastSuccessfulAt: '2026-08-27T17:50:00.000Z',
      },
      health: {
        ...queueSnapshot().health,
        queueActivePendingTaskCount: 1,
      },
    },
    build: build(),
    generatedAt: '2026-08-27T18:00:00.000Z',
    expectedProjectId: 'nhl-fantasy-app-ab673',
  });

  assert.equal(unsafe.gate.readyForFreeze, false);
  assert.match(unsafe.gate.blockers.join('\n'), /Shadow|watchdog|drain/i);
});

test('private-season evidence requires the exact approved build, cohort, support, and rollback decision', () => {
  const ready = createPrivateSeasonFreezeEvidenceReport({
    snapshot: privateSeasonSnapshot(),
    build: build(),
    generatedAt: '2026-08-27T18:00:00.000Z',
  });
  assert.equal(ready.gate.readyForFreeze, true);

  const brokenSnapshot = privateSeasonSnapshot();
  brokenSnapshot.plan.support.rollbackRehearsed = false;
  brokenSnapshot.readiness.readyForApproval = false;
  brokenSnapshot.readiness.currentDecisionValid = false;
  brokenSnapshot.readiness.blockers = ['Rollback rehearsal incomplete.'];
  const blocked = createPrivateSeasonFreezeEvidenceReport({
    snapshot: brokenSnapshot,
    build: build(),
  });
  assert.equal(blocked.gate.readyForFreeze, false);
  assert.match(blocked.gate.blockers.join('\n'), /rollback|decision|readiness/i);
});

test('the season freeze validator accepts one matching fresh evidence set and rejects stale scoring evidence', async () => {
  const policy = JSON.parse(await read('config/release-freeze/season-freeze-policy.json'));
  const now = Date.parse('2026-08-27T18:05:00.000Z');
  const scoring = createSeasonLaunchScoringEvidenceReport({
    snapshot: queueSnapshot(),
    build: build(),
    generatedAt: '2026-08-27T18:00:00.000Z',
    expectedProjectId: policy.firebaseProjectId,
  });
  const privateSeason = createPrivateSeasonFreezeEvidenceReport({
    snapshot: privateSeasonSnapshot(),
    build: build(),
    generatedAt: '2026-08-27T18:00:00.000Z',
  });

  const accepted = validateSeasonFreezeEvidence({
    validationReport: validationReport(),
    scoringEvidence: scoring,
    privateSeasonEvidence: privateSeason,
    preseasonCertification: runPreseasonScoringCertification(),
    liveManifest: build(),
    policy,
    nowMilliseconds: now,
  });
  assert.equal(accepted.ok, true);

  const stale = validateSeasonFreezeEvidence({
    validationReport: validationReport(),
    scoringEvidence: {
      ...scoring,
      generatedAt: '2026-08-27T17:00:00.000Z',
    },
    privateSeasonEvidence: privateSeason,
    preseasonCertification: runPreseasonScoringCertification(),
    liveManifest: build(),
    policy,
    nowMilliseconds: now,
  });
  assert.equal(stale.ok, false);
  assert.match(stale.issues.join('\n'), /older than/i);
});

test('source-only season preflight proves the current D1J policy without touching production', () => {
  const output = execFileSync(
    process.execPath,
    ['scripts/release/season-freeze.mjs', 'preflight', '--source-only'],
    { cwd: new URL('.', ROOT), encoding: 'utf8' },
  );

  assert.match(output, /Private-season source preflight passed/);
  assert.match(output, /Node 22\.23\.1/);
  assert.match(output, /13 targeted scoring Functions/);
  assert.match(output, /Shadow freeze/);
});

test('freeze tooling requires explicit evidence and never deploys or tags silently', async () => {
  const source = await read('scripts/release/season-freeze.mjs');

  assert.match(source, /RINKRAT_FREEZE_PRIVATE_SEASON === 'FREEZE'/);
  assert.match(source, /validation-report/);
  assert.match(source, /scoring-evidence/);
  assert.match(source, /private-season-evidence/);
  assert.match(source, /preseason-certification/);
  assert.match(source, /ci-passed/);
  assert.match(source, /rollback-rehearsed/);
  assert.match(source, /queue-shadow/);
  assert.match(source, /private-season-approved/);
  assert.doesNotMatch(source, /run\(['"]firebase['"]/);
  assert.doesNotMatch(source, /run\(['"]git['"], \[['"]tag['"]/);
});

test('generated recovery guidance uses targeted Functions, Shadow first, and no broad Firebase deployment', async () => {
  const deploymentPolicy = JSON.parse(
    await read('config/release-freeze/season-deployment-policy.json'),
  );
  const record = {
    release: build(),
    verification: { command: 'npm run verify:batchd1j' },
    toolchain: { node: '22.23.1', npm: '11.17.0' },
    firebase: {
      projectId: 'nhl-fantasy-app-ab673',
      hostingTarget: 'app',
      publicUrl: 'https://rinkratfantasy.com',
    },
    git: { tag: 'rinkrat-2026-private-season-baseline' },
  };

  const rollback = formatSeasonRollbackPlan(record, deploymentPolicy);
  const incident = formatSeasonIncidentGuide(record, deploymentPolicy);

  assert.match(rollback, /Return queued scoring to \*\*Shadow\*\*/);
  assert.match(rollback, /functions:monitorLeagueAutomationSeasonSafety/);
  assert.match(rollback, /firebase deploy --only hosting:app/);
  assert.match(rollback, /Never run a broad `firebase deploy`/);
  assert.match(incident, /First 15 Minutes/);
  assert.match(incident, /disable canonical authority/i);
  assert.match(incident, /Never silently alter a score/i);
});

test('one pure kit builder produces every required recovery artifact', async () => {
  const deploymentPolicy = JSON.parse(
    await read('config/release-freeze/season-deployment-policy.json'),
  );
  const record = {
    schemaVersion: 1,
    recordType: 'rinkrat-private-season-freeze',
    seasonLabel: '2026-27',
    release: build(),
    verification: { command: 'npm run verify:batchd1j' },
    toolchain: { node: '22.23.1', npm: '11.17.0' },
    firebase: {
      projectId: 'nhl-fantasy-app-ab673',
      hostingTarget: 'app',
      publicUrl: 'https://rinkratfantasy.com',
    },
    git: { tag: 'rinkrat-2026-private-season-baseline' },
  };

  const files = buildSeasonKitFiles(record, deploymentPolicy);
  assert.deepEqual(Object.keys(files).sort(), [
    'FIREBASE_FUNCTION_SELECTOR.txt',
    'FREEZE_RECORD.json',
    'INCIDENT_FIRST_15_MINUTES.md',
    'ROLLBACK.md',
    'SEASON_LAUNCH_CHECKLIST.md',
  ]);
  assert.equal(JSON.parse(files['FREEZE_RECORD.json']).release.buildId, build().buildId);
  assert.match(files['ROLLBACK.md'], /Return queued scoring to \*\*Shadow\*\*/);
  assert.match(files['INCIDENT_FIRST_15_MINUTES.md'], /First 15 Minutes/);
  assert.match(files['SEASON_LAUNCH_CHECKLIST.md'], /Private-Season Launch Checklist/);
  assert.match(files['FIREBASE_FUNCTION_SELECTOR.txt'], /functions:processLeagueAutomationTask/);
});

test('the release UI exports both scoring and private-season freeze evidence', async () => {
  const [
    queueComponent,
    queueTemplate,
    privateComponent,
    privateTemplate,
  ] = await Promise.all([
    read('src/app/features/release/scoring-queue-control-center/scoring-queue-control-center.ts'),
    read('src/app/features/release/scoring-queue-control-center/scoring-queue-control-center.html'),
    read('src/app/features/admin/private-season-center/private-season-center.ts'),
    read('src/app/features/admin/private-season-center/private-season-center.html'),
  ]);

  assert.match(queueComponent, /createSeasonLaunchScoringEvidenceReport/);
  assert.match(queueComponent, /copySeasonLaunchEvidence/);
  assert.match(queueTemplate, /Copy Season Freeze Evidence/);
  assert.match(privateComponent, /createPrivateSeasonFreezeEvidenceReport/);
  assert.match(privateComponent, /copyFreezeEvidence/);
  assert.match(privateTemplate, /Copy Freeze Evidence/);
});

test('D1J keeps generated season kits ignored and recoverable', async () => {
  const [gitignore, sync] = await Promise.all([
    read('.gitignore'),
    read('scripts/security/sync-repository-automation.mjs'),
  ]);

  assert.match(gitignore, /\/\.season-release\//);
  assert.match(sync, /SEASON_RELEASE_IGNORE_RULE/);
  assert.match(sync, /Generated private-season freeze and recovery kits/);
});

test('D1J preserves scoring, Projection V11, Rules, and indexes', async () => {
  const protectedPaths = [
    ['src/app/core/scoring/scoring-rules.ts', 'scoringRules'],
    ['functions/src/shared/core/scoring/scoring-rules.ts', 'scoringRules'],
    ['src/app/core/scoring/scoring-engine.ts', 'scoringEngine'],
    ['functions/src/shared/core/scoring/scoring-engine.ts', 'scoringEngine'],
    ['src/app/core/projection/projection-v11.util.ts', 'projectionV11'],
    ['functions/src/shared/core/projection/projection-v11.util.ts', 'projectionV11'],
    ['firestore.rules', 'firestoreRules'],
    ['firestore.indexes.json', 'firestoreIndexes'],
  ];

  for (const [relativePath, hashKey] of protectedPaths) {
    assert.equal(await sha256(relativePath), PROTECTED_SOURCE_HASHES[hashKey]);
  }
});

test('D1J scripts, documentation, and synchronized roadmaps remain present', async () => {
  const [packageJson, readme, docs, rootRoadmap, docsRoadmap] = await Promise.all([
    read('package.json'),
    read('README.md'),
    read('docs/RINKRAT_DATA_D1J_SEASON_FREEZE_RECOVERY.md'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
  ]);
  const scripts = JSON.parse(packageJson).scripts;

  assert.match(scripts['test:batchd1j:run'], /batchd1j-season-freeze-recovery/);
  assert.match(scripts['verify:batchd1j:core'], /verify:batchd1i:core/);
  assert.match(scripts['season:freeze'], /season-freeze\.mjs freeze/);
  assert.match(scripts['security:ci'], /verify:batchd1j:core/);
  assert.match(readme, /RINKRAT_DATA_D1J_SEASON_FREEZE_RECOVERY/);
  assert.match(docs, /exact-build freeze/i);
  assert.match(rootRoadmap, /D1J/);
  assert.equal(rootRoadmap, docsRoadmap);
});
