export type LeagueActivityCategory = 'league' | 'draft' | 'roster';

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
  | 'activate-ir-to-bench';

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
  occurredAt: Date | null;
}
