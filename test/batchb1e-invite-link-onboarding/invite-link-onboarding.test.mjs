import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  PENDING_LEAGUE_INVITE_MAX_AGE_MS,
  bindPendingLeagueInviteToAccount,
  buildLeagueInvitePath,
  buildLeagueInviteUrl,
  clearPendingLeagueInvite,
  isValidLeagueInviteCode,
  markPendingLeagueInviteRequiresTrainingCamp,
  markPendingLeagueInviteTrainingCampComplete,
  normalizeLeagueInviteCode,
  pendingLeagueInviteAccountMatch,
  readPendingLeagueInvite,
  startPendingLeagueInvite,
  unbindPendingLeagueInviteAccount,
} from '../../src/app/core/league/invite-link-intent.service.ts';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test.afterEach(() => {
  clearPendingLeagueInvite();
});

test('invite codes and canonical links use the existing six-character contract', () => {
  assert.equal(normalizeLeagueInviteCode(' ab7k9q '), 'AB7K9Q');
  assert.equal(isValidLeagueInviteCode('AB7K9Q'), true);
  assert.equal(isValidLeagueInviteCode('RINK-4729'), false);
  assert.equal(buildLeagueInvitePath('ab7k9q'), '/join/AB7K9Q');
  assert.equal(
    buildLeagueInviteUrl('ab7k9q'),
    'https://rinkratfantasy.com/join/AB7K9Q',
  );
  assert.equal(buildLeagueInviteUrl('bad'), '');
});

test('a deliberate invite intent persists for a bounded 72-hour continuation window', () => {
  const now = 1_800_000_000_000;
  const started = startPendingLeagueInvite('ICE123', { now });

  assert.ok(started);
  assert.equal(started.inviteCode, 'ICE123');
  assert.equal(started.accountUid, null);
  assert.equal(started.requiresTrainingCamp, false);
  assert.equal(started.expiresAt - started.requestedAt, PENDING_LEAGUE_INVITE_MAX_AGE_MS);
  assert.deepEqual(readPendingLeagueInvite('ICE123', now + 1_000), started);
  assert.equal(
    readPendingLeagueInvite('ICE123', now + PENDING_LEAGUE_INVITE_MAX_AGE_MS),
    null,
  );
});

test('account binding prevents silent account switching but allows explicit confirmation', () => {
  startPendingLeagueInvite('ICE123');
  const first = bindPendingLeagueInviteToAccount('user-a', { inviteCode: 'ICE123' });

  assert.ok(first);
  assert.equal(pendingLeagueInviteAccountMatch(first, 'user-a'), 'matching');
  assert.equal(pendingLeagueInviteAccountMatch(first, 'user-b'), 'mismatch');
  assert.equal(
    bindPendingLeagueInviteToAccount('user-b', { inviteCode: 'ICE123' }),
    null,
  );

  const confirmed = bindPendingLeagueInviteToAccount('user-b', {
    inviteCode: 'ICE123',
    allowAccountSwitch: true,
  });
  assert.ok(confirmed);
  assert.equal(confirmed.accountUid, 'user-b');

  const unbound = unbindPendingLeagueInviteAccount('ICE123');
  assert.ok(unbound);
  assert.equal(pendingLeagueInviteAccountMatch(unbound, 'user-a'), 'unbound');
});

test('new-account Training Camp state can only be completed by the bound account', () => {
  startPendingLeagueInvite('ICE123');
  bindPendingLeagueInviteToAccount('new-user', { inviteCode: 'ICE123' });

  const required = markPendingLeagueInviteRequiresTrainingCamp('new-user', 'ICE123');
  assert.ok(required);
  assert.equal(required.requiresTrainingCamp, true);
  assert.equal(
    markPendingLeagueInviteTrainingCampComplete('wrong-user', 'ICE123'),
    null,
  );

  const complete = markPendingLeagueInviteTrainingCampComplete('new-user', 'ICE123');
  assert.ok(complete);
  assert.equal(complete.requiresTrainingCamp, false);
});

