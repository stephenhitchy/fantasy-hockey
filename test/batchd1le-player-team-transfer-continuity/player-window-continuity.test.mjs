import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const require = createRequire(import.meta.url);
const {
  advancePlayerWindowContinuity,
  createPlayerWindowContinuity,
  mergeLegacyPlayerWindowContinuityCopies,
  normalizePlayerWindowContinuity,
  reconstructLegacyPlayerWindowContinuity,
} = require(
  `${ROOT_PATH}functions/lib/shared/core/cycle/player-window-continuity.util.js`,
);

function skater(id, team = 'TOR') {
  return {
    assetType: 'skater',
    assetKey: `skater-${id}`,
    position: 'LW',
    player: {
      id,
      fullName: `Skater ${id}`,
      position: 'LW',
      nhlTeamAbbreviation: team,
    },
  };
}

function goalieUnit(team = 'TOR') {
  return {
    assetType: 'team-goalie',
    assetKey: `team-goalie-${team}`,
    position: 'G',
    teamGoalie: {
      teamAbbreviation: team,
      teamName: `${team} Goalie Unit`,
    },
  };
}

test('normalization keeps only a valid versioned lineage and canonical evidence', () => {
  assert.equal(normalizePlayerWindowContinuity(null), undefined);
  assert.throws(
    () => normalizePlayerWindowContinuity({ schemaVersion: 2, continuityId: 'future' }),
    /unsupported schema/,
  );
  assert.throws(
    () => normalizePlayerWindowContinuity({ schemaVersion: 1, continuityId: '   ' }),
    /malformed/,
  );

  assert.deepEqual(
    normalizePlayerWindowContinuity({
      schemaVersion: 1,
      continuityId: '  owner::slot::skater-1::draft  ',
      ownerId: 'owner',
      rosterSlotId: 'slot',
      assetKey: 'skater-1',
      assignmentNotBeforeMilliseconds: 1_780_000_000_000,
      priorAssignedGameIds: [9, 7, 8],
      lastScheduleTeamAbbreviation: ' cbj ',
    }),
    {
      schemaVersion: 1,
      continuityId: 'owner::slot::skater-1::draft',
      ownerId: 'owner',
      rosterSlotId: 'slot',
      assetKey: 'skater-1',
      assignmentNotBeforeMilliseconds: 1_780_000_000_000,
      priorAssignedGameIds: [9, 7, 8],
      lastScheduleTeamAbbreviation: 'CBJ',
    },
  );
  assert.throws(
    () => normalizePlayerWindowContinuity({
      schemaVersion: 1,
      continuityId: 'owner::slot::skater-1::draft',
      ownerId: 'owner',
      rosterSlotId: 'slot',
      assetKey: 'skater-1',
      priorAssignedGameIds: [9, 9],
    }),
    /duplicates/,
  );
});

test('a skater activation creates an empty lineage scoped to owner, slot, asset, and activation', () => {
  assert.deepEqual(
    createPlayerWindowContinuity({
      ownerId: 'owner-a',
      rosterSlotId: 'lw-1',
      asset: skater(8482720, 'tor'),
      activationKey: 'draft-31',
    }),
    {
      schemaVersion: 1,
      continuityId: 'owner-a::lw-1::skater-8482720::draft-31',
      ownerId: 'owner-a',
      rosterSlotId: 'lw-1',
      assetKey: 'skater-8482720',
      priorAssignedGameIds: [],
      lastScheduleTeamAbbreviation: 'TOR',
    },
  );
});

