import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildEffectiveCycleLineupPicks,
  isCycleWindowIdentityLocked,
  isPendingMovePlannedForCycle,
} from '../../src/app/features/cycles/cycle-one/cycle-lineup-preview.util.ts';

const ownerId = 'owner-a';
const slotId = 'LW-1';

function makePlayerAsset(assetKey, fullName, overrides = {}) {
  const numericId = Number(assetKey.replace(/\D/g, '')) || 1;

  return {
    assetType: 'skater',
    assetKey,
    position: 'LW',
    player: {
      id: numericId,
      fullName,
      position: 'LW',
      nhlTeamAbbreviation: 'TST',
      teamLogoUrl: '/test.svg',
    },
    cycleScore: {
      cycleNumber: 1,
      gamesCounted: 0,
      fantasyPoints: 0,
    },
    ...overrides,
  };
}

function makePick(asset, overrides = {}) {
  return {
    overallPick: 1,
    round: 1,
    pickInRound: 1,
    ownerId,
    rosterArea: 'active',
    rosterSlotId: slotId,
    snapshotCycleNumber: 2,
    snapshotOrder: 1,
    asset,
    ...overrides,
  };
}

function makeRoster(slotOverrides = {}) {
  return {
    schemaVersion: 2,
    activeSlots: [
      {
        slotId,
        position: 'LW',
        slotNumber: 1,
        asset: null,
        pendingMove: null,
        ...slotOverrides,
      },
    ],
    benchSlots: [],
    irSlots: [],
  };
}

function makeWindow(asset, overrides = {}) {
  return {
    id: `${ownerId}__${slotId}__cycle-2`,
    ownerId,
    rosterSlotId: slotId,
    cycleNumber: 2,
    position: 'LW',
    assetKey: asset.assetKey,
    asset,
    status: 'scheduled',
    scheduledGameIds: [],
    scheduledGameDates: [],
    scheduledGameLabels: [],
    completedGameIds: [],
    liveGameIds: [],
    appearanceGameIds: [],
    gameScores: {},
    gameStates: {},
    scheduledGames: 0,
    gamesPlayed: 0,
    actualGamesPlayed: 0,
    gamesLeft: 6,
    fantasyPoints: 0,
    frozenProjectionPoints: null,
    frozenProjectionVersion: null,
    frozenProjectionSource: null,
    frozenProjectionSnapshotId: null,
    frozenProjectionGeneratedAt: null,
    frozenProjectionFrozenAt: null,
    frozenProjectionTargetGameIds: [],
    firstScheduledGameDate: null,
    lastScheduledGameDate: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function buildInput({
  cycleNumber = 2,
  snapshotPicks = [],
  liveDraftPicks = [],
  roster = undefined,
  projectionAssets = [],
  windows = [],
  expected = true,
  loaded = true,
} = {}) {
  return {
    cycleNumber,
    snapshotPicks,
    liveDraftPicks,
    rostersByOwner: roster === undefined ? {} : { [ownerId]: roster },
    projectionAssets,
    teamWindowsByOwner: windows.length
      ? {
          [ownerId]: {
            id: ownerId,
            ownerId,
            cycleNumber,
            expectedRosterSlotIds: [slotId],
            windows,
            completedWindowCount: 0,
            totalWindowCount: 1,
            status: 'scheduled',
          },
        }
      : {},
    rosterOwnerIdsExpected: expected ? new Set([ownerId]) : new Set(),
    rosterOwnerIdsLoaded: loaded ? new Set([ownerId]) : new Set(),
  };
}

function makePendingMove(incomingAsset, overrides = {}) {
  return {
    id: 'queued-move-1',
    moveType: 'add-drop',
    incomingAsset,
    outgoingAssetKey: 'skater-1',
    sourceWaiverId: null,
    queuedByOwnerId: ownerId,
    queuedAt: '2026-01-01T00:00:00.000Z',
    requestedEffectiveCycleNumber: 2,
    requestedEffectiveLabel: 'Matchup 2',
    outgoingDestination: 'waivers',
    ...overrides,
  };
}

test('future matchup previews a queued incoming player before that player records a game', () => {
  const outgoing = makePlayerAsset('skater-1', 'Outgoing Player', {
    projectedCyclePoints: 60,
    frozenCycleProjectionPoints: 58,
  });
  const incoming = makePlayerAsset('skater-2', 'Incoming Player', {
    projectedCyclePoints: 71,
    frozenCycleProjectionPoints: 66,
    frozenProjectionCycleNumber: 1,
    projectionGeneratedAt: '2026-01-01T00:00:00.000Z',
    eligibleFromCycleNumber: 2,
  });
  const currentPoolIncoming = makePlayerAsset('skater-2', 'Incoming Player', {
    projectedCyclePoints: 88,
    targetProjectionCycleNumber: 2,
    sharedProjectionSnapshotId: 'projection-v-current',
    projectionGeneratedAt: '2026-02-01T00:00:00.000Z',
  });
  const snapshotPick = makePick(outgoing);
  const roster = makeRoster({
    asset: outgoing,
    pendingMove: makePendingMove(incoming),
  });

  const result = buildEffectiveCycleLineupPicks(
    buildInput({
      snapshotPicks: [snapshotPick],
      liveDraftPicks: [snapshotPick],
      roster,
      projectionAssets: [currentPoolIncoming],
      windows: [makeWindow(outgoing)],
    }),
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].asset.assetKey, incoming.assetKey);
  assert.equal(result[0].asset.projectedCyclePoints, 88);
  assert.equal(result[0].asset.sharedProjectionSnapshotId, 'projection-v-current');
  assert.equal(result[0].asset.frozenCycleProjectionPoints, null);
  assert.equal(result[0].asset.frozenProjectionCycleNumber, null);
});

test('the same queued move does not replace the current matchup lineup early', () => {
  const outgoing = makePlayerAsset('skater-1', 'Outgoing Player');
  const incoming = makePlayerAsset('skater-2', 'Incoming Player', {
    eligibleFromCycleNumber: 2,
  });
  const snapshotPick = makePick(outgoing, { snapshotCycleNumber: 1 });
  const roster = makeRoster({
    asset: outgoing,
    pendingMove: makePendingMove(incoming),
  });

  const result = buildEffectiveCycleLineupPicks(
    buildInput({
      cycleNumber: 1,
      snapshotPicks: [snapshotPick],
      liveDraftPicks: [snapshotPick],
      roster,
      windows: [makeWindow(outgoing, { cycleNumber: 1 })],
    }),
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].asset.assetKey, outgoing.assetKey);
});

