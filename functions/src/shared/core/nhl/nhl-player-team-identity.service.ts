import { createHash, randomUUID } from 'node:crypto';

import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import { db } from '../firebase';
import {
  getCurrentNhlDraftSkaters,
  NHL_DRAFT_CLUBS,
  type NhlDraftSkater,
} from './nhl-api.service';

export const NHL_PLAYER_TEAM_IDENTITY_PATH = 'appData/nhlPlayerTeamIdentity';
export const NHL_PLAYER_TEAM_IDENTITY_SCHEMA_VERSION = 2;

// Current-team identity can change immediately before a game. Keep the shared
// catalog short-lived enough to resolve the transfer before an old-club game
// becomes protected as live, while the Firestore lease still deduplicates the
// 32-club provider refresh across every league worker.
const IDENTITY_FRESH_MILLISECONDS = 5 * 60 * 1000;
const IDENTITY_REFRESH_LEASE_MILLISECONDS = 2 * 60 * 1000;
const IDENTITY_MISSING_COVERAGE_RETRY_MILLISECONDS = 5 * 60 * 1000;
const MAX_PERSISTED_MISSING_COVERAGE_PLAYER_IDS = 128;
const IDENTITY_WAIT_ATTEMPTS = 50;
const IDENTITY_WAIT_MILLISECONDS = 500;
const MINIMUM_CURRENT_SKATER_COUNT = 300;

export interface NhlPlayerTeamIdentitySnapshot {
  generatedAt: string;
  identityHash: string;
  playerCount: number;
  byPlayerId: ReadonlyMap<number, string>;
  /** First retained observation of the player's current uninterrupted club. */
  teamConfirmedAtByPlayerId: ReadonlyMap<number, string>;
}

export interface NhlPlayerTeamIdentityCoverage {
  complete: boolean;
  requiredPlayerCount: number;
  missingPlayerIds: number[];
}

export interface LoadNhlPlayerTeamIdentityOptions {
  /** Stable NHL skater ids whose current-team identity this caller requires. */
  requiredPlayerIds?: Iterable<number>;
  /**
   * Forces evidence generated at or after an NHL ownership boundary such as
   * puck drop. A merely TTL-fresh pregame roster cannot freeze an old club's
   * game after a last-minute trade.
   */
  minimumGeneratedAtMilliseconds?: number;
}

export type LoadNhlPlayerTeamIdentityInput =
  | LoadNhlPlayerTeamIdentityOptions
  | Iterable<number>;

export class NhlPlayerTeamIdentityCoverageError extends Error {
  readonly code = 'nhl-player-team-identity-coverage-incomplete';

  constructor(
    readonly missingPlayerIds: number[],
    readonly identityHash: string,
    readonly generatedAt: string,
  ) {
    const shownIds = missingPlayerIds.slice(0, 20).join(', ');
    const omittedCount = Math.max(0, missingPlayerIds.length - 20);

    super(
      `NHL current-team identity is missing ${missingPlayerIds.length} required ` +
      `rostered skater${missingPlayerIds.length === 1 ? '' : 's'}: ${shownIds}` +
      `${omittedCount > 0 ? ` (+${omittedCount} more)` : ''}. ` +
      'Scoring was left unchanged and will retry.',
    );
    this.name = 'NhlPlayerTeamIdentityCoverageError';
  }
}

interface StoredNhlPlayerTeamIdentityEntry {
  playerId: number;
  teamAbbreviation: string;
  teamConfirmedAt?: string;
}

interface StoredMissingCoverageEvidence {
  schemaVersion: 1;
  identityHash: string;
  generatedAt: string;
  retryAfter: string;
  missingPlayerIds: number[];
  requestMissingPlayerCount: number;
  requestMissingPlayerIdsHash: string;
}

interface RefreshClaim {
  kind: 'ready' | 'coverage-missing' | 'claimed' | 'waiting';
  attemptId: string;
  snapshot: NhlPlayerTeamIdentitySnapshot | null;
}

const supportedTeams = new Set(
  NHL_DRAFT_CLUBS.map((club) => club.abbreviation),
);

