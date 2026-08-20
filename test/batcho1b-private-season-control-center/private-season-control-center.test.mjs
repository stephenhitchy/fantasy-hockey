import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import {
  buildPrivateSeasonReadiness,
  emptyPrivateSeasonPlan,
  normalizePrivateSeasonPlan,
  privateSeasonPlanHashInput,
} from '../../functions/src/shared/core/operations/private-season.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(path) {
  return readFile(new URL(path, ROOT), 'utf8');
}

function buildIdentity() {
  return {
    releaseLabel: 'Release Candidate 55',
    buildId: 'release-candidate-55-test-build',
    scoringRulesVersion: 4,
    projectionVersion: 11,
  };
}

function readyPlan() {
  const plan = emptyPrivateSeasonPlan();
  plan.revision = 7;
  plan.status = 'rehearsal';
  plan.leagueSlots = [
    { slotId: 'league-slot-one', leagueId: 'league-a', label: 'League A', expectedManagerCount: 6, draftRehearsalComplete: true, active: true },
    { slotId: 'league-slot-two', leagueId: 'league-b', label: 'League B', expectedManagerCount: 6, draftRehearsalComplete: true, active: true },
  ];
  plan.testers = Array.from({ length: 12 }, (_, index) => ({
    testerId: `tester-${index + 1}`,
    alias: `Tester ${index + 1}`,
    leagueSlotIds: [index < 6 ? 'league-slot-one' : 'league-slot-two'],
    role: index === 0 || index === 6 ? 'commissioner' : 'manager',
    experience: index === 0 ? 'hockey-expert' : index === 1 ? 'fantasy-beginner' : 'casual-fan',
    devices: index === 0 ? ['iphone'] : index === 1 ? ['android'] : ['desktop'],
    isFounder: index === 6,
    contactConfirmed: true,
    consentConfirmed: true,
    accountReady: true,
    draftRehearsalComplete: true,
  }));
  plan.support = {
    primaryOwner: 'Stephen',
    deputyAlias: 'Deputy',
    supportChannelReady: true,
    knownIssuesReady: true,
    rollbackRehearsed: true,
    deputyConfirmed: true,
    coverageConfirmed: true,
  };
  plan.freeze = {
    featureFreezeConfirmed: true,
    approvedReleaseLabel: 'Release Candidate 55',
    approvedBuildId: 'release-candidate-55-test-build',
    nonGoals: ['No public paid acquisition'],
  };
  return plan;
}

function evidence() {
  return [
    { slotId: 'league-slot-one', leagueId: 'league-a', exists: true, name: 'League A', teamCount: 6, maxTeams: 6, draftStatus: 'setup', draftOrderCount: 6, draftScheduled: true },
    { slotId: 'league-slot-two', leagueId: 'league-b', exists: true, name: 'League B', teamCount: 6, maxTeams: 6, draftStatus: 'setup', draftOrderCount: 6, draftScheduled: true },
  ];
}

test('private-season normalization is bounded and strips unsupported values', () => {
  const normalized = normalizePrivateSeasonPlan({
    status: 'unsupported',
    leagueSlots: Array.from({ length: 8 }, (_, index) => ({
      slotId: index === 0 ? 'bad id' : `slot-${index}`,
      leagueId: `league-${index}`,
      expectedManagerCount: 99,
      active: true,
    })),
    testers: Array.from({ length: 40 }, (_, index) => ({
      testerId: `tester-${index}`,
      alias: `Tester ${index}`,
      experience: 'invented',
      devices: ['iphone', 'pager'],
    })),
    freeze: { nonGoals: Array.from({ length: 20 }, (_, index) => `Non-goal ${index}`) },
  });

  assert.equal(normalized.status, 'planning');
  assert.equal(normalized.leagueSlots.length, 4);
  assert.equal(normalized.testers.length, 30);
  assert.equal(normalized.leagueSlots[0].slotId, 'league-slot-1');
  assert.equal(normalized.leagueSlots[0].expectedManagerCount, 12);
  const minimum = normalizePrivateSeasonPlan({
    leagueSlots: [{ slotId: 'slot-minimum', expectedManagerCount: 2 }],
  });
  assert.equal(minimum.leagueSlots[0].expectedManagerCount, 6);
  const legacyAssignment = normalizePrivateSeasonPlan({
    leagueSlots: [{ slotId: 'slot-legacy', expectedManagerCount: 6 }],
    testers: [{ testerId: 'tester-legacy', alias: 'Legacy', leagueSlotId: 'slot-legacy' }],
  });
  assert.deepEqual(legacyAssignment.testers[0].leagueSlotIds, ['slot-legacy']);
  assert.equal(normalized.testers[0].experience, 'casual-fan');
  assert.deepEqual(normalized.testers[0].devices, ['iphone']);
  assert.equal(normalized.freeze.nonGoals.length, 12);
});

