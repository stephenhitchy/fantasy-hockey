export interface LeagueIdentityMemberFields {
  profileIconId?: string | null;
  username?: string | null;
}

export interface LeagueIdentityTeamFields {
  managerName?: string | null;
  profileIconId?: string | null;
}

export interface LeagueIdentityRepair {
  member: Partial<LeagueIdentityMemberFields> | null;
  team: Partial<LeagueIdentityTeamFields> | null;
}

export function buildLeagueIdentityRepair(input: {
  member: LeagueIdentityMemberFields | null;
  team: LeagueIdentityTeamFields | null;
  profileIconId: string;
  username?: string | null;
}): LeagueIdentityRepair {
  const normalizedUsername = input.username?.trim() || null;
  const member: Partial<LeagueIdentityMemberFields> = {};
  const team: Partial<LeagueIdentityTeamFields> = {};

  if (input.member?.profileIconId !== input.profileIconId) {
    member.profileIconId = input.profileIconId;
  }

  if (input.team?.profileIconId !== input.profileIconId) {
    team.profileIconId = input.profileIconId;
  }

  if (normalizedUsername && input.member?.username !== normalizedUsername) {
    member.username = normalizedUsername;
  }

  if (normalizedUsername && input.team?.managerName !== normalizedUsername) {
    team.managerName = normalizedUsername;
  }

  return {
    member: Object.keys(member).length > 0 ? member : null,
    team: Object.keys(team).length > 0 ? team : null,
  };
}
