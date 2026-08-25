export const RINKRAT_PUBLIC_ORIGIN = 'https://rinkratfantasy.com';
export const PENDING_LEAGUE_INVITE_STORAGE_KEY =
  'rinkrat:pending-league-invite:v1';
export const PENDING_LEAGUE_INVITE_MAX_AGE_MS = 72 * 60 * 60 * 1_000;

export interface PendingLeagueInviteIntent {
  schemaVersion: 1;
  inviteCode: string;
  requestedAt: number;
  expiresAt: number;
  accountUid: string | null;
  requiresTrainingCamp: boolean;
}

export type PendingLeagueInviteAccountMatch =
  | 'unbound'
  | 'matching'
  | 'mismatch';

export type LeagueInviteContinuationStep =
  | 'training-camp'
  | 'email-verification'
  | 'join';

export function resolveLeagueInviteContinuationStep(options: {
  trainingCampResolved: boolean;
  emailVerified: boolean;
}): LeagueInviteContinuationStep {
  if (!options.trainingCampResolved) {
    return 'training-camp';
  }

  return options.emailVerified ? 'join' : 'email-verification';
}

let memoryStorageValue = '';

export function normalizeLeagueInviteCode(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

export function isValidLeagueInviteCode(value: unknown): boolean {
  return /^[A-Z0-9]{6}$/.test(normalizeLeagueInviteCode(value));
}

export function buildLeagueInvitePath(inviteCode: unknown): string {
  const normalizedCode = normalizeLeagueInviteCode(inviteCode);
  return isValidLeagueInviteCode(normalizedCode)
    ? `/join/${encodeURIComponent(normalizedCode)}`
    : '';
}

export function buildLeagueInviteUrl(
  inviteCode: unknown,
  origin = RINKRAT_PUBLIC_ORIGIN,
): string {
  const path = buildLeagueInvitePath(inviteCode);

  if (!path) {
    return '';
  }

  const normalizedOrigin = origin.trim().replace(/\/+$/, '') || RINKRAT_PUBLIC_ORIGIN;
  return `${normalizedOrigin}${path}`;
}

export function startPendingLeagueInvite(
  inviteCode: unknown,
  options: {
    accountUid?: string | null;
    requiresTrainingCamp?: boolean;
    now?: number;
  } = {},
): PendingLeagueInviteIntent | null {
  const normalizedCode = normalizeLeagueInviteCode(inviteCode);

  if (!isValidLeagueInviteCode(normalizedCode)) {
    return null;
  }

  const requestedAt = normalizeNow(options.now);
  const intent: PendingLeagueInviteIntent = {
    schemaVersion: 1,
    inviteCode: normalizedCode,
    requestedAt,
    expiresAt: requestedAt + PENDING_LEAGUE_INVITE_MAX_AGE_MS,
    accountUid: normalizeAccountUid(options.accountUid),
    requiresTrainingCamp: options.requiresTrainingCamp === true,
  };

  writeIntent(intent);
  return intent;
}

export function readPendingLeagueInvite(
  inviteCode?: unknown,
  now = Date.now(),
): PendingLeagueInviteIntent | null {
  const rawValue = readStoredValue();

  if (!rawValue) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawValue);
  } catch {
    clearStoredValue();
    return null;
  }

  const intent = normalizeStoredIntent(parsed);
  const normalizedNow = normalizeNow(now);

  if (!intent || intent.expiresAt <= normalizedNow) {
    clearStoredValue();
    return null;
  }

  const requestedCode = normalizeLeagueInviteCode(inviteCode);

  if (requestedCode && intent.inviteCode !== requestedCode) {
    return null;
  }

  return intent;
}

export function pendingLeagueInviteAccountMatch(
  intent: PendingLeagueInviteIntent,
  accountUid: unknown,
): PendingLeagueInviteAccountMatch {
  const normalizedUid = normalizeAccountUid(accountUid);

  if (!intent.accountUid) {
    return 'unbound';
  }

  return normalizedUid && intent.accountUid === normalizedUid
    ? 'matching'
    : 'mismatch';
}

export function bindPendingLeagueInviteToAccount(
  accountUid: unknown,
  options: {
    inviteCode?: unknown;
    allowAccountSwitch?: boolean;
    now?: number;
  } = {},
): PendingLeagueInviteIntent | null {
  const normalizedUid = normalizeAccountUid(accountUid);
  const intent = readPendingLeagueInvite(options.inviteCode, options.now);

  if (!normalizedUid || !intent) {
    return null;
  }

  if (
    intent.accountUid &&
    intent.accountUid !== normalizedUid &&
    options.allowAccountSwitch !== true
  ) {
    return null;
  }

  return updateIntent(intent, {
    accountUid: normalizedUid,
  });
}

