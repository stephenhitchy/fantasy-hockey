import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { getMockRosterDisplayPlayers, MockRosterDisplayPlayer } from '../../core/player/mock-player-data';
import { DEFAULT_ROSTER_GROUPS } from '../../core/team/roster-config';

@Component({
  selector: 'app-roster-board',
  imports: [RouterLink],
  templateUrl: './roster-board.html',
  styleUrl: './roster-board.css'
})
export class RosterBoard {
  private readonly testPlayers = getMockRosterDisplayPlayers();

  readonly rosterGroups = DEFAULT_ROSTER_GROUPS.map((group) => ({
    position: group.position,
    label: group.label,
    slotCount: group.slots,
    slots: Array.from({ length: group.slots }, (_, index) => {
      const slotNumber = index + 1;

      return {
        slotNumber,
        player: this.testPlayers[`${group.position}-${slotNumber}`]
      };
    })
  }));

  getPointsPerGame(player: MockRosterDisplayPlayer): string {
    const { gamesCounted, fantasyPoints } = player.cycleScore;

    if (gamesCounted === 0) {
      return '0.0';
    }

    return (fantasyPoints / gamesCounted).toFixed(1);
  }
}