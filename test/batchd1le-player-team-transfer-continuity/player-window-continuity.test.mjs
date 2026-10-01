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
      priorAssignedGameIds: [9, 7, 8],
      lastScheduleTeamAbbreviation: ' cbj ',
    }),
    {
      schemaVersion: 1,
      continuityId: 'owner::slot::skater-1::draft',
      ownerId: 'owner',
      rosterSlotId: 'slot',
      assetKey: 'skater-1',
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
  });

  assert.deepEqual(replacement, {
    schemaVersion: 1,
    continuityId: 'owner-a::lw-1::skater-8478402::move-transaction-42',
    ownerId: 'owner-a',
    rosterSlotId: 'lw-1',
    assetKey: 'skater-8478402',
    priorAssignedGameIds: [],
    lastScheduleTeamAbbreviation: 'EDM',
  });
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
  });

  assert.notEqual(reacquiredStint.continuityId, firstStint.continuityId);
  assert.deepEqual(reacquiredStint.priorAssignedGameIds, []);
  assert.equal(reacquiredStint.lastScheduleTeamAbbreviation, 'CBJ');
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

test('a legacy move snapshot is a fresh fantasy stint even for the same skater', () => {
  const rebuilt = reconstructLegacyPlayerWindowContinuity({
    ownerId: 'owner-a',
    rosterSlotId: 'lw-1',
    currentCycleNumber: 3,
    currentAsset: skater(8482720, 'TOR'),
    currentSnapshotSource: 'queued-slot-move-reconciled',
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
    'owner-a::lw-1::skater-8482720::legacy-cycle-3',
  );
});

test('a legacy move snapshot rejects a carried pre-move cursor for the same asset', () => {
  const rebuilt = reconstructLegacyPlayerWindowContinuity({
    ownerId: 'owner-a',
    rosterSlotId: 'lw-1',
    currentCycleNumber: 3,
    currentAsset: skater(8482720, 'CBJ'),
    currentSnapshotSource: 'queued-slot-move-reconciled',
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
    'owner-a::lw-1::skater-8482720::legacy-cycle-3',
  );
});
