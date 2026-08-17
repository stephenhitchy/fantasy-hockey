export const TEAM_IDENTITY_UNLOCK_ORDER = [
  'first-line-change',
  'commissioner-mode',
  'league-explorer',
  'crowded-schedule',
  'identity-architect',
] as const;

export type TeamIdentityUnlock = typeof TEAM_IDENTITY_UNLOCK_ORDER[number];

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeTeamIdentityUnlocks(value: unknown): TeamIdentityUnlock[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const saved = new Set(value.map(asString).filter(Boolean));
  return TEAM_IDENTITY_UNLOCK_ORDER.filter((unlock) => saved.has(unlock));
}

export function calculateTeamIdentityChallengeUnlocks(input: {
  existingUnlocks: unknown;
  leagueCount: number;
  commissionerLeagueCount: number;
  opponentCount: number;
}): TeamIdentityUnlock[] {
  const merged = new Set<TeamIdentityUnlock>(
    normalizeTeamIdentityUnlocks(input.existingUnlocks),
  );

  if (input.leagueCount >= 1) {
    merged.add('first-line-change');
  }
  if (input.commissionerLeagueCount >= 1) {
    merged.add('commissioner-mode');
  }
  if (input.leagueCount >= 3) {
    merged.add('league-explorer');
  }
  if (input.opponentCount >= 10) {
    merged.add('crowded-schedule');
  }

  const foundationalUnlocks: TeamIdentityUnlock[] = [
    'first-line-change',
    'commissioner-mode',
    'league-explorer',
    'crowded-schedule',
  ];

  if (foundationalUnlocks.every((unlock) => merged.has(unlock))) {
    merged.add('identity-architect');
  }

  return TEAM_IDENTITY_UNLOCK_ORDER.filter((unlock) => merged.has(unlock));
}
