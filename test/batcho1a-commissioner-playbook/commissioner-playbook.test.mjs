import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildCommissionerReadiness,
} from '../../src/app/core/league/commissioner-readiness.util.ts';
import {
  buildCommissionerDraftNightMessage,
  buildCommissionerInviteMessage,
  COMMISSIONER_DRAFT_NIGHT_CHECKLIST,
  COMMISSIONER_RECOVERY_STEPS,
  getCommissionerChecklistProgress,
  normalizeCommissionerChecklistState,
} from '../../src/app/core/league/commissioner-playbook.util.ts';
import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function readinessInput(overrides = {}) {
  return {
    leagueId: 'league-a',
    emailVerified: true,
    teamCount: 8,
    maximumTeams: 8,
    draftStatus: 'scheduled',
    draftSettingsSaved: true,
    draftScheduled: true,
    projectionStatus: 'ready',
    projectionVersion: 11,
    scoringRulesVersion: 4,
    expectedProjectionVersion: 11,
    expectedScoringRulesVersion: 4,
    ...overrides,
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('a filled, scheduled league with a matching verified board is rehearsal-ready', () => {
  const summary = buildCommissionerReadiness(readinessInput());

  assert.equal(summary.status, 'ready');
  assert.equal(summary.readyCount, 5);
  assert.equal(summary.totalCount, 5);
  assert.match(summary.headline, /Ready for a Draft rehearsal/);
  assert.ok(summary.checks.every((check) => check.status === 'ready'));
});

test('commissioner verification is a hard readiness block', () => {
  const summary = buildCommissionerReadiness(readinessInput({ emailVerified: false }));
  const account = summary.checks.find((check) => check.id === 'verified-account');

  assert.equal(summary.status, 'blocked');
  assert.equal(account?.status, 'blocked');
  assert.deepEqual(account?.actionPath, ['/account', 'settings']);
});

test('league filling and Draft setup distinguish blockers from items needing attention', () => {
  const oneTeam = buildCommissionerReadiness(readinessInput({
    teamCount: 1,
    draftSettingsSaved: false,
    draftScheduled: false,
    projectionStatus: 'missing',
    projectionVersion: null,
    scoringRulesVersion: null,
  }));
  const rehearsalLeague = buildCommissionerReadiness(readinessInput({
    teamCount: 4,
    draftSettingsSaved: false,
    draftScheduled: false,
  }));

  assert.equal(oneTeam.status, 'blocked');
  assert.equal(oneTeam.checks.find((check) => check.id === 'league-filled')?.status, 'blocked');
  assert.equal(rehearsalLeague.checks.find((check) => check.id === 'league-filled')?.status, 'attention');
  assert.equal(rehearsalLeague.checks.find((check) => check.id === 'draft-scheduled')?.status, 'attention');
});

test('a Projection V11 board from the wrong scoring version is not declared ready', () => {
  const summary = buildCommissionerReadiness(readinessInput({ scoringRulesVersion: 3 }));
  const board = summary.checks.find((check) => check.id === 'projection-ready');

  assert.equal(summary.status, 'blocked');
  assert.equal(board?.status, 'blocked');
  assert.match(board?.detail ?? '', /Generate and verify|needs attention/i);
  assert.deepEqual(board?.actionPath, ['/leagues', 'league-a', 'projections']);
});

test('live and completed Drafts retain frozen-board readiness without rewriting competition state', () => {
  for (const status of ['live', 'complete']) {
    const summary = buildCommissionerReadiness(readinessInput({
      draftStatus: status,
      draftSettingsSaved: false,
      draftScheduled: false,
      projectionStatus: 'missing',
      projectionVersion: null,
      scoringRulesVersion: null,
    }));

    assert.equal(summary.checks.find((check) => check.id === 'draft-order')?.status, 'ready');
    assert.equal(summary.checks.find((check) => check.id === 'draft-scheduled')?.status, 'ready');
    assert.equal(summary.checks.find((check) => check.id === 'projection-ready')?.status, 'ready');
  }
});

test('O1A.1 accepts string keys from Object.entries without widening the checklist IDs themselves', async () => {
  const source = await read('src/app/core/league/commissioner-playbook.util.ts');

  assert.match(source, /const allowedIds:\s*ReadonlySet<string>/);
  assert.match(source, /allowedIds\.has\(key\)/);
});

test('the device-only checklist is bounded, normalized, and reports progress', () => {
  assert.equal(COMMISSIONER_DRAFT_NIGHT_CHECKLIST.length, 6);
  assert.ok(COMMISSIONER_DRAFT_NIGHT_CHECKLIST.some((item) => item.id === 'backup-device'));
  assert.ok(COMMISSIONER_DRAFT_NIGHT_CHECKLIST.some((item) => item.id === 'deputy-contact'));
  assert.ok(COMMISSIONER_RECOVERY_STEPS.some((step) => /Never manually/.test(step)));

  const normalized = normalizeCommissionerChecklistState({
    'manager-sign-in': true,
    'draft-time-shared': false,
    'unknown-item': true,
  });
  const progress = getCommissionerChecklistProgress(normalized);

  assert.deepEqual(normalized, { 'manager-sign-in': true });
  assert.deepEqual(progress, { complete: 1, total: 6, percent: 17 });
  assert.deepEqual(normalizeCommissionerChecklistState(null), {});
});

test('commissioner messages contain the invite, Draft timing, and safe-action guidance', () => {
  const input = {
    leagueName: 'Rink Rats Invitational',
    inviteCode: 'ICE123',
    inviteUrl: 'https://rinkratfantasy.com/join/ICE123',
    draftTimeLabel: 'Sep 20, 7:00 PM',
    managerCount: 7,
    maximumTeams: 8,
  };
  const invite = buildCommissionerInviteMessage(input);
  const reminder = buildCommissionerDraftNightMessage(input);

  assert.match(invite, /https:\/\/rinkratfantasy\.com\/join\/ICE123/);
  assert.match(invite, /ICE123/);
  assert.match(invite, /7 of 8/);
  assert.match(invite, /six NHL team games/);
  assert.match(invite, /seventh team game/);
  assert.match(reminder, /15 minutes early/);
  assert.match(reminder, /Do not submit the same pick repeatedly/);
});

test('public and league-specific routes use the intended access boundaries', async () => {
  const routes = await read('src/app/app.routes.ts');

  const publicRouteIndex = routes.indexOf("path: 'commissioner-guide'");
  const authenticatedShellIndex = routes.indexOf('canActivate: [authGuard]');
  assert.ok(publicRouteIndex > 0 && publicRouteIndex < authenticatedShellIndex);
  assert.match(routes, /path: 'commissioner-guide'[\s\S]*?CommissionerGuide/);
  assert.match(routes, /path: 'leagues\/:leagueId\/commissioner'[\s\S]*?canActivate: \[leagueMemberGuard, commissionerGuard\]/);
  assert.match(routes, /CommissionerPlaybook/);
});

test('League HQ and Support expose the playbook without adding a modal or sticky surface', async () => {
  const [hq, support, playbook, guide, playbookCss, guideCss] = await Promise.all([
    read('src/app/features/leagues/league-detail/league-detail.html'),
    read('src/app/features/support/support-home/support-home.html'),
    read('src/app/features/leagues/commissioner-playbook/commissioner-playbook.html'),
    read('src/app/features/support/commissioner-guide/commissioner-guide.html'),
    read('src/app/features/leagues/commissioner-playbook/commissioner-playbook.css'),
    read('src/app/features/support/commissioner-guide/commissioner-guide.css'),
  ]);

  assert.match(hq, /Commissioner Playbook/);
  assert.match(hq, /leagueId, 'commissioner'/);
  assert.match(support, /Open Commissioner Guide/);
  assert.match(playbook, /League readiness/);
  assert.match(playbook, /Draft-night checklist/);
  assert.match(playbook, /Copy Invite Link/);
  assert.match(playbook, /Copy Invite Message/);
  assert.match(guide, /Six NHL games per active roster slot/);
  assert.match(guide, /Commissioner FAQ/);
  assert.match(guide, /Protect the competition first/);
  assert.doesNotMatch(playbook + guide, /role="dialog"|viewport-overlay|innerHTML/i);
  assert.doesNotMatch(playbookCss + guideCss, /position:\s*(?:fixed|sticky)|backdrop-filter/i);
});

test('O1A advances to RC51 while preserving Scoring V4, Projection V11, and safety modes', async () => {
  const [
    runtime,
    productionRuntime,
    freezeSource,
    packageSource,
    scoringRules,
    scoringEngine,
    projectionV11,
    firestoreRules,
    firestoreIndexes,
    appCheckSource,
    canarySource,
    cacheSource,
  ] = await Promise.all([
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('config/release-freeze/beta-freeze-policy.json'),
    read('package.json'),
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/scoring/scoring-engine.ts'),
    read('src/app/core/projection/projection-v11.util.ts'),
    read('firestore.rules'),
    read('firestore.indexes.json'),
    read('config/app-check-enforcement-readiness.json'),
    read('config/app-check-callable-canary.json'),
    read('config/nhl-shared-cache-policy.json'),
  ]);
  const freeze = JSON.parse(freezeSource);
  const packageJson = JSON.parse(packageSource);
  const appCheck = JSON.parse(appCheckSource);
  const canary = JSON.parse(canarySource);
  const cache = JSON.parse(cacheSource);

  assert.match(runtime, /Release Candidate 65/);
  assert.match(productionRuntime, /Release Candidate 65/);
  assert.equal(freeze.releaseLabel, 'Release Candidate 65');
  assert.equal(freeze.scoringRulesVersion, 4);
  assert.equal(freeze.projectionVersion, 11);
  assert.equal(freeze.verificationCommand, 'npm run verify:batchb1j');
  assert.equal(freeze.defaultTag, 'rinkrat-rc65-invite-beta');
  assert.match(packageJson.scripts['verify:batcho1a:core'], /verify:batchv4a:core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batchb1j:core/);
  assert.equal(sha256(scoringRules), PROTECTED_SOURCE_HASHES.scoringRules);
  assert.equal(sha256(scoringEngine), PROTECTED_SOURCE_HASHES.scoringEngine);
  assert.equal(sha256(projectionV11), PROTECTED_SOURCE_HASHES.projectionV11);
  assert.equal(sha256(firestoreRules), PROTECTED_SOURCE_HASHES.firestoreRules);
  assert.equal(sha256(firestoreIndexes), PROTECTED_SOURCE_HASHES.firestoreIndexes);
  assert.equal(appCheck.mode, 'monitor');
  assert.equal(canary.automaticPromotion, false);
  assert.equal(cache.mode, 'shadow');
  assert.equal(cache.authoritativeReadsEnabled, false);
});

test('documentation and the permanent roadmap record the bounded commissioner foundation', async () => {
  const [roadmap, docsRoadmap, readme, doc, runbook] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('README.md'),
    read('docs/RINKRAT_OPERATIONS_O1A_COMMISSIONER_PLAYBOOK.md'),
    read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
  ]);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.54/);
  assert.match(roadmap, /O1\.5[\s\S]*?O1A/);
  assert.match(roadmap, /LOG\.62/);
  assert.match(readme, /Release Candidate 65 \/ Beta Batch B1J/);
  assert.match(readme, /RINKRAT_OPERATIONS_O1A_COMMISSIONER_PLAYBOOK\.md/);
  assert.match(doc, /public commissioner guide/i);
  assert.match(doc, /O1A\.1 strict-TypeScript hotfix/);
  assert.match(doc, /league-specific readiness/i);
  assert.match(doc, /device-local/i);
  assert.match(doc, /No Cloud Function/);
  assert.match(runbook, /Release Candidate 65/);
  assert.match(runbook, /Beta Batch B1J/);
  assert.match(runbook, /npm run verify:batchb1j/);
});
