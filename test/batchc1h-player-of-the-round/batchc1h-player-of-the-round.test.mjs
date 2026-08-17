import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import {
  buildRegularSeasonRoundRecapLeagueActivity,
} from '../../functions/src/shared/core/league/league-activity.util.ts';
import {
  normalizeLeagueActivityReactionType,
} from '../../functions/src/shared/core/league/league-activity-reaction.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function matchup(overrides = {}) {
  return {
    cycleNumber: 9,
    phase: 'regular_season',
    teamAOwnerId: 'owner-a',
    teamBOwnerId: 'owner-b',
    teamAScore: 44.25,
    teamBScore: 41.75,
    winnerOwnerId: 'owner-a',
    status: 'complete',
    ...overrides,
  };
}

function round() {
  return [
    matchup(),
    matchup({
      teamAOwnerId: 'owner-c',
      teamBOwnerId: 'owner-d',
      teamAScore: 52.1,
      teamBScore: 39.4,
      winnerOwnerId: 'owner-c',
    }),
  ];
}

function skaterAsset(name, position = 'C') {
  return {
    assetType: 'skater',
    assetKey: `player:${name}`,
    position,
    player: { fullName: name },
  };
}


function goalieAsset(teamName = 'Vegas Golden Knights') {
  return {
    assetType: 'team-goalie-unit',
    assetKey: `goalie:${teamName}`,
    position: 'G',
    teamName,
    teamAbbreviation: 'VGK',
  };
}

function teamWindow(ownerId, fantasyPoints, name, overrides = {}) {
  const rosterSlotId = `${ownerId}-slot-1`;

  return {
    ownerId,
    cycleNumber: 9,
    expectedRosterSlotIds: [rosterSlotId],
    completedWindowCount: 1,
    totalWindowCount: 1,
    status: 'complete',
    windows: [{
      ownerId,
      rosterSlotId,
      cycleNumber: 9,
      status: 'complete',
      fantasyPoints,
      asset: skaterAsset(name),
      ...overrides,
    }],
  };
}

function eligibleTeamWindows() {
  return [
    teamWindow('owner-a', 18.4, 'Auston Matthews'),
    teamWindow('owner-b', 14.2, 'David Pastrnak', { asset: skaterAsset('David Pastrnak', 'RW') }),
    teamWindow('owner-c', 24.75, 'Connor McDavid'),
    teamWindow('owner-d', 17.1, 'Cale Makar', { asset: skaterAsset('Cale Makar', 'D') }),
  ];
}

test('C1H derives one bounded Player of the Round from completed same-cycle slot windows', () => {
  const result = buildRegularSeasonRoundRecapLeagueActivity(
    round(),
    null,
    true,
    eligibleTeamWindows(),
  );

  assert.ok(result);
  assert.equal(result.topPerformerScore, 24.75);
  assert.equal(result.topPerformerTieCount, 1);
  assert.deepEqual(result.topPerformers, [{
    ownerId: 'owner-c',
    asset: {
      name: 'Connor McDavid',
      position: 'C',
      assetType: 'skater',
    },
  }]);
  assert.deepEqual(result.activity.recapTopPerformers, result.topPerformers);
  assert.equal(result.activity.recapTopPerformerScore, 24.75);
  assert.equal(result.activity.recapTopPerformerTieCount, 1);

  const serialized = JSON.stringify(result.activity);
  assert.equal(serialized.includes('rosterSlotId'), false);
  assert.equal(serialized.includes('gameScores'), false);
  assert.equal(serialized.includes('assetKey'), false);
});

test('Player of the Round considers skaters rather than the draftable team-goalie unit', () => {
  const windows = eligibleTeamWindows();
  windows[0] = {
    ...windows[0],
    windows: [{
      ...windows[0].windows[0],
      fantasyPoints: 99,
      asset: goalieAsset(),
    }],
  };

  const result = buildRegularSeasonRoundRecapLeagueActivity(round(), null, true, windows);

  assert.ok(result);
  assert.equal(result.topPerformerScore, 24.75);
  assert.equal(result.topPerformers[0]?.asset.name, 'Connor McDavid');
});

test('Player of the Round ties are deterministic, display-bounded, and retain the full tie count', () => {
  const windows = eligibleTeamWindows().map((entry, index) => ({
    ...entry,
    windows: entry.windows.map((window) => ({
      ...window,
      fantasyPoints: 30,
      asset: skaterAsset(['Zeta Wing', 'Alpha Center', 'Delta Defense', 'Beta Wing'][index]),
    })),
  }));
  const result = buildRegularSeasonRoundRecapLeagueActivity(round(), null, true, windows);

  assert.ok(result);
  assert.equal(result.topPerformerScore, 30);
  assert.equal(result.topPerformerTieCount, 4);
  assert.equal(result.topPerformers.length, 3);
  assert.deepEqual(
    result.topPerformers.map((performer) => performer.asset.name),
    ['Alpha Center', 'Beta Wing', 'Delta Defense'],
  );
});

