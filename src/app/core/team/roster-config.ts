import { NHLPosition } from '../player/player.models';

export interface RosterGroup {
  position: NHLPosition;
  label: string;
  slots: number;
  assetType: 'skater' | 'team-goalie-unit';
}

export const DEFAULT_ROSTER_GROUPS: RosterGroup[] = [
  {
    position: 'LW',
    label: 'Left Wing',
    slots: 3,
    assetType: 'skater'
  },
  {
    position: 'C',
    label: 'Center',
    slots: 3,
    assetType: 'skater'
  },
  {
    position: 'RW',
    label: 'Right Wing',
    slots: 3,
    assetType: 'skater'
  },
  {
    position: 'D',
    label: 'Defense',
    slots: 4,
    assetType: 'skater'
  },
  {
    position: 'G',
    label: 'Team Goalie Unit',
    slots: 1,
    assetType: 'team-goalie-unit'
  }
];

export const IR_SLOT_COUNT = 4;

export const DEFAULT_STARTING_ROSTER_SIZE = DEFAULT_ROSTER_GROUPS.reduce(
  (total, group) => total + group.slots,
  0
);

export const DEFAULT_TOTAL_ROSTER_SIZE =
  DEFAULT_STARTING_ROSTER_SIZE + IR_SLOT_COUNT;