import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const requireFunctions = createRequire(
  new URL('../../functions/package.json', import.meta.url),
);
const {
  createFutureMatchupLineupActivationAuditDocumentId,
  createFutureMatchupLineupAssignmentHash,
  deriveFutureMatchupLineupPlanStatus,
  normalizeFutureMatchupLineupPlan,
  resolveFutureLineupSlotAtBoundary,
  validateFutureMatchupLineupSlots,
} = requireFunctions(
  './lib/shared/core/team/future-matchup-lineup.util.js',
);
const {
  snapshotSourceStartsFreshRosterAssignment,
} = requireFunctions(
  './lib/shared/core/cycle/player-window-continuity.util.js',
);
const cycleScoring = requireFunctions(
  './lib/shared/core/cycle/cycle-scoring.service.js',
);
const nhlApi = requireFunctions(
  './lib/shared/core/nhl/nhl-api.service.js',
);
const { defaultScoringRules } = requireFunctions(
  './lib/shared/core/scoring/scoring-rules.js',
);

test('future-lineup snapshots are an exact fresh-assignment source', () => {
  assert.equal(
    snapshotSourceStartsFreshRosterAssignment('future-lineup-plan'),
    true,
  );
  assert.equal(
    snapshotSourceStartsFreshRosterAssignment('queued-slot-move'),
    true,
  );
  assert.equal(
    snapshotSourceStartsFreshRosterAssignment('future-lineup-plan-v2'),
    false,
  );
  assert.equal(
    snapshotSourceStartsFreshRosterAssignment('slot-window-advance'),
    false,
  );
});

test('future-lineup goalie scoring excludes games that began before materialization', async (t) => {
  const materializedAt = Date.parse('2026-10-01T11:00:00.000Z');
  t.mock.method(Date, 'now', () => Date.parse('2026-10-01T12:00:00.000Z'));
  const schedule = Array.from({ length: 7 }, (_, index) => ({
    id: index + 1,
    gameDate: `2026-10-${String(index + 1).padStart(2, '0')}`,
    startTimeUTC: index === 0
      ? '2026-10-01T10:00:00.000Z'
      : `2026-10-${String(index + 1).padStart(2, '0')}T13:00:00.000Z`,
    gameType: 2,
    gameState: index === 0 ? 'FINAL' : 'FUT',
    homeTeam: { abbrev: 'VAN', ...(index === 0 ? { score: 3 } : {}) },
    awayTeam: { abbrev: 'SEA', ...(index === 0 ? { score: 2 } : {}) },
  }));
  t.mock.method(nhlApi, 'getNhlTeamSeasonSchedule', async () => schedule);
  const pick = {
    overallPick: 1,
    round: 0,
    pickInRound: 1,
    ownerId: 'owner-a',
    rosterSlotId: 'G-1',
    cycleWindowId: 'owner-a__G-1__cycle-2',
    snapshotCycleNumber: 2,
    sourceNhlBlockNumber: 1,
    snapshotSource: 'future-lineup-plan',
    snapshottedAt: { toMillis: () => materializedAt },
    asset: {
      assetKey: 'goalie-unit-VAN',
      assetType: 'team-goalie-unit',
      position: 'G',
      teamName: 'Vancouver Canucks Goalies',
      teamAbbreviation: 'VAN',
    },
  };

  const result = await cycleScoring.calculateCycleScoring({
    picks: [pick],
    cycleNumber: 2,
    season: '20262027',
    requiredGamesPerCycle: 6,
    scoringRules: defaultScoringRules,
  });

  assert.deepEqual(
    result.windowScores[pick.cycleWindowId].scheduledGameIds,
    [2, 3, 4, 5, 6, 7],
  );
});

test('future-lineup audit IDs preserve distinct custom Firebase UID identities', () => {
  const common = {
    cycleNumber: 2,
    revision: 1,
    rosterSlotId: 'C-1',
  };
  const colonUid = createFutureMatchupLineupActivationAuditDocumentId({
    ...common,
    ownerId: 'manager:a',
  });
  const dashUid = createFutureMatchupLineupActivationAuditDocumentId({
    ...common,
    ownerId: 'manager-a',
  });

  assert.match(colonUid, /^future-lineup-[a-f0-9]{64}$/);
  assert.notEqual(colonUid, dashUid);
  assert.equal(
    colonUid,
    createFutureMatchupLineupActivationAuditDocumentId({
      ...common,
      ownerId: 'manager:a',
    }),
  );
});

