import { FieldValue } from 'firebase-admin/firestore';

import { db } from '../firebase';
import {
  getCurrentNhlDraftSkaters,
  NHL_DRAFT_CLUBS,
  NhlDraftSkater,
} from '../nhl/nhl-api.service';

import {
  CanonicalProjectionAsset,
  CanonicalProjectionAssetCatalog,
  createProjectionCatalogHash,
} from './projection-asset-catalog.util';

export const PROJECTION_ASSET_CATALOG_SCHEMA_VERSION = 1;

const CATALOG_POINTER_PATH = 'appData/projectionAssetCatalog';
const CATALOG_COLLECTION = 'projectionAssetCatalogs';
const CATALOG_CHUNK_SIZE = 25;
const CATALOG_CACHE_MILLISECONDS = 6 * 60 * 60 * 1000;

export type {
  CanonicalProjectionAsset,
  CanonicalProjectionAssetCatalog,
  ProjectionCatalogValidationResult,
} from './projection-asset-catalog.util';
export { validateProjectionAssetsAgainstCatalog } from './projection-asset-catalog.util';

let cachedCatalog: CanonicalProjectionAssetCatalog | null = null;
let catalogRequestInFlight: Promise<CanonicalProjectionAssetCatalog> | null = null;
const catalogByIdCache = new Map<string, CanonicalProjectionAssetCatalog>();

function currentRosterSeason(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const startYear = now.getUTCMonth() + 1 >= 7 ? year : year - 1;
  return `${startYear}${startYear + 1}`;
}

function buildCanonicalSkater(skater: NhlDraftSkater): CanonicalProjectionAsset {
  return {
    assetType: 'skater',
    assetKey: `skater-${skater.id}`,
    playerId: skater.id,
    fullName: skater.fullName,
    position: skater.position,
    teamAbbreviation: skater.nhlTeamAbbreviation,
    teamLogoUrl: skater.teamLogoUrl,
    headshotUrl: skater.headshotUrl ?? '',
    birthDate: skater.birthDate ?? '',
  };
}

function buildCanonicalAssets(skaters: NhlDraftSkater[]): CanonicalProjectionAsset[] {
  const assets: CanonicalProjectionAsset[] = skaters.map(buildCanonicalSkater);

  for (const club of NHL_DRAFT_CLUBS) {
    assets.push({
      assetType: 'team-goalie-unit',
      assetKey: `goalie-unit-${club.abbreviation}`,
      position: 'G',
      teamAbbreviation: club.abbreviation,
      teamName: club.name,
      teamLogoUrl: `https://assets.nhle.com/logos/nhl/svg/${club.abbreviation}_light.svg`,
    });
  }

  const seen = new Set<string>();

  for (const asset of assets) {
    if (seen.has(asset.assetKey)) {
      throw new Error(`The canonical NHL asset catalog contains duplicate key ${asset.assetKey}.`);
    }

    seen.add(asset.assetKey);
  }

  return assets.sort((first, second) => first.assetKey.localeCompare(second.assetKey));
}

function createCatalog(
  assets: CanonicalProjectionAsset[],
  cacheHit: boolean,
): CanonicalProjectionAssetCatalog {
  const season = currentRosterSeason();
  const contentHash = createProjectionCatalogHash(assets);
  const catalogId = `catalog-v${PROJECTION_ASSET_CATALOG_SCHEMA_VERSION}-${season}-${contentHash.slice(0, 20)}`;
  const generatedAt = new Date().toISOString();
  const assetsByKey = new Map(assets.map((asset) => [asset.assetKey, asset] as const));
  const skaterCount = assets.filter((asset) => asset.assetType === 'skater').length;
  const goalieUnitCount = assets.length - skaterCount;

  return {
    catalogId,
    schemaVersion: PROJECTION_ASSET_CATALOG_SCHEMA_VERSION,
    season,
    contentHash,
    generatedAt,
    assetCount: assets.length,
    skaterCount,
    goalieUnitCount,
    assets,
    assetsByKey,
    cacheHit,
  };
}

