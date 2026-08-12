import type { PlayerAvailability } from '../../../core/player/player-availability.models';

export interface MobilePlayerAvailabilityStatus {
  icon: string;
  shortLabel: string;
  returnDateLabel: string | null;
  ariaLabel: string;
}

const INJURY_STATUSES = new Set([
  'day-to-day',
  'out',
  'injured-reserve',
  'long-term-injured-reserve',
]);

function formatReturnDate(value: string | undefined, now = new Date()): string | null {
  if (!value) return null;

  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T12:00:00.000Z`
    : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;

  const includeYear = date.getUTCFullYear() !== now.getUTCFullYear();
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    ...(includeYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  }).format(date);
}

export function getMobilePlayerAvailabilityStatus(
  availability: PlayerAvailability,
  now = new Date(),
): MobilePlayerAvailabilityStatus | null {
  if (availability.status === 'suspended') {
    return {
      icon: '⛔',
      shortLabel: availability.shortLabel || 'Susp.',
      returnDateLabel: null,
      ariaLabel: 'Suspended player',
    };
  }

  if (!INJURY_STATUSES.has(availability.status)) {
    return null;
  }

  const formattedReturnDate = formatReturnDate(availability.externalReturnDate, now);
  const returnDateLabel = formattedReturnDate ? `Return ${formattedReturnDate}` : 'Return TBD';
  const shortLabel = availability.shortLabel || 'Inj.';

  return {
    icon: '✚',
    shortLabel,
    returnDateLabel,
    ariaLabel: `${availability.label}. ${returnDateLabel}.`,
  };
}
