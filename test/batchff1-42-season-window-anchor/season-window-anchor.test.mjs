import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SeasonWindowAnchorInputError,
  determineSeasonWindowAnchor,
} from '../../functions/src/shared/core/draft/season-window-anchor.util.ts';

const ACTIVE_TEAMS = [
  'ANA', 'BOS', 'BUF', 'CAR', 'CBJ', 'CGY', 'CHI', 'COL',
  'DAL', 'DET', 'EDM', 'FLA', 'LAK', 'MIN', 'MTL', 'NJD',
  'NSH', 'NYI', 'NYR', 'OTT', 'PHI', 'PIT', 'SEA', 'SJS',
  'STL', 'TBL', 'TOR', 'UTA', 'VAN', 'VGK', 'WPG', 'WSH',
];

function makeSchedule(teamAbbreviation, finalCount, overrides = {}) {
  const gameCount = overrides.gameCount ?? 18;
  const teamOffset = ACTIVE_TEAMS.indexOf(teamAbbreviation) * 100;

  return {
    teamAbbreviation,
    games: Array.from({ length: gameCount }, (_, index) => ({
      id: 2026020000 + teamOffset + index + 1,
      gameDate: `2026-${String(Math.floor(index / 28) + 10).padStart(2, '0')}-${String((index % 28) + 1).padStart(2, '0')}`,
      startTimeUTC: `2026-${String(Math.floor(index / 28) + 10).padStart(2, '0')}-${String((index % 28) + 1).padStart(2, '0')}T02:00:00Z`,
      gameType: 2,
      gameState: index < finalCount ? 'FINAL' : 'FUT',
      homeTeam: { abbrev: teamAbbreviation },
      awayTeam: { abbrev: 'OPP' },
    })),
  };
}

function determine(teamSchedules) {
  return determineSeasonWindowAnchor({
    season: '20262027',
    requiredGames: 6,
    activeTeamAbbreviations: ACTIVE_TEAMS,
    teamSchedules,
  });
}

test('one club at five finals keeps Matchup 1 on NHL games 1-6', () => {
  const result = determine(ACTIVE_TEAMS.map((team) =>
    makeSchedule(team, team === 'CBJ' ? 5 : 7)));

  assert.equal(result.minimumFinalPrefixGameCount, 5);
  assert.equal(result.sourceBlockNumber, 1);
  assert.equal(result.sourceGameNumberStart, 1);
  assert.equal(result.sourceGameNumberEnd, 6);
  assert.equal(result.activeTeamCount, 32);

  const columbus = result.teams.find((team) => team.teamAbbreviation === 'CBJ');
  const anaheim = result.teams.find((team) => team.teamAbbreviation === 'ANA');

  assert.equal(columbus?.finalPrefixGameCount, 5);
  assert.equal(anaheim?.finalPrefixGameCount, 7);
  assert.deepEqual(columbus?.targetGameIds, [
    2026020401,
    2026020402,
    2026020403,
    2026020404,
    2026020405,
    2026020406,
  ]);
});

test('all clubs beyond the first six games move Matchup 1 to NHL games 7-12', () => {
  const result = determine(ACTIVE_TEAMS.map((team) => makeSchedule(team, 7)));

  assert.equal(result.minimumFinalPrefixGameCount, 7);
  assert.equal(result.sourceBlockNumber, 2);
  assert.equal(result.sourceGameNumberStart, 7);
  assert.equal(result.sourceGameNumberEnd, 12);
  assert.deepEqual(result.teams[0].targetGameIds, [
    2026020007,
    2026020008,
    2026020009,
    2026020010,
    2026020011,
    2026020012,
  ]);
});

test('the same six-game boundary rule applies arbitrarily late in the season', () => {
  const result = determine(ACTIVE_TEAMS.map((team) => makeSchedule(team, 37, {
    gameCount: 60,
  })));

  assert.equal(result.minimumFinalPrefixGameCount, 37);
  assert.equal(result.sourceBlockNumber, 7);
  assert.equal(result.sourceGameNumberStart, 37);
  assert.equal(result.sourceGameNumberEnd, 42);
  assert.deepEqual(result.teams[0].targetGameIds, [
    2026020037,
    2026020038,
    2026020039,
    2026020040,
    2026020041,
    2026020042,
  ]);
});

test('completing exactly six games is sufficient to advance to block 2', () => {
  const schedules = ACTIVE_TEAMS.map((team) => makeSchedule(team, 6));
  schedules.find((schedule) => schedule.teamAbbreviation === 'CBJ')
    .games[5].gameState = 'OFF';
  const result = determine(schedules);

  assert.equal(result.minimumFinalPrefixGameCount, 6);
  assert.equal(result.sourceBlockNumber, 2);
  assert.equal(result.sourceGameNumberStart, 7);
});

