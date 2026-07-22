export type NHLPosition = 'LW' | 'C' | 'RW' | 'D' | 'G';

export interface NHLPlayer {
  id: number;
  fullName: string;
  position: NHLPosition;
  nhlTeamAbbreviation: string;

  // These will come from the NHL API later.
  teamLogoUrl?: string;
  headshotUrl?: string;
}

export interface PlayerCycleScore {
  playerId: number;
  cycleNumber: number;
  gamesCounted: number;
  fantasyPoints: number;
}