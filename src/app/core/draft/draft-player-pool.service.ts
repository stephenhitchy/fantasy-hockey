import {
  getCurrentNhlDraftSkaters,
  NHL_DRAFT_CLUBS
} from '../nhl/nhl-api.service';

import {
  DraftableAsset
} from './draft.models';

let cachedPlayerPool: DraftableAsset[] | null = null;

export async function loadDraftPlayerPool(): Promise<DraftableAsset[]> {
  if (cachedPlayerPool) {
    return cachedPlayerPool;
  }

  const skaters = await getCurrentNhlDraftSkaters();

  const skaterAssets: DraftableAsset[] = skaters.map(
    (skater) => ({
      assetType: 'skater',
      assetKey: `skater-${skater.id}`,
      position: skater.position,
      player: {
        id: skater.id,
        fullName: skater.fullName,
        position: skater.position,
        nhlTeamAbbreviation: skater.nhlTeamAbbreviation,
        teamLogoUrl: skater.teamLogoUrl,
        headshotUrl: skater.headshotUrl
      }
    })
  );

  const goalieUnitAssets: DraftableAsset[] =
    NHL_DRAFT_CLUBS.map((club) => ({
      assetType: 'team-goalie-unit',
      assetKey: `goalie-unit-${club.abbreviation}`,
      position: 'G',
      teamName: club.name,
      teamAbbreviation: club.abbreviation,
      teamLogoUrl: `https://assets.nhle.com/logos/nhl/svg/${club.abbreviation}_light.svg`
    }));

  cachedPlayerPool = [
    ...skaterAssets,
    ...goalieUnitAssets
  ].sort((first, second) => {
    const firstName =
      first.assetType === 'skater'
        ? first.player.fullName
        : first.teamName;

    const secondName =
      second.assetType === 'skater'
        ? second.player.fullName
        : second.teamName;

    return firstName.localeCompare(secondName);
  });

  return cachedPlayerPool;
}