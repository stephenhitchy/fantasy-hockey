import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import {
  buildLeaguePlayerBoardRows,
  buildLeaguePlayerOwnership,
  buildLeaguePlayerReservedAssetKeys,
  filterLeaguePlayerBoardRows,
} from '../../src/app/core/player/league-player-board.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function skater(assetKey, name, position, points, ppg, extras = {}) {
  return {
    assetType: 'skater',
    assetKey,
    position,
    player: {
      id: Number(assetKey.replace(/\D/g, '')) || 1,
      fullName: name,
      position,
      nhlTeamAbbreviation: extras.team ?? 'VGK',
      teamLogoUrl: `https://example.test/${assetKey}.svg`,
      headshotUrl: `https://example.test/${assetKey}.png`,
    },
    currentSeasonFantasyPoints: points,
    seasonFantasyPointsPerGame: ppg,
    projectionGamesPlayed: extras.games ?? 40,
    availabilityAdjustedCyclePoints: extras.nextSix ?? 50,
    projectionFloorPoints: extras.floor ?? 40,
    projectionCeilingPoints: extras.ceiling ?? 60,
    reliabilityRating: extras.reliability ?? 80,
    availabilityLabel: extras.availability ?? 'Active',
    seasonStatBreakdown: extras.breakdown ?? [],
  };
}

function rosterAsset(asset) {
  return {
    ...asset,
    cycleScore: { cycleNumber: 1, gamesCounted: 0, fantasyPoints: 0 },
  };
}

function emptyRoster() {
  return {
    schemaVersion: 2,
    activeSlots: [],
    benchSlots: [],
    irSlots: [],
  };
}

test('ownership maps active, bench, and IR assets without changing the roster', () => {
  const teams = [
    { ownerId: 'owner-a', teamName: 'Rink Raiders', managerName: 'Alex' },
    { ownerId: 'owner-b', teamName: 'Blue Line', managerName: 'Blake' },
  ];
  const active = skater('skater-1', 'Active One', 'C', 100, 2.5);
  const bench = skater('skater-2', 'Bench Two', 'LW', 80, 2);
  const injured = skater('skater-3', 'IR Three', 'D', 70, 1.75);
  const rosters = new Map([
    ['owner-a', {
      ...emptyRoster(),
      activeSlots: [{ slotId: 'C-1', position: 'C', slotNumber: 1, asset: rosterAsset(active) }],
      benchSlots: [{ slotId: 'B-1', slotNumber: 1, asset: rosterAsset(bench) }],
    }],
    ['owner-b', {
      ...emptyRoster(),
      irSlots: [{ slotId: 'IR-1', slotNumber: 1, asset: rosterAsset(injured) }],
    }],
  ]);

  const ownership = buildLeaguePlayerOwnership(teams, rosters);
  assert.deepEqual(ownership.get('skater-1'), {
    assetKey: 'skater-1',
    ownerId: 'owner-a',
    teamName: 'Rink Raiders',
    managerName: 'Alex',
    area: 'active',
    rosterSlotId: 'C-1',
    slotLabel: 'C1',
  });
  assert.equal(ownership.get('skater-2')?.area, 'bench');
  assert.equal(ownership.get('skater-3')?.area, 'ir');
});

test('pending incoming assets become private reserved markers without destination ownership', () => {
  const incoming = skater('skater-9', 'Reserved Nine', 'RW', 99, 2.2);
  const rosters = new Map([
    ['owner-secret', {
      ...emptyRoster(),
      activeSlots: [{
        slotId: 'RW-1',
        position: 'RW',
        slotNumber: 1,
        asset: null,
        pendingMove: { incomingAsset: rosterAsset(incoming) },
      }],
    }],
  ]);

  const reserved = buildLeaguePlayerReservedAssetKeys(rosters);
  const [row] = buildLeaguePlayerBoardRows({
    assets: [incoming],
    reservedAssetKeys: reserved,
  });

  assert.equal(reserved.has('skater-9'), true);
  assert.equal(row.status, 'reserved');
  assert.equal(row.ownership, null);
});

test('board rows combine roster, waiver, free-agent, and private watched state', () => {
  const assets = [
    skater('skater-1', 'Rostered Star', 'C', 120, 3),
    skater('skater-2', 'Waiver Wing', 'LW', 90, 2.25),
    skater('skater-3', 'Open Defense', 'D', 75, 1.8),
  ];
  const ownership = new Map([
    ['skater-1', {
      assetKey: 'skater-1',
      ownerId: 'owner-a',
      teamName: 'Rink Raiders',
      managerName: 'Alex',
      area: 'active',
      slotLabel: 'C1',
    }],
  ]);

  const rows = buildLeaguePlayerBoardRows({
    assets,
    ownershipByAssetKey: ownership,
    waiverAssetKeys: new Set(['skater-2']),
    watchedAssetKeys: new Set(['skater-1', 'skater-3']),
  });

  assert.deepEqual(rows.map((row) => row.status), ['rostered', 'waivers', 'free-agent']);
  assert.deepEqual(rows.map((row) => row.watched), [true, false, true]);
});