async function persistCatalog(catalog: CanonicalProjectionAssetCatalog): Promise<void> {
  const catalogRef = db.doc(`${CATALOG_COLLECTION}/${catalog.catalogId}`);
  const existing = await catalogRef.get();

  if (!existing.exists) {
    const chunks: CanonicalProjectionAsset[][] = [];

    for (let index = 0; index < catalog.assets.length; index += CATALOG_CHUNK_SIZE) {
      chunks.push(catalog.assets.slice(index, index + CATALOG_CHUNK_SIZE));
    }

    for (let index = 0; index < chunks.length; index += 400) {
      const batch = db.batch();
      const writeGroup = chunks.slice(index, index + 400);

      writeGroup.forEach((assets, offset) => {
        const chunkIndex = index + offset;
        const chunkId = `chunk-${String(chunkIndex + 1).padStart(4, '0')}`;

        batch.set(
          catalogRef.collection('assets').doc(chunkId),
          {
            schemaVersion: PROJECTION_ASSET_CATALOG_SCHEMA_VERSION,
            chunkIndex,
            assetCount: assets.length,
            catalogId: catalog.catalogId,
            assets,
          },
        );
      });

      await batch.commit();
    }

    await catalogRef.set({
      schemaVersion: PROJECTION_ASSET_CATALOG_SCHEMA_VERSION,
      catalogId: catalog.catalogId,
      season: catalog.season,
      contentHash: catalog.contentHash,
      status: 'ready',
      assetCount: catalog.assetCount,
      skaterCount: catalog.skaterCount,
      goalieUnitCount: catalog.goalieUnitCount,
      assetDocumentCount: chunks.length,
      generatedAt: catalog.generatedAt,
      generatedAtServer: FieldValue.serverTimestamp(),
      source: 'server:nhl-current-rosters',
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  await db.doc(CATALOG_POINTER_PATH).set(
    {
      schemaVersion: PROJECTION_ASSET_CATALOG_SCHEMA_VERSION,
      activeCatalogId: catalog.catalogId,
      season: catalog.season,
      contentHash: catalog.contentHash,
      assetCount: catalog.assetCount,
      skaterCount: catalog.skaterCount,
      goalieUnitCount: catalog.goalieUnitCount,
      status: 'ready',
      source: 'server:nhl-current-rosters',
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}



/**
 * Loads the exact immutable server catalog used by an existing projection
 * snapshot. The content hash is recalculated before the catalog is trusted,
 * so a legacy S2A snapshot can be sealed without silently switching to a
 * newer NHL roster catalog.
 */
export async function loadCanonicalProjectionAssetCatalog(
  catalogId: string,
): Promise<CanonicalProjectionAssetCatalog | null> {
  const normalizedCatalogId = catalogId.trim();

  if (!normalizedCatalogId) {
    return null;
  }

  const cached = catalogByIdCache.get(normalizedCatalogId);

  if (cached) {
    return { ...cached, cacheHit: true };
  }

  const catalogRef = db.doc(`${CATALOG_COLLECTION}/${normalizedCatalogId}`);
  const [metadataSnapshot, assetSnapshot] = await Promise.all([
    catalogRef.get(),
    catalogRef.collection('assets').orderBy('chunkIndex', 'asc').get(),
  ]);

  if (!metadataSnapshot.exists) {
    return null;
  }

  const metadata = metadataSnapshot.data() ?? {};
  const assets = assetSnapshot.docs.flatMap((document) => {
    const data = document.data() as { assets?: unknown };
    return Array.isArray(data.assets)
      ? data.assets as CanonicalProjectionAsset[]
      : [];
  });
  const contentHash = createProjectionCatalogHash(assets);
  const expectedCount = typeof metadata['assetCount'] === 'number'
    ? metadata['assetCount']
    : 0;
  const expectedHash = typeof metadata['contentHash'] === 'string'
    ? metadata['contentHash']
    : '';

  if (
    metadata['status'] !== 'ready' ||
    metadata['catalogId'] !== normalizedCatalogId ||
    metadata['schemaVersion'] !== PROJECTION_ASSET_CATALOG_SCHEMA_VERSION ||
    expectedCount <= 0 ||
    assets.length !== expectedCount ||
    contentHash !== expectedHash
  ) {
    throw new Error(`Canonical projection asset catalog ${normalizedCatalogId} failed integrity verification.`);
  }

  const skaterCount = assets.filter((asset) => asset.assetType === 'skater').length;
  const catalog: CanonicalProjectionAssetCatalog = {
    catalogId: normalizedCatalogId,
    schemaVersion: PROJECTION_ASSET_CATALOG_SCHEMA_VERSION,
    season: typeof metadata['season'] === 'string' ? metadata['season'] : '',
    contentHash,
    generatedAt: typeof metadata['generatedAt'] === 'string'
      ? metadata['generatedAt']
      : new Date(0).toISOString(),
    assetCount: assets.length,
    skaterCount,
    goalieUnitCount: assets.length - skaterCount,
    assets,
    assetsByKey: new Map(assets.map((asset) => [asset.assetKey, asset] as const)),
    cacheHit: false,
  };

  catalogByIdCache.set(normalizedCatalogId, catalog);
  return catalog;
}

/**
 * Creates or reuses the server-owned NHL identity catalog used to validate
 * every Projection V11 asset before it can become a shared league snapshot.
 */
export async function ensureCanonicalProjectionAssetCatalog(): Promise<CanonicalProjectionAssetCatalog> {
  if (
    cachedCatalog &&
    Date.now() - Date.parse(cachedCatalog.generatedAt) < CATALOG_CACHE_MILLISECONDS
  ) {
    return {
      ...cachedCatalog,
      cacheHit: true,
    };
  }

  if (catalogRequestInFlight) {
    return catalogRequestInFlight;
  }

  catalogRequestInFlight = getCurrentNhlDraftSkaters()
    .then(async (skaters) => {
      const next = createCatalog(buildCanonicalAssets(skaters), false);
      await persistCatalog(next);
      cachedCatalog = next;
      catalogByIdCache.set(next.catalogId, next);
      return next;
    })
    .finally(() => {
      catalogRequestInFlight = null;
    });

  return catalogRequestInFlight;
}
