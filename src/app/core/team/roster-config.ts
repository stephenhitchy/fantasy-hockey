import { NHLPosition } from '../player/player.models';

export interface RosterGroup {
  position: NHLPosition;
  label: string;
  slots: number;
}

export const DEFAULT_ROSTER_GROUPS: RosterGroup[] = [
  { position: 'LW', label: 'Left Wing', slots: 4 },
  { position: 'C', label: 'Center', slots: 4 },
  { position: 'RW', label: 'Right Wing', slots: 4 },
  { position: 'D', label: 'Defense', slots: 6 },
  { position: 'G', label: 'Goalie', slots: 2 }
];

export const DEFAULT_STARTING_ROSTER_SIZE = DEFAULT_ROSTER_GROUPS.reduce(
  (total, group) => total + group.slots,
  0
);