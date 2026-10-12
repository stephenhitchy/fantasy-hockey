import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const ROOT = new URL('../../', import.meta.url);

async function loadFutureMatchupLineupUtil() {
  const dependencySource = stripTypeScriptTypes(
    await readFile(
      new URL('src/app/core/cycle/cycle-window-selection.util.ts', ROOT),
      'utf8',
    ),
    { mode: 'strip' },
  );
  const dependencyUrl = `data:text/javascript;base64,${Buffer.from(dependencySource).toString('base64')}`;
  const utilitySource = (
    await readFile(
      new URL('src/app/core/team/future-matchup-lineup.util.ts', ROOT),
      'utf8',
    )
  ).replace(
    "from '../cycle/cycle-window-selection.util';",
    `from '${dependencyUrl}';`,
  );
  const utilityJavaScript = stripTypeScriptTypes(utilitySource, { mode: 'strip' });
  const utilityUrl = `data:text/javascript;base64,${Buffer.from(utilityJavaScript).toString('base64')}`;

  return import(utilityUrl);
}

const {
  areFutureMatchupLineupSlotsEqual,
  buildFutureMatchupLineupCandidates,
  buildFutureMatchupLineupOptions,
  buildFutureMatchupProjectedLineup,
  hasFutureMatchupLineupPendingMoveBlock,
  isFutureMatchupCandidateCompatible,
  isFutureMatchupWindowLocked,
  resolveFutureMatchupSlotDateState,
  selectFutureMatchupProjectedGames,
  validateFutureMatchupLineupDraft,
} = await loadFutureMatchupLineupUtil();

function skater(assetKey, position, team = 'SEA', overrides = {}) {
  return {
    assetType: 'skater',
    assetKey,
    position,
    player: {
      id: Number(assetKey.replace(/\D/g, '')) || 1,
      fullName: assetKey,
      position,
      nhlTeamAbbreviation: team,
    },
    cycleScore: { cycleNumber: 1, gamesCounted: 0, fantasyPoints: 0 },
    ...overrides,
  };
}

function activeSlot(slotId, position, slotNumber, asset, overrides = {}) {
  return {
    slotId,
    position,
    slotNumber,
    asset,
    pendingMove: null,
    openFromCycleNumber: null,
    ...overrides,
  };
}

function roster(overrides = {}) {
  return {
    schemaVersion: 2,
    activeSlots: [
      activeSlot('LW-1', 'LW', 1, skater('skater-1', 'LW')),
      activeSlot('LW-2', 'LW', 2, skater('skater-2', 'LW')),
    ],
    benchSlots: [
      { slotId: 'B-1', slotNumber: 1, asset: skater('skater-3', 'LW', 'VAN') },
    ],
    irSlots: [
      { slotId: 'IR-1', slotNumber: 1, asset: skater('skater-4', 'LW', 'CGY') },
    ],
    ...overrides,
  };
}

