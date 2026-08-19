import type {
  OfflineMatchupMarkerSnapshot,
  OfflineMatchupMarkerStatus,
  OfflineMatchupPlayerSnapshot,
  OfflineMatchupPositionGroupSnapshot,
  OfflineMatchupPositionRowSnapshot,
  OfflineMatchupSnapshotContext,
  OfflineMatchupTeamSnapshot,
  RinkRatOfflineMatchupSnapshot,
} from './offline-matchup-snapshot.models';

export const OFFLINE_MATCHUP_SNAPSHOT_SCHEMA_VERSION = 1;
export const OFFLINE_MATCHUP_SNAPSHOT_MAX_PER_ACCOUNT = 12;
export const OFFLINE_MATCHUP_SNAPSHOT_MAX_AGE_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;
export const OFFLINE_MATCHUP_SNAPSHOT_MAX_BYTES = 350_000;
export const OFFLINE_MATCHUP_SNAPSHOT_MAX_GROUPS = 5;
export const OFFLINE_MATCHUP_SNAPSHOT_MAX_ROWS_PER_GROUP = 4;

const ALLOWED_POSITIONS = new Set(['LW', 'C', 'RW', 'D', 'G']);
const ALLOWED_MARKER_STATUSES = new Set<OfflineMatchupMarkerStatus>([
  'played',
  'missed',
  'live',
  'upcoming',
  'unavailable',
]);

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function finiteNumber(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= minimum &&
      value <= maximum
    ? value
    : null;
}

function nullableFiniteNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null | undefined {
  if (value === null) {
    return null;
  }

  const normalized = finiteNumber(value, minimum, maximum);
  return normalized === null ? undefined : normalized;
}

function validIsoDate(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function normalizeMarker(value: unknown): OfflineMatchupMarkerSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = value as Record<string, unknown>;
  const index = finiteNumber(source['index'], 1, 6);
  const status = source['status'];
  const label = boundedString(source['label'], 220);

  if (
    index === null ||
    !Number.isInteger(index) ||
    !ALLOWED_MARKER_STATUSES.has(status as OfflineMatchupMarkerStatus) ||
    !label
  ) {
    return null;
  }

  return { index, status: status as OfflineMatchupMarkerStatus, label };
}

function normalizePlayer(value: unknown): OfflineMatchupPlayerSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = value as Record<string, unknown>;
  const playerName = boundedString(source['playerName'], 120);
  const teamLabel = boundedString(source['teamLabel'], 48);
  const position = source['position'];
  const currentPoints = finiteNumber(source['currentPoints'], -1_000, 10_000);
  const projectedPoints = nullableFiniteNumber(source['projectedPoints'], -1_000, 10_000);
  const availabilityLabel = source['availabilityLabel'] === null
    ? null
    : boundedString(source['availabilityLabel'], 180);
  const rawMarkers = Array.isArray(source['markers']) ? source['markers'] : null;

  if (
    !playerName ||
    !teamLabel ||
    !ALLOWED_POSITIONS.has(position as string) ||
    currentPoints === null ||
    projectedPoints === undefined ||
    availabilityLabel === undefined ||
    !rawMarkers ||
    rawMarkers.length !== 6
  ) {
    return null;
  }

  const markers = rawMarkers.map(normalizeMarker);

  if (markers.some((marker) => marker === null)) {
    return null;
  }

  const normalizedMarkers = markers as OfflineMatchupMarkerSnapshot[];

  if (new Set(normalizedMarkers.map((marker) => marker.index)).size !== 6) {
    return null;
  }

  return {
    playerName,
    teamLabel,
    position: position as OfflineMatchupPlayerSnapshot['position'],
    currentPoints,
    projectedPoints,
    availabilityLabel,
    markers: normalizedMarkers.sort((left, right) => left.index - right.index),
  };
}

function normalizeRow(value: unknown): OfflineMatchupPositionRowSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = value as Record<string, unknown>;
  const slotLabel = boundedString(source['slotLabel'], 80);
  const rawTeamAPlayer = source['teamAPlayer'];
  const rawTeamBPlayer = source['teamBPlayer'];
  const teamAPlayer = rawTeamAPlayer === null ? null : normalizePlayer(rawTeamAPlayer);
  const teamBPlayer = rawTeamBPlayer === null ? null : normalizePlayer(rawTeamBPlayer);

  if (
    !slotLabel ||
    (rawTeamAPlayer !== null && !teamAPlayer) ||
    (rawTeamBPlayer !== null && !teamBPlayer) ||
    (!teamAPlayer && !teamBPlayer)
  ) {
    return null;
  }

  return { slotLabel, teamAPlayer, teamBPlayer };
}

