import type { DraftableAsset } from '../../../core/draft/draft.models';

export type DraftAssetPortraitKind = 'headshot' | 'team-logo' | 'fallback';

export interface DraftAssetPortrait {
  primaryImageUrl: string | null;
  primaryKind: DraftAssetPortraitKind;
  teamBadgeUrl: string | null;
  fallbackLabel: string;
}

export interface DraftAssetPortraitOptions {
  currentTeamLogoUrl?: string | null;
  currentTeamLabel?: string | null;
  failedImageUrls?: ReadonlySet<string>;
}

function getAvailableUrl(
  value: string | null | undefined,
  failedImageUrls: ReadonlySet<string>,
): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';

  return normalized && !failedImageUrls.has(normalized) ? normalized : null;
}

/**
 * Resolves presentation-only Draft imagery without fetching or mutating player data.
 * Skaters prefer a headshot with a current-team badge. Goalie units and failed
 * headshots retain the existing team-logo identity treatment.
 */
export function resolveDraftAssetPortrait(
  asset: DraftableAsset,
  options: DraftAssetPortraitOptions = {},
): DraftAssetPortrait {
  const failedImageUrls = options.failedImageUrls ?? new Set<string>();
  const defaultTeamLogoUrl =
    asset.assetType === 'skater' ? asset.player.teamLogoUrl : asset.teamLogoUrl;
  const teamLogoUrl = getAvailableUrl(
    options.currentTeamLogoUrl ?? defaultTeamLogoUrl,
    failedImageUrls,
  );
  const defaultTeamLabel =
    asset.assetType === 'skater' ? asset.player.nhlTeamAbbreviation : asset.teamAbbreviation;
  const fallbackLabel = options.currentTeamLabel?.trim() || defaultTeamLabel;

  if (asset.assetType === 'skater') {
    const headshotUrl = getAvailableUrl(asset.player.headshotUrl, failedImageUrls);

    if (headshotUrl) {
      return {
        primaryImageUrl: headshotUrl,
        primaryKind: 'headshot',
        teamBadgeUrl: teamLogoUrl,
        fallbackLabel,
      };
    }
  }

  if (teamLogoUrl) {
    return {
      primaryImageUrl: teamLogoUrl,
      primaryKind: 'team-logo',
      teamBadgeUrl: null,
      fallbackLabel,
    };
  }

  return {
    primaryImageUrl: null,
    primaryKind: 'fallback',
    teamBadgeUrl: null,
    fallbackLabel,
  };
}