test('a completed window carries the same skater lineage and reserves every assigned game once', () => {
  const previousAsset = skater(8482720, 'TOR');
  const advanced = advancePlayerWindowContinuity({
    previousAsset,
    nextAsset: skater(8482720, 'CBJ'),
    previousContinuity: {
      schemaVersion: 1,
      continuityId: 'owner-a::lw-1::skater-8482720::draft-31',
      ownerId: 'owner-a',
      rosterSlotId: 'lw-1',
      assetKey: 'skater-8482720',
      priorAssignedGameIds: [1, 2, 3],
      lastScheduleTeamAbbreviation: 'TOR',
    },
    completedScheduledGameIds: [3, 4, 5, 6],
    completedScheduleTeamAbbreviation: 'cbj',
    ownerId: 'owner-a',
    rosterSlotId: 'lw-1',
    activationKey: 'cycle-2',
  });

  assert.deepEqual(advanced, {
    schemaVersion: 1,
    continuityId: 'owner-a::lw-1::skater-8482720::draft-31',
    ownerId: 'owner-a',
    rosterSlotId: 'lw-1',
    assetKey: 'skater-8482720',
    priorAssignedGameIds: [1, 2, 3, 4, 5, 6],
    lastScheduleTeamAbbreviation: 'CBJ',
  });
});

test('legacy migration unions same-lineage redundant cursor prefixes', () => {
  const merged = mergeLegacyPlayerWindowContinuityCopies({
    ownerId: 'owner-a',
    rosterSlotId: 'lw-1',
    asset: skater(8482720, 'CBJ'),
    values: [
      {
        schemaVersion: 1,
        continuityId: 'owner-a::lw-1::skater-8482720::legacy-cycle-2',
        ownerId: 'owner-a',
        rosterSlotId: 'lw-1',
        assetKey: 'skater-8482720',
        priorAssignedGameIds: [1, 2, 3],
        lastScheduleTeamAbbreviation: 'TOR',
      },
      {
        schemaVersion: 1,
        continuityId: 'owner-a::lw-1::skater-8482720::legacy-cycle-2',
        ownerId: 'owner-a',
        rosterSlotId: 'lw-1',
        assetKey: 'skater-8482720',
        priorAssignedGameIds: [1, 2, 3, 4, 5, 6],
        lastScheduleTeamAbbreviation: 'TOR',
      },
    ],
  });

  assert.deepEqual(merged.priorAssignedGameIds, [1, 2, 3, 4, 5, 6]);
  assert.equal(merged.lastScheduleTeamAbbreviation, 'TOR');
});

test('legacy migration rejects divergent histories with the same continuity id', () => {
  assert.throws(
    () => mergeLegacyPlayerWindowContinuityCopies({
      ownerId: 'owner-a',
      rosterSlotId: 'lw-1',
      asset: skater(8482720, 'CBJ'),
      values: [
        {
          schemaVersion: 1,
          continuityId: 'owner-a::lw-1::skater-8482720::legacy-cycle-2',
          ownerId: 'owner-a',
          rosterSlotId: 'lw-1',
          assetKey: 'skater-8482720',
          priorAssignedGameIds: [1, 2],
          lastScheduleTeamAbbreviation: 'TOR',
        },
        {
          schemaVersion: 1,
          continuityId: 'owner-a::lw-1::skater-8482720::legacy-cycle-2',
          ownerId: 'owner-a',
          rosterSlotId: 'lw-1',
          assetKey: 'skater-8482720',
          priorAssignedGameIds: [1, 3],
          lastScheduleTeamAbbreviation: 'TOR',
        },
      ],
    }),
    /copies disagree/,
  );
});

test('replacing the fantasy asset resets the lineage instead of inheriting game ownership', () => {
  const replacement = advancePlayerWindowContinuity({
    previousAsset: skater(8482720, 'TOR'),
    nextAsset: skater(8478402, 'EDM'),
    previousContinuity: {
      schemaVersion: 1,
      continuityId: 'old-stint',
      priorAssignedGameIds: [1, 2, 3, 4, 5, 6],
      lastScheduleTeamAbbreviation: 'TOR',
    },
    completedScheduledGameIds: [7, 8],
    completedScheduleTeamAbbreviation: 'TOR',
    ownerId: 'owner-a',
    rosterSlotId: 'lw-1',
    activationKey: 'move-transaction-42',
    assignmentNotBefore: 1_780_000_000_000,
  });

  assert.deepEqual(replacement, {
    schemaVersion: 1,
    continuityId: 'owner-a::lw-1::skater-8478402::move-transaction-42',
    ownerId: 'owner-a',
    rosterSlotId: 'lw-1',
    assetKey: 'skater-8478402',
    assignmentNotBeforeMilliseconds: 1_780_000_000_000,
    priorAssignedGameIds: [],
    lastScheduleTeamAbbreviation: 'EDM',
  });
});

