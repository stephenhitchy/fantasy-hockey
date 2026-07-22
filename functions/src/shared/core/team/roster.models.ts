import { NHLPlayer } from '../player/player.models';

export type ActiveRosterPosition = 'LW' | 'C' | 'RW' | 'D' | 'G';

export interface RosterCycleScore {
  cycleNumber: number;
  gamesCounted: number;
  fantasyPoints: number;
}

export type RosterStatus = 'active' | 'injured' | 'benched' | 'new' | 'moved';

export interface BaseRosterAsset {
  /**
   * Stored going forward so roster moves can match assets without guessing.
   * Older rosters may not have this, so service helpers still fall back to
   * skater-{player.id} or goalie-unit-{teamAbbreviation}.
   */
  assetKey?: string;
  rosterStatus?: RosterStatus;

  projectedSeasonPoints?: number | null;
  projectedCyclePoints?: number | null;
  frozenCycleProjectionPoints?: number | null;
  frozenProjectionCycleNumber?: number | null;
  frozenProjectionSource?: 'shared-snapshot' | 'roster' | 'draft-pick' | 'legacy' | null;
  frozenProjectionVersion?: number | null;
  frozenProjectionSnapshotId?: string | null;
  frozenProjectionGeneratedAt?: string | null;
  frozenProjectionFrozenAt?: string | null;
  seasonBaselineCyclePoints?: number | null;
  recentFormAdjustment?: number | null;
  roleAdjustment?: number | null;
  scheduleStrengthAdjustment?: number | null;
  scheduleStrengthMultiplier?: number | null;
  scheduleDifficultyRating?: number | null;
  scheduleDifficultyLabel?: string | null;
  scheduleDataConfidence?: number | null;
  projectionHomeGames?: number | null;
  projectionRoadGames?: number | null;
  projectionBackToBackGames?: number | null;
  projectionRestAdvantageGames?: number | null;
  projectionOpponentAbbreviations?: string[] | null;
  projectionDataSeason?: string | null;
  projectionDataSource?: string | null;
  projectionGamesPlayed?: number | null;
  recentFormSampleSize?: number | null;
  seasonFantasyPointsPerGame?: number | null;
  recentThreeGameFantasyPointsPerGame?: number | null;
  recentFiveGameFantasyPointsPerGame?: number | null;
  recentTenGameFantasyPointsPerGame?: number | null;
  seasonAverageTimeOnIceMinutes?: number | null;
  recentAverageTimeOnIceMinutes?: number | null;
  actualRecentAppearances?: number | null;
  missedRecentTeamGames?: number | null;
  weightedRecentAppearances?: number | null;
  fullWeightRecentGames?: number | null;
  partialWeightRecentGames?: number | null;
  healthyProjectedCyclePoints?: number | null;
  scheduledGamesInProjectionCycle?: number | null;
  expectedGamesAvailable?: number | null;
  expectedGamesMissed?: number | null;
  availabilityAdjustment?: number | null;
  availabilityAdjustedCyclePoints?: number | null;
  availabilityStatus?: string | null;
  availabilityLabel?: string | null;
  availabilityReturnDate?: string | null;
  availabilityNote?: string | null;
  availabilityAsOf?: string | null;
  targetProjectionCycleNumber?: number | null;
  sharedProjectionSnapshotId?: string | null;
  projectionGeneratedAt?: string | null;
  balancedDraftValue?: number | null;
  balancedRank?: number | null;
  positionRank?: number | null;
  reliabilityRating?: number | null;
  volatilityPenalty?: number | null;
  floorAdjustedCyclePoints?: number | null;
  floorAdjustedDraftValue?: number | null;

  /** Earliest untouched fantasy window in which this asset may become active. */
  eligibleFromCycleNumber?: number | null;
}

export interface SkaterRosterAsset extends BaseRosterAsset {
  assetType: 'skater';
  position: 'LW' | 'C' | 'RW' | 'D';
  player: NHLPlayer;
  cycleScore: RosterCycleScore;
}

export interface TeamGoalieUnitAsset extends BaseRosterAsset {
  assetType: 'team-goalie-unit';
  position: 'G';
  teamName: string;
  teamAbbreviation: string;
  teamLogoUrl?: string;
  cycleScore: RosterCycleScore;
}

export type RosterAsset = SkaterRosterAsset | TeamGoalieUnitAsset;

export type PendingRosterMoveType = 'add-drop' | 'add-open-slot' | 'waiver-award';

/**
 * A roster change reserved for the next boundary of one persistent active
 * roster slot. The current asset remains in place until its active six-game
 * window finishes. The incoming asset is reserved immediately so another
 * manager cannot add it while the move is waiting.
 */
export interface PendingRosterSlotMove {
  id: string;
  moveType: PendingRosterMoveType;
  incomingAsset: RosterAsset;
  outgoingAssetKey: string | null;
  sourceWaiverId: string | null;
  queuedByOwnerId: string;
  queuedAt: string;
  requestedEffectiveCycleNumber: number | null;
  requestedEffectiveLabel: string | null;
  sourceBenchSlotId?: string | null;
  outgoingDestination?: 'waivers' | 'bench';
}

export interface ActiveRosterSlot {
  slotId: string;
  position: ActiveRosterPosition;
  slotNumber: number;
  asset: RosterAsset | null;
  pendingMove?: PendingRosterSlotMove | null;
  /** Current untouched cycle this empty slot may still join immediately. */
  openFromCycleNumber?: number | null;
}

export interface BenchRosterSlot {
  slotId: string;
  slotNumber: number;
  asset: RosterAsset | null;
}

export interface IrRosterSlot {
  slotId: string;
  slotNumber: number;
  asset: SkaterRosterAsset | null;
}

export interface FantasyRoster {
  schemaVersion: number;
  activeSlots: ActiveRosterSlot[];
  benchSlots: BenchRosterSlot[];
  irSlots: IrRosterSlot[];
  createdAt?: unknown;
  updatedAt?: unknown;
}