test('the public route sits outside the authenticated shell and loads a dedicated invite page', async () => {
  const routes = await read('src/app/app.routes.ts');
  const publicInviteIndex = routes.indexOf("path: 'join/:inviteCode'");
  const authenticatedShellIndex = routes.indexOf('canActivate: [authGuard]');

  assert.ok(publicInviteIndex > 0 && publicInviteIndex < authenticatedShellIndex);
  assert.match(routes, /path: 'join\/:inviteCode'[\s\S]*?LeagueInviteLink/);
});

test('opening a link cannot mutate membership until Join League is deliberately pressed', async () => {
  const [component, template] = await Promise.all([
    read('src/app/features/leagues/invite-link/invite-link.ts'),
    read('src/app/features/leagues/invite-link/invite-link.html'),
  ]);

  assert.match(template, /Opening this page never joins you automatically/);
  assert.match(template, /\(click\)="beginJoin\(\)"[\s\S]*?Join League/);
  assert.match(component, /async beginJoin\(\)[\s\S]*?startPendingLeagueInvite/);
  assert.match(component, /private async initialize\(\)[\s\S]*?readPendingLeagueInvite/);
  assert.doesNotMatch(component, /constructor\([\s\S]{0,1200}startPendingLeagueInvite/);
});

test('saved invitations continue through auth, Training Camp, verification, and the existing secure join', async () => {
  const [invite, authPage, trainingCamp, leagueService, emailService] = await Promise.all([
    read('src/app/features/leagues/invite-link/invite-link.ts'),
    read('src/app/features/auth/auth.ts'),
    read('src/app/features/onboarding/training-camp/training-camp.ts'),
    read('src/app/core/league/league.service.ts'),
    read('src/app/core/notifications/email-notification.service.ts'),
  ]);

  assert.match(authPage, /readPendingLeagueInvite/);
  assert.match(authPage, /markPendingLeagueInviteRequiresTrainingCamp/);
  assert.match(authPage, /continue: 'league-invite'/);
  assert.match(trainingCamp, /markPendingLeagueInviteTrainingCampComplete/);
  assert.match(trainingCamp, /navigateByUrl\(invitePath\)/);
  assert.match(invite, /requestVerificationEmail/);
  assert.match(invite, /user\.reload\(\)/);
  assert.match(invite, /user\.getIdToken\(true\)/);
  assert.match(invite, /joinLeagueByInviteCode\(this\.inviteCode\(\), username\)/);
  assert.match(leagueService, /joinLeagueSecure/);
  assert.match(emailService, /resendVerificationEmail/);
});

test('the invite flow handles account mismatch and retains manual code entry as a fallback', async () => {
  const [invite, inviteTemplate, manualTemplate] = await Promise.all([
    read('src/app/features/leagues/invite-link/invite-link.ts'),
    read('src/app/features/leagues/invite-link/invite-link.html'),
    read('src/app/features/leagues/join-league/join-league.html'),
  ]);

  assert.match(invite, /accountMatch === 'mismatch'/);
  assert.match(inviteTemplate, /Join With This Account/);
  assert.match(inviteTemplate, /Use Another Account/);
  assert.match(manualTemplate, /placeholder="Ex: AB7K9Q"/);
  assert.match(manualTemplate, /maxlength="6"/);
  assert.doesNotMatch(manualTemplate, /RINK-4729/);
});

test('commissioner surfaces copy a canonical invite link while preserving the code fallback', async () => {
  const [detail, detailSource, playbook, playbookSource, messageUtil] = await Promise.all([
    read('src/app/features/leagues/league-detail/league-detail.html'),
    read('src/app/features/leagues/league-detail/league-detail.ts'),
    read('src/app/features/leagues/commissioner-playbook/commissioner-playbook.html'),
    read('src/app/features/leagues/commissioner-playbook/commissioner-playbook.ts'),
    read('src/app/core/league/commissioner-playbook.util.ts'),
  ]);

  assert.match(detail, /Copy Invite Link/);
  assert.match(detail, /Copy Code/);
  assert.match(detailSource, /buildLeagueInviteUrl/);
  assert.match(playbook, /Copy Invite Link/);
  assert.match(playbookSource, /copyInviteLink/);
  assert.match(messageUtil, /Join link:/);
  assert.match(messageUtil, /Invite code:/);
});

test('invite codes are redacted from browser, beta, diagnostic, and CSP route collection', async () => {
  const [browser, functionsIndex, betaOperations, securityOperations] = await Promise.all([
    read('src/app/core/observability/telemetry.service.ts'),
    read('functions/src/index.ts'),
    read('functions/src/beta-operations.ts'),
    read('functions/src/security-operations.ts'),
  ]);

  assert.match(browser, /previous === 'join'[\s\S]*?:inviteCode/);
  assert.match(functionsIndex, /normalizeBetaRoute[\s\S]*?'\/join\/:inviteCode'/);
  assert.match(functionsIndex, /redactDiagnosticText[\s\S]*?\/join\/:inviteCode/);
  assert.match(betaOperations, /function sanitizeRoute[\s\S]*?'\/join\/:inviteCode'/);
  assert.match(securityOperations, /function redactReportPath[\s\S]*?'\/join\/:inviteCode'/);
});

test('the invite page does not add unauthenticated league or invite-document reads', async () => {
  const [component, rules] = await Promise.all([
    read('src/app/features/leagues/invite-link/invite-link.ts'),
    read('firestore.rules'),
  ]);

  assert.doesNotMatch(component, /getLeagueById|getDoc|collection\(|leagueInvites/);
  assert.match(
    rules,
    /match \/leagueInvites\/\{inviteCode\}[\s\S]*?allow read, create, update, delete: if false;/,
  );
});


test('invite links opt out of indexing, referrer leakage, and route caching', async () => {
  const [robots, firebaseSource] = await Promise.all([
    read('public/robots.txt'),
    read('firebase.json'),
  ]);
  const firebase = JSON.parse(firebaseSource);
  const inviteHeaders = firebase.hosting.headers.find((entry) => entry.source === '/join/**');
  const headerMap = new Map(
    (inviteHeaders?.headers ?? []).map((header) => [header.key.toLowerCase(), header.value]),
  );

  assert.match(robots, /Disallow: \/join\//);
  assert.equal(headerMap.get('cache-control'), 'no-store, private');
  assert.equal(headerMap.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.equal(headerMap.get('referrer-policy'), 'no-referrer');
});

test('current release controls inherit B1G as the exact verification gate', async () => {
  const [runtime, productionRuntime, freezeSource, packageSource, readme, runbook] =
    await Promise.all([
      read('src/environments/app-runtime.config.ts'),
      read('src/environments/app-runtime.config.production.ts'),
      read('config/release-freeze/beta-freeze-policy.json'),
      read('package.json'),
      read('README.md'),
      read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
    ]);
  const freeze = JSON.parse(freezeSource);
  const packageJson = JSON.parse(packageSource);

  assert.match(runtime, /Release Candidate 65/);
  assert.match(productionRuntime, /Release Candidate 65/);
  assert.equal(freeze.releaseLabel, 'Release Candidate 65');
  assert.equal(freeze.verificationCommand, 'npm run verify:batchb1j');
  assert.equal(freeze.defaultTag, 'rinkrat-rc65-invite-beta');
  assert.match(packageJson.scripts['security:ci'], /verify:batch(?:b1j|d1j):core/);
  assert.match(readme, /Release Candidate 65 \/ Beta Batch B1J/);
  assert.match(runbook, /npm run verify:batchb1j/);
  assert.match(runbook, /rinkrat-rc65-invite-beta/);
});
