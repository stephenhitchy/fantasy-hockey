import { NHLPlayer } from '../player/player.models';

export type ActiveRosterPosition = 'LW' | 'C' | 'RW' | 'D' | 'G';

export interface RosterCycleScore {
  cycleNumber: number;
  gamesCounted: number;
  fantasyPoints: number;
}

export type RosterStatus =
  | 'active'
  | 'injured'
  | 'benched'
  | 'new'
  | 'moved';

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
  reliabilityRating?: number | null;
  volatilityPenalty?: number | null;
  floorAdjustedCyclePoints?: number | null;
  floorAdjustedDraftValue?: number | null;
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

export type RosterAsset =
  | SkaterRosterAsset
  | TeamGoalieUnitAsset;

export interface ActiveRosterSlot {
  slotId: string;
  position: ActiveRosterPosition;
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
  irSlots: IrRosterSlot[];
  createdAt?: unknown;
  updatedAt?: unknown;
}
