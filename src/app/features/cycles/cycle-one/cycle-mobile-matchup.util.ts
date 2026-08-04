import type { FantasyMatchup } from '../../../core/cycle/cycle.models';
import type {
  CycleWindowGameMarker,
  MatchupViewMode,
  MobileMatchupPlayerPair,
  MobileMatchupPositionGroup,
  MobileMatchupSection,
} from './cycle-one.models';

export type MobileMatchupPerspective = 'my-team' | 'head-to-head' | 'opponent';

export interface MobileGameMarkerExplanation {
  heading: string;
  detail: string;
  pointsLabel: string;
}

export function resolveMobileMatchupView(
  perspective: MobileMatchupPerspective,
  viewerId: string,
  matchup: Pick<FantasyMatchup, 'teamAOwnerId' | 'teamBOwnerId'>,
): MatchupViewMode {
  if (perspective === 'head-to-head') {
    return 'both';
  }

  const viewerIsTeamB = matchup.teamBOwnerId === viewerId;

  if (perspective === 'my-team') {
    return viewerIsTeamB ? 'teamB' : 'teamA';
  }

  return viewerIsTeamB ? 'teamA' : 'teamB';
}

export function getMobileMatchupPerspective(
  view: MatchupViewMode,
  viewerId: string,
  matchup: Pick<FantasyMatchup, 'teamAOwnerId' | 'teamBOwnerId'>,
): MobileMatchupPerspective {
  if (view === 'both') {
    return 'head-to-head';
  }

  const viewerView = matchup.teamBOwnerId === viewerId ? 'teamB' : 'teamA';
  return view === viewerView ? 'my-team' : 'opponent';
}

export function getOwnerIdForMobileView(
  view: MatchupViewMode,
  matchup: Pick<FantasyMatchup, 'teamAOwnerId' | 'teamBOwnerId'>,
): string | null {
  if (view === 'teamA') {
    return matchup.teamAOwnerId;
  }

  if (view === 'teamB') {
    return matchup.teamBOwnerId;
  }

  return null;
}

export function groupMobileMatchupPositions(
  groups: MobileMatchupPositionGroup[],
): MobileMatchupSection[] {
  const sectionDefinitions: Array<{
    key: MobileMatchupSection['key'];
    label: string;
    shortLabel: string;
    positions: MobileMatchupSection['positions'];
  }> = [
    {
      key: 'forwards',
      label: 'Forwards',
      shortLabel: 'LW · C · RW',
      positions: ['LW', 'C', 'RW'],
    },
    {
      key: 'defense',
      label: 'Defense',
      shortLabel: 'D',
      positions: ['D'],
    },
    {
      key: 'goalie',
      label: 'Goalie Unit',
      shortLabel: 'G',
      positions: ['G'],
    },
  ];

  return sectionDefinitions
    .map((definition) => {
      const rows: MobileMatchupPlayerPair[] = groups
        .filter((group) => definition.positions.includes(group.position))
        .flatMap((group) => group.rows);

      return {
        ...definition,
        rows,
      };
    })
    .filter((section) => section.rows.length > 0);
}

export function getMobileGameMarkerExplanation(
  marker: CycleWindowGameMarker,
  score: number | null,
  runtimeState: 'scheduled' | 'live' | 'final' | null,
): MobileGameMarkerExplanation {
  const pointsLabel = typeof score === 'number' ? `${score.toFixed(1)} pts` : '—';
  const dateText = marker.gameDate
    ? new Date(`${marker.gameDate}T12:00:00`).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      })
    : 'date pending';

  if (marker.status === 'played') {
    return {
      heading: `Game ${marker.index} counted — player appeared`,
      detail: `${marker.gameLabel} on ${dateText}. The player appeared, so the fantasy points from this NHL game count in this six-game window.`,
      pointsLabel,
    };
  }

  if (marker.status === 'missed') {
    return {
      heading: `Game ${marker.index} counted — no appearance`,
      detail: `${marker.gameLabel} on ${dateText}. The NHL team played, so this still uses one of the roster slot's six scheduled team games even though the player did not appear.`,
      pointsLabel: '0.0 pts',
    };
  }

  if (marker.status === 'upcoming' && runtimeState === 'live') {
    return {
      heading: `Game ${marker.index} is live`,
      detail: `${marker.gameLabel} is in progress. Fantasy points may change until the NHL game becomes final.`,
      pointsLabel,
    };
  }

  if (marker.status === 'upcoming') {
    return {
      heading: `Game ${marker.index} is scheduled`,
      detail: `${marker.gameLabel} is scheduled for ${dateText}. It will use one of the six roster-slot games when the NHL team plays.`,
      pointsLabel: 'Upcoming',
    };
  }

  return {
    heading: `Game ${marker.index} is not scheduled yet`,
    detail: 'This roster slot has not received a complete six-game schedule yet. RinkRat will fill this marker when the slot reaches its correct asynchronous window boundary.',
    pointsLabel: 'Pending',
  };
}
