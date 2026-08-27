import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildLeaguePlayerRosterFitRecommendations,
} from '../../src/app/core/player/league-player-roster-fit.util.ts';
import {
  buildLeaguePowerRankings,
} from '../../src/app/core/league/league-power-rankings.util.ts';
import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function team({
  ownerId,
  teamName,
  wins = 0,
  losses = 0,
  ties = 0,
  pointsFor = 0,
  pointsAgainst = 0,
}) {
  return {
    id: ownerId,
    ownerId,
    teamName,
    managerName: `${teamName} Manager`,
    logo: '',
    wins,
    losses,
    ties,
    pointsFor,
    pointsAgainst,
    waiverPriority: 1,
    draftPosition: 1,
  };
}

function matchup({
  cycleNumber,
  teamAOwnerId,
  teamBOwnerId,
  teamAScore,
  teamBScore,
  status = 'complete',
  phase = 'regular_season',
}) {
  return {
    cycleNumber,
    phase,
    status,
    teamAOwnerId,
    teamBOwnerId,
    teamAScore,
    teamBScore,
    winnerOwnerId: teamAScore === teamBScore
      ? null
      : teamAScore > teamBScore
        ? teamAOwnerId
        : teamBOwnerId,
  };
}

function boardRow({
  key,
  name,
  position,
  status = 'free-agent',
  nextSix = 30,
  rest = 220,
}) {
  return {
    assetKey: key,
    asset: {
      assetType: 'skater',
      assetKey: key,
      position,
      player: {
        id: Number(key.replace(/\D/g, '')) || 1,
        fullName: name,
        nhlTeamAbbreviation: 'EDM',
      },
      projectedCyclePoints: nextSix,
      availabilityAdjustedCyclePoints: nextSix,
      projectedRestOfSeasonPoints: rest,
      reliabilityRating: 80,
      expectedGamesAvailable: 6,
      availabilityStatus: 'active',
    },
    name,
    nhlTeamAbbreviation: 'EDM',
    position,
    logoUrl: null,
    headshotUrl: null,
    status,
    ownership: null,
    watched: false,
    seasonFantasyPoints: 100,
    seasonFantasyPointsPerGame: 5,
    seasonGamesPlayed: 20,
    overallRank: 20,
    positionRank: 6,
    nextSixProjection: nextSix,
    nextSixOverallRank: 20,
    nextSixPositionRank: 5,
    nextSixOverallRankCount: 200,
    nextSixPositionRankCount: 40,
    restOfSeasonProjection: rest,
    projectedFinalSeasonPoints: 320,
    projectionFloor: nextSix - 5,
    projectionCeiling: nextSix + 5,
    reliabilityRating: 80,
    projectionConfidence: 80,
    recentFiveGameFantasyPointsPerGame: 5,
    recentTenGameFantasyPointsPerGame: 5,
    recentTwentyGameFantasyPointsPerGame: 5,
    seasonAverageTimeOnIceMinutes: 18,
    recentAverageTimeOnIceMinutes: 18,
    expectedGamesAvailable: 6,
    expectedGamesMissed: 0,
    scheduleDifficultyLabel: 'Average',
    availabilityLabel: 'Active',
    draftRank: 20,
    cycleRank: 20,
    cyclePositionRank: 5,
    overallRankCount: 200,
    positionRankCount: 40,
  };
}

function rosterAsset(row) {
  return {
    assetType: 'skater',
    assetKey: row.assetKey,
    position: row.position,
    player: row.asset.player,
    cycleScore: { cycleNumber: 1, gamesCounted: 0, fantasyPoints: 0 },
  };
}

function roster({ active = [], bench = [] } = {}) {
  return {
    schemaVersion: 1,
    activeSlots: active,
    benchSlots: bench,
    irSlots: [],
  };
}