test('an ordinary rollover replacement cannot inherit the outgoing snapshot boundary', () => {
  const replacement = advancePlayerWindowContinuity({
    previousAsset: skater(8482720, 'TOR'),
    nextAsset: skater(8478402, 'EDM'),
    previousContinuity: {
      schemaVersion: 1,
      continuityId: 'owner-a::lw-1::skater-8482720::draft-31',
      ownerId: 'owner-a',
      rosterSlotId: 'lw-1',
      assetKey: 'skater-8482720',
      priorAssignedGameIds: [1, 2, 3, 4, 5, 6],
      lastScheduleTeamAbbreviation: 'TOR',
    },
    completedScheduledGameIds: [1, 2, 3, 4, 5, 6],
    completedScheduleTeamAbbreviation: 'TOR',
    ownerId: 'owner-a',
    rosterSlotId: 'lw-1',
    activationKey: 'cycle-2',
    assignmentNotBefore: '2026-10-20T20:00:00.000Z',
  });

  assert.equal(
    Object.hasOwn(replacement, 'assignmentNotBeforeMilliseconds'),
    false,
  );
  assert.equal(
    replacement.continuityId,
    'owner-a::lw-1::skater-8478402::cycle-2',
  );
});

test('a dropped and later reacquired skater starts a new stint even in the same slot', () => {
  const firstStint = createPlayerWindowContinuity({
    ownerId: 'owner-a',
    rosterSlotId: 'lw-1',
    asset: skater(8482720, 'TOR'),
    activationKey: 'draft-31',
  });
  const reacquiredStint = createPlayerWindowContinuity({
    ownerId: 'owner-a',
    rosterSlotId: 'lw-1',
    asset: skater(8482720, 'CBJ'),
    activationKey: 'move-transaction-99',
    assignmentNotBefore: 1_780_000_100_000,
  });

  assert.notEqual(reacquiredStint.continuityId, firstStint.continuityId);
  assert.deepEqual(reacquiredStint.priorAssignedGameIds, []);
  assert.equal(reacquiredStint.lastScheduleTeamAbbreviation, 'CBJ');
  assert.equal(
    reacquiredStint.assignmentNotBeforeMilliseconds,
    1_780_000_100_000,
  );
});

test('team-goalie units never receive skater transfer continuity', () => {
  assert.equal(
    createPlayerWindowContinuity({
      ownerId: 'owner-a',
      rosterSlotId: 'g-1',
      asset: goalieUnit('TOR'),
      activationKey: 'draft-31',
    }),
    undefined,
  );

  assert.equal(
    advancePlayerWindowContinuity({
      previousAsset: skater(8482720),
      nextAsset: goalieUnit('TOR'),
      previousContinuity: {
        schemaVersion: 1,
        continuityId: 'old-stint',
        priorAssignedGameIds: [1, 2, 3, 4, 5, 6],
      },
      completedScheduledGameIds: [7],
      ownerId: 'owner-a',
      rosterSlotId: 'g-1',
      activationKey: 'move-transaction-100',
    }),
    undefined,
  );
});

test('legacy bootstrap preserves every prior game across an NHL A to B to A return', () => {
  const rebuilt = reconstructLegacyPlayerWindowContinuity({
    ownerId: 'owner-a',
    rosterSlotId: 'lw-1',
    currentCycleNumber: 3,
    currentAsset: skater(8482720, 'TOR'),
    assignmentsNewestFirst: [
      {
        cycleNumber: 2,
        asset: skater(8482720, 'CBJ'),
        scheduledGameIds: [101, 102, 103, 104, 105, 106],
        scheduleTeamAbbreviation: 'CBJ',
        ownershipStarted: true,
      },
      {
        cycleNumber: 1,
        asset: skater(8482720, 'TOR'),
        scheduledGameIds: [1, 2, 3, 4, 5, 6],
        scheduleTeamAbbreviation: 'TOR',
        ownershipStarted: true,
      },
    ],
  });

  assert.deepEqual(rebuilt, {
    schemaVersion: 1,
    continuityId: 'owner-a::lw-1::skater-8482720::legacy-cycle-3',
    ownerId: 'owner-a',
    rosterSlotId: 'lw-1',
    assetKey: 'skater-8482720',
    priorAssignedGameIds: [1, 2, 3, 4, 5, 6, 101, 102, 103, 104, 105, 106],
    lastScheduleTeamAbbreviation: 'CBJ',
  });
});