export function unbindPendingLeagueInviteAccount(
  inviteCode?: unknown,
  now = Date.now(),
): PendingLeagueInviteIntent | null {
  const intent = readPendingLeagueInvite(inviteCode, now);

  if (!intent) {
    return null;
  }

  return updateIntent(intent, {
    accountUid: null,
  });
}

export function markPendingLeagueInviteRequiresTrainingCamp(
  accountUid: unknown,
  inviteCode?: unknown,
): PendingLeagueInviteIntent | null {
  const intent = bindPendingLeagueInviteToAccount(accountUid, { inviteCode });

  if (!intent) {
    return null;
  }

  return updateIntent(intent, {
    requiresTrainingCamp: true,
  });
}

export function markPendingLeagueInviteTrainingCampComplete(
  accountUid: unknown,
  inviteCode?: unknown,
): PendingLeagueInviteIntent | null {
  const intent = readPendingLeagueInvite(inviteCode);
  const normalizedUid = normalizeAccountUid(accountUid);

  if (!intent || !normalizedUid || intent.accountUid !== normalizedUid) {
    return null;
  }

  return updateIntent(intent, {
    requiresTrainingCamp: false,
  });
}

export function clearPendingLeagueInvite(inviteCode?: unknown): void {
  const requestedCode = normalizeLeagueInviteCode(inviteCode);

  if (requestedCode) {
    const intent = readPendingLeagueInvite();

    if (intent && intent.inviteCode !== requestedCode) {
      return;
    }
  }

  clearStoredValue();
}

function normalizeStoredIntent(value: unknown): PendingLeagueInviteIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const inviteCode = normalizeLeagueInviteCode(record['inviteCode']);
  const requestedAt = normalizeTimestamp(record['requestedAt']);
  const expiresAt = normalizeTimestamp(record['expiresAt']);
  const accountUid = normalizeAccountUid(record['accountUid']);

  if (
    record['schemaVersion'] !== 1 ||
    !isValidLeagueInviteCode(inviteCode) ||
    requestedAt <= 0 ||
    expiresAt <= requestedAt ||
    expiresAt - requestedAt > PENDING_LEAGUE_INVITE_MAX_AGE_MS ||
    typeof record['requiresTrainingCamp'] !== 'boolean'
  ) {
    return null;
  }

  if (
    record['accountUid'] !== null &&
    record['accountUid'] !== undefined &&
    !accountUid
  ) {
    return null;
  }

  return {
    schemaVersion: 1,
    inviteCode,
    requestedAt,
    expiresAt,
    accountUid,
    requiresTrainingCamp: record['requiresTrainingCamp'],
  };
}

function updateIntent(
  intent: PendingLeagueInviteIntent,
  update: Partial<Pick<PendingLeagueInviteIntent, 'accountUid' | 'requiresTrainingCamp'>>,
): PendingLeagueInviteIntent {
  const nextIntent: PendingLeagueInviteIntent = {
    ...intent,
    ...update,
  };

  writeIntent(nextIntent);
  return nextIntent;
}

function normalizeAccountUid(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized && normalized.length <= 128 ? normalized : null;
}

function normalizeTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}

function normalizeNow(value: unknown): number {
  const normalized = normalizeTimestamp(value);
  return normalized > 0 ? normalized : Date.now();
}

function readStoredValue(): string {
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem(PENDING_LEAGUE_INVITE_STORAGE_KEY) ?? '';
    }
  } catch {
    // Storage is convenience-only. The in-memory fallback keeps this tab usable.
  }

  return memoryStorageValue;
}

function writeIntent(intent: PendingLeagueInviteIntent): void {
  const serialized = JSON.stringify(intent);
  memoryStorageValue = serialized;

  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(PENDING_LEAGUE_INVITE_STORAGE_KEY, serialized);
    }
  } catch {
    // Continue with the in-memory fallback when storage is unavailable.
  }
}

function clearStoredValue(): void {
  memoryStorageValue = '';

  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(PENDING_LEAGUE_INVITE_STORAGE_KEY);
    }
  } catch {
    // Storage cleanup must never block navigation.
  }
}
