import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import {
  buildPrivateSeasonHealthSummary,
  normalizePrivateSeasonEngagementCategory,
  normalizePrivateSeasonWeeklyHealthRecord,
  privateSeasonManagerDayId,
  privateSeasonManagerHash,
  privateSeasonRetentionManagerRequirement,
} from '../../functions/src/shared/core/operations/private-season-health.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

const thresholds = {
  unresolvedP0IntegrityDefectsMaximum: 0,
  confirmedCoreActionReliabilityPercentMinimum: 99.5,
  sixMemberLeagueDraftCompletionPercentMinimum: 75,
  createdLeagueSixVerifiedMemberPercentMinimum: 60,
  fourWeekLeagueRetentionPercentMinimum: 70,
  medianSupportMinutesPerActiveLeagueWeekMaximum: 20,
  nextSeasonCommissionerIntentPercentMinimum: 70,
};

function league(overrides = {}) {
  return {
    slotId: 'league-slot-a',
    leagueId: 'league-a',
    label: 'Tester League A',
    expectedManagerCount: 6,
    exists: true,
    teamCount: 6,
    draftStatus: 'complete',
    draftCompletedAt: '2026-09-20T12:00:00.000Z',
    firstMatchupViewedAt: '2026-09-29T12:00:00.000Z',
    firstRosterActionAt: '2026-09-30T12:00:00.000Z',
    activatedAt: '2026-09-29T12:00:00.000Z',
    latestEngagementAt: '2026-10-27T12:00:00.000Z',
    activeManagerCount7Days: 5,
    fourWeekDue: true,
    fourWeekWindowClosed: true,
    fourWeekActiveManagerCount: 4,
    fourWeekRequiredManagerCount: 3,
    retainedAtFourWeeks: true,
    ...overrides,
  };
}

function weekly(overrides = {}) {
  return {
    schemaVersion: 1,
    weekEnding: '2026-10-25',
    revision: 1,
    platformCostUsd: 40,
    leagues: [
      {
        slotId: 'league-slot-a',
        leagueId: 'league-a',
        supportMinutes: 12,
        founderInterventions: 0,
        commissionerIntent: 'definitely',
        note: 'No recurring support issue.',
      },
      {
        slotId: 'league-slot-b',
        leagueId: 'league-b',
        supportMinutes: 18,
        founderInterventions: 1,
        commissionerIntent: 'probably',
        note: 'One commissioner question.',
      },
    ],
    updatedAt: '2026-10-25T20:00:00.000Z',
    updatedBy: 'admin-user',
    ...overrides,
  };
}

test('private-season engagement categories and pseudonymous IDs fail closed', () => {
  assert.equal(normalizePrivateSeasonEngagementCategory('game-center'), 'game-center');
  assert.equal(normalizePrivateSeasonEngagementCategory('roster'), 'roster');
  assert.equal(normalizePrivateSeasonEngagementCategory('email'), null);

  const first = privateSeasonManagerHash('manager-a', 'league-a');
  const replay = privateSeasonManagerHash('manager-a', 'league-a');
  const otherLeague = privateSeasonManagerHash('manager-a', 'league-b');

  assert.equal(first, replay);
  assert.notEqual(first, otherLeague);
  assert.match(first, /^[a-f0-9]{32}$/);
  assert.match(privateSeasonManagerDayId(first, '2026-09-29'), /^[a-f0-9]{40}$/);
  assert.doesNotMatch(first, /manager-a|league-a/);
});

