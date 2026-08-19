export type DashboardLeagueActivityStage =
  | 'forming'
  | 'draft-setup'
  | 'draft-scheduled'
  | 'draft-live'
  | 'season-preparing'
  | 'matchup-active'
  | 'matchup-complete'
  | 'cycle-complete';

export type DashboardLeagueActivityTone = 'neutral' | 'info' | 'warning' | 'success';

export interface DashboardLeagueMatchupSummary {
  cycleNumber: number;
  opponentTeamName: string;
  myScore: number;
  opponentScore: number;
  scoreStatusLabel: string;
  gamesPlayed: number;
  totalGames: number;
  gamesRemaining: number;
  progressPercent: number;
}


export type DashboardRecentWaiverOutcomeStatus =
  | 'awarded'
  | 'not-awarded'
  | 'cleared';

export interface DashboardRecentWaiverOutcome {
  waiverId: string;
  status: DashboardRecentWaiverOutcomeStatus;
  assetName: string;
  effectiveLabel: string | null;
  occurredAt: Date | string | null;
}

export interface DashboardLeagueActivity {
  stage: DashboardLeagueActivityStage;
  statusLabel: string;
  tone: DashboardLeagueActivityTone;
  headline: string;
  detail: string;
  primaryActionLabel: string;
  primaryActionRoute: Array<string | number>;
  injuredStarterCount: number;
  queuedMoveCount: number;
  boundarySlotCount: number;
  recentWaiverOutcome: DashboardRecentWaiverOutcome | null;
  matchup: DashboardLeagueMatchupSummary | null;
}
