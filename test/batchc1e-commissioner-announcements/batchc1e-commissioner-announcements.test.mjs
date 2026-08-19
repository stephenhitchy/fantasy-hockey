import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import {
  buildCommissionerAnnouncementLeagueActivity,
  getLeagueActivityDocumentId,
  normalizeLeagueAnnouncementText,
} from '../../functions/src/shared/core/league/league-activity.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

test('announcement text is plain, bounded, normalized, and preserves intentional short lines', () => {
  const normalized = normalizeLeagueAnnouncementText({
    title: '  Draft\u200B   Night Reminder  ',
    body: '\r\n  Be online by 6:45.  \r\n  Queue a player if needed.\t \r\n',
  });

  assert.deepEqual(normalized, {
    title: 'Draft Night Reminder',
    body: 'Be online by 6:45.\nQueue a player if needed.',
    valid: true,
  });
  assert.equal(normalizeLeagueAnnouncementText({
    title: 'x'.repeat(73),
    body: 'Valid message',
  }).valid, false);
  assert.equal(normalizeLeagueAnnouncementText({
    title: 'Valid title',
    body: 'x'.repeat(501),
  }).valid, false);
  assert.equal(normalizeLeagueAnnouncementText({
    title: 'Valid title',
    body: Array.from({ length: 9 }, (_, index) => `Line ${index + 1}`).join('\n'),
  }).valid, false);
  assert.equal(normalizeLeagueAnnouncementText({ title: '', body: 'Message' }).valid, false);
});

test('the server builder accepts only the live commissioner and returns a sanitized activity', () => {
  const activity = buildCommissionerAnnouncementLeagueActivity({
    ownerId: 'commissioner-owner',
    title: '  League update ',
    body: 'Waivers process at noon.\nGood luck this week.',
    requestId: 'private-request-id',
    leagueId: 'private-league-id',
    internalNote: 'Never publish this.',
  }, 'commissioner-owner');

  assert.ok(activity);
  assert.equal(activity.category, 'announcement');
  assert.equal(activity.eventType, 'commissioner-announcement');
  assert.equal(activity.ownerId, 'commissioner-owner');
  assert.equal(activity.announcementTitle, 'League update');
  assert.equal(activity.announcementBody, 'Waivers process at noon.\nGood luck this week.');

  const serialized = JSON.stringify(activity);
  assert.equal(serialized.includes('private-request-id'), false);
  assert.equal(serialized.includes('private-league-id'), false);
  assert.equal(serialized.includes('Never publish this'), false);
  assert.equal(buildCommissionerAnnouncementLeagueActivity({
    ownerId: 'ordinary-manager',
    title: 'Not allowed',
    body: 'This should fail closed.',
  }, 'commissioner-owner'), null);
});

test('announcement activity identity is deterministic without exposing the raw request identifier', () => {
  const first = getLeagueActivityDocumentId('announcement', 'announcement-private-request-123');
  const second = getLeagueActivityDocumentId('announcement', 'announcement-private-request-123');

  assert.equal(first, second);
  assert.match(first, /^activity-[a-f0-9]{40}$/);
  assert.equal(first.includes('announcement-private-request-123'), false);
});

