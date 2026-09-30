import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const requireFunctions = createRequire(
  new URL('../../functions/package.json', import.meta.url),
);
const {
  determineEarliestEligibleSourceBlock,
  toLeagueRelativeCycleNumber,
} = requireFunctions('./lib/roster-moves.js');

function game(id, gameState) {
  return {
    id,
    gameDate: `2026-10-${String(id).padStart(2, '0')}`,
    gameType: 2,
    gameState,
  };
}

test('legacy leagues retain absolute NHL block to fantasy matchup mapping', () => {
  assert.equal(toLeagueRelativeCycleNumber(1, 1), 1);
  assert.equal(toLeagueRelativeCycleNumber(2, 1), 2);
  assert.equal(toLeagueRelativeCycleNumber(13, 1), 13);
});

test('a league opening on NHL block 2 maps that block to Fantasy Matchup 1', () => {
  assert.equal(toLeagueRelativeCycleNumber(2, 2), 1);
  assert.equal(toLeagueRelativeCycleNumber(3, 2), 2);
  assert.equal(toLeagueRelativeCycleNumber(12, 2), 11);
});

test('arbitrary late starts stay league-relative and never return matchup zero', () => {
  assert.equal(toLeagueRelativeCycleNumber(7, 7), 1);
  assert.equal(toLeagueRelativeCycleNumber(8, 7), 2);
  assert.equal(toLeagueRelativeCycleNumber(6, 7), 1);
});

test('a provider insertion cannot falsely delay an untouched frozen opening block', () => {
  const firstBlock = Array.from({ length: 6 }, (_, index) => game(index + 1, 'FINAL'));
  const frozenOpening = Array.from({ length: 6 }, (_, index) => game(index + 7, 'FUT'));
  const laterGames = Array.from({ length: 6 }, (_, index) => game(index + 13, 'FUT'));
  const sourceBlock = determineEarliestEligibleSourceBlock({
    schedule: [
      ...firstBlock,
      game(99, 'LIVE'),
      ...frozenOpening,
      ...laterGames,
    ],
    gamesPerCycle: 6,
    initialNhlBlockNumber: 2,
    frozenSourceGameIdsByTeam: {
      SEA: [...firstBlock, ...frozenOpening, ...laterGames].map((entry) => entry.id),
    },
    teamAbbreviation: 'SEA',
  });

  assert.equal(sourceBlock, 2);
  assert.equal(toLeagueRelativeCycleNumber(sourceBlock, 2), 1);
});

test('a reordered frozen game that has started still forces the move to Matchup 2', () => {
  const firstBlock = Array.from({ length: 6 }, (_, index) => game(index + 1, 'FINAL'));
  const insertedGames = Array.from({ length: 6 }, (_, index) => game(index + 90, 'FUT'));
  const frozenOpening = Array.from({ length: 6 }, (_, index) =>
    game(index + 7, index === 0 ? 'LIVE' : 'FUT'));
  const sourceBlock = determineEarliestEligibleSourceBlock({
    schedule: [...firstBlock, ...insertedGames, ...frozenOpening],
    gamesPerCycle: 6,
    initialNhlBlockNumber: 2,
    frozenSourceGameIdsByTeam: {
      SEA: [...firstBlock, ...frozenOpening].map((entry) => entry.id),
    },
    teamAbbreviation: 'SEA',
  });

  assert.equal(sourceBlock, 3);
  assert.equal(toLeagueRelativeCycleNumber(sourceBlock, 2), 2);
});

test('a provider insertion cannot replace a game in a later frozen source block', () => {
  const firstBlock = Array.from({ length: 6 }, (_, index) => game(index + 1, 'FINAL'));
  const secondBlock = Array.from({ length: 6 }, (_, index) => game(index + 7, 'FINAL'));
  const thirdBlock = Array.from({ length: 6 }, (_, index) => game(index + 13, 'FUT'));
  const sourceBlock = determineEarliestEligibleSourceBlock({
    schedule: [
      ...firstBlock,
      ...secondBlock,
      game(99, 'LIVE'),
      ...thirdBlock,
    ],
    gamesPerCycle: 6,
    initialNhlBlockNumber: 2,
    frozenSourceGameIdsByTeam: {
      SEA: [...firstBlock, ...secondBlock, ...thirdBlock].map((entry) => entry.id),
    },
    teamAbbreviation: 'SEA',
  });

  assert.equal(sourceBlock, 3);
  assert.equal(toLeagueRelativeCycleNumber(sourceBlock, 2), 2);
});

test('missing frozen later-block evidence fails instead of timing a move from a replacement game', () => {
  const schedule = Array.from({ length: 12 }, (_, index) =>
    game(index + 1, index < 6 ? 'FINAL' : 'FUT'));

  assert.throws(
    () => determineEarliestEligibleSourceBlock({
      schedule,
      gamesPerCycle: 6,
      initialNhlBlockNumber: 2,
      frozenSourceGameIdsByTeam: {
        SEA: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 999],
      },
      teamAbbreviation: 'SEA',
    }),
    /missing frozen game id\(s\).*source block 2: 999/i,
  );
});

test('an anchored roster move fails visibly when its complete frozen plan is missing', () => {
  const schedule = Array.from({ length: 12 }, (_, index) =>
    game(index + 1, index < 6 ? 'FINAL' : 'FUT'));

  assert.throws(
    () => determineEarliestEligibleSourceBlock({
      schedule,
      gamesPerCycle: 6,
      initialNhlBlockNumber: 2,
      frozenSourceGameIdsByTeam: {},
      teamAbbreviation: 'SEA',
    }),
    /frozen NHL source-game plan is empty/i,
  );
});
