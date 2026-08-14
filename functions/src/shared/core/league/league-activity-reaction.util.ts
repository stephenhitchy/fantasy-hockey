export const LEAGUE_ACTIVITY_REACTION_TYPES = [
  'stick-tap',
  'fire',
  'wow',
  'rink-rat',
] as const;

export type LeagueActivityReactionType = typeof LEAGUE_ACTIVITY_REACTION_TYPES[number];

export const LEAGUE_ACTIVITY_REACTION_MAX_COUNT = 32;
export const LEAGUE_ACTIVITY_REACTION_MIN_INTERVAL_MILLISECONDS = 750;
export const LEAGUE_ACTIVITY_REACTION_WINDOW_MILLISECONDS = 60_000;
export const LEAGUE_ACTIVITY_REACTION_MAX_CHANGES_PER_WINDOW = 20;

export interface LeagueActivityReactionCounts {
  'stick-tap': number;
  fire: number;
  wow: number;
  'rink-rat': number;
}

export interface LeagueActivityReactionRecord {
  ownerId: string;
  reactionType: LeagueActivityReactionType;
  firstChangedAt: Date;
  updatedAt: Date;
}

export interface LeagueActivityReactionTransition {
  changed: boolean;
  previousReactionType: LeagueActivityReactionType | null;
  nextReactionType: LeagueActivityReactionType | null;
  nextRecords: LeagueActivityReactionRecord[];
  nextCounts: LeagueActivityReactionCounts;
}

export interface LeagueActivityReactionRateControl {
  lastChangedAtMilliseconds: number | null;
  windowStartedAtMilliseconds: number | null;
  changesInWindow: number;
}

export interface LeagueActivityReactionRateLimitResult {
  allowed: boolean;
  retryAfterMilliseconds: number;
  nextControl: LeagueActivityReactionRateControl;
}

const REACTION_TYPE_SET = new Set<string>(LEAGUE_ACTIVITY_REACTION_TYPES);

const ELIGIBLE_EVENT_TYPES = new Set<string>([
  'draft-pick',
  'add-drop',
  'add-open-slot',
  'move-to-ir',
  'activate-from-ir',
  'drop-to-waivers',
  'waiver-award',
  'waiver-cleared',
  'slot-move-activated',
  'active-bench-swap-activated',
  'move-bench-to-ir',
  'activate-ir-to-bench',
  'matchup-result',
  'commissioner-announcement',
  'matchup-round-recap',
]);

export function emptyLeagueActivityReactionCounts(): LeagueActivityReactionCounts {
  return {
    'stick-tap': 0,
    fire: 0,
    wow: 0,
    'rink-rat': 0,
  };
}

export function normalizeLeagueActivityReactionType(
  value: unknown,
): LeagueActivityReactionType | null {
  return typeof value === 'string' && REACTION_TYPE_SET.has(value)
    ? value as LeagueActivityReactionType
    : null;
}

export function isLeagueActivityReactionEligibleEventType(value: unknown): boolean {
  return typeof value === 'string' && ELIGIBLE_EVENT_TYPES.has(value);
}

function normalizeOwnerId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  const byteLength = new TextEncoder().encode(normalized).length;

  return normalized && byteLength <= 128 && !/[\/\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null;
}

function normalizeDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const source = value as Record<string, unknown>;

  if (typeof source['toDate'] === 'function') {
    try {
      return normalizeDate((source['toDate'] as () => unknown).call(value));
    } catch {
      return null;
    }
  }

  if (typeof source['toMillis'] === 'function') {
    try {
      const milliseconds = (source['toMillis'] as () => unknown).call(value);
      return typeof milliseconds === 'number' && Number.isFinite(milliseconds)
        ? new Date(milliseconds)
        : null;
    } catch {
      return null;
    }
  }

  const seconds = source['seconds'];
  const nanoseconds = source['nanoseconds'];

  if (
    typeof seconds === 'number' &&
    Number.isFinite(seconds) &&
    (nanoseconds === undefined ||
      (typeof nanoseconds === 'number' && Number.isFinite(nanoseconds)))
  ) {
    const milliseconds = seconds * 1_000 +
      (typeof nanoseconds === 'number' ? nanoseconds / 1_000_000 : 0);
    const candidate = new Date(milliseconds);
    return Number.isFinite(candidate.getTime()) ? candidate : null;
  }

  return null;
}

