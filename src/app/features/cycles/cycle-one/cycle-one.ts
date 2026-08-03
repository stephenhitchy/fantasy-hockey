import { Component, computed, inject, OnDestroy, signal, ViewEncapsulation } from '@angular/core';

import {
  CycleAssetScoreSummary,
  CycleScoringResult,
} from '../../../core/cycle/cycle-scoring.service';

import { getFantasyTeamProfileIconId } from '../../../core/team/team.service';
import { defaultScoringRules } from '../../../core/scoring/scoring-rules';

import { saveProjectionAccuracyForCycle } from '../../../core/projection/projection-accuracy.service';

import { getFrozenCycleProjection } from '../../../core/projection/cycle-projection.util';

import { ActivatedRoute, ParamMap, Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import {
  FantasyAssetCycleWindow,
  FantasyCycle,
  FantasyMatchup,
  FantasyTeamCycleWindows,
} from '../../../core/cycle/cycle.models';

import {
  listenToCycle,
  listenToCycleMatchups,
  listenToCycleRosterPicks,
  listenToLeagueCycles,
} from '../../../core/cycle/cycle.service';

import { listenToCycleTeamWindows } from '../../../core/cycle/asset-cycle-window.service';

import { loadDraftPlayerPool } from '../../../core/draft/draft-player-pool.service';

import { DraftableAsset, DraftPick, DraftPosition } from '../../../core/draft/draft.models';

import { listenToDraftPicks } from '../../../core/draft/draft.service';

import { getLeagueById, League } from '../../../core/league/league.service';


import {
  STANDARD_FULL_CYCLE_SEASON_COUNT,
  getPlayoffRoundLabel,
  getStandardPlayoffRoundCount,
  getStandardPlayoffTeamCount,
  getStandardRegularSeasonCycleCount,
} from '../../../core/playoffs/playoff-format';

import { getNhlTeamSeasonSchedule, NHL_DRAFT_CLUBS } from '../../../core/nhl/nhl-api.service';

import { FantasyTeam, getLeagueTeams } from '../../../core/team/team.service';
import { BENCH_SLOT_COUNT } from '../../../core/team/roster-config';
import { BenchRosterSlot, FantasyRoster, RosterAsset } from '../../../core/team/roster.models';
import { listenToFantasyRoster } from '../../../core/team/roster.service';
import { getPublicManagerProfilesForLeague } from '../../../core/user/user.service';
import {
  PixelTeamTheme,
  getPixelTeamTheme,
  hexToRgba,
  RINKRAT_NEUTRAL_ABBREVIATION,
} from '../../../shared/pixel-theme/pixel-theme.data';

import {
  areDeveloperToolsEnabled,
  getHistoricalScoringTestDate,
} from '../../../core/cycle/cycle-runtime.config';

import {
  listenToSharedCycleScoring,
  listenToSharedLiveScoringControl,
  openNextCompetitionPeriod,
  requestLeagueLiveScoringRefresh,
} from '../../../core/live-scoring/live-scoring.service';

import {
  advanceHistoricalReplayDay,
  HistoricalReplayControl,
  listenToHistoricalReplayControl,
} from '../../../core/replay/historical-replay.service';

import {
  SharedCycleScoringSnapshot,
  SharedLiveScoringControl,
} from '../../../core/live-scoring/live-scoring.models';

import {
  getMatchupScoreViewState,
  saveMatchupScoreViewState,
} from '../../../core/live-scoring/matchup-score-view.service';

import {
  getPlayerAvailabilityForPlayer,
  startPlayerAvailabilityListenerForLeague,
} from '../../../core/player/player-availability.service';
import { requestTestInjuryEmail } from '../../../core/notifications/email-notification.service';
import { PlatformAdminService } from '../../../core/admin/platform-admin.service';

import { CycleMatchupCard } from './components/cycle-matchup-card/cycle-matchup-card';
import { CycleMatchupToolbar } from './components/cycle-matchup-toolbar/cycle-matchup-toolbar';
import { CycleMobileScorebar } from './components/cycle-mobile-scorebar/cycle-mobile-scorebar';
import { CyclePageHeader } from './components/cycle-page-header/cycle-page-header';
import { CycleStatusBanners } from './components/cycle-status-banners/cycle-status-banners';

import { waitForAuthUser } from './cycle-one-auth.util';
import {
  CYCLE_PROJECTION_WINDOW_DAYS,
  CycleWindowGameMarker,
  MatchupAssetPerformanceRow,
  MatchupPositionBreakdownRow,
  MatchupViewMode,
  MobileMatchupBenchRow,
  MobileMatchupPlayerPair,
  MobileMatchupPositionGroup,
  NHL_SCHEDULE_BATCH_SIZE,
  OwnerTeamIdentity,
  PendingScoreDelta,
  PROJECTION_NEUTRAL_PERCENT,
  PROJECTION_NEUTRAL_POINTS,
  ScoreDeltaAnimation,
} from './cycle-one.models';
import {
  buildEffectiveCycleLineupPicks,
  getCycleLineupPickIdentity,
  isCycleWindowIdentityLocked,
  isPendingMovePlannedForCycle,
} from './cycle-lineup-preview.util';

@Component({
  selector: 'app-cycle-one',
  host: { class: 'g' },
  imports: [
    RouterLink,
    CycleMobileScorebar,
    CyclePageHeader,
    CycleStatusBanners,
    CycleMatchupToolbar,
    CycleMatchupCard,
  ],
  templateUrl: './cycle-one.html',
  styleUrl: './cycle-one.css',
  encapsulation: ViewEncapsulation.None,
})
export class CycleOne implements OnDestroy {
  private readonly platformAdminService = inject(PlatformAdminService);

  readonly presenter = this;
  readonly developerToolsEnabled = areDeveloperToolsEnabled();
  readonly isPlatformAdmin = this.platformAdminService.isAdmin;
  leagueId = '';
  userId = '';
  cycleNumber = 1;
  matchupId: string | null = null;

  league = signal<League | null>(null);
  teams = signal<FantasyTeam[]>([]);
  ownerFavoriteTeams = signal<Record<string, OwnerTeamIdentity>>({});
  allCycles = signal<FantasyCycle[]>([]);
  cycle = signal<FantasyCycle | null>(null);
  matchups = signal<FantasyMatchup[]>([]);
  picks = signal<DraftPick[]>([]);
  playerPool = signal<DraftableAsset[]>([]);
  teamWindowsByOwner = signal<Record<string, FantasyTeamCycleWindows>>({});
  teamRostersByOwner = signal<Record<string, FantasyRoster | null>>({});

  teamGameCounts = signal<Record<string, number>>({});

  cycleScoring = signal<CycleScoringResult | null>(null);
  sharedScoringSnapshot = signal<SharedCycleScoringSnapshot | null>(null);
  liveScoringControl = signal<SharedLiveScoringControl | null>(null);
  historicalReplayControl = signal<HistoricalReplayControl | null>(null);
  historicalReplayAdvancing = signal(false);
  historicalReplayMessage = signal('');
  historicalReplayError = signal('');
  matchupView = signal<MatchupViewMode>('both');
  scoreDeltaAnimations = signal<Record<string, ScoreDeltaAnimation>>({});

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

  testInjuryEmailSending = signal(false);
  testInjuryEmailMessage = signal('');
  testInjuryEmailError = signal('');

  async sendTestInjuryEmailPreview(): Promise<void> {
    if (this.testInjuryEmailSending()) {
      return;
    }

    this.testInjuryEmailSending.set(true);
    this.testInjuryEmailMessage.set('');
    this.testInjuryEmailError.set('');

    try {
      const result = await requestTestInjuryEmail(this.leagueId);
      this.testInjuryEmailMessage.set(result.message);
    } catch (error: unknown) {
      this.testInjuryEmailError.set(
        error instanceof Error
          ? error.message
          : 'Unable to send the test injury notification.',
      );
    } finally {
      this.testInjuryEmailSending.set(false);
    }
  }

  async advanceReplayOneDay(): Promise<void> {
    if (this.historicalReplayAdvancing()) {
      return;
    }

    this.historicalReplayAdvancing.set(true);
    this.historicalReplayMessage.set('');
    this.historicalReplayError.set('');

    try {
      const result = await advanceHistoricalReplayDay(this.leagueId);
      this.historicalReplayMessage.set(result.message);
    } catch (error: unknown) {
      this.historicalReplayError.set(
        error instanceof Error ? error.message : 'Unable to advance the historical replay.',
      );
    } finally {
      this.historicalReplayAdvancing.set(false);
    }
  }

  getHistoricalReplayDateLabel(): string {
    const date = this.historicalReplayControl()?.simulatedDate;

    if (!date) {
      return 'Not started';
    }

    return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });
  }

  getHistoricalReplayStatusLabel(): string {
    const control = this.historicalReplayControl();

    if (this.historicalReplayAdvancing() || control?.status === 'advancing') {
      return 'Processing simulated NHL day';
    }

    if (!control?.enabled) {
      return 'Ready to begin';
    }

    if (control.status === 'error') {
      return 'Replay needs attention';
    }

    return 'Historical replay active';
  }

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
    return `${this.getCycleLabel()} has no NHL team games left to score. The app will stop creating new matchups until more games are available.`;
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
      this.completeCycleMessage.set(`${this.getCycleLabel()} is already complete.`);
      return;
    }

    if (!scoring) {
      this.completeCycleError.set(
        'Current scores are not ready yet. Wait for server scoring to finish loading.',
      );
      return;
    }

    if (matchups.length === 0) {
      this.completeCycleError.set('No matchups were found to reconcile.');
      return;
    }

    if (!this.areAllMatchupsReadyToComplete()) {
      this.completeCycleError.set(
        `${this.getCycleLabel()} is not ready yet. Some roster games are still unfinished.`,
      );
      return;
    }

    if (!this.isCommissioner()) {
      this.completeCycleError.set('Only the league commissioner can request a scoring reconciliation.');
      return;
    }

    this.completingCycle.set(true);

    try {
      await requestLeagueLiveScoringRefresh(this.leagueId);
      await this.saveCurrentCycleProjectionAccuracy();

      this.completeCycleMessage.set(
        'Server scoring was refreshed. Any completed matchups, standings, six-game roster counts, and playoff advancement were reconciled securely.',
      );
    } catch (error: unknown) {
      this.completeCycleError.set(
        error instanceof Error ? error.message : `Unable to refresh ${this.getCycleLabel()}.`,
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

  getTeamRosterGameTotal(ownerId: string | null): number {
    return (
      this.getTeamRosterGamesPlayed(ownerId) +
      this.getTeamRosterGamesLeft(ownerId)
    );
  }

  getTeamRosterProgressPercent(ownerId: string | null): number {
    const totalGames = this.getTeamRosterGameTotal(ownerId);

    if (totalGames <= 0) {
      return 0;
    }

    const percentage = (this.getTeamRosterGamesPlayed(ownerId) / totalGames) * 100;

    return Number(Math.min(100, Math.max(0, percentage)).toFixed(1));
  }

  getTeamRosterProgressLabel(ownerId: string | null): string {
    const playedGames = this.getTeamRosterGamesPlayed(ownerId);
    const gamesLeft = this.getTeamRosterGamesLeft(ownerId);
    const totalGames = playedGames + gamesLeft;

    if (totalGames <= 0) {
      return 'Counted roster-game progress is not available yet.';
    }

    return `${playedGames} of ${totalGames} counted roster games played. ${gamesLeft} left.`;
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
      return `${this.getCycleLabel()} readiness will appear once the matchup starts.`;
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
        'Server scoring refresh completed. A shared snapshot was published only if NHL data changed.',
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

    return 'The server checks NHL results for the entire league. Everyone reads the same shared scoring update.';
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
  private stopHistoricalReplayListener: (() => void) | null = null;
  private stopRosterListeners = new Map<string, () => void>();
  private displayedRosterOwnerIds = new Set<string>();
  private loadedRosterOwnerIds = new Set<string>();
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
  private readonly scoreDeltaAnimationDurationMs = 3200;
  private readonly scoreDeltaCascadeDelayMs = 500;
  private scoreDeltaAnimationId = 0;
  private scoreDeltaTimers = new Set<ReturnType<typeof setTimeout>>();
  private pendingScoreDeltas = new Map<string, PendingScoreDelta>();
  private scheduledScoreDeltaAssetKeys = new Set<string>();
  private scoreDeltaVisibilityTimer: ReturnType<typeof setTimeout> | null = null;
  private observedScoreBaselineLoaded = false;
  private observedScoreBaselineExists = false;
  private observedScoreBaselineInitialized = false;
  private observedScoreBaseline: Record<string, number> = {};
  private observedScoreSaveChain: Promise<void> = Promise.resolve();

  private getCycleDisplayPickIdentity(pick: DraftPick): string {
    return getCycleLineupPickIdentity(pick);
  }

  private getCycleProjectionPreviewSignature(asset: DraftableAsset): string {
    return [
      asset.frozenCycleProjectionPoints ?? '',
      asset.projectedCyclePoints ?? '',
      asset.availabilityAdjustedCyclePoints ?? '',
      asset.floorAdjustedCyclePoints ?? '',
      asset.draftProjectedCyclePoints ?? '',
      asset.targetProjectionCycleNumber ?? '',
      asset.sharedProjectionSnapshotId ?? '',
      asset.projectionGeneratedAt ?? '',
    ].join(':');
  }

  private refreshEffectivePicks(): void {
    const snapshotPicks = this.cycleRosterSnapshotPicks;
    const livePicks = this.liveDraftPicks;
    const effectivePicks = buildEffectiveCycleLineupPicks({
      cycleNumber: this.cycleNumber,
      snapshotPicks,
      liveDraftPicks: livePicks,
      rostersByOwner: this.teamRostersByOwner(),
      projectionAssets: this.playerPool(),
      teamWindowsByOwner: this.teamWindowsByOwner(),
      rosterOwnerIdsExpected: this.displayedRosterOwnerIds,
      rosterOwnerIdsLoaded: this.loadedRosterOwnerIds,
    });

    const source = snapshotPicks.length > 0
      ? 'cycle-snapshot-plus-roster-preview'
      : 'current-roster-preview';

    const nextKey = [
      source,
      effectivePicks
        .map(
          (pick) =>
            `${this.getCycleDisplayPickIdentity(pick)}:${pick.asset.assetKey}:${this.getCycleProjectionPreviewSignature(pick.asset)}`,
        )
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

  private getDisplayedMatchupScoreEntries(result: CycleScoringResult): Array<{
    pick: DraftPick;
    rosterOrder: number;
    score: number;
    ownerId: string;
  }> {
    const matchup = this.getCurrentDisplayedMatchup();

    if (!matchup) {
      return [];
    }

    const ownerIds = [matchup.teamAOwnerId, matchup.teamBOwnerId].filter(
      (ownerId): ownerId is string => Boolean(ownerId),
    );

    return ownerIds.flatMap((ownerId, teamIndex) =>
      this.getTeamPicks(ownerId).map((pick, rosterOrder) => ({
        pick,
        ownerId,
        // Keep each roster in its normal order while alternating equally placed
        // players from the two sides when several updates arrive together.
        rosterOrder: rosterOrder * ownerIds.length + teamIndex,
        score: Number(
          (result.assetScores[pick.asset.assetKey]?.currentScore ?? 0).toFixed(1),
        ),
      })),
    );
  }

  private queuePendingScoreDelta(input: {
    assetKey: string;
    delta: number;
    rosterOrder: number;
    targetScore: number;
    ownerId: string;
  }): void {
    const existing = this.pendingScoreDeltas.get(input.assetKey);
    const combinedDelta = Number(((existing?.delta ?? 0) + input.delta).toFixed(1));

    if (Math.abs(combinedDelta) < 0.1) {
      this.pendingScoreDeltas.delete(input.assetKey);
      return;
    }

    this.pendingScoreDeltas.set(input.assetKey, {
      delta: combinedDelta,
      rosterOrder: Math.min(existing?.rosterOrder ?? input.rosterOrder, input.rosterOrder),
      targetScore: input.targetScore,
      ownerId: input.ownerId,
    });
  }

  private persistObservedScoreBaseline(): void {
    if (!this.userId || !this.leagueId || !this.observedScoreBaselineLoaded) {
      return;
    }

    const payload = {
      userId: this.userId,
      leagueId: this.leagueId,
      cycleNumber: this.cycleNumber,
      scores: { ...this.observedScoreBaseline },
    };

    this.observedScoreSaveChain = this.observedScoreSaveChain
      .catch(() => undefined)
      .then(() => saveMatchupScoreViewState(payload))
      .catch((error: unknown) => {
        console.warn('Unable to persist matchup score-view state.', error);
      });
  }

  private markScoreDeltaObserved(assetKey: string, targetScore: number): void {
    this.observedScoreBaseline[assetKey] = Number(targetScore.toFixed(1));
    this.observedScoreBaselineExists = true;
    this.persistObservedScoreBaseline();
  }

  private initializeObservedScoreBaseline(nextResult: CycleScoringResult): boolean {
    if (
      this.observedScoreBaselineInitialized ||
      !this.observedScoreBaselineLoaded ||
      !this.userId
    ) {
      return false;
    }

    const scoreEntries = this.getDisplayedMatchupScoreEntries(nextResult);

    if (scoreEntries.length === 0) {
      return false;
    }

    this.observedScoreBaselineInitialized = true;
    let baselineChanged = false;

    if (!this.observedScoreBaselineExists) {
      this.observedScoreBaseline = Object.fromEntries(
        scoreEntries.map(({ pick, score }) => [pick.asset.assetKey, score]),
      );
      this.observedScoreBaselineExists = true;
      this.persistObservedScoreBaseline();
      return true;
    }

    for (const { pick, ownerId, rosterOrder, score } of scoreEntries) {
      const assetKey = pick.asset.assetKey;
      const observedScore = this.observedScoreBaseline[assetKey];

      if (typeof observedScore !== 'number' || !Number.isFinite(observedScore)) {
        this.observedScoreBaseline[assetKey] = score;
        baselineChanged = true;
        continue;
      }

      const delta = Number((score - observedScore).toFixed(1));

      if (Math.abs(delta) >= 0.1) {
        this.queuePendingScoreDelta({
          assetKey,
          delta,
          rosterOrder,
          targetScore: score,
          ownerId,
        });
      }
    }

    if (baselineChanged) {
      this.persistObservedScoreBaseline();
    }

    if (this.pendingScoreDeltas.size > 0) {
      this.queueScoreDeltaVisibilityCheck();
    }

    return true;
  }

  private clearScoreDeltaTimers(): void {
    for (const timer of this.scoreDeltaTimers) {
      clearTimeout(timer);
    }

    if (this.scoreDeltaVisibilityTimer) {
      clearTimeout(this.scoreDeltaVisibilityTimer);
      this.scoreDeltaVisibilityTimer = null;
    }

    this.scoreDeltaTimers.clear();
    this.pendingScoreDeltas.clear();
    this.scheduledScoreDeltaAssetKeys.clear();
    this.scoreDeltaAnimations.set({});
  }

  private isScoreDeltaTargetVisible(assetKey: string): boolean {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      return false;
    }

    if (document.visibilityState !== 'visible') {
      return false;
    }

    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>('[data-score-asset-key]'),
    ).filter((element) => element.dataset['scoreAssetKey'] === assetKey);

    return candidates.some((element) => {
      const style = window.getComputedStyle(element);

      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number(style.opacity) === 0
      ) {
        return false;
      }

      const rect = element.getBoundingClientRect();

      if (rect.width <= 0 || rect.height <= 0) {
        return false;
      }

      const visibleWidth = Math.max(
        0,
        Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0),
      );
      const visibleHeight = Math.max(
        0,
        Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0),
      );
      const visibleArea = visibleWidth * visibleHeight;
      const totalArea = rect.width * rect.height;

      return totalArea > 0 && visibleArea / totalArea >= 0.55;
    });
  }

  private queueScoreDeltaVisibilityCheck(delayMs = 120): void {
    if (
      this.scoreDeltaVisibilityTimer ||
      (this.pendingScoreDeltas.size === 0 && this.scheduledScoreDeltaAssetKeys.size === 0)
    ) {
      return;
    }

    this.scoreDeltaVisibilityTimer = setTimeout(() => {
      this.scoreDeltaVisibilityTimer = null;
      this.processVisibleScoreDeltaQueue();

      if (this.pendingScoreDeltas.size > 0 || this.scheduledScoreDeltaAssetKeys.size > 0) {
        this.queueScoreDeltaVisibilityCheck(280);
      }
    }, delayMs);
  }

  private processVisibleScoreDeltaQueue(): void {
    const visiblePending = Array.from(this.pendingScoreDeltas.entries())
      .filter(
        ([assetKey]) =>
          !this.scheduledScoreDeltaAssetKeys.has(assetKey) &&
          !this.scoreDeltaAnimations()[assetKey] &&
          this.isScoreDeltaTargetVisible(assetKey),
      )
      .sort(([, first], [, second]) => first.rosterOrder - second.rosterOrder);

    visiblePending.forEach(([assetKey], index) => {
      this.scheduledScoreDeltaAssetKeys.add(assetKey);

      const startTimer = setTimeout(() => {
        this.scoreDeltaTimers.delete(startTimer);
        this.scheduledScoreDeltaAssetKeys.delete(assetKey);

        const pending = this.pendingScoreDeltas.get(assetKey);

        if (!pending) {
          return;
        }

        if (!this.isScoreDeltaTargetVisible(assetKey)) {
          this.queueScoreDeltaVisibilityCheck();
          return;
        }

        this.pendingScoreDeltas.delete(assetKey);
        this.markScoreDeltaObserved(assetKey, pending.targetScore);

        const animation: ScoreDeltaAnimation = {
          id: ++this.scoreDeltaAnimationId,
          delta: pending.delta,
          direction: pending.delta >= 0 ? 'gain' : 'loss',
          ownerId: pending.ownerId,
          presentation: pending.ownerId === this.userId ? 'my-team' : 'opponent',
        };

        this.scoreDeltaAnimations.update((current) => ({
          ...current,
          [assetKey]: animation,
        }));

        const cleanupTimer = setTimeout(() => {
          this.scoreDeltaAnimations.update((current) => {
            if (current[assetKey]?.id !== animation.id) {
              return current;
            }

            const next = { ...current };
            delete next[assetKey];
            return next;
          });
          this.scoreDeltaTimers.delete(cleanupTimer);
          this.queueScoreDeltaVisibilityCheck();
        }, this.scoreDeltaAnimationDurationMs);

        this.scoreDeltaTimers.add(cleanupTimer);
      }, index * this.scoreDeltaCascadeDelayMs);

      this.scoreDeltaTimers.add(startTimer);
    });
  }

  private scheduleScoreDeltaAnimations(
    previousResult: CycleScoringResult | null,
    nextResult: CycleScoringResult,
  ): void {
    const initializedFromPersistedState = this.initializeObservedScoreBaseline(nextResult);

    if (initializedFromPersistedState || !previousResult || !this.userId) {
      return;
    }

    const changedPicks = this.getDisplayedMatchupScoreEntries(nextResult)
      .map(({ pick, ownerId, rosterOrder, score: nextScore }) => {
        const previousScore = Number(
          (previousResult.assetScores[pick.asset.assetKey]?.currentScore ?? 0).toFixed(1),
        );
        const delta = Number((nextScore - previousScore).toFixed(1));

        return { pick, ownerId, delta, rosterOrder, nextScore };
      })
      .filter(({ delta }) => Math.abs(delta) >= 0.1);

    if (changedPicks.length === 0) {
      return;
    }

    for (const { pick, ownerId, delta, rosterOrder, nextScore } of changedPicks) {
      this.queuePendingScoreDelta({
        assetKey: pick.asset.assetKey,
        delta,
        rosterOrder,
        targetScore: nextScore,
        ownerId,
      });
    }

    this.queueScoreDeltaVisibilityCheck();
  }

  getScoreDeltaAnimation(asset: DraftableAsset): ScoreDeltaAnimation | null {
    return this.scoreDeltaAnimations()[asset.assetKey] ?? null;
  }

  isOpponentScoreGainAnimation(asset: DraftableAsset): boolean {
    const animation = this.getScoreDeltaAnimation(asset);

    return animation?.presentation === 'opponent' && animation.direction === 'gain';
  }

  getScoreDeltaLabel(animation: ScoreDeltaAnimation): string {
    return `${animation.delta > 0 ? '+' : ''}${animation.delta.toFixed(1)}`;
  }

  private async applySharedScoringSnapshot(snapshot: SharedCycleScoringSnapshot): Promise<void> {
    if (snapshot.cycleNumber !== this.cycleNumber) {
      return;
    }

    const cycle = this.cycle();
    const picks = this.picks();
    const result = snapshot.result;
    const previousResult = this.cycleScoring();

    this.scheduleScoreDeltaAnimations(previousResult, result);
    this.sharedScoringSnapshot.set(snapshot);
    this.cycleScoring.set(result);
    this.scoringLoading.set(false);
    this.scoringError.set('');
    this.teamGameCounts.set({
      ...this.teamGameCounts(),
      ...result.teamGameCounts,
    });

    // The shared snapshot is read-only in the browser. The same server run
    // that published it also persists windows, scores, standings, cycle
    // completion, and playoff transitions through the Admin SDK.
  }

  private async persistWindowProgressAndAdvance(
    _cycle: FantasyCycle,
    _picks: DraftPick[],
    _scoring: CycleScoringResult,
  ): Promise<void> {
    // Kept as a compatibility seam while the matchup component is split into
    // smaller pieces. Competition writes are performed only by Cloud Functions.
    return;
  }

  private async evaluateAutoCompleteCycleIfReady(): Promise<void> {
    // Scheduled and manual server scoring already finalizes ready matchups and
    // opens the next period. Browser listeners only render the resulting state.
    return;
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
        `Projection accuracy saved for ${result.summary.gradedAssetCount} players and goalie units. Average error: ${result.summary.meanAbsoluteError.toFixed(1)} points.`,
      );
    } catch (error: unknown) {
      this.projectionAccuracyAttemptKey = null;
      this.projectionAccuracyError.set(
        error instanceof Error
          ? error.message
          : 'Unable to save projection accuracy for this matchup.',
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
        console.warn(`Unable to check next-six-game availability for ${teamAbbreviation}.`, error);
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
      const result = await openNextCompetitionPeriod(
        this.leagueId,
        this.cycleNumber,
      );

      if (result.status === 'season-complete' || result.nextCycleNumber === null) {
        const completeMessage =
          'The fantasy season is complete. Opening the final playoff bracket...';

        this.startNextCycleMessage.set(completeMessage);
        this.autoFlowMessage.set(completeMessage);

        await this.router.navigate(['/leagues', this.leagueId, 'playoffs']);
        return;
      }

      const actionLabel = result.alreadyExisted ? 'already existed' : 'was opened securely';
      const successMessage =
        source === 'automatic'
          ? `${this.getNextCycleLabel()} ${actionLabel}. Opening it now...`
          : `${this.getNextCycleLabel()} ${actionLabel}. Opening it now...`;

      this.startNextCycleMessage.set(successMessage);
      this.autoFlowMessage.set(successMessage);

      await this.router.navigate([
        '/leagues',
        this.leagueId,
        'cycles',
        result.nextCycleNumber,
      ]);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : `Unable to start ${this.getNextCycleLabel()}.`;

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
    this.clearScoreDeltaTimers();
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
    this.stopHistoricalReplayListener?.();

    for (const stopRosterListener of this.stopRosterListeners.values()) {
      stopRosterListener();
    }
    this.stopRosterListeners.clear();
    this.displayedRosterOwnerIds.clear();
    this.loadedRosterOwnerIds.clear();

    this.stopCyclesListener = null;
    this.stopCycleListener = null;
    this.stopMatchupsListener = null;
    this.stopPicksListener = null;
    this.stopCycleRosterPicksListener = null;
    this.stopTeamWindowsListener = null;
    this.stopSharedScoringListener = null;
    this.stopLiveScoringControlListener = null;
    this.stopHistoricalReplayListener = null;
  }

  private resetPageStateForNewRoute(): void {
    this.stopLiveListeners();
    this.clearScoreDeltaTimers();

    this.matchupId = null;
    this.liveDraftPicks = [];
    this.cycleRosterSnapshotPicks = [];
    this.effectivePicksKey = null;
    this.displayedRosterOwnerIds.clear();
    this.loadedRosterOwnerIds.clear();

    this.league.set(null);
    this.teams.set([]);
    this.ownerFavoriteTeams.set({});
    this.allCycles.set([]);
    this.cycle.set(null);
    this.matchups.set([]);
    this.picks.set([]);
    this.playerPool.set([]);
    this.teamWindowsByOwner.set({});
    this.teamRostersByOwner.set({});
    this.teamGameCounts.set({});
    this.cycleScoring.set(null);
    this.sharedScoringSnapshot.set(null);
    this.liveScoringControl.set(null);
    this.historicalReplayControl.set(null);
    this.historicalReplayAdvancing.set(false);
    this.historicalReplayMessage.set('');
    this.historicalReplayError.set('');
    this.matchupView.set('both');
    this.observedScoreBaselineLoaded = false;
    this.observedScoreBaselineExists = false;
    this.observedScoreBaselineInitialized = false;
    this.observedScoreBaseline = {};
    this.observedScoreSaveChain = Promise.resolve();

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
    void this.platformAdminService.refreshAccess(true);
    startPlayerAvailabilityListenerForLeague(leagueId);

    try {
      const [league, teams, scoreViewState] = await Promise.all([
        getLeagueById(leagueId),
        getLeagueTeams(leagueId),
        getMatchupScoreViewState(user.uid, leagueId, cycleNumber),
      ]);

      if (requestId !== this.pageLoadRequestId) {
        return;
      }

      this.observedScoreBaselineLoaded = true;
      this.observedScoreBaselineExists = Boolean(scoreViewState);
      this.observedScoreBaseline = { ...(scoreViewState?.scores ?? {}) };

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

      this.stopHistoricalReplayListener = listenToHistoricalReplayControl(
        leagueId,
        (control) => {
          const previousDate = this.historicalReplayControl()?.simulatedDate;
          this.historicalReplayControl.set(control);

          if (control?.status === 'error' && control.lastError) {
            this.historicalReplayError.set(control.lastError);
          }

          if (control?.simulatedDate && control.simulatedDate !== previousDate) {
            this.scheduleLoadStartedForCycleId = null;
            void this.loadScheduleAdjustedProjectionData(this.cycle());
          }
        },
        (error) => this.historicalReplayError.set(error.message),
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
        this.syncDisplayedMatchupRosterListeners(matchups);

        const scoringResult = this.cycleScoring();

        if (scoringResult) {
          this.initializeObservedScoreBaseline(scoringResult);
        }

        void this.evaluateAutoCompleteCycleIfReady();
      });

      this.stopTeamWindowsListener = listenToCycleTeamWindows(
        leagueId,
        cycleNumber,
        (teamWindows) => {
          this.teamWindowsByOwner.set(
            Object.fromEntries(teamWindows.map((entry) => [entry.ownerId, entry])),
          );
          this.refreshEffectivePicks();
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

    let profiles = new Map<string, {
      favoriteTeamAbbreviation: string;
      favoriteTeamVariantId: string;
    }>();

    try {
      profiles = new Map(
        await getPublicManagerProfilesForLeague(this.leagueId, unresolvedOwnerIds),
      );
    } catch (error: unknown) {
      console.warn('Unable to load public opponent themes. Using safe defaults.', error);
    }

    const resolvedEntries = unresolvedOwnerIds.map((ownerId) => {
      const profile = profiles.get(ownerId);

      return [
        ownerId,
        {
          abbreviation:
            profile?.favoriteTeamAbbreviation || this.getFallbackFavoriteTeam(ownerId),
          variantId:
            profile?.favoriteTeamVariantId || this.getFallbackFavoriteTeamVariant(ownerId),
        },
      ] as const;
    });

    this.ownerFavoriteTeams.set({
      ...this.ownerFavoriteTeams(),
      ...Object.fromEntries(resolvedEntries),
    });
  }

  private getFallbackFavoriteTeam(ownerId: string | null | undefined): string {
    if (typeof document !== 'undefined' && ownerId === this.userId) {
      return document.documentElement.dataset['favoriteTeam'] || RINKRAT_NEUTRAL_ABBREVIATION;
    }

    return RINKRAT_NEUTRAL_ABBREVIATION;
  }

  private getFallbackFavoriteTeamVariant(ownerId: string | null | undefined): string {
    if (typeof document !== 'undefined' && ownerId === this.userId) {
      return document.documentElement.dataset['favoriteTeamVariant'] || 'current-home';
    }

    return 'current-home';
  }

  getOwnerTheme(ownerId: string | null | undefined): PixelTeamTheme {
    const identity = ownerId ? this.ownerFavoriteTeams()[ownerId] : null;

    return getPixelTeamTheme(
      identity?.abbreviation || this.getFallbackFavoriteTeam(ownerId),
      identity?.variantId || this.getFallbackFavoriteTeamVariant(ownerId),
    );
  }

  getOwnerThemeStyles(ownerId: string | null | undefined): Record<string, string> {
    const theme = this.getOwnerTheme(ownerId);

    return {
      '--owner-theme-primary': theme.primaryColor,
      '--owner-theme-secondary': theme.secondaryColor,
      '--owner-theme-tertiary': theme.tertiaryColor,
      '--owner-theme-highlight': theme.accentColor,
      '--owner-theme-outline': theme.accentColor,
      '--owner-theme-outline-strong': theme.accentColor,
      '--owner-theme-outline-soft': hexToRgba(theme.accentColor, 0.32),
      '--owner-theme-subtle': hexToRgba(theme.accentColor, 0.12),
      '--owner-theme-surface': `linear-gradient(135deg, ${hexToRgba(theme.primaryColor, 0.26)} 0%, ${hexToRgba(theme.secondaryColor, 0.18)} 55%, rgba(16, 25, 37, 0.98) 100%)`,
      '--owner-theme-surface-2': `linear-gradient(135deg, ${hexToRgba(theme.secondaryColor, 0.2)} 0%, ${hexToRgba(theme.tertiaryColor, 0.12)} 100%), #151f2b`,
      '--owner-theme-banner': `linear-gradient(105deg, ${hexToRgba(theme.primaryColor, 0.42)} 0%, ${hexToRgba(theme.secondaryColor, 0.28)} 52%, ${hexToRgba(theme.tertiaryColor, 0.2)} 100%), #101925`,
      '--owner-theme-chip-background': theme.primaryColor,
      '--owner-theme-chip-text': theme.primaryTextColor,
      '--owner-theme-glow': hexToRgba(theme.accentColor, 0.22),
      '--owner-theme-accent-text': '#f7f9fc',
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
      return cycle.playoffRoundLabel ?? `Playoff Matchup ${this.cycleNumber}`;
    }

    return `Matchup ${this.cycleNumber}`;
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

    return `Matchup ${this.cycleNumber + 1}`;
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
      return `${this.getCycleLabel()} · ${this.matchupId}`;
    }

    if (this.myMatchup()) {
      return `Your ${this.getCycleLabel()}`;
    }

    return `${this.getCycleLabel()} Details`;
  }

  private getDisplayedMatchupsFrom(matchups: FantasyMatchup[]): FantasyMatchup[] {
    if (this.matchupId) {
      return matchups.filter((matchup) => matchup.id === this.matchupId);
    }

    const myMatchup = matchups.find(
      (matchup) => matchup.teamAOwnerId === this.userId || matchup.teamBOwnerId === this.userId,
    );

    return myMatchup ? [myMatchup] : matchups.slice(0, 1);
  }

  private syncDisplayedMatchupRosterListeners(matchups: FantasyMatchup[]): void {
    const ownerIds = new Set<string>();

    for (const matchup of this.getDisplayedMatchupsFrom(matchups)) {
      ownerIds.add(matchup.teamAOwnerId);

      if (matchup.teamBOwnerId) {
        ownerIds.add(matchup.teamBOwnerId);
      }
    }

    this.displayedRosterOwnerIds = ownerIds;

    for (const [ownerId, stopListener] of this.stopRosterListeners.entries()) {
      if (ownerIds.has(ownerId)) {
        continue;
      }

      stopListener();
      this.stopRosterListeners.delete(ownerId);
      this.loadedRosterOwnerIds.delete(ownerId);
      this.teamRostersByOwner.update((current) => {
        const next = { ...current };
        delete next[ownerId];
        return next;
      });
    }

    for (const ownerId of ownerIds) {
      if (this.stopRosterListeners.has(ownerId)) {
        continue;
      }

      this.loadedRosterOwnerIds.delete(ownerId);
      this.teamRostersByOwner.update((current) => {
        const next = { ...current };
        delete next[ownerId];
        return next;
      });

      const stopListener = listenToFantasyRoster(
        this.leagueId,
        ownerId,
        (roster) => {
          this.loadedRosterOwnerIds.add(ownerId);
          this.teamRostersByOwner.update((current) => ({
            ...current,
            [ownerId]: roster,
          }));
          this.refreshEffectivePicks();
        },
        (error) => {
          console.error(`Unable to load bench for ${ownerId}.`, error);
          this.loadedRosterOwnerIds.add(ownerId);
          this.teamRostersByOwner.update((current) => ({
            ...current,
            [ownerId]: null,
          }));
          this.refreshEffectivePicks();
        },
      );

      this.stopRosterListeners.set(ownerId, stopListener);
    }

    // Once a matchup identifies the roster owners, suppress the original-draft
    // fallback until those live roster documents finish loading.
    this.refreshEffectivePicks();
  }

  private createEmptyBenchSlots(): BenchRosterSlot[] {
    return Array.from({ length: BENCH_SLOT_COUNT }, (_, index) => ({
      slotId: `B-${index + 1}`,
      slotNumber: index + 1,
      asset: null,
    }));
  }

  getTeamBenchSlots(ownerId: string | null): BenchRosterSlot[] {
    if (!ownerId) {
      return this.createEmptyBenchSlots();
    }

    return this.teamRostersByOwner()[ownerId]?.benchSlots ?? this.createEmptyBenchSlots();
  }

  getTeamBenchFilledCount(ownerId: string | null): number {
    return this.getTeamBenchSlots(ownerId).filter((slot) => Boolean(slot.asset)).length;
  }

  getMobileMatchupBenchRows(matchup: FantasyMatchup): MobileMatchupBenchRow[] {
    const teamASlots = this.getTeamBenchSlots(matchup.teamAOwnerId);
    const teamBSlots = this.getTeamBenchSlots(matchup.teamBOwnerId);

    return Array.from({ length: BENCH_SLOT_COUNT }, (_, slotIndex) => ({
      slotIndex,
      teamASlot: teamASlots[slotIndex] ?? this.createEmptyBenchSlots()[slotIndex],
      teamBSlot: teamBSlots[slotIndex] ?? this.createEmptyBenchSlots()[slotIndex],
    }));
  }

  getBenchAssetName(asset: RosterAsset): string {
    return asset.assetType === 'skater' ? asset.player.fullName : `${asset.teamName} Goalie Unit`;
  }

  getBenchAssetTeamLabel(asset: RosterAsset): string {
    return asset.assetType === 'skater' ? asset.player.nhlTeamAbbreviation : asset.teamAbbreviation;
  }

  getBenchAssetLogoUrl(asset: RosterAsset): string | undefined {
    return asset.assetType === 'skater' ? asset.player.teamLogoUrl : asset.teamLogoUrl;
  }

  getBenchAssetProjection(asset: RosterAsset): number | null {
    const assetKey = this.getBenchAssetKey(asset);
    const poolAsset = assetKey
      ? this.playerPool().find((availableAsset) => availableAsset.assetKey === assetKey)
      : null;

    return (
      asset.projectedCyclePoints ??
      asset.availabilityAdjustedCyclePoints ??
      poolAsset?.projectedCyclePoints ??
      poolAsset?.availabilityAdjustedCyclePoints ??
      null
    );
  }

  isBenchAssetInjured(asset: RosterAsset): boolean {
    if (asset.assetType !== 'skater') {
      return false;
    }

    const status = getPlayerAvailabilityForPlayer(asset.player).status;
    return ['day-to-day', 'out', 'injured-reserve', 'long-term-injured-reserve'].includes(status);
  }

  isBenchAssetSuspended(asset: RosterAsset): boolean {
    return asset.assetType === 'skater' && getPlayerAvailabilityForPlayer(asset.player).status === 'suspended';
  }

  hasBenchAssetStatusFlag(asset: RosterAsset): boolean {
    return this.isBenchAssetInjured(asset) || this.isBenchAssetSuspended(asset);
  }

  getBenchAssetStatusFlagIcon(asset: RosterAsset): string {
    return this.isBenchAssetSuspended(asset) ? '⛔' : '✚';
  }

  getBenchAssetStatusTooltip(asset: RosterAsset): string {
    if (asset.assetType !== 'skater') {
      return '';
    }

    const availability = getPlayerAvailabilityForPlayer(asset.player);
    const detail = availability.note?.trim();
    return detail ? `${availability.label}: ${detail}` : availability.label;
  }

  private getBenchAssetKey(asset: RosterAsset): string | null {
    if (asset.assetKey) {
      return asset.assetKey;
    }

    if (asset.assetType === 'team-goalie-unit') {
      return asset.teamAbbreviation ? `goalie-unit-${asset.teamAbbreviation}` : null;
    }

    const playerId = asset.player?.id;
    return playerId !== undefined && playerId !== null ? `skater-${playerId}` : null;
  }

  openBenchAssetDetail(asset: RosterAsset): void {
    const assetKey = this.getBenchAssetKey(asset);

    if (!assetKey) {
      return;
    }

    void this.router.navigate(
      ['/leagues', this.leagueId, 'cycles', this.cycleNumber, 'assets', assetKey],
      {
        queryParams: {
          returnTo: this.router.url,
        },
      },
    );
  }

  getDisplayedMatchups(): FantasyMatchup[] {
    return this.getDisplayedMatchupsFrom(this.matchups());
  }

  getNoDisplayedMatchupMessage(): string {
    if (this.matchupId) {
      return `${this.matchupId} was not found for ${this.getCycleLabel()}.`;
    }

    return `No matchup was found for ${this.getCycleLabel()}.`;
  }

  isAssetInjured(asset: DraftableAsset): boolean {
    if (asset.assetType !== 'skater') {
      return false;
    }

    const status = getPlayerAvailabilityForPlayer(asset.player).status;

    return ['day-to-day', 'out', 'injured-reserve', 'long-term-injured-reserve'].includes(status);
  }

  isAssetSuspended(asset: DraftableAsset): boolean {
    return asset.assetType === 'skater' && getPlayerAvailabilityForPlayer(asset.player).status === 'suspended';
  }

  hasAssetStatusFlag(asset: DraftableAsset): boolean {
    return this.isAssetInjured(asset) || this.isAssetSuspended(asset);
  }

  getAssetStatusFlagIcon(asset: DraftableAsset): string {
    return this.isAssetSuspended(asset) ? '⛔' : '✚';
  }

  getAssetStatusFlagLabel(asset: DraftableAsset): string {
    return this.isAssetSuspended(asset) ? 'Suspended player' : 'Injured player';
  }

  getAssetStatusTooltip(asset: DraftableAsset): string {
    if (asset.assetType !== 'skater') {
      return '';
    }

    const availability = getPlayerAvailabilityForPlayer(asset.player);
    const detail = availability.note?.trim();

    return detail
      ? `${availability.label}: ${detail}`
      : availability.label;
  }

  private getActiveRosterSlotForPick(pick: DraftPick) {
    if (!pick.rosterSlotId) {
      return null;
    }

    return (
      this.teamRostersByOwner()[pick.ownerId]?.activeSlots.find(
        (slot) => slot.slotId === pick.rosterSlotId,
      ) ?? null
    );
  }

  private isQueuedIncomingPreview(pick: DraftPick): boolean {
    const slot = this.getActiveRosterSlotForPick(pick);
    const pendingMove = slot?.pendingMove;

    if (!pendingMove || !isPendingMovePlannedForCycle(pendingMove, this.cycleNumber)) {
      return false;
    }

    return this.getBenchAssetKey(pendingMove.incomingAsset) === pick.asset.assetKey;
  }

  private isPlannedFutureLineupPick(pick: DraftPick): boolean {
    const identity = this.getCycleDisplayPickIdentity(pick);
    const snapshotPick = this.cycleRosterSnapshotPicks.find(
      (candidate) => this.getCycleDisplayPickIdentity(candidate) === identity,
    );

    return !snapshotPick || snapshotPick.asset.assetKey !== pick.asset.assetKey;
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
        if (
          slotWindow.assetKey !== pick.asset.assetKey &&
          !isCycleWindowIdentityLocked(slotWindow)
        ) {
          // A queued/current roster preview may replace an untouched stale
          // snapshot. Do not show the outgoing player's NHL schedule markers.
          return null;
        }

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

  isFutureWindowPending(pick: DraftPick): boolean {
    const window = this.getWindowForPick(pick);
    return !window || window.status === 'scheduled';
  }

  getPendingWindowCallout(pick: DraftPick): string {
    const window = this.getWindowForPick(pick);
    const cycleNumber = window?.cycleNumber ?? this.cycleNumber;

    if (this.isQueuedIncomingPreview(pick)) {
      return `Scheduled move · Matchup ${cycleNumber}`;
    }

    if (this.isPlannedFutureLineupPick(pick)) {
      return `Planned starter · Matchup ${cycleNumber}`;
    }

    return `Matchup ${cycleNumber} has not started for this roster slot yet.`;
  }

  getPendingWindowTooltip(pick: DraftPick): string {
    const window = this.getWindowForPick(pick);
    const cycleNumber = window?.cycleNumber ?? this.cycleNumber;

    if (this.isQueuedIncomingPreview(pick)) {
      return `${this.getAssetName(pick.asset)} is scheduled to take this roster slot as soon as the outgoing player's current six-game count ends. The Matchup ${cycleNumber} projection is an estimate until this slot starts, then it locks to the new player.`;
    }

    if (this.isPlannedFutureLineupPick(pick)) {
      return `${this.getAssetName(pick.asset)} is the player currently assigned to this future roster slot. The Matchup ${cycleNumber} projection is an estimate until the slot's six-game count begins.`;
    }

    return `This player appears here early so you can track the whole roster. ${this.getCycleLabel()} will begin for this slot when ${this.getAssetName(pick.asset)} reaches the first NHL team game in this six-game count.`;
  }

  getWindowStatusLabel(pick: DraftPick): string {
    const window = this.getWindowForPick(pick);

    if (!window) {
      return `${this.getCycleLabel()} · not started yet`;
    }

    if (window.status === 'complete') {
      return `Matchup ${window.cycleNumber} · six-game count complete`;
    }

    if (window.status === 'active') {
      return `Matchup ${window.cycleNumber} · ${window.gamesPlayed}/${window.scheduledGames} games counted`;
    }

    return `Matchup ${window.cycleNumber} · waiting for first game`;
  }

  stopCardNavigation(event: Event): void {
    event.stopPropagation();
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

  getMobileMatchupPositionGroups(matchup: FantasyMatchup): MobileMatchupPositionGroup[] {
    const positions = [...this.forwardPositions, ...this.defensePositions, ...this.goaliePositions];

    return positions
      .map((position) => {
        const teamAPicks = this.getTeamPicksByPosition(matchup.teamAOwnerId, position);
        const teamBPicks = this.getTeamPicksByPosition(matchup.teamBOwnerId, position);
        const rowCount = Math.max(teamAPicks.length, teamBPicks.length);

        return {
          position,
          label: this.getPositionLabel(position),
          rows: Array.from({ length: rowCount }, (_, slotIndex) => ({
            position,
            slotIndex,
            teamAPick: teamAPicks[slotIndex] ?? null,
            teamBPick: teamBPicks[slotIndex] ?? null,
          })),
        };
      })
      .filter((group) => group.rows.length > 0);
  }

  getMobileMatchupPlayerTrackKey(row: MobileMatchupPlayerPair): string {
    return `${row.position}-${row.slotIndex}-${row.teamAPick?.overallPick ?? 'empty-a'}-${row.teamBPick?.overallPick ?? 'empty-b'}`;
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
      return `${this.getTeamName(matchup.teamAOwnerId)} had a bye this matchup.`;
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

    return `Current scores use NHL team games ${firstGameNumber}-${lastGameNumber} for each roster spot. Missed games count as 0-point games.`;
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
      return `The projection date range will appear once ${this.getCycleLabel()} has a start time.`;
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

      return `No NHL games were found in this date range. Using ${requiredGames} projected games per player until games are available.`;
    }

    return 'NHL schedules are loaded for game progress. Projections stay frozen at the value saved when the matchup started.';
  }

  private async loadPlayerPoolForProjectionFallback(): Promise<void> {
    try {
      this.playerPool.set(await loadDraftPlayerPool(true));
      this.refreshEffectivePicks();
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
    const replayDate = this.historicalReplayControl()?.enabled
      ? this.historicalReplayControl()?.simulatedDate
      : null;

    if (replayDate) {
      return new Date(`${replayDate}T12:00:00Z`);
    }

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

  getTeamProfileIconId(ownerId: string | null | undefined): string {
    const team = ownerId
      ? this.teams().find((candidate) => candidate.ownerId === ownerId)
      : null;
    return getFantasyTeamProfileIconId(team);
  }

  getTeamManagerLabel(ownerId: string | null | undefined): string {
    const team = ownerId
      ? this.teams().find((candidate) => candidate.ownerId === ownerId)
      : null;
    return team?.managerName?.trim() || team?.teamName?.trim() || 'Manager';
  }

}