test('the publish callable verifies identity, commissioner authority, idempotency, and rate control', async () => {
  const [publisher, index, functionsPackageSource] = await Promise.all([
    read('functions/src/league-activity.ts'),
    read('functions/src/index.ts'),
    read('functions/package.json'),
  ]);
  const functionsPackage = JSON.parse(functionsPackageSource);

  assert.match(publisher, /export const publishLeagueAnnouncement = onCall/);
  assert.match(publisher, /requireAuthenticatedUserId\(request\.auth, actionLabel\)/);
  assert.match(publisher, /requireVerifiedEmail\(request\.auth, actionLabel\)/);
  assert.match(publisher, /commissionerId !== userId/);
  assert.match(publisher, /Only the league commissioner can post an announcement/);
  assert.match(publisher, /getLeagueActivityDocumentId\('announcement', input\.requestId\)/);
  assert.match(publisher, /payloadHash/);
  assert.match(publisher, /if \(activitySnapshot\.exists\)/);
  assert.match(publisher, /idempotentReplay: true/);
  assert.match(publisher, /ANNOUNCEMENT_RATE_LIMIT_MILLISECONDS = 10_000/);
  assert.match(publisher, /resource-exhausted/);
  assert.match(publisher, /transaction\.create\(activityReference/);
  assert.match(publisher, /release: 'Social Batch C1E'/);
  assert.match(index, /publishLeagueAnnouncement/);
  assert.match(functionsPackage.scripts.logs, /publishLeagueAnnouncement/);
});

test('optional pinning uses one exact activity document without duplicating the ordered feed', async () => {
  const [publisher, service] = await Promise.all([
    read('functions/src/league-activity.ts'),
    read('src/app/core/league/league-activity.service.ts'),
  ]);

  assert.match(publisher, /PINNED_ANNOUNCEMENT_DOCUMENT_ID = 'pinned-announcement'/);
  assert.match(publisher, /announcementOccurredAt:/);
  assert.match(publisher, /pinnedAt: FieldValue\.serverTimestamp\(\)/);
  assert.doesNotMatch(
    publisher.match(/function pinnedAnnouncementDocument[\s\S]*?\n}/)?.[0] ?? '',
    /\n\s*occurredAt:/,
  );
  assert.match(service, /orderBy\('occurredAt', 'desc'\)/);
  assert.match(service, /limit\(LEAGUE_ACTIVITY_LIMIT\)/);
  assert.match(service, /'pinned-announcement'/);
  assert.match(service, /monitorFirestoreListener\('league:pinned-announcement'/);
  assert.match(service, /announcementOccurredAt/);
  assert.equal((service.match(/onSnapshot\(/g) ?? []).length, 2);
});

test('unpinning is commissioner-only and removes only the pin snapshot', async () => {
  const publisher = await read('functions/src/league-activity.ts');
  const match = publisher.match(/export const unpinLeagueAnnouncement = onCall[\s\S]*?\n\);\n\nasync function publishProjectionIfMissing/);

  assert.ok(match);
  assert.match(match[0], /requireAuthenticatedUserId/);
  assert.match(match[0], /requireVerifiedEmail/);
  assert.match(match[0], /Only the league commissioner can unpin an announcement/);
  assert.match(match[0], /transaction\.delete\(pinnedReference\)/);
  assert.doesNotMatch(match[0], /transaction\.delete\(activityReference\)/);
  assert.match(match[0], /unpinned: pinnedSnapshot\.exists/);
});

test('League Wire provides an inline commissioner composer and readable member-only pin on mobile', async () => {
  const [component, template, styles, detailTemplate, clientService] = await Promise.all([
    read('src/app/features/leagues/league-wire/league-wire.ts'),
    read('src/app/features/leagues/league-wire/league-wire.html'),
    read('src/app/features/leagues/league-wire/league-wire.css'),
    read('src/app/features/leagues/league-detail/league-detail.html'),
    read('src/app/core/league/league-announcement.service.ts'),
  ]);

  assert.match(detailTemplate, /\[isCommissioner\]="isCommissioner\(\)"/);
  assert.match(component, /readonly isCommissioner = input\(false\)/);
  assert.match(component, /publishLeagueAnnouncement/);
  assert.match(component, /unpinCurrentAnnouncement/);
  assert.match(template, /Post announcement/);
  assert.match(template, /Pin at the top/);
  assert.match(template, /Pinned announcement/);
  assert.match(template, /maxlength="72"/);
  assert.match(template, /maxlength="500"/);
  assert.match(template, /\{\{ pinned\.title \}\}/);
  assert.match(template, /\{\{ pinned\.body \}\}/);
  assert.match(styles, /white-space: pre-line/);
  assert.match(styles, /league-wire-compose-toggle[\s\S]*?min-height:\s*44px/);
  assert.match(styles, /league-wire-form-actions \.rr-button[\s\S]*?min-height:\s*44px/);
  assert.match(styles, /league-wire-unpin[\s\S]*?min-height:\s*44px/);
  assert.match(clientService, /httpsCallable/);
  assert.doesNotMatch(template, /innerHTML|role="dialog"|viewport-overlay|action-sheet/i);
  assert.doesNotMatch(styles, /position:\s*(?:fixed|sticky)|backdrop-filter/i);
});

test('C1E remains intact under RC34 while preserving competitive models, Rules, indexes, and safety modes', async () => {
  const [
    scoringRules,
    scoringEngine,
    projectionV11,
    firestoreRules,
    firestoreIndexes,
    runtime,
    productionRuntime,
    freezeSource,
    appCheckSource,
    canarySource,
    cacheSource,
    packageSource,
  ] = await Promise.all([
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/scoring/scoring-engine.ts'),
    read('src/app/core/projection/projection-v11.util.ts'),
    read('firestore.rules'),
    read('firestore.indexes.json'),
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('config/release-freeze/beta-freeze-policy.json'),
    read('config/app-check-enforcement-readiness.json'),
    read('config/app-check-callable-canary.json'),
    read('config/nhl-shared-cache-policy.json'),
    read('package.json'),
  ]);
  const freeze = JSON.parse(freezeSource);
  const appCheck = JSON.parse(appCheckSource);
  const canary = JSON.parse(canarySource);
  const cache = JSON.parse(cacheSource);
  const packageJson = JSON.parse(packageSource);

  assert.equal(createHash('sha256').update(scoringRules).digest('hex'), PROTECTED_SOURCE_HASHES.scoringRules);
  assert.equal(createHash('sha256').update(scoringEngine).digest('hex'), PROTECTED_SOURCE_HASHES.scoringEngine);
  assert.equal(createHash('sha256').update(projectionV11).digest('hex'), PROTECTED_SOURCE_HASHES.projectionV11);
  assert.equal(createHash('sha256').update(firestoreRules).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreRules);
  assert.equal(createHash('sha256').update(firestoreIndexes).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreIndexes);
  assert.match(runtime, /Release Candidate 52/);
  assert.match(productionRuntime, /Release Candidate 52/);
  assert.equal(freeze.scoringRulesVersion, 4);
  assert.equal(freeze.projectionVersion, 11);
  assert.equal(freeze.requiredGamesPerRosterSlot, 6);
  assert.equal(freeze.queueMode, 'shadow');
  assert.equal(freeze.appCheckMode, 'monitor');
  assert.equal(freeze.verificationCommand, 'npm run verify:batcho1b');
  assert.equal(appCheck.mode, 'monitor');
  assert.equal(canary.automaticPromotion, false);
  assert.equal(cache.mode, 'shadow');
  assert.equal(cache.authoritativeReadsEnabled, false);
  assert.match(packageJson.scripts['verify:batchc1e:core'], /verify:batchc1d:core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batcho1b:core/);
});

test('C1E documentation and roadmap record announcements, pinning, and the site-first workflow', async () => {
  const [roadmap, docsRoadmap, runbook, readme, releaseRunbook] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_SOCIAL_C1E_COMMISSIONER_ANNOUNCEMENTS.md'),
    read('README.md'),
    read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
  ]);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.43/);
  assert.match(roadmap, /# \[x\] C1\.3/);
  assert.match(roadmap, /# \[x\] C1\.17/);
  assert.match(roadmap, /# \[x\] LOG\.37/);
  assert.match(runbook, /1–72 characters/);
  assert.match(runbook, /1–500 characters/);
  assert.match(runbook, /one exact-document listener/i);
  assert.match(runbook, /one automated verification gate/i);
  assert.match(runbook, /functions:publishLeagueAnnouncement,functions:unpinLeagueAnnouncement/);
  assert.match(runbook, /Do not deploy Firestore Rules, indexes, TTL configuration/);
  assert.match(runbook, /Site-first smoke test/);
  assert.match(readme, /Release Candidate 52 \/ Operations Batch O1B/);
  assert.match(readme, /RINKRAT_SOCIAL_C1E_COMMISSIONER_ANNOUNCEMENTS\.md/);
  assert.match(releaseRunbook, /npm run verify:batcho1b/);
  assert.match(releaseRunbook, /rinkrat-rc52-validation\.json/);
  assert.match(releaseRunbook, /rinkrat-rc52-invite-beta/);
});

test('the clean C1E package contains no abandoned record-milestone batch', async () => {
  const testDirectories = await readdir(new URL('../', import.meta.url));
  const [publisher, utility] = await Promise.all([
    read('functions/src/league-activity.ts'),
    read('functions/src/shared/core/league/league-activity.util.ts'),
  ]);

  assert.equal(testDirectories.includes('batchc1e-record-milestones'), false);
  assert.doesNotMatch(publisher, /buildLeagueMatchupMilestoneDecision|socialState\/matchupMilestones/);
  assert.doesNotMatch(utility, /LeagueMatchupMilestone|matchupNewLeagueHighScore|matchupNewClosestFinish/);
});