function normalizeGroup(value: unknown): OfflineMatchupPositionGroupSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = value as Record<string, unknown>;
  const position = source['position'];
  const label = boundedString(source['label'], 60);
  const rawRows = Array.isArray(source['rows']) ? source['rows'] : null;

  if (
    !ALLOWED_POSITIONS.has(position as string) ||
    !label ||
    !rawRows ||
    rawRows.length < 1 ||
    rawRows.length > OFFLINE_MATCHUP_SNAPSHOT_MAX_ROWS_PER_GROUP
  ) {
    return null;
  }

  const rows = rawRows.map(normalizeRow);

  if (rows.some((row) => row === null)) {
    return null;
  }

  return {
    position: position as OfflineMatchupPositionGroupSnapshot['position'],
    label,
    rows: rows as OfflineMatchupPositionRowSnapshot[],
  };
}

function normalizeTeam(value: unknown): OfflineMatchupTeamSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = value as Record<string, unknown>;
  const teamName = boundedString(source['teamName'], 120);
  const record = boundedString(source['record'], 40);
  const currentScore = finiteNumber(source['currentScore'], -10_000, 100_000);
  const projectedScore = nullableFiniteNumber(source['projectedScore'], -10_000, 100_000);
  const gamesPlayed = finiteNumber(source['gamesPlayed'], 0, 1_000);
  const gamesTotal = finiteNumber(source['gamesTotal'], 0, 1_000);
  const resultLabel = source['resultLabel'] === null
    ? null
    : boundedString(source['resultLabel'], 60);

  if (
    !teamName ||
    !record ||
    currentScore === null ||
    projectedScore === undefined ||
    gamesPlayed === null ||
    gamesTotal === null ||
    !Number.isInteger(gamesPlayed) ||
    !Number.isInteger(gamesTotal) ||
    gamesPlayed > gamesTotal ||
    resultLabel === undefined ||
    typeof source['viewerTeam'] !== 'boolean'
  ) {
    return null;
  }

  return {
    teamName,
    record,
    currentScore,
    projectedScore,
    gamesPlayed,
    gamesTotal,
    resultLabel,
    viewerTeam: source['viewerTeam'],
  };
}

function serializedByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function normalizeOfflineMatchupSnapshot(
  value: unknown,
  expectedContext?: OfflineMatchupSnapshotContext,
): RinkRatOfflineMatchupSnapshot | null {
  if (!value || typeof value !== 'object' || serializedByteLength(value) > OFFLINE_MATCHUP_SNAPSHOT_MAX_BYTES) {
    return null;
  }

  const source = value as Record<string, unknown>;
  const accountId = boundedString(source['accountId'], 128);
  const leagueId = boundedString(source['leagueId'], 128);
  const leagueName = boundedString(source['leagueName'], 160);
  const cycleNumber = finiteNumber(source['cycleNumber'], 1, 1_000);
  const cycleLabel = boundedString(source['cycleLabel'], 100);
  const matchupId = boundedString(source['matchupId'], 160);
  const matchupLabel = boundedString(source['matchupLabel'], 240);
  const matchupStatus = source['matchupStatus'];
  const readinessLabel = boundedString(source['readinessLabel'], 120);
  const finishLabel = boundedString(source['finishLabel'], 120);
  const savedAt = validIsoDate(source['savedAt']);
  const sourceReleaseLabel = boundedString(source['sourceReleaseLabel'], 120);
  const sourceScoringVersion = finiteNumber(source['sourceScoringVersion'], 1, 1_000);
  const sourceProjectionVersion = finiteNumber(source['sourceProjectionVersion'], 1, 1_000);
  const teamA = normalizeTeam(source['teamA']);
  const rawTeamB = source['teamB'];
  const teamB = rawTeamB === null ? null : normalizeTeam(rawTeamB);
  const rawGroups = Array.isArray(source['positionGroups']) ? source['positionGroups'] : null;

  if (
    source['schemaVersion'] !== OFFLINE_MATCHUP_SNAPSHOT_SCHEMA_VERSION ||
    !accountId || !leagueId || !leagueName ||
    cycleNumber === null || !Number.isInteger(cycleNumber) ||
    !cycleLabel || !matchupId || !matchupLabel ||
    (matchupStatus !== 'active' && matchupStatus !== 'complete') ||
    !readinessLabel || !finishLabel || !savedAt || !sourceReleaseLabel ||
    sourceScoringVersion === null || sourceProjectionVersion === null ||
    !Number.isInteger(sourceScoringVersion) || !Number.isInteger(sourceProjectionVersion) ||
    !teamA || (rawTeamB !== null && !teamB) ||
    !rawGroups || rawGroups.length < 1 || rawGroups.length > OFFLINE_MATCHUP_SNAPSHOT_MAX_GROUPS
  ) {
    return null;
  }

  const positionGroups = rawGroups.map(normalizeGroup);

  if (positionGroups.some((group) => group === null)) {
    return null;
  }

  if (
    expectedContext &&
    (accountId !== expectedContext.accountId.trim() ||
      leagueId !== expectedContext.leagueId.trim() ||
      cycleNumber !== expectedContext.cycleNumber ||
      (expectedContext.matchupId && matchupId !== expectedContext.matchupId.trim()))
  ) {
    return null;
  }

  return {
    schemaVersion: OFFLINE_MATCHUP_SNAPSHOT_SCHEMA_VERSION,
    accountId,
    leagueId,
    leagueName,
    cycleNumber,
    cycleLabel,
    matchupId,
    matchupLabel,
    matchupStatus,
    readinessLabel,
    finishLabel,
    savedAt,
    sourceReleaseLabel,
    sourceScoringVersion,
    sourceProjectionVersion,
    teamA,
    teamB,
    positionGroups: positionGroups as OfflineMatchupPositionGroupSnapshot[],
  };
}

