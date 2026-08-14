import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import {
  LEAGUE_ACTIVITY_REACTION_MAX_CHANGES_PER_WINDOW,
  LEAGUE_ACTIVITY_REACTION_MAX_COUNT,
  LEAGUE_ACTIVITY_REACTION_MIN_INTERVAL_MILLISECONDS,
  LEAGUE_ACTIVITY_REACTION_TYPES,
  applyLeagueActivityReactionSelection,
  emptyLeagueActivityReactionCounts,
  evaluateLeagueActivityReactionRateLimit,
  isLeagueActivityReactionEligibleEventType,
  normalizeLeagueActivityReactionRecords,
  normalizeLeagueActivityReactionType,
  summarizeLeagueActivityReactionRecords,
} from '../../functions/src/shared/core/league/league-activity-reaction.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function reactionRecord(ownerId, reactionType, milliseconds = 1_000) {
  const changedAt = new Date(milliseconds);
  return {
    ownerId,
    reactionType,
    firstChangedAt: changedAt,
    updatedAt: changedAt,
  };
}

test('C1G exposes exactly four bounded hockey reactions', () => {
  assert.deepEqual(LEAGUE_ACTIVITY_REACTION_TYPES, [
    'stick-tap',
    'fire',
    'wow',
    'rink-rat',
  ]);
  assert.equal(LEAGUE_ACTIVITY_REACTION_MAX_COUNT, 32);
  assert.equal(normalizeLeagueActivityReactionType('stick-tap'), 'stick-tap');
  assert.equal(normalizeLeagueActivityReactionType('fire'), 'fire');
  assert.equal(normalizeLeagueActivityReactionType('wow'), 'wow');
  assert.equal(normalizeLeagueActivityReactionType('rink-rat'), 'rink-rat');
  assert.equal(normalizeLeagueActivityReactionType('thumbs-up'), null);
  assert.equal(normalizeLeagueActivityReactionType(''), null);
});

test('public reaction records stay bounded, unique, and fail closed when malformed', () => {
  assert.deepEqual(normalizeLeagueActivityReactionRecords(undefined), []);

  const records = [
    reactionRecord('owner-b', 'fire', 2_000),
    reactionRecord('owner-a', 'stick-tap', 1_000),
  ];
  assert.deepEqual(
    normalizeLeagueActivityReactionRecords(records)?.map((record) => record.ownerId),
    ['owner-a', 'owner-b'],
  );
  assert.equal(normalizeLeagueActivityReactionRecords({}), null);
  assert.equal(normalizeLeagueActivityReactionRecords([
    reactionRecord('owner-a', 'fire'),
    reactionRecord('owner-a', 'wow'),
  ]), null);
  assert.equal(normalizeLeagueActivityReactionRecords([
    { ...reactionRecord('owner-a', 'fire'), reactionType: 'unsafe' },
  ]), null);
  assert.equal(normalizeLeagueActivityReactionRecords([
    { ...reactionRecord('owner-a', 'fire'), updatedAt: null },
  ]), null);
  assert.equal(normalizeLeagueActivityReactionRecords(
    Array.from({ length: 33 }, (_, index) => reactionRecord(`owner-${index}`, 'wow')),
  ), null);
});

test('reaction summaries are derived from member records instead of trusting browser totals', () => {
  const counts = summarizeLeagueActivityReactionRecords([
    reactionRecord('owner-a', 'stick-tap'),
    reactionRecord('owner-b', 'fire'),
    reactionRecord('owner-c', 'fire'),
    reactionRecord('owner-d', 'rink-rat'),
  ]);

  assert.deepEqual(counts, {
    'stick-tap': 1,
    fire: 2,
    wow: 0,
    'rink-rat': 1,
  });
  assert.deepEqual(summarizeLeagueActivityReactionRecords([]), emptyLeagueActivityReactionCounts());
});