test('season point ranking produces all-position and exact-position ranks with ties', () => {
  const rows = buildLeaguePlayerBoardRows({
    assets: [
      skater('skater-1', 'Center One', 'C', 120, 3),
      skater('skater-2', 'Wing Two', 'LW', 110, 2.8),
      skater('skater-3', 'Center Three', 'C', 90, 2.1),
      skater('skater-4', 'Center Four', 'C', 90, 2.1),
    ],
  });
  const byKey = new Map(rows.map((row) => [row.assetKey, row]));

  assert.equal(byKey.get('skater-1')?.overallRank, 1);
  assert.equal(byKey.get('skater-2')?.overallRank, 2);
  assert.equal(byKey.get('skater-3')?.overallRank, 3);
  assert.equal(byKey.get('skater-4')?.overallRank, 3);
  assert.equal(byKey.get('skater-1')?.positionRank, 1);
  assert.equal(byKey.get('skater-3')?.positionRank, 2);
  assert.equal(byKey.get('skater-4')?.positionRank, 2);
  assert.equal(byKey.get('skater-1')?.overallRankCount, 4);
  assert.equal(byKey.get('skater-1')?.positionRankCount, 3);
});

test('board search, status, position, watched, and sorting remain deterministic', () => {
  const rows = buildLeaguePlayerBoardRows({
    assets: [
      skater('skater-1', 'Alpha Center', 'C', 80, 2, { nextSix: 41, team: 'VGK' }),
      skater('skater-2', 'Beta Wing', 'LW', 110, 3, { nextSix: 36, team: 'EDM' }),
      skater('skater-3', 'Gamma Defense', 'D', 70, 1.5, { nextSix: 55, team: 'MIN' }),
    ],
    ownershipByAssetKey: new Map([['skater-2', {
      assetKey: 'skater-2', ownerId: 'b', teamName: 'Blue Line', managerName: 'Blake', area: 'bench', slotLabel: 'Bench 1',
    }]]),
    watchedAssetKeys: new Set(['skater-3']),
  });

  assert.deepEqual(
    filterLeaguePlayerBoardRows(rows, { status: 'rostered' }).map((row) => row.assetKey),
    ['skater-2'],
  );
  assert.deepEqual(
    filterLeaguePlayerBoardRows(rows, { status: 'watched' }).map((row) => row.assetKey),
    ['skater-3'],
  );
  assert.deepEqual(
    filterLeaguePlayerBoardRows(rows, { searchTerm: 'blue line' }).map((row) => row.assetKey),
    ['skater-2'],
  );
  assert.deepEqual(
    filterLeaguePlayerBoardRows(rows, { position: 'C' }).map((row) => row.assetKey),
    ['skater-1'],
  );
  assert.deepEqual(
    filterLeaguePlayerBoardRows(rows, { sortMode: 'next-six' }).map((row) => row.assetKey),
    ['skater-3', 'skater-1', 'skater-2'],
  );
});

test('A1B Player Intel remains the shared directory model after A1C unifies Players with Add / Drop', async () => {
  const [routes, navbar, leagueHq, standings, unifiedTemplate, detailTemplate] = await Promise.all([
    read('src/app/app.routes.ts'),
    read('src/app/shared/navbar/navbar.html'),
    read('src/app/features/leagues/league-detail/league-detail.html'),
    read('src/app/features/leagues/league-standings/league-standings.html'),
    read('src/app/features/free-agents/free-agents.html'),
    read('src/app/features/players/league-player-detail/league-player-detail.html'),
  ]);

  assert.match(routes, /path: 'leagues\/:leagueId\/players',[\s\S]*?title: 'Add \/ Drop'[\s\S]*?pendingRosterActionGuard[\s\S]*?FreeAgents/);
  assert.match(routes, /path: 'leagues\/:leagueId\/free-agents',[\s\S]*?redirectTo: 'leagues\/:leagueId\/players'/);
  assert.match(routes, /path: 'leagues\/:leagueId\/players\/:assetKey',[\s\S]*?title: 'Player Intel'[\s\S]*?LeaguePlayerDetail/);
  assert.match(routes, /path: 'leagues\/:leagueId\/leaders',[\s\S]*?title: 'Point Leaders'[\s\S]*?PointLeaders/);
  assert.match(navbar, /\['\/leagues', activeLeagueId, 'players'\][\s\S]*?>\s*Add\/Drop\s*</);
  assert.match(leagueHq, /\['\/leagues', leagueId, 'players'\][\s\S]*?<strong>Add \/ Drop<\/strong>/);
  assert.match(standings, /\['\/leagues', leagueId, 'players'\][\s\S]*?>\s*Add \/ Drop\s*</);
  assert.match(unifiedTemplate, /\['\/leagues', leagueId, 'players', row\.assetKey\]/);
  assert.match(unifiedTemplate, />Point Leaders<\/a>/);
  assert.match(detailTemplate, /\['\/leagues', leagueId, 'players'\]/);
  assert.match(detailTemplate, /Back to Add \/ Drop/);
});

