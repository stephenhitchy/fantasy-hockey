import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  calculateLiveMatchupProjection,
  getLiveMatchupProjectionTrend,
} from '../../src/app/core/projection/live-matchup-projection.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

test('live projection starts at the frozen matchup projection', () => {
  assert.equal(calculateLiveMatchupProjection(60, null), 60);
  assert.equal(calculateLiveMatchupProjection(60, {
    currentScore: 0,
    gamesPlayed: 0,
    scheduledGames: 6,
    completedGameIds: [],
    liveGameIds: [],
    gameScores: {},
  }), 60);
});

test('settled results replace only their original per-game expectation', () => {
  assert.equal(calculateLiveMatchupProjection(60, {
    currentScore: 26,
    gamesPlayed: 1,
    scheduledGames: 6,
    completedGameIds: [1],
    liveGameIds: [],
    gameScores: { 1: 26 },
  }), 76);

  assert.equal(calculateLiveMatchupProjection(60, {
    currentScore: 4,
    gamesPlayed: 1,
    scheduledGames: 6,
    completedGameIds: [1],
    liveGameIds: [],
    gameScores: { 1: 4 },
  }), 54);
});

test('an in-progress game does not create a false projection trend at puck drop', () => {
  assert.equal(calculateLiveMatchupProjection(60, {
    currentScore: 0,
    gamesPlayed: 0,
    scheduledGames: 6,
    completedGameIds: [],
    liveGameIds: [2],
    gameScores: { 2: 0 },
  }), 60);

  assert.equal(calculateLiveMatchupProjection(60, {
    currentScore: 4,
    gamesPlayed: 0,
    scheduledGames: 6,
    completedGameIds: [],
    liveGameIds: [2],
    gameScores: { 2: 4 },
  }), 60);

  assert.equal(calculateLiveMatchupProjection(60, {
    currentScore: 13,
    gamesPlayed: 0,
    scheduledGames: 6,
    completedGameIds: [],
    liveGameIds: [2],
    gameScores: { 2: 13 },
  }), 60);
});

test('live points do not contaminate adjustments from earlier settled games', () => {
  assert.equal(calculateLiveMatchupProjection(60, {
    currentScore: 30,
    gamesPlayed: 1,
    scheduledGames: 6,
    completedGameIds: [1],
    liveGameIds: [2],
    gameScores: { 1: 26, 2: 4 },
  }), 76);

  assert.equal(calculateLiveMatchupProjection(60, {
    currentScore: 39,
    gamesPlayed: 1,
    scheduledGames: 6,
    completedGameIds: [1],
    liveGameIds: [2],
    gameScores: { 1: 26, 2: 13 },
  }), 76);
});

test('settled evidence must identify every finalized game score', () => {
  assert.equal(calculateLiveMatchupProjection(60, {
    currentScore: 4,
    gamesPlayed: 1,
    scheduledGames: 6,
    completedGameIds: [],
    liveGameIds: [],
    gameScores: {},
  }), null);

  assert.equal(calculateLiveMatchupProjection(60, {
    currentScore: 4,
    gamesPlayed: 1,
    scheduledGames: 6,
    completedGameIds: [1],
    liveGameIds: [],
    gameScores: {},
  }), null);
});

test('post-final corrections update the settled projection without changing its model', () => {
  assert.equal(calculateLiveMatchupProjection(60, {
    currentScore: 5,
    gamesPlayed: 1,
    scheduledGames: 6,
    completedGameIds: [1],
    liveGameIds: [],
    gameScores: { 1: 5 },
  }), 55);

  assert.equal(calculateLiveMatchupProjection(60, {
    currentScore: 6,
    gamesPlayed: 1,
    scheduledGames: 6,
    completedGameIds: [1],
    liveGameIds: [],
    gameScores: { 1: 6 },
  }), 56);
});

test('missing and non-finite evidence stays unavailable instead of becoming zero', () => {
  assert.equal(calculateLiveMatchupProjection(null, null), null);
  assert.equal(calculateLiveMatchupProjection(60, {
    currentScore: Number.NaN,
    gamesPlayed: 0,
    scheduledGames: 6,
    completedGameIds: [],
    liveGameIds: [],
    gameScores: {},
  }), null);
});

test('projection trend reports up, down, even, and unavailable directions', () => {
  assert.equal(getLiveMatchupProjectionTrend(76, 60), 'up');
  assert.equal(getLiveMatchupProjectionTrend(54, 60), 'down');
  assert.equal(getLiveMatchupProjectionTrend(60, 60), 'even');
  assert.equal(getLiveMatchupProjectionTrend(null, 60), 'unavailable');
});

test('Game Center renders changing projections with color and a non-color direction cue', async () => {
  const [source, desktop, mobileScorebar, mobileRoster, styles] = await Promise.all([
    read('src/app/features/cycles/cycle-one/cycle-one.ts'),
    read('src/app/features/cycles/cycle-one/components/cycle-matchup-team-panel/cycle-matchup-team-panel.html'),
    read('src/app/features/cycles/cycle-one/components/cycle-mobile-scorebar/cycle-mobile-scorebar.html'),
    read('src/app/features/cycles/cycle-one/components/cycle-mobile-head-to-head/cycle-mobile-head-to-head.html'),
    read('src/app/features/cycles/cycle-one/cycle-one.css'),
  ]);

  assert.match(source, /getLiveProjectedCycleForTeam/);
  assert.match(source, /getAssetLiveProjection/);
  assert.match(source, /getLiveProjectionDirectionSymbol/);
  assert.match(desktop, /Live proj/);
  assert.match(desktop, /live-projection-up/);
  assert.match(mobileScorebar, /getLiveProjectedCycleForTeam/);
  assert.match(mobileRoster, /getPickLiveProjection/);
  assert.match(desktop, /class="live-projection-direction"/);
  assert.match(mobileScorebar, /class="live-projection-direction"/);
  assert.match(mobileRoster, /class="live-projection-direction"/);
  assert.match(styles, /\.live-projection-up/);
  assert.match(styles, /\.live-projection-down/);
  assert.match(styles, /\.live-projection-direction/);
});
