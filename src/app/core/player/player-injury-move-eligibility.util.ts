import type { PlayerAvailabilityStatus } from './player-availability.models';

const IMMEDIATE_INJURY_MOVE_STATUSES = new Set<PlayerAvailabilityStatus>([
  'day-to-day',
  'out',
  'injured-reserve',
  'long-term-injured-reserve',
]);

/**
 * Browser preview for the statuses that may use the protected mixed-window
 * injury route. Functions reread availability before writing, so this helper
 * can select the intended request without authorizing the roster change.
 */
export function isImmediateInjuryMoveStatus(
  status: PlayerAvailabilityStatus | null | undefined,
): boolean {
  return Boolean(status && IMMEDIATE_INJURY_MOVE_STATUSES.has(status));
}
