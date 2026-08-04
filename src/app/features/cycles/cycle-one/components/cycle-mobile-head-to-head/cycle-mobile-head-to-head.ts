import { NgStyle } from '@angular/common';
import { Component, Input, signal } from '@angular/core';

import type { FantasyMatchup } from '../../../../../core/cycle/cycle.models';
import type { DraftPick } from '../../../../../core/draft/draft.models';
import type { RosterAsset } from '../../../../../core/team/roster.models';
import { DialogFocusTrapDirective } from '../../../../../shared/accessibility/dialog-focus-trap.directive';
import type { CycleOne } from '../../cycle-one';
import type {
  CycleWindowGameMarker,
  MobileMatchupPlayerPair,
  MobileMatchupSection,
} from '../../cycle-one.models';
import {
  getMobileGameMarkerExplanation,
  getMobileMatchupPerspective,
  getOwnerIdForMobileView,
  groupMobileMatchupPositions,
  MobileGameMarkerExplanation,
  MobileMatchupPerspective,
  resolveMobileMatchupView,
} from '../../cycle-mobile-matchup.util';

interface MobileMatchupDetailSelection {
  kind: 'active' | 'bench';
  ownerId: string;
  pick: DraftPick | null;
  benchAsset: RosterAsset | null;
  benchSlotNumber: number | null;
}

@Component({
  selector: 'app-cycle-mobile-head-to-head',
  imports: [NgStyle, DialogFocusTrapDirective],
  templateUrl: './cycle-mobile-head-to-head.html',
  styleUrl: './cycle-mobile-head-to-head.css',
})
export class CycleMobileHeadToHead {
  @Input({ required: true }) matchup!: FantasyMatchup;
  @Input({ required: true }) presenter!: CycleOne;

  readonly selectedDetail = signal<MobileMatchupDetailSelection | null>(null);

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

  openActiveDetail(pick: DraftPick): void {
    this.selectedDetail.set({
      kind: 'active',
      ownerId: pick.ownerId,
      pick,
      benchAsset: null,
      benchSlotNumber: null,
    });
  }

  openBenchDetail(
    asset: RosterAsset,
    ownerId: string | null,
    benchSlotNumber: number,
  ): void {
    if (!ownerId) {
      return;
    }

    this.selectedDetail.set({
      kind: 'bench',
      ownerId,
      pick: null,
      benchAsset: asset,
      benchSlotNumber,
    });
  }

  closeDetail(): void {
    this.selectedDetail.set(null);
  }

  getDetailName(detail: MobileMatchupDetailSelection): string {
    if (detail.pick) {
      return this.presenter.getAssetName(detail.pick.asset);
    }

    return detail.benchAsset
      ? this.presenter.getBenchAssetName(detail.benchAsset)
      : 'Roster slot';
  }

  getDetailTeamLabel(detail: MobileMatchupDetailSelection): string {
    if (detail.pick) {
      return this.presenter.getAssetTeamLabel(detail.pick.asset);
    }

    return detail.benchAsset
      ? this.presenter.getBenchAssetTeamLabel(detail.benchAsset)
      : 'NHL team unavailable';
  }

  getDetailPosition(detail: MobileMatchupDetailSelection): string {
    return detail.pick?.asset.position ?? detail.benchAsset?.position ?? '—';
  }

  getDetailLogoUrl(detail: MobileMatchupDetailSelection): string | undefined {
    if (detail.pick) {
      return this.presenter.getAssetLogoUrl(detail.pick.asset);
    }

    return detail.benchAsset
      ? this.presenter.getBenchAssetLogoUrl(detail.benchAsset)
      : undefined;
  }

  getDetailCurrentScore(detail: MobileMatchupDetailSelection): string {
    return detail.pick
      ? this.presenter.getProjectionDisplay(
          this.presenter.getAssetCurrentCycleScore(detail.pick.asset),
        )
      : '—';
  }

  getDetailProjection(detail: MobileMatchupDetailSelection): string {
    const projection = detail.pick
      ? this.presenter.getBestCycleProjection(detail.pick.asset)
      : detail.benchAsset
        ? this.presenter.getBenchAssetProjection(detail.benchAsset)
        : null;

    return this.presenter.getProjectionDisplay(projection);
  }

  getDetailProjectionRange(detail: MobileMatchupDetailSelection): string {
    const asset = detail.pick?.asset;
    const floor = asset?.projectionFloorPoints;
    const ceiling = asset?.projectionCeilingPoints;

    if (typeof floor !== 'number' || typeof ceiling !== 'number') {
      return 'Range becomes available with a Projection V11 snapshot.';
    }

    return `${floor.toFixed(1)}–${ceiling.toFixed(1)} likely range`;
  }

  getDetailGamesLabel(detail: MobileMatchupDetailSelection): string {
    if (!detail.pick) {
      return 'Bench players do not score until moved into a starting roster slot.';
    }

    return `${this.presenter.getAssetGamesPlayed(detail.pick.asset)} of 6 team games counted`;
  }

  getDetailStatus(detail: MobileMatchupDetailSelection): string {
    if (detail.pick) {
      return this.getActiveStatusLine(detail.pick);
    }

    if (!detail.benchAsset) {
      return 'Bench slot';
    }

    const availability = this.presenter.getBenchAssetStatusTooltip(detail.benchAsset);
    return availability || `Bench ${detail.benchSlotNumber ?? ''} · does not score`;
  }

  getDetailMarkers(detail: MobileMatchupDetailSelection): CycleWindowGameMarker[] {
    return detail.pick ? this.presenter.getWindowGameMarkers(detail.pick) : [];
  }

  getMarkerScore(pick: DraftPick, marker: CycleWindowGameMarker): number | null {
    if (!marker.gameId) {
      return null;
    }

    const summary = this.presenter.getAssetScoreSummary(pick.asset);
    const score = summary?.gameScores[String(marker.gameId)];
    return typeof score === 'number' ? score : null;
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

  getMarkerExplanation(
    pick: DraftPick,
    marker: CycleWindowGameMarker,
  ): MobileGameMarkerExplanation {
    return getMobileGameMarkerExplanation(
      marker,
      this.getMarkerScore(pick, marker),
      this.getMarkerRuntimeState(pick, marker),
    );
  }

  openFullDetail(detail: MobileMatchupDetailSelection): void {
    this.closeDetail();

    if (detail.pick) {
      void this.presenter.openAssetDetail(detail.pick.asset);
      return;
    }

    if (detail.benchAsset) {
      this.presenter.openBenchAssetDetail(detail.benchAsset);
    }
  }
}