test('an active six-game window keeps its immutable outgoing-player snapshot', () => {
  const outgoing = makePlayerAsset('skater-1', 'Outgoing Player');
  const incoming = makePlayerAsset('skater-2', 'Incoming Player', {
    eligibleFromCycleNumber: 2,
  });
  const snapshotPick = makePick(outgoing);
  const roster = makeRoster({
    asset: incoming,
    pendingMove: null,
  });

  const result = buildEffectiveCycleLineupPicks(
    buildInput({
      snapshotPicks: [snapshotPick],
      liveDraftPicks: [snapshotPick],
      roster,
      windows: [
        makeWindow(outgoing, {
          status: 'active',
          gamesPlayed: 1,
          completedGameIds: [1001],
          startedAt: '2026-01-05T00:00:00.000Z',
        }),
      ],
    }),
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].asset.assetKey, outgoing.assetKey);
});

test('a completed six-game window also keeps its immutable player snapshot', () => {
  const outgoing = makePlayerAsset('skater-1', 'Outgoing Player');
  const incoming = makePlayerAsset('skater-2', 'Incoming Player', {
    eligibleFromCycleNumber: 2,
  });
  const snapshotPick = makePick(outgoing);
  const roster = makeRoster({ asset: incoming });

  const result = buildEffectiveCycleLineupPicks(
    buildInput({
      snapshotPicks: [snapshotPick],
      roster,
      windows: [
        makeWindow(outgoing, {
          status: 'complete',
          gamesPlayed: 6,
          actualGamesPlayed: 6,
          completedGameIds: [1, 2, 3, 4, 5, 6],
          fantasyPoints: 90,
          completedAt: '2026-01-10T00:00:00.000Z',
        }),
      ],
    }),
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].asset.assetKey, outgoing.assetKey);
});

test('an unlocked stale snapshot is hidden while the current roster is still loading', () => {
  const outgoing = makePlayerAsset('skater-1', 'Outgoing Player');
  const snapshotPick = makePick(outgoing);

  const result = buildEffectiveCycleLineupPicks(
    buildInput({
      snapshotPicks: [snapshotPick],
      liveDraftPicks: [snapshotPick],
      roster: undefined,
      windows: [makeWindow(outgoing)],
      expected: true,
      loaded: false,
    }),
  );

  assert.deepEqual(result, []);
});

test('a failed/unavailable roster read safely falls back to the saved snapshot', () => {
  const outgoing = makePlayerAsset('skater-1', 'Outgoing Player');
  const snapshotPick = makePick(outgoing);

  const result = buildEffectiveCycleLineupPicks(
    buildInput({
      snapshotPicks: [snapshotPick],
      liveDraftPicks: [snapshotPick],
      roster: null,
      windows: [makeWindow(outgoing)],
      expected: true,
      loaded: true,
    }),
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].asset.assetKey, outgoing.assetKey);
});

