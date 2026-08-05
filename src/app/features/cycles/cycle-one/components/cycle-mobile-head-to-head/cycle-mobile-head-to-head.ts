import { NgStyle } from '@angular/common';
import { Component, Input } from '@angular/core';

import type { FantasyMatchup } from '../../../../../core/cycle/cycle.models';
import type { DraftPick } from '../../../../../core/draft/draft.models';
import type { RosterAsset } from '../../../../../core/team/roster.models';
import type { CycleOne } from '../../cycle-one';
import type {
  CycleWindowGameMarker,
  MobileMatchupPlayerPair,
  MobileMatchupSection,
} from '../../cycle-one.models';
import {
  getMobileMatchupPerspective,
  getOwnerIdForMobileView,
  groupMobileMatchupPositions,
  MobileMatchupPerspective,
  resolveMobileMatchupView,
} from '../../cycle-mobile-matchup.util';

@Component({
  selector: 'app-cycle-mobile-head-to-head',
  imports: [NgStyle],
  templateUrl: './cycle-mobile-head-to-head.html',
  styleUrl: './cycle-mobile-head-to-head.css',
})
export class CycleMobileHeadToHead {
  @Input({ required: true }) matchup!: FantasyMatchup;
  @Input({ required: true }) presenter!: CycleOne;

  getPositionSections(): MobileMatchupSection[] {
    return groupMobileMatchupPositions(
      this.presenter.getMobileMatchupPositionGroups(this.matchup),
    );
  }

  getCurrentPerspective(): MobileMatchupPerspective {
    return getMobileMatchupPerspective(
      this.presenter.matchupView(),
      this.presenter.userId,
      this.matchup,
    );
  }

  setPerspective(perspective: MobileMatchupPerspective): void {
    this.presenter.setMatchupView(
      resolveMobileMatchupView(perspective, this.presenter.userId, this.matchup),
    );
  }

  isPerspectiveActive(perspective: MobileMatchupPerspective): boolean {
    return this.getCurrentPerspective() === perspective;
  }

  getPrimaryViewLabel(): string {
    return this.presenter.isMyMatchup(this.matchup)
      ? 'My Team'
      : this.presenter.getTeamName(this.matchup.teamAOwnerId);
  }

  getSecondaryViewLabel(): string {
    return this.presenter.isMyMatchup(this.matchup)
      ? 'Opponent'
      : this.presenter.getTeamName(this.matchup.teamBOwnerId);
  }

  isHeadToHeadView(): boolean {
    return this.presenter.matchupView() === 'both';
  }

  getSingleOwnerId(): string | null {
    return getOwnerIdForMobileView(this.presenter.matchupView(), this.matchup);
  }

  getPickForOwner(row: MobileMatchupPlayerPair, ownerId: string | null): DraftPick | null {
    if (!ownerId) {
      return null;
    }

    return ownerId === this.matchup.teamAOwnerId ? row.teamAPick : row.teamBPick;
  }

  getOwnerSideClass(ownerId: string | null): string {
    return ownerId === this.matchup.teamBOwnerId ? 'team-b' : 'team-a';
  }

  getTeamProgressText(ownerId: string | null): string {
    if (!ownerId) {
      return 'No opponent';
    }

    return `${this.presenter.getTeamRosterGamesPlayed(ownerId)} played · ${this.presenter.getTeamRosterGamesLeft(ownerId)} left`;
  }

  getActiveStatusLine(pick: DraftPick): string {
    if (this.presenter.hasAssetStatusFlag(pick.asset)) {
      return this.presenter.getAssetStatusTooltip(pick.asset);
    }

    if (this.presenter.isFutureWindowPending(pick)) {
      return this.presenter.getPendingWindowCallout(pick);
    }

    return this.presenter.getWindowStatusLabel(pick);
  }

  getMarkerClass(marker: CycleWindowGameMarker): string {
    return `mobile-window-marker mobile-window-marker-${marker.status}`;
  }

  getMarkerRuntimeState(
    pick: DraftPick,
    marker: CycleWindowGameMarker,
  ): 'scheduled' | 'live' | 'final' | null {
    if (!marker.gameId) {
      return null;
    }

    return this.presenter.getAssetScoreSummary(pick.asset)?.gameStates[
      String(marker.gameId)
    ] ?? null;
  }

  openActiveDetail(pick: DraftPick): void {
    void this.presenter.openAssetDetail(pick.asset);
  }

  openBenchDetail(
    asset: RosterAsset,
    ownerId: string | null,
    benchSlotNumber: number,
  ): void {
    if (!ownerId || benchSlotNumber < 1) {
      return;
    }

    this.presenter.openBenchAssetDetail(asset);
  }
}
