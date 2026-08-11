import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { resolveRosterMoveReplayContext } from '../../src/app/core/transactions/roster-move-replay-context.util.ts';
import { resolveServerRosterMoveReplayContext } from '../../functions/src/shared/core/replay/roster-move-replay-context.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function replay(overrides = {}) {
  return {
    enabled: true,
    status: 'ready',
    targetSeason: '20262027',
    simulatedDate: '2026-10-10',
    seasonStartDate: '2026-10-07',
    daysAdvanced: 4,
    lastReleasedGameCount: 2,
    totalReleasedGameCount: 12,
    ...overrides,
  };
}

test('an errored replay before any released NHL game still permits deterministic Matchup 1 timing', () => {
  const control = replay({
    status: 'error',
    simulatedDate: '2026-10-06',
    daysAdvanced: 1,
    lastReleasedGameCount: 0,
    totalReleasedGameCount: 0,
  });

  assert.deepEqual(resolveRosterMoveReplayContext(control), {
    mode: 'historical-replay',
    seasonOverride: '20262027',
    completedThroughDate: '2026-10-06',
    safePregameRecovery: true,
  });
  assert.deepEqual(resolveServerRosterMoveReplayContext(control), {
    mode: 'historical-replay',
    seasonOverride: '20262027',
    completedThroughDate: '2026-10-06',
    safePregameRecovery: true,
  });
});

test('pregame recovery falls back to the day before the season start when no simulated date was saved', () => {
  const control = replay({
    status: 'error',
    simulatedDate: null,
    lastReleasedGameCount: 0,
    totalReleasedGameCount: 0,
  });

  const expected = {
    mode: 'historical-replay',
    seasonOverride: '20262027',
    completedThroughDate: '2026-10-06',
    safePregameRecovery: true,
  };

  assert.deepEqual(resolveRosterMoveReplayContext(control), expected);
  assert.deepEqual(resolveServerRosterMoveReplayContext(control), expected);
});

test('an errored legacy replay without explicit released-game counters remains blocked', () => {
  const control = replay({
    status: 'error',
    lastReleasedGameCount: undefined,
    totalReleasedGameCount: undefined,
  });

  assert.equal(resolveRosterMoveReplayContext(control).mode, 'blocked');
  assert.equal(resolveServerRosterMoveReplayContext(control).mode, 'blocked');
});

test('a replay error after any NHL game was released still blocks roster timing', () => {
  const control = replay({
    status: 'error',
    lastReleasedGameCount: 0,
    totalReleasedGameCount: 1,
  });

  const client = resolveRosterMoveReplayContext(control);
  const server = resolveServerRosterMoveReplayContext(control);

  assert.equal(client.mode, 'blocked');
  assert.match(client.message, /must recover/i);
  assert.equal(server.mode, 'blocked');
  assert.match(server.message, /must recover/i);
});

test('queued and advancing replay work continues to block concurrent roster decisions', () => {
  for (const status of ['queued', 'advancing']) {
    const client = resolveRosterMoveReplayContext(replay({ status }));
    const server = resolveServerRosterMoveReplayContext(replay({ status }));

    assert.equal(client.mode, 'blocked');
    assert.equal(server.mode, 'blocked');
  }
});

test('ready historical replay and ordinary live leagues retain their existing date behavior', () => {
  assert.deepEqual(resolveRosterMoveReplayContext(null), {
    mode: 'live',
    safePregameRecovery: false,
  });
  assert.deepEqual(resolveServerRosterMoveReplayContext({ enabled: false }), {
    mode: 'live',
    safePregameRecovery: false,
  });

  const client = resolveRosterMoveReplayContext(replay());
  const server = resolveServerRosterMoveReplayContext(replay());

  assert.equal(client.mode, 'historical-replay');
  assert.equal(client.safePregameRecovery, false);
  assert.equal(server.mode, 'historical-replay');
  assert.equal(server.safePregameRecovery, false);
});

test('the Free Agent workbench uses the shared replay decision and explains the safe pregame recovery', async () => {
  const source = await read('src/app/features/free-agents/free-agents.ts');

  assert.match(source, /resolveRosterMoveReplayContext/);
  assert.match(source, /safePregameRecovery/);
  assert.match(source, /no NHL game has been released into this league/);
  assert.doesNotMatch(
    source,
    /if \(replay\.status === 'error'\) \{\s*throw new Error\(\s*'Historical replay must recover/s,
  );
});

test('server roster actions evaluate the NHL schedule through the authoritative replay date', async () => {
  const [moves, authority] = await Promise.all([
    read('functions/src/roster-moves.ts'),
    read('functions/src/roster-authority.ts'),
  ]);

  assert.match(moves, /resolveServerRosterMoveReplayContext/);
  assert.match(moves, /historicalReplay\/control/);
  assert.match(moves, /completedThroughDate/);
  assert.match(moves, /getScheduleGameState\(game, completedThroughDate\)/);
  assert.match(
    moves,
    /getEarliestEligibleCycleNumber\(addAsset, gamesPerCycle, leagueId\)/,
  );
  assert.match(
    authority,
    /getEarliestEligibleCycleNumber\(asset, gamesPerCycle, leagueId\)/,
  );
});

test('S3B.1 verification and permanent roadmap tracking are present', async () => {
  const [packageJson, rootRoadmap, docsRoadmap, docs] = await Promise.all([
    read('package.json'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
  ]);

  assert.match(packageJson, /test:batchs3b-1:run/);
  assert.match(packageJson, /verify:batchs3b-1/);
  assert.equal(rootRoadmap, docsRoadmap);
  assert.match(rootRoadmap, /S3B\.1/);
  assert.match(docs, /Security Batch S3B\.1/);
});