test('an authoritative empty future roster slot does not resurrect its old player', () => {
  const outgoing = makePlayerAsset('skater-1', 'Outgoing Player');
  const snapshotPick = makePick(outgoing);
  const roster = makeRoster({ asset: null, pendingMove: null });

  const result = buildEffectiveCycleLineupPicks(
    buildInput({
      snapshotPicks: [snapshotPick],
      liveDraftPicks: [snapshotPick],
      roster,
      windows: [makeWindow(outgoing)],
    }),
  );

  assert.deepEqual(result, []);
});

test('a roster asset never appears in a matchup before its eligibility cycle', () => {
  const oldDraftedPlayer = makePlayerAsset('skater-1', 'Old Drafted Player');
  const incoming = makePlayerAsset('skater-2', 'Incoming Player', {
    eligibleFromCycleNumber: 2,
  });
  const roster = makeRoster({ asset: incoming });

  const cycleOne = buildEffectiveCycleLineupPicks(
    buildInput({
      cycleNumber: 1,
      liveDraftPicks: [makePick(oldDraftedPlayer, { snapshotCycleNumber: 1 })],
      roster,
      windows: [],
    }),
  );
  const cycleTwo = buildEffectiveCycleLineupPicks(
    buildInput({
      cycleNumber: 2,
      liveDraftPicks: [makePick(oldDraftedPlayer)],
      roster,
      windows: [],
    }),
  );

  assert.deepEqual(cycleOne, []);
  assert.equal(cycleTwo.length, 1);
  assert.equal(cycleTwo[0].asset.assetKey, incoming.assetKey);
});

test('pending-move eligibility uses the later of the requested and asset eligibility cycles', () => {
  const outgoing = makePlayerAsset('skater-1', 'Outgoing Player');
  const incoming = makePlayerAsset('skater-2', 'Incoming Player', {
    eligibleFromCycleNumber: 3,
  });
  const pendingMove = makePendingMove(incoming, {
    requestedEffectiveCycleNumber: 2,
  });

  assert.equal(isPendingMovePlannedForCycle(pendingMove, 2), false);
  assert.equal(isPendingMovePlannedForCycle(pendingMove, 3), true);
});

test('scheduled game IDs alone do not lock a stale future identity, but real start evidence does', () => {
  const outgoing = makePlayerAsset('skater-1', 'Outgoing Player');

  assert.equal(
    isCycleWindowIdentityLocked(
      makeWindow(outgoing, {
        scheduledGameIds: [101, 102, 103, 104, 105, 106],
        scheduledGames: 6,
      }),
    ),
    false,
  );

  assert.equal(
    isCycleWindowIdentityLocked(
      makeWindow(outgoing, {
        status: 'scheduled',
        scheduledGameIds: [101, 102, 103, 104, 105, 106],
        scheduledGames: 6,
        startedAt: '2026-01-05T00:00:00.000Z',
      }),
    ),
    true,
  );
});

test('Game Center refreshes future previews from roster, window, and projection changes', async () => {
  const source = await readFile(
    new URL('../../src/app/features/cycles/cycle-one/cycle-one.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /buildEffectiveCycleLineupPicks\(\{/);
  assert.match(source, /rostersByOwner: this\.teamRostersByOwner\(\)/);
  assert.match(source, /this\.refreshEffectivePicks\(\);\s*\n\s*}\,\s*\n\s*\);/);
  assert.match(source, /this\.playerPool\.set\(await loadDraftPlayerPool\(true\)\);\s*\n\s*this\.refreshEffectivePicks\(\);/);
  assert.match(source, /getCycleProjectionPreviewSignature/);
  assert.match(source, /slotWindow\.assetKey !== pick\.asset\.assetKey/);
  assert.match(source, /Scheduled move · Matchup/);
  assert.match(source, /Planned starter · Matchup/);
});

test('the batch does not alter scoring rules or the projection engine', async () => {
  const packageRoot = new URL('../../', import.meta.url);
  const [scoringRules, projectionUtility] = await Promise.all([
    readFile(new URL('src/app/core/scoring/scoring-rules.ts', packageRoot), 'utf8'),
    readFile(new URL('src/app/core/projection/cycle-projection.util.ts', packageRoot), 'utf8'),
  ]);

  assert.match(scoringRules, /CURRENT_SCORING_RULES_VERSION = 4/);
  assert.match(scoringRules, /goal:\s*\{\s*first: 6,/);
  assert.match(scoringRules, /DEFAULT_GOALIE_GAME_MAXIMUM = 28/);
  assert.match(projectionUtility, /LW: 0\.98/);
  assert.match(projectionUtility, /D: 0\.97/);
  assert.match(projectionUtility, /G: 0\.96/);
});
