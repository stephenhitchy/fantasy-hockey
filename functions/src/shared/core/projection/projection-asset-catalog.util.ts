import { createHash } from 'node:crypto';

import type { DraftableAsset } from '../draft/draft.models';

export type CanonicalProjectionAsset =
  | {
      assetType: 'skater';
      assetKey: string;
      playerId: number;
      fullName: string;
      position: 'LW' | 'C' | 'RW' | 'D';
      teamAbbreviation: string;
      teamLogoUrl: string;
      headshotUrl: string;
      birthDate: string;
    }
  | {
      assetType: 'team-goalie-unit';
      assetKey: string;
      position: 'G';
      teamAbbreviation: string;
      teamName: string;
      teamLogoUrl: string;
    };

export interface CanonicalProjectionAssetCatalog {
  catalogId: string;
  schemaVersion: number;
  season: string;
  contentHash: string;
  generatedAt: string;
  assetCount: number;
  skaterCount: number;
  goalieUnitCount: number;
  assets: CanonicalProjectionAsset[];
  assetsByKey: ReadonlyMap<string, CanonicalProjectionAsset>;
  cacheHit: boolean;
}

export interface ProjectionCatalogValidationResult {
  catalogId: string;
  catalogHash: string;
  catalogSeason: string;
  validatedAssetCount: number;
  catalogCacheHit: boolean;
}

export function stableProjectionCatalogJson(
  assets: CanonicalProjectionAsset[],
): string {
  return JSON.stringify(
    [...assets].sort((first, second) => first.assetKey.localeCompare(second.assetKey)),
  );
}

export function createProjectionCatalogHash(
  assets: CanonicalProjectionAsset[],
): string {
  return createHash('sha256')
    .update(stableProjectionCatalogJson(assets))
    .digest('hex');
}

function assertSkaterIdentity(
  asset: DraftableAsset,
  canonical: CanonicalProjectionAsset,
): void {
  if (asset.assetType !== 'skater' || canonical.assetType !== 'skater') {
    throw new Error(`Projection asset ${asset.assetKey} does not match its canonical asset type.`);
  }

  if (
    asset.player.id !== canonical.playerId ||
    asset.player.fullName !== canonical.fullName ||
    asset.position !== canonical.position ||
    asset.player.position !== canonical.position ||
    asset.player.nhlTeamAbbreviation !== canonical.teamAbbreviation
  ) {
    throw new Error(`Projection asset ${asset.assetKey} does not match the server NHL catalog.`);
  }
}

function assertGoalieUnitIdentity(
  asset: DraftableAsset,
  canonical: CanonicalProjectionAsset,
): void {
  if (
    asset.assetType !== 'team-goalie-unit' ||
    canonical.assetType !== 'team-goalie-unit'
  ) {
    throw new Error(`Projection asset ${asset.assetKey} does not match its canonical asset type.`);
  }

  if (
    asset.position !== 'G' ||
    asset.teamAbbreviation !== canonical.teamAbbreviation ||
    asset.teamName !== canonical.teamName
  ) {
    throw new Error(`Projection goalie unit ${asset.assetKey} does not match the server NHL catalog.`);
  }
}

/**
 * Rejects fake, duplicated, missing, or position-modified projection assets.
 * Projection values remain Projection V11's responsibility; this helper only
 * validates the canonical NHL identity and eligible position of every asset.
 */
export function validateProjectionAssetsAgainstCatalog(
  assets: DraftableAsset[],
  catalog: CanonicalProjectionAssetCatalog,
): ProjectionCatalogValidationResult {
  const seen = new Set<string>();

  for (const asset of assets) {
    if (seen.has(asset.assetKey)) {
      throw new Error(`Projection output contains duplicate asset ${asset.assetKey}.`);
    }

    seen.add(asset.assetKey);
    const canonical = catalog.assetsByKey.get(asset.assetKey);

    if (!canonical) {
      throw new Error(`Projection output contains unknown asset ${asset.assetKey}.`);
    }

    if (canonical.assetType === 'skater') {
      assertSkaterIdentity(asset, canonical);
    } else {
      assertGoalieUnitIdentity(asset, canonical);
    }
  }

  if (seen.size !== catalog.assetCount) {
    const missing = catalog.assets
      .filter((asset) => !seen.has(asset.assetKey))
      .slice(0, 5)
      .map((asset) => asset.assetKey);

    throw new Error(
      `Projection output is missing ${catalog.assetCount - seen.size} canonical asset(s)` +
        (missing.length > 0 ? `: ${missing.join(', ')}` : '.'),
    );
  }

  return {
    catalogId: catalog.catalogId,
    catalogHash: catalog.contentHash,
    catalogSeason: catalog.season,
    validatedAssetCount: seen.size,
    catalogCacheHit: catalog.cacheHit,
  };
}
