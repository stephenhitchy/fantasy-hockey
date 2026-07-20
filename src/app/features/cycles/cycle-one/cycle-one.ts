import { Component, computed, OnDestroy, signal } from '@angular/core';

import {
  CycleAssetScoreSummary,
  CycleScoringResult,
} from '../../../core/cycle/cycle-scoring.service';

import { defaultScoringRules } from '../../../core/scoring/scoring-rules';

import { saveProjectionAccuracyForCycle } from '../../../core/projection/projection-accuracy.service';

import { getFrozenCycleProjection } from '../../../core/projection/cycle-projection.util';

import { NgStyle } from '@angular/common';
import { ActivatedRoute, ParamMap, Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { onAuthStateChanged, User } from 'firebase/auth';

import { auth } from '../../../core/firebase';

import {
  FantasyAssetCycleWindow,
  FantasyCycle,
  FantasyMatchup,
  FantasyTeamCycleWindows,
} from '../../../core/cycle/cycle.models';

import {
  advanceCompletedRegularSeasonAssetWindows,
  completeCycle,
  listenToCycle,
  listenToCycleMatchups,
  listenToCycleRosterPicks,
  listenToLeagueCycles,
  reconcileRegularSeasonCycleMatchupCompletion,
  startNextCycle,
} from '../../../core/cycle/cycle.service';

import {
  listenToCycleTeamWindows,
  syncCycleTeamWindows,
} from '../../../core/cycle/asset-cycle-window.service';

import { loadDraftPlayerPool } from '../../../core/draft/draft-player-pool.service';

import { DraftableAsset, DraftPick, DraftPosition } from '../../../core/draft/draft.models';

import { listenToDraftPicks } from '../../../core/draft/draft.service';

import { getLeagueById, League } from '../../../core/league/league.service';

import { getFantasyPlayoffs } from '../../../core/playoffs/playoff.service';

import {
  ensureNextPlayoffBankWindows,
  syncPlayoffWindowBankScores,
} from '../../../core/playoffs/playoff-window-bank.service';

import {
  STANDARD_FULL_CYCLE_SEASON_COUNT,
  getPlayoffRoundLabel,
  getStandardPlayoffRoundCount,
  getStandardPlayoffTeamCount,
  getStandardRegularSeasonCycleCount,
} from '../../../core/playoffs/playoff-format';

import { getNhlTeamSeasonSchedule, NHL_DRAFT_CLUBS } from '../../../core/nhl/nhl-api.service';

import { FantasyTeam, getLeagueTeams } from '../../../core/team/team.service';
import { getUserProfile } from '../../../core/user/user.service';
import { PixelTeamTheme, getPixelTeamTheme } from '../../../shared/pixel-theme/pixel-theme.data';

import {
  areDeveloperToolsEnabled,
  getHistoricalScoringTestDate,
} from '../../../core/cycle/cycle-runtime.config';

import {
  listenToSharedCycleScoring,
  listenToSharedLiveScoringControl,
  requestLeagueLiveScoringRefresh,
} from '../../../core/live-scoring/live-scoring.service';

import {
  SharedCycleScoringSnapshot,
  SharedLiveScoringControl,
} from '../../../core/live-scoring/live-scoring.models';

import { FantasyRoster, PendingRosterSlotMove } from '../../../core/team/roster.models';

import { listenToFantasyRoster } from '../../../core/team/roster.service';

const CYCLE_PROJECTION_WINDOW_DAYS = 14;
const NHL_SCHEDULE_BATCH_SIZE = 4;

const PROJECTION_NEUTRAL_PERCENT = 0.1;
const PROJECTION_NEUTRAL_POINTS = 10;

type MatchupViewMode = 'teamA' | 'both' | 'teamB';

interface MatchupPositionBreakdownRow {
  position: DraftPosition;
  label: string;
  actual: number;
  projected: number | null;
  delta: number | null;
}

interface MatchupAssetPerformanceRow {
  asset: DraftableAsset;
  ownerId: string;
  teamName: string;
  actual: number;
  projected: number | null;
  delta: number | null;
  position: DraftPosition;
}

interface CycleWindowGameMarker {
  index: number;
  gameId: number | null;
  gameDate: string | null;
  gameLabel: string;
  status: 'played' | 'missed' | 'upcoming' | 'unavailable';
  statusLabel: string;
  title: string;
}

function waitForAuthUser(): Promise<User | null> {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

@Component({
  selector: 'app-cycle-one',
  imports: [RouterLink, NgStyle],
  templateUrl: './cycle-one.html',
  styleUrl: './cycle-one.css',
})
export class CycleOne implements OnDestroy {
  readonly developerToolsEnabled = areDeveloperToolsEnabled();
  leagueId = '';
  userId = '';
  cycleNumber = 1;
  matchupId: string | null = null;

  league = signal<League | null>(null);
  teams = signal<FantasyTeam[]>([]);
  ownerFavoriteTeams = signal<Record<string, string>>({});
  allCycles = signal<FantasyCycle[]>([]);
  cycle = signal<FantasyCycle | null>(null);
  matchups = signal<FantasyMatchup[]>([]);
  picks = signal<DraftPick[]>([]);
  playerPool = signal<DraftableAsset[]>([]);
  teamWindowsByOwner = signal<Record<string, FantasyTeamCycleWindows>>({});
  displayedRostersByOwner = signal<Record<string, FantasyRoster>>({});

  teamGameCounts = signal<Record<string, number>>({});

  cycleScoring = signal<CycleScoringResult | null>(null);
  sharedScoringSnapshot = signal<SharedCycleScoringSnapshot | null>(null);
  liveScoringControl = signal<SharedLiveScoringControl | null>(null);
  matchupView = signal<MatchupViewMode>('both');

  scoringLoading = signal(false);
  scoringError = signal('');

  loading = signal(true);
  errorMessage = signal('');
  scheduleProjectionLoading = signal(false);
  scheduleProjectionError = signal('');
  syncingScores = signal(false);
  syncScoreMessage = signal('');
  syncScoreError = signal('');

  completingCycle = signal(false);
  completeCycleMessage = signal('');
  completeCycleError = signal('');
  startingNextCycle = signal(false);
  startNextCycleMessage = signal('');
  startNextCycleError = signal('');

  autoFlowMessage = signal('');
  autoFlowError = signal('');

  projectionAccuracySaving = signal(false);
  projectionAccuracyMessage = signal('');
  projectionAccuracyError = signal('');

  isCommissioner(): boolean {
    return this.league()?.commissionerId === this.userId;
  }

  getAutoLeagueStatusTitle(): string {
    const cycle = this.cycle();

    if (!cycle) {
      return `${this.getCycleLabel()} Not Started`;
    }

    if (
      this.autoFlowError() ||
      this.completeCycleError() ||
      this.startNextCycleError() ||
      this.scoringError()
    ) {
      return 'Score Update Needs Attention';
    }

    if (this.completingCycle()) {
      return `Completing ${this.getCycleLabel()}`;
    }

    if (this.startingNextCycle()) {
      return `Preparing ${this.getNextCycleLabel()}`;
    }

    if (cycle.status === 'complete') {
      return `${this.getCycleLabel()} Complete`;
    }

    if (this.scoringLoading()) {
      return 'Checking Current Scores';
    }

    if (!this.cycleScoring()) {
      return 'Waiting for Scoring Data';
    }

    if (!this.hasCurrentCycleScheduledGames()) {
      return 'Season Schedule Complete';
    }

    if (this.areAllMatchupsReadyToComplete()) {
      return `${this.getCycleLabel()} Ready to Finish`;
    }

    return `${this.getCycleLabel()} Active`;
  }

  getAutoLeagueStatusText(): string {
    const cycle = this.cycle();

    if (!cycle) {
      return `${this.getCycleLabel()} will appear here once it has been created.`;
    }

    const activeError =
      this.autoFlowError() ||
      this.completeCycleError() ||
      this.startNextCycleError() ||
      this.scoringError();

    if (activeError) {
      return activeError;
    }

    if (this.completingCycle()) {
      return cycle.phase === 'playoffs'
        ? 'All roster games are complete. Final scores and the playoff bracket are being saved now.'
        : 'All roster games are complete. Final scores, winners, and team records are being saved now.';
    }

    if (this.startingNextCycle()) {
      return `${this.getNextCycleLabel()} is being created or opened automatically.`;
    }

    if (this.autoFlowMessage()) {
      return this.autoFlowMessage();
    }

    if (cycle.status === 'complete') {
      if (this.isFinalPlayoffRound()) {
        return `${this.getCycleLabel()} has final scores saved. The fantasy season is complete.`;
      }

      return `${this.getCycleLabel()} has final scores saved. ${this.getNextCycleLabel()} will be created or opened automatically when the flow continues.`;
    }

    if (this.scoringLoading()) {
      return 'The app is loading NHL game results and recalculating fantasy scores.';
    }

    if (!this.cycleScoring()) {
      return 'Current scoring is waiting for drafted roster data and NHL game data.';
    }

    if (!this.hasCurrentCycleScheduledGames()) {
      return this.getNoMoreGamesMessage();
    }

    if (this.areAllMatchupsReadyToComplete()) {
      return `${this.getCycleLabel()} is ready. It will complete automatically and then move forward to ${this.getNextCycleLabel()}.`;
    }

    const gamesLeft = this.matchups().reduce(
      (total, matchup) => total + this.getMatchupRosterGamesLeft(matchup),
      0,
    );

    const gameLabel = gamesLeft === 1 ? 'counted roster game' : 'counted roster games';

    return `Waiting on ${gamesLeft} ${gameLabel}. Missed or injured player games still count once that player's NHL team game is final.`;
  }

  getAutoLeagueStatusClass(): string {
    const cycle = this.cycle();

    if (
      this.autoFlowError() ||
      this.completeCycleError() ||
      this.startNextCycleError() ||
      this.scoringError()
    ) {
      return 'auto-status-error';
    }

    if (this.completingCycle() || this.startingNextCycle()) {
      return 'auto-status-working';
    }

    if (cycle?.status === 'complete') {
      return 'auto-status-complete';
    }

    if (this.cycleScoring() && !this.hasCurrentCycleScheduledGames()) {
      return 'auto-status-complete';
    }

    if (this.cycleScoring() && this.areAllMatchupsReadyToComplete()) {
      return 'auto-status-ready';
    }

    return 'auto-status-active';
  }

  shouldShowCompactAutoStatus(): boolean {
    return Boolean(
      this.autoFlowError() ||
      this.completeCycleError() ||
      this.startNextCycleError() ||
      this.scoringError() ||
      this.scoringLoading() ||
      this.completingCycle() ||
      this.startingNextCycle() ||
      (this.cycleScoring() && !this.hasCurrentCycleScheduledGames()),
    );
  }

  hasCurrentCycleScheduledGames(): boolean {
    const scoring = this.cycleScoring();

    if (typeof scoring?.cycleHasScheduledGames === 'boolean') {
      return scoring.cycleHasScheduledGames;
    }

    return Object.values(scoring?.assetScores ?? {}).some((summary) => summary.scheduledGames > 0);
  }

  getNoMoreGamesMessage(): string {
    return `${this.getCycleLabel()} has no NHL team games left to score. The app will stop creating new cycles until more games are available.`;
  }

  setMatchupView(viewMode: MatchupViewMode): void {
    this.matchupView.set(viewMode);
  }

  shouldShowTeamA(): boolean {
    return this.matchupView() === 'teamA' || this.matchupView() === 'both';
  }

  shouldShowTeamB(): boolean {
    return this.matchupView() === 'teamB' || this.matchupView() === 'both';
  }

  shouldShowMatchupDivider(): boolean {
    return this.matchupView() === 'both';
  }

  getTeamsComparisonClass(): string {
    return this.matchupView() === 'both' ? 'teams-comparison' : 'teams-comparison single-team-view';
  }

  async completeCurrentCycleFromCurrentScores(): Promise<void> {
    this.completeCycleMessage.set('');
    this.completeCycleError.set('');

    const cycle = this.cycle();
    const scoring = this.cycleScoring();
    const matchups = this.matchups();

    if (!cycle) {
      this.completeCycleError.set(`${this.getCycleLabel()} has not been started yet.`);
      return;
    }

    if (cycle.status === 'complete') {
      this.completeCycleError.set(`${this.getCycleLabel()} has already been completed.`);
      return;
    }

    if (!scoring) {
      this.completeCycleError.set(
        'Current scores are not ready yet. Wait for scoring to finish loading.',
      );
      return;
    }

    if (matchups.length === 0) {
      this.completeCycleError.set('No matchups were found to complete.');
      return;
    }

    if (!this.areAllMatchupsReadyToComplete()) {
      this.completeCycleError.set(
        `${this.getCycleLabel()} is not ready to complete yet. Some roster games are still unfinished.`,
      );
      return;
    }

    this.completingCycle.set(true);

    try {
      if (cycle.phase === 'regular_season') {
        const completionResult = await reconcileRegularSeasonCycleMatchupCompletion(
          this.leagueId,
          this.cycleNumber,
        );

        if (!completionResult.cycleCompleted) {
          throw new Error(
            `${this.getCycleLabel()} still has ${completionResult.pendingMatchupCount} matchup${completionResult.pendingMatchupCount === 1 ? '' : 's'} waiting on roster-slot windows.`,
          );
        }
      } else {
        await completeCycle(this.leagueId, this.cycleNumber, matchups, scoring.teamScores);
      }

      await this.saveCurrentCycleProjectionAccuracy();

      this.completeCycleMessage.set(
        cycle.phase === 'playoffs'
          ? `${this.getCycleLabel()} was completed and the playoff bracket advanced.`
          : `${this.getCycleLabel()} was completed and team records were updated.`,
      );

      this.teams.set(await getLeagueTeams(this.leagueId));

      await this.startOrOpenNextCycleAfterCompletion('manual', true);
    } catch (error: unknown) {
      this.completeCycleError.set(
        error instanceof Error ? error.message : `Unable to complete ${this.getCycleLabel()}.`,
      );
    } finally {
      this.completingCycle.set(false);
    }
  }

  async startNextCycleFromCurrentCycle(): Promise<void> {
    this.startNextCycleMessage.set('');
    this.startNextCycleError.set('');

    const cycle = this.cycle();

    if (!cycle) {
      this.startNextCycleError.set(`${this.getCycleLabel()} has not been started yet.`);
      return;
    }

    if (cycle.status !== 'complete') {
      this.startNextCycleError.set(
        `${this.getCycleLabel()} must be complete before opening ${this.getNextCycleLabel()}.`,
      );
      return;
    }

    await this.startOrOpenNextCycleAfterCompletion('manual');
  }

  isMatchupComplete(matchup: FantasyMatchup): boolean {
    return matchup.status === 'complete' || this.cycle()?.status === 'complete';
  }

  getTeamRosterGamesLeft(ownerId: string | null): number {
    if (!ownerId) {
      return 0;
    }

    return this.getTeamPicks(ownerId).reduce(
      (total, pick) => total + this.getAssetGamesLeft(pick.asset),
      0,
    );
  }

  getTeamRosterGamesPlayed(ownerId: string | null): number {
    if (!ownerId) {
      return 0;
    }

    return this.getTeamPicks(ownerId).reduce(
      (total, pick) => total + this.getAssetGamesPlayed(pick.asset),
      0,
    );
  }

  isTeamReadyToComplete(ownerId: string | null): boolean {
    if (!ownerId) {
      return true;
    }

    const scoring = this.cycleScoring();

    if (typeof scoring?.teamCycleComplete?.[ownerId] === 'boolean') {
      return scoring.teamCycleComplete[ownerId];
    }

    const picks = this.getTeamPicks(ownerId);

    return picks.length > 0 && picks.every((pick) => this.getAssetGamesLeft(pick.asset) === 0);
  }

  getMatchupRosterGamesLeft(matchup: FantasyMatchup): number {
    return (
      this.getTeamRosterGamesLeft(matchup.teamAOwnerId) +
      this.getTeamRosterGamesLeft(matchup.teamBOwnerId)
    );
  }

  isMatchupReadyToComplete(matchup: FantasyMatchup): boolean {
    if (this.isMatchupComplete(matchup)) {
      return true;
    }

    if (!this.cycleScoring() || !this.hasCurrentCycleScheduledGames()) {
      return false;
    }

    return (
      this.isTeamReadyToComplete(matchup.teamAOwnerId) &&
      this.isTeamReadyToComplete(matchup.teamBOwnerId)
    );
  }

  areAllMatchupsReadyToComplete(): boolean {
    const matchups = this.matchups();

    return (
      Boolean(this.cycleScoring()) &&
      this.hasCurrentCycleScheduledGames() &&
      matchups.length > 0 &&
      matchups.every((matchup) => this.isMatchupReadyToComplete(matchup))
    );
  }

  getMatchupReadinessLabel(matchup: FantasyMatchup): string {
    if (this.isMatchupComplete(matchup)) {
      return 'Complete';
    }

    if (this.scoringLoading()) {
      return 'Checking Games';
    }

    if (!this.cycleScoring()) {
      return 'Waiting for Scores';
    }

    if (!this.hasCurrentCycleScheduledGames()) {
      return 'No NHL Games Left';
    }

    if (this.isMatchupReadyToComplete(matchup)) {
      return 'Ready to Complete';
    }

    const gamesLeft = this.getMatchupRosterGamesLeft(matchup);
    const gameLabel = gamesLeft === 1 ? 'roster game' : 'roster games';

    return `Waiting on ${gamesLeft} ${gameLabel}`;
  }

  getCycleCompletionReadinessText(): string {
    const cycle = this.cycle();

    if (!cycle) {
      return `${this.getCycleLabel()} readiness will appear once the cycle starts.`;
    }

    if (cycle.status === 'complete') {
      return `${this.getCycleLabel()} is complete.`;
    }

    if (this.scoringLoading()) {
      return 'Checking whether all matchup roster games are complete...';
    }

    if (!this.cycleScoring()) {
      return 'Completion readiness will appear once current scoring loads.';
    }

    if (this.areAllMatchupsReadyToComplete()) {
      return `${this.getCycleLabel()} is ready and will complete automatically.`;
    }

    const gamesLeft = this.matchups().reduce(
      (total, matchup) => total + this.getMatchupRosterGamesLeft(matchup),
      0,
    );

    const gameLabel = gamesLeft === 1 ? 'roster game' : 'roster games';

    return `${this.getCycleLabel()} is waiting on ${gamesLeft} counted ${gameLabel}.`;
  }

  isWinningTeam(matchup: FantasyMatchup, ownerId: string | null): boolean {
    if (!ownerId || !this.isMatchupComplete(matchup)) {
      return false;
    }

    return matchup.winnerOwnerId === ownerId;
  }

  isLosingTeam(matchup: FantasyMatchup, ownerId: string | null): boolean {
    if (
      !ownerId ||
      !this.isMatchupComplete(matchup) ||
      !matchup.teamBOwnerId ||
      !matchup.winnerOwnerId
    ) {
      return false;
    }

    return matchup.winnerOwnerId !== ownerId;
  }

  getTeamResultLabel(matchup: FantasyMatchup, ownerId: string | null): string {
    if (!ownerId || !this.isMatchupComplete(matchup)) {
      return '';
    }

    if (!matchup.teamBOwnerId && ownerId === matchup.teamAOwnerId) {
      return 'Bye Win';
    }

    if (!matchup.winnerOwnerId) {
      return 'Tie';
    }

    return matchup.winnerOwnerId === ownerId ? 'Winner' : 'Lost';
  }

  async syncCurrentScoresToFirestore(): Promise<void> {
    this.syncScoreMessage.set('');
    this.syncScoreError.set('');
    this.syncingScores.set(true);

    try {
      await requestLeagueLiveScoringRefresh(this.leagueId);
      this.syncScoreMessage.set(
        'Shared scoring refresh requested. The league scorer will publish only if NHL data changed.',
      );
    } catch (error: unknown) {
      this.syncScoreError.set(
        error instanceof Error ? error.message : 'Unable to request a shared scoring refresh.',
      );
    } finally {
      this.syncingScores.set(false);
    }
  }

  getSharedScoringStatusLabel(): string {
    const control = this.liveScoringControl();

    if (!control) {
      return 'Waiting for shared scorer';
    }

    if (control.status === 'refreshing') {
      return 'Checking NHL scores';
    }

    if (control.status === 'error') {
      return 'Shared scorer needs attention';
    }

    return this.cycleScoring() ? 'Shared scoring active' : 'Waiting for first shared update';
  }

  getSharedScoringStatusText(): string {
    const control = this.liveScoringControl();

    if (control?.lastError) {
      return control.lastError;
    }

    const snapshot = this.sharedScoringSnapshot();

    if (snapshot?.result.refreshedAt) {
      return `Last NHL calculation: ${new Date(snapshot.result.refreshedAt).toLocaleString()}. Live games refresh about every 10 minutes.`;
    }

    return 'One commissioner browser calculates scores for the entire league. Other managers read the shared result.';
  }

  readonly forwardPositions: DraftPosition[] = ['LW', 'C', 'RW'];

  readonly defensePositions: DraftPosition[] = ['D'];

  readonly goaliePositions: DraftPosition[] = ['G'];

  readonly breakdownPositions: DraftPosition[] = ['LW', 'C', 'RW', 'D', 'G'];

  private routeSubscription: Subscription | null = null;
  private pageLoadRequestId = 0;
  private stopCyclesListener: (() => void) | null = null;
  private stopCycleListener: (() => void) | null = null;
  private stopMatchupsListener: (() => void) | null = null;
  private stopPicksListener: (() => void) | null = null;
  private stopCycleRosterPicksListener: (() => void) | null = null;
  private stopTeamWindowsListener: (() => void) | null = null;
  private stopSharedScoringListener: (() => void) | null = null;
  private stopLiveScoringControlListener: (() => void) | null = null;
  private stopDisplayedRosterListeners: (() => void)[] = [];
  private displayedRosterOwnerKey = '';
  private liveDraftPicks: DraftPick[] = [];
  private cycleRosterSnapshotPicks: DraftPick[] = [];
  private effectivePicksKey: string | null = null;
  private scheduleLoadStartedForCycleId: string | null = null;
  private scoringLoadKey: string | null = null;
  private scoringRequestId = 0;
  private sharedScoringRefreshRequestKey: string | null = null;
  private windowProgressSyncKey: string | null = null;
  private matchupCompletionSyncKey: string | null = null;
  private autoCompleteAttemptKey: string | null = null;
  private autoStartNextCycleAttemptKey: string | null = null;
  private projectionAccuracyAttemptKey: string | null = null;

  private refreshEffectivePicks(): void {
    const snapshotPicks = this.cycleRosterSnapshotPicks;
    const livePicks = this.liveDraftPicks;
    const effectivePicks = snapshotPicks.length > 0 ? snapshotPicks : livePicks;

    const source = snapshotPicks.length > 0 ? 'cycle-snapshot' : 'live-draft-picks';

    const nextKey = [
      source,
      effectivePicks
        .map((pick) => `${pick.rosterSlotId ?? pick.overallPick}:${pick.asset.assetKey}`)
        .join('|'),
    ].join('::');

    if (this.effectivePicksKey === nextKey) {
      return;
    }

    this.effectivePicksKey = nextKey;
    this.picks.set(effectivePicks);
    this.scoringLoadKey = null;
    this.cycleScoring.set(null);

    void this.loadCurrentCycleScoringIfReady();
  }

  private async loadCurrentCycleScoringIfReady(): Promise<void> {
    const cycle = this.cycle();
    const league = this.league();
    const picks = this.picks();

    if (!cycle || !league || picks.length === 0) {
      return;
    }

    const scoringKey = [
      cycle.id,
      cycle.activeWindowCount ?? 0,
      picks
        .map((pick) => `${pick.rosterSlotId ?? pick.overallPick}:${pick.asset.assetKey}`)
        .join('|'),
    ].join('::');

    if (this.scoringLoadKey === scoringKey) {
      const snapshot = this.sharedScoringSnapshot();

      if (snapshot) {
        await this.applySharedScoringSnapshot(snapshot);
      }

      return;
    }

    this.scoringLoadKey = scoringKey;
    this.scoringLoading.set(!this.sharedScoringSnapshot());
    this.scoringError.set('');

    const snapshot = this.sharedScoringSnapshot();

    if (snapshot) {
      await this.applySharedScoringSnapshot(snapshot);
      return;
    }

    if (this.isCommissioner() && this.sharedScoringRefreshRequestKey !== scoringKey) {
      this.sharedScoringRefreshRequestKey = scoringKey;

      try {
        await requestLeagueLiveScoringRefresh(this.leagueId);
      } catch (error: unknown) {
        this.scoringError.set(
          error instanceof Error ? error.message : 'Unable to request shared NHL scoring.',
        );
        this.scoringLoading.set(false);
      }
    }
  }

  private async applySharedScoringSnapshot(snapshot: SharedCycleScoringSnapshot): Promise<void> {
    if (snapshot.cycleNumber !== this.cycleNumber) {
      return;
    }

    const cycle = this.cycle();
    const picks = this.picks();
    const result = snapshot.result;

    this.sharedScoringSnapshot.set(snapshot);
    this.cycleScoring.set(result);
    this.scoringLoading.set(false);
    this.scoringError.set('');
    this.teamGameCounts.set({
      ...this.teamGameCounts(),
      ...result.teamGameCounts,
    });

    if (this.isCommissioner() && cycle && picks.length > 0) {
      await this.persistWindowProgressAndAdvance(cycle, picks, result);
    }

    void this.evaluateAutoCompleteCycleIfReady();
  }

  private async persistWindowProgressAndAdvance(
    cycle: FantasyCycle,
    picks: DraftPick[],
    scoring: CycleScoringResult,
  ): Promise<void> {
    const progressKey = [
      cycle.id,
      picks.length,
      ...Object.values(scoring.windowScores)
        .sort((first, second) => first.windowId.localeCompare(second.windowId))
        .map(
          (summary) =>
            `${summary.windowId}:${summary.status}:${summary.gamesPlayed}:${summary.currentScore}`,
        ),
    ].join('|');

    if (this.windowProgressSyncKey === progressKey) {
      return;
    }

    this.windowProgressSyncKey = progressKey;

    try {
      const windowSyncResult = await syncCycleTeamWindows(this.leagueId, cycle, picks, scoring);

      if (cycle.phase === 'regular_season') {
        const completionKey = [cycle.id, windowSyncResult.completionFingerprint].join('::');

        if (this.matchupCompletionSyncKey !== completionKey) {
          this.matchupCompletionSyncKey = completionKey;

          const completionResult = await reconcileRegularSeasonCycleMatchupCompletion(
            this.leagueId,
            cycle.cycleNumber,
          );

          if (completionResult.newlyCompletedMatchupIds.length > 0) {
            this.autoFlowMessage.set(
              completionResult.cycleCompleted
                ? `${this.getCycleLabel()} is complete. All matchup results were finalized and standings were updated.`
                : `${completionResult.newlyCompletedMatchupIds.length} matchup${completionResult.newlyCompletedMatchupIds.length === 1 ? '' : 's'} finalized. ${completionResult.pendingMatchupCount} still waiting on roster-slot windows.`,
            );
          }

          if (completionResult.cycleCompleted) {
            await this.saveCurrentCycleProjectionAccuracy();
            this.teams.set(await getLeagueTeams(this.leagueId));
          }
        }
      }

      if (cycle.phase === 'playoffs') {
        const playoffs = await getFantasyPlayoffs(this.leagueId);
        const league = this.league();

        if (playoffs && league) {
          const scoringRules = league.scoringRules ?? defaultScoringRules;
          const requiredGamesPerCycle =
            scoringRules.requiredGamesPerCycle ?? defaultScoringRules.requiredGamesPerCycle;
          const season = this.getNhlSeasonForDate(
            this.getProjectionWindowStartDate() ?? new Date(),
          );
          const banks = await syncPlayoffWindowBankScores({
            leagueId: this.leagueId,
            playoffs,
            season,
            requiredGamesPerCycle,
            scoringRules,
            assignedPicks: picks,
            assignedScoring: scoring,
          });

          await ensureNextPlayoffBankWindows({
            leagueId: this.leagueId,
            playoffs,
            banks,
          });
        }
      }

      try {
        await advanceCompletedRegularSeasonAssetWindows(
          this.leagueId,
          this.teams(),
          cycle,
          picks,
          scoring,
        );
      } catch (advanceError: unknown) {
        console.warn(
          'Current window progress was saved, but one or more next-window assignments could not be opened yet.',
          advanceError,
        );
      }
    } catch (error: unknown) {
      this.windowProgressSyncKey = null;
      this.matchupCompletionSyncKey = null;
      console.warn('Unable to save independent cycle-window progress.', error);
    }
  }

  private async evaluateAutoCompleteCycleIfReady(): Promise<void> {
    // Cycle completion and creation update shared league records.
    // Only the commissioner should run this browser-side automatic flow.
    if (!this.isCommissioner()) {
      return;
    }

    const cycle = this.cycle();
    const scoring = this.cycleScoring();
    const matchups = this.matchups();

    if (!cycle || cycle.status !== 'active') {
      return;
    }

    // Regular-season matchups now finalize independently from persisted
    // roster-slot windows. The legacy whole-cycle completion path remains for
    // playoff rounds until playoff-window routing is introduced.
    if (cycle.phase === 'regular_season') {
      return;
    }

    if (!scoring || matchups.length === 0) {
      return;
    }

    if (!this.hasCurrentCycleScheduledGames()) {
      this.autoFlowMessage.set(this.getNoMoreGamesMessage());
      return;
    }

    if (this.scoringLoading() || this.completingCycle()) {
      return;
    }

    if (!this.areAllMatchupsReadyToComplete()) {
      return;
    }

    const attemptKey = this.getAutoCompleteAttemptKey(cycle, scoring, matchups);

    if (this.autoCompleteAttemptKey === attemptKey) {
      return;
    }

    this.autoCompleteAttemptKey = attemptKey;
    this.autoFlowMessage.set(`${this.getCycleLabel()} is ready. Completing automatically...`);
    this.autoFlowError.set('');
    this.completeCycleMessage.set('');
    this.completeCycleError.set('');
    this.completingCycle.set(true);

    try {
      await completeCycle(this.leagueId, this.cycleNumber, matchups, scoring.teamScores);

      await this.saveCurrentCycleProjectionAccuracy();

      this.autoFlowMessage.set(
        cycle.phase === 'playoffs'
          ? `${this.getCycleLabel()} was completed automatically and the playoff bracket advanced.`
          : `${this.getCycleLabel()} was completed automatically and team records were updated.`,
      );

      this.teams.set(await getLeagueTeams(this.leagueId));

      await this.startOrOpenNextCycleAfterCompletion('automatic', true);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : `Unable to auto-complete ${this.getCycleLabel()}.`;

      if (message.includes('has already been completed')) {
        this.autoFlowMessage.set(`${this.getCycleLabel()} is already complete.`);
        return;
      }

      this.autoCompleteAttemptKey = null;
      this.autoFlowError.set(message);
    } finally {
      this.completingCycle.set(false);
    }
  }

  private getDisplayedProjectionByAssetKey(): Record<string, number | null> {
    const projections: Record<string, number | null> = {};

    for (const pick of this.picks()) {
      projections[pick.asset.assetKey] = this.getBestCycleProjection(pick.asset);
    }

    return projections;
  }

  private getProjectionAccuracyAttemptKey(): string | null {
    const cycle = this.cycle();
    const scoring = this.cycleScoring();
    const picks = this.picks();

    if (!cycle || !scoring || picks.length === 0) {
      return null;
    }

    const scoreKey = Object.values(scoring.assetScores)
      .sort((first, second) => first.assetKey.localeCompare(second.assetKey))
      .map(
        (summary) =>
          `${summary.assetKey}:${summary.currentScore}:${summary.actualGamesPlayed ?? 0}`,
      )
      .join('|');

    return [this.leagueId, cycle.id, cycle.cycleNumber, scoreKey].join('::');
  }

  private async saveCurrentCycleProjectionAccuracy(): Promise<void> {
    if (!this.isCommissioner()) {
      return;
    }

    const cycle = this.cycle();
    const scoring = this.cycleScoring();
    const picks = this.picks();
    const attemptKey = this.getProjectionAccuracyAttemptKey();

    if (
      !cycle ||
      cycle.projectionAccuracyStatus === 'complete' ||
      !scoring ||
      picks.length === 0 ||
      !attemptKey ||
      this.projectionAccuracySaving() ||
      this.projectionAccuracyAttemptKey === attemptKey
    ) {
      return;
    }

    this.projectionAccuracyAttemptKey = attemptKey;
    this.projectionAccuracySaving.set(true);
    this.projectionAccuracyError.set('');

    try {
      const result = await saveProjectionAccuracyForCycle({
        leagueId: this.leagueId,
        cycleId: cycle.id,
        cycleNumber: cycle.cycleNumber,
        picks,
        scoring,
        displayedProjectionByAssetKey: this.getDisplayedProjectionByAssetKey(),
      });

      this.projectionAccuracyMessage.set(
        `Projection accuracy saved for ${result.summary.gradedAssetCount} assets. Average error: ${result.summary.meanAbsoluteError.toFixed(1)} points.`,
      );
    } catch (error: unknown) {
      this.projectionAccuracyAttemptKey = null;
      this.projectionAccuracyError.set(
        error instanceof Error
          ? error.message
          : 'Unable to save projection accuracy for this cycle.',
      );
    } finally {
      this.projectionAccuracySaving.set(false);
    }
  }

  private async hasAnyRosterGamesForCycle(cycleNumber: number): Promise<boolean> {
    const league = this.league();
    const picks = this.picks();

    if (!league || picks.length === 0) {
      return false;
    }

    const scoringRules = league.scoringRules ?? defaultScoringRules;
    const requiredGamesPerCycle =
      scoringRules.requiredGamesPerCycle ?? defaultScoringRules.requiredGamesPerCycle;

    const startIndex = (cycleNumber - 1) * requiredGamesPerCycle;
    const endIndex = cycleNumber * requiredGamesPerCycle;
    const season = this.getNhlSeasonForDate(this.getProjectionWindowStartDate() ?? new Date());

    const teamAbbreviations = [
      ...new Set(picks.map((pick) => this.getAssetNhlTeamAbbreviation(pick.asset))),
    ];

    for (const teamAbbreviation of teamAbbreviations) {
      try {
        const schedule = await getNhlTeamSeasonSchedule(teamAbbreviation, season);

        if (schedule.slice(startIndex, endIndex).length > 0) {
          return true;
        }
      } catch (error: unknown) {
        console.warn(`Unable to check next-cycle games for ${teamAbbreviation}.`, error);
      }
    }

    return false;
  }

  private async startOrOpenNextCycleAfterCompletion(
    source: 'automatic' | 'manual',
    allowBeforeCycleSnapshotUpdates: boolean = false,
  ): Promise<void> {
    const cycle = this.cycle();

    if (!cycle) {
      return;
    }

    if (!allowBeforeCycleSnapshotUpdates && cycle.status !== 'complete') {
      return;
    }

    if (this.isFinalPlayoffRound()) {
      const message = 'The league championship is complete. Opening the final playoff bracket...';
      this.startNextCycleMessage.set(message);
      this.autoFlowMessage.set(message);

      await this.router.navigate(['/leagues', this.leagueId, 'playoffs']);
      return;
    }

    if (this.teams().length < 2) {
      const message = 'At least two teams are required to start the next matchup period.';
      this.startNextCycleError.set(message);
      this.autoFlowError.set(message);
      return;
    }

    const nextCycleNumber = this.cycleNumber + 1;

    // Every standard fantasy season uses exactly 13 complete six-game
    // periods (78 NHL team games). Playoff cycles may contain only a
    // subset of owners because higher seeds can have byes, so checking
    // the current cycle's roster snapshots could incorrectly stop the
    // season before a bye team returns in the following round.
    const nextCycleHasGames =
      nextCycleNumber <= STANDARD_FULL_CYCLE_SEASON_COUNT ||
      (await this.hasAnyRosterGamesForCycle(nextCycleNumber));

    if (!nextCycleHasGames) {
      const message = `No NHL team games were found for ${this.getNextCycleLabel()}. The season flow is stopping instead of creating an empty matchup period.`;
      this.startNextCycleMessage.set(message);
      this.autoFlowMessage.set(message);
      return;
    }

    const attemptKey = [this.leagueId, this.cycleNumber, cycle.id, this.getNextCycleLabel()].join(
      '::',
    );

    if (this.autoStartNextCycleAttemptKey === attemptKey || this.startingNextCycle()) {
      return;
    }

    this.autoStartNextCycleAttemptKey = attemptKey;
    this.startingNextCycle.set(true);
    this.startNextCycleMessage.set('');
    this.startNextCycleError.set('');
    this.autoFlowError.set('');

    const preparingMessage =
      source === 'automatic'
        ? `${this.getNextCycleLabel()} is being prepared automatically...`
        : `${this.getNextCycleLabel()} is being prepared...`;

    this.autoFlowMessage.set(preparingMessage);

    try {
      const nextCycle = await startNextCycle(this.leagueId, this.teams(), this.cycleNumber);

      if (!nextCycle) {
        const completeMessage =
          'The fantasy season is complete. Opening the final playoff bracket...';

        this.startNextCycleMessage.set(completeMessage);
        this.autoFlowMessage.set(completeMessage);

        await this.router.navigate(['/leagues', this.leagueId, 'playoffs']);
        return;
      }

      const successMessage =
        source === 'automatic'
          ? `${this.getNextCycleLabel()} was started automatically. Opening it now...`
          : `${this.getNextCycleLabel()} was started. Opening it now...`;

      this.startNextCycleMessage.set(successMessage);
      this.autoFlowMessage.set(successMessage);

      await this.router.navigate(['/leagues', this.leagueId, 'cycles', nextCycleNumber]);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : `Unable to start ${this.getNextCycleLabel()}.`;

      if (errorMessage.includes(`Cycle ${nextCycleNumber} has already been started`)) {
        const alreadyStartedMessage = `${this.getNextCycleLabel()} already exists. Opening it now...`;

        this.startNextCycleMessage.set(alreadyStartedMessage);
        this.autoFlowMessage.set(alreadyStartedMessage);

        await this.router.navigate(['/leagues', this.leagueId, 'cycles', nextCycleNumber]);

        return;
      }

      this.autoStartNextCycleAttemptKey = null;
      this.startNextCycleError.set(errorMessage);
      this.autoFlowError.set(errorMessage);
    } finally {
      this.startingNextCycle.set(false);
    }
  }

  private getAutoCompleteAttemptKey(
    cycle: FantasyCycle,
    scoring: CycleScoringResult,
    matchups: FantasyMatchup[],
  ): string {
    const teamScoreKey = Object.entries(scoring.teamScores)
      .sort(([firstOwnerId], [secondOwnerId]) => firstOwnerId.localeCompare(secondOwnerId))
      .map(([ownerId, score]) => `${ownerId}:${score}`)
      .join('|');

    const matchupKey = matchups.map((matchup) => `${matchup.id}:${matchup.status}`).join('|');

    return [this.leagueId, cycle.id, this.cycleNumber, teamScoreKey, matchupKey].join('::');
  }

  readonly myMatchup = computed(
    () =>
      this.matchups().find(
        (matchup) => matchup.teamAOwnerId === this.userId || matchup.teamBOwnerId === this.userId,
      ) ?? null,
  );

  readonly scheduleHasGamesInWindow = computed(() =>
    Object.values(this.teamGameCounts()).some((gameCount) => gameCount > 0),
  );

  constructor(
    private route: ActivatedRoute,
    private router: Router,
  ) {
    this.routeSubscription = this.route.paramMap.subscribe((params) => {
      void this.loadCyclePageFromParams(params);
    });
  }

  ngOnDestroy(): void {
    this.routeSubscription?.unsubscribe();
    this.stopLiveListeners();
  }

  private stopLiveListeners(): void {
    this.stopCyclesListener?.();
    this.stopCycleListener?.();
    this.stopMatchupsListener?.();
    this.stopPicksListener?.();
    this.stopCycleRosterPicksListener?.();
    this.stopTeamWindowsListener?.();
    this.stopSharedScoringListener?.();
    this.stopLiveScoringControlListener?.();
    this.stopDisplayedRosterListeners.forEach((stopListener) => stopListener());

    this.stopCyclesListener = null;
    this.stopCycleListener = null;
    this.stopMatchupsListener = null;
    this.stopPicksListener = null;
    this.stopCycleRosterPicksListener = null;
    this.stopTeamWindowsListener = null;
    this.stopSharedScoringListener = null;
    this.stopLiveScoringControlListener = null;
    this.stopDisplayedRosterListeners = [];
    this.displayedRosterOwnerKey = '';
  }

  private resetPageStateForNewRoute(): void {
    this.stopLiveListeners();

    this.matchupId = null;
    this.liveDraftPicks = [];
    this.cycleRosterSnapshotPicks = [];
    this.effectivePicksKey = null;

    this.league.set(null);
    this.teams.set([]);
    this.ownerFavoriteTeams.set({});
    this.allCycles.set([]);
    this.cycle.set(null);
    this.matchups.set([]);
    this.picks.set([]);
    this.playerPool.set([]);
    this.teamWindowsByOwner.set({});
    this.displayedRostersByOwner.set({});
    this.teamGameCounts.set({});
    this.cycleScoring.set(null);
    this.sharedScoringSnapshot.set(null);
    this.liveScoringControl.set(null);
    this.matchupView.set('both');

    this.scoringLoading.set(false);
    this.scoringError.set('');
    this.loading.set(true);
    this.errorMessage.set('');
    this.scheduleProjectionLoading.set(false);
    this.scheduleProjectionError.set('');
    this.syncingScores.set(false);
    this.syncScoreMessage.set('');
    this.syncScoreError.set('');
    this.completingCycle.set(false);
    this.completeCycleMessage.set('');
    this.completeCycleError.set('');
    this.startingNextCycle.set(false);
    this.startNextCycleMessage.set('');
    this.startNextCycleError.set('');
    this.autoFlowMessage.set('');
    this.autoFlowError.set('');
    this.projectionAccuracySaving.set(false);
    this.projectionAccuracyMessage.set('');
    this.projectionAccuracyError.set('');

    this.scheduleLoadStartedForCycleId = null;
    this.scoringLoadKey = null;
    this.windowProgressSyncKey = null;
    this.matchupCompletionSyncKey = null;
    this.autoCompleteAttemptKey = null;
    this.autoStartNextCycleAttemptKey = null;
    this.projectionAccuracyAttemptKey = null;
    this.scoringRequestId += 1;
    this.sharedScoringRefreshRequestKey = null;
  }

  async loadCyclePageFromParams(params: ParamMap): Promise<void> {
    const leagueId = params.get('leagueId');
    const cycleNumberRaw = params.get('cycleNumber') ?? '1';
    const parsedCycleNumber = Number(cycleNumberRaw);
    const cycleNumber =
      Number.isInteger(parsedCycleNumber) && parsedCycleNumber > 0 ? parsedCycleNumber : 1;

    const matchupId = params.get('matchupId');

    const requestId = ++this.pageLoadRequestId;
    this.resetPageStateForNewRoute();

    const user = await waitForAuthUser();

    if (requestId !== this.pageLoadRequestId) {
      return;
    }

    if (!leagueId || !user) {
      await this.router.navigate(['/']);
      return;
    }

    this.leagueId = leagueId;
    this.cycleNumber = cycleNumber;
    this.matchupId = matchupId;
    this.userId = user.uid;

    try {
      const [league, teams] = await Promise.all([
        getLeagueById(leagueId),
        getLeagueTeams(leagueId),
      ]);

      if (requestId !== this.pageLoadRequestId) {
        return;
      }

      if (!league) {
        this.errorMessage.set('League not found.');
        return;
      }

      this.league.set(league);
      this.teams.set(teams);
      void this.loadOwnerFavoriteTeams(teams.map((team) => team.ownerId));

      this.stopSharedScoringListener = listenToSharedCycleScoring(
        leagueId,
        cycleNumber,
        (snapshot) => {
          if (!snapshot) {
            this.scoringLoading.set(true);
            void this.loadCurrentCycleScoringIfReady();
            return;
          }

          void this.applySharedScoringSnapshot(snapshot);
        },
        (error) => {
          this.scoringLoading.set(false);
          this.scoringError.set(error.message);
        },
      );

      this.stopLiveScoringControlListener = listenToSharedLiveScoringControl(
        leagueId,
        (control) => {
          this.liveScoringControl.set(control);

          if (control?.status === 'error' && control.lastError) {
            this.scoringError.set(control.lastError);
          }
        },
      );

      this.stopCyclesListener = listenToLeagueCycles(leagueId, (cycles) => {
        this.allCycles.set(cycles);
      });

      this.stopCycleListener = listenToCycle(leagueId, cycleNumber, (cycle) => {
        this.cycle.set(cycle);
        void this.loadScheduleAdjustedProjectionData(cycle);
        void this.loadCurrentCycleScoringIfReady();
        void this.evaluateAutoCompleteCycleIfReady();
      });

      this.stopMatchupsListener = listenToCycleMatchups(leagueId, cycleNumber, (matchups) => {
        this.matchups.set(matchups);
        this.refreshDisplayedRosterListeners();
        void this.evaluateAutoCompleteCycleIfReady();
      });

      this.stopTeamWindowsListener = listenToCycleTeamWindows(
        leagueId,
        cycleNumber,
        (teamWindows) => {
          this.teamWindowsByOwner.set(
            Object.fromEntries(teamWindows.map((entry) => [entry.ownerId, entry])),
          );
        },
      );

      this.stopCycleRosterPicksListener = listenToCycleRosterPicks(
        leagueId,
        cycleNumber,
        (picks) => {
          this.cycleRosterSnapshotPicks = picks;
          this.refreshEffectivePicks();
        },
      );

      this.stopPicksListener = listenToDraftPicks(leagueId, (picks) => {
        this.liveDraftPicks = picks;
        this.refreshEffectivePicks();
      });

      void this.loadPlayerPoolForProjectionFallback();
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error ? error.message : `Unable to load ${this.getCycleLabel()}.`,
      );
    } finally {
      if (requestId === this.pageLoadRequestId) {
        this.loading.set(false);
      }
    }
  }

  getAvailableCycleNumbers(): number[] {
    const cycleNumbers = new Set<number>();

    for (const cycle of this.allCycles()) {
      if (
        typeof cycle.cycleNumber === 'number' &&
        Number.isInteger(cycle.cycleNumber) &&
        cycle.cycleNumber > 0
      ) {
        cycleNumbers.add(cycle.cycleNumber);
      }
    }

    cycleNumbers.add(this.cycleNumber);

    return [...cycleNumbers].sort((first, second) => first - second);
  }

  navigateToCycle(value: string | number): void {
    const targetCycleNumber = Number(value);

    if (
      !Number.isInteger(targetCycleNumber) ||
      targetCycleNumber < 1 ||
      targetCycleNumber === this.cycleNumber
    ) {
      return;
    }

    const route = this.matchupId
      ? ['/leagues', this.leagueId, 'cycles', targetCycleNumber, 'matchups', this.matchupId]
      : ['/leagues', this.leagueId, 'cycles', targetCycleNumber];

    void this.router.navigate(route);
  }


  private async loadOwnerFavoriteTeams(ownerIds: string[]): Promise<void> {
    const uniqueOwnerIds = [...new Set(ownerIds.filter((ownerId) => !!ownerId))];

    if (uniqueOwnerIds.length === 0) {
      return;
    }

    const knownFavoriteTeams = this.ownerFavoriteTeams();
    const unresolvedOwnerIds = uniqueOwnerIds.filter((ownerId) => !knownFavoriteTeams[ownerId]);

    if (unresolvedOwnerIds.length === 0) {
      return;
    }

    const resolvedEntries = await Promise.all(
      unresolvedOwnerIds.map(async (ownerId) => {
        try {
          const profile = await getUserProfile(ownerId);
          return [ownerId, profile?.favoriteTeamAbbreviation || this.getFallbackFavoriteTeam(ownerId)] as const;
        } catch {
          return [ownerId, this.getFallbackFavoriteTeam(ownerId)] as const;
        }
      }),
    );

    this.ownerFavoriteTeams.set({
      ...this.ownerFavoriteTeams(),
      ...Object.fromEntries(resolvedEntries),
    });
  }

  private getFallbackFavoriteTeam(ownerId: string): string {
    if (typeof document !== 'undefined' && ownerId === this.userId) {
      return document.documentElement.dataset['favoriteTeam'] || 'VGK';
    }

    return 'VGK';
  }

  getOwnerTheme(ownerId: string): PixelTeamTheme {
    return getPixelTeamTheme(this.ownerFavoriteTeams()[ownerId] || this.getFallbackFavoriteTeam(ownerId));
  }

  getOwnerThemeStyles(ownerId: string): Record<string, string> {
    const theme = this.getOwnerTheme(ownerId);

    return {
      '--owner-theme-primary': theme.primaryColor,
      '--owner-theme-secondary': theme.secondaryColor,
      '--owner-theme-highlight': theme.highlightColor,
      '--owner-theme-outline': `color-mix(in srgb, ${theme.primaryColor} 70%, #496685)`,
      '--owner-theme-outline-strong': `color-mix(in srgb, ${theme.primaryColor} 82%, #6f8eac)`,
      '--owner-theme-outline-soft': `color-mix(in srgb, ${theme.primaryColor} 30%, rgba(198, 213, 228, 0.16))`,
      '--owner-theme-subtle': `color-mix(in srgb, ${theme.primaryColor} 18%, transparent)`,
      '--owner-theme-surface': `color-mix(in srgb, ${theme.secondaryColor} 78%, #0b1322)`,
      '--owner-theme-surface-2': `color-mix(in srgb, ${theme.primaryColor} 12%, #101827)`,
      '--owner-theme-chip-background': `color-mix(in srgb, ${theme.highlightColor} 85%, ${theme.primaryColor} 15%)`,
      '--owner-theme-chip-text': `color-mix(in srgb, ${theme.secondaryColor} 88%, #0d1422 12%)`,
      '--owner-theme-glow': `color-mix(in srgb, ${theme.primaryColor} 22%, transparent)`,
      '--owner-theme-accent-text': `color-mix(in srgb, ${theme.highlightColor} 80%, #eff6ff)`,
    };
  }

  getCurrentDisplayedMatchup(): FantasyMatchup | null {
    return this.getDisplayedMatchups()[0] ?? null;
  }

  getCurrentDisplayedMatchupIndex(): number {
    const currentMatchup = this.getCurrentDisplayedMatchup();

    if (!currentMatchup) {
      return -1;
    }

    return this.matchups().findIndex((matchup) => matchup.id === currentMatchup.id);
  }

  getPreviousMatchup(): FantasyMatchup | null {
    const matchups = this.matchups();
    const currentIndex = this.getCurrentDisplayedMatchupIndex();

    if (matchups.length <= 1 || currentIndex === -1) {
      return null;
    }

    const previousIndex = (currentIndex - 1 + matchups.length) % matchups.length;

    return matchups[previousIndex] ?? null;
  }

  getNextMatchup(): FantasyMatchup | null {
    const matchups = this.matchups();
    const currentIndex = this.getCurrentDisplayedMatchupIndex();

    if (matchups.length <= 1 || currentIndex === -1) {
      return null;
    }

    const nextIndex = (currentIndex + 1) % matchups.length;

    return matchups[nextIndex] ?? null;
  }

  getMatchupNavigationTitle(matchup: FantasyMatchup | null): string {
    if (!matchup) {
      return 'No matchup';
    }

    return `${this.getTeamName(matchup.teamAOwnerId)} vs ${this.getTeamName(matchup.teamBOwnerId)}`;
  }

  openMatchup(matchup: FantasyMatchup | null): void {
    if (!matchup) {
      return;
    }

    void this.router.navigate([
      '/leagues',
      this.leagueId,
      'cycles',
      this.cycleNumber,
      'matchups',
      matchup.id,
    ]);
  }

  openPreviousMatchup(): void {
    this.openMatchup(this.getPreviousMatchup());
  }

  openNextMatchup(): void {
    this.openMatchup(this.getNextMatchup());
  }

  getCycleLabel(): string {
    const cycle = this.cycle();

    if (cycle?.phase === 'playoffs') {
      return cycle.playoffRoundLabel ?? `Playoff Cycle ${this.cycleNumber}`;
    }

    return `Cycle ${this.cycleNumber}`;
  }

  getNextCycleLabel(): string {
    const cycle = this.cycle();

    if (cycle?.phase === 'playoffs') {
      const roundNumber = cycle.playoffRoundNumber ?? 1;
      const roundCount = cycle.playoffRoundCount ?? roundNumber;

      if (roundNumber >= roundCount) {
        return 'Season Complete';
      }

      return getPlayoffRoundLabel(roundNumber + 1, roundCount);
    }

    const teamCount = this.teams().length;
    const regularSeasonCycleCount = getStandardRegularSeasonCycleCount(teamCount);

    if (this.cycleNumber >= regularSeasonCycleCount) {
      const playoffTeamCount = getStandardPlayoffTeamCount(teamCount);
      const playoffRoundCount = getStandardPlayoffRoundCount(playoffTeamCount);

      return getPlayoffRoundLabel(1, playoffRoundCount);
    }

    return `Cycle ${this.cycleNumber + 1}`;
  }

  isFinalPlayoffRound(): boolean {
    const cycle = this.cycle();

    return Boolean(
      cycle?.phase === 'playoffs' &&
      cycle.playoffRoundNumber &&
      cycle.playoffRoundCount &&
      cycle.playoffRoundNumber >= cycle.playoffRoundCount,
    );
  }

  getDetailedMatchupHeading(): string {
    if (this.matchupId) {
      return `${this.getCycleLabel()} ${this.matchupId}`;
    }

    if (this.myMatchup()) {
      return `Your ${this.getCycleLabel()} Matchup`;
    }

    return `${this.getCycleLabel()} Matchup Detail`;
  }

  getDisplayedMatchups(): FantasyMatchup[] {
    const matchups = this.matchups();

    if (this.matchupId) {
      return matchups.filter((matchup) => matchup.id === this.matchupId);
    }

    const myMatchup = this.myMatchup();

    if (myMatchup) {
      return [myMatchup];
    }

    return matchups.slice(0, 1);
  }

  getNoDisplayedMatchupMessage(): string {
    if (this.matchupId) {
      return `${this.matchupId} was not found for ${this.getCycleLabel()}.`;
    }

    return `No matchup was found for ${this.getCycleLabel()}.`;
  }

  getCurrentCycleWindowCounts(): {
    complete: number;
    started: number;
    total: number;
  } {
    const teamWindows = Object.values(this.teamWindowsByOwner());
    const total = teamWindows.reduce((sum, team) => sum + team.expectedRosterSlotIds.length, 0);
    const complete = teamWindows.reduce((sum, team) => sum + team.completedWindowCount, 0);
    const started = teamWindows.reduce(
      (sum, team) => sum + team.windows.filter((window) => window.status !== 'scheduled').length,
      0,
    );

    return { complete, started, total };
  }

  getNextCycleStartedWindowCount(): number {
    return (
      this.allCycles().find((cycle) => cycle.cycleNumber === this.cycleNumber + 1)
        ?.activeWindowCount ?? 0
    );
  }

  getDisplayedQueuedMoveCount(): number {
    return Object.values(this.displayedRostersByOwner()).reduce(
      (sum, roster) => sum + roster.activeSlots.filter((slot) => Boolean(slot.pendingMove)).length,
      0,
    );
  }

  getTeamWindowProgressLabel(ownerId: string | null): string {
    if (!ownerId) {
      return 'Bye';
    }

    const teamWindows = this.teamWindowsByOwner()[ownerId];

    if (!teamWindows) {
      return 'Window data is initializing';
    }

    const total = teamWindows.expectedRosterSlotIds.length;
    const complete = teamWindows.completedWindowCount;
    const pending = Math.max(0, total - complete);

    return pending === 0
      ? `${complete}/${total} slots complete`
      : `${complete}/${total} complete · ${pending} waiting`;
  }

  getPendingSlotLabels(ownerId: string | null): string[] {
    if (!ownerId) {
      return [];
    }

    const teamWindows = this.teamWindowsByOwner()[ownerId];

    if (!teamWindows) {
      return [];
    }

    const completedSlotIds = new Set(
      teamWindows.windows
        .filter((window) => window.status === 'complete')
        .map((window) => window.rosterSlotId),
    );

    return teamWindows.expectedRosterSlotIds.filter((slotId) => !completedSlotIds.has(slotId));
  }

  getWindowForPick(pick: DraftPick): FantasyAssetCycleWindow | null {
    const teamWindows = this.teamWindowsByOwner()[pick.ownerId];

    if (!teamWindows) {
      return null;
    }

    if (pick.rosterSlotId) {
      const slotWindow = teamWindows.windows.find(
        (window) => window.rosterSlotId === pick.rosterSlotId,
      );

      if (slotWindow) {
        return slotWindow;
      }
    }

    return teamWindows.windows.find((window) => window.assetKey === pick.asset.assetKey) ?? null;
  }

  getWindowGameMarkers(pick: DraftPick): CycleWindowGameMarker[] {
    const window = this.getWindowForPick(pick);
    const requiredGames = this.league()?.scoringRules?.requiredGamesPerCycle ?? 6;

    return Array.from({ length: requiredGames }, (_, index) => {
      const gameId = window?.scheduledGameIds[index] ?? null;
      const gameDate = window?.scheduledGameDates[index] ?? null;
      const gameLabel = window?.scheduledGameLabels[index] ?? 'Schedule pending';
      const completed = Boolean(gameId && window?.completedGameIds.includes(gameId));
      const hasAppearanceData = Boolean(window?.appearanceGameIds.length);
      const inferredAllAppearances = Boolean(
        window &&
        window.actualGamesPlayed === window.completedGameIds.length &&
        window.completedGameIds.length > 0,
      );
      const appeared = Boolean(
        gameId &&
        (window?.appearanceGameIds.includes(gameId) ||
          (!hasAppearanceData && inferredAllAppearances)),
      );

      let status: CycleWindowGameMarker['status'] = 'unavailable';
      let statusLabel = 'Not scheduled';

      if (gameId && completed && appeared) {
        status = 'played';
        statusLabel = 'Played';
      } else if (gameId && completed) {
        status = 'missed';
        statusLabel = 'Counted team game · no appearance';
      } else if (gameId) {
        status = 'upcoming';
        statusLabel = 'Upcoming';
      }

      const dateLabel = gameDate
        ? new Date(`${gameDate}T12:00:00`).toLocaleDateString()
        : 'Date pending';

      return {
        index: index + 1,
        gameId,
        gameDate,
        gameLabel,
        status,
        statusLabel,
        title: `Game ${index + 1}: ${gameLabel} · ${dateLabel} · ${statusLabel}${gameId ? ` · NHL game ${gameId}` : ''}`,
      };
    });
  }

  getWindowStatusLabel(pick: DraftPick): string {
    const window = this.getWindowForPick(pick);

    if (!window) {
      return 'Window initializing';
    }

    if (window.status === 'complete') {
      return `Cycle ${window.cycleNumber} window complete`;
    }

    if (window.status === 'active') {
      return `Cycle ${window.cycleNumber} · ${window.gamesPlayed}/${window.scheduledGames} counted`;
    }

    return `Cycle ${window.cycleNumber} · waiting for first game`;
  }

  getPendingMoveForPick(pick: DraftPick): PendingRosterSlotMove | null {
    if (!pick.rosterSlotId) {
      return null;
    }

    const roster = this.displayedRostersByOwner()[pick.ownerId];
    const slot = roster?.activeSlots.find((candidate) => candidate.slotId === pick.rosterSlotId);

    return slot?.pendingMove ?? null;
  }

  getPendingMoveAssetName(move: PendingRosterSlotMove): string {
    return move.incomingAsset.assetType === 'skater'
      ? move.incomingAsset.player.fullName
      : `${move.incomingAsset.teamName} Goalie Unit`;
  }

  stopCardNavigation(event: Event): void {
    event.stopPropagation();
  }

  private refreshDisplayedRosterListeners(): void {
    const matchup = this.getCurrentDisplayedMatchup();
    const ownerIds = [matchup?.teamAOwnerId ?? null, matchup?.teamBOwnerId ?? null]
      .filter((ownerId): ownerId is string => Boolean(ownerId))
      .sort();
    const ownerKey = ownerIds.join('|');

    if (ownerKey === this.displayedRosterOwnerKey) {
      return;
    }

    this.stopDisplayedRosterListeners.forEach((stopListener) => stopListener());
    this.stopDisplayedRosterListeners = [];
    this.displayedRosterOwnerKey = ownerKey;
    this.displayedRostersByOwner.set({});

    for (const ownerId of ownerIds) {
      const stopListener = listenToFantasyRoster(this.leagueId, ownerId, (roster) => {
        this.displayedRostersByOwner.update((current) => {
          const next = { ...current };

          if (roster) {
            next[ownerId] = roster;
          } else {
            delete next[ownerId];
          }

          return next;
        });
      });

      this.stopDisplayedRosterListeners.push(stopListener);
    }
  }

  getTeamName(ownerId: string | null): string {
    if (!ownerId) {
      return 'Bye';
    }

    return this.teams().find((team) => team.ownerId === ownerId)?.teamName ?? 'Unknown Team';
  }

  getTeamRecord(ownerId: string | null): string {
    if (!ownerId) {
      return '';
    }

    const team = this.teams().find((candidate) => candidate.ownerId === ownerId);

    if (!team) {
      return '';
    }

    return `${team.wins}-${team.losses}-${team.ties}`;
  }

  getTeamPicks(ownerId: string | null): DraftPick[] {
    if (!ownerId) {
      return [];
    }

    return this.picks()
      .filter((pick) => pick.ownerId === ownerId)
      .sort((first, second) => {
        const positionComparison =
          this.getPositionSortValue(first.asset.position) -
          this.getPositionSortValue(second.asset.position);

        if (positionComparison !== 0) {
          return positionComparison;
        }

        return this.getAssetName(first.asset).localeCompare(this.getAssetName(second.asset));
      });
  }

  getTeamPicksByPosition(ownerId: string | null, position: DraftPosition): DraftPick[] {
    return this.getTeamPicks(ownerId).filter((pick) => pick.asset.position === position);
  }

  getProjectedCycleForTeam(ownerId: string | null): number | null {
    const picks = this.getTeamPicks(ownerId);

    if (picks.length === 0) {
      return null;
    }

    const projectionTotal = picks.reduce(
      (total, pick) => total + (this.getBestCycleProjection(pick.asset) ?? 0),
      0,
    );

    return Number(projectionTotal.toFixed(1));
  }

  getProjectedSeasonForTeam(ownerId: string | null): number | null {
    const picks = this.getTeamPicks(ownerId);

    if (picks.length === 0) {
      return null;
    }

    const projectionTotal = picks.reduce(
      (total, pick) => total + (this.getAssetProjectedSeason(pick.asset) ?? 0),
      0,
    );

    return Number(projectionTotal.toFixed(1));
  }

  getProjectedWinnerLabel(matchup: FantasyMatchup): string {
    if (matchup.status === 'complete' || this.cycle()?.status === 'complete') {
      if (!matchup.teamBOwnerId) {
        return `Final: ${this.getTeamName(matchup.teamAOwnerId)} had a bye.`;
      }

      if (matchup.teamAScore === matchup.teamBScore) {
        return `Final: Tie, ${matchup.teamAScore.toFixed(1)} to ${matchup.teamBScore.toFixed(1)}.`;
      }

      const winnerOwnerId =
        matchup.winnerOwnerId ??
        (matchup.teamAScore > matchup.teamBScore ? matchup.teamAOwnerId : matchup.teamBOwnerId);

      const difference = Math.abs(matchup.teamAScore - matchup.teamBScore);

      return `Final: ${this.getTeamName(winnerOwnerId)} won by ${difference.toFixed(1)}.`;
    }

    if (!matchup.teamBOwnerId) {
      return `${this.getTeamName(matchup.teamAOwnerId)} has a bye.`;
    }

    const teamAProjection = this.getProjectedCycleForTeam(matchup.teamAOwnerId);

    const teamBProjection = this.getProjectedCycleForTeam(matchup.teamBOwnerId);

    if (typeof teamAProjection !== 'number' || typeof teamBProjection !== 'number') {
      return 'Projection unavailable';
    }

    if (teamAProjection === teamBProjection) {
      return 'Projected tie';
    }

    const winnerOwnerId =
      teamAProjection > teamBProjection ? matchup.teamAOwnerId : matchup.teamBOwnerId;

    const difference = Math.abs(teamAProjection - teamBProjection);

    return `${this.getTeamName(winnerOwnerId)} by ${difference.toFixed(1)}`;
  }

  isMyMatchup(matchup: FantasyMatchup): boolean {
    return matchup.teamAOwnerId === this.userId || matchup.teamBOwnerId === this.userId;
  }

  getProjectionDisplay(value: number | null | undefined): string {
    if (typeof value !== 'number') {
      return '—';
    }

    return value.toFixed(1);
  }

  getSignedProjectionDisplay(value: number | null | undefined): string {
    if (typeof value !== 'number') {
      return '—';
    }

    if (value > 0) {
      return `+${value.toFixed(1)}`;
    }

    return value.toFixed(1);
  }

  isPositiveDelta(value: number | null | undefined): boolean {
    return typeof value === 'number' && value > 0;
  }

  isNegativeDelta(value: number | null | undefined): boolean {
    return typeof value === 'number' && value < 0;
  }

  isMeaningfulPositiveProjectionDelta(
    actual: number | null | undefined,
    projected: number | null | undefined,
  ): boolean {
    const delta = this.getProjectionDelta(actual, projected);
    const neutralThreshold = this.getProjectionNeutralThreshold(projected);

    return (
      typeof delta === 'number' && typeof neutralThreshold === 'number' && delta >= neutralThreshold
    );
  }

  isMeaningfulNegativeProjectionDelta(
    actual: number | null | undefined,
    projected: number | null | undefined,
  ): boolean {
    const delta = this.getProjectionDelta(actual, projected);
    const neutralThreshold = this.getProjectionNeutralThreshold(projected);

    return (
      typeof delta === 'number' &&
      typeof neutralThreshold === 'number' &&
      delta <= -neutralThreshold
    );
  }

  isNeutralProjectionDelta(
    actual: number | null | undefined,
    projected: number | null | undefined,
  ): boolean {
    const delta = this.getProjectionDelta(actual, projected);
    const neutralThreshold = this.getProjectionNeutralThreshold(projected);

    return (
      typeof delta === 'number' &&
      typeof neutralThreshold === 'number' &&
      Math.abs(delta) < neutralThreshold
    );
  }

  private getProjectionDelta(
    actual: number | null | undefined,
    projected: number | null | undefined,
  ): number | null {
    if (typeof actual !== 'number' || typeof projected !== 'number') {
      return null;
    }

    return Number((actual - projected).toFixed(1));
  }

  private getProjectionNeutralThreshold(projected: number | null | undefined): number | null {
    if (typeof projected !== 'number') {
      return null;
    }

    return Math.max(PROJECTION_NEUTRAL_POINTS, Math.abs(projected) * PROJECTION_NEUTRAL_PERCENT);
  }

  getMatchupTeamProjectionDelta(matchup: FantasyMatchup, ownerId: string | null): number | null {
    if (!ownerId) {
      return null;
    }

    const actual = this.getMatchupTeamCurrentScore(matchup, ownerId);
    const projected = this.getProjectedCycleForTeam(ownerId);

    if (typeof projected !== 'number') {
      return null;
    }

    return Number((actual - projected).toFixed(1));
  }

  getPositionProjectionDelta(ownerId: string | null, position: DraftPosition): number | null {
    if (!ownerId) {
      return null;
    }

    const actual = this.getPositionCurrentTotal(ownerId, position);
    const projected = this.getPositionProjectedTotal(ownerId, position);

    if (typeof projected !== 'number') {
      return null;
    }

    return Number((actual - projected).toFixed(1));
  }

  getPositionBreakdownRows(ownerId: string | null): MatchupPositionBreakdownRow[] {
    if (!ownerId) {
      return [];
    }

    return this.breakdownPositions.map((position) => {
      const actual = this.getPositionCurrentTotal(ownerId, position);
      const projected = this.getPositionProjectedTotal(ownerId, position);
      const delta = typeof projected === 'number' ? Number((actual - projected).toFixed(1)) : null;

      return {
        position,
        label: position,
        actual,
        projected,
        delta,
      };
    });
  }

  getMatchupAssetPerformanceRows(matchup: FantasyMatchup): MatchupAssetPerformanceRow[] {
    const ownerIds = [matchup.teamAOwnerId, matchup.teamBOwnerId].filter(
      (ownerId): ownerId is string => Boolean(ownerId),
    );

    return ownerIds.flatMap((ownerId) =>
      this.getTeamPicks(ownerId).map((pick) => {
        const actual = this.getAssetCurrentCycleScore(pick.asset);
        const projected = this.getBestCycleProjection(pick.asset);
        const delta =
          typeof projected === 'number' ? Number((actual - projected).toFixed(1)) : null;

        return {
          asset: pick.asset,
          ownerId,
          teamName: this.getTeamName(ownerId),
          actual,
          projected,
          delta,
          position: pick.asset.position,
        };
      }),
    );
  }

  getTopContributors(matchup: FantasyMatchup, limit: number = 5): MatchupAssetPerformanceRow[] {
    return [...this.getMatchupAssetPerformanceRows(matchup)]
      .sort((first, second) => {
        if (second.actual !== first.actual) {
          return second.actual - first.actual;
        }

        return this.getAssetName(first.asset).localeCompare(this.getAssetName(second.asset));
      })
      .slice(0, limit);
  }

  getTopOverPerformers(matchup: FantasyMatchup, limit: number = 5): MatchupAssetPerformanceRow[] {
    return [...this.getMatchupAssetPerformanceRows(matchup)]
      .filter((row) => this.isMeaningfulPositiveProjectionDelta(row.actual, row.projected))
      .sort((first, second) => {
        const secondDelta = second.delta ?? 0;
        const firstDelta = first.delta ?? 0;

        if (secondDelta !== firstDelta) {
          return secondDelta - firstDelta;
        }

        return second.actual - first.actual;
      })
      .slice(0, limit);
  }

  getTopUnderPerformers(matchup: FantasyMatchup, limit: number = 5): MatchupAssetPerformanceRow[] {
    return [...this.getMatchupAssetPerformanceRows(matchup)]
      .filter((row) => this.isMeaningfulNegativeProjectionDelta(row.actual, row.projected))
      .sort((first, second) => {
        const secondDelta = second.delta ?? 0;
        const firstDelta = first.delta ?? 0;

        if (firstDelta !== secondDelta) {
          return firstDelta - secondDelta;
        }

        return first.actual - second.actual;
      })
      .slice(0, limit);
  }

  getMatchupBreakdownSummary(matchup: FantasyMatchup): string {
    if (!matchup.teamBOwnerId) {
      return `${this.getTeamName(matchup.teamAOwnerId)} had a bye this cycle.`;
    }

    const teamADelta = this.getMatchupTeamProjectionDelta(matchup, matchup.teamAOwnerId);

    const teamBDelta = this.getMatchupTeamProjectionDelta(matchup, matchup.teamBOwnerId);

    if (typeof teamADelta !== 'number' || typeof teamBDelta !== 'number') {
      return 'Projection comparison will appear once projected totals are available.';
    }

    const swing = Number((teamADelta - teamBDelta).toFixed(1));

    if (swing === 0) {
      return 'Both teams performed the same amount above or below their projections.';
    }

    const betterOwnerId = swing > 0 ? matchup.teamAOwnerId : matchup.teamBOwnerId;

    return `${this.getTeamName(betterOwnerId)} had a ${Math.abs(swing).toFixed(1)} point projection swing in this matchup.`;
  }

  getAssetName(asset: DraftableAsset): string {
    return asset.assetType === 'skater' ? asset.player.fullName : `${asset.teamName} Goalie Unit`;
  }

  getAssetTeamLabel(asset: DraftableAsset): string {
    return asset.assetType === 'skater' ? asset.player.nhlTeamAbbreviation : asset.teamAbbreviation;
  }

  getAssetLogoUrl(asset: DraftableAsset): string | undefined {
    return asset.assetType === 'skater' ? asset.player.teamLogoUrl : asset.teamLogoUrl;
  }

  getPositionLabel(position: DraftPosition): string {
    switch (position) {
      case 'LW':
        return 'Left Wing';

      case 'C':
        return 'Center';

      case 'RW':
        return 'Right Wing';

      case 'D':
        return 'Defense';

      case 'G':
        return 'Goalie Unit';

      default:
        return position;
    }
  }

  getAssetProjectedSeason(asset: DraftableAsset): number | null {
    const poolAsset = this.playerPool().find(
      (availableAsset) => availableAsset.assetKey === asset.assetKey,
    );

    return asset.projectedSeasonPoints ?? poolAsset?.projectedSeasonPoints ?? null;
  }

  getBestCycleProjection(asset: DraftableAsset): number | null {
    // Cycle projections are immutable once the cycle roster snapshot exists.
    // NHL schedule and scoring requests update actual results only.
    return getFrozenCycleProjection(asset);
  }

  getAssetScoreSummary(asset: DraftableAsset): CycleAssetScoreSummary | null {
    return this.cycleScoring()?.assetScores[asset.assetKey] ?? null;
  }

  getAssetCurrentCycleScore(asset: DraftableAsset): number {
    return this.getAssetScoreSummary(asset)?.currentScore ?? 0;
  }

  getAssetGamesPlayed(asset: DraftableAsset): number {
    return this.getAssetScoreSummary(asset)?.gamesPlayed ?? 0;
  }

  getAssetGamesLeft(asset: DraftableAsset): number {
    const summary = this.getAssetScoreSummary(asset);

    if (summary) {
      return summary.gamesLeft;
    }

    return Math.max(0, this.getAssetScheduledGames(asset));
  }

  getTeamCurrentCycleScore(ownerId: string | null): number {
    if (!ownerId) {
      return 0;
    }

    const scoringTotal = this.cycleScoring()?.teamScores[ownerId];

    if (typeof scoringTotal === 'number') {
      return scoringTotal;
    }

    return Number(
      this.getTeamPicks(ownerId)
        .reduce((total, pick) => total + this.getAssetCurrentCycleScore(pick.asset), 0)
        .toFixed(1),
    );
  }

  getMatchupTeamCurrentScore(matchup: FantasyMatchup, ownerId: string | null): number {
    if (!ownerId) {
      return 0;
    }

    if (this.isMatchupComplete(matchup)) {
      if (ownerId === matchup.teamAOwnerId) {
        return matchup.teamAScore;
      }

      if (ownerId === matchup.teamBOwnerId) {
        return matchup.teamBScore;
      }
    }

    return this.getTeamCurrentCycleScore(ownerId);
  }

  getCurrentScoringStatusText(): string {
    if (!this.cycle()) {
      return `Current scoring will appear once ${this.getCycleLabel()} starts.`;
    }

    if (this.scoringLoading()) {
      return 'Loading current fantasy scoring from final NHL games...';
    }

    if (this.scoringError()) {
      return this.scoringError();
    }

    if (!this.cycleScoring()) {
      return 'Current scoring is waiting for drafted player data.';
    }

    if (!this.hasCurrentCycleScheduledGames()) {
      return this.getNoMoreGamesMessage();
    }

    const scoringRules = this.league()?.scoringRules ?? defaultScoringRules;
    const requiredGamesPerCycle =
      scoringRules.requiredGamesPerCycle ?? defaultScoringRules.requiredGamesPerCycle;
    const firstGameNumber = (this.cycleNumber - 1) * requiredGamesPerCycle + 1;
    const lastGameNumber = this.cycleNumber * requiredGamesPerCycle;

    return `Current scores use each asset's NHL team games ${firstGameNumber}-${lastGameNumber}. Missed games count as 0-point counted games.`;
  }

  getAssetScheduledGames(asset: DraftableAsset): number {
    const requiredGames = this.league()?.scoringRules?.requiredGamesPerCycle ?? 6;

    if (!this.scheduleHasGamesInWindow()) {
      return requiredGames;
    }

    const teamAbbreviation = this.getAssetNhlTeamAbbreviation(asset);

    const gameCount = this.teamGameCounts()[teamAbbreviation];

    if (typeof gameCount !== 'number') {
      return requiredGames;
    }

    return Math.min(gameCount, requiredGames);
  }

  getPositionCurrentTotal(ownerId: string | null, position: DraftPosition): number {
    return this.getTeamPicksByPosition(ownerId, position).reduce(
      (total, pick) => total + this.getAssetCurrentCycleScore(pick.asset),
      0,
    );
  }

  getPositionProjectedTotal(ownerId: string | null, position: DraftPosition): number | null {
    const picks = this.getTeamPicksByPosition(ownerId, position);

    if (picks.length === 0) {
      return null;
    }

    const projectionTotal = picks.reduce(
      (total, pick) => total + (this.getBestCycleProjection(pick.asset) ?? 0),
      0,
    );

    return Number(projectionTotal.toFixed(1));
  }

  getPositionGamesPlayed(ownerId: string | null, position: DraftPosition): number {
    return this.getTeamPicksByPosition(ownerId, position).reduce(
      (total, pick) => total + this.getAssetGamesPlayed(pick.asset),
      0,
    );
  }

  getPositionGamesLeft(ownerId: string | null, position: DraftPosition): number {
    return this.getTeamPicksByPosition(ownerId, position).reduce(
      (total, pick) => total + this.getAssetGamesLeft(pick.asset),
      0,
    );
  }

  getProjectionWindowLabel(): string {
    const startDate = this.getProjectionWindowStartDate();
    const endDate = this.getProjectionWindowEndDate();

    if (!startDate || !endDate) {
      return `Projection window will appear once ${this.getCycleLabel()} has a start time.`;
    }

    return `${startDate.toLocaleDateString()} – ${endDate.toLocaleDateString()}`;
  }

  getScheduleProjectionStatusText(): string {
    if (this.scheduleProjectionLoading()) {
      return 'Loading NHL schedules...';
    }

    if (this.scheduleProjectionError()) {
      return this.scheduleProjectionError();
    }

    if (!this.scheduleHasGamesInWindow()) {
      const requiredGames = this.league()?.scoringRules?.requiredGamesPerCycle ?? 6;

      return `No NHL games found in this window. Using ${requiredGames} projected games per player until games are available.`;
    }

    return 'NHL schedules are loaded for game progress. Projections remain frozen at the value saved when the cycle started.';
  }

  private async loadPlayerPoolForProjectionFallback(): Promise<void> {
    try {
      this.playerPool.set(await loadDraftPlayerPool(true));
    } catch (error: unknown) {
      console.warn('Unable to load player pool projection fallback.', error);
    }
  }

  private async loadScheduleAdjustedProjectionData(cycle: FantasyCycle | null): Promise<void> {
    if (!cycle) {
      return;
    }

    if (this.scheduleLoadStartedForCycleId === cycle.id) {
      return;
    }

    this.scheduleLoadStartedForCycleId = cycle.id;
    this.scheduleProjectionLoading.set(true);
    this.scheduleProjectionError.set('');

    const startDate = this.getProjectionWindowStartDate() ?? new Date();

    const endDate = this.getProjectionWindowEndDateFromStart(startDate);

    const season = this.getNhlSeasonForDate(startDate);

    const gameCounts: Record<string, number> = {};

    try {
      for (let index = 0; index < NHL_DRAFT_CLUBS.length; index += NHL_SCHEDULE_BATCH_SIZE) {
        const batch = NHL_DRAFT_CLUBS.slice(index, index + NHL_SCHEDULE_BATCH_SIZE);

        const results = await Promise.allSettled(
          batch.map(async (club) => {
            const schedule = await getNhlTeamSeasonSchedule(club.abbreviation, season);

            const gameCount = schedule.filter((game) =>
              this.isGameInProjectionWindow(game.gameDate, startDate, endDate),
            ).length;

            return {
              teamAbbreviation: club.abbreviation,
              gameCount,
            };
          }),
        );

        for (const result of results) {
          if (result.status === 'fulfilled') {
            gameCounts[result.value.teamAbbreviation] = result.value.gameCount;
          } else {
            console.warn('Unable to load one NHL team schedule.', result.reason);
          }
        }

        await this.wait(125);
      }

      this.teamGameCounts.set(gameCounts);
    } catch (error: unknown) {
      this.scheduleProjectionError.set(
        error instanceof Error ? error.message : 'Unable to load NHL schedule projections.',
      );
    } finally {
      this.scheduleProjectionLoading.set(false);
    }
  }

  private getAssetNhlTeamAbbreviation(asset: DraftableAsset): string {
    return asset.assetType === 'skater' ? asset.player.nhlTeamAbbreviation : asset.teamAbbreviation;
  }

  private getProjectionWindowStartDate(): Date | null {
    const historicalTestDate = getHistoricalScoringTestDate();

    if (historicalTestDate) {
      return historicalTestDate;
    }

    const cycle = this.cycle();

    return this.getDateFromUnknown(cycle?.startedAt);
  }

  private getProjectionWindowEndDate(): Date | null {
    const startDate = this.getProjectionWindowStartDate();

    if (!startDate) {
      return null;
    }

    return this.getProjectionWindowEndDateFromStart(startDate);
  }

  private getProjectionWindowEndDateFromStart(startDate: Date): Date {
    const endDate = new Date(startDate);

    endDate.setDate(endDate.getDate() + CYCLE_PROJECTION_WINDOW_DAYS);

    return endDate;
  }

  private getDateFromUnknown(value: unknown): Date | null {
    if (!value) {
      return null;
    }

    if (value instanceof Date) {
      return value;
    }

    if (typeof value === 'object' && value !== null && 'toDate' in value) {
      const timestampLike = value as {
        toDate?: () => Date;
      };

      if (typeof timestampLike.toDate === 'function') {
        return timestampLike.toDate();
      }
    }

    if (typeof value === 'string' || typeof value === 'number') {
      const parsedDate = new Date(value);

      if (!Number.isNaN(parsedDate.getTime())) {
        return parsedDate;
      }
    }

    return null;
  }

  private getNhlSeasonForDate(date: Date): string {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;

    const seasonStartYear = month >= 7 ? year : year - 1;

    return `${seasonStartYear}${seasonStartYear + 1}`;
  }

  private isGameInProjectionWindow(gameDate: string, startDate: Date, endDate: Date): boolean {
    const startKey = this.getDateKey(startDate);
    const endKey = this.getDateKey(endDate);

    return gameDate >= startKey && gameDate <= endKey;
  }

  private getDateKey(date: Date): string {
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');

    return `${year}-${month}-${day}`;
  }

  async openAssetDetail(asset: DraftableAsset): Promise<void> {
    await this.router.navigate(
      ['/leagues', this.leagueId, 'cycles', this.cycleNumber, 'assets', asset.assetKey],
      {
        queryParams: {
          returnTo: this.router.url,
        },
      },
    );
  }

  private getPositionSortValue(position: DraftPosition): number {
    const order: DraftPosition[] = ['LW', 'C', 'RW', 'D', 'G'];

    return order.indexOf(position);
  }

  private wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  }
}
