import {
  DraftableAsset,
  DraftPosition,
  DraftProjection
} from '../draft/draft.models';

/**
 * Keeps the cycle-page projection scale consistent with the existing UI.
 * The resulting manager-facing value is frozen into every cycle snapshot.
 */
const VISIBLE_PROJECTION_MULTIPLIERS: Record<DraftPosition, number> = {
  LW: 0.9,
  C: 0.9,
  RW: 0.9,
  D: 0.88,
  G: 0.85
};

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : null;
}

/**
 * Returns the model's current cycle forecast before the manager-facing scale
 * is applied. projectedCyclePoints is preferred because it already includes
 * the current availability adjustment in Projection Version 4.
 */
export function getRawCycleProjection(
  projection: DraftProjection | null | undefined
): number | null {
  if (!projection) {
    return null;
  }

  return (
    toFiniteNumber(projection.projectedCyclePoints) ??
    toFiniteNumber(projection.availabilityAdjustedCyclePoints) ??
    toFiniteNumber(projection.floorAdjustedCyclePoints)
  );
}

export function getVisibleCycleProjection(
  position: DraftPosition,
  rawProjection: number | null
): number | null {
  if (rawProjection === null) {
    return null;
  }

  const multiplier =
    VISIBLE_PROJECTION_MULTIPLIERS[position] ?? 0.9;

  return Number((rawProjection * multiplier).toFixed(1));
}

/**
 * Creates the exact number managers should see for a cycle. This value is
 * stored in the cycle roster snapshot and therefore cannot move when NHL
 * schedules or live scoring finish loading.
 */
export function createFrozenCycleProjection(
  asset: Pick<DraftableAsset, 'position'> & DraftProjection
): number | null {
  return getVisibleCycleProjection(
    asset.position,
    getRawCycleProjection(asset)
  );
}

/**
 * Reads the immutable cycle-start value. Older cycle documents that predate
 * this field receive the same stable calculation from their stored snapshot;
 * no live player-pool or NHL-schedule value is consulted.
 */
export function getFrozenCycleProjection(
  asset: DraftableAsset
): number | null {
  return (
    toFiniteNumber(asset.frozenCycleProjectionPoints) ??
    createFrozenCycleProjection(asset)
  );
}
