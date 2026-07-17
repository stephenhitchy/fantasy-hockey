import { DraftableAsset } from '../draft/draft.models';
import {
  isSharedProjectionSnapshotFreshForWindow,
  SHARED_PROJECTION_VERSION,
  SharedProjectionSnapshotMetadata,
} from './projection-snapshot.service';
import { createFrozenWindowProjectionFields } from './window-projection.service';

export interface WindowProjectionSimulationCheck {
  id: string;
  label: string;
  expected: string;
  actual: string;
  passed: boolean;
}

export interface WindowProjectionSimulationResult {
  passed: boolean;
  passedCount: number;
  totalCount: number;
  checks: WindowProjectionSimulationCheck[];
}

function createAsset(
  assetKey: string,
  projectedCyclePoints: number,
  targetCycleNumber: number,
  snapshotId: string,
  generatedAt: string,
): DraftableAsset {
  return {
    assetType: 'skater',
    assetKey,
    position: 'C',
    player: {
      id: Number(assetKey.replace(/\D/g, '')) || 1,
      fullName: assetKey,
      position: 'C',
      nhlTeamAbbreviation: 'VGK',
    },
    projectedCyclePoints,
    targetProjectionCycleNumber: targetCycleNumber,
    sharedProjectionSnapshotId: snapshotId,
    projectionGeneratedAt: generatedAt,
  };
}

function createMetadata(
  targetCycleNumber: number,
  generatedAt: string,
): SharedProjectionSnapshotMetadata {
  return {
    snapshotId: `snapshot-${targetCycleNumber}`,
    activeSnapshotId: `snapshot-${targetCycleNumber}`,
    status: 'ready',
    projectionVersion: SHARED_PROJECTION_VERSION,
    generatedAt,
    generatedBy: 'commissioner',
    assetCount: 300,
    teamCount: 4,
    targetCycleNumber,
    requiredGamesPerCycle: 6,
    generationReason: 'window-boundary',
    draftReadyUntil: generatedAt,
    message: 'Ready',
  };
}

function check(
  id: string,
  label: string,
  expected: string,
  actual: string,
  passed: boolean,
): WindowProjectionSimulationCheck {
  return { id, label, expected, actual, passed };
}