export function normalizeLeagueActivityReactionRecords(
  value: unknown,
): LeagueActivityReactionRecord[] | null {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value) || value.length > LEAGUE_ACTIVITY_REACTION_MAX_COUNT) {
    return null;
  }

  const ownerIds = new Set<string>();
  const records: LeagueActivityReactionRecord[] = [];

  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return null;
    }

    const source = candidate as Record<string, unknown>;
    const ownerId = normalizeOwnerId(source['ownerId']);
    const reactionType = normalizeLeagueActivityReactionType(source['reactionType']);
    const firstChangedAt = normalizeDate(source['firstChangedAt']);
    const updatedAt = normalizeDate(source['updatedAt']);

    if (
      !ownerId ||
      !reactionType ||
      !firstChangedAt ||
      !updatedAt ||
      firstChangedAt.getTime() > updatedAt.getTime() ||
      ownerIds.has(ownerId)
    ) {
      return null;
    }

    ownerIds.add(ownerId);
    records.push({ ownerId, reactionType, firstChangedAt, updatedAt });
  }

  return records.sort((left, right) => left.ownerId.localeCompare(right.ownerId));
}

export function summarizeLeagueActivityReactionRecords(
  value: unknown,
): LeagueActivityReactionCounts | null {
  const records = normalizeLeagueActivityReactionRecords(value);

  if (!records) {
    return null;
  }

  const counts = emptyLeagueActivityReactionCounts();

  for (const record of records) {
    counts[record.reactionType] += 1;
  }

  return counts;
}

export function applyLeagueActivityReactionSelection(options: {
  records: unknown;
  ownerId: unknown;
  desiredReactionType: LeagueActivityReactionType | null;
  changedAt: unknown;
}): LeagueActivityReactionTransition | null {
  const records = normalizeLeagueActivityReactionRecords(options.records);
  const ownerId = normalizeOwnerId(options.ownerId);
  const changedAt = normalizeDate(options.changedAt);
  const desiredReactionType = options.desiredReactionType === null
    ? null
    : normalizeLeagueActivityReactionType(options.desiredReactionType);

  if (
    !records ||
    !ownerId ||
    !changedAt ||
    (options.desiredReactionType !== null && !desiredReactionType)
  ) {
    return null;
  }

  const existingIndex = records.findIndex((record) => record.ownerId === ownerId);
  const existing = existingIndex >= 0 ? records[existingIndex] : null;
  const previousReactionType = existing?.reactionType ?? null;

  if (previousReactionType === desiredReactionType) {
    return {
      changed: false,
      previousReactionType,
      nextReactionType: desiredReactionType,
      nextRecords: records,
      nextCounts: summarizeLeagueActivityReactionRecords(records) ??
        emptyLeagueActivityReactionCounts(),
    };
  }

  if (!existing && desiredReactionType && records.length >= LEAGUE_ACTIVITY_REACTION_MAX_COUNT) {
    return null;
  }

  const nextRecords = records.filter((record) => record.ownerId !== ownerId);

  if (desiredReactionType) {
    nextRecords.push({
      ownerId,
      reactionType: desiredReactionType,
      firstChangedAt: existing?.firstChangedAt ?? changedAt,
      updatedAt: changedAt,
    });
  }

  nextRecords.sort((left, right) => left.ownerId.localeCompare(right.ownerId));

  return {
    changed: true,
    previousReactionType,
    nextReactionType: desiredReactionType,
    nextRecords,
    nextCounts: summarizeLeagueActivityReactionRecords(nextRecords) ??
      emptyLeagueActivityReactionCounts(),
  };
}

