import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { calculateCurrentTeamCycleFantasyPoints } from '../../src/app/core/draft/current-team-cycle-performance.util.ts';
import { calculateCurrentTeamCycleFantasyPoints as calculateServerCurrentTeamCycleFantasyPoints } from '../../functions/src/shared/core/draft/current-team-cycle-performance.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

const markers = [
  {
    gameId: 2026020001,
    gameDate: '2026-10-01',
    opponentAbbreviation: 'SEA',
    venue: 'home',
    status: 'played',
  },
  {
    gameId: 2026020002,
    gameDate: '2026-10-03',
    opponentAbbreviation: 'VAN',
    venue: 'away',
    status: 'missed',
  },
  {
    gameId: 2026020003,
    gameDate: '2026-10-05',
    opponentAbbreviation: 'SJS',
    venue: 'home',
    status: 'upcoming',
  },
];

test('bench block points include appearances but exclude missed and upcoming team games', () => {
  const games = [
    { gameId: 2026020001, fantasyPoints: 12.26 },
    { gameId: 2026020002, fantasyPoints: 99 },
    { gameId: 2026019999, fantasyPoints: 50 },
  ];

  assert.equal(calculateCurrentTeamCycleFantasyPoints(games, markers), 12.3);
  assert.equal(calculateServerCurrentTeamCycleFantasyPoints(games, markers), 12.3);
});

test('bench block points preserve a proven zero and fail visibly when played evidence is missing', () => {
  assert.equal(
    calculateCurrentTeamCycleFantasyPoints([], markers.map((marker) => ({
      ...marker,
      status: 'upcoming',
    }))),
    0,
  );
  assert.equal(calculateCurrentTeamCycleFantasyPoints([], []), null);
  assert.equal(calculateCurrentTeamCycleFantasyPoints([], markers), null);
});

test('My Team, desktop matchup, mobile matchup, and Player Intel expose non-counting bench production', async () => {
  const [
    teamSource,
    teamTemplate,
    matchupSource,
    desktopTemplate,
    mobileTemplate,
    detailSource,
    detailTemplate,
    serverPoolSource,
  ] = await Promise.all([
    read('src/app/features/team/team-settings/team-settings.ts'),
    read('src/app/features/team/team-settings/team-settings.html'),
    read('src/app/features/cycles/cycle-one/cycle-one.ts'),
    read('src/app/features/cycles/cycle-one/components/cycle-matchup-team-panel/cycle-matchup-team-panel.html'),
    read('src/app/features/cycles/cycle-one/components/cycle-mobile-head-to-head/cycle-mobile-head-to-head.html'),
    read('src/app/features/players/league-player-detail/league-player-detail.ts'),
    read('src/app/features/players/league-player-detail/league-player-detail.html'),
    read('functions/src/shared/core/draft/draft-player-pool.service.ts'),
  ]);

  assert.match(teamSource, /getBenchCurrentBlockScore/);
  assert.match(teamSource, /getBenchCurrentBlockMarkers/);
  assert.match(teamSource, /includeCurrentTeamCycle: true/);
  assert.match(teamTemplate, /Bench pts/);
  assert.match(teamTemplate, /bench-game-marker--played/);

  assert.match(matchupSource, /getBenchAssetCurrentBlockScore/);
  assert.match(matchupSource, /getBenchAssetGameMarkers/);
  assert.match(matchupSource, /includeCurrentTeamCycle: true/);
  assert.match(desktopTemplate, /bench-window-game-markers/);
  assert.match(desktopTemplate, /Bench pts/);
  assert.match(mobileTemplate, /getBenchAssetGameMarkers/);
  assert.match(mobileTemplate, /Bench pts/);

  assert.match(detailSource, /currentTeamCycleFantasyPoints/);
  assert.match(detailSource, /Does not count/);
  assert.match(detailTemplate, /currentDisplayFantasyPoints/);
  assert.match(serverPoolSource, /currentTeamCycleFantasyPoints/);
});
