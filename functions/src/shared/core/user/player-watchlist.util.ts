export const PLAYER_WATCHLIST_SCHEMA_VERSION = 1;
export const PLAYER_WATCHLIST_MAX_COUNT = 100;
export const PLAYER_WATCHLIST_MAX_ASSET_KEY_BYTES = 160;

export interface PlayerWatchlistUpdate {
  assetKeys: string[];
  changed: boolean;
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

export function normalizePlayerWatchlist(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    const assetKey = normalizePlayerWatchlistAssetKey(item);
    if (!assetKey || seen.has(assetKey)) {
      continue;
    }

    seen.add(assetKey);
    normalized.push(assetKey);

    if (normalized.length >= PLAYER_WATCHLIST_MAX_COUNT) {
      break;
    }
  }

  return normalized;
}

export function updatePlayerWatchlist(
  currentValue: unknown,
  assetKeyValue: unknown,
  watched: unknown,
): PlayerWatchlistUpdate | null {
  const assetKey = normalizePlayerWatchlistAssetKey(assetKeyValue);
  if (!assetKey || typeof watched !== 'boolean') {
    return null;
  }

  const current = normalizePlayerWatchlist(currentValue);
  const alreadyWatched = current.includes(assetKey);

  if (alreadyWatched === watched) {
    return { assetKeys: current, changed: false };
  }

  if (watched) {
    if (current.length >= PLAYER_WATCHLIST_MAX_COUNT) {
      return null;
    }

    return {
      assetKeys: [assetKey, ...current],
      changed: true,
    };
  }

  return {
    assetKeys: current.filter((item) => item !== assetKey),
    changed: true,
  };
}