test('a live sixth game keeps the source anchor in block 1', () => {
  const schedules = ACTIVE_TEAMS.map((team) => makeSchedule(team, 7));
  const columbus = schedules.find((schedule) => schedule.teamAbbreviation === 'CBJ');

  columbus.games[5].gameState = 'LIVE';

  const result = determine(schedules);
  const columbusEvidence = result.teams.find(
    (team) => team.teamAbbreviation === 'CBJ',
  );

  assert.equal(columbusEvidence?.finalPrefixGameCount, 5);
  assert.equal(result.sourceBlockNumber, 1);
});

test('missing, malformed, and duplicate team schedules fail visibly', () => {
  const complete = ACTIVE_TEAMS.map((team) => makeSchedule(team, 7));

  assert.throws(
    () => determine(complete.filter((schedule) => schedule.teamAbbreviation !== 'CBJ')),
    (error) => {
      assert.ok(error instanceof SeasonWindowAnchorInputError);
      assert.match(error.message, /Missing NHL team schedules for active clubs: CBJ/);
      return true;
    },
  );

  assert.throws(
    () => determine([...complete, makeSchedule('CBJ', 7)]),
    /duplicate NHL team schedules for CBJ/,
  );

  const malformed = ACTIVE_TEAMS.map((team) => makeSchedule(team, 7));
  malformed[0].games[0].startTimeUTC = 'not-a-date';
  assert.throws(
    () => determine(malformed),
    /missing or malformed startTimeUTC/,
  );

  const duplicateGame = ACTIVE_TEAMS.map((team) => makeSchedule(team, 7));
  duplicateGame[0].games[1].id = duplicateGame[0].games[0].id;
  assert.throws(
    () => determine(duplicateGame),
    /contains duplicate NHL game/,
  );
});

test('retries and source ordering produce the same decision and SHA-256 evidence', () => {
  const firstInput = ACTIVE_TEAMS.map((team) => makeSchedule(team, 7));
  const retryInput = firstInput
    .slice()
    .reverse()
    .map((schedule) => ({
      ...schedule,
      games: schedule.games.slice().reverse(),
    }));
  const first = determine(firstInput);
  const retry = determine(retryInput);

  assert.deepEqual(retry, first);
  assert.match(first.evidenceHash, /^[a-f0-9]{64}$/);
  assert.equal(first.evidenceHashAlgorithm, 'sha256');
});

test('schedule order uses parsed startTimeUTC, then gameDate, then game ID', () => {
  const result = determineSeasonWindowAnchor({
    season: '20262027',
    requiredGames: 4,
    activeTeamAbbreviations: ['ANA'],
    teamSchedules: [{
      teamAbbreviation: 'ANA',
      games: [
        {
          id: 40,
          gameDate: '2026-10-04',
          startTimeUTC: '2026-10-05T02:00:00Z',
          gameType: 2,
          gameState: 'FUT',
        },
        {
          id: 30,
          gameDate: '2026-10-03',
          startTimeUTC: '2026-10-04T02:00:00Z',
          gameType: 2,
          gameState: 'FUT',
        },
        {
          id: 20,
          gameDate: '2026-10-02',
          startTimeUTC: '2026-10-04T02:00:00Z',
          gameType: 2,
          gameState: 'FUT',
        },
        {
          id: 10,
          gameDate: '2026-10-02',
          startTimeUTC: '2026-10-04T02:00:00Z',
          gameType: 2,
          gameState: 'FUT',
        },
      ],
    }],
  });

  assert.deepEqual(result.teams[0].targetGameIds, [10, 20, 30, 40]);
});

test('only regular-season gameType 2 contributes to counts and target IDs', () => {
  const schedules = ACTIVE_TEAMS.map((team) => makeSchedule(team, 7));
  const anaheim = schedules.find((schedule) => schedule.teamAbbreviation === 'ANA');

  anaheim.games.unshift({
    id: 2026019999,
    gameDate: '2026-09-25',
    startTimeUTC: '2026-09-26T02:00:00Z',
    gameType: 1,
    gameState: 'FINAL',
    homeTeam: { abbrev: 'ANA' },
    awayTeam: { abbrev: 'SJS' },
  });

  const result = determine(schedules);
  const anaheimEvidence = result.teams.find(
    (team) => team.teamAbbreviation === 'ANA',
  );

  assert.equal(anaheimEvidence?.regularSeasonGameCount, 18);
  assert.equal(anaheimEvidence?.finalPrefixGameCount, 7);
  assert.deepEqual(anaheimEvidence?.targetGameIds, [
    2026020007,
    2026020008,
    2026020009,
    2026020010,
    2026020011,
    2026020012,
  ]);
});

test('a late-season partial block fails instead of weakening or wrapping the six-game contract', () => {
  const schedules = ACTIVE_TEAMS.map((team) => makeSchedule(team, 78, {
    gameCount: 82,
  }));

  assert.throws(
    () => determine(schedules),
    (error) => {
      assert.ok(error instanceof SeasonWindowAnchorInputError);
      assert.match(
        error.message,
        /schedule has only 4 of 6 games required for source block 14/,
      );
      return true;
    },
  );
});