test('weekly health normalization accepts only active league slots and bounded evidence', () => {
  const result = normalizePrivateSeasonWeeklyHealthRecord({
    weekEnding: '2026-09-27',
    revision: 4,
    platformCostUsd: 12.345,
    leagues: [
      {
        slotId: 'league-slot-a',
        leagueId: 'forged-league',
        supportMinutes: 42.4,
        founderInterventions: 3.8,
        commissionerIntent: 'probably',
        note: '  Weekly evidence.  ',
      },
      {
        slotId: 'unknown-slot',
        leagueId: 'unknown-league',
        supportMinutes: 999,
        commissionerIntent: 'definitely',
      },
    ],
  }, [
    { slotId: 'league-slot-a', leagueId: 'league-a' },
    { slotId: 'league-slot-b', leagueId: 'league-b' },
  ]);

  assert.ok(result);
  assert.equal(result.weekEnding, '2026-09-27');
  assert.equal(result.platformCostUsd, 12.35);
  assert.equal(result.leagues.length, 2);
  assert.deepEqual(result.leagues[0], {
    slotId: 'league-slot-a',
    leagueId: 'league-a',
    supportMinutes: 42,
    founderInterventions: 4,
    commissionerIntent: 'probably',
    note: 'Weekly evidence.',
  });
  assert.equal(result.leagues[1].leagueId, 'league-b');
  assert.equal(result.leagues[1].supportMinutes, 0);
});

test('retention requirement uses half the league with a minimum of three managers', () => {
  assert.equal(privateSeasonRetentionManagerRequirement(4), 3);
  assert.equal(privateSeasonRetentionManagerRequirement(6), 3);
  assert.equal(privateSeasonRetentionManagerRequirement(8), 4);
  assert.equal(privateSeasonRetentionManagerRequirement(12), 6);
});

test('healthy evidence uses activated leagues rather than drafted-only leagues for cost and counts', () => {
  const summary = buildPrivateSeasonHealthSummary({
    leagues: [
      league(),
      league({
        slotId: 'league-slot-b',
        leagueId: 'league-b',
        label: 'Tester League B',
        fourWeekActiveManagerCount: 3,
      }),
    ],
    weeklyRecords: [weekly()],
    actions: {
      buildId: 'release-candidate-53-test-build',
      total: 250,
      successes: 250,
      errors: 0,
      uncertain: 0,
      cancelled: 0,
    },
    unresolvedIntegrityCount: 0,
    thresholds,
  });

  assert.equal(summary.status, 'healthy');
  assert.equal(summary.activeLeagueCount, 2);
  assert.equal(summary.activatedLeagueCount, 2);
  assert.equal(summary.retainedLeagueCount, 2);
  assert.equal(summary.costPerActivatedLeagueWeek, 20);
  assert.equal(summary.metrics.find((metric) => metric.key === 'core-action-reliability')?.valueLabel, '100.0%');
  assert.equal(summary.metrics.find((metric) => metric.key === 'support-burden')?.valueLabel, '15 min');
  assert.equal(summary.metrics.find((metric) => metric.key === 'commissioner-intent')?.valueLabel, '100.0%');
});

test('unresolved integrity evidence blocks the season and low reliability remains visible', () => {
  const summary = buildPrivateSeasonHealthSummary({
    leagues: [league({ teamCount: 4, draftStatus: 'setup', activatedAt: null, fourWeekDue: false })],
    weeklyRecords: [],
    actions: {
      buildId: 'release-candidate-53-test-build',
      total: 25,
      successes: 23,
      errors: 1,
      uncertain: 1,
      cancelled: 0,
    },
    unresolvedIntegrityCount: 1,
    thresholds,
  });

  assert.equal(summary.status, 'blocked');
  assert.ok(summary.blockers.some((entry) => entry.startsWith('Competition integrity:')));
  assert.equal(summary.metrics.find((metric) => metric.key === 'core-action-reliability')?.status, 'red');
  assert.equal(summary.metrics.find((metric) => metric.key === 'league-filling')?.status, 'red');
});