function skater(id, position = 'C', rosterStatus = 'active') {
  return {
    assetKey: `skater-${id}`,
    assetType: 'skater',
    position,
    rosterStatus,
    player: {
      id,
      fullName: `Player ${id}`,
      position,
      nhlTeamAbbreviation: 'SEA',
    },
    cycleScore: { cycleNumber: 1, gamesCounted: 0, fantasyPoints: 0 },
  };
}

function roster(overrides = {}) {
  return {
    schemaVersion: 2,
    activeSlots: [
      { slotId: 'C-1', position: 'C', slotNumber: 1, asset: skater(1) },
      { slotId: 'C-2', position: 'C', slotNumber: 2, asset: skater(2) },
    ],
    benchSlots: [
      { slotId: 'B-1', slotNumber: 1, asset: skater(3, 'C', 'benched') },
      { slotId: 'B-2', slotNumber: 2, asset: skater(4, 'LW', 'benched') },
    ],
    irSlots: [
      { slotId: 'IR-1', slotNumber: 1, asset: skater(5, 'C', 'injured') },
    ],
    ...overrides,
  };
}

test('full plans accept same-slot active assets and compatible bench swaps', () => {
  const saved = validateFutureMatchupLineupSlots(roster(), [
    { rosterSlotId: 'C-2', assetKey: 'skater-2' },
    { rosterSlotId: 'C-1', assetKey: 'skater-3' },
  ], { targetCycleNumber: 2 });

  assert.deepEqual(saved, [
    { rosterSlotId: 'C-1', assetKey: 'skater-3' },
    { rosterSlotId: 'C-2', assetKey: 'skater-2' },
  ]);
  assert.equal(createFutureMatchupLineupAssignmentHash(saved).length, 64);
});

test('plans reject IR assets, cross-slot active moves, duplicates, and position mismatches', () => {
  assert.throws(
    () => validateFutureMatchupLineupSlots(roster(), [
      { rosterSlotId: 'C-1', assetKey: 'skater-5' },
      { rosterSlotId: 'C-2', assetKey: 'skater-2' },
    ], { targetCycleNumber: 2 }),
    /not currently active or benched/,
  );
  assert.throws(
    () => validateFutureMatchupLineupSlots(roster(), [
      { rosterSlotId: 'C-1', assetKey: 'skater-2' },
      { rosterSlotId: 'C-2', assetKey: 'skater-1' },
    ], { targetCycleNumber: 2 }),
    /must remain/,
  );
  assert.throws(
    () => validateFutureMatchupLineupSlots(roster(), [
      { rosterSlotId: 'C-1', assetKey: 'skater-3' },
      { rosterSlotId: 'C-2', assetKey: 'skater-3' },
    ], { targetCycleNumber: 2 }),
    /only one active roster slot/,
  );
  assert.throws(
    () => validateFutureMatchupLineupSlots(roster(), [
      { rosterSlotId: 'C-1', assetKey: 'skater-4' },
      { rosterSlotId: 'C-2', assetKey: 'skater-2' },
    ], { targetCycleNumber: 2 }),
    /not eligible/,
  );
});

test('bench assets cannot be planned before their authoritative eligible cycle', () => {
  const restrictedRoster = roster({
    benchSlots: [
      {
        slotId: 'B-1',
        slotNumber: 1,
        asset: {
          ...skater(3, 'C', 'benched'),
          eligibleFromCycleNumber: 3,
        },
      },
    ],
  });
  const slots = [
    { rosterSlotId: 'C-1', assetKey: 'skater-3' },
    { rosterSlotId: 'C-2', assetKey: 'skater-2' },
  ];

  assert.throws(
    () => validateFutureMatchupLineupSlots(
      restrictedRoster,
      slots,
      { targetCycleNumber: 2 },
    ),
    /not eligible until Cycle 3/,
  );
  assert.deepEqual(
    validateFutureMatchupLineupSlots(
      restrictedRoster,
      slots,
      { targetCycleNumber: 3 },
    ),
    slots,
  );
  assert.equal(
    resolveFutureLineupSlotAtBoundary({
      roster: restrictedRoster,
      rosterSlotId: 'C-1',
      planSlot: {
        rosterSlotId: 'C-1',
        assetKey: 'skater-3',
        resolution: 'planned',
      },
      targetCycleNumber: 2,
    }).reason,
    'desired-asset-unavailable',
  );
});