test('partial, duplicate-owner, mixed-cycle, active, missing-slot, count-mismatch, malformed-score, and malformed-asset windows fail closed', () => {
  const base = eligibleTeamWindows();

  assert.equal(buildRegularSeasonRoundRecapLeagueActivity(round(), null, true, base.slice(0, 3)), null);
  assert.equal(buildRegularSeasonRoundRecapLeagueActivity(round(), null, true, [...base, base[0]]), null);
  assert.equal(buildRegularSeasonRoundRecapLeagueActivity(round(), null, true, [
    { ...base[0], cycleNumber: 8 }, ...base.slice(1),
  ]), null);
  assert.equal(buildRegularSeasonRoundRecapLeagueActivity(round(), null, true, [
    { ...base[0], status: 'active' }, ...base.slice(1),
  ]), null);
  assert.equal(buildRegularSeasonRoundRecapLeagueActivity(round(), null, true, [
    {
      ...base[0],
      expectedRosterSlotIds: ['owner-a-slot-1', 'owner-a-slot-2'],
      completedWindowCount: 2,
      totalWindowCount: 2,
    },
    ...base.slice(1),
  ]), null);
  assert.equal(buildRegularSeasonRoundRecapLeagueActivity(round(), null, true, [
    { ...base[0], completedWindowCount: 0 }, ...base.slice(1),
  ]), null);
  assert.equal(buildRegularSeasonRoundRecapLeagueActivity(round(), null, true, [
    {
      ...base[0],
      windows: [{ ...base[0].windows[0], fantasyPoints: Number.NaN }],
    },
    ...base.slice(1),
  ]), null);
  assert.equal(buildRegularSeasonRoundRecapLeagueActivity(round(), null, true, [
    {
      ...base[0],
      windows: [{ ...base[0].windows[0], asset: { assetType: 'unsafe' } }],
    },
    ...base.slice(1),
  ]), null);
});

test('a retained non-expected historical window cannot win Player of the Round', () => {
  const windows = eligibleTeamWindows();
  windows[0] = {
    ...windows[0],
    windows: [
      ...windows[0].windows,
      {
        ownerId: 'owner-a',
        rosterSlotId: 'retired-slot',
        cycleNumber: 9,
        status: 'complete',
        fantasyPoints: 999,
        asset: skaterAsset('Retired Slot'),
      },
    ],
  };

  const result = buildRegularSeasonRoundRecapLeagueActivity(round(), null, true, windows);

  assert.ok(result);
  assert.equal(result.topPerformerScore, 24.75);
  assert.equal(result.topPerformers[0]?.asset.name, 'Connor McDavid');
});

test('C1H retires custom quick IDs while preserving them as standard-emoji compatibility aliases', () => {
  assert.equal(normalizeLeagueActivityReactionType('rr_stick_tap'), '🏒');
  assert.equal(normalizeLeagueActivityReactionType('rr_on_fire'), '🔥');
  assert.equal(normalizeLeagueActivityReactionType('rr_no_way'), '😮');
  assert.equal(normalizeLeagueActivityReactionType('rr_rink_rat'), '🐀');
  assert.equal(normalizeLeagueActivityReactionType('rr_laugh'), '😂');
  assert.equal(normalizeLeagueActivityReactionType('🏆'), '🏆');
  assert.equal(normalizeLeagueActivityReactionType('unsafe-text'), null);
});

test('the recap publisher reads bounded team windows and publishes C1H through the existing trigger', async () => {
  const publisher = await read('functions/src/league-activity.ts');

  assert.match(publisher, /export const publishLeagueRoundRecapActivity = onDocumentUpdated/);
  assert.match(publisher, /cycles\/\$\{cycleId\}\/teamWindows/);
  assert.match(publisher, /teamWindowSnapshots\.empty/);
  assert.match(publisher, /teamWindowValues/);
  assert.match(publisher, /recap\.topPerformers\.length === 0/);
  assert.match(publisher, /recap\.topPerformerTieCount < recap\.topPerformers\.length/);
  assert.match(publisher, /release: 'Social Batch C1I'/);
  assert.equal((publisher.match(/publishLeagueRoundRecapActivity = onDocumentUpdated/g) ?? []).length, 1);
});

test('League Wire renders Player of the Round as a compact separate recap line', async () => {
  const [model, service, component, template, styles] = await Promise.all([
    read('src/app/core/league/league-activity.models.ts'),
    read('src/app/core/league/league-activity.service.ts'),
    read('src/app/features/leagues/league-wire/league-wire.ts'),
    read('src/app/features/leagues/league-wire/league-wire.html'),
    read('src/app/features/leagues/league-wire/league-wire.css'),
  ]);

  assert.match(model, /recapTopPerformers: LeagueActivityRecapPerformer\[\]/);
  assert.match(service, /normalizeRecapPerformers/);
  assert.match(service, /recapTopPerformerTieCount < recapTopPerformers\.length/);
  assert.match(component, /Player of the Round/);
  assert.match(component, /recapDetails\.join\('\\n'\)/);
  assert.match(template, /league-wire-detail-recap/);
  assert.match(styles, /league-wire-detail-recap[\s\S]*?white-space:\s*pre-line/);
});

