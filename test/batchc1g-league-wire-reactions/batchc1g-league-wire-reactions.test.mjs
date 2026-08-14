import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import {
  LEAGUE_ACTIVITY_REACTION_CATALOG_VERSION,
  LEAGUE_ACTIVITY_REACTION_FAVORITES,
  LEAGUE_ACTIVITY_REACTION_MAX_BYTES,
  LEAGUE_ACTIVITY_REACTION_MAX_CHANGES_PER_WINDOW,
  LEAGUE_ACTIVITY_REACTION_MAX_COUNT,
  LEAGUE_ACTIVITY_REACTION_MIN_INTERVAL_MILLISECONDS,
  LEAGUE_EMOJI_SET,
  applyLeagueActivityReactionSelection,
  emptyLeagueActivityReactionCounts,
  evaluateLeagueActivityReactionRateLimit,
  isLeagueActivityReactionEligibleEventType,
  normalizeLeagueActivityReactionRecords,
  normalizeLeagueActivityReactionType,
  summarizeLeagueActivityReactionRecords,
} from '../../functions/src/shared/core/league/league-activity-reaction.util.ts';
import {
  LEAGUE_EMOJI_CATALOG,
  LEAGUE_EMOJI_CATALOG_VERSION as CLIENT_EMOJI_CATALOG_VERSION,
  LEAGUE_EMOJI_GROUPS,
} from '../../src/app/core/league/league-emoji-catalog.generated.ts';
const ROOT = new URL('../../', import.meta.url);
const EXPECTED_EMOJI_COUNT = 3_944;

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

test('C1G.2 accepts the complete locally generated Unicode Emoji 17 catalog', () => {
  assert.equal(LEAGUE_ACTIVITY_REACTION_CATALOG_VERSION, '17.0');
  assert.equal(CLIENT_EMOJI_CATALOG_VERSION, '17.0');
  assert.equal(LEAGUE_EMOJI_CATALOG.length, EXPECTED_EMOJI_COUNT);
  assert.equal(LEAGUE_EMOJI_SET.size, EXPECTED_EMOJI_COUNT);
  assert.deepEqual(LEAGUE_EMOJI_GROUPS, [
    'Smileys & Emotion',
    'People & Body',
    'Animals & Nature',
    'Food & Drink',
    'Travel & Places',
    'Activities',
    'Objects',
    'Symbols',
    'Flags',
  ]);
  assert.deepEqual(LEAGUE_ACTIVITY_REACTION_FAVORITES, ['rr_stick_tap', 'rr_on_fire', 'rr_no_way', 'rr_rink_rat', 'rr_laugh']);

  for (const emoji of ['🤣', '🏆', '👩🏽‍💻', '🏳️‍🌈', '🇺🇸', '#️⃣']) {
    assert.equal(LEAGUE_EMOJI_SET.has(emoji), true, emoji);
    assert.equal(normalizeLeagueActivityReactionType(emoji), emoji, emoji);
  }
  assert.equal(LEAGUE_EMOJI_SET.has('🏒'), true);
  assert.equal(normalizeLeagueActivityReactionType('🏒'), 'rr_stick_tap');
  assert.equal(normalizeLeagueActivityReactionType('🔥'), 'rr_on_fire');
  assert.equal(normalizeLeagueActivityReactionType('😮'), 'rr_no_way');
  assert.equal(normalizeLeagueActivityReactionType('🐀'), 'rr_rink_rat');
  assert.equal(normalizeLeagueActivityReactionType('😂'), 'rr_laugh');

  assert.equal(normalizeLeagueActivityReactionType('rr_stick_tap'), 'rr_stick_tap');
  assert.equal(normalizeLeagueActivityReactionType('rr_on_fire'), 'rr_on_fire');
  assert.equal(normalizeLeagueActivityReactionType('rr_no_way'), 'rr_no_way');
  assert.equal(normalizeLeagueActivityReactionType('rr_rink_rat'), 'rr_rink_rat');
  assert.equal(normalizeLeagueActivityReactionType('rr_laugh'), 'rr_laugh');
  assert.equal(normalizeLeagueActivityReactionType('stick-tap'), 'rr_stick_tap');
  assert.equal(normalizeLeagueActivityReactionType('fire'), 'rr_on_fire');
  assert.equal(normalizeLeagueActivityReactionType('wow'), 'rr_no_way');
  assert.equal(normalizeLeagueActivityReactionType('rink-rat'), 'rr_rink_rat');
  assert.equal(normalizeLeagueActivityReactionType('thumbs-up'), null);
  assert.equal(normalizeLeagueActivityReactionType('😀😀'), null);
  assert.equal(normalizeLeagueActivityReactionType(''), null);
  assert.ok(
    Math.max(...LEAGUE_EMOJI_CATALOG.map(([emoji]) => Buffer.byteLength(emoji, 'utf8'))) <=
      LEAGUE_ACTIVITY_REACTION_MAX_BYTES,
  );
});

