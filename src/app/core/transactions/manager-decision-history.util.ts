export type ManagerDecisionHistoryType =
  | 'add-drop'
  | 'add-open-slot'
  | 'waiver-award'
  | 'slot-move-activated';

export interface ManagerDecisionCurrentOwnership {
  area: 'active' | 'bench' | 'ir';
  teamName: string;
}

export interface ManagerDecisionCurrentPlayer {
  assetKey: string;
  name: string;
  nhlTeamAbbreviation: string;
  position: string;
  seasonFantasyPoints: number | null;
  nextSixProjection: number | null;
  positionRank: number | null;
  status: 'rostered' | 'free-agent' | 'waivers' | 'reserved';
  ownership: ManagerDecisionCurrentOwnership | null;
  headshotUrl: string | null;
  logoUrl: string | null;
}

export interface ManagerDecisionTransaction {
  id: string;
  type: string;
  addedAsset?: unknown;
  droppedAsset?: unknown;
  waiverAsset?: unknown;
  effectiveCycleNumber?: unknown;
  effectiveLabel?: unknown;
  createdAt?: unknown;
}

export interface ManagerDecisionHistoryAsset {
  assetKey: string | null;
  name: string;
  teamAbbreviation: string;
  position: string;
  current: ManagerDecisionCurrentPlayer | null;
}

export interface ManagerDecisionHistoryRow {
  id: string;
  type: ManagerDecisionHistoryType;
  label: string;
  occurredAt: Date | null;
  effectiveCycleNumber: number | null;
  effectiveLabel: string | null;
  added: ManagerDecisionHistoryAsset;
  dropped: ManagerDecisionHistoryAsset | null;
  currentSeasonDifference: number | null;
  currentNextSixDifference: number | null;
}

const COMPLETED_DECISION_TYPES = new Set<ManagerDecisionHistoryType>([
  'add-drop',
  'add-open-slot',
  'waiver-award',
  'slot-move-activated',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown, maximumLength = 160): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized && normalized.length <= maximumLength ? normalized : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function normalizeDate(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value;
  }

  const timestampLike = asRecord(value);
  if (timestampLike) {
    const toDate = timestampLike['toDate'];
    if (typeof toDate === 'function') {
      try {
        const date = toDate.call(value);
        return date instanceof Date && Number.isFinite(date.getTime()) ? date : null;
      } catch {
        return null;
      }
    }

    const seconds = finiteNumber(timestampLike['seconds']);
    if (seconds !== null) {
      const nanoseconds = finiteNumber(timestampLike['nanoseconds']) ?? 0;
      const date = new Date((seconds * 1_000) + Math.floor(nanoseconds / 1_000_000));
      return Number.isFinite(date.getTime()) ? date : null;
    }
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  return null;
}

function getAssetKey(value: unknown): string | null {
  const source = asRecord(value);
  if (!source) {
    return null;
  }

  const direct = boundedString(source['assetKey']);
  if (direct) {
    return direct;
  }

  if (source['assetType'] === 'skater') {
    const player = asRecord(source['player']);
    const playerId = player?.['id'];
    if (typeof playerId === 'number' && Number.isInteger(playerId) && playerId > 0) {
      return `skater-${playerId}`;
    }
    const stringPlayerId = boundedString(playerId, 32);
    return stringPlayerId ? `skater-${stringPlayerId}` : null;
  }

  if (source['assetType'] === 'team-goalie-unit') {
    const abbreviation = boundedString(source['teamAbbreviation'], 8);
    return abbreviation ? `goalie-unit-${abbreviation}` : null;
  }

  return null;
}

function buildHistoryAsset(
  value: unknown,
  rowsByAssetKey: ReadonlyMap<string, ManagerDecisionCurrentPlayer>,
): ManagerDecisionHistoryAsset | null {
  const source = asRecord(value);
  if (!source) {
    return null;
  }

  const assetKey = getAssetKey(source);
  const current = assetKey ? rowsByAssetKey.get(assetKey) ?? null : null;

  if (current) {
    return {
      assetKey,
      name: current.name,
      teamAbbreviation: current.nhlTeamAbbreviation,
      position: current.position,
      current,
    };
  }

  if (source['assetType'] === 'skater') {
    const player = asRecord(source['player']);
    const name = boundedString(player?.['fullName']) ??
      [boundedString(player?.['firstName']), boundedString(player?.['lastName'])]
        .filter(Boolean)
        .join(' ');
    const teamAbbreviation = boundedString(
      player?.['nhlTeamAbbreviation'] ?? player?.['teamAbbrev'],
      8,
    ) ?? 'NHL';
    const position = boundedString(source['position'], 4) ?? '—';

    return name
      ? { assetKey, name, teamAbbreviation, position, current: null }
      : null;
  }

  if (source['assetType'] === 'team-goalie-unit') {
    const teamName = boundedString(source['teamName']) ?? 'Team';
    const teamAbbreviation = boundedString(source['teamAbbreviation'], 8) ?? 'NHL';
    return {
      assetKey,
      name: `${teamName} Goalie Unit`,
      teamAbbreviation,
      position: 'G',
      current: null,
    };
  }

  return null;
}

function decisionLabel(type: ManagerDecisionHistoryType): string {
  switch (type) {
    case 'add-open-slot':
      return 'Added to open slot';
    case 'waiver-award':
      return 'Waiver claim won';
    case 'slot-move-activated':
      return 'Scheduled move activated';
    default:
      return 'Add / Drop';
  }
}

function difference(
  added: number | null | undefined,
  dropped: number | null | undefined,
): number | null {
  return typeof added === 'number' && Number.isFinite(added) &&
    typeof dropped === 'number' && Number.isFinite(dropped)
    ? added - dropped
    : null;
}

export function isCompletedManagerDecisionType(
  value: string,
): value is ManagerDecisionHistoryType {
  return COMPLETED_DECISION_TYPES.has(value as ManagerDecisionHistoryType);
}

export function buildManagerDecisionHistoryRows(
  transactions: readonly ManagerDecisionTransaction[],
  playerRows: readonly ManagerDecisionCurrentPlayer[],
): ManagerDecisionHistoryRow[] {
  const rowsByAssetKey = new Map(playerRows.map((row) => [row.assetKey, row] as const));

  return transactions
    .filter((transaction) => isCompletedManagerDecisionType(transaction.type))
    .map((transaction): ManagerDecisionHistoryRow | null => {
      const added = buildHistoryAsset(
        transaction.addedAsset ?? transaction.waiverAsset,
        rowsByAssetKey,
      );

      if (!added) {
        return null;
      }

      const dropped = buildHistoryAsset(transaction.droppedAsset, rowsByAssetKey);
      const type = transaction.type as ManagerDecisionHistoryType;

      return {
        id: transaction.id,
        type,
        label: decisionLabel(type),
        occurredAt: normalizeDate(transaction.createdAt),
        effectiveCycleNumber: positiveInteger(transaction.effectiveCycleNumber),
        effectiveLabel: boundedString(transaction.effectiveLabel, 80),
        added,
        dropped,
        currentSeasonDifference: dropped
          ? difference(
            added.current?.seasonFantasyPoints,
            dropped.current?.seasonFantasyPoints,
          )
          : null,
        currentNextSixDifference: dropped
          ? difference(
            added.current?.nextSixProjection,
            dropped.current?.nextSixProjection,
          )
          : null,
      };
    })
    .filter((row): row is ManagerDecisionHistoryRow => row !== null)
    .sort((left, right) =>
      (right.occurredAt?.getTime() ?? 0) - (left.occurredAt?.getTime() ?? 0) ||
      right.id.localeCompare(left.id),
    );
}