function normalizeOptionalMilliseconds(value: unknown): number | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }

  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function normalizeLeagueActivityReactionRateControl(
  value: unknown,
): LeagueActivityReactionRateControl | null {
  if (value === undefined || value === null) {
    return {
      lastChangedAtMilliseconds: null,
      windowStartedAtMilliseconds: null,
      changesInWindow: 0,
    };
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const source = value as Record<string, unknown>;
  const lastChangedAtMilliseconds = normalizeOptionalMilliseconds(
    source['lastChangedAtMilliseconds'],
  );
  const windowStartedAtMilliseconds = normalizeOptionalMilliseconds(
    source['windowStartedAtMilliseconds'],
  );
  const changesInWindow = source['changesInWindow'];

  if (
    lastChangedAtMilliseconds === undefined ||
    windowStartedAtMilliseconds === undefined ||
    typeof changesInWindow !== 'number' ||
    !Number.isInteger(changesInWindow) ||
    changesInWindow < 0 ||
    changesInWindow > LEAGUE_ACTIVITY_REACTION_MAX_CHANGES_PER_WINDOW
  ) {
    return null;
  }

  if (
    (changesInWindow === 0 && windowStartedAtMilliseconds !== null) ||
    (changesInWindow > 0 && windowStartedAtMilliseconds === null) ||
    (lastChangedAtMilliseconds !== null && windowStartedAtMilliseconds === null) ||
    (lastChangedAtMilliseconds !== null &&
      windowStartedAtMilliseconds !== null &&
      lastChangedAtMilliseconds < windowStartedAtMilliseconds)
  ) {
    return null;
  }

  return {
    lastChangedAtMilliseconds,
    windowStartedAtMilliseconds,
    changesInWindow,
  };
}

export function evaluateLeagueActivityReactionRateLimit(options: {
  control: unknown;
  nowMilliseconds: unknown;
}): LeagueActivityReactionRateLimitResult | null {
  const control = normalizeLeagueActivityReactionRateControl(options.control);
  const nowMilliseconds = options.nowMilliseconds;

  if (
    !control ||
    typeof nowMilliseconds !== 'number' ||
    !Number.isFinite(nowMilliseconds) ||
    nowMilliseconds < 0
  ) {
    return null;
  }

  if (
    control.lastChangedAtMilliseconds !== null &&
    nowMilliseconds < control.lastChangedAtMilliseconds
  ) {
    return null;
  }

  const elapsedSinceLastChange = control.lastChangedAtMilliseconds === null
    ? Number.POSITIVE_INFINITY
    : nowMilliseconds - control.lastChangedAtMilliseconds;

  if (elapsedSinceLastChange < LEAGUE_ACTIVITY_REACTION_MIN_INTERVAL_MILLISECONDS) {
    return {
      allowed: false,
      retryAfterMilliseconds:
        LEAGUE_ACTIVITY_REACTION_MIN_INTERVAL_MILLISECONDS - elapsedSinceLastChange,
      nextControl: control,
    };
  }

  const windowStartedAtMilliseconds = control.windowStartedAtMilliseconds;

  if (
    windowStartedAtMilliseconds === null ||
    nowMilliseconds - windowStartedAtMilliseconds >=
      LEAGUE_ACTIVITY_REACTION_WINDOW_MILLISECONDS
  ) {
    return {
      allowed: true,
      retryAfterMilliseconds: 0,
      nextControl: {
        lastChangedAtMilliseconds: nowMilliseconds,
        windowStartedAtMilliseconds: nowMilliseconds,
        changesInWindow: 1,
      },
    };
  }

  if (control.changesInWindow >= LEAGUE_ACTIVITY_REACTION_MAX_CHANGES_PER_WINDOW) {
    return {
      allowed: false,
      retryAfterMilliseconds: Math.max(
        1,
        LEAGUE_ACTIVITY_REACTION_WINDOW_MILLISECONDS -
          (nowMilliseconds - windowStartedAtMilliseconds),
      ),
      nextControl: control,
    };
  }

  return {
    allowed: true,
    retryAfterMilliseconds: 0,
    nextControl: {
      lastChangedAtMilliseconds: nowMilliseconds,
      windowStartedAtMilliseconds,
      changesInWindow: control.changesInWindow + 1,
    },
  };
}
