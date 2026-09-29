export interface SkaterPortraitAsset {
  assetType: 'skater';
  player: {
    id: number;
    fullName: string;
    nhlTeamAbbreviation: string;
    headshotUrl?: string;
    teamLogoUrl?: string;
  };
}

export interface GoalieUnitPortraitAsset {
  assetType: 'team-goalie-unit';
  teamName: string;
  teamAbbreviation: string;
  teamLogoUrl?: string;
}

export type AssetPortraitSource = SkaterPortraitAsset | GoalieUnitPortraitAsset;
export type AssetPortraitKind =
  'headshot' | 'team-logo' | 'player-placeholder' | 'team-placeholder';

export interface AssetPortraitViewModel {
  primaryImageUrl: string | null;
  primaryKind: AssetPortraitKind;
  primaryAlt: string;
  teamBadgeUrl: string | null;
  fallbackLabel: string;
  playerId: number | null;
}

function availableUrl(
  value: string | null | undefined,
  failedImageUrls: ReadonlySet<string>,
): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized && !failedImageUrls.has(normalized) ? normalized : null;
}

/**
 * Resolves roster and add/drop imagery from the NHL-backed asset record.
 *
 * A skater headshot belongs to a stable NHL player id. If that exact image is
 * absent or fails, the UI deliberately returns a neutral silhouette instead
 * of promoting a team logo into the player-photo position. Team-goalie units
 * continue to use the NHL team logo because the asset represents the unit.
 */
export function resolveAssetPortrait(
  asset: AssetPortraitSource,
  failedImageUrls: ReadonlySet<string> = new Set<string>(),
): AssetPortraitViewModel {
  if (asset.assetType === 'skater') {
    const headshotUrl = availableUrl(asset.player.headshotUrl, failedImageUrls);
    const teamBadgeUrl = availableUrl(asset.player.teamLogoUrl, failedImageUrls);

    return {
      primaryImageUrl: headshotUrl,
      primaryKind: headshotUrl ? 'headshot' : 'player-placeholder',
      primaryAlt: headshotUrl ? `${asset.player.fullName} headshot` : '',
      teamBadgeUrl,
      fallbackLabel: 'Player image unavailable',
      playerId: asset.player.id,
    };
  }

  const teamLogoUrl = availableUrl(asset.teamLogoUrl, failedImageUrls);

  return {
    primaryImageUrl: teamLogoUrl,
    primaryKind: teamLogoUrl ? 'team-logo' : 'team-placeholder',
    primaryAlt: teamLogoUrl ? `${asset.teamName} goalie unit logo` : '',
    teamBadgeUrl: null,
    fallbackLabel: asset.teamAbbreviation,
    playerId: null,
  };
}
