import { NHLPlayer } from '../player/player.models';

export type DraftStatus =
  | 'setup'
  | 'scheduled'
  | 'live'
  | 'complete';

export type DraftPosition = 'LW' | 'C' | 'RW' | 'D' | 'G';

export type DraftClockStatus =
  | 'stopped'
  | 'running'
  | 'paused'
  | 'complete';

export type DraftSelectionType =
  | 'manual'
  | 'queue'
  | 'automatic';

export type DraftAutoPickReason =
  | 'timer-expired'
  | 'manager-auto-mode';

export interface DraftRosterRequirements {
  LW: number;
  C: number;
  RW: number;
  D: number;
  G: number;
}

export interface DraftProjection {
  projectedSeasonPoints?: number | null;
  projectedCyclePoints?: number | null;

  /**
   * 0-100 estimate of how trustworthy the projection is.
   * Higher = safer / more repeatable.
   */
  reliabilityRating?: number | null;

  /**
   * Estimated cycle-point deduction caused by volatility/risk.
   * This does not change real scoring; it only improves draft/projection value.
   */
  volatilityPenalty?: number | null;

  /**
   * Projected cycle points after applying reliability/risk.
   * This is used for safer draft value ranking.
   */
  floorAdjustedCyclePoints?: number | null;

  /**
   * Optional value above replacement after reliability/risk is applied.
   * Most screens calculate this dynamically because replacement depends on league size.
   */
  floorAdjustedDraftValue?: number | null;
}

export interface DraftableSkaterAsset extends DraftProjection {
  assetType: 'skater';
  assetKey: string;
  position: 'LW' | 'C' | 'RW' | 'D';
  player: NHLPlayer;
}

export interface DraftableGoalieUnitAsset extends DraftProjection {
  assetType: 'team-goalie-unit';
  assetKey: string;
  position: 'G';
  teamName: string;
  teamAbbreviation: string;
  teamLogoUrl?: string;
}

export type DraftableAsset =
  | DraftableSkaterAsset
  | DraftableGoalieUnitAsset;

export interface FantasyDraft {
  schemaVersion: number;
  status: DraftStatus;
  format: 'snake';
  totalRounds: number;
  rosterRequirements: DraftRosterRequirements;
  roundOneOrder: string[];

  nextOverallPick: number;
  draftedAssetKeys: string[];

  scheduledStartAt: unknown | null;

  /**
   * Draft clock configuration and shared state.
   * pickStartedAt is written with a Firestore server timestamp.
   */
  pickSeconds: number;
  clockStatus: DraftClockStatus;
  pickStartedAt: unknown | null;
  currentPickSeconds: number;
  pausedRemainingSeconds: number | null;
  clockUpdatedBy?: string | null;
  clockUpdatedAt?: unknown;
  lastPickId?: string | null;

  createdAt?: unknown;
  updatedAt?: unknown;
  startedAt?: unknown;
}

export interface DraftPickPreview {
  overallPick: number;
  round: number;
  pickInRound: number;
  ownerId: string;
}

export interface DraftPick extends DraftPickPreview {
  asset: DraftableAsset;
  selectionType?: DraftSelectionType;
  selectedByUserId?: string;
  autoPickReason?: DraftAutoPickReason | null;
  madeAt?: unknown;
}

export interface DraftQueue {
  ownerId: string;
  assetKeys: string[];
  autoDraftEnabled: boolean;
  updatedAt?: unknown;
}