test('empty plan fails closed on cohort, coverage, exact-build, and support gates', () => {
  const plan = emptyPrivateSeasonPlan();
  const readiness = buildPrivateSeasonReadiness({ plan, liveLeagueEvidence: [], build: buildIdentity() });

  assert.equal(readiness.readyForApproval, false);
  assert.equal(readiness.status, 'blocked');
  assert.ok(readiness.blockers.some((item) => item.includes('2–4 active tester leagues')));
  assert.ok(readiness.blockers.some((item) => item.includes('10–30')));
  assert.ok(readiness.blockers.some((item) => item.includes('non-founder')));
  assert.ok(readiness.blockers.some((item) => item.includes('support channel')));
  assert.ok(readiness.blockers.some((item) => item.includes('Release Candidate 55')));
});

test('diverse two-league plan reaches the explicit decision gate', () => {
  const plan = readyPlan();
  const readiness = buildPrivateSeasonReadiness({ plan, liveLeagueEvidence: evidence(), build: buildIdentity() });

  assert.equal(readiness.readyForApproval, true);
  assert.equal(readiness.status, 'ready');
  assert.equal(readiness.leagueCount, 2);
  assert.equal(readiness.testerCount, 12);
  assert.equal(readiness.nonFounderCommissionerCount, 1);
  assert.equal(readiness.exactBuildFrozen, true);
  assert.deepEqual(readiness.blockers, []);
});

test('a fully prepared plan still cannot be approved before it enters rehearsal', () => {
  const plan = readyPlan();
  plan.status = 'planning';
  const readiness = buildPrivateSeasonReadiness({ plan, liveLeagueEvidence: evidence(), build: buildIdentity() });

  assert.equal(readiness.readyForApproval, false);
  assert.ok(readiness.blockers.some((item) => item.includes('Rehearsal')));
});

test('one unique tester may cover multiple tester leagues without duplicating identity', () => {
  const plan = readyPlan();
  plan.testers = plan.testers.slice(0, 10);
  plan.testers[0].leagueSlotIds = ['league-slot-one', 'league-slot-two'];
  plan.testers[1].leagueSlotIds = ['league-slot-one', 'league-slot-two'];
  const readiness = buildPrivateSeasonReadiness({ plan, liveLeagueEvidence: evidence(), build: buildIdentity() });

  assert.equal(readiness.testerCount, 10);
  assert.equal(readiness.readyForApproval, true);
  assert.deepEqual(readiness.blockers, []);
});

test('an approved decision is current only for the exact plan revision and build', () => {
  const plan = readyPlan();
  const hash = createHash('sha256').update(JSON.stringify(privateSeasonPlanHashInput(plan))).digest('hex');
  plan.latestDecision = {
    decisionId: 'decision-1', gate: 'private-season', outcome: 'approved', reason: 'All rehearsal evidence passed.',
    planRevision: plan.revision, planHash: hash, releaseLabel: 'Release Candidate 55', buildId: 'release-candidate-55-test-build', recordedAt: '2026-09-27T12:00:00Z', recordedBy: 'admin',
  };
  const current = buildPrivateSeasonReadiness({ plan, liveLeagueEvidence: evidence(), build: buildIdentity() });
  const changed = buildPrivateSeasonReadiness({ plan: { ...plan, revision: plan.revision + 1 }, liveLeagueEvidence: evidence(), build: buildIdentity() });

  assert.equal(current.currentDecisionValid, true);
  assert.equal(current.headline, 'Private season approved for this exact build');
  assert.equal(changed.currentDecisionValid, false);
});

test('missing live league evidence and incomplete consent remain stop-the-line blockers', () => {
  const plan = readyPlan();
  plan.testers[0].consentConfirmed = false;
  const live = evidence();
  live[1] = { ...live[1], exists: false, teamCount: 0 };
  const readiness = buildPrivateSeasonReadiness({ plan, liveLeagueEvidence: live, build: buildIdentity() });

  assert.equal(readiness.readyForApproval, false);
  assert.ok(readiness.blockers.some((item) => item.includes('beta consent')));
  assert.ok(readiness.blockers.some((item) => item.includes('could not be verified')));
});

test('duplicate leagues, duplicate aliases, and incomplete per-league assignments fail closed', () => {
  const plan = readyPlan();
  plan.leagueSlots[1].leagueId = plan.leagueSlots[0].leagueId;
  plan.testers[1].alias = plan.testers[0].alias;
  plan.testers = plan.testers.filter((tester) => !tester.leagueSlotIds.includes('league-slot-two') || tester.testerId === 'tester-7');

  const readiness = buildPrivateSeasonReadiness({ plan, liveLeagueEvidence: evidence(), build: buildIdentity() });

  assert.equal(readiness.readyForApproval, false);
  assert.ok(readiness.blockers.some((item) => item.includes('listed more than once')));
  assert.ok(readiness.blockers.some((item) => item.includes('unique privacy-limited alias')));
  assert.ok(readiness.blockers.some((item) => item.includes('tester aliases assigned')));
});