test('legacy bootstrap stops at a roster gap instead of joining separate fantasy stints', () => {
  const rebuilt = reconstructLegacyPlayerWindowContinuity({
    ownerId: 'owner-a',
    rosterSlotId: 'lw-1',
    currentCycleNumber: 4,
    currentAsset: skater(8482720, 'TOR'),
    assignmentsNewestFirst: [
      {
        cycleNumber: 3,
        asset: skater(8482720, 'TOR'),
        scheduledGameIds: [13, 14, 15, 16, 17, 18],
        scheduleTeamAbbreviation: 'TOR',
        ownershipStarted: true,
      },
      null,
      {
        cycleNumber: 1,
        asset: skater(8482720, 'TOR'),
        scheduledGameIds: [1, 2, 3, 4, 5, 6],
        scheduleTeamAbbreviation: 'TOR',
        ownershipStarted: true,
      },
    ],
  });

  assert.deepEqual(rebuilt.priorAssignedGameIds, [13, 14, 15, 16, 17, 18]);
});

test('legacy bootstrap fails closed when an earlier assignment never started', () => {
  assert.throws(
    () => reconstructLegacyPlayerWindowContinuity({
      ownerId: 'owner-a',
      rosterSlotId: 'lw-1',
      currentCycleNumber: 2,
      currentAsset: skater(8482720, 'TOR'),
      assignmentsNewestFirst: [{
        cycleNumber: 1,
        asset: skater(8482720, 'TOR'),
        scheduledGameIds: [1, 2, 3, 4, 5, 6],
        scheduleTeamAbbreviation: 'TOR',
        ownershipStarted: false,
      }],
    }),
    /unstarted Cycle 1 assignment/,
  );
});

test('legacy bootstrap rejects conflicting explicit boundaries for the same continuity id', () => {
  const continuityId =
    'owner-a::lw-1::skater-8482720::move-transaction-7';

  assert.throws(
    () => reconstructLegacyPlayerWindowContinuity({
      ownerId: 'owner-a',
      rosterSlotId: 'lw-1',
      currentCycleNumber: 3,
      currentAsset: skater(8482720, 'CBJ'),
      currentContinuity: {
        schemaVersion: 1,
        continuityId,
        ownerId: 'owner-a',
        rosterSlotId: 'lw-1',
        assetKey: 'skater-8482720',
        assignmentNotBeforeMilliseconds:
          Date.parse('2026-10-01T20:00:00.000Z'),
        priorAssignedGameIds: [101, 102, 103, 104, 105, 106],
        lastScheduleTeamAbbreviation: 'CBJ',
      },
      assignmentsNewestFirst: [{
        cycleNumber: 2,
        asset: skater(8482720, 'CBJ'),
        scheduledGameIds: [101, 102, 103, 104, 105, 106],
        scheduleTeamAbbreviation: 'CBJ',
        ownershipStarted: true,
        snapshotSource: 'queued-slot-move-reconciled',
        assignmentNotBefore: '2026-10-03T20:00:00.000Z',
        playerWindowContinuity: {
          schemaVersion: 1,
          continuityId,
          ownerId: 'owner-a',
          rosterSlotId: 'lw-1',
          assetKey: 'skater-8482720',
          assignmentNotBeforeMilliseconds:
            Date.parse('2026-10-02T20:00:00.000Z'),
          priorAssignedGameIds: [101, 102, 103, 104, 105, 106],
          lastScheduleTeamAbbreviation: 'CBJ',
        },
      }],
    }),
    /assignment boundaries disagree/,
  );
});

