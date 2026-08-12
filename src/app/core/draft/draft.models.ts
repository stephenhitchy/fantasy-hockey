import { NHLPlayer } from '../player/player.models';

export type DraftStatus = 'setup' | 'scheduled' | 'live' | 'complete';

export type DraftPosition = 'LW' | 'C' | 'RW' | 'D' | 'G';

export type DraftClockStatus = 'stopped' | 'running' | 'paused' | 'complete';

export type DraftSelectionType = 'manual' | 'queue' | 'automatic';

export type DraftAutoPickReason = 'timer-expired' | 'manager-auto-mode';

export type ProjectionDataSource =
  | 'current-season-form'
  | 'current-season-baseline'
  | 'previous-season-form'
  | 'previous-season-baseline'
  | 'conservative-baseline';

export type SharedProjectionAvailabilityStatus =
  | 'active'
  | 'day-to-day'
  | 'out'
  | 'injured-reserve'
  | 'long-term-injured-reserve'
  | 'suspended'
  | 'personal-leave'
  | 'unknown';

export interface DraftRosterRequirements {
  LW: number;
  C: number;
  RW: number;
  D: number;
  G: number;
}


export type ProjectionCycleGameStatus = 'played' | 'missed' | 'upcoming';

export interface ProjectionCycleGameMarker {
  gameId: number;
  gameDate: string;
  opponentAbbreviation: string;
  venue: 'home' | 'away';
  status: ProjectionCycleGameStatus;
}

export interface ProjectionStatBreakdownItem {
  key: string;
  label: string;
  statValue: number;
  statUnit: string;
  fantasyPoints: number;
  note?: string | null;
}

export interface DraftProjection {
  projectedSeasonPoints?: number | null;
  projectedCyclePoints?: number | null;

  /** Current-season fantasy production calculated from available NHL game rows. */
  currentSeasonFantasyPoints?: number | null;

  /** Remaining regular-season fantasy points at the current projection pace. */
  projectedRestOfSeasonPoints?: number | null;

  /** Current production plus the remaining-season estimate. */
  projectedFinalSeasonPoints?: number | null;

  /** Stable draft/preseason pace through the number of games already played. */
  expectedFantasyPointsToDate?: number | null;

  /** Positive means ahead of projection; negative means behind projection. */
  performanceVsProjectionPoints?: number | null;
  performanceVsProjectionPercent?: number | null;

  /** NHL team games completed and remaining in the regular season. */
  seasonTeamGamesPlayed?: number | null;
  seasonGamesRemaining?: number | null;

  /** Category-by-category explanation of current-season fantasy points. */
  seasonStatBreakdown?: ProjectionStatBreakdownItem[] | null;
  seasonStatBreakdownNote?: string | null;

  /** The NHL team's currently active six-game block and its game markers. */
  currentTeamCycleNumber?: number | null;
  currentTeamCycleGames?: ProjectionCycleGameMarker[] | null;


  /**
   * Exact manager-facing projection frozen when a fantasy cycle begins.
   * Live NHL schedule and scoring requests must never replace this value.
   */
  frozenCycleProjectionPoints?: number | null;

  /** Fantasy cycle for which frozenCycleProjectionPoints was captured. */
  frozenProjectionCycleNumber?: number | null;

  /** Source used when the cycle projection was frozen. */
  frozenProjectionSource?: 'shared-snapshot' | 'roster' | 'draft-pick' | 'legacy' | null;

  /** Projection model version captured for this immutable window. */
  frozenProjectionVersion?: number | null;

  /** Shared snapshot used to create the immutable window projection. */
  frozenProjectionSnapshotId?: string | null;

  /** When the underlying shared projection data was generated. */
  frozenProjectionGeneratedAt?: string | null;

  /** When this specific roster-slot window froze its projection. */
  frozenProjectionFrozenAt?: string | null;

  /** Projection before short-term form and role adjustments. */
  seasonBaselineCyclePoints?: number | null;

  /** Capped cycle-point adjustment from the latest 10 and 20 appearances. */
  recentFormAdjustment?: number | null;

  /** Capped cycle-point adjustment from recent ice-time / role movement. */
  roleAdjustment?: number | null;

  /** Bounded adjustment from the exact six opponents, venue, and rest pattern. */
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
  projectionDataSource?: ProjectionDataSource | null;
  projectionGamesPlayed?: number | null;
  recentFormSampleSize?: number | null;

  seasonFantasyPointsPerGame?: number | null;
  recentThreeGameFantasyPointsPerGame?: number | null;
  recentFiveGameFantasyPointsPerGame?: number | null;
  recentTenGameFantasyPointsPerGame?: number | null;
  recentTwentyGameFantasyPointsPerGame?: number | null;

  /**
   * Stable season-long draft outlook. Short-term form is deliberately capped
   * so a hot or cold week cannot dominate the initial draft board.
   */
  draftProjectedSeasonPoints?: number | null;
  draftProjectedCyclePoints?: number | null;

  /** Projection V11 completed-season development/decline classification. */
  draftTrajectoryLabel?:
    | 'breakout'
    | 'rising'
    | 'stable'
    | 'declining'
    | 'insufficient-data'
    | null;
  draftTrajectoryConfidence?: number | null;
  draftTrajectoryAdjustment?: number | null;
  draftLatestSeasonWeight?: number | null;
  draftPaceChangePercent?: number | null;

  draftRecentTrendAdjustment?: number | null;
  draftRoleAdjustment?: number | null;
  draftReliabilityRating?: number | null;
  draftVolatilityPenalty?: number | null;
  draftFloorAdjustedCyclePoints?: number | null;

  /** Projection V11 stat-component ensemble diagnostics. */
  projectionModelVersion?: number | null;
  projectionModelConfidence?: number | null;