test('Roster Fit ignores a weaker different-position Bench player', () => {
  const target = boardRow({ key: 'skater-101', name: 'Center Target', position: 'C', nextSix: 34, rest: 250 });
  const center = boardRow({ key: 'skater-102', name: 'Current Center', position: 'C', status: 'rostered', nextSix: 29, rest: 225 });
  const weakWing = boardRow({ key: 'skater-103', name: 'Weak Wing', position: 'LW', status: 'rostered', nextSix: 12, rest: 90 });
  const leagueRoster = roster({
    active: [
      { slotId: 'C1', position: 'C', slotNumber: 1, asset: rosterAsset(center), pendingMove: null },
    ],
    bench: [
      { slotId: 'B1', slotNumber: 1, asset: rosterAsset(weakWing) },
    ],
  });

  const result = buildLeaguePlayerRosterFitRecommendations({
    rows: [target, center, weakWing],
    roster: leagueRoster,
    requiredGames: 6,
  }).get(target.assetKey);

  assert.equal(result?.comparisonAssetKey, center.assetKey);
  assert.equal(result?.comparisonName, center.name);
  assert.equal(result?.comparisonArea, 'active');
  assert.equal(result?.nextSixEdge, 5);
  assert.doesNotMatch(result?.summary ?? '', /Weak Wing/);
});

test('Roster Fit uses a same-position Bench player when that is the fair replacement', () => {
  const target = boardRow({ key: 'skater-201', name: 'Defense Target', position: 'D', nextSix: 35, rest: 260 });
  const activeDefense = boardRow({ key: 'skater-202', name: 'Active Defense', position: 'D', status: 'rostered', nextSix: 31, rest: 245 });
  const benchDefense = boardRow({ key: 'skater-203', name: 'Bench Defense', position: 'D', status: 'rostered', nextSix: 22, rest: 170 });
  const weakerCenter = boardRow({ key: 'skater-204', name: 'Weaker Center', position: 'C', status: 'rostered', nextSix: 10, rest: 80 });
  const leagueRoster = roster({
    active: [
      { slotId: 'D1', position: 'D', slotNumber: 1, asset: rosterAsset(activeDefense), pendingMove: null },
    ],
    bench: [
      { slotId: 'B1', slotNumber: 1, asset: rosterAsset(benchDefense) },
      { slotId: 'B2', slotNumber: 2, asset: rosterAsset(weakerCenter) },
    ],
  });

  const result = buildLeaguePlayerRosterFitRecommendations({
    rows: [target, activeDefense, benchDefense, weakerCenter],
    roster: leagueRoster,
    requiredGames: 6,
  }).get(target.assetKey);

  assert.equal(result?.comparisonAssetKey, benchDefense.assetKey);
  assert.equal(result?.comparisonArea, 'bench');
  assert.ok(result?.detailLines.some((line) => /same-position bench/.test(line)));
});

test('Roster Fit reports insufficient comparison evidence when no same-position option exists', () => {
  const target = boardRow({ key: 'skater-301', name: 'Right Wing Target', position: 'RW', nextSix: 34, rest: 250 });
  const center = boardRow({ key: 'skater-302', name: 'Only Center', position: 'C', status: 'rostered', nextSix: 12, rest: 90 });
  const leagueRoster = roster({
    active: [
      { slotId: 'C1', position: 'C', slotNumber: 1, asset: rosterAsset(center), pendingMove: null },
    ],
    bench: [],
  });

  const result = buildLeaguePlayerRosterFitRecommendations({
    rows: [target, center],
    roster: leagueRoster,
    requiredGames: 6,
  }).get(target.assetKey);

  assert.equal(result?.comparisonAssetKey, null);
  assert.equal(result?.tier, 'insufficient');
});

test('Add Drop opens in Roster Fit by default and explains exact-position comparison', async () => {
  const [component, template] = await Promise.all([
    read('src/app/features/free-agents/free-agents.ts'),
    read('src/app/features/free-agents/free-agents.html'),
  ]);

  assert.match(component, /boardSortMode = signal<LeaguePlayerBoardSortMode>\('roster-fit'\)/);
  assert.match(component, /: 'roster-fit';\s+this\.boardSortMode\.set\(nextSort\)/);
  assert.match(template, /<option value="roster-fit">Roster fit \(for you\)<\/option>[\s\S]*?<option value="next-six">/);
  assert.match(template, /only with your legal options at that exact position/i);
});