test('one manager selection adds, switches, removes, and retries idempotently', () => {
  const added = applyLeagueActivityReactionSelection({
    records: [],
    ownerId: 'owner-a',
    desiredReactionType: 'stick-tap',
    changedAt: new Date(1_000),
  });
  assert.equal(added?.changed, true);
  assert.equal(added?.previousReactionType, null);
  assert.equal(added?.nextReactionType, 'stick-tap');
  assert.deepEqual(added?.nextCounts, {
    'stick-tap': 1,
    fire: 0,
    wow: 0,
    'rink-rat': 0,
  });

  const replay = applyLeagueActivityReactionSelection({
    records: added?.nextRecords,
    ownerId: 'owner-a',
    desiredReactionType: 'stick-tap',
    changedAt: new Date(2_000),
  });
  assert.equal(replay?.changed, false);
  assert.deepEqual(replay?.nextRecords, added?.nextRecords);

  const switched = applyLeagueActivityReactionSelection({
    records: added?.nextRecords,
    ownerId: 'owner-a',
    desiredReactionType: 'fire',
    changedAt: new Date(3_000),
  });
  assert.equal(switched?.previousReactionType, 'stick-tap');
  assert.equal(switched?.nextReactionType, 'fire');
  assert.deepEqual(switched?.nextCounts, {
    'stick-tap': 0,
    fire: 1,
    wow: 0,
    'rink-rat': 0,
  });

  const removed = applyLeagueActivityReactionSelection({
    records: switched?.nextRecords,
    ownerId: 'owner-a',
    desiredReactionType: null,
    changedAt: new Date(4_000),
  });
  assert.equal(removed?.nextReactionType, null);
  assert.deepEqual(removed?.nextRecords, []);
});

test('a full activity cannot silently exceed the league-sized reaction bound', () => {
  const records = Array.from(
    { length: LEAGUE_ACTIVITY_REACTION_MAX_COUNT },
    (_, index) => reactionRecord(`owner-${index}`, 'wow'),
  );

  assert.equal(applyLeagueActivityReactionSelection({
    records,
    ownerId: 'owner-new',
    desiredReactionType: 'fire',
    changedAt: new Date(5_000),
  }), null);

  const switchAtCapacity = applyLeagueActivityReactionSelection({
    records,
    ownerId: 'owner-0',
    desiredReactionType: 'fire',
    changedAt: new Date(5_000),
  });
  assert.equal(switchAtCapacity?.nextRecords.length, LEAGUE_ACTIVITY_REACTION_MAX_COUNT);
  assert.equal(switchAtCapacity?.nextReactionType, 'fire');
});

test('reaction writes have both a short throttle and a bounded minute window', () => {
  const first = evaluateLeagueActivityReactionRateLimit({
    control: {
      lastChangedAtMilliseconds: null,
      windowStartedAtMilliseconds: null,
      changesInWindow: 0,
    },
    nowMilliseconds: 10_000,
  });
  assert.equal(first?.allowed, true);
  assert.equal(first?.nextControl.changesInWindow, 1);

  const tooFast = evaluateLeagueActivityReactionRateLimit({
    control: first?.nextControl,
    nowMilliseconds: 10_000 + LEAGUE_ACTIVITY_REACTION_MIN_INTERVAL_MILLISECONDS - 1,
  });
  assert.equal(tooFast?.allowed, false);
  assert.equal(tooFast?.retryAfterMilliseconds, 1);

  const capped = evaluateLeagueActivityReactionRateLimit({
    control: {
      lastChangedAtMilliseconds: 50_000,
      windowStartedAtMilliseconds: 1_000,
      changesInWindow: LEAGUE_ACTIVITY_REACTION_MAX_CHANGES_PER_WINDOW,
    },
    nowMilliseconds: 51_000,
  });
  assert.equal(capped?.allowed, false);
  assert.ok((capped?.retryAfterMilliseconds ?? 0) > 0);

  const reset = evaluateLeagueActivityReactionRateLimit({
    control: {
      lastChangedAtMilliseconds: 50_000,
      windowStartedAtMilliseconds: 1_000,
      changesInWindow: LEAGUE_ACTIVITY_REACTION_MAX_CHANGES_PER_WINDOW,
    },
    nowMilliseconds: 61_001,
  });
  assert.equal(reset?.allowed, true);
  assert.equal(reset?.nextControl.changesInWindow, 1);
});

