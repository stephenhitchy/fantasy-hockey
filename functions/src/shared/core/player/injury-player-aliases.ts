import type { InjuryPlayerAlias } from './injury-match-quality.util';

/**
 * Verified ESPN-to-NHL identity aliases.
 *
 * Keep this list intentionally small and source controlled. Add an entry only
 * after the Injury Match Quality panel shows that ESPN's public player name
 * cannot be matched safely to the current NHL roster identity. The playerId
 * must be the canonical NHL player ID already present in RinkRat's roster
 * catalog. Team-specific aliases take precedence over generic aliases.
 */
export const ESPN_INJURY_PLAYER_ALIASES = [
  // Example shape (do not add an unverified placeholder):
  // {
  //   sourceName: 'Verified ESPN Name',
  //   sourceTeamAbbreviation: 'NHL',
  //   playerId: 1234567,
  //   note: 'Verified against the current NHL roster feed.',
  // },
] as const satisfies readonly InjuryPlayerAlias[];
