import {
  Component,
  computed,
  OnDestroy,
  signal
} from '@angular/core';

import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { onAuthStateChanged, User } from 'firebase/auth';

import { auth } from '../../../core/firebase';
import { APP_RUNTIME_CONFIG } from '../../../../environments/app-runtime.config';

import {
  FantasyCycle,
  FantasyMatchup
} from '../../../core/cycle/cycle.models';

import {
  listenToCycleMatchups,
  listenToLatestCycle,
  startCycleOne
} from '../../../core/cycle/cycle.service';

import {
  FantasyDraft
} from '../../../core/draft/draft.models';

import {
  activateScheduledDraftIfReady,
  getScheduledStartDate,
  isDraftStartTimeReached,
  listenToFantasyDraft
} from '../../../core/draft/draft.service';


import {
  generateSharedProjectionSnapshot,
  isSharedProjectionSnapshotFreshForDraft,
  loadSharedProjectionSnapshot,
  loadSharedProjectionSnapshotMetadata,
  PRE_DRAFT_PROJECTION_WARMUP_MINUTES,
  SharedProjectionGenerationReason
} from '../../../core/projection/projection-snapshot.service';

import {
  listenToPlayerAvailabilitySyncState,
  syncPlayerAvailabilityFromEspn
} from '../../../core/player/player-availability-sync.service';

import {
  PlayerAvailabilitySyncState
} from '../../../core/player/player-availability.models';

import {
  getLeagueById,
  League
} from '../../../core/league/league.service';

import {
  FantasyTeam,
  listenToLeagueTeams
} from '../../../core/team/team.service';

import {
  startPlayerAvailabilityListenerForLeague
} from '../../../core/player/player-availability.service';

