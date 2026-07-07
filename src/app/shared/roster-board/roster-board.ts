import {
  Component,
  Input
} from '@angular/core';

import { RouterLink } from '@angular/router';

import {
  DEFAULT_ROSTER_GROUPS,
  DEFAULT_STARTING_ROSTER_SIZE,
  IR_SLOT_COUNT
} from '../../core/team/roster-config';

import {
  ActiveRosterPosition,
  FantasyRoster,
  RosterAsset,
  RosterCycleScore,
  SkaterRosterAsset
} from '../../core/team/roster.models';

interface RosterGroupView {
  position: ActiveRosterPosition;
  label: string;
  slotCount: number;
  slotNumbers: number[];
}

@Component({
  selector: 'app-roster-board',
  imports: [RouterLink],
  templateUrl: './roster-board.html',
  styleUrl: './roster-board.css'
})
export class RosterBoard {
  @Input() roster: FantasyRoster | null = null;

  readonly startingRosterSize = DEFAULT_STARTING_ROSTER_SIZE;
  readonly irSlotCount = IR_SLOT_COUNT;

  private readonly rosterGroups: RosterGroupView[] =
    DEFAULT_ROSTER_GROUPS.map((group) => ({
      position: group.position as ActiveRosterPosition,
      label: group.label,
      slotCount: group.slots,
      slotNumbers: Array.from(
        { length: group.slots },
        (_, index) => index + 1
      )
    }));

  readonly forwardGroups = this.rosterGroups.filter(
    (group) =>
      group.position === 'LW' ||
      group.position === 'C' ||
      group.position === 'RW'
  );

  readonly backEndGroups = this.rosterGroups.filter(
    (group) =>
      group.position === 'D' ||
      group.position === 'G'
  );

  readonly irSlots = Array.from(
    { length: IR_SLOT_COUNT },
    (_, index) => index + 1
  );

  getActiveAsset(
    position: ActiveRosterPosition,
    slotNumber: number
  ): RosterAsset | null {
    return this.roster?.activeSlots.find(
      (slot) =>
        slot.position === position &&
        slot.slotNumber === slotNumber
    )?.asset ?? null;
  }

  getIrAsset(slotNumber: number): SkaterRosterAsset | null {
    return this.roster?.irSlots.find(
      (slot) => slot.slotNumber === slotNumber
    )?.asset ?? null;
  }

  getPointsPerGame(asset: RosterAsset): string {
    return this.getCyclePointsPerGame(asset.cycleScore);
  }

  private getCyclePointsPerGame(score: RosterCycleScore): string {
    if (score.gamesCounted === 0) {
      return '0.0';
    }

    return (
      score.fantasyPoints / score.gamesCounted
    ).toFixed(1);
  }
}