export function createOfflineMatchupSnapshotStorageKey(
  context: OfflineMatchupSnapshotContext,
): string {
  return [
    encodeURIComponent(context.accountId.trim()),
    encodeURIComponent(context.leagueId.trim()),
    context.cycleNumber,
    encodeURIComponent(context.matchupId?.trim() || 'default'),
  ].join('::');
}

export function isOfflineMatchupSnapshotFresh(
  snapshot: RinkRatOfflineMatchupSnapshot,
  nowMilliseconds = Date.now(),
): boolean {
  const savedAtMilliseconds = Date.parse(snapshot.savedAt);

  return Number.isFinite(savedAtMilliseconds) &&
    savedAtMilliseconds <= nowMilliseconds + 5 * 60 * 1_000 &&
    nowMilliseconds - savedAtMilliseconds <= OFFLINE_MATCHUP_SNAPSHOT_MAX_AGE_MILLISECONDS;
}

export function selectOfflineMatchupSnapshot(
  values: readonly unknown[],
  context: OfflineMatchupSnapshotContext,
  nowMilliseconds = Date.now(),
): RinkRatOfflineMatchupSnapshot | null {
  const snapshots = values
    .map((value) => normalizeOfflineMatchupSnapshot(value))
    .filter((snapshot): snapshot is RinkRatOfflineMatchupSnapshot => Boolean(snapshot))
    .filter((snapshot) =>
      snapshot.accountId === context.accountId.trim() &&
      snapshot.leagueId === context.leagueId.trim() &&
      snapshot.cycleNumber === context.cycleNumber &&
      isOfflineMatchupSnapshotFresh(snapshot, nowMilliseconds),
    )
    .sort((left, right) => right.savedAt.localeCompare(left.savedAt));

  if (context.matchupId?.trim()) {
    return snapshots.find((snapshot) => snapshot.matchupId === context.matchupId?.trim()) ?? null;
  }

  return snapshots.find((snapshot) => snapshot.teamA.viewerTeam || snapshot.teamB?.viewerTeam) ?? null;
}

export function offlineMatchupSnapshotContentEquals(
  left: RinkRatOfflineMatchupSnapshot,
  right: RinkRatOfflineMatchupSnapshot,
): boolean {
  const withoutSavedAt = (snapshot: RinkRatOfflineMatchupSnapshot): unknown => ({
    ...snapshot,
    savedAt: '',
  });

  return JSON.stringify(withoutSavedAt(left)) === JSON.stringify(withoutSavedAt(right));
}

export function getOfflineMatchupSnapshotAgeLabel(
  savedAt: string,
  nowMilliseconds = Date.now(),
): string {
  const savedAtMilliseconds = Date.parse(savedAt);

  if (!Number.isFinite(savedAtMilliseconds)) {
    return 'Saved time unavailable';
  }

  const ageMilliseconds = Math.max(0, nowMilliseconds - savedAtMilliseconds);
  const minutes = Math.floor(ageMilliseconds / 60_000);

  if (minutes < 1) return 'Saved just now';
  if (minutes < 60) return `Saved ${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Saved ${hours} hr ago`;

  const days = Math.floor(hours / 24);
  return `Saved ${days} ${days === 1 ? 'day' : 'days'} ago`;
}