test('the phone emoji picker exposes every category and scrolls results without Quick Picks', async () => {
  const [component, template, styles, clientUtility, serverUtility] = await Promise.all([
    read('src/app/features/leagues/league-wire/league-wire.ts'),
    read('src/app/features/leagues/league-wire/league-wire.html'),
    read('src/app/features/leagues/league-wire/league-wire.css'),
    read('src/app/core/league/league-activity-reaction.util.ts'),
    read('functions/src/shared/core/league/league-activity-reaction.util.ts'),
  ]);

  assert.match(template, /league-wire-emoji-category-select/);
  assert.match(template, /selectEmojiGroupFromInput/);
  assert.match(template, /league-wire-emoji-results/);
  assert.match(template, /Scrollable emoji choices/);
  assert.doesNotMatch(template, /Quick picks|option\.assetPath|league-wire-reaction-icon/);
  assert.match(component, /emojiGroupIndex = signal\(0\)/);
  assert.match(component, /selectEmojiGroupFromInput/);
  assert.doesNotMatch(component, /LEAGUE_ACTIVITY_REACTION_OPTIONS|reactionOptions/);
  assert.match(styles, /league-wire-emoji-results[\s\S]*?overflow-y:\s*auto/);
  assert.match(styles, /-webkit-overflow-scrolling:\s*touch/);
  assert.match(styles, /touch-action:\s*pan-y/);
  assert.match(styles, /league-wire-emoji-category-select[\s\S]*?display:\s*grid/);
  assert.match(styles, /league-wire-emoji-categories[\s\S]*?display:\s*none/);
  assert.doesNotMatch(clientUtility, /assets\/reactions|QUICK_REACTIONS/);
  assert.doesNotMatch(serverUtility, /QUICK_REACTION_TYPE_SET|REACTION_FAVORITES/);

  for (const asset of [
    'public/assets/reactions/stick-tap.svg',
    'public/assets/reactions/on-fire.svg',
    'public/assets/reactions/no-way.svg',
    'public/assets/reactions/rink-rat.svg',
    'public/assets/reactions/laugh.svg',
  ]) {
    await assert.rejects(access(new URL(asset, ROOT)));
  }
});

test('C1H advances to RC34 while preserving competitive models, Rules, indexes, and safety modes', async () => {
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
  assert.match(runtime, /Release Candidate 36/);
  assert.match(productionRuntime, /Release Candidate 36/);
  assert.equal(freeze.scoringRulesVersion, 3);
  assert.equal(freeze.projectionVersion, 11);
  assert.equal(freeze.requiredGamesPerRosterSlot, 6);
  assert.equal(freeze.queueMode, 'shadow');
  assert.equal(freeze.appCheckMode, 'monitor');
  assert.equal(freeze.verificationCommand, 'npm run verify:batchc1j');
  assert.equal(freeze.defaultTag, 'rinkrat-rc36-invite-beta');
  assert.equal(appCheck.mode, 'monitor');
  assert.equal(canary.automaticPromotion, false);
  assert.equal(cache.mode, 'shadow');
  assert.equal(cache.authoritativeReadsEnabled, false);
  assert.match(packageJson.scripts['verify:batchc1h:core'], /verify:batchc1g:core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batchc1j:core/);
});

test('C1H documentation and roadmap record the bounded implementation and site-first workflow', async () => {
  const [roadmap, docsRoadmap, runbook, readme, releaseRunbook] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_SOCIAL_C1H_PLAYER_OF_THE_ROUND.md'),
    read('README.md'),
    read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
  ]);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.27/);
  assert.match(roadmap, /# \[x\] C1\.20/);
  assert.match(roadmap, /# \[x\] LOG\.43/);
  assert.match(runbook, /Player of the Round/);
  assert.match(runbook, /native category selector/);
  assert.match(runbook, /overflow-y: auto/);
  assert.match(runbook, /one verification gate/i);
  assert.match(runbook, /functions:publishLeagueRoundRecapActivity,functions:setLeagueActivityReaction/);
  assert.doesNotMatch(runbook, /--only firestore:rules/);
  assert.match(readme, /Release Candidate 36 \/ Social Batch C1J/);
  assert.match(readme, /RINKRAT_SOCIAL_C1H_PLAYER_OF_THE_ROUND\.md/);
  assert.match(releaseRunbook, /npm run verify:batchc1j/);
  assert.match(releaseRunbook, /rinkrat-rc36-validation\.json/);
  assert.match(releaseRunbook, /rinkrat-rc36-invite-beta/);
});