test('server authority requires platform admin, recent auth, revision checks, and immutable audits', async () => {
  const source = await read('functions/src/private-season-authority.ts');

  assert.match(source, /getPrivateSeasonControlCenter/);
  assert.match(source, /updatePrivateSeasonPlan/);
  assert.match(source, /recordPrivateSeasonGateDecision/);
  assert.match(source, /requireVerifiedRecentAuthentication/);
  assert.match(source, /expectedRevision/);
  assert.match(source, /collection\('changes'\)/);
  assert.match(source, /collection\('decisions'\)/);
  assert.match(source, /createHash\('sha256'\)/);
  assert.match(source, /CURRENT_BUILD_ID_PATTERN/);
  assert.match(source, /buildId\.endsWith\('-local'\)/);
  assert.match(source, /draftStatus: 'invalid-id'/);
  assert.doesNotMatch(source, /automaticPromotion|setAppCheck|queueMode:\s*'primary'/);
});

test('private-season UI is admin-guarded, mobile-first, inline, and omits contact-detail fields', async () => {
  const [routes, template, styles, adminTemplate] = await Promise.all([
    read('src/app/app.routes.ts'),
    read('src/app/features/admin/private-season-center/private-season-center.html'),
    read('src/app/features/admin/private-season-center/private-season-center.css'),
    read('src/app/features/admin/admin-center/admin-center.html'),
  ]);

  assert.match(routes, /path: 'admin\/private-season'[\s\S]*?canActivate: \[platformAdminGuard\]/);
  assert.match(adminTemplate, /routerLink="\/admin\/private-season"/);
  assert.match(template, /No email addresses or phone numbers/);
  assert.match(template, /Use nicknames or initials only/);
  assert.match(template, /Approve exact release/);
  assert.match(template, /leagueAssigned\(tester, slot\.slotId\)/);
  assert.doesNotMatch(template, /type="email"|type="tel"|role="dialog"|viewport-overlay/);
  assert.doesNotMatch(styles, /position:\s*(?:fixed|sticky)/);
  assert.match(styles, /@media \(max-width: 640px\)/);
  assert.match(styles, /min-height:\s*var\(--rr-touch-target\)/);
});

test('O1B uses current build identity and has a complete verification chain', async () => {
  const [service, packageSource, freezeSource] = await Promise.all([
    read('src/app/core/operations/private-season.service.ts'),
    read('package.json'),
    read('config/release-freeze/beta-freeze-policy.json'),
  ]);
  const packageJson = JSON.parse(packageSource);
  const freeze = JSON.parse(freezeSource);

  assert.match(service, /BUNDLED_RELEASE_MANIFEST/);
  assert.equal(packageJson.scripts['verify:batcho1b:core'], 'npm run verify:batcho1a-2:core && npm run beta:audit-season-plan && npm run audit:product-copy-density && npm run test:batcho1b:run && npm run validate:release-manifest');
  assert.equal(freeze.releaseLabel, 'Release Candidate 55');
  assert.equal(freeze.scoringRulesVersion, 4);
  assert.equal(freeze.projectionVersion, 11);
  assert.equal(freeze.verificationCommand, 'npm run verify:batcho1e');
  assert.equal(freeze.queueMode, 'shadow');
  assert.equal(freeze.appCheckMode, 'monitor');
});

test('O1B preserves scoring, projections, Rules, indexes, and shadow safety modes', async () => {
  const [scoringRules, scoringEngine, projectionV11, firestoreRules, firestoreIndexes] = await Promise.all([
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/scoring/scoring-engine.ts'),
    read('src/app/core/projection/projection-v11.util.ts'),
    read('firestore.rules'),
    read('firestore.indexes.json'),
  ]);

  assert.equal(createHash('sha256').update(scoringRules).digest('hex'), PROTECTED_SOURCE_HASHES.scoringRules);
  assert.equal(createHash('sha256').update(scoringEngine).digest('hex'), PROTECTED_SOURCE_HASHES.scoringEngine);
  assert.equal(createHash('sha256').update(projectionV11).digest('hex'), PROTECTED_SOURCE_HASHES.projectionV11);
  assert.equal(createHash('sha256').update(firestoreRules).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreRules);
  assert.equal(createHash('sha256').update(firestoreIndexes).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreIndexes);
});

test('roadmap and documentation record partial operational completion rather than claiming live proof', async () => {
  const [roadmap, docsRoadmap, readme, runbook, releaseRunbook] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('README.md'),
    read('docs/RINKRAT_OPERATIONS_O1B_PRIVATE_SEASON_CONTROL_CENTER.md'),
    read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
  ]);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.46/);
  assert.match(roadmap, /\[~\] O1\.1 Freeze the exact 2026–27 tester-season scope/);
  assert.match(roadmap, /\[~\] O1\.2 Recruit and track a diverse tester matrix/);
  assert.match(roadmap, /LOG\.64 2026-08-19 — Completed Operations Batch O1B/);
  assert.match(readme, /Release Candidate 55 \/ Operations Batch O1E/);
  assert.match(runbook, /does not automatically approve/i);
  assert.match(releaseRunbook, /Private Season Control Center/);
});
