export type LeagueActivityCategory =
  | 'league'
  | 'draft'
  | 'roster'
  | 'matchup'
  | 'commissioner'
  | 'announcement';

export type LeagueActivityEventType =
  | 'league-created'
  | 'member-joined'
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
  | 'commissioner-announcement';

export type LeagueActivityAvailabilityStatus =
  | 'active'
  | 'day-to-day'
  | 'out'
  | 'injured-reserve'
  | 'long-term-injured-reserve'
  | 'suspended'
  | 'personal-leave'
  | 'unknown';

export interface LeagueActivityAssetSummary {
  name: string;
  position: 'LW' | 'C' | 'RW' | 'D' | 'G' | null;
  assetType: 'skater' | 'team-goalie-unit' | null;
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
