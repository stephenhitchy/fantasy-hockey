export const LEAGUE_LIFECYCLE_STATE_SCHEMA_VERSION = 1;
export const LEAGUE_AUTHORITY_SCHEMA_VERSION = 2;
export const LEAGUE_DOCUMENT_SCHEMA_VERSION = 1;
export const LEAGUE_INVITE_SCHEMA_VERSION = 1;
export const LEAGUE_MEMBER_SCHEMA_VERSION = 1;
export const LEAGUE_TEAM_SCHEMA_VERSION = 1;
export const LEAGUE_AUDIT_SCHEMA_VERSION = 1;

export const MAX_ACTIVE_LEAGUES_PER_USER = 20;
export const MAX_LEAGUE_CREATIONS_PER_24_HOURS = 8;
export const MAX_JOIN_ATTEMPTS_PER_10_MINUTES = 20;
export const MAX_JOIN_ATTEMPTS_PER_24_HOURS = 100;
export const LEAGUE_CREATION_WINDOW_MILLISECONDS = 24 * 60 * 60 * 1000;
export const LEAGUE_JOIN_SHORT_WINDOW_MILLISECONDS = 10 * 60 * 1000;
export const LEAGUE_JOIN_DAILY_WINDOW_MILLISECONDS = 24 * 60 * 60 * 1000;

export const LEAGUE_DOCUMENT_KEYS = [
  'id',
  'name',
  'leagueLogoId',
  'leagueLogoPaletteId',
  'commissionerId',
  'inviteCode',
  'maxTeams',
  'teamCount',
  'joinStatus',
  'joinLockedAt',
  'joinLockedReason',
  'matchupFormat',
  'requiredGamesPerCycle',
  'scoringRules',
  'scoringRulesVersion',
  'authoritySchemaVersion',
  'documentSchemaVersion',
  'createdByAuthority',
  'competitionSettingsLocked',
  'createdAt',
  'updatedAt',
  'migratedAt',
  'deletionStatus',
  'deletionRequestedBy',
  'deletionRequestedAt',
] as const;

export const LEAGUE_INVITE_DOCUMENT_KEYS = [
  'schemaVersion',
  'inviteCode',
  'leagueId',
  'createdBy',
  'active',
  'joinCount',
  'expiresAt',
  'lockedAt',
  'lockedReason',
  'lastJoinedAt',
  'createdAt',
  'updatedAt',
  'authority',
] as const;

export const LEAGUE_MEMBER_DOCUMENT_KEYS = [
  'schemaVersion',
  'uid',
  'leagueId',
  'username',
  'profileIconId',
  'role',
  'inviteCodeUsed',
  'joinedAt',
  'authority',
  'accountDeleted',
  'accountDeletedAt',
  'updatedAt',
] as const;

export const LEAGUE_TEAM_DOCUMENT_KEYS = [
  'schemaVersion',
  'id',
  'ownerId',
  'teamName',
  'managerName',
  'profileIconId',
  'logo',
  'wins',
  'losses',
  'ties',
  'pointsFor',
  'pointsAgainst',
  'waiverPriority',
  'draftPosition',
  'createdAt',
  'updatedAt',
  'authority',
  'accountDeleted',
  'accountDeletedAt',
] as const;

export interface RollingWindowState {
  startedAtMilliseconds: number | null;
  count: number;
}

export interface NormalizedRollingWindow {
  startedAtMilliseconds: number;
  count: number;
  reset: boolean;
}

export function normalizeRollingWindow(
  state: RollingWindowState,
  nowMilliseconds: number,
  durationMilliseconds: number,
): NormalizedRollingWindow {
  const startedAtMilliseconds = state.startedAtMilliseconds;
  const count = Number.isInteger(state.count) && state.count > 0
    ? state.count
    : 0;

  if (
    startedAtMilliseconds === null ||
    !Number.isFinite(startedAtMilliseconds) ||
    startedAtMilliseconds > nowMilliseconds ||
    nowMilliseconds - startedAtMilliseconds >= durationMilliseconds
  ) {
    return {
      startedAtMilliseconds: nowMilliseconds,
      count: 0,
      reset: true,
    };
  }

  return {
    startedAtMilliseconds,
    count,
    reset: false,
  };
}

export function getEffectiveActiveLeagueCount(
  storedCount: unknown,
  measuredCount: number,
): number {
  const normalizedStoredCount = typeof storedCount === 'number' && Number.isInteger(storedCount)
    ? Math.max(0, storedCount)
    : 0;
  const normalizedMeasuredCount = Number.isInteger(measuredCount)
    ? Math.max(0, measuredCount)
    : 0;

  return Math.max(normalizedStoredCount, normalizedMeasuredCount);
}

export function isDraftJoinLocked(draftData: unknown): boolean {
  if (!draftData || typeof draftData !== 'object' || Array.isArray(draftData)) {
    return false;
  }

  const data = draftData as Record<string, unknown>;
  const status = typeof data['status'] === 'string' ? data['status'] : '';
  const roundOneOrder = Array.isArray(data['roundOneOrder'])
    ? data['roundOneOrder']
    : [];
  const draftedAssetKeys = Array.isArray(data['draftedAssetKeys'])
    ? data['draftedAssetKeys']
    : [];
  const nextOverallPick = typeof data['nextOverallPick'] === 'number'
    ? data['nextOverallPick']
    : 1;

  return (
    status === 'scheduled' ||
    status === 'live' ||
    status === 'complete' ||
    roundOneOrder.length > 0 ||
    draftedAssetKeys.length > 0 ||
    nextOverallPick > 1
  );
}

export function getOccupiedLeagueOwnerIds(
  memberOwnerIds: readonly string[],
  teamOwnerIds: readonly string[],
): string[] {
  return [...new Set(
    [...memberOwnerIds, ...teamOwnerIds]
      .map((ownerId) => ownerId.trim())
      .filter(Boolean),
  )].sort((first, second) => first.localeCompare(second));
}

export function getUnexpectedDocumentKeys(
  data: Record<string, unknown>,
  allowedKeys: readonly string[],
): string[] {
  const allowed = new Set(allowedKeys);
  return Object.keys(data)
    .filter((key) => !allowed.has(key))
    .sort((first, second) => first.localeCompare(second));
}

export function normalizeBoundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, value));
}

export function getCanonicalJoinStatus(input: {
  teamCount: number;
  maxTeams: number;
  draftLocked: boolean;
  storedStatus?: unknown;
}): 'open' | 'locked' | 'full' {
  if (input.teamCount >= input.maxTeams) {
    return 'full';
  }

  if (input.draftLocked || input.storedStatus === 'locked') {
    return 'locked';
  }

  return 'open';
}