test('the generated client catalog and server allowlist stay exactly synchronized', () => {
  const clientEmoji = LEAGUE_EMOJI_CATALOG.map(([emoji]) => emoji);
  assert.equal(new Set(clientEmoji).size, clientEmoji.length);
  assert.deepEqual(new Set(clientEmoji), LEAGUE_EMOJI_SET);
  assert.ok(LEAGUE_EMOJI_CATALOG.every(([, label, groupIndex]) =>
    label.length > 0 &&
    Number.isInteger(groupIndex) &&
    groupIndex >= 0 &&
    groupIndex < LEAGUE_EMOJI_GROUPS.length));
});

test('public reaction records stay bounded, unique, canonical, and fail closed when malformed', () => {
  assert.deepEqual(normalizeLeagueActivityReactionRecords(undefined), []);

  const records = [
    reactionRecord('owner-b', '😂', 2_000),
    reactionRecord('owner-a', 'stick-tap', 1_000),
  ];
  const normalized = normalizeLeagueActivityReactionRecords(records);
  assert.deepEqual(normalized?.map((record) => record.ownerId), ['owner-a', 'owner-b']);
  assert.deepEqual(normalized?.map((record) => record.reactionType), ['rr_stick_tap', 'rr_laugh']);
  assert.equal(normalizeLeagueActivityReactionRecords({}), null);
  assert.equal(normalizeLeagueActivityReactionRecords([
    reactionRecord('owner-a', '🔥'),
    reactionRecord('owner-a', '😮'),
  ]), null);
  assert.equal(normalizeLeagueActivityReactionRecords([
    { ...reactionRecord('owner-a', '🔥'), reactionType: 'unsafe' },
  ]), null);
  assert.equal(normalizeLeagueActivityReactionRecords([
    { ...reactionRecord('owner-a', '🔥'), updatedAt: null },
  ]), null);
  assert.equal(normalizeLeagueActivityReactionRecords(
    Array.from({ length: 33 }, (_, index) => reactionRecord(`owner-${index}`, '😮')),
  ), null);
});

test('reaction summaries are dynamic and derived from member records instead of browser totals', () => {
  const counts = summarizeLeagueActivityReactionRecords([
    reactionRecord('owner-a', 'rr_stick_tap'),
    reactionRecord('owner-b', '😂'),
    reactionRecord('owner-c', '😂'),
    reactionRecord('owner-d', '🏆'),
  ]);

  assert.deepEqual(counts, {
    rr_stick_tap: 1,
    rr_laugh: 2,
    '🏆': 1,
  });
  assert.deepEqual(summarizeLeagueActivityReactionRecords([]), emptyLeagueActivityReactionCounts());
});

