export type OfflineMatchupMarkerStatus =
  | 'played'
  | 'missed'
  | 'live'
  | 'upcoming'
  | 'unavailable';

export interface OfflineMatchupMarkerSnapshot {
  index: number;
  status: OfflineMatchupMarkerStatus;
  label: string;
}

export interface OfflineMatchupPlayerSnapshot {
  playerName: string;
  teamLabel: string;
  position: 'LW' | 'C' | 'RW' | 'D' | 'G';
  currentPoints: number;
  projectedPoints: number | null;
  availabilityLabel: string | null;
  markers: OfflineMatchupMarkerSnapshot[];
}

export interface OfflineMatchupPositionRowSnapshot {
  slotLabel: string;
  teamAPlayer: OfflineMatchupPlayerSnapshot | null;
  teamBPlayer: OfflineMatchupPlayerSnapshot | null;
}

export interface OfflineMatchupPositionGroupSnapshot {
  position: 'LW' | 'C' | 'RW' | 'D' | 'G';
  label: string;
  rows: OfflineMatchupPositionRowSnapshot[];
}

export interface OfflineMatchupTeamSnapshot {
  teamName: string;
  record: string;
  currentScore: number;
  projectedScore: number | null;
  gamesPlayed: number;
  gamesTotal: number;
  resultLabel: string | null;
  viewerTeam: boolean;
}

export interface RinkRatOfflineMatchupSnapshot {
  schemaVersion: 1;
  accountId: string;
  leagueId: string;
  leagueName: string;
  cycleNumber: number;
  cycleLabel: string;
  matchupId: string;
  matchupLabel: string;
  matchupStatus: 'active' | 'complete';
  readinessLabel: string;
  finishLabel: string;
  savedAt: string;
  sourceReleaseLabel: string;
  sourceScoringVersion: number;
  sourceProjectionVersion: number;
  teamA: OfflineMatchupTeamSnapshot;
  teamB: OfflineMatchupTeamSnapshot | null;
  positionGroups: OfflineMatchupPositionGroupSnapshot[];
}

export interface OfflineMatchupSnapshotContext {
  accountId: string;
  leagueId: string;
  cycleNumber: number;
  matchupId?: string | null;
}