function waitForAuthUser(): Promise<User | null> {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

@Component({
  selector: 'app-league-detail',
  imports: [RouterLink],
  templateUrl: './league-detail.html',
  styleUrl: './league-detail.css'
})
export class LeagueDetail implements OnDestroy {
  leagueId = '';

  league = signal<League | null>(null);
  teams = signal<FantasyTeam[]>([]);
  draft = signal<FantasyDraft | null>(null);
  cycle = signal<FantasyCycle | null>(null);
  matchups = signal<FantasyMatchup[]>([]);
  injurySyncState = signal<PlayerAvailabilitySyncState | null>(null);

  loading = signal(true);
  isCommissioner = signal(false);
  copyMessage = signal('');
  errorMessage = signal('');
  showDraftStartedModal = signal(false);
  draftInjurySyncInProgress = signal(false);
  draftInjurySyncMessage = signal('');
  draftInjurySyncWarning = signal('');
  preDraftPreparationInProgress = signal(false);
  preDraftPreparationReady = signal(false);

  dailyInjuryRefreshInProgress = signal(false);
  dailyInjuryRefreshMessage = signal('');
  dailyInjuryRefreshError = signal('');

  cycleActionMessage = signal('');
  cycleActionInProgress = signal(false);

  readonly now = signal(Date.now());

  private stopDraftListener: (() => void) | null = null;
  private stopTeamListener: (() => void) | null = null;
  private stopCycleListener: (() => void) | null = null;
  private stopMatchupsListener: (() => void) | null = null;
  private stopInjurySyncListener: (() => void) | null = null;

  private activationInProgress = false;
  private scheduledDraftCheckInProgress = false;
  private destroyed = false;
  private activationFailureCount = 0;
  private activationRetryNotBefore = 0;
  private preDraftPreparationAttemptKey = '';
  private redirectTimer: ReturnType<typeof setTimeout> | null = null;
  private hasEnteredDraftRoom = false;
  private automaticSeasonStartInProgress = false;

  private readonly countdownTimer = setInterval(() => {
    if (!this.destroyed) {
      this.now.set(Date.now());
    }
  }, 1000);

  private readonly scheduledDraftCheckTimer = setInterval(() => {
    void this.runScheduledDraftChecks();
  }, 5000);

  private readonly automaticCycleStartTimer = setInterval(() => {
    void this.runAutomaticSeasonStartChecks();
  }, 15000);

  readonly sortedTeams = computed(() =>
    [...this.teams()].sort((first, second) => {
      const firstWinPercentage = this.getWinPercentageValue(first);
      const secondWinPercentage = this.getWinPercentageValue(second);

      if (secondWinPercentage !== firstWinPercentage) {
        return secondWinPercentage - firstWinPercentage;
      }

      const firstDiff = (first.pointsFor ?? 0) - (first.pointsAgainst ?? 0);
      const secondDiff = (second.pointsFor ?? 0) - (second.pointsAgainst ?? 0);

      if (secondDiff !== firstDiff) {
        return secondDiff - firstDiff;
      }

      return first.teamName.localeCompare(second.teamName);
    })
  );

  readonly currentCycleNumber = computed(() =>
    this.cycle()?.cycleNumber ?? 1
  );

  readonly currentCycleLabel = computed(() => {
    const cycle = this.cycle();

    if (cycle?.phase === 'playoffs') {
      return cycle.playoffRoundLabel ??
        `Playoff Cycle ${this.currentCycleNumber()}`;
    }

    return `Cycle ${this.currentCycleNumber()}`;
  });

  readonly scheduledStartDate = computed(() =>
    getScheduledStartDate(this.draft())
  );

  readonly startTimeReached = computed(() => {
    const draft = this.draft();

    return (
      draft?.status === 'scheduled' &&
      isDraftStartTimeReached(
        draft,
        new Date(this.now())
      )
    );
  });

  readonly shouldShowDraftStatus = computed(() =>
    this.draft()?.status !== 'complete'
  );

  readonly shouldShowInviteCode = computed(() =>
    this.draft()?.status !== 'complete'
  );

  readonly regularSeasonAutoStartDate = computed(() => {
    const iso = APP_RUNTIME_CONFIG.regularSeasonAutoStartIso;
    return iso ? new Date(iso) : null;
  });

  readonly regularSeasonAutoStartReached = computed(() => {
    const startDate = this.regularSeasonAutoStartDate();
    return !!startDate && startDate.getTime() <= this.now();
  });

  readonly draftStatusLabel = computed(() => {
    const draft = this.draft();
    const scheduledStart = this.scheduledStartDate();

    if (!draft || !scheduledStart) {
      return 'Draft Not Scheduled';
    }

    if (draft.status === 'live') {
      return 'Draft Live';
    }

    if (draft.status === 'complete') {
      return 'Draft Complete';
    }

    if (this.startTimeReached()) {
      return (
        this.draftInjurySyncInProgress() ||
        this.injurySyncState()?.status === 'running'
      )
        ? 'Updating Injuries'
        : 'Opening Draft';
    }

    return 'Draft Scheduled';
  });

  readonly draftStatusDescription = computed(() => {
    const draft = this.draft();
    const scheduledStart = this.scheduledStartDate();

    if (!draft || !scheduledStart) {
      return 'The commissioner has not selected a draft date and time yet.';
    }

    if (draft.status === 'live') {
      return 'The draft is currently in progress.';
    }

    if (draft.status === 'complete') {
      return 'All draft picks have been completed.';
    }

    if (this.startTimeReached()) {
      return this.isCommissioner()
        ? 'Refreshing the shared ESPN injury report before opening the live draft.'
        : 'Waiting for the commissioner to refresh the shared injury report and open the live draft.';
    }

    return 'The draft will become available at the scheduled time below.';
  });

  readonly countdownText = computed(() => {
    const draft = this.draft();
    const startDate = this.scheduledStartDate();

    if (!startDate) {
      return 'No countdown available.';
    }

    if (draft?.status === 'live') {
      return 'Picks are currently being made.';
    }

    if (draft?.status === 'complete') {
      return 'All picks are complete.';
    }

    const millisecondsRemaining =
      startDate.getTime() - this.now();

    if (millisecondsRemaining <= 0) {
      return (
        this.draftInjurySyncInProgress() ||
        this.injurySyncState()?.status === 'running'
      )
        ? 'Updating injury report...'
        : 'Opening live draft...';
    }

    const totalSeconds = Math.floor(
      millisecondsRemaining / 1000
    );

    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor(
      (totalSeconds % 86400) / 3600
    );
    const minutes = Math.floor(
      (totalSeconds % 3600) / 60
    );
    const seconds = totalSeconds % 60;

    if (days > 0) {
      return `${days}d ${hours}h ${minutes}m remaining`;
    }

    return `${hours}h ${minutes}m ${seconds}s remaining`;
  });

  constructor(
    private route: ActivatedRoute,
    private router: Router
  ) {
    this.loadLeague();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    clearInterval(this.countdownTimer);
    clearInterval(this.scheduledDraftCheckTimer);
    clearInterval(this.automaticCycleStartTimer);

    if (this.redirectTimer) {
      clearTimeout(this.redirectTimer);
    }

    this.stopDraftListener?.();
    this.stopTeamListener?.();
    this.stopCycleListener?.();
    this.stopMatchupsListener?.();
    this.stopInjurySyncListener?.();
  }

  async loadLeague(): Promise<void> {
    const leagueId = this.route.snapshot.paramMap.get('leagueId');
    const user = await waitForAuthUser();

    if (!leagueId || !user) {
      await this.router.navigate(['/']);
      return;
    }

    this.leagueId = leagueId;

    try {
      const league = await getLeagueById(leagueId);

      if (!league) {
        this.errorMessage.set('League not found.');
        return;
      }

      this.league.set(league);
      startPlayerAvailabilityListenerForLeague(leagueId);
      this.isCommissioner.set(
        league.commissionerId === user.uid
      );

      this.stopInjurySyncListener?.();
      this.stopInjurySyncListener =
        listenToPlayerAvailabilitySyncState(
          leagueId,
          (state) => {
            this.injurySyncState.set(state);
          }
        );

      if (this.isCommissioner()) {
        void this.requestTodayInjuryRefresh();
      }

      this.stopDraftListener?.();
      this.stopTeamListener?.();
      this.stopCycleListener?.();
      this.stopMatchupsListener?.();

      this.stopDraftListener = listenToFantasyDraft(
        leagueId,
        (draft) => {
          this.draft.set(draft);
          void this.runScheduledDraftChecks();
          void this.runAutomaticSeasonStartChecks();
        }
      );

      this.stopTeamListener = listenToLeagueTeams(
        leagueId,
        (teams) => {
          this.teams.set(teams);
          void this.runScheduledDraftChecks();
          void this.runAutomaticSeasonStartChecks();
        }
      );

      this.stopCycleListener = listenToLatestCycle(
        leagueId,
        (cycle) => {
          this.cycle.set(cycle);
          this.listenToCurrentCycleMatchups(cycle);
          void this.runAutomaticSeasonStartChecks();
        }
      );
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to load this league.'
      );
    } finally {
      this.loading.set(false);
    }
  }

  getDailyInjuryStatusLabel(): string {
    const state = this.injurySyncState();

    if (
      this.dailyInjuryRefreshInProgress() ||
      state?.status === 'running'
    ) {
      return 'Updating Today’s Report';
    }

    if (this.dailyInjuryRefreshError()) {
      return 'Using Last Saved Report';
    }

    if (
      state?.lastDailySyncKey &&
      state.lastDailySyncKey === this.getUtcDailyKey()
    ) {
      return 'Updated Today';
    }

    if (state?.lastSuccessfulSyncAt) {
      return 'Last Saved Report';
    }

    return 'Waiting for First Update';
  }

  getDailyInjuryStatusDescription(): string {
    if (this.dailyInjuryRefreshInProgress()) {
      return 'A browser is checking whether today’s app-wide ESPN injury report is already current.';
    }

    if (this.dailyInjuryRefreshError()) {
      return this.dailyInjuryRefreshError();
    }

    if (this.dailyInjuryRefreshMessage()) {
      return this.dailyInjuryRefreshMessage();
    }

    const state = this.injurySyncState();

    if (state?.status === 'running') {
      return 'Today’s shared injury refresh is already running.';
    }

    if (state?.status === 'error') {
      return state.message ||
        'Today’s refresh failed. The most recent saved injury report is still being used.';
    }

    if (state?.lastSuccessfulSyncAt) {
      return 'The single shared injury report is available to every league and manager in the app.';
    }

    return 'The first league visit each UTC day refreshes one shared report for the entire app.';
  }

  getDailyInjuryStatusTimeLabel(): string {
    const value =
      this.injurySyncState()?.lastDailySuccessfulSyncAt ||
      this.injurySyncState()?.lastSuccessfulSyncAt;

    if (!value) {
      return 'No successful injury update yet';
    }

    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      return 'Successful injury update recorded';
    }

    return `Last updated: ${parsed.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    })}`;
  }

  getUtcDailyKey(date: Date = new Date()): string {
    return date.toISOString().slice(0, 10);
  }

  async requestTodayInjuryRefresh(): Promise<void> {
    if (
      !this.leagueId ||
      !this.isCommissioner() ||
      this.dailyInjuryRefreshInProgress()
    ) {
      return;
    }

    this.dailyInjuryRefreshInProgress.set(true);
    this.dailyInjuryRefreshError.set('');
    this.dailyInjuryRefreshMessage.set(
      'Checking the single app-wide injury report for today.'
    );

    try {
      const result = await syncPlayerAvailabilityFromEspn({
        leagueId: this.leagueId,
        trigger: 'daily-visit'
      });

      this.dailyInjuryRefreshMessage.set(
        result.skipped
          ? result.message
          : `Today’s app-wide injury report is ready. ${result.matchedCount} injured skaters were matched.`
      );
    } catch (error: unknown) {
      this.dailyInjuryRefreshMessage.set('');
      this.dailyInjuryRefreshError.set(
        error instanceof Error
          ? `Today’s refresh could not run: ${error.message} The last saved report remains available.`
          : 'Today’s injury refresh could not run. The last saved report remains available.'
      );
    } finally {
      this.dailyInjuryRefreshInProgress.set(false);
    }
  }

  getDraftInjurySyncStatusLabel(): string {
    if (this.draftInjurySyncInProgress() || this.injurySyncState()?.status === 'running') {
      return 'Refreshing Now';
    }

    if (this.injurySyncState()?.status === 'success') {
      return 'Report Ready';
    }

    if (this.injurySyncState()?.status === 'error') {
      return 'Using Last Saved Report';
    }

    return 'Waiting for First Sync';
  }

  getDraftInjurySyncDescription(): string {
    if (this.draftInjurySyncInProgress() || this.injurySyncState()?.status === 'running') {
      return 'The app is preparing today’s shared ESPN injury report. The draft will open after this one daily check finishes.';
    }

    if (this.draftInjurySyncWarning()) {
      return this.draftInjurySyncWarning();
    }

    if (this.draftInjurySyncMessage()) {
      return this.draftInjurySyncMessage();
    }

    const state = this.injurySyncState();

    if (state?.status === 'success') {
      return state.message || 'The shared ESPN injury report is ready for every league and account.';
    }

    if (state?.status === 'error') {
      return state.message || 'The last refresh failed, so the most recent saved report will remain available.';
    }

    return `The app checks the shared daily injury report and prepares league rankings ${PRE_DRAFT_PROJECTION_WARMUP_MINUTES} minutes before the scheduled start.`;
  }

  getDraftInjurySyncTimeLabel(): string {
    const value = this.injurySyncState()?.lastSuccessfulSyncAt;

    if (!value) {
      return 'No successful sync yet';
    }

    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      return 'Last successful sync recorded';
    }

    return `Last successful sync: ${parsed.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    })}`;
  }

  private getProjectionTeamCount(): number {
    return Math.max(
      this.league()?.maxTeams ?? this.teams().length,
      2
    );
  }

  private getRequiredGamesPerCycle(): number {
    return (
      this.league()?.scoringRules
        ?.requiredGamesPerCycle ?? 6
    );
  }

  private async loadFreshDraftSnapshotIfAvailable(): Promise<boolean> {
    const metadata =
      await loadSharedProjectionSnapshotMetadata(
        this.leagueId
      );

    const isFresh =
      isSharedProjectionSnapshotFreshForDraft(
        metadata,
        {
          teamCount: this.getProjectionTeamCount(),
          requiredGamesPerCycle:
            this.getRequiredGamesPerCycle(),
          now: new Date(this.now())
        }
      );

    if (!isFresh) {
      return false;
    }

    const snapshot = await loadSharedProjectionSnapshot(
      this.leagueId
    );

    if (!snapshot || snapshot.assets.length === 0) {
      return false;
    }

    this.preDraftPreparationReady.set(true);
    this.draftInjurySyncMessage.set(
      'Shared season draft rankings, next-cycle projections, and injury data are ready.'
    );

    return true;
  }

  private async prepareDraftData(
    generationReason: SharedProjectionGenerationReason
  ): Promise<void> {
    if (this.preDraftPreparationInProgress()) {
      return;
    }

    this.preDraftPreparationInProgress.set(true);
    this.preDraftPreparationReady.set(false);
    this.draftInjurySyncInProgress.set(true);
    this.draftInjurySyncWarning.set('');
    this.draftInjurySyncMessage.set(
      'Refreshing injuries and preparing one shared draft ranking before the scheduled start.'
    );

    try {
      try {
        const result = await syncPlayerAvailabilityFromEspn({
          leagueId: this.leagueId,
          trigger: 'draft-start'
        });

        this.draftInjurySyncMessage.set(
          result.skipped
            ? result.message
            : `Today’s shared injury report is ready. ${result.matchedCount} injured skaters matched. Building shared projections now.`
        );
      } catch (error: unknown) {
        const detail = error instanceof Error
          ? error.message
          : 'Unable to refresh ESPN injury data.';

        this.draftInjurySyncWarning.set(
          `The daily injury refresh failed: ${detail} The newest saved app-wide report will be used for projections.`
        );
      }

      const snapshot =
        await generateSharedProjectionSnapshot({
          leagueId: this.leagueId,
          teamCount: this.getProjectionTeamCount(),
          requiredGamesPerCycle:
            this.getRequiredGamesPerCycle(),
          generationReason
        });

      this.preDraftPreparationReady.set(true);
      this.draftInjurySyncMessage.set(
        `Draft data ready: ${snapshot.metadata.assetCount} shared assets are prepared for every manager.`
      );
    } finally {
      this.draftInjurySyncInProgress.set(false);
      this.preDraftPreparationInProgress.set(false);
    }
  }

  private async maybeWarmPreDraftProjections(): Promise<void> {
    const draft = this.draft();
    const startDate = this.scheduledStartDate();

    if (
      !draft ||
      draft.status !== 'scheduled' ||
      !startDate ||
      !this.isCommissioner() ||
      this.preDraftPreparationInProgress() ||
      this.activationInProgress
    ) {
      return;
    }

    const millisecondsRemaining =
      startDate.getTime() - this.now();

    if (
      millisecondsRemaining <= 0 ||
      millisecondsRemaining >
        PRE_DRAFT_PROJECTION_WARMUP_MINUTES *
          60 *
          1000
    ) {
      return;
    }

    const attemptKey = [
      startDate.getTime(),
      this.getProjectionTeamCount(),
      this.getRequiredGamesPerCycle()
    ].join(':');

    if (
      this.preDraftPreparationAttemptKey === attemptKey
    ) {
      return;
    }

    if (await this.loadFreshDraftSnapshotIfAvailable()) {
      this.preDraftPreparationAttemptKey = attemptKey;
      return;
    }

    this.preDraftPreparationAttemptKey = attemptKey;

    try {
      await this.prepareDraftData('pre-draft');
    } catch (error: unknown) {
      const detail = error instanceof Error
        ? error.message
        : 'Unable to prepare shared projections.';

      this.draftInjurySyncWarning.set(
        `Pre-draft preparation failed: ${detail} The app will retry at the scheduled start.`
      );
    }
  }

  async enterDraftRoom(): Promise<void> {
    if (this.hasEnteredDraftRoom) {
      return;
    }

    this.hasEnteredDraftRoom = true;

    if (this.redirectTimer) {
      clearTimeout(this.redirectTimer);
      this.redirectTimer = null;
    }

    await this.router.navigate([
      '/leagues',
      this.leagueId,
      'draft'
    ]);
  }

  formatDraftStart(): string {
    const startDate = this.scheduledStartDate();

    if (!startDate) {
      return 'Not scheduled';
    }

    return startDate.toLocaleString(undefined, {
      dateStyle: 'full',
      timeStyle: 'short'
    });
  }

  async copyInviteCode(): Promise<void> {
    const code = this.league()?.inviteCode;

    if (!code) {
      return;
    }

    await navigator.clipboard.writeText(code);

    this.copyMessage.set('Invite code copied!');

    setTimeout(() => {
      this.copyMessage.set('');
    }, 2000);
  }

  getTeamName(ownerId: string | null): string {
    if (!ownerId) {
      return 'Bye';
    }

    return this.teams().find(
      (team) => team.ownerId === ownerId
    )?.teamName ?? 'Unknown Team';
  }

  getTeamRecord(team: FantasyTeam | null | undefined): string {
    if (!team) {
      return '0-0-0';
    }

    return `${team.wins ?? 0}-${team.losses ?? 0}-${team.ties ?? 0}`;
  }

  getWinPercentage(team: FantasyTeam): string {
    return this.getWinPercentageValue(team)
      .toFixed(3)
      .replace(/^0/, '');
  }

  getPointDifferential(team: FantasyTeam): number {
    return Number(
      ((team.pointsFor ?? 0) - (team.pointsAgainst ?? 0)).toFixed(1)
    );
  }

  getSignedDisplayNumber(value: number): string {
    const rounded = value.toFixed(1);

    return value > 0
      ? `+${rounded}`
      : rounded;
  }

  getDisplayNumber(value: number | null | undefined): string {
    if (typeof value !== 'number') {
      return '0.0';
    }

    return value.toFixed(1);
  }

  getCurrentCycleStatusLabel(): string {
    const cycle = this.cycle();

    if (cycle?.status === 'complete') {
      return 'Complete';
    }

    if (cycle?.status === 'active') {
      return 'Active';
    }

    if (this.draft()?.status === 'complete') {
      return 'Ready';
    }

    return 'Locked';
  }

  getCurrentCycleDescription(): string {
    const cycle = this.cycle();

    if (cycle?.status === 'complete') {
      return cycle.phase === 'playoffs'
        ? `${this.currentCycleLabel()} is complete. Open the playoff bracket to see the updated path and final placements.`
        : `${this.currentCycleLabel()} is complete. The next matchup period will open automatically when the league flow continues.`;
    }

    if (cycle?.status === 'active') {
      return `${this.currentCycleLabel()} is active. Matchups are ready for scoring.`;
    }

    if (this.draft()?.status === 'complete') {
      return 'The draft is complete. The commissioner can now start the first fantasy cycle.';
    }

    return 'Finish the draft before starting the fantasy season.';
  }

  getMatchupScore(
    matchup: FantasyMatchup,
    ownerId: string | null
  ): number {
    if (!ownerId) {
      return 0;
    }

    if (ownerId === matchup.teamAOwnerId) {
      return matchup.teamAScore;
    }

    if (ownerId === matchup.teamBOwnerId) {
      return matchup.teamBScore;
    }

    return 0;
  }

  getMatchupResultLabel(matchup: FantasyMatchup): string {
    if (matchup.status !== 'complete') {
      return 'Live';
    }

    if (!matchup.winnerOwnerId) {
      return 'Tie';
    }

    if (matchup.tieBrokenByHigherSeed) {
      return `${this.getTeamName(matchup.winnerOwnerId)} advanced on seed`;
    }

    return `${this.getTeamName(matchup.winnerOwnerId)} won`;
  }


  getRegularSeasonAutoStartLabel(): string {
    const date = this.regularSeasonAutoStartDate();

    if (!date) {
      return 'Automatic regular-season start is disabled.';
    }

    return new Intl.DateTimeFormat('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/Los_Angeles',
      timeZoneName: 'short',
    }).format(date);
  }

  getSeasonStartStatusTitle(): string {
    if (this.cycle()) {
      return `${this.currentCycleLabel()} is active.`;
    }

    if (this.draft()?.status !== 'complete') {
      return 'Finish the draft to unlock the season start.';
    }

    if (this.teams().length < 2) {
      return 'At least two teams are required to begin the season.';
    }

    if (this.regularSeasonAutoStartReached()) {
      return this.isCommissioner()
        ? 'The season is ready to open automatically.'
        : 'Waiting for a commissioner to open the season.';
    }

    return 'The regular season is scheduled to open automatically.';
  }

  getSeasonStartStatusDescription(): string {
    if (this.cycle()) {
      return 'Scoring windows are already live. Managers can jump straight into their matchup, roster, or player tools.';
    }

    if (this.draft()?.status !== 'complete') {
      return 'Cycle 1 will not open until the draft has been completed.';
    }

    if (this.teams().length < 2) {
      return 'Invite more managers or complete the remaining team setup before the season begins.';
    }

    if (this.regularSeasonAutoStartReached()) {
      return this.isCommissioner()
        ? 'As soon as a commissioner opens the league after the NHL season begins, Fantasy Hockey will create Cycle 1 automatically from the official season-start time.'
        : 'A commissioner visit is required to initialize Cycle 1 the first time.';
    }

    return 'Cycle 1 will open automatically the first time a commissioner visits after the scheduled season-start time.';
  }

  getSeasonStartCountdown(): string {
    const date = this.regularSeasonAutoStartDate();

    if (!date || this.regularSeasonAutoStartReached()) {
      return 'Automatic start enabled';
    }

    const diff = Math.max(0, date.getTime() - this.now());
    const totalMinutes = Math.floor(diff / 60000);
    const days = Math.floor(totalMinutes / (60 * 24));
    const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
    const minutes = totalMinutes % 60;

    const parts: string[] = [];

    if (days > 0) {
      parts.push(`${days}d`);
    }

    if (hours > 0 || days > 0) {
      parts.push(`${hours}h`);
    }

    parts.push(`${minutes}m`);

    return `Starts in ${parts.join(' ')}`;
  }

  shouldShowSeasonStartCard(): boolean {
    return this.draft()?.status === 'complete' && !this.cycle();
  }

  async runAutomaticSeasonStartChecks(): Promise<void> {
    if (
      this.destroyed ||
      this.automaticSeasonStartInProgress ||
      !this.isCommissioner() ||
      !this.canStartCycleOne() ||
      !this.regularSeasonAutoStartReached()
    ) {
      return;
    }

    this.automaticSeasonStartInProgress = true;

    try {
      this.cycleActionMessage.set('');
      await this.startFirstCycle(true);
    } finally {
      this.automaticSeasonStartInProgress = false;
    }
  }

  canStartCycleOne(): boolean {
    return (
      this.isCommissioner() &&
      this.draft()?.status === 'complete' &&
      this.cycle() === null &&
      this.teams().length >= 2
    );
  }

  async startFirstCycle(automatic = false): Promise<void> {
    this.errorMessage.set('');
    this.cycleActionMessage.set('');

    if (!this.canStartCycleOne()) {
      return;
    }

    this.cycleActionInProgress.set(true);

    try {
      await startCycleOne(
        this.leagueId,
        this.teams()
      );

      this.cycleActionMessage.set(
        automatic ? 'Cycle 1 opened automatically.' : 'Cycle 1 has been started.'
      );
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to start Cycle 1.'
      );
    } finally {
      this.cycleActionInProgress.set(false);
    }
  }

  private listenToCurrentCycleMatchups(
    cycle: FantasyCycle | null
  ): void {
    this.stopMatchupsListener?.();
    this.stopMatchupsListener = null;

    if (!cycle) {
      this.matchups.set([]);
      return;
    }

    this.stopMatchupsListener = listenToCycleMatchups(
      this.leagueId,
      cycle.cycleNumber,
      (matchups) => {
        this.matchups.set(matchups);
      }
    );
  }

  private getWinPercentageValue(team: FantasyTeam): number {
    const wins = team.wins ?? 0;
    const losses = team.losses ?? 0;
    const ties = team.ties ?? 0;
    const gamesPlayed = wins + losses + ties;

    if (gamesPlayed <= 0) {
      return 0;
    }

    return (wins + ties * 0.5) / gamesPlayed;
  }

  private async runScheduledDraftChecks(): Promise<void> {
    if (
      this.destroyed ||
      this.scheduledDraftCheckInProgress ||
      Date.now() < this.activationRetryNotBefore
    ) {
      return;
    }

    this.scheduledDraftCheckInProgress = true;

    try {
      await this.maybeWarmPreDraftProjections();
      await this.handleScheduledDraft();
    } finally {
      this.scheduledDraftCheckInProgress = false;
    }
  }

  private async handleScheduledDraft(): Promise<void> {
    const draft = this.draft();

    if (!draft || this.hasEnteredDraftRoom) {
      return;
    }

    if (draft.status === 'live') {
      this.openDraftStartedModal();
      return;
    }

    if (
      draft.status !== 'scheduled' ||
      !isDraftStartTimeReached(draft)
    ) {
      return;
    }

    if (!this.isCommissioner()) {
      this.draftInjurySyncMessage.set(
        'Waiting for the commissioner to refresh the shared injury report and open the draft.'
      );
      return;
    }

    if (this.activationInProgress) {
      return;
    }

    this.activationInProgress = true;

    try {
      const snapshotReady =
        await this.loadFreshDraftSnapshotIfAvailable();

      if (!snapshotReady) {
        await this.prepareDraftData(
          'draft-start-fallback'
        );
      }

      const activatedDraft =
        await activateScheduledDraftIfReady(
          this.leagueId,
          auth.currentUser?.uid
        );

      if (activatedDraft?.status === 'live') {
        this.activationFailureCount = 0;
        this.activationRetryNotBefore = 0;
        this.draft.set(activatedDraft);
        this.openDraftStartedModal();
      }
    } catch (error: unknown) {
      this.activationFailureCount += 1;

      const retryDelayMilliseconds = Math.min(
        5 * 60_000,
        15_000 * 2 ** Math.max(0, this.activationFailureCount - 1)
      );

      this.activationRetryNotBefore =
        Date.now() + retryDelayMilliseconds;

      const detail = error instanceof Error
        ? error.message
        : 'Unable to open the scheduled draft.';
      const retrySeconds = Math.ceil(
        retryDelayMilliseconds / 1000
      );

      this.errorMessage.set(
        `${detail} The next activation check will wait about ${retrySeconds} seconds.`
      );
    } finally {
      this.activationInProgress = false;
    }
  }

  private openDraftStartedModal(): void {
    if (this.hasEnteredDraftRoom) {
      return;
    }

    this.showDraftStartedModal.set(true);

    if (this.redirectTimer) {
      return;
    }

    this.redirectTimer = setTimeout(() => {
      void this.enterDraftRoom();
    }, 2500);
  }
}