test('one manager selection adds, switches, removes, and retries idempotently', () => {
  const added = applyLeagueActivityReactionSelection({
    records: [],
    ownerId: 'owner-a',
    desiredReactionType: 'rr_laugh',
    changedAt: new Date(1_000),
  });
  assert.equal(added?.changed, true);
  assert.equal(added?.previousReactionType, null);
  assert.equal(added?.nextReactionType, 'rr_laugh');
  assert.deepEqual(added?.nextCounts, { rr_laugh: 1 });

  const replay = applyLeagueActivityReactionSelection({
    records: added?.nextRecords,
    ownerId: 'owner-a',
    desiredReactionType: 'rr_laugh',
    changedAt: new Date(2_000),
  });
  assert.equal(replay?.changed, false);
  assert.deepEqual(replay?.nextRecords, added?.nextRecords);

  const switched = applyLeagueActivityReactionSelection({
    records: added?.nextRecords,
    ownerId: 'owner-a',
    desiredReactionType: '🏆',
    changedAt: new Date(3_000),
  });
  assert.equal(switched?.previousReactionType, 'rr_laugh');
  assert.equal(switched?.nextReactionType, '🏆');
  assert.deepEqual(switched?.nextCounts, { '🏆': 1 });

  const removed = applyLeagueActivityReactionSelection({
    records: switched?.nextRecords,
    ownerId: 'owner-a',
    desiredReactionType: null,
    changedAt: new Date(4_000),
  });
  assert.equal(removed?.nextReactionType, null);
  assert.deepEqual(removed?.nextRecords, []);
  assert.deepEqual(removed?.nextCounts, {});
});

test('a full activity cannot silently exceed the league-sized reaction bound', () => {
  const records = Array.from(
    { length: LEAGUE_ACTIVITY_REACTION_MAX_COUNT },
    (_, index) => reactionRecord(`owner-${index}`, '😮'),
  );

  assert.equal(applyLeagueActivityReactionSelection({
    records,
    ownerId: 'owner-new',
    desiredReactionType: '😂',
    changedAt: new Date(5_000),
  }), null);

  const switchAtCapacity = applyLeagueActivityReactionSelection({
    records,
    ownerId: 'owner-0',
    desiredReactionType: '🏆',
    changedAt: new Date(5_000),
  });
  assert.equal(switchAtCapacity?.nextRecords.length, LEAGUE_ACTIVITY_REACTION_MAX_COUNT);
  assert.equal(switchAtCapacity?.nextReactionType, '🏆');
});

