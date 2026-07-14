import {
  PlayerAvailabilityOverride
} from './player-availability.models';

/**
 * Emergency code fallbacks for player availability.
 *
 * Firestore commissioner records take first priority, followed by ESPN-synced
 * records. Keep this list empty during normal operation so players who are no
 * longer present in the injury feed return to Active automatically.
 *
 * Add a temporary entry only when both Firestore and the external feed are
 * unavailable and a correction is urgently required.
 */
export const PLAYER_AVAILABILITY_OVERRIDES: PlayerAvailabilityOverride[] = [];

export const PLAYER_AVAILABILITY_OVERRIDES_LAST_REVIEWED = '2026-07-10';