test('Power Rankings reward current strength while remaining separate from official order', () => {
  const teams = [
    team({ ownerId: 'a', teamName: 'Official One', wins: 3, losses: 1, pointsFor: 160, pointsAgainst: 120 }),
    team({ ownerId: 'b', teamName: 'Hot Team', wins: 3, losses: 1, pointsFor: 154, pointsAgainst: 108 }),
    team({ ownerId: 'c', teamName: 'Middle Team', wins: 1, losses: 3, pointsFor: 128, pointsAgainst: 148 }),
    team({ ownerId: 'd', teamName: 'Cold Team', wins: 0, losses: 4, pointsFor: 98, pointsAgainst: 164 }),
  ];
  const matchups = [
    matchup({ cycleNumber: 1, teamAOwnerId: 'a', teamBOwnerId: 'd', teamAScore: 42, teamBScore: 20 }),
    matchup({ cycleNumber: 1, teamAOwnerId: 'b', teamBOwnerId: 'c', teamAScore: 35, teamBScore: 30 }),
    matchup({ cycleNumber: 2, teamAOwnerId: 'b', teamBOwnerId: 'a', teamAScore: 41, teamBScore: 34 }),
    matchup({ cycleNumber: 2, teamAOwnerId: 'c', teamBOwnerId: 'd', teamAScore: 31, teamBScore: 25 }),
    matchup({ cycleNumber: 3, teamAOwnerId: 'b', teamBOwnerId: 'd', teamAScore: 43, teamBScore: 21 }),
    matchup({ cycleNumber: 3, teamAOwnerId: 'c', teamBOwnerId: 'a', teamAScore: 33, teamBScore: 29 }),
  ];

  const result = buildLeaguePowerRankings({ teams, matchups });

  assert.equal(result.asOfCycleNumber, 3);
  assert.equal(result.completedMatchupCount, 6);
  assert.equal(result.rows[0]?.ownerId, 'b');
  assert.equal(result.rows[0]?.officialRank, 2);
  assert.equal(result.rows[0]?.movement, 1);
  assert.equal(result.rows[0]?.factors.length, 4);
  assert.equal(
    result.rows[0]?.factors.reduce((sum, factor) => sum + factor.weight, 0),
    1,
  );
});

test('Power Rankings ignore active scores, playoff games, byes, and malformed owners', () => {
  const teams = [
    team({ ownerId: 'a', teamName: 'Alpha', wins: 1, losses: 0, pointsFor: 40, pointsAgainst: 30 }),
    team({ ownerId: 'b', teamName: 'Beta', wins: 0, losses: 1, pointsFor: 30, pointsAgainst: 40 }),
  ];
  const completed = matchup({
    cycleNumber: 1,
    teamAOwnerId: 'a',
    teamBOwnerId: 'b',
    teamAScore: 40,
    teamBScore: 30,
  });
  const baseline = buildLeaguePowerRankings({ teams, matchups: [completed] });
  const noisy = buildLeaguePowerRankings({
    teams,
    matchups: [
      completed,
      matchup({ cycleNumber: 2, teamAOwnerId: 'b', teamBOwnerId: 'a', teamAScore: 999, teamBScore: 0, status: 'active' }),
      matchup({ cycleNumber: 3, teamAOwnerId: 'b', teamBOwnerId: 'a', teamAScore: 999, teamBScore: 0, phase: 'playoffs' }),
      matchup({ cycleNumber: 4, teamAOwnerId: 'a', teamBOwnerId: null, teamAScore: 999, teamBScore: 0 }),
      matchup({ cycleNumber: 5, teamAOwnerId: 'unknown', teamBOwnerId: 'a', teamAScore: 999, teamBScore: 0 }),
    ],
  });

  assert.deepEqual(noisy, baseline);
});

test('Power Rankings are deterministic when every metric is tied', () => {
  const teams = [
    team({ ownerId: 'z', teamName: 'Zulu', wins: 0, losses: 0 }),
    team({ ownerId: 'a', teamName: 'Alpha', wins: 0, losses: 0 }),
  ];
  const result = buildLeaguePowerRankings({ teams, matchups: [] });

  assert.equal(result.completedMatchupCount, 0);
  assert.equal(result.asOfCycleNumber, null);
  assert.deepEqual(result.rows.map((row) => row.teamName), ['Alpha', 'Zulu']);
  assert.ok(result.rows.every((row) => row.powerScore === 50));
});

