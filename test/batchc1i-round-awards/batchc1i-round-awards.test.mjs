import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import {
  buildRegularSeasonRoundRecapLeagueActivity,
} from '../../functions/src/shared/core/league/league-activity.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function skater(name, position = 'C') {
  return {
    assetType: 'skater',
    assetKey: `player:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    position,
    player: { fullName: name },
  };
}

function goalie(teamName = 'Vegas Golden Knights') {
  return {
    assetType: 'team-goalie-unit',
    assetKey: `goalie:${teamName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    position: 'G',
    teamName,
    teamAbbreviation: 'VGK',
  };
}

function teamWindow(ownerId, windows, overrides = {}) {
  const normalized = windows.map((window, index) => {
    const asset = window.asset;
    return {
      ownerId,
      rosterSlotId: `${ownerId}-slot-${index + 1}`,
      cycleNumber: 12,
      status: 'complete',
      fantasyPoints: window.fantasyPoints,
      frozenProjectionPoints: window.frozenProjectionPoints,
      assetKey: asset.assetKey,
      asset,
      ...window.overrides,
    };
  });
  const slotIds = normalized.map((window) => window.rosterSlotId);

  return {
    ownerId,
    cycleNumber: 12,
    expectedRosterSlotIds: slotIds,
    completedWindowCount: slotIds.length,
    totalWindowCount: slotIds.length,
    status: 'complete',
    windows: normalized,
    ...overrides,
  };
}

function matchups() {
  return [
    {
      cycleNumber: 12,
      phase: 'regular_season',
      teamAOwnerId: 'owner-a',
      teamBOwnerId: 'owner-b',
      teamAScore: 58,
      teamBScore: 54,
      winnerOwnerId: 'owner-a',
      status: 'complete',
    },
    {
      cycleNumber: 12,
      phase: 'regular_season',
      teamAOwnerId: 'owner-c',
      teamBOwnerId: 'owner-d',
      teamAScore: 43,
      teamBScore: 61,
      winnerOwnerId: 'owner-d',
      status: 'complete',
    },
  ];
}

function windows() {
  return [
    teamWindow('owner-a', [
      { asset: skater('Pickup Hero'), fantasyPoints: 26, frozenProjectionPoints: 42 },
      { asset: skater('Steady Center'), fantasyPoints: 14, frozenProjectionPoints: 18 },
    ]),
    teamWindow('owner-b', [
      { asset: skater('Favorite Wing', 'RW'), fantasyPoints: 22, frozenProjectionPoints: 48 },
      { asset: skater('Favorite Defense', 'D'), fantasyPoints: 16, frozenProjectionPoints: 28 },
    ]),
    teamWindow('owner-c', [
      { asset: skater('Quiet Skater'), fantasyPoints: 13, frozenProjectionPoints: 22 },
      { asset: goalie(), fantasyPoints: 35, frozenProjectionPoints: 25 },
    ]),
    teamWindow('owner-d', [
      { asset: skater('Round Star'), fantasyPoints: 31, frozenProjectionPoints: 26 },
      { asset: skater('Winning Wing', 'LW'), fantasyPoints: 19, frozenProjectionPoints: 24 },
    ]),
  ];
}

function acquisition(ownerId, asset, type = 'add-open-slot', overrides = {}) {
  return {
    type,
    ownerId,
    winningOwnerId: type === 'waiver-award' ? ownerId : undefined,
    addedAsset: asset,
    waiverAsset: type === 'waiver-award' ? asset : undefined,
    effectiveCycleNumber: 12,
    ...overrides,
  };
}