function windowFor(asset, overrides = {}) {
  return {
    id: 'owner-a__LW-1__cycle-2',
    ownerId: 'owner-a',
    rosterSlotId: 'LW-1',
    cycleNumber: 2,
    sourceNhlBlockNumber: 3,
    position: 'LW',
    assetKey: asset.assetKey,
    asset,
    status: 'scheduled',
    scheduledGameIds: [1, 2, 3, 4, 5, 6],
    scheduledGameDates: [
      '2026-10-12',
      '2026-10-14',
      '2026-10-17',
      '2026-10-19',
      '2026-10-21',
      '2026-10-24',
    ],
    scheduledGameLabels: [],
    completedGameIds: [],
    liveGameIds: [],
    appearanceGameIds: [],
    gameScores: {},
    gameStates: {},
    scheduledGames: 6,
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
    firstScheduledGameDate: '2026-10-12',
    lastScheduledGameDate: '2026-10-24',
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function plan(slots, overrides = {}) {
  return {
    ownerId: 'owner-a',
    cycleNumber: 2,
    revision: 1,
    status: 'planned',
    slots,
    materializedSlotCount: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

function game(id, gameDate, home = 'SEA', away = 'VAN') {
  return {
    id,
    gameDate,
    gameType: 2,
    homeTeam: { abbrev: home },
    awayTeam: { abbrev: away },
  };
}

test('matchup options use the exact current matchup and omit completed periods', () => {
  const options = buildFutureMatchupLineupOptions({
    ownerId: 'owner-a',
    teams: [
      { ownerId: 'owner-a', teamName: 'Rats' },
      { ownerId: 'owner-b', teamName: 'Owls' },
    ],
    cycles: [
      { cycleNumber: 1, status: 'complete', phase: 'regular_season' },
      { cycleNumber: 2, status: 'active', phase: 'regular_season', sourceNhlBlockNumber: 4 },
    ],
    schedulePreview: [
      { cycleNumber: 1, matchups: [{ id: 'matchup-1', teamAOwnerId: 'owner-a', teamBOwnerId: 'owner-b' }] },
      { cycleNumber: 2, matchups: [{ id: 'matchup-1', teamAOwnerId: 'owner-b', teamBOwnerId: 'owner-a' }] },
      { cycleNumber: 3, matchups: [{ id: 'matchup-1', teamAOwnerId: 'owner-a', teamBOwnerId: null }] },
    ],
    currentMatchup: {
      id: 'saved-matchup',
      cycleNumber: 2,
      phase: 'regular_season',
      teamAOwnerId: 'owner-b',
      teamBOwnerId: 'owner-a',
      status: 'active',
    },
    initialNhlBlockNumber: 3,
  });

  assert.deepEqual(options.map((option) => option.cycleNumber), [2, 3]);
  assert.equal(options[0].matchupId, 'saved-matchup');
  assert.equal(options[0].timing, 'current');
  assert.equal(options[0].sourceNhlBlockNumber, 4);
  assert.equal(options[0].label, 'Matchup 2 · vs Owls · Current');
  assert.equal(options[1].isBye, true);
  assert.equal(options[1].sourceNhlBlockNumber, 5);
});

test('candidate inventory is active plus bench, with active assets bound to their own slot', () => {
  const candidates = buildFutureMatchupLineupCandidates(roster(), 2);
  const firstActive = candidates.find((candidate) => candidate.assetKey === 'skater-1');
  const bench = candidates.find((candidate) => candidate.assetKey === 'skater-3');

  assert.deepEqual(candidates.map((candidate) => candidate.assetKey), [
    'skater-1',
    'skater-2',
    'skater-3',
  ]);
  assert.equal(isFutureMatchupCandidateCompatible(firstActive, 'LW', 'LW-1'), true);
  assert.equal(isFutureMatchupCandidateCompatible(firstActive, 'LW', 'LW-2'), false);
  assert.equal(isFutureMatchupCandidateCompatible(bench, 'LW', 'LW-2'), true);
});

test('projected lineup accepts a bench promotion but marks a cross-active assignment conflicted', () => {
  const futureRoster = roster();
  const projected = buildFutureMatchupProjectedLineup({
    cycleNumber: 2,
    roster: futureRoster,
    windows: [],
    plan: plan([
      { rosterSlotId: 'LW-1', assetKey: 'skater-3', resolution: 'planned' },
      { rosterSlotId: 'LW-2', assetKey: 'skater-1', resolution: 'planned' },
    ]),
  });

  assert.equal(projected[0].origin, 'saved-plan');
  assert.equal(projected[0].assetKey, 'skater-3');
  assert.equal(projected[1].origin, 'conflict');
  assert.match(projected[1].reason, /no longer available|remain/i);
});

test('later previews compose valid earlier plans while selected plans and windows keep precedence', () => {
  const futureRoster = roster();
  const earlierPlan = plan([
    { rosterSlotId: 'LW-1', assetKey: 'skater-3', resolution: 'planned' },
    { rosterSlotId: 'LW-2', assetKey: 'skater-2', resolution: 'planned' },
  ], { cycleNumber: 2 });
  const conflictedPlan = plan([
    {
      rosterSlotId: 'LW-1',
      assetKey: 'skater-99',
      resolution: 'conflict',
      reason: 'The requested asset was unavailable.',
    },
  ], { cycleNumber: 3, status: 'conflicted', materializedSlotCount: 1 });
  const composed = buildFutureMatchupProjectedLineup({
    cycleNumber: 4,
    baseCycleNumber: 1,
    roster: futureRoster,
    windows: [],
    plan: null,
    plans: [conflictedPlan, earlierPlan],
  });

  assert.equal(composed[0].assetKey, 'skater-3');
  assert.equal(composed[0].origin, 'preceding-plan');

  const selectedPlan = plan([
    { rosterSlotId: 'LW-1', assetKey: 'skater-1', resolution: 'planned' },
    { rosterSlotId: 'LW-2', assetKey: 'skater-2', resolution: 'planned' },
  ], { cycleNumber: 4 });
  const selected = buildFutureMatchupProjectedLineup({
    cycleNumber: 4,
    baseCycleNumber: 1,
    roster: futureRoster,
    windows: [],
    plan: selectedPlan,
    plans: [earlierPlan, conflictedPlan, selectedPlan],
  });

  assert.equal(selected[0].assetKey, 'skater-1');
  assert.equal(selected[0].origin, 'saved-plan');

  const materialized = buildFutureMatchupProjectedLineup({
    cycleNumber: 4,
    baseCycleNumber: 1,
    roster: futureRoster,
    windows: [windowFor(skater('skater-3', 'LW'), { cycleNumber: 4 })],
    plan: selectedPlan,
    plans: [earlierPlan, conflictedPlan, selectedPlan],
  });

  assert.equal(materialized[0].assetKey, 'skater-3');
  assert.equal(materialized[0].origin, 'materialized-window');
  assert.equal(materialized[0].locked, true);
});

test('materialized windows stay immutable even before their NHL games start', () => {
  const futureRoster = roster();
  const savedAsset = skater('skater-1', 'LW');
  const scheduledWindow = windowFor(savedAsset);
  const startedWindow = windowFor(savedAsset, {
    status: 'active',
    completedGameIds: [1],
    gamesPlayed: 1,
    gameStates: { 1: 'final' },
    startedAt: '2026-10-12T02:00:00.000Z',
  });

  assert.equal(isFutureMatchupWindowLocked(scheduledWindow), true);
  assert.equal(isFutureMatchupWindowLocked(startedWindow), true);

  const [locked] = buildFutureMatchupProjectedLineup({
    cycleNumber: 2,
    roster: futureRoster,
    windows: [startedWindow],
    plan: plan([
      { rosterSlotId: 'LW-1', assetKey: 'skater-3', resolution: 'planned' },
    ]),
  });

  assert.equal(locked.assetKey, 'skater-1');
  assert.equal(locked.origin, 'materialized-window');
  assert.equal(locked.editable, false);
});

test('materialized windows stay authoritative when a saved plan conflicts', () => {
  const futureRoster = roster();
  const savedPlan = plan([
    {
      rosterSlotId: 'LW-1',
      assetKey: 'skater-99',
      resolution: 'conflict',
      reason: 'Reserved by another cycle.',
      resolvedAtMs: 10,
    },
    { rosterSlotId: 'LW-2', assetKey: 'skater-2', resolution: 'planned' },
  ], {
    status: 'conflicted',
    materializedSlotCount: 1,
  });
  const projected = buildFutureMatchupProjectedLineup({
    cycleNumber: 2,
    roster: futureRoster,
    windows: [windowFor(skater('skater-1', 'LW'))],
    plan: savedPlan,
  });

  assert.equal(projected[0].assetKey, 'skater-1');
  assert.equal(projected[0].origin, 'conflict');
  assert.equal(projected[0].editable, false);
  assert.equal(projected[0].locked, true);

  const unchanged = validateFutureMatchupLineupDraft({
    roster: futureRoster,
    cycleNumber: 2,
    plan: savedPlan,
    slots: [
      { rosterSlotId: 'LW-1', assetKey: 'skater-99' },
      { rosterSlotId: 'LW-2', assetKey: 'skater-2' },
    ],
  });
  const changed = validateFutureMatchupLineupDraft({
    roster: futureRoster,
    cycleNumber: 2,
    plan: savedPlan,
    slots: [
      { rosterSlotId: 'LW-1', assetKey: 'skater-1' },
      { rosterSlotId: 'LW-2', assetKey: 'skater-2' },
    ],
  });

  assert.equal(unchanged.valid, true);
  assert.equal(changed.valid, false);
  assert.match(changed.issues.join(' '), /cannot be changed/i);
});

test('resolved plan assets drive locked display and validation without changing saved intent', () => {
  const futureRoster = roster();
  const resolvedPlan = plan([
    {
      rosterSlotId: 'LW-1',
      assetKey: 'skater-99',
      resolvedAssetKey: 'skater-1',
      resolution: 'conflict',
      reason: 'The requested asset was unavailable.',
    },
    {
      rosterSlotId: 'LW-2',
      assetKey: 'skater-2',
      resolvedAssetKey: 'skater-2',
      resolution: 'unchanged',
    },
  ], { status: 'conflicted', materializedSlotCount: 2 });
  const projected = buildFutureMatchupProjectedLineup({
    cycleNumber: 2,
    roster: futureRoster,
    windows: [],
    plan: resolvedPlan,
  });

  assert.equal(resolvedPlan.slots[0].assetKey, 'skater-99');
  assert.equal(projected[0].assetKey, 'skater-1');
  assert.equal(projected[0].locked, true);
  assert.equal(validateFutureMatchupLineupDraft({
    roster: futureRoster,
    cycleNumber: 2,
    plan: resolvedPlan,
    slots: projected.map(({ rosterSlotId, assetKey }) => ({ rosterSlotId, assetKey })),
  }).valid, true);

  const openRoster = roster({
    activeSlots: [
      activeSlot('LW-1', 'LW', 1, null),
      activeSlot('LW-2', 'LW', 2, skater('skater-2', 'LW')),
    ],
  });
  const resolvedOpenPlan = plan([
    {
      rosterSlotId: 'LW-1',
      assetKey: 'skater-3',
      resolvedAssetKey: null,
      resolution: 'conflict',
    },
    {
      rosterSlotId: 'LW-2',
      assetKey: 'skater-2',
      resolvedAssetKey: 'skater-2',
      resolution: 'unchanged',
    },
  ], { status: 'conflicted', materializedSlotCount: 2 });
  const [resolvedOpenSlot] = buildFutureMatchupProjectedLineup({
    cycleNumber: 2,
    roster: openRoster,
    windows: [],
    plan: resolvedOpenPlan,
  });

  assert.equal(resolvedOpenSlot.assetKey, null);
  assert.equal(validateFutureMatchupLineupDraft({
    roster: openRoster,
    cycleNumber: 2,
    plan: resolvedOpenPlan,
    slots: [
      { rosterSlotId: 'LW-1', assetKey: null },
      { rosterSlotId: 'LW-2', assetKey: 'skater-2' },
    ],
  }).valid, true);
});

test('validation rejects empty occupied slots, cross-active moves, duplicates, and pending moves', () => {
  const pendingRoster = roster();
  pendingRoster.activeSlots[0].pendingMove = {
    id: 'queued-1',
    moveType: 'add-drop',
    incomingAsset: skater('skater-5', 'LW'),
    outgoingAssetKey: 'skater-1',
    sourceWaiverId: null,
    queuedByOwnerId: 'owner-a',
    queuedAt: '2026-10-01T00:00:00.000Z',
    requestedEffectiveCycleNumber: 2,
    requestedEffectiveLabel: 'Matchup 2',
  };

  assert.equal(hasFutureMatchupLineupPendingMoveBlock(pendingRoster), true);

  const validation = validateFutureMatchupLineupDraft({
    roster: pendingRoster,
    cycleNumber: 2,
    slots: [
      { rosterSlotId: 'LW-1', assetKey: null },
      { rosterSlotId: 'LW-2', assetKey: 'skater-1' },
    ],
  });

  assert.equal(validation.valid, false);
  assert.match(validation.issues.join(' '), /queued roster move/i);
  assert.match(validation.issues.join(' '), /cannot be saved as empty/i);
  assert.match(validation.issues.join(' '), /must remain/i);
});

test('validation accepts an old asset in a materialized slot while checking unresolved slots', () => {
  const currentRoster = roster();
  const oldAsset = skater('skater-99', 'LW');
  const validation = validateFutureMatchupLineupDraft({
    roster: currentRoster,
    cycleNumber: 2,
    plan: null,
    windows: [windowFor(oldAsset)],
    slots: [
      { rosterSlotId: 'LW-1', assetKey: 'skater-99' },
      { rosterSlotId: 'LW-2', assetKey: 'skater-2' },
    ],
  });

  assert.deepEqual(validation, { valid: true, issues: [] });
});

test('slot comparison is order-independent but preserves null assignments', () => {
  assert.equal(
    areFutureMatchupLineupSlotsEqual(
      [
        { rosterSlotId: 'LW-1', assetKey: 'skater-1' },
        { rosterSlotId: 'LW-2', assetKey: null },
      ],
      [
        { rosterSlotId: 'LW-2', assetKey: null },
        { rosterSlotId: 'LW-1', assetKey: 'skater-1' },
      ],
    ),
    true,
  );
});

test('saved window dates win while materialized identity mismatches stay pending', () => {
  const savedAsset = skater('skater-1', 'LW');
  const savedWindow = windowFor(savedAsset);
  const projectedGames = [game(11, '2026-11-02'), game(12, '2026-11-04')];

  assert.deepEqual(
    resolveFutureMatchupSlotDateState({
      assetKey: 'skater-1',
      savedWindow,
      projectedGames,
      now: new Date('2026-10-12T23:00:00.000Z'),
      locale: 'en-US',
    }),
    {
      source: 'saved',
      startDate: '2026-10-12',
      endDate: '2026-10-24',
      label: 'Starts Oct 12',
    },
  );

  const mismatchedMaterialized = resolveFutureMatchupSlotDateState({
    assetKey: 'skater-3',
    savedWindow,
    projectedGames,
    locale: 'en-US',
  });
  assert.equal(mismatchedMaterialized.source, 'pending');
  assert.equal(mismatchedMaterialized.label, 'Pending');

  const projected = resolveFutureMatchupSlotDateState({
    assetKey: 'skater-3',
    savedWindow: null,
    projectedGames,
    locale: 'en-US',
  });
  assert.equal(projected.source, 'projected');
  assert.equal(projected.label, 'Begins Nov 2');

  const materializedBeforeFirstGame = resolveFutureMatchupSlotDateState({
    assetKey: 'skater-1',
    savedWindow: windowFor(savedAsset, {
      status: 'active',
      scheduledGameDates: ['2026-10-13'],
      firstScheduledGameDate: '2026-10-13',
      lastScheduledGameDate: '2026-10-13',
      startedAt: '2026-10-12T18:00:00.000Z',
    }),
    projectedGames: [],
    now: new Date('2026-10-12T23:00:00.000Z'),
    locale: 'en-US',
  });
  assert.equal(materializedBeforeFirstGame.label, 'Starts Oct 13');

  const pending = resolveFutureMatchupSlotDateState({
    assetKey: 'skater-1',
    savedWindow: windowFor(savedAsset, {
      status: 'active',
      scheduledGameDates: [],
      firstScheduledGameDate: null,
      lastScheduledGameDate: null,
      liveGameIds: [1],
    }),
    projectedGames,
  });
  assert.equal(pending.source, 'pending');
  assert.equal(pending.label, 'Pending');
});

test('projected games honor stable IDs rather than a reordered provider slice', () => {
  const schedule = [
    game(4, '2026-10-04'),
    game(1, '2026-10-01'),
    game(3, '2026-10-03'),
    game(2, '2026-10-02'),
  ];
  const selected = selectFutureMatchupProjectedGames({
    schedule,
    targetGameIds: [2, 4],
    sourceNhlBlockNumber: 1,
    requiredGamesPerCycle: 2,
  });

  assert.deepEqual(selected.map((entry) => entry.id), [2, 4]);
});

test('client service uses one callable, bounded context reads, one-owner windows, and no listener', async () => {
  const source = await readFile(
    new URL('src/app/core/team/future-matchup-lineup.service.ts', ROOT),
    'utf8',
  );

  assert.match(source, /manageFutureMatchupLineups/);
  assert.match(source, /getFantasyDraft\(normalizedLeagueId\)/);
  assert.match(source, /getLeagueCycles\(normalizedLeagueId\)/);
  assert.match(source, /getAnchoredRegularSeasonCycleCount/);
  assert.match(source, /getCycleTeamWindowsRef\(/);
  assert.match(source, /'lineup-mutation-state-invalid'/);
  assert.match(source, /'cycle-state-invalid'/);
  assert.match(source, /'invalid-lineup-slots'/);
  assert.match(source, /'lineup-mutation-limit-exceeded'/);
  assert.match(source, /'plan-state-invalid'/);
  assert.match(source, /'target-pick-state-invalid'/);
  assert.match(source, /details\.reason !== 'lineup-mutation-limit-exceeded'/);
  assert.match(source, /resolvedAssetKey/);
  assert.doesNotMatch(source, /onSnapshot\(/);
  assert.doesNotMatch(source, /getCycleTeamWindows\(/);
});