test('engagement authority verifies exact build, tracked league, membership, rate limits, and privacy-limited daily hashes', async () => {
  const [authority, engagementService] = await Promise.all([
    read('functions/src/private-season-health.ts'),
    read('src/app/core/operations/private-season-engagement.service.ts'),
  ]);

  assert.match(authority, /PRIVATE_SEASON_HEALTH_RELEASE_LABEL/);
  assert.match(authority, /release-candidate-53-/);
  assert.match(authority, /requireVerifiedManager/);
  assert.match(authority, /plan\.leagueSlots\.some\(\(slot\) => slot\.active && slot\.leagueId === leagueId\)/);
  assert.match(authority, /leagues\/\$\{leagueId\}\/members\/\$\{userId\}/);
  assert.match(authority, /consumeEngagementRateLimit/);
  assert.match(authority, /privateSeasonManagerHash/);
  assert.match(authority, /privateSeasonManagerDayId/);
  assert.match(authority, /FieldValue\.arrayUnion\(managerHash\)/);
  assert.match(authority, /catch \{\s*return missingLeagueHealthEvidence\(slot\);\s*\}/);
  assert.match(authority, /iso\(draftData\['completedAt'\]\)/);
  assert.doesNotMatch(authority, /managerDays[\s\S]{0,500}userId,/);

  assert.match(engagementService, /build\.buildId\.endsWith\('-local'\)/);
  assert.match(engagementService, /recorded = new Set<string>/);
  assert.match(engagementService, /ignoredLeagues = new Set<string>/);
  assert.match(engagementService, /recordPrivateSeasonEngagement/);
  assert.match(engagementService, /not-tracked/);
});

test('weekly authority is platform-admin only, recently authenticated, revision-safe, and audited', async () => {
  const authority = await read('functions/src/private-season-health.ts');

  assert.match(authority, /requirePlatformAdmin\(request\.auth, true\)/);
  assert.match(authority, /PRIVATE_SEASON_HEALTH_WEEKLY_REASON_MINIMUM_LENGTH/);
  assert.match(authority, /currentRevision !== expectedRevision/);
  assert.match(authority, /weeklyHealthChanges/);
  assert.match(authority, /recordHash/);
  assert.match(authority, /FieldValue\.serverTimestamp\(\)/);
  assert.match(authority, /getPrivateSeasonHealthDashboard/);
  assert.match(authority, /updatePrivateSeasonWeeklyHealth/);
});

test('account deletion removes private-season manager-day evidence', async () => {
  const index = await read('functions/src/index.ts');

  assert.match(index, /deletePrivateSeasonEngagementForAccount/);
  assert.match(index, /privateSeasonManagerHash\(userId, leagueId\)/);
  assert.match(index, /collection\('managerDays'\)/);
  assert.match(index, /FieldValue\.arrayRemove\(managerHash\)/);
  assert.match(index, /deletePrivateSeasonEngagementForAccount\(userId, leagueIds\)/);
});

