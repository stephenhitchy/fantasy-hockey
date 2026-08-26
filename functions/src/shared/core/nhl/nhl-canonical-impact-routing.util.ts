export interface CanonicalLeagueImpactIndexEntry {
  leagueId: string;
  playerIds: readonly number[];
  teamAbbreviations: readonly string[];
}

export function selectAffectedCanonicalLeagueIds(input: {
  affectedPlayerIds: readonly number[];
  affectedTeamAbbreviations: readonly string[];
  exactCanaryLeagueIds: readonly string[];
  impacts: readonly CanonicalLeagueImpactIndexEntry[];
  impactIndexComplete: boolean;
}): string[] {
  if (!input.impactIndexComplete) {
    return [...new Set(input.exactCanaryLeagueIds)].sort();
  }

  const playerIds = new Set(
    input.affectedPlayerIds
      .filter((playerId) => Number.isFinite(playerId) && playerId > 0)
      .map((playerId) => Math.trunc(playerId)),
  );
  const teams = new Set(
    input.affectedTeamAbbreviations
      .map((team) => team.trim().toUpperCase())
      .filter(Boolean),
  );

  return [...new Set(
    input.impacts
      .filter((impact) =>
        impact.teamAbbreviations.some((team) =>
          teams.has(team.trim().toUpperCase())
        ) ||
        impact.playerIds.some((playerId) => playerIds.has(Math.trunc(playerId)))
      )
      .map((impact) => impact.leagueId),
  )].sort();
}