test('legacy current move keeps its explicit boundary over a later write timestamp', () => {
  const boundary = Date.parse('2026-10-01T20:00:00.000Z');
  const rebuilt = reconstructLegacyPlayerWindowContinuity({
    ownerId: 'owner-a',
    rosterSlotId: 'lw-1',
    currentCycleNumber: 3,
    currentAsset: skater(8482720, 'CBJ'),
    currentSnapshotSource: 'immediate-untouched-roster-move',
    currentAssignmentNotBefore: '2026-10-01T20:05:00.000Z',
    currentContinuity: {
      schemaVersion: 1,
      continuityId:
        'owner-a::lw-1::skater-8482720::move-transaction-7',
      ownerId: 'owner-a',
      rosterSlotId: 'lw-1',
      assetKey: 'skater-8482720',
      assignmentNotBeforeMilliseconds: boundary,
      priorAssignedGameIds: [],
      lastScheduleTeamAbbreviation: 'CBJ',
    },
    assignmentsNewestFirst: [],
  });

  assert.equal(rebuilt.assignmentNotBeforeMilliseconds, boundary);
});

test('legacy historical move keeps explicit same-lineage boundary over its audit timestamp', () => {
  const boundary = Date.parse('2026-10-01T20:00:00.000Z');
  const continuity = {
    schemaVersion: 1,
    continuityId:
      'owner-a::lw-1::skater-8482720::move-transaction-7',
    ownerId: 'owner-a',
    rosterSlotId: 'lw-1',
    assetKey: 'skater-8482720',
    assignmentNotBeforeMilliseconds: boundary,
    priorAssignedGameIds: [101, 102, 103, 104, 105, 106],
    lastScheduleTeamAbbreviation: 'CBJ',
  };
  const rebuilt = reconstructLegacyPlayerWindowContinuity({
    ownerId: 'owner-a',
    rosterSlotId: 'lw-1',
    currentCycleNumber: 3,
    currentAsset: skater(8482720, 'CBJ'),
    currentContinuity: continuity,
    assignmentsNewestFirst: [{
      cycleNumber: 2,
      asset: skater(8482720, 'CBJ'),
      scheduledGameIds: [101, 102, 103, 104, 105, 106],
      scheduleTeamAbbreviation: 'CBJ',
      ownershipStarted: true,
      snapshotSource: 'queued-slot-move-reconciled',
      assignmentNotBefore: '2026-10-01T20:05:00.000Z',
      playerWindowContinuity: continuity,
    }],
  });

  assert.equal(rebuilt.assignmentNotBeforeMilliseconds, boundary);
});

test('legacy bootstrap merges one missing boundary with one proven same-lineage boundary', () => {
  const boundary = Date.parse('2026-10-01T20:00:00.000Z');
  const continuityId =
    'owner-a::lw-1::skater-8482720::move-transaction-7';
  const rebuilt = reconstructLegacyPlayerWindowContinuity({
    ownerId: 'owner-a',
    rosterSlotId: 'lw-1',
    currentCycleNumber: 3,
    currentAsset: skater(8482720, 'CBJ'),
    currentContinuity: {
      schemaVersion: 1,
      continuityId,
      ownerId: 'owner-a',
      rosterSlotId: 'lw-1',
      assetKey: 'skater-8482720',
      priorAssignedGameIds: [101, 102, 103, 104, 105, 106],
      lastScheduleTeamAbbreviation: 'CBJ',
    },
    assignmentsNewestFirst: [{
      cycleNumber: 2,
      asset: skater(8482720, 'CBJ'),
      scheduledGameIds: [101, 102, 103, 104, 105, 106],
      scheduleTeamAbbreviation: 'CBJ',
      ownershipStarted: true,
      playerWindowContinuity: {
        schemaVersion: 1,
        continuityId,
        ownerId: 'owner-a',
        rosterSlotId: 'lw-1',
        assetKey: 'skater-8482720',
        assignmentNotBeforeMilliseconds: boundary,
        priorAssignedGameIds: [101, 102, 103, 104, 105, 106],
        lastScheduleTeamAbbreviation: 'CBJ',
      },
    }],
  });

  assert.equal(rebuilt.assignmentNotBeforeMilliseconds, boundary);
  assert.equal(rebuilt.continuityId, continuityId);
});

test('a legacy move snapshot is a fresh fantasy stint even for the same skater', () => {
  const rebuilt = reconstructLegacyPlayerWindowContinuity({
    ownerId: 'owner-a',
    rosterSlotId: 'lw-1',
    currentCycleNumber: 3,
    currentAsset: skater(8482720, 'TOR'),
    currentSnapshotSource: 'queued-slot-move-reconciled',
    currentAssignmentNotBefore: '2026-10-01T20:00:00.000Z',
    assignmentsNewestFirst: [{
      cycleNumber: 2,
      asset: skater(8482720, 'TOR'),
      scheduledGameIds: [7, 8, 9, 10, 11, 12],
      scheduleTeamAbbreviation: 'TOR',
      ownershipStarted: true,
    }],
  });

  assert.deepEqual(rebuilt.priorAssignedGameIds, []);
  assert.equal(
    rebuilt.continuityId,
    'owner-a::lw-1::skater-8482720::move-legacy-cycle-3',
  );
  assert.equal(
    rebuilt.assignmentNotBeforeMilliseconds,
    Date.parse('2026-10-01T20:00:00.000Z'),
  );
});

test('a legacy move snapshot rejects a carried pre-move cursor for the same asset', () => {
  const rebuilt = reconstructLegacyPlayerWindowContinuity({
    ownerId: 'owner-a',
    rosterSlotId: 'lw-1',
    currentCycleNumber: 3,
    currentAsset: skater(8482720, 'CBJ'),
    currentSnapshotSource: 'queued-slot-move-reconciled',
    currentAssignmentNotBefore: '2026-10-02T20:00:00.000Z',
    currentContinuity: {
      schemaVersion: 1,
      continuityId: 'owner-a::lw-1::skater-8482720::draft-1',
      ownerId: 'owner-a',
      rosterSlotId: 'lw-1',
      assetKey: 'skater-8482720',
      priorAssignedGameIds: [1, 2, 3, 4, 5, 6],
      lastScheduleTeamAbbreviation: 'TOR',
    },
    assignmentsNewestFirst: [],
  });

  assert.deepEqual(rebuilt.priorAssignedGameIds, []);
  assert.equal(
    rebuilt.continuityId,
    'owner-a::lw-1::skater-8482720::move-legacy-cycle-3',
  );
  assert.equal(
    rebuilt.assignmentNotBeforeMilliseconds,
    Date.parse('2026-10-02T20:00:00.000Z'),
  );
});

test('regular rollover preserves the original move activation boundary', () => {
  const activationBoundary = Date.parse('2026-10-01T20:00:00.000Z');
  const advanced = advancePlayerWindowContinuity({
    previousAsset: skater(8482720, 'CBJ'),
    nextAsset: skater(8482720, 'CBJ'),
    previousContinuity: {
      schemaVersion: 1,
      continuityId: 'owner-a::lw-1::skater-8482720::move-transaction-7',
      ownerId: 'owner-a',
      rosterSlotId: 'lw-1',
      assetKey: 'skater-8482720',
      assignmentNotBeforeMilliseconds: activationBoundary,
      priorAssignedGameIds: [101, 102, 103, 104, 105, 106],
      lastScheduleTeamAbbreviation: 'CBJ',
    },
    completedScheduledGameIds: [101, 102, 103, 104, 105, 106],
    completedScheduleTeamAbbreviation: 'CBJ',
    ownerId: 'owner-a',
    rosterSlotId: 'lw-1',
    activationKey: 'cycle-3',
    assignmentNotBefore: '2026-10-20T20:00:00.000Z',
  });

  assert.equal(
    advanced.assignmentNotBeforeMilliseconds,
    activationBoundary,
  );
});