export function runWindowProjectionDeterministicSimulator(): WindowProjectionSimulationResult {
  const now = new Date('2026-01-20T12:00:00Z');
  const recentGeneratedAt = '2026-01-20T06:00:00Z';
  const staleGeneratedAt = '2026-01-18T06:00:00Z';
  const cycleOneAsset = createAsset('skater-1', 40, 1, 'snapshot-1', recentGeneratedAt);
  const cycleTwoAsset = createAsset('skater-1', 60, 2, 'snapshot-2', recentGeneratedAt);
  const incomingAsset = createAsset('skater-2', 30, 2, 'snapshot-2', recentGeneratedAt);
  const slotACycleOne = createFrozenWindowProjectionFields(
    cycleOneAsset,
    1,
    'shared-snapshot',
    '2026-01-10T12:00:00Z',
  );
  const slotACycleTwo = createFrozenWindowProjectionFields(
    cycleTwoAsset,
    2,
    'shared-snapshot',
    '2026-01-20T12:00:00Z',
  );
  const slotBCycleOne = createFrozenWindowProjectionFields(
    cycleOneAsset,
    1,
    'shared-snapshot',
    '2026-01-10T12:00:00Z',
  );
  const queuedIncomingCycleTwo = createFrozenWindowProjectionFields(
    incomingAsset,
    2,
    'shared-snapshot',
    '2026-01-20T12:00:00Z',
  );
  const legacyFallback = createFrozenWindowProjectionFields(
    cycleTwoAsset,
    2,
    'legacy',
    '2026-01-20T12:00:00Z',
  );
  const checks: WindowProjectionSimulationCheck[] = [];

  const fresh = isSharedProjectionSnapshotFreshForWindow(createMetadata(2, recentGeneratedAt), {
    teamCount: 4,
    requiredGamesPerCycle: 6,
    targetCycleNumber: 2,
    now,
  });
  checks.push(
    check(
      'fresh-target-reused',
      'A recent projection for the exact window is reused',
      'fresh',
      fresh ? 'fresh' : 'refresh required',
      fresh,
    ),
  );

  const wrongTargetFresh = isSharedProjectionSnapshotFreshForWindow(
    createMetadata(1, recentGeneratedAt),
    {
      teamCount: 4,
      requiredGamesPerCycle: 6,
      targetCycleNumber: 2,
      now,
    },
  );
  checks.push(
    check(
      'wrong-target-rejected',
      'A projection for another six-game window is rejected',
      'refresh required',
      wrongTargetFresh ? 'fresh' : 'refresh required',
      !wrongTargetFresh,
    ),
  );

  const staleFresh = isSharedProjectionSnapshotFreshForWindow(createMetadata(2, staleGeneratedAt), {
    teamCount: 4,
    requiredGamesPerCycle: 6,
    targetCycleNumber: 2,
    now,
  });
  checks.push(
    check(
      'stale-target-refreshed',
      'An old target snapshot requires a fresh projection generation',
      'refresh required',
      staleFresh ? 'fresh' : 'refresh required',
      !staleFresh,
    ),
  );

  checks.push(
    check(
      'cycle-one-frozen',
      'Cycle 1 keeps its original manager-facing projection',
      '38.0',
      (slotACycleOne.frozenCycleProjectionPoints ?? 0).toFixed(1),
      slotACycleOne.frozenCycleProjectionPoints === 38,
    ),
  );

  checks.push(
    check(
      'cycle-two-new-freeze',
      'The same player receives a new projection for Cycle 2',
      '57.0',
      (slotACycleTwo.frozenCycleProjectionPoints ?? 0).toFixed(1),
      slotACycleTwo.frozenCycleProjectionPoints === 57,
    ),
  );

  checks.push(
    check(
      'prior-window-immutable',
      'Generating Cycle 2 does not mutate the saved Cycle 1 value',
      '38.0 remains',
      `${(slotACycleOne.frozenCycleProjectionPoints ?? 0).toFixed(1)} remains`,
      slotACycleOne.frozenCycleProjectionPoints === 38,
    ),
  );

  checks.push(
    check(
      'independent-slot-starts',
      'One slot may use Cycle 2 while another remains frozen in Cycle 1',
      'Slot A 57.0 · Slot B 38.0',
      `Slot A ${(slotACycleTwo.frozenCycleProjectionPoints ?? 0).toFixed(1)} · Slot B ${(slotBCycleOne.frozenCycleProjectionPoints ?? 0).toFixed(1)}`,
      slotACycleTwo.frozenProjectionCycleNumber === 2 &&
        slotBCycleOne.frozenProjectionCycleNumber === 1,
    ),
  );

  checks.push(
    check(
      'queued-player-projection',
      'A queued replacement freezes the incoming player projection',
      '28.5 from skater-2',
      `${(queuedIncomingCycleTwo.frozenCycleProjectionPoints ?? 0).toFixed(1)} from skater-2`,
      queuedIncomingCycleTwo.frozenCycleProjectionPoints === 28.5,
    ),
  );

  checks.push(
    check(
      'snapshot-provenance',
      'The new window stores its projection snapshot and generation time',
      'snapshot-2 recorded',
      slotACycleTwo.frozenProjectionSnapshotId ?? 'missing',
      slotACycleTwo.frozenProjectionSnapshotId === 'snapshot-2' &&
        slotACycleTwo.frozenProjectionGeneratedAt === recentGeneratedAt,
    ),
  );

  checks.push(
    check(
      'fallback-labeled',
      'A fallback projection is labeled and does not claim the shared model version',
      'legacy · version none',
      `${legacyFallback.frozenProjectionSource} · version ${legacyFallback.frozenProjectionVersion ?? 'none'}`,
      legacyFallback.frozenProjectionSource === 'legacy' &&
        legacyFallback.frozenProjectionVersion === null,
    ),
  );

  const passedCount = checks.filter((entry) => entry.passed).length;

  return {
    passed: passedCount === checks.length,
    passedCount,
    totalCount: checks.length,
    checks,
  };
}
