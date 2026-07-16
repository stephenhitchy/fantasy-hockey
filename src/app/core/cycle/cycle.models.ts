import { DraftPosition, DraftableAsset } from '../draft/draft.models';

export type FantasyCycleStatus =
  | 'active'
  | 'complete';

export type FantasyMatchupStatus =
  | 'active'
  | 'complete';

export type ProjectionAccuracyStatus =
  | 'pending'
  | 'complete';

export type FantasySeasonPhase =
  | 'regular_season'
  | 'playoffs';

export type FantasyPlayoffBracketType =
  | 'championship'
  | 'consolation';

export type AssetCycleWindowStatus =
  | 'scheduled'
  | 'active'
  | 'complete';

/**
 * One immutable six-game assignment for one persistent fantasy roster slot.
 * The same league can have windows from several cycle numbers active at once.
 */
export interface FantasyAssetCycleWindow {
  id: string;
  ownerId: string;
  rosterSlotId: string;
  cycleNumber: number;
  position: DraftPosition;
  assetKey: string;
  asset: DraftableAsset;
  status: AssetCycleWindowStatus;
  scheduledGameIds: number[];
  scheduledGameDates: string[];
  scheduledGameLabels: string[];
  completedGameIds: number[];
  appearanceGameIds: number[];
  scheduledGames: number;
  gamesPlayed: number;
  actualGamesPlayed: number;
  gamesLeft: number;
  fantasyPoints: number;
  frozenProjectionPoints: number | null;
  frozenProjectionVersion: number | null;
  firstScheduledGameDate: string | null;
  lastScheduledGameDate: string | null;
  startedAt?: unknown | null;
  completedAt?: unknown | null;
  createdAt?: unknown;
  updatedAt?: unknown;
}

/**
 * Stored as one Firestore document per fantasy team per cycle so the app can
 * load 14 slot windows with one document read rather than one read per asset.
 */
export interface FantasyTeamCycleWindows {
  id: string;
  ownerId: string;
  cycleNumber: number;
  expectedRosterSlotIds: string[];
  windows: FantasyAssetCycleWindow[];
  completedWindowCount: number;
  totalWindowCount: number;
  status: AssetCycleWindowStatus;
  createdAt?: unknown;
  updatedAt?: unknown;
  completedAt?: unknown | null;
}

export interface FantasyCycle {
  id: string;
  cycleNumber: number;
  status: FantasyCycleStatus;
  phase: FantasySeasonPhase;
  playoffRoundNumber?: number | null;
  playoffRoundCount?: number | null;
  playoffRoundLabel?: string | null;
  matchupIds: string[];

  /** Independent-window architecture metadata. */
  windowSchemaVersion?: number;
  expectedRosterSlotIdsByOwner?: Record<string, string[]>;
  parentCycleNumber?: number | null;
  overlapsPreviousCycle?: boolean;
  bankedPlayoffWindowsEnabled?: boolean;
  totalExpectedWindowCount?: number;
  activeWindowCount?: number;
  completedWindowCount?: number;

  /** Matchup aggregation and idempotent standings metadata. */
  matchupCompletionSchemaVersion?: number;
  totalMatchupCount?: number;
  completedMatchupCount?: number;
  pendingMatchupCount?: number;
  lastMatchupCompletedAt?: unknown | null;
  standingsAppliedAt?: unknown | null;

  projectionAccuracyStatus?: ProjectionAccuracyStatus;
  projectionAccuracyAssetCount?: number;
  projectionAccuracyProjectionVersions?: number[];
  projectionAccuracyUpdatedAt?: unknown | null;
  startedAt?: unknown;
  completedAt?: unknown | null;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface FantasyMatchup {
  id: string;
  cycleNumber: number;
  phase: FantasySeasonPhase;
  bracketType?: FantasyPlayoffBracketType | null;
  playoffRoundNumber?: number | null;
  playoffMatchupId?: string | null;
  teamASeed?: number | null;
  teamBSeed?: number | null;
  teamAWindowNumber?: number | null;
  teamBWindowNumber?: number | null;
  teamAWindowCycleNumber?: number | null;
  teamBWindowCycleNumber?: number | null;
  winnerPlace?: number | null;
  loserPlace?: number | null;
  tieBrokenByHigherSeed?: boolean;
  teamAOwnerId: string;
  teamBOwnerId: string | null;
  teamAScore: number;
  teamBScore: number;
  winnerOwnerId: string | null;
  status: FantasyMatchupStatus;
  completedAt?: unknown | null;
  createdAt?: unknown;
  updatedAt?: unknown;
}