test('materialized slots remain valid even after their locked asset leaves the roster', () => {
  const changedRoster = roster({
    activeSlots: [
      { slotId: 'C-1', position: 'C', slotNumber: 1, asset: null },
      { slotId: 'C-2', position: 'C', slotNumber: 2, asset: skater(2) },
    ],
    benchSlots: [
      { slotId: 'B-1', slotNumber: 1, asset: skater(6, 'C', 'benched') },
    ],
  });

  assert.deepEqual(
    validateFutureMatchupLineupSlots(
      changedRoster,
      [
        { rosterSlotId: 'C-1', assetKey: 'skater-99' },
        { rosterSlotId: 'C-2', assetKey: 'skater-6' },
      ],
      {
        lockedRosterSlotIds: new Set(['C-1']),
        targetCycleNumber: 2,
      },
    ),
    [
      { rosterSlotId: 'C-1', assetKey: 'skater-99' },
      { rosterSlotId: 'C-2', assetKey: 'skater-6' },
    ],
  );
});

test('slot-boundary resolution gives pending moves precedence and fails stale assets visibly', () => {
  assert.deepEqual(
    resolveFutureLineupSlotAtBoundary({
      roster: roster(),
      rosterSlotId: 'C-1',
      planSlot: {
        rosterSlotId: 'C-1',
        assetKey: 'skater-1',
        resolution: 'planned',
      },
      targetCycleNumber: 2,
    }),
    {
      kind: 'unchanged',
      desiredAssetKey: 'skater-1',
      incomingAsset: skater(1),
      sourceBenchSlotId: null,
      reason: null,
    },
  );

  const plannedSlot = {
    rosterSlotId: 'C-1',
    assetKey: 'skater-3',
    resolution: 'planned',
  };
  assert.deepEqual(
    resolveFutureLineupSlotAtBoundary({
      roster: roster(),
      rosterSlotId: 'C-1',
      planSlot: plannedSlot,
      targetCycleNumber: 2,
    }),
    {
      kind: 'swap',
      desiredAssetKey: 'skater-3',
      incomingAsset: skater(3, 'C', 'benched'),
      sourceBenchSlotId: 'B-1',
      reason: null,
    },
  );

  const pendingRoster = roster();
  pendingRoster.activeSlots[0].pendingMove = {
    id: 'pending-1',
    incomingAsset: skater(8, 'C', 'benched'),
  };
  assert.equal(
    resolveFutureLineupSlotAtBoundary({
      roster: pendingRoster,
      rosterSlotId: 'C-1',
      planSlot: plannedSlot,
      targetCycleNumber: 2,
    }).reason,
    'pending-roster-move',
  );

  const staleRoster = roster({ benchSlots: [] });
  assert.equal(
    resolveFutureLineupSlotAtBoundary({
      roster: staleRoster,
      rosterSlotId: 'C-1',
      planSlot: plannedSlot,
      targetCycleNumber: 2,
    }).reason,
    'desired-asset-unavailable',
  );
});

test('plan status is deterministic across partial and conflict resolution', () => {
  assert.equal(deriveFutureMatchupLineupPlanStatus([
    { rosterSlotId: 'C-1', assetKey: 'skater-1', resolution: 'planned' },
  ]), 'planned');
  assert.equal(deriveFutureMatchupLineupPlanStatus([
    { rosterSlotId: 'C-1', assetKey: 'skater-1', resolution: 'unchanged' },
    { rosterSlotId: 'C-2', assetKey: 'skater-2', resolution: 'planned' },
  ]), 'partially-applied');
  assert.equal(deriveFutureMatchupLineupPlanStatus([
    { rosterSlotId: 'C-1', assetKey: 'skater-1', resolution: 'conflict' },
    { rosterSlotId: 'C-2', assetKey: 'skater-2', resolution: 'planned' },
  ]), 'conflicted');
  assert.equal(deriveFutureMatchupLineupPlanStatus([
    { rosterSlotId: 'C-1', assetKey: 'skater-1', resolution: 'unchanged' },
    { rosterSlotId: 'C-2', assetKey: 'skater-3', resolution: 'applied' },
  ]), 'applied');
});

test('persisted plans fail closed when their assignment hash does not match the slots', () => {
  const slots = [
    { rosterSlotId: 'C-1', assetKey: 'skater-1', resolution: 'planned' },
    { rosterSlotId: 'C-2', assetKey: 'skater-2', resolution: 'planned' },
  ];
  const saved = {
    schemaVersion: 1,
    ownerId: 'owner-1',
    cycleNumber: 2,
    revision: 1,
    status: 'planned',
    assignmentHash: createFutureMatchupLineupAssignmentHash(slots),
    slots,
  };

  assert.ok(normalizeFutureMatchupLineupPlan(saved));
  assert.equal(normalizeFutureMatchupLineupPlan({
    ...saved,
    assignmentHash: '0'.repeat(64),
  }), null);
});

