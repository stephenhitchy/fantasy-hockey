import { DraftableAsset, DraftPosition, DraftProjection } from '../draft/draft.models';

/**
 * Manager-facing calibration target (Projection Version 6).
 *
 * The raw model remains the central forecast. These modest discounts preserve
 * the product goal that players should beat their projection more often than
 * they miss it, while moving the observed under-projection rate away from the
 * prior ~90% level and toward roughly 70%. The exact rate will vary by season,
 * position, injuries, and sample size and is measured by Projection Accuracy.
 */
const VISIBLE_PROJECTION_MULTIPLIERS: Record<DraftPosition, number> = {
  LW: 0.95,
  C: 0.95,
  RW: 0.95,
  D: 0.93,
  G: 0.9,
};

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Returns the model's current cycle forecast before the manager-facing scale
 * is applied. projectedCyclePoints is preferred because it already includes
 * the current availability adjustment before the manager-facing calibration is applied.
 */
export function getRawCycleProjection(
  projection: DraftProjection | null | undefined,
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
  rawProjection: number | null,
): number | null {
  if (rawProjection === null) {
    return null;
  }

  const multiplier = VISIBLE_PROJECTION_MULTIPLIERS[position] ?? 0.9;

  return Number((rawProjection * multiplier).toFixed(1));
}

/**
 * Creates the exact number managers should see for a cycle. This value is
 * stored in the cycle roster snapshot and therefore cannot move when NHL
 * schedules or live scoring finish loading.
 */
export function createFrozenCycleProjection(
  asset: Pick<DraftableAsset, 'position'> & DraftProjection,
): number | null {
  return getVisibleCycleProjection(asset.position, getRawCycleProjection(asset));
}

/**
 * Reads the immutable cycle-start value. Older cycle documents that predate
 * this field receive the same stable calculation from their stored snapshot;
 * no live player-pool or NHL-schedule value is consulted.
 */
export function getFrozenCycleProjection(asset: DraftableAsset): number | null {
  return toFiniteNumber(asset.frozenCycleProjectionPoints) ?? createFrozenCycleProjection(asset);
}