test('C1G.1 narrows the nullable rate-window timestamp before arithmetic', async () => {
  const source = await read(
    'functions/src/shared/core/league/league-activity-reaction.util.ts',
  );

  assert.match(
    source,
    /const windowStartedAtMilliseconds = control\.windowStartedAtMilliseconds;/,
  );
  assert.match(
    source,
    /windowStartedAtMilliseconds === null \|\|[\s\S]*?nowMilliseconds - windowStartedAtMilliseconds/,
  );
  assert.doesNotMatch(
    source,
    /nowMilliseconds - control\.windowStartedAtMilliseconds/,
  );
});

test('reactions stay limited to celebratory competitive and commissioner-announcement events', () => {
  for (const eventType of [
    'draft-pick',
    'add-drop',
    'waiver-award',
    'matchup-result',
    'commissioner-announcement',
    'matchup-round-recap',
  ]) {
    assert.equal(isLeagueActivityReactionEligibleEventType(eventType), true, eventType);
  }

  for (const eventType of [
    'league-created',
    'member-joined',
    'league-presentation-updated',
    'draft-settings-saved',
    'commissioner-draft-clock-paused',
    'commissioner-availability-override-set',
    'pinned-announcement',
  ]) {
    assert.equal(isLeagueActivityReactionEligibleEventType(eventType), false, eventType);
  }
});

