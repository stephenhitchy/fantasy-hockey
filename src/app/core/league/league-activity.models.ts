export type LeagueActivityCategory =
  | 'league'
  | 'draft'
  | 'roster'
  | 'matchup'
  | 'commissioner'
  | 'announcement'
  | 'recap';

export type LeagueActivityEventType =
  | 'league-created'
  | 'member-joined'
  | 'member-removed'
  | 'league-presentation-updated'
  | 'draft-settings-saved'
  | 'draft-pick'
  | 'add-drop'
  | 'add-open-slot'
  | 'move-to-ir'
  | 'activate-from-ir'
  | 'drop-to-waivers'
  | 'waiver-award'
  | 'waiver-cleared'
  | 'slot-move-activated'
  | 'active-bench-swap-activated'
  | 'move-bench-to-ir'
  | 'activate-ir-to-bench'
  | 'matchup-result'
  | 'commissioner-availability-override-set'
  | 'commissioner-availability-override-cleared'
  | 'commissioner-draft-opened'
  | 'commissioner-draft-clock-paused'
  | 'commissioner-draft-clock-resumed'
  | 'commissioner-announcement'
  | 'matchup-round-recap';

export type LeagueActivityAvailabilityStatus =
  | 'active'
  | 'day-to-day'
  | 'out'
  | 'injured-reserve'
  | 'long-term-injured-reserve'
  | 'suspended'
  | 'personal-leave'
  | 'unknown';



export type LeagueActivityReactionType = string;

export type LeagueActivityReactionCounts = Record<string, number>;

export interface LeagueActivityReactionRecord {
  ownerId: string;
  reactionType: LeagueActivityReactionType;
  firstChangedAt: Date;
  updatedAt: Date;
}

export interface LeagueActivityAssetSummary {
  name: string;
  position: 'LW' | 'C' | 'RW' | 'D' | 'G' | null;
  assetType: 'skater' | 'team-goalie-unit' | null;
}

export interface LeagueActivityRecapPerformer {
  ownerId: string;
  asset: LeagueActivityAssetSummary;
}

export interface LeagueActivityRecapPickup {
  ownerId: string;
  asset: LeagueActivityAssetSummary;
}

export interface LeagueActivity {
  id: string;
  schemaVersion: number;
  category: LeagueActivityCategory;
  eventType: LeagueActivityEventType;
  ownerId: string | null;
  primaryAsset: LeagueActivityAssetSummary | null;
  secondaryAsset: LeagueActivityAssetSummary | null;
  overallPick: number | null;
  round: number | null;
  selectionType: 'manual' | 'queue' | 'automatic' | null;
  effectiveCycleNumber: number | null;
  effectiveLabel: string | null;
  matchupPhase: 'regular_season' | 'playoffs' | null;
  matchupCycleNumber: number | null;
  teamAOwnerId: string | null;
  teamBOwnerId: string | null;
  teamAScore: number | null;
  teamBScore: number | null;
  winnerOwnerId: string | null;
  playoffBracketType: 'championship' | 'consolation' | null;
  playoffRoundNumber: number | null;
  winnerPlace: number | null;
  loserPlace: number | null;
  tieBrokenByHigherSeed: boolean;
  availabilityPlayerName: string | null;
  availabilityStatus: LeagueActivityAvailabilityStatus | null;
  announcementTitle: string | null;
  announcementBody: string | null;
  recapCycleNumber: number | null;
  recapMatchupCount: number | null;
  recapTopScoreOwnerIds: string[];
  recapTopScore: number | null;
  recapClosestTeamAOwnerId: string | null;
  recapClosestTeamBOwnerId: string | null;
  recapClosestWinnerOwnerId: string | null;
  recapClosestMargin: number | null;
  recapNewLeagueHighScore: boolean;
  recapPreviousLeagueHighScore: number | null;
  recapTopPerformers: LeagueActivityRecapPerformer[];
  recapTopPerformerScore: number | null;
  recapTopPerformerTieCount: number;
  recapTopPickups: LeagueActivityRecapPickup[];
  recapTopPickupScore: number | null;
  recapTopPickupTieCount: number;
  recapUpsetWinnerOwnerId: string | null;
  recapUpsetLoserOwnerId: string | null;
  recapUpsetProjectionGap: number | null;
  recapUpsetWinnerProjection: number | null;
  recapUpsetLoserProjection: number | null;
  reactionRecords: LeagueActivityReactionRecord[];
  reactionCounts: LeagueActivityReactionCounts;
  occurredAt: Date | null;
}

export interface PinnedLeagueAnnouncement {
  ownerId: string;
  title: string;
  body: string;
  activityId: string;
  occurredAt: Date | null;
  pinnedAt: Date | null;
}