test('the unified page reuses bounded A1B board sources and progressive mobile rendering', async () => {
  const [service, component, template, styles, draftService] = await Promise.all([
    read('src/app/core/player/league-player-board.service.ts'),
    read('src/app/features/free-agents/free-agents.ts'),
    read('src/app/features/free-agents/free-agents.html'),
    read('src/app/features/free-agents/free-agents.css'),
    read('src/app/core/draft/draft.service.ts'),
  ]);

  assert.match(service, /loadSharedProjectionSnapshot/);
  assert.match(service, /getFantasyRosterOnce/);
  assert.match(service, /getPublicLeagueWaiversOnce/);
  assert.match(service, /LEAGUE_PLAYER_BOARD_CACHE_MILLISECONDS = 30_000/);
  assert.match(service, /forceRefresh/);
  assert.doesNotMatch(service, /\b(?:setDoc|updateDoc|deleteDoc|onSnapshot)\s*\(/);
  assert.match(draftService, /export async function getPublicLeagueWaiversOnce/);
  assert.match(component, /const UNIFIED_PLAYER_PAGE_SIZE = 50/);
  assert.match(component, /getPlayerWatchlist/);
  assert.match(component, /setPlayerWatchlistEntry/);
  assert.match(component, /boardStatusFilter = signal<LeaguePlayerBoardStatusFilter>\('free-agent'\)/);
  assert.match(component, /boardSortMode = signal<LeaguePlayerBoardSortMode>\('roster-fit'\)/);
  assert.match(template, /Show \{\{ hiddenBoardRowCount\(\) > 50 \? 50 : hiddenBoardRowCount\(\) \}\} more/);
  assert.match(template, /Overall/);
  assert.match(template, /\{\{ row\.position \}\} rank/);
  assert.match(template, /Unavailable \(\{\{ unavailableBoardCount\(\) \}\}\)/);
  assert.match(styles, /unified-watch-button/);
  assert.match(styles, /@media \(max-width: 560px\)/);
  assert.doesNotMatch(styles, /backdrop-filter/i);
});

test('Player Intel keeps real Projection V11 fields and returns to the unified Add / Drop surface', async () => {
  const [component, template, styles] = await Promise.all([
    read('src/app/features/players/league-player-detail/league-player-detail.ts'),
    read('src/app/features/players/league-player-detail/league-player-detail.html'),
    read('src/app/features/players/league-player-detail/league-player-detail.css'),
  ]);

  assert.match(component, /loadLeaguePlayerBoardBaseData/);
  assert.match(component, /seasonStatBreakdown/);
  assert.match(component, /performanceVsProjectionPercent/);
  assert.match(component, /projectionOpponentAbbreviations/);
  assert.match(component, /currentTeamCycleGames/);
  assert.match(component, /recentTenGameFantasyPointsPerGame/);
  assert.match(component, /setPlayerWatchlistEntry/);
  assert.match(component, /activeSection = signal<PlayerIntelSection>\('overview'\)/);
  assert.doesNotMatch(component, /mock-player-data|getMockPlayerDetail/);
  assert.match(template, /Overall rank/);
  assert.match(template, /role="tablist"/);
  assert.match(template, />Overview<\/button>/);
  assert.match(template, />Stats<\/button>/);
  assert.match(template, />Projection<\/button>/);
  assert.match(template, />Schedule<\/button>/);
  assert.match(template, /Fantasy point breakdown/);
  assert.match(template, /Six-game opportunity/);
  assert.match(template, /Back to Add \/ Drop/);
  assert.match(styles, /player-intel-watch[\s\S]*?min-height:\s*44px/);
  assert.match(styles, /player-intel-tabs[\s\S]*?grid-template-columns/);
  assert.doesNotMatch(styles, /position:\s*(?:fixed|sticky)|backdrop-filter/i);
});

test('unified player rows, roster candidates, and scoring leaders link into league-aware Player Intel', async () => {
  const [freeAgents, leaders] = await Promise.all([
    read('src/app/features/free-agents/free-agents.html'),
    read('src/app/features/leaders/point-leaders/point-leaders.html'),
  ]);

  assert.match(freeAgents, /\['\/leagues', leagueId, 'players', row\.assetKey\]/);
  assert.match(freeAgents, /\['\/leagues', leagueId, 'players', outgoing\.assetKey\]/);
  assert.match(leaders, /\['\/leagues', leagueId, 'players', row\.assetKey\]/);
});

test('A1B preserves scoring, Projection V11, Rules, indexes, and inactive safety controls', async () => {
  const [
    scoringRules,
    scoringEngine,
    projectionV11,
    firestoreRules,
    firestoreIndexes,
    freezeSource,
    appCheckSource,
    canarySource,
    cacheSource,
  ] = await Promise.all([
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/scoring/scoring-engine.ts'),
    read('src/app/core/projection/projection-v11.util.ts'),
    read('firestore.rules'),
    read('firestore.indexes.json'),
    read('config/release-freeze/beta-freeze-policy.json'),
    read('config/app-check-enforcement-readiness.json'),
    read('config/app-check-callable-canary.json'),
    read('config/nhl-shared-cache-policy.json'),
  ]);
  const freeze = JSON.parse(freezeSource);
  const appCheck = JSON.parse(appCheckSource);
  const canary = JSON.parse(canarySource);
  const cache = JSON.parse(cacheSource);

  assert.equal(createHash('sha256').update(scoringRules).digest('hex'), PROTECTED_SOURCE_HASHES.scoringRules);
  assert.equal(createHash('sha256').update(scoringEngine).digest('hex'), PROTECTED_SOURCE_HASHES.scoringEngine);
  assert.equal(createHash('sha256').update(projectionV11).digest('hex'), PROTECTED_SOURCE_HASHES.projectionV11);
  assert.equal(createHash('sha256').update(firestoreRules).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreRules);
  assert.equal(createHash('sha256').update(firestoreIndexes).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreIndexes);
  assert.equal(freeze.scoringRulesVersion, 4);
  assert.equal(freeze.projectionVersion, 11);
  assert.equal(freeze.requiredGamesPerRosterSlot, 6);
  assert.equal(freeze.queueMode, 'shadow');
  assert.equal(freeze.appCheckMode, 'monitor');
  assert.equal(appCheck.mode, 'monitor');
  assert.equal(canary.automaticPromotion, false);
  assert.equal(cache.mode, 'shadow');
  assert.equal(cache.authoritativeReadsEnabled, false);
});

test('A1B remains permanently recorded while current release operations advance through A1C', async () => {
  const [runtime, productionRuntime, freezeSource, packageSource, roadmap, docsRoadmap, docs, readme, runbook] = await Promise.all([
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('config/release-freeze/beta-freeze-policy.json'),
    read('package.json'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_PRODUCT_A1B_PLAYER_BOARD.md'),
    read('README.md'),
    read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
  ]);
  const freeze = JSON.parse(freezeSource);
  const packageJson = JSON.parse(packageSource);

  assert.match(runtime, /Release Candidate 51/);
  assert.match(productionRuntime, /Release Candidate 51/);
  assert.equal(freeze.releaseLabel, 'Release Candidate 51');
  assert.equal(freeze.verificationCommand, 'npm run verify:batcho1a');
  assert.equal(freeze.defaultTag, 'rinkrat-rc51-invite-beta');
  assert.match(packageJson.scripts['verify:batcha1b:core'], /verify:batcha1a:core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batcho1a:core/);
  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.42/);
  assert.match(roadmap, /# \[x\] A1\.12 Add a league-wide Player Board/);
  assert.match(roadmap, /# \[x\] LOG\.49 2026-08-17/);
  assert.match(docs, /Hosting only/);
  assert.match(docs, /reserved/i);
  assert.match(readme, /Release Candidate 51 \/ Operations Batch O1A/);
  assert.match(readme, /RINKRAT_PRODUCT_A1B_PLAYER_BOARD\.md/);
  assert.match(runbook, /npm run verify:batcho1a/);
  assert.match(runbook, /rinkrat-rc51-validation\.json/);
  assert.match(runbook, /rinkrat-rc51-invite-beta/);
});