  /** Stored as 0-1 rates; UI surfaces format them as percentages. */
  projectionPrimaryAssistShare?: number | null;
  projectionShootingPercentage?: number | null;
  projectionCurrentSeasonWeight?: number | null;
  projectionHistoricalWeight?: number | null;

  /** Estimated goals per 82 added or removed by shooting regression. */
  projectionShootingRegressionAdjustment?: number | null;

  /** Likely next-matchup range around the availability-adjusted mean. */
  projectionFloorPoints?: number | null;
  projectionCeilingPoints?: number | null;
  projectionUncertaintyPoints?: number | null;

  /** Repeatable opportunity portion of the recent-form adjustment. */
  sustainableFormAdjustment?: number | null;
  recentGameStandardDeviation?: number | null;

  /** Shared ranking fields used by the Draft Room and auto-draft. */
  draftValueAboveReplacement?: number | null;
  draftScore?: number | null;
  draftRank?: number | null;
  draftPositionRank?: number | null;

  /** Shared ranking fields for regular-season next-cycle decisions. */
  cycleValueAboveReplacement?: number | null;
  cycleScore?: number | null;
  cycleRank?: number | null;
  cyclePositionRank?: number | null;

  seasonAverageTimeOnIceMinutes?: number | null;
  recentAverageTimeOnIceMinutes?: number | null;

  /** Number of recent game records where the skater actually appeared. */
  actualRecentAppearances?: number | null;

  /** Recent final NHL team games where the skater did not appear. */
  missedRecentTeamGames?: number | null;

  /** Appearance-equivalent sample after short injury games receive partial weight. */
  weightedRecentAppearances?: number | null;

  fullWeightRecentGames?: number | null;
  partialWeightRecentGames?: number | null;

  /** Healthy six-game value before expected absences are applied. */
  healthyProjectedCyclePoints?: number | null;

  /** Number of games in the target NHL-team cycle schedule. */
  scheduledGamesInProjectionCycle?: number | null;

  /** Expected appearances after injury / availability information is applied. */
  expectedGamesAvailable?: number | null;
  expectedGamesMissed?: number | null;

  availabilityAdjustment?: number | null;
  availabilityAdjustedCyclePoints?: number | null;
  availabilityStatus?: SharedProjectionAvailabilityStatus | null;
  availabilityLabel?: string | null;
  availabilityReturnDate?: string | null;
  availabilityNote?: string | null;
  availabilityAsOf?: string | null;
  targetProjectionCycleNumber?: number | null;

  /** Shared snapshot and deterministic ranking fields. */
  sharedProjectionSnapshotId?: string | null;
  projectionGeneratedAt?: string | null;

  /**
   * Backward-compatible aliases. New code should prefer draftScore,
   * draftRank, and draftPositionRank.
   */
  balancedDraftValue?: number | null;
  balancedRank?: number | null;
  positionRank?: number | null;

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

  /** Earliest untouched fantasy window in which this asset may become active. */
  eligibleFromCycleNumber?: number | null;
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

export type DraftableAsset = DraftableSkaterAsset | DraftableGoalieUnitAsset;

export interface FantasyDraft {
  schemaVersion: number;
  status: DraftStatus;
  format: 'snake';
  totalRounds: number;
  rosterRequirements: DraftRosterRequirements;
  benchSlots: number;
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
  /** Exact client request that most recently saved commissioner settings. */
  lastSettingsSubmissionId?: string | null;

  /** Server-owned background request preparing the verified Draft board. */
  projectionPreparationRequestId?: string | null;
  /** Latest known preparation state when Draft settings were saved. */
  projectionPreparationStatus?: 'ready' | 'queued' | 'processing' | 'error' | null;

  /** Verified shared projection snapshot frozen for the entire draft. */
  serverDraftProjectionSnapshotId?: string | null;
  /** Deterministic SHA-256 root hash of the frozen Draft pool. */
  serverDraftProjectionSnapshotHash?: string | null;
  /** Server projection-authority schema frozen with the Draft. */
  serverDraftProjectionAuthorityVersion?: number | null;
  /** Canonical NHL asset-catalog hash used by the frozen Draft pool. */
  serverDraftProjectionCatalogHash?: string | null;

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

  /**
   * Present on cycle roster snapshots. Draft picks remain backward-compatible
   * because the field is optional for the original draft collection.
   */
  rosterArea?: 'active' | 'bench';
  rosterSlotId?: string;
  cycleWindowId?: string;
  snapshotCycleNumber?: number;
  snapshotOrder?: number;
  playoffWindowNumber?: number;

  selectionType?: DraftSelectionType;
  selectedByUserId?: string;
  autoPickReason?: DraftAutoPickReason | null;

  /**
   * Client-generated idempotency key for a manual pick submission. Automatic
   * picks and legacy draft records may omit it. Retrying the same request with
   * this identifier must return the original committed pick instead of
   * creating or attempting a second selection.
   */
  submissionId?: string | null;

  /** Exact server-verified projection pool used for this selection. */
  projectionSnapshotId?: string | null;
  projectionSnapshotHash?: string | null;
  projectionAuthorityVersion?: number | null;

  madeAt?: unknown;
}

export interface DraftQueue {
  ownerId: string;
  assetKeys: string[];
  autoDraftEnabled: boolean;

  /**
   * Consecutive turns where this manager allowed the draft clock to expire.
   * A manual pick resets the count. The value is capped at two because the
   * second consecutive expiration enables auto-draft for future turns.
   */
  consecutiveClockExpirations: number;

  /** True when auto-draft was forced on by two consecutive expired turns. */
  autoDraftActivatedByTimeout: boolean;

  updatedAt?: unknown;
}
