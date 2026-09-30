import { createHash, randomUUID } from 'node:crypto';

import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import { db } from '../firebase';
import {
  getCurrentNhlDraftSkaters,
  NHL_DRAFT_CLUBS,
  type NhlDraftSkater,
} from './nhl-api.service';

export const NHL_PLAYER_TEAM_IDENTITY_PATH = 'appData/nhlPlayerTeamIdentity';
export const NHL_PLAYER_TEAM_IDENTITY_SCHEMA_VERSION = 1;

const IDENTITY_FRESH_MILLISECONDS = 30 * 60 * 1000;
const IDENTITY_REFRESH_LEASE_MILLISECONDS = 2 * 60 * 1000;
const IDENTITY_WAIT_ATTEMPTS = 50;
const IDENTITY_WAIT_MILLISECONDS = 500;
const MINIMUM_CURRENT_SKATER_COUNT = 300;

export interface NhlPlayerTeamIdentitySnapshot {
  generatedAt: string;
  identityHash: string;
  playerCount: number;
  byPlayerId: ReadonlyMap<number, string>;
}

interface StoredNhlPlayerTeamIdentityEntry {
  playerId: number;
  teamAbbreviation: string;
}

interface RefreshClaim {
  kind: 'ready' | 'claimed' | 'waiting';
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

function normalizeStoredSnapshot(
  data: Record<string, unknown> | undefined,
): NhlPlayerTeamIdentitySnapshot | null {
  if (
    !data ||
    data['schemaVersion'] !== NHL_PLAYER_TEAM_IDENTITY_SCHEMA_VERSION ||
    data['status'] !== 'ready' ||
    typeof data['generatedAt'] !== 'string' ||
    !Number.isFinite(Date.parse(data['generatedAt'])) ||
    typeof data['identityHash'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(data['identityHash']) ||
    !Array.isArray(data['players'])
  ) {
    return null;
  }

  const byPlayerId = new Map<number, string>();

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
  }

  if (byPlayerId.size < MINIMUM_CURRENT_SKATER_COUNT) {
    return null;
  }

  return {
    generatedAt: data['generatedAt'],
    identityHash: data['identityHash'],
    playerCount: byPlayerId.size,
    byPlayerId,
  };
}

function snapshotIsFresh(
  snapshot: NhlPlayerTeamIdentitySnapshot | null,
  nowMilliseconds: number,
): snapshot is NhlPlayerTeamIdentitySnapshot {
  return Boolean(
    snapshot &&
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
    .update(JSON.stringify(players))
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
): Promise<RefreshClaim> {
  const attemptId = randomUUID();
  const reference = db.doc(NHL_PLAYER_TEAM_IDENTITY_PATH);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const data = snapshot.exists
      ? snapshot.data() as Record<string, unknown>
      : undefined;
    const current = normalizeStoredSnapshot(data);

    if (snapshotIsFresh(current, nowMilliseconds)) {
      return {
        kind: 'ready' as const,
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

async function completeRefresh(attemptId: string): Promise<NhlPlayerTeamIdentitySnapshot> {
  const players = buildStoredEntries(
    await getCurrentNhlDraftSkaters(true),
  );
  const generatedAt = new Date().toISOString();
  const identityHash = createIdentityHash(players);
  const reference = db.doc(NHL_PLAYER_TEAM_IDENTITY_PATH);

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const data = snapshot.data() ?? {};

    if (data['refreshAttemptId'] !== attemptId) {
      throw new Error(
        'NHL current-team identity refresh lost its server lease before publication.',
      );
    }

    transaction.set(
      reference,
      {
        schemaVersion: NHL_PLAYER_TEAM_IDENTITY_SCHEMA_VERSION,
        status: 'ready',
        source: 'server:nhl-current-rosters',
        generatedAt,
        identityHash,
        playerCount: players.length,
        players,
        refreshAttemptId: attemptId,
        refreshCompletedAt: FieldValue.serverTimestamp(),
        leaseExpiresAt: null,
        lastError: '',
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });

  const byPlayerId = new Map(
    players.map((entry) => [entry.playerId, entry.teamAbbreviation] as const),
  );

  return {
    generatedAt,
    identityHash,
    playerCount: players.length,
    byPlayerId,
  };
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

async function waitForClaimedRefresh(): Promise<NhlPlayerTeamIdentitySnapshot> {
  for (let attempt = 0; attempt < IDENTITY_WAIT_ATTEMPTS; attempt += 1) {
    await wait(IDENTITY_WAIT_MILLISECONDS);
    const snapshot = await readStoredSnapshot();

    if (snapshotIsFresh(snapshot, Date.now())) {
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
export async function loadCurrentNhlPlayerTeamIdentity(): Promise<NhlPlayerTeamIdentitySnapshot> {
  const nowMilliseconds = Date.now();

  if (snapshotIsFresh(cachedSnapshot, nowMilliseconds)) {
    return cachedSnapshot;
  }

  const stored = await readStoredSnapshot();

  if (snapshotIsFresh(stored, nowMilliseconds)) {
    cachedSnapshot = stored;
    return stored;
  }

  const claim = await claimRefresh(nowMilliseconds);

  if (claim.kind === 'ready' && claim.snapshot) {
    cachedSnapshot = claim.snapshot;
    return claim.snapshot;
  }

  if (claim.kind === 'waiting') {
    const refreshed = await waitForClaimedRefresh();
    cachedSnapshot = refreshed;
    return refreshed;
  }

  try {
    const refreshed = await completeRefresh(claim.attemptId);
    cachedSnapshot = refreshed;
    return refreshed;
  } catch (error: unknown) {
    await recordRefreshFailure(claim.attemptId, error).catch(() => undefined);
    throw error;
  }
}