test('reaction writes keep the existing short throttle and bounded minute window', () => {
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

test('C1G.1 nullable rate-window TypeScript narrowing remains intact', async () => {
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

test('the callable validates against the exact catalog and preserves member authority and rate controls', async () => {
  const [publisher, index, functionsPackageSource, reactionUtility] = await Promise.all([
    read('functions/src/league-activity.ts'),
    read('functions/src/index.ts'),
    read('functions/package.json'),
    read('functions/src/shared/core/league/league-activity-reaction.util.ts'),
  ]);
  const functionsPackage = JSON.parse(functionsPackageSource);

  assert.match(reactionUtility, /LEAGUE_EMOJI_SET\.has\(normalized\)/);
  assert.match(reactionUtility, /LEGACY_REACTION_TYPE_MAP/);
  assert.match(reactionUtility, /QUICK_REACTION_TYPE_SET/);
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
  assert.match(publisher, /reactionRelease: 'Social Batch C1G\.3'/);
  assert.match(publisher, /logger\.info\('League Wire reaction changed\.'/);
  assert.doesNotMatch(publisher, /members\/\$\{userId\}\/activityReactions/);
  assert.match(index, /setLeagueActivityReaction/);
  assert.match(functionsPackage.scripts.logs, /setLeagueActivityReaction/);
});

test('the browser keeps two League Wire listeners and lazy-loads the local emoji catalog only when the picker opens', async () => {
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
  assert.match(reactionService, /import\('\.\/league-emoji-catalog\.generated'\)/);
  assert.match(reactionService, /emojiCatalogPromise \?\?=/);
  assert.doesNotMatch(reactionService, /fetch\(|emoji-picker-element|https?:\/\//);
  assert.match(component, /void this\.ensureEmojiCatalogLoaded\(\)/);
  assert.match(component, /activity\.reactionRecords\.find/);
  assert.match(component, /applyReactionResult/);
  assert.match(detailTemplate, /\[userId\]="userId"/);
});

test('League Wire provides custom quick icons, search, categories, pagination, bounded summaries, and an inline phone-safe picker', async () => {
  const [template, styles, component] = await Promise.all([
    read('src/app/features/leagues/league-wire/league-wire.html'),
    read('src/app/features/leagues/league-wire/league-wire.css'),
    read('src/app/features/leagues/league-wire/league-wire.ts'),
  ]);

  assert.match(template, /Search emojis/);
  assert.match(template, /Emoji \{\{ emojiCatalogVersion\(\) \}\}/);
  assert.match(template, /league-wire-emoji-categories/);
  assert.match(template, />\s*Quick picks\s*</);
  assert.match(template, /visibleEmojiOptions\(\)/);
  assert.match(template, /league-wire-reaction-icon/);
  assert.match(template, /showMoreEmojis\(\)/);
  assert.match(template, /aria-pressed/);
  assert.match(template, /reactionAriaLabel/);
  assert.match(template, /chooseReaction\(item, option\)/);
  assert.match(template, /reactions are visible only to league members/i);
  assert.match(component, /const REACTION_SUMMARY_LIMIT = 8;/);
  assert.match(component, /const EMOJI_PICKER_PAGE_SIZE = 48;/);
  assert.match(styles, /league-wire-reaction-option[\s\S]*?min-height:\s*44px/);
  assert.match(styles, /league-wire-reaction-icon-large/);
  assert.match(styles, /grid-template-columns:\s*repeat\(auto-fill, minmax\(44px, 1fr\)\)/);
  assert.match(styles, /overflow-x:\s*auto/);
  assert.doesNotMatch(template, /role="dialog"|viewport-overlay|action-sheet|innerHTML/i);
  assert.doesNotMatch(styles, /position:\s*(?:fixed|sticky)|backdrop-filter/i);
});

test('C1G.3 keeps legacy reactions readable while migrating them to custom quick IDs on change', async () => {
  const [clientUtility, activityService, serverUtility] = await Promise.all([
    read('src/app/core/league/league-activity-reaction.util.ts'),
    read('src/app/core/league/league-activity.service.ts'),
    read('functions/src/shared/core/league/league-activity-reaction.util.ts'),
  ]);

  for (const source of [clientUtility, serverUtility]) {
    assert.match(source, /'stick-tap': 'rr_stick_tap'/);
    assert.match(source, /fire: 'rr_on_fire'/);
    assert.match(source, /wow: 'rr_no_way'/);
    assert.match(source, /'rink-rat': 'rr_rink_rat'/);
    assert.match(source, /'😂': 'rr_laugh'/);
  }
  assert.match(activityService, /normalizeLeagueActivityReactionType\(source\['reactionType'\]\)/);
  assert.match(serverUtility, /reactionType: desiredReactionType/);
});

test('C1G.3 remains RC33 and preserves competitive models, Rules, indexes, and inactive safety controls', async () => {
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

test('C1G.3 documentation and roadmap record the custom quick icons, full local catalog, and site-first proof', async () => {
  const [roadmap, docsRoadmap, runbook, readme, releaseRunbook] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_SOCIAL_C1G_LEAGUE_WIRE_REACTIONS.md'),
    read('README.md'),
    read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
  ]);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.24\.3/);
  assert.match(roadmap, /# \[x\] C1\.4/);
  assert.match(roadmap, /# \[x\] C1\.19/);
  assert.match(roadmap, /# \[x\] LOG\.39/);
  assert.match(roadmap, /# \[x\] LOG\.40/);
  assert.match(roadmap, /# \[x\] LOG\.41/);
  assert.match(runbook, /3,944 fully-qualified Emoji 17\.0 sequences/);
  assert.match(runbook, /C1G\.3 custom quick reactions/);
  assert.match(runbook, /lazy-load/i);
  assert.match(runbook, /same two Firestore listeners/i);
  assert.match(runbook, /one automated verification gate/i);
  assert.match(runbook, /functions:setLeagueActivityReaction/);
  assert.doesNotMatch(runbook, /--only firestore:rules/);
  assert.match(runbook, /Site-first smoke test/);
  assert.match(readme, /Release Candidate 33 \/ Social Batch C1G\.3/);
  assert.match(readme, /RINKRAT_SOCIAL_C1G_LEAGUE_WIRE_REACTIONS\.md/);
  assert.match(releaseRunbook, /C1G\.3/);
  assert.match(releaseRunbook, /npm run verify:batchc1g/);
  assert.match(releaseRunbook, /rinkrat-rc33-validation\.json/);
  assert.match(releaseRunbook, /rinkrat-rc33-invite-beta/);
});
