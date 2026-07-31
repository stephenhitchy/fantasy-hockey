import type { FantasyMatchup } from '../../core/cycle/cycle.models';
import type { DraftStatus } from '../../core/draft/draft.models';

export type MobileLeaguePrimaryKind = 'league' | 'draft' | 'matchup';

export interface MobileLeaguePrimaryDestination {
  kind: MobileLeaguePrimaryKind;
  label: 'League' | 'Draft' | 'Matchup';
  iconClass: 'icon-league' | 'icon-draft' | 'icon-matchup';
  route: Array<string | number>;
}

interface ResolveMobileLeaguePrimaryDestinationInput {
  leagueId: string;
  draftStatus: DraftStatus | null;
  matchup: FantasyMatchup | null;
}

const NON_LEAGUE_ROUTE_SEGMENTS = new Set(['create', 'join']);

export function extractLeagueIdFromUrl(url: string): string {
  const match = url.match(/\/leagues\/([^/?#]+)/);
  const encodedLeagueId = match?.[1] ?? '';

  if (!encodedLeagueId) {
    return '';
  }

  let leagueId = encodedLeagueId;

  try {
    leagueId = decodeURIComponent(encodedLeagueId);
  } catch {
    // Keep the original route segment when a malformed escape sequence is present.
  }

  return NON_LEAGUE_ROUTE_SEGMENTS.has(leagueId.toLowerCase()) ? '' : leagueId;
}

export function resolveMobileLeaguePrimaryDestination({
  leagueId,
  draftStatus,
  matchup,
}: ResolveMobileLeaguePrimaryDestinationInput): MobileLeaguePrimaryDestination {
  if (draftStatus === 'scheduled' || draftStatus === 'live') {
    return {
      kind: 'draft',
      label: 'Draft',
      iconClass: 'icon-draft',
      route: ['/leagues', leagueId, 'draft'],
    };
  }

  if (draftStatus === 'complete' && matchup) {
    return {
      kind: 'matchup',
      label: 'Matchup',
      iconClass: 'icon-matchup',
      route: [
        '/leagues',
        leagueId,
        'cycles',
        matchup.cycleNumber,
        'matchups',
        matchup.id,
      ],
    };
  }

  return {
    kind: 'league',
    label: 'League',
    iconClass: 'icon-league',
    route: ['/leagues', leagueId],
  };
}