test('persisted resolution evidence requires an explicit authoritative asset', () => {
  const desiredSlots = [
    { rosterSlotId: 'C-1', assetKey: 'skater-3' },
  ];
  const saved = {
    schemaVersion: 1,
    ownerId: 'owner-1',
    cycleNumber: 2,
    revision: 1,
    status: 'conflicted',
    assignmentHash: createFutureMatchupLineupAssignmentHash(desiredSlots),
    slots: [{
      ...desiredSlots[0],
      resolution: 'conflict',
      resolvedAssetKey: null,
    }],
  };

  assert.equal(
    normalizeFutureMatchupLineupPlan(saved)?.slots[0].resolvedAssetKey,
    null,
  );
  assert.equal(normalizeFutureMatchupLineupPlan({
    ...saved,
    slots: [{ ...desiredSlots[0], resolution: 'conflict' }],
  }), null);
  assert.equal(normalizeFutureMatchupLineupPlan({
    ...saved,
    slots: [{
      ...desiredSlots[0],
      resolution: 'planned',
      resolvedAssetKey: 'skater-1',
    }],
  }), null);
});

test('server wiring keeps plans private and consumes them in both regular rollover paths', async () => {
  const root = new URL('../../', import.meta.url);
  const [authority, cycleService, functionsIndex, rules] = await Promise.all([
    readFile(new URL('functions/src/future-matchup-lineup.ts', root), 'utf8'),
    readFile(new URL('functions/src/shared/core/cycle/cycle.service.ts', root), 'utf8'),
    readFile(new URL('functions/src/index.ts', root), 'utf8'),
    readFile(new URL('firestore.rules', root), 'utf8'),
  ]);

  assert.match(authority, /manageFutureMatchupLineups = onCall/);
  assert.match(authority, /lineupPlans/);
  assert.match(authority, /cycle-\$\{cycleNumber\}/);
  assert.match(authority, /lineupPlanMutationState/);
  assert.match(authority, /MAX_MUTATION_RECEIPTS_PER_CYCLE = 64/);
  assert.match(authority, /'historical-replay-active'/);
  assert.match(authority, /'playoffs-not-supported'/);
  assert.match(authority, /'cross-cycle-asset-conflict'/);
  assert.match(authority, /'revision-conflict'/);
  assert.match(functionsIndex, /manageFutureMatchupLineups/);
  assert.match(cycleService, /future-lineup-plan/);
  assert.match(cycleService, /buildNextWindowSnapshotPicks[\s\S]*futureLineupPlansBySlotKey/);
  assert.match(cycleService, /startNextCycle[\s\S]*regularFutureLineupPlansBySlotKey/);
  assert.match(cycleService, /target-window-already-materialized/);
  assert.doesNotMatch(cycleService, /transactionFallbackPickBuildersBySlotKey/);
  assert.doesNotMatch(cycleService, /active-roster-race-fallback/);
  assert.match(
    cycleService,
    /const pushSafeFallback = \(\) => \{[\s\S]*throw new Error\([\s\S]*adjustedCyclePicks\.push\(transactionFallbackPick\)/,
  );
  assert.match(
    cycleService,
    /const futurePlanOwnerIds = \[[\s\S]*Object\.values\(futureLineupPlansBySlotKey\)[\s\S]*Object\.keys\(openSlotRolloversByOwner\)/,
  );
  assert.match(
    cycleService,
    /getRosterAssetKey\(rosterSlot\.asset\) === pick\.asset\.assetKey[\s\S]*\? pick[\s\S]*: null/,
  );
  assert.doesNotMatch(rules, /lineupPlans|lineupPlanMutationState/);
});

test('regular-season persistence advances child windows before completing the parent cycle', async () => {
  const source = await readFile(
    new URL('../../functions/src/league-automation.ts', import.meta.url),
    'utf8',
  );
  const persistStart = source.indexOf('async function persistServerScoring(');
  const regularBranch = source.indexOf(
    "if (cycle.phase === 'regular_season')",
    persistStart,
  );
  const advanceIndex = source.indexOf(
    'await advanceCompletedRegularSeasonAssetWindows(',
    regularBranch,
  );
  const completionIndex = source.indexOf(
    'await reconcileRegularSeasonCycleMatchupCompletion(',
    regularBranch,
  );
  const branchEnd = source.indexOf(
    "if (completion.cycleCompleted)",
    regularBranch,
  );

  assert.ok(persistStart >= 0);
  assert.ok(regularBranch >= 0);
  assert.ok(advanceIndex > regularBranch);
  assert.ok(completionIndex > advanceIndex);
  assert.ok(branchEnd > completionIndex);
});
