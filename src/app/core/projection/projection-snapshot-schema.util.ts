/**
 * Projection snapshot hash schemas that the current browser can verify.
 *
 * Schema 2 is the pre-anchor Scoring V4 format already published in existing
 * leagues. Schema 3 additionally seals the late-season NHL source block and
 * immutable season-window anchor.
 */
export const PROJECTION_SNAPSHOT_SCORING_HASH_SCHEMA_VERSION = 2;
export const PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION = 3;

export function isSupportedProjectionSnapshotHashSchemaVersion(
  value: unknown,
): value is 2 | 3 {
  return value === PROJECTION_SNAPSHOT_SCORING_HASH_SCHEMA_VERSION ||
    value === PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION;
}
