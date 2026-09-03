import type { PlayerAvailability } from '../../../core/player/player-availability.models';

export type DraftPlayerAvailabilityTone = 'danger' | 'warning' | 'neutral';

export interface DraftPlayerAvailabilityDisplay {
  icon: 'injury' | 'suspended' | 'notice';
  iconText: string;
  shortLabel: string;
  timingLabel: string | null;
  ariaLabel: string;
  tone: DraftPlayerAvailabilityTone;
}

const INJURY_STATUSES = new Set([
  'day-to-day',
  'out',
  'injured-reserve',
  'long-term-injured-reserve',
]);

function formatReturnDate(value: string | undefined, now: Date): string | null {
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

export function getDraftPlayerAvailabilityDisplay(
  availability: PlayerAvailability,
  now = new Date(),
): DraftPlayerAvailabilityDisplay | null {
  if (availability.status === 'active') {
    return null;
  }

  if (INJURY_STATUSES.has(availability.status)) {
    const returnDate = formatReturnDate(availability.externalReturnDate, now);
    const timingLabel = returnDate ? `Est. ${returnDate}` : 'Return TBD';
    const irEligibilityLabel = availability.irEligible
      ? ' Injured Reserve eligible.'
      : '';

    return {
      icon: 'injury',
      iconText: '',
      shortLabel: availability.shortLabel || 'Inj.',
      timingLabel,
      ariaLabel: `${availability.label}. ${timingLabel}.${irEligibilityLabel}`,
      tone: availability.status === 'day-to-day' ? 'warning' : 'danger',
    };
  }

  if (availability.status === 'suspended') {
    return {
      icon: 'suspended',
      iconText: '⛔',
      shortLabel: availability.shortLabel || 'Susp.',
      timingLabel: null,
      ariaLabel: 'Suspended player.',
      tone: 'warning',
    };
  }

  return {
    icon: 'notice',
    iconText: availability.status === 'unknown' ? '?' : '!',
    shortLabel: availability.shortLabel || availability.label,
    timingLabel: null,
    ariaLabel: `${availability.label}.`,
    tone: 'neutral',
  };
}