test('the callable is verified-member-only, idempotent, rate-limited, and updates one activity document', async () => {
  const [publisher, index, functionsPackageSource] = await Promise.all([
    read('functions/src/league-activity.ts'),
    read('functions/src/index.ts'),
    read('functions/package.json'),
  ]);
  const functionsPackage = JSON.parse(functionsPackageSource);

  assert.match(publisher, /export const setLeagueActivityReaction = onCall/);
  assert.match(publisher, /requireAuthenticatedUserId\(request\.auth, actionLabel\)/);
  assert.match(publisher, /requireVerifiedEmail\(request\.auth, actionLabel\)/);
  assert.match(publisher, /Only current league members can react/);
  assert.match(publisher, /activity\['authority'\] !== 'league-activity-authority'/);
  assert.match(publisher, /normalizeLeagueActivityReactionRecords/);
  assert.match(publisher, /applyLeagueActivityReactionSelection/);
  assert.match(publisher, /evaluateLeagueActivityReactionRateLimit/);
  assert.match(publisher, /activityReactionControls\/current/);
  assert.match(publisher, /reactionRecords: transition\.nextRecords/);
  assert.match(publisher, /reactionCounts: transition\.nextCounts/);
  assert.match(publisher, /reactionAuthority: 'league-activity-reaction-authority'/);
  assert.match(publisher, /logger\.info\('League Wire reaction changed\.'/);
  assert.doesNotMatch(publisher, /members\/\$\{userId\}\/activityReactions/);
  assert.match(index, /setLeagueActivityReaction/);
  assert.match(functionsPackage.scripts.logs, /setLeagueActivityReaction/);
});

test('the browser keeps the original two League Wire listeners and derives the current manager reaction from the activity document', async () => {
  const [activityService, reactionService, component, detailTemplate] = await Promise.all([
    read('src/app/core/league/league-activity.service.ts'),
    read('src/app/core/league/league-activity-reaction.service.ts'),
    read('src/app/features/leagues/league-wire/league-wire.ts'),
    read('src/app/features/leagues/league-detail/league-detail.html'),
  ]);

  assert.match(activityService, /orderBy\('occurredAt', 'desc'\)/);
  assert.match(activityService, /limit\(LEAGUE_ACTIVITY_LIMIT\)/);
  assert.match(activityService, /normalizeReactionRecords/);
  assert.match(activityService, /reactionCounts: summarizeReactionRecords\(reactionRecords\)/);
  assert.equal((activityService.match(/onSnapshot\(/g) ?? []).length, 2);
  assert.doesNotMatch(activityService, /listenToMyLeagueActivityReactions|my-activity-reactions/);
  assert.match(reactionService, /httpsCallable/);
  assert.match(reactionService, /setLeagueActivityReaction/);
  assert.match(component, /activity\.reactionRecords\.find/);
  assert.match(component, /applyReactionResult/);
  assert.match(detailTemplate, /\[userId\]="userId"/);
});

test('League Wire uses a compact inline picker without a modal, sticky panel, or extra data listener', async () => {
  const [template, styles, reactionService] = await Promise.all([
    read('src/app/features/leagues/league-wire/league-wire.html'),
    read('src/app/features/leagues/league-wire/league-wire.css'),
    read('src/app/core/league/league-activity-reaction.service.ts'),
  ]);

  assert.match(reactionService, /emoji: '🏒'/);
  assert.match(reactionService, /emoji: '🔥'/);
  assert.match(reactionService, /emoji: '😮'/);
  assert.match(reactionService, /emoji: '🐀'/);
  assert.match(template, /'React'/);
  assert.match(template, /league-wire-reaction-picker/);
  assert.match(template, /aria-pressed/);
  assert.match(template, /reactionAriaLabel/);
  assert.match(template, /chooseReaction\(item, option\)/);
  assert.match(template, /reactions are visible only to league members/i);
  assert.match(styles, /league-wire-reaction-chip,[\s\S]*?league-wire-reaction-toggle[\s\S]*?min-height:\s*44px/);
  assert.match(styles, /league-wire-reaction-option[\s\S]*?min-height:\s*44px/);
  assert.match(styles, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(template, /role="dialog"|viewport-overlay|action-sheet|innerHTML/i);
  assert.doesNotMatch(styles, /position:\s*(?:fixed|sticky)|backdrop-filter/i);
});

test('C1G advances RC33 while preserving competitive models, Rules, indexes, and inactive safety controls', async () => {
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
  assert.match(runtime, /Release Candidate 33/);
  assert.match(productionRuntime, /Release Candidate 33/);
  assert.equal(freeze.scoringRulesVersion, 3);
  assert.equal(freeze.projectionVersion, 11);
  assert.equal(freeze.requiredGamesPerRosterSlot, 6);
  assert.equal(freeze.queueMode, 'shadow');
  assert.equal(freeze.appCheckMode, 'monitor');
  assert.equal(freeze.verificationCommand, 'npm run verify:batchc1g');
  assert.equal(freeze.defaultTag, 'rinkrat-rc33-invite-beta');
  assert.equal(appCheck.mode, 'monitor');
  assert.equal(canary.automaticPromotion, false);
  assert.equal(cache.mode, 'shadow');
  assert.equal(cache.authoritativeReadsEnabled, false);
  assert.match(packageJson.scripts['verify:batchc1g:core'], /verify:batchc1f:core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batchc1g:core/);
});

test('C1G documentation and roadmap record the bounded two-listener feature and site-first proof', async () => {
  const [roadmap, docsRoadmap, runbook, readme, releaseRunbook] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_SOCIAL_C1G_LEAGUE_WIRE_REACTIONS.md'),
    read('README.md'),
    read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
  ]);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.24\.1/);
  assert.match(roadmap, /# \[x\] C1\.4/);
  assert.match(roadmap, /# \[x\] C1\.19/);
  assert.match(roadmap, /# \[x\] LOG\.39/);
  assert.match(roadmap, /# \[x\] LOG\.40/);
  assert.match(runbook, /four reactions/i);
  assert.match(runbook, /C1G\.1 TypeScript build hotfix/);
  assert.match(runbook, /same two Firestore listeners/i);
  assert.match(runbook, /one automated verification gate/i);
  assert.match(runbook, /functions:setLeagueActivityReaction/);
  assert.doesNotMatch(runbook, /--only firestore:rules/);
  assert.match(runbook, /Site-first smoke test/);
  assert.match(readme, /Release Candidate 33 \/ Social Batch C1G/);
  assert.match(readme, /RINKRAT_SOCIAL_C1G_LEAGUE_WIRE_REACTIONS\.md/);
  assert.match(releaseRunbook, /npm run verify:batchc1g/);
  assert.match(releaseRunbook, /rinkrat-rc33-validation\.json/);
  assert.match(releaseRunbook, /rinkrat-rc33-invite-beta/);
});