test('admin health route is guarded, linked, mobile-first, and avoids blocking presentation', async () => {
  const [routes, adminTemplate, planTemplate, healthTemplate, healthStyles, mainLayout, gameCenter] = await Promise.all([
    read('src/app/app.routes.ts'),
    read('src/app/features/admin/admin-center/admin-center.html'),
    read('src/app/features/admin/private-season-center/private-season-center.html'),
    read('src/app/features/admin/private-season-health/private-season-health.html'),
    read('src/app/features/admin/private-season-health/private-season-health.css'),
    read('src/app/layouts/main-layout/main-layout.ts'),
    read('src/app/features/cycles/cycle-one/cycle-one.ts'),
  ]);

  assert.match(routes, /path: 'admin\/private-season\/health'[\s\S]*?canActivate: \[platformAdminGuard\]/);
  assert.match(adminTemplate, /routerLink="\/admin\/private-season\/health"/);
  assert.match(planTemplate, /routerLink="\/admin\/private-season\/health"/);
  assert.match(healthTemplate, /Private Season Health/);
  assert.match(healthTemplate, /Activation and retention/);
  assert.match(healthTemplate, /Support, intervention, intent, and cost/);
  assert.match(healthTemplate, /No names or contact details/);
  assert.doesNotMatch(healthTemplate, /email|phone number/i);
  assert.doesNotMatch(healthTemplate, /role="dialog"|backdrop|overlay/i);
  assert.doesNotMatch(healthStyles, /position:\s*(?:fixed|sticky)/);
  assert.match(healthStyles, /@media \(max-width: 640px\)/);
  assert.match(healthStyles, /min-height:\s*var\(--rr-touch-target\)/);
  assert.match(mainLayout, /PrivateSeasonEngagementService/);
  assert.match(mainLayout, /observeRoute\(path\)/);
  assert.match(gameCenter, /matchups\.some\(\(matchup\) =>/);
  assert.match(gameCenter, /recordLeagueActivity\(leagueId, 'game-center'\)/);
});

test('O1C adds no Firestore Rule, index, TTL, scoring, projection, or safety-mode change', async () => {
  const [
    scoringRules,
    scoringEngine,
    projectionV11,
    firestoreRules,
    firestoreIndexes,
    freezeSource,
    runtime,
    productionRuntime,
  ] = await Promise.all([
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/scoring/scoring-engine.ts'),
    read('src/app/core/projection/projection-v11.util.ts'),
    read('firestore.rules'),
    read('firestore.indexes.json'),
    read('config/release-freeze/beta-freeze-policy.json'),
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
  ]);
  const freeze = JSON.parse(freezeSource);

  assert.equal(createHash('sha256').update(scoringRules).digest('hex'), PROTECTED_SOURCE_HASHES.scoringRules);
  assert.equal(createHash('sha256').update(scoringEngine).digest('hex'), PROTECTED_SOURCE_HASHES.scoringEngine);
  assert.equal(createHash('sha256').update(projectionV11).digest('hex'), PROTECTED_SOURCE_HASHES.projectionV11);
  assert.equal(createHash('sha256').update(firestoreRules).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreRules);
  assert.equal(createHash('sha256').update(firestoreIndexes).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreIndexes);
  assert.match(runtime, /Release Candidate 53/);
  assert.match(productionRuntime, /Release Candidate 53/);
  assert.equal(freeze.scoringRulesVersion, 4);
  assert.equal(freeze.projectionVersion, 11);
  assert.equal(freeze.requiredGamesPerRosterSlot, 6);
  assert.equal(freeze.queueMode, 'shadow');
  assert.equal(freeze.appCheckMode, 'monitor');
  assert.equal(freeze.verificationCommand, 'npm run verify:batcho1c');
  assert.equal(freeze.defaultTag, 'rinkrat-rc53-invite-beta');
});

test('roadmap and documentation advance O1.3 and O1.4 without claiming live proof', async () => {
  const [roadmap, docsRoadmap, readme, runbook, packageSource, boundariesSource] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('README.md'),
    read('docs/RINKRAT_OPERATIONS_O1C_PRIVATE_SEASON_HEALTH.md'),
    read('package.json'),
    read('config/firestore-document-id-boundaries.json'),
  ]);
  const packageJson = JSON.parse(packageSource);
  const boundaries = JSON.parse(boundariesSource);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.44/);
  assert.match(roadmap, /O1\.3[\s\S]*O1C \/ Release Candidate 53/);
  assert.match(roadmap, /O1\.4[\s\S]*live cohort proof remains required/i);
  assert.match(roadmap, /LOG\.65 2026-08-19 — Completed Operations Batch O1C/);
  assert.match(readme, /Release Candidate 53 \/ Operations Batch O1C/);
  assert.match(readme, /npm run verify:batcho1c/);
  assert.match(runbook, /privacy-limited/i);
  assert.match(runbook, /Functions[\s\S]*Hosting/i);
  assert.equal(packageJson.scripts['verify:batcho1c:core'], 'npm run verify:batcho1b:core && npm run beta:audit-season-plan && npm run audit:product-copy-density && npm run test:batcho1c:run && npm run validate:release-manifest');
  assert.match(packageJson.scripts['security:ci'], /verify:batcho1c:core/);
  assert.ok(boundaries.boundaries.some((entry) => entry.file === 'functions/src/private-season-health.ts'));
});