let cachedSnapshot: NhlPlayerTeamIdentitySnapshot | null = null;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function timestampMilliseconds(value: unknown): number | null {
  if (value instanceof Timestamp) {
    return value.toMillis();
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const toMillis = (value as Record<string, unknown>)['toMillis'];

  if (typeof toMillis !== 'function') {
    return null;
  }

  const milliseconds = toMillis.call(value);

  return typeof milliseconds === 'number' && Number.isFinite(milliseconds)
    ? milliseconds
    : null;
}

function normalizeTeamAbbreviation(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toUpperCase();
  return supportedTeams.has(normalized) ? normalized : null;
}

export function resolveNhlPlayerTeamConfirmedAt(input: {
  currentTeamAbbreviation: string;
  generatedAt: string;
  previousTeamAbbreviation?: string;
  previousTeamConfirmedAt?: string;
  previousGeneratedAt?: string;
}): string {
  if (!Number.isFinite(Date.parse(input.generatedAt))) {
    throw new Error('NHL current-team identity generatedAt is invalid.');
  }

  const currentTeamAbbreviation = normalizeTeamAbbreviation(
    input.currentTeamAbbreviation,
  );
  const previousTeamAbbreviation = normalizeTeamAbbreviation(
    input.previousTeamAbbreviation,
  );

  if (
    currentTeamAbbreviation &&
    currentTeamAbbreviation === previousTeamAbbreviation
  ) {
    for (const candidate of [
      input.previousTeamConfirmedAt,
      input.previousGeneratedAt,
    ]) {
      if (
        typeof candidate === 'string' &&
        Number.isFinite(Date.parse(candidate))
      ) {
        return candidate;
      }
    }
  }

  return input.generatedAt;
}

function normalizeRequiredPlayerIds(
  values: Iterable<number> | undefined,
): number[] {
  if (!values) {
    return [];
  }

  const playerIds = new Set<number>();

  for (const playerId of values) {
    if (!Number.isSafeInteger(playerId) || playerId <= 0) {
      throw new Error(
        `NHL current-team identity received an invalid required player id: ${String(playerId)}.`,
      );
    }

    playerIds.add(playerId);
  }

  return [...playerIds].sort((first, second) => first - second);
}

function createPlayerIdSetHash(playerIds: readonly number[]): string {
  return createHash('sha256')
    .update(JSON.stringify(playerIds))
    .digest('hex');
}

function normalizeStoredMissingCoverageEvidence(
  value: unknown,
): StoredMissingCoverageEvidence | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const missingPlayerIds = candidate['missingPlayerIds'];

  if (
    candidate['schemaVersion'] !== 1 ||
    typeof candidate['identityHash'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(candidate['identityHash']) ||
    typeof candidate['generatedAt'] !== 'string' ||
    !Number.isFinite(Date.parse(candidate['generatedAt'])) ||
    typeof candidate['retryAfter'] !== 'string' ||
    !Number.isFinite(Date.parse(candidate['retryAfter'])) ||
    !Array.isArray(missingPlayerIds) ||
    missingPlayerIds.length > MAX_PERSISTED_MISSING_COVERAGE_PLAYER_IDS ||
    missingPlayerIds.some(
      (playerId) =>
        !Number.isSafeInteger(playerId) || (playerId as number) <= 0,
    ) ||
    new Set(missingPlayerIds).size !== missingPlayerIds.length ||
    typeof candidate['requestMissingPlayerCount'] !== 'number' ||
    !Number.isSafeInteger(candidate['requestMissingPlayerCount']) ||
    candidate['requestMissingPlayerCount'] <= 0 ||
    typeof candidate['requestMissingPlayerIdsHash'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(candidate['requestMissingPlayerIdsHash'])
  ) {
    return null;
  }

  const normalizedMissingPlayerIds = [...missingPlayerIds as number[]]
    .sort((first, second) => first - second);

  if (
    normalizedMissingPlayerIds.some(
      (playerId, index) => playerId !== missingPlayerIds[index],
    )
  ) {
    return null;
  }

  return {
    schemaVersion: 1,
    identityHash: candidate['identityHash'],
    generatedAt: candidate['generatedAt'],
    retryAfter: candidate['retryAfter'],
    missingPlayerIds: normalizedMissingPlayerIds,
    requestMissingPlayerCount: candidate['requestMissingPlayerCount'],
    requestMissingPlayerIdsHash: candidate['requestMissingPlayerIdsHash'],
  };
}

function missingCoverageEvidenceCovers(input: {
  evidence: StoredMissingCoverageEvidence | null;
  snapshot: NhlPlayerTeamIdentitySnapshot;
  missingPlayerIds: readonly number[];
  nowMilliseconds: number;
  minimumGeneratedAtMilliseconds: number;
}): boolean {
  const evidence = input.evidence;

  if (
    !evidence ||
    evidence.identityHash !== input.snapshot.identityHash ||
    evidence.generatedAt !== input.snapshot.generatedAt ||
    Date.parse(evidence.retryAfter) <= input.nowMilliseconds ||
    Date.parse(evidence.generatedAt) < input.minimumGeneratedAtMilliseconds
  ) {
    return false;
  }

  const exactRequestMatch =
    evidence.requestMissingPlayerCount === input.missingPlayerIds.length &&
    evidence.requestMissingPlayerIdsHash ===
      createPlayerIdSetHash(input.missingPlayerIds);
  const retainedMissingIds = new Set(evidence.missingPlayerIds);

  return exactRequestMatch || input.missingPlayerIds.every(
    (playerId) => retainedMissingIds.has(playerId),
  );
}

function buildMissingCoverageEvidence(input: {
  snapshot: NhlPlayerTeamIdentitySnapshot;
  missingPlayerIds: readonly number[];
  previous?: StoredMissingCoverageEvidence | null;
  nowMilliseconds?: number;
}): StoredMissingCoverageEvidence {
  const missingPlayerIds = normalizeRequiredPlayerIds(input.missingPlayerIds);
  const retainedMissingPlayerIds = normalizeRequiredPlayerIds([
    ...(input.previous?.missingPlayerIds ?? []),
    ...missingPlayerIds,
  ])
    .filter((playerId) => !input.snapshot.byPlayerId.has(playerId))
    .slice(0, MAX_PERSISTED_MISSING_COVERAGE_PLAYER_IDS);
  const nowMilliseconds = input.nowMilliseconds ?? Date.now();

  return {
    schemaVersion: 1,
    identityHash: input.snapshot.identityHash,
    generatedAt: input.snapshot.generatedAt,
    retryAfter: new Date(
      nowMilliseconds + IDENTITY_MISSING_COVERAGE_RETRY_MILLISECONDS,
    ).toISOString(),
    missingPlayerIds: retainedMissingPlayerIds,
    requestMissingPlayerCount: missingPlayerIds.length,
    requestMissingPlayerIdsHash: createPlayerIdSetHash(missingPlayerIds),
  };
}

function requiredPlayerIdsFromLoadInput(
  input: LoadNhlPlayerTeamIdentityInput,
): Iterable<number> | undefined {
  if (
    Symbol.iterator in Object(input) &&
    typeof (input as Iterable<number>)[Symbol.iterator] === 'function'
  ) {
    return input as Iterable<number>;
  }

  return (input as LoadNhlPlayerTeamIdentityOptions).requiredPlayerIds;
}

export function inspectNhlPlayerTeamIdentityCoverage(
  snapshot: NhlPlayerTeamIdentitySnapshot,
  requiredPlayerIds: Iterable<number> = [],
): NhlPlayerTeamIdentityCoverage {
  const required = normalizeRequiredPlayerIds(requiredPlayerIds);
  const missingPlayerIds = required.filter(
    (playerId) => !snapshot.byPlayerId.has(playerId),
  );

  return {
    complete: missingPlayerIds.length === 0,
    requiredPlayerCount: required.length,
    missingPlayerIds,
  };
}

export function requireNhlPlayerTeamIdentityCoverage(
  snapshot: NhlPlayerTeamIdentitySnapshot,
  requiredPlayerIds: Iterable<number> = [],
): NhlPlayerTeamIdentitySnapshot {
  const coverage = inspectNhlPlayerTeamIdentityCoverage(
    snapshot,
    requiredPlayerIds,
  );

  if (!coverage.complete) {
    throw new NhlPlayerTeamIdentityCoverageError(
      coverage.missingPlayerIds,
      snapshot.identityHash,
      snapshot.generatedAt,
    );
  }

  return snapshot;
}

function normalizeStoredSnapshot(
  data: Record<string, unknown> | undefined,
  options: { allowRefreshing?: boolean } = {},
): NhlPlayerTeamIdentitySnapshot | null {
  if (
    !data ||
    data['schemaVersion'] !== NHL_PLAYER_TEAM_IDENTITY_SCHEMA_VERSION ||
    (
      data['status'] !== 'ready' &&
      !(options.allowRefreshing && data['status'] === 'refreshing')
    ) ||
    typeof data['generatedAt'] !== 'string' ||
    !Number.isFinite(Date.parse(data['generatedAt'])) ||
    typeof data['identityHash'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(data['identityHash']) ||
    !Array.isArray(data['players'])
  ) {
    return null;
  }

  const byPlayerId = new Map<number, string>();
  const teamConfirmedAtByPlayerId = new Map<number, string>();

  for (const entry of data['players']) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return null;
    }

    const candidate = entry as Record<string, unknown>;
    const playerId = candidate['playerId'];
    const teamAbbreviation = normalizeTeamAbbreviation(
      candidate['teamAbbreviation'],
    );

    if (
      !Number.isSafeInteger(playerId) ||
      (playerId as number) <= 0 ||
      !teamAbbreviation ||
      byPlayerId.has(playerId as number)
    ) {
      return null;
    }

    byPlayerId.set(playerId as number, teamAbbreviation);
    const teamConfirmedAt = typeof candidate['teamConfirmedAt'] === 'string' &&
      Number.isFinite(Date.parse(candidate['teamConfirmedAt']))
      ? candidate['teamConfirmedAt']
      : data['generatedAt'];
    teamConfirmedAtByPlayerId.set(playerId as number, teamConfirmedAt);
  }

  if (byPlayerId.size < MINIMUM_CURRENT_SKATER_COUNT) {
    return null;
  }

  return {
    generatedAt: data['generatedAt'],
    identityHash: data['identityHash'],
    playerCount: byPlayerId.size,
    byPlayerId,
    teamConfirmedAtByPlayerId,
  };
}

function snapshotIsFresh(
  snapshot: NhlPlayerTeamIdentitySnapshot | null,
  nowMilliseconds: number,
  minimumGeneratedAtMilliseconds = Number.NEGATIVE_INFINITY,
): snapshot is NhlPlayerTeamIdentitySnapshot {
  return Boolean(
    snapshot &&
    Date.parse(snapshot.generatedAt) >= minimumGeneratedAtMilliseconds &&
    nowMilliseconds - Date.parse(snapshot.generatedAt) <
      IDENTITY_FRESH_MILLISECONDS,
  );
}

function buildStoredEntries(
  skaters: NhlDraftSkater[],
): StoredNhlPlayerTeamIdentityEntry[] {
  const byPlayerId = new Map<number, string>();

  for (const skater of skaters) {
    const teamAbbreviation = normalizeTeamAbbreviation(
      skater.nhlTeamAbbreviation,
    );

    if (
      !Number.isSafeInteger(skater.id) ||
      skater.id <= 0 ||
      !teamAbbreviation
    ) {
      continue;
    }

    const existing = byPlayerId.get(skater.id);

    if (existing && existing !== teamAbbreviation) {
      throw new Error(
        `NHL current rosters assigned player ${skater.id} to both ${existing} and ${teamAbbreviation}.`,
      );
    }

    byPlayerId.set(skater.id, teamAbbreviation);
  }

  if (byPlayerId.size < MINIMUM_CURRENT_SKATER_COUNT) {
    throw new Error(
      `NHL current-team identity was incomplete (${byPlayerId.size} skaters).`,
    );
  }

  return [...byPlayerId.entries()]
    .sort(([first], [second]) => first - second)
    .map(([playerId, teamAbbreviation]) => ({
      playerId,
      teamAbbreviation,
    }));
}

function createIdentityHash(
  players: StoredNhlPlayerTeamIdentityEntry[],
): string {
  return createHash('sha256')
    .update(JSON.stringify(players.map(({ playerId, teamAbbreviation }) => ({
      playerId,
      teamAbbreviation,
    }))))
    .digest('hex');
}

async function readStoredSnapshot(): Promise<NhlPlayerTeamIdentitySnapshot | null> {
  const snapshot = await db.doc(NHL_PLAYER_TEAM_IDENTITY_PATH).get();
  return normalizeStoredSnapshot(
    snapshot.exists
      ? snapshot.data() as Record<string, unknown>
      : undefined,
  );
}

async function claimRefresh(
  nowMilliseconds: number,
  requiredPlayerIds: readonly number[],
  minimumGeneratedAtMilliseconds: number,
): Promise<RefreshClaim> {
  const attemptId = randomUUID();
  const reference = db.doc(NHL_PLAYER_TEAM_IDENTITY_PATH);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const data = snapshot.exists
      ? snapshot.data() as Record<string, unknown>
      : undefined;
    const current = normalizeStoredSnapshot(data);
    const currentCoverage = current
      ? inspectNhlPlayerTeamIdentityCoverage(current, requiredPlayerIds)
      : null;

    if (
      snapshotIsFresh(
        current,
        nowMilliseconds,
        minimumGeneratedAtMilliseconds,
      ) && currentCoverage?.complete
    ) {
      return {
        kind: 'ready' as const,
        attemptId: '',
        snapshot: current,
      };
    }

    if (
      current &&
      currentCoverage &&
      !currentCoverage.complete &&
      snapshotIsFresh(
        current,
        nowMilliseconds,
        minimumGeneratedAtMilliseconds,
      ) &&
      missingCoverageEvidenceCovers({
        evidence: normalizeStoredMissingCoverageEvidence(
          data?.['missingCoverage'],
        ),
        snapshot: current,
        missingPlayerIds: currentCoverage.missingPlayerIds,
        nowMilliseconds,
        minimumGeneratedAtMilliseconds,
      })
    ) {
      return {
        kind: 'coverage-missing' as const,
        attemptId: '',
        snapshot: current,
      };
    }

    const leaseExpiresAt = timestampMilliseconds(data?.['leaseExpiresAt']);

    if (leaseExpiresAt !== null && leaseExpiresAt > nowMilliseconds) {
      return {
        kind: 'waiting' as const,
        attemptId: '',
        snapshot: current,
      };
    }

    transaction.set(
      reference,
      {
        schemaVersion: NHL_PLAYER_TEAM_IDENTITY_SCHEMA_VERSION,
        status: 'refreshing',
        refreshAttemptId: attemptId,
        refreshStartedAt: FieldValue.serverTimestamp(),
        leaseExpiresAt: Timestamp.fromMillis(
          nowMilliseconds + IDENTITY_REFRESH_LEASE_MILLISECONDS,
        ),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return {
      kind: 'claimed' as const,
      attemptId,
      snapshot: current,
    };
  });
}

async function completeRefresh(
  attemptId: string,
  requiredPlayerIds: readonly number[],
): Promise<NhlPlayerTeamIdentitySnapshot> {
  // The provider catalog is read over several seconds. Its safe evidence
  // boundary is when that read began, not when the final club response
  // arrived; otherwise a refresh spanning puck drop could masquerade as a
  // wholly post-puck-drop observation.
  const generatedAt = new Date().toISOString();
  const providerPlayers = buildStoredEntries(
    await getCurrentNhlDraftSkaters(true),
  );
  const reference = db.doc(NHL_PLAYER_TEAM_IDENTITY_PATH);
  let publishedPlayers: StoredNhlPlayerTeamIdentityEntry[] = [];
  let identityHash = '';
  let publishedSnapshot: NhlPlayerTeamIdentitySnapshot | null = null;

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const data = snapshot.data() ?? {};
    const previous = normalizeStoredSnapshot(
      snapshot.exists
        ? data as Record<string, unknown>
        : undefined,
      { allowRefreshing: true },
    );

    if (data['refreshAttemptId'] !== attemptId) {
      throw new Error(
        'NHL current-team identity refresh lost its server lease before publication.',
      );
    }

    publishedPlayers = providerPlayers.map((player) => ({
      ...player,
      teamConfirmedAt: resolveNhlPlayerTeamConfirmedAt({
        currentTeamAbbreviation: player.teamAbbreviation,
        generatedAt,
        previousTeamAbbreviation: previous?.byPlayerId.get(player.playerId),
        previousTeamConfirmedAt:
          previous?.teamConfirmedAtByPlayerId.get(player.playerId),
        previousGeneratedAt: previous?.generatedAt,
      }),
    }));
    identityHash = createIdentityHash(publishedPlayers);
    publishedSnapshot = {
      generatedAt,
      identityHash,
      playerCount: publishedPlayers.length,
      byPlayerId: new Map(
        publishedPlayers.map((entry) => [
          entry.playerId,
          entry.teamAbbreviation,
        ] as const),
      ),
      teamConfirmedAtByPlayerId: new Map(
        publishedPlayers.map((entry) => [
          entry.playerId,
          entry.teamConfirmedAt ?? generatedAt,
        ] as const),
      ),
    };
    const missingPlayerIds = inspectNhlPlayerTeamIdentityCoverage(
      publishedSnapshot,
      requiredPlayerIds,
    ).missingPlayerIds;
    const previousMissingCoverage = normalizeStoredMissingCoverageEvidence(
      data['missingCoverage'],
    );
    const missingCoverage = missingPlayerIds.length > 0
      ? buildMissingCoverageEvidence({
          snapshot: publishedSnapshot,
          missingPlayerIds,
          previous: previousMissingCoverage,
        })
      : null;

    transaction.set(
      reference,
      {
        schemaVersion: NHL_PLAYER_TEAM_IDENTITY_SCHEMA_VERSION,
        status: 'ready',
        source: 'server:nhl-current-rosters',
        generatedAt,
        identityHash,
        playerCount: publishedPlayers.length,
        players: publishedPlayers,
        missingCoverage,
        refreshAttemptId: attemptId,
        refreshCompletedAt: FieldValue.serverTimestamp(),
        leaseExpiresAt: null,
        lastError: '',
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });

  if (!publishedSnapshot) {
    throw new Error(
      'NHL current-team identity refresh completed without a published snapshot.',
    );
  }

  return publishedSnapshot;
}

async function recordMissingCoverageEvidence(
  snapshot: NhlPlayerTeamIdentitySnapshot,
  requiredPlayerIds: readonly number[],
): Promise<void> {
  const missingPlayerIds = inspectNhlPlayerTeamIdentityCoverage(
    snapshot,
    requiredPlayerIds,
  ).missingPlayerIds;

  if (missingPlayerIds.length === 0) {
    return;
  }

  const reference = db.doc(NHL_PLAYER_TEAM_IDENTITY_PATH);

  await db.runTransaction(async (transaction) => {
    const saved = await transaction.get(reference);
    const data = saved.exists
      ? saved.data() as Record<string, unknown>
      : undefined;
    const current = normalizeStoredSnapshot(data);

    if (
      !current ||
      current.identityHash !== snapshot.identityHash ||
      current.generatedAt !== snapshot.generatedAt
    ) {
      return;
    }

    transaction.set(
      reference,
      {
        missingCoverage: buildMissingCoverageEvidence({
          snapshot: current,
          missingPlayerIds,
          previous: normalizeStoredMissingCoverageEvidence(
            data?.['missingCoverage'],
          ),
        }),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
}

async function recordRefreshFailure(
  attemptId: string,
  error: unknown,
): Promise<void> {
  const reference = db.doc(NHL_PLAYER_TEAM_IDENTITY_PATH);
  const message = error instanceof Error
    ? error.message.slice(0, 500)
    : 'Unknown NHL current-team identity refresh error.';

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const data = snapshot.data() ?? {};

    if (data['refreshAttemptId'] !== attemptId) {
      return;
    }

    transaction.set(
      reference,
      {
        status: 'error',
        leaseExpiresAt: null,
        lastError: message,
        lastErrorAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
}

async function waitForClaimedRefresh(
  minimumGeneratedAtMilliseconds: number,
): Promise<NhlPlayerTeamIdentitySnapshot> {
  for (let attempt = 0; attempt < IDENTITY_WAIT_ATTEMPTS; attempt += 1) {
    await wait(IDENTITY_WAIT_MILLISECONDS);
    const snapshot = await readStoredSnapshot();

    if (
      snapshotIsFresh(
        snapshot,
        Date.now(),
        minimumGeneratedAtMilliseconds,
      )
    ) {
      return snapshot;
    }
  }

  throw new Error(
    'NHL current-team identity is refreshing. Scoring was left unchanged and will retry.',
  );
}

/**
 * Loads one shared, server-owned player-to-team map for a complete league
 * scoring run. A stale or incomplete catalog blocks the new scoring pass
 * instead of allowing an old-team nonappearance to settle as zero.
 */
export async function loadCurrentNhlPlayerTeamIdentity(
  input: LoadNhlPlayerTeamIdentityInput = {},
): Promise<NhlPlayerTeamIdentitySnapshot> {
  const requiredPlayerIds = normalizeRequiredPlayerIds(
    requiredPlayerIdsFromLoadInput(input),
  );
  const nowMilliseconds = Date.now();
  const minimumGeneratedAtMilliseconds =
    Symbol.iterator in Object(input) &&
    typeof (input as Iterable<number>)[Symbol.iterator] === 'function'
      ? Number.NEGATIVE_INFINITY
      : Number.isFinite(
          (input as LoadNhlPlayerTeamIdentityOptions)
            .minimumGeneratedAtMilliseconds,
        )
        ? Math.floor(
            (input as LoadNhlPlayerTeamIdentityOptions)
              .minimumGeneratedAtMilliseconds!,
          )
        : Number.NEGATIVE_INFINITY;

  if (
    snapshotIsFresh(
      cachedSnapshot,
      nowMilliseconds,
      minimumGeneratedAtMilliseconds,
    ) &&
    inspectNhlPlayerTeamIdentityCoverage(
      cachedSnapshot,
      requiredPlayerIds,
    ).complete
  ) {
    return cachedSnapshot;
  }

  const stored = await readStoredSnapshot();

  if (
    snapshotIsFresh(
      stored,
      nowMilliseconds,
      minimumGeneratedAtMilliseconds,
    ) &&
    inspectNhlPlayerTeamIdentityCoverage(
      stored,
      requiredPlayerIds,
    ).complete
  ) {
    cachedSnapshot = stored;
    return stored;
  }

  // A fresh aggregate catalog can still omit the exact player this scoring
  // run owns. Such a miss bypasses the normal freshness shortcut once, forcing
  // a new provider read before the run either receives exact coverage or fails.
  const claim = await claimRefresh(
    nowMilliseconds,
    requiredPlayerIds,
    minimumGeneratedAtMilliseconds,
  );

  if (claim.kind === 'ready' && claim.snapshot) {
    cachedSnapshot = claim.snapshot;
    return requireNhlPlayerTeamIdentityCoverage(
      claim.snapshot,
      requiredPlayerIds,
    );
  }

  if (claim.kind === 'coverage-missing' && claim.snapshot) {
    cachedSnapshot = claim.snapshot;
    return requireNhlPlayerTeamIdentityCoverage(
      claim.snapshot,
      requiredPlayerIds,
    );
  }

  if (claim.kind === 'waiting') {
    const refreshed = await waitForClaimedRefresh(
      minimumGeneratedAtMilliseconds,
    );
    cachedSnapshot = refreshed;
    await recordMissingCoverageEvidence(
      refreshed,
      requiredPlayerIds,
    );
    return requireNhlPlayerTeamIdentityCoverage(
      refreshed,
      requiredPlayerIds,
    );
  }

  let refreshed: NhlPlayerTeamIdentitySnapshot;

  try {
    refreshed = await completeRefresh(
      claim.attemptId,
      requiredPlayerIds,
    );
  } catch (error: unknown) {
    await recordRefreshFailure(claim.attemptId, error).catch(() => undefined);
    throw error;
  }

  cachedSnapshot = refreshed;
  return requireNhlPlayerTeamIdentityCoverage(
    refreshed,
    requiredPlayerIds,
  );
}