test('regular rollover keeps ordinary draft continuity boundary-free', () => {
  const advanced = advancePlayerWindowContinuity({
    previousAsset: skater(8482720, 'TOR'),
    nextAsset: skater(8482720, 'TOR'),
    previousContinuity: {
      schemaVersion: 1,
      continuityId: 'owner-a::lw-1::skater-8482720::draft-31',
      ownerId: 'owner-a',
      rosterSlotId: 'lw-1',
      assetKey: 'skater-8482720',
      priorAssignedGameIds: [101, 102, 103, 104, 105, 106],
      lastScheduleTeamAbbreviation: 'TOR',
    },
    completedScheduledGameIds: [101, 102, 103, 104, 105, 106],
    completedScheduleTeamAbbreviation: 'TOR',
    ownerId: 'owner-a',
    rosterSlotId: 'lw-1',
    activationKey: 'cycle-3',
    assignmentNotBefore: '2026-10-20T20:00:00.000Z',
  });

  assert.equal(
    Object.hasOwn(advanced, 'assignmentNotBeforeMilliseconds'),
    false,
  );
});

test('playoff rollover preserves the original move activation boundary', () => {
  const activationBoundary = Date.parse('2026-10-01T20:00:00.000Z');
  const advanced = advancePlayerWindowContinuity({
    previousAsset: skater(8482720, 'CBJ'),
    nextAsset: skater(8482720, 'CBJ'),
    previousContinuity: {
      schemaVersion: 1,
      continuityId: 'owner-a::lw-1::skater-8482720::move-transaction-7',
      ownerId: 'owner-a',
      rosterSlotId: 'lw-1',
      assetKey: 'skater-8482720',
      assignmentNotBeforeMilliseconds: activationBoundary,
      priorAssignedGameIds: [101, 102, 103, 104, 105, 106],
      lastScheduleTeamAbbreviation: 'CBJ',
    },
    completedScheduledGameIds: [107, 108, 109, 110, 111, 112],
    completedScheduleTeamAbbreviation: 'CBJ',
    ownerId: 'owner-a',
    rosterSlotId: 'lw-1',
    activationKey: 'playoff-window-2',
    assignmentNotBefore: '2027-04-20T20:00:00.000Z',
  });

  assert.equal(
    advanced.assignmentNotBeforeMilliseconds,
    activationBoundary,
  );
});

test('playoff rollover keeps ordinary draft continuity boundary-free', () => {
  const advanced = advancePlayerWindowContinuity({
    previousAsset: skater(8482720, 'TOR'),
    nextAsset: skater(8482720, 'TOR'),
    previousContinuity: {
      schemaVersion: 1,
      continuityId: 'owner-a::lw-1::skater-8482720::draft-31',
      ownerId: 'owner-a',
      rosterSlotId: 'lw-1',
      assetKey: 'skater-8482720',
      priorAssignedGameIds: [101, 102, 103, 104, 105, 106],
      lastScheduleTeamAbbreviation: 'TOR',
    },
    completedScheduledGameIds: [107, 108, 109, 110, 111, 112],
    completedScheduleTeamAbbreviation: 'TOR',
    ownerId: 'owner-a',
    rosterSlotId: 'lw-1',
    activationKey: 'playoff-window-2',
    assignmentNotBefore: '2027-04-20T20:00:00.000Z',
  });

  assert.equal(
    Object.hasOwn(advanced, 'assignmentNotBeforeMilliseconds'),
    false,
  );
});

test('later windows fail closed when legacy move lineage has no original boundary', () => {
  assert.throws(
    () => advancePlayerWindowContinuity({
      previousAsset: skater(8482720, 'CBJ'),
      nextAsset: skater(8482720, 'CBJ'),
      previousContinuity: {
        schemaVersion: 1,
        continuityId: 'owner-a::lw-1::skater-8482720::move-transaction-7',
        ownerId: 'owner-a',
        rosterSlotId: 'lw-1',
        assetKey: 'skater-8482720',
        priorAssignedGameIds: [101, 102, 103, 104, 105, 106],
        lastScheduleTeamAbbreviation: 'CBJ',
      },
      completedScheduledGameIds: [107, 108, 109, 110, 111, 112],
      completedScheduleTeamAbbreviation: 'CBJ',
      ownerId: 'owner-a',
      rosterSlotId: 'lw-1',
      activationKey: 'cycle-3',
    }),
    /missing its original roster-move assignment boundary/,
  );
});
