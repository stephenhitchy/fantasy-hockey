import { NHLPlayer } from '../player/player.models';

export type ActiveRosterPosition = 'LW' | 'C' | 'RW' | 'D' | 'G';

export interface RosterCycleScore {
  cycleNumber: number;
  gamesCounted: number;
  fantasyPoints: number;
}

export interface SkaterRosterAsset {
  assetType: 'skater';
  position: 'LW' | 'C' | 'RW' | 'D';
  player: NHLPlayer;
  cycleScore: RosterCycleScore;
}

export interface TeamGoalieUnitAsset {
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