test('C1I publishes Pickup of the Round and Biggest Upset from completed server evidence', () => {
  const result = buildRegularSeasonRoundRecapLeagueActivity(
    matchups(),
    null,
    true,
    windows(),
    [acquisition('owner-a', skater('Pickup Hero'))],
    true,
  );

  assert.ok(result);
  assert.equal(result.topPickupScore, 26);
  assert.equal(result.topPickupTieCount, 1);
  assert.equal(result.topPickups[0]?.ownerId, 'owner-a');
  assert.equal(result.topPickups[0]?.asset.name, 'Pickup Hero');
  assert.equal(result.upsetWinnerOwnerId, 'owner-a');
  assert.equal(result.upsetLoserOwnerId, 'owner-b');
  assert.equal(result.upsetProjectionGap, 16);
  assert.equal(result.upsetWinnerProjection, 60);
  assert.equal(result.upsetLoserProjection, 76);
  assert.equal(result.activity.recapUpsetWinnerProjection, 60);
  assert.equal(result.activity.recapUpsetLoserProjection, 76);

  const serialized = JSON.stringify(result.activity);
  for (const forbidden of ['rosterSlotId', 'transactionId', 'gameScores', 'claim', 'waiverPriority']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('Pickup of the Round recognizes completed adds, waiver awards, and activated queued moves only', () => {
  const candidates = windows();
  candidates[0].windows[0].fantasyPoints = 28;
  candidates[1].windows[0].fantasyPoints = 29;
  candidates[3].windows[1].fantasyPoints = 30;

  const result = buildRegularSeasonRoundRecapLeagueActivity(
    matchups(),
    null,
    true,
    candidates,
    [
      acquisition('owner-a', skater('Pickup Hero')),
      acquisition('owner-b', skater('Favorite Wing', 'RW'), 'waiver-award'),
      acquisition('owner-d', skater('Winning Wing', 'LW'), 'slot-move-activated'),
      acquisition('owner-c', skater('Quiet Skater'), 'queue-add-open-slot'),
      acquisition('owner-c', goalie(), 'add-open-slot'),
      acquisition('owner-d', skater('Round Star'), 'add-open-slot', { effectiveCycleNumber: 11 }),
    ],
    true,
  );

  assert.ok(result);
  assert.equal(result.topPickupScore, 30);
  assert.equal(result.topPickups[0]?.asset.name, 'Winning Wing');
});

test('Pickup ties are deterministic, display-bounded, and retain the complete tie count', () => {
  const tiedWindows = windows();
  for (const [index, entry] of tiedWindows.entries()) {
    entry.windows[0].fantasyPoints = 30;
    entry.windows[0].asset = skater(['Zulu', 'Alpha', 'Delta', 'Beta'][index]);
    entry.windows[0].assetKey = entry.windows[0].asset.assetKey;
  }
  const transactions = tiedWindows.map((entry) =>
    acquisition(entry.ownerId, entry.windows[0].asset),
  );

  const result = buildRegularSeasonRoundRecapLeagueActivity(
    matchups(), null, true, tiedWindows, transactions, true,
  );

  assert.ok(result);
  assert.equal(result.topPickupTieCount, 4);
  assert.equal(result.topPickups.length, 3);
  assert.deepEqual(result.topPickups.map((pickup) => pickup.asset.name), ['Alpha', 'Beta', 'Delta']);
});

test('pickup evidence fails optional-award closed without suppressing the core recap', () => {
  const malformed = acquisition('owner-a', skater('Pickup Hero'));
  delete malformed.ownerId;

  const malformedResult = buildRegularSeasonRoundRecapLeagueActivity(
    matchups(), null, true, windows(), [malformed], true,
  );
  const overBoundResult = buildRegularSeasonRoundRecapLeagueActivity(
    matchups(), null, true, windows(), [acquisition('owner-a', skater('Pickup Hero'))], false,
  );

  for (const result of [malformedResult, overBoundResult]) {
    assert.ok(result);
    assert.deepEqual(result.topPickups, []);
    assert.equal(result.topPickupScore, null);
    assert.equal(result.activity.recapTopPickups, undefined);
    assert.equal(result.topPerformers.length > 0, true);
  }
});

test('Biggest Upset chooses the largest frozen-projection deficit with deterministic tie-breaking', () => {
  const result = buildRegularSeasonRoundRecapLeagueActivity(matchups(), null, true, windows());

  assert.ok(result);
  // owner-a was projected 60 against owner-b at 76; owner-d was projected 50
  // against owner-c at 47, so only owner-a is a projected underdog winner.
  assert.equal(result.upsetWinnerOwnerId, 'owner-a');
  assert.equal(result.upsetLoserOwnerId, 'owner-b');
  assert.equal(result.upsetProjectionGap, 16);
});

test('Biggest Upset is omitted for favorite wins, ties, or incomplete frozen projection evidence', () => {
  const favoriteWins = matchups().map((matchup) => ({ ...matchup }));
  favoriteWins[0] = {
    ...favoriteWins[0],
    teamAScore: 54,
    teamBScore: 58,
    winnerOwnerId: 'owner-b',
  };
  const incompleteProjection = windows();
  incompleteProjection[0].windows[0].frozenProjectionPoints = null;

  const favoriteResult = buildRegularSeasonRoundRecapLeagueActivity(
    favoriteWins, null, true, windows(),
  );
  const incompleteResult = buildRegularSeasonRoundRecapLeagueActivity(
    matchups(), null, true, incompleteProjection,
  );

  assert.ok(favoriteResult);
  assert.equal(favoriteResult.upsetWinnerOwnerId, null);
  assert.ok(incompleteResult);
  assert.equal(incompleteResult.upsetWinnerOwnerId, null);
  assert.equal(incompleteResult.activity.recapUpsetProjectionGap, undefined);
});

test('retained non-expected windows cannot win pickup awards or alter upset projections', () => {
  const values = windows();
  values[0].windows.push({
    ownerId: 'owner-a',
    rosterSlotId: 'retired-slot',
    cycleNumber: 12,
    status: 'complete',
    fantasyPoints: 999,
    frozenProjectionPoints: 999,
    assetKey: skater('Retired Pickup').assetKey,
    asset: skater('Retired Pickup'),
  });

  const result = buildRegularSeasonRoundRecapLeagueActivity(
    matchups(), null, true, values, [acquisition('owner-a', skater('Retired Pickup'))], true,
  );

  assert.ok(result);
  assert.deepEqual(result.topPickups, []);
  assert.equal(result.upsetProjectionGap, 16);
});

test('the existing recap publisher performs one bounded cycle transaction query and publishes C1I', async () => {
  const source = await read('functions/src/league-activity.ts');
  const triggerStart = source.indexOf('export const publishLeagueRoundRecapActivity');
  const triggerEnd = source.indexOf('export const publishLeagueWaiverPrivacy', triggerStart);
  const publisher = source.slice(triggerStart, triggerEnd);

  assert.match(publisher, /where\('effectiveCycleNumber', '==', cycleNumber\)/);
  assert.match(publisher, /limit\(MAX_ROUND_RECAP_TRANSACTION_DOCUMENTS \+ 1\)/);
  assert.match(publisher, /transactionValuesComplete/);
  assert.match(publisher, /recap\.upsetProjectionGap/);
  assert.match(publisher, /release: 'Social Batch C1I'/);
  assert.equal((source.match(/publishLeagueRoundRecapActivity = onDocumentUpdated/g) ?? []).length, 1);
  assert.doesNotMatch(publisher, /onDocumentCreated|onCall\(/);
});

test('League Wire renders compact Pickup and Biggest Upset lines without another listener', async () => {
  const [model, service, component, activityService, template, styles] = await Promise.all([
    read('src/app/core/league/league-activity.models.ts'),
    read('src/app/core/league/league-activity.service.ts'),
    read('src/app/features/leagues/league-wire/league-wire.ts'),
    read('src/app/core/league/league-activity.service.ts'),
    read('src/app/features/leagues/league-wire/league-wire.html'),
    read('src/app/features/leagues/league-wire/league-wire.css'),
  ]);

  assert.match(model, /recapTopPickups: LeagueActivityRecapPickup\[\]/);
  assert.match(model, /recapUpsetProjectionGap: number \| null/);
  assert.match(service, /hasRecapUpsetFields/);
  assert.match(component, /Pickup of the Round/);
  assert.match(component, /Biggest upset:/);
  assert.match(component, /projected underdog/);
  assert.equal((activityService.match(/onSnapshot\(/g) ?? []).length, 2);
  assert.doesNotMatch(template, /Pickup of the Round/);
  assert.match(styles, /league-wire-detail-recap[\s\S]*?white-space:\s*pre-line/);
  assert.doesNotMatch(styles, /position:\s*(?:fixed|sticky)|backdrop-filter/i);
});

test('C1I remains compatible with the RC36 release while preserving competitive models, Rules, indexes, and safety modes', async () => {
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
  assert.match(runtime, /Release Candidate 45/);
  assert.match(productionRuntime, /Release Candidate 45/);
  assert.equal(freeze.scoringRulesVersion, 3);
  assert.equal(freeze.projectionVersion, 11);
  assert.equal(freeze.requiredGamesPerRosterSlot, 6);
  assert.equal(freeze.queueMode, 'shadow');
  assert.equal(freeze.appCheckMode, 'monitor');
  assert.equal(freeze.verificationCommand, 'npm run verify:batcha1g');
  assert.equal(freeze.defaultTag, 'rinkrat-rc45-invite-beta');
  assert.equal(appCheck.mode, 'monitor');
  assert.equal(canary.automaticPromotion, false);
  assert.equal(cache.mode, 'shadow');
  assert.equal(cache.authoritativeReadsEnabled, false);
  assert.match(packageJson.scripts['verify:batcha1a:core'], /verify:batchc1l:core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batcha1g:core/);
});

test('C1I documentation and roadmap complete the bounded recap and site-first workflow', async () => {
  const [roadmap, docsRoadmap, runbook, readme, releaseRunbook] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_SOCIAL_C1I_ROUND_AWARDS.md'),
    read('README.md'),
    read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
  ]);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.36/);
  assert.match(roadmap, /# \[x\] C1\.21/);
  assert.match(roadmap, /# \[x\] C1\.22/);
  assert.match(roadmap, /# \[x\] LOG\.44/);
  assert.match(runbook, /Pickup of the Round/);
  assert.match(runbook, /Biggest Upset/);
  assert.match(runbook, /256-document bound/);
  assert.match(runbook, /functions:publishLeagueRoundRecapActivity/);
  assert.doesNotMatch(runbook, /--only firestore:rules/);
  assert.match(readme, /Release Candidate 45 \/ Product Batch A1G/);
  assert.match(readme, /RINKRAT_SOCIAL_C1I_ROUND_AWARDS\.md/);
  assert.match(releaseRunbook, /npm run verify:batcha1g/);
  assert.match(releaseRunbook, /rinkrat-rc45-validation\.json/);
  assert.match(releaseRunbook, /rinkrat-rc45-invite-beta/);
});
