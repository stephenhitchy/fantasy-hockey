import { httpsCallable } from 'firebase/functions';

import { functions } from '../firebase-functions';

export const PLAYER_WATCHLIST_MAX_COUNT = 100;
export const PLAYER_WATCHLIST_MAX_ASSET_KEY_BYTES = 160;

export interface PlayerWatchlistResult {
  assetKeys: string[];
  maximumCount: number;
  changed: boolean;
}

export interface SetPlayerWatchlistEntryInput {
  assetKey: string;
  watched: boolean;
}

function callableMessage(error: unknown, fallback: string): string {
  const candidate = error !== null && typeof error === 'object'
    ? error as { message?: unknown }
    : null;

  return typeof candidate?.message === 'string' && candidate.message.trim()
    ? candidate.message.trim().replace(/^Firebase:\s*/i, '')
    : fallback;
}

export function normalizePlayerWatchlistAssetKey(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  const byteLength = new TextEncoder().encode(normalized).length;

  return normalized.length >= 2 &&
      byteLength <= PLAYER_WATCHLIST_MAX_ASSET_KEY_BYTES &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)
    ? normalized
    : null;
}

function normalizeResult(value: unknown): PlayerWatchlistResult {
  const source = value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  const assetKeys = Array.isArray(source['assetKeys'])
    ? source['assetKeys']
      .map(normalizePlayerWatchlistAssetKey)
      .filter((assetKey): assetKey is string => Boolean(assetKey))
      .slice(0, PLAYER_WATCHLIST_MAX_COUNT)
    : [];

  return {
    assetKeys: Array.from(new Set(assetKeys)),
    maximumCount: Number.isInteger(source['maximumCount'])
      ? Math.max(1, Math.min(PLAYER_WATCHLIST_MAX_COUNT, Number(source['maximumCount'])))
      : PLAYER_WATCHLIST_MAX_COUNT,
    changed: source['changed'] === true,
  };
}

const getPlayerWatchlistCallable = httpsCallable<
  Record<string, never>,
  PlayerWatchlistResult
>(functions, 'getPlayerWatchlist', { timeout: 25_000 });

const setPlayerWatchlistEntryCallable = httpsCallable<
  SetPlayerWatchlistEntryInput,
  PlayerWatchlistResult
>(functions, 'setPlayerWatchlistEntry', { timeout: 25_000 });

export async function getPlayerWatchlist(): Promise<PlayerWatchlistResult> {
  try {
    const response = await getPlayerWatchlistCallable({});
    return normalizeResult(response.data);
  } catch (error) {
    throw new Error(callableMessage(error, 'Unable to load your watchlist right now.'));
  }
}

export async function setPlayerWatchlistEntry(
  input: SetPlayerWatchlistEntryInput,
): Promise<PlayerWatchlistResult> {
  const assetKey = normalizePlayerWatchlistAssetKey(input.assetKey);

  if (!assetKey || typeof input.watched !== 'boolean') {
    throw new Error('Choose a valid player to update.');
  }

  try {
    const response = await setPlayerWatchlistEntryCallable({
      assetKey,
      watched: input.watched,
    });
    return normalizeResult(response.data);
  } catch (error) {
    throw new Error(callableMessage(error, 'Unable to update your watchlist right now.'));
  }
}