test('Standings keeps Power Rankings optional, transparent, and mobile-safe', async () => {
  const [component, template, styles] = await Promise.all([
    read('src/app/features/leagues/league-standings/league-standings.ts'),
    read('src/app/features/leagues/league-standings/league-standings.html'),
    read('src/app/features/leagues/league-standings/league-standings.css'),
  ]);

  assert.match(component, /viewMode = signal<'official' \| 'power'>\('official'\)/);
  assert.match(component, /buildLeaguePowerRankings/);
  assert.match(template, /Official Standings/);
  assert.match(template, /Power Rankings/);
  assert.match(template, /Entertainment/);
  assert.match(template, /Official standings decide playoffs/);
  assert.match(template, /35% official record · 25% points per matchup · 20% point differential · 20% last-three form/);
  assert.match(template, /Last-three form blends 60% result rate and 40% recent differential/);
  assert.match(template, /<details class="power-rankings-method">/);
  assert.match(template, /Score breakdown/);
  assert.match(styles, /standings-view-tabs[\s\S]*?min-height:\s*44px/);
  assert.match(styles, /@media \(max-width: 560px\)/);
  assert.doesNotMatch(template, /role="dialog"|viewport-overlay|action-sheet|innerHTML/i);
  assert.doesNotMatch(styles, /position:\s*(?:fixed|sticky)|backdrop-filter/i);
});

test('A1H adds no server authority, Rule, index, or competitive model change', async () => {
  const [
    utility,
    functionsIndex,
    rules,
    indexes,
    scoringRules,
    scoringEngine,
    projectionV11,
  ] = await Promise.all([
    read('src/app/core/league/league-power-rankings.util.ts'),
    read('functions/src/index.ts'),
    read('firestore.rules'),
    read('firestore.indexes.json'),
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/scoring/scoring-engine.ts'),
    read('src/app/core/projection/projection-v11.util.ts'),
  ]);

  assert.doesNotMatch(utility, /fetch\(|httpsCallable|onSnapshot|collection\(|doc\(/);
  assert.doesNotMatch(functionsIndex, /PowerRanking|powerRanking/);
  assert.equal(createHash('sha256').update(rules).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreRules);
  assert.equal(createHash('sha256').update(indexes).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreIndexes);
  assert.equal(createHash('sha256').update(scoringRules).digest('hex'), PROTECTED_SOURCE_HASHES.scoringRules);
  assert.equal(createHash('sha256').update(scoringEngine).digest('hex'), PROTECTED_SOURCE_HASHES.scoringEngine);
  assert.equal(createHash('sha256').update(projectionV11).digest('hex'), PROTECTED_SOURCE_HASHES.projectionV11);
});

test('A1H advances RC46, completes A1.10, and retains replay latency as work in progress', async () => {
  const [runtime, productionRuntime, freezeSource, packageSource, roadmap, docsRoadmap, docs, readme, runbook] = await Promise.all([
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('config/release-freeze/beta-freeze-policy.json'),
    read('package.json'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_PRODUCT_A1H_POSITION_FIT_POWER_RANKINGS.md'),
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
  assert.match(packageJson.scripts['verify:batcha1h:core'], /verify:batcha1g:core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batch(?:b1j|d1j):core/);
  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.54/);
  assert.match(roadmap, /# \[x\] A1\.10/);
  assert.match(roadmap, /# \[x\] A1\.17/);
  assert.match(roadmap, /\[~\] A1\.16 Reduce historical-replay player-data catch-up latency/);
  assert.match(roadmap, /# \[x\] LOG\.55 2026-08-18/);
  assert.match(docs, /exact-position/i);
  assert.match(docs, /entertainment only/i);
  assert.match(docs, /Hosting-only/i);
  assert.match(readme, /Release Candidate 65 \/ Beta Batch B1J/);
  assert.match(runbook, /npm run verify:batchb1j/);
  assert.match(runbook, /rinkrat-rc65-validation\.json/);
  assert.match(runbook, /rinkrat-rc65-invite-beta/);
});
