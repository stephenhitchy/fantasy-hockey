import {
  Component,
  computed,
  OnDestroy,
  signal
} from '@angular/core';

import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { onAuthStateChanged, User } from 'firebase/auth';

import { auth } from '../../../core/firebase';

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
  getLeagueById,
  League
} from '../../../core/league/league.service';

import {
  FantasyTeam,
  listenToLeagueTeams
} from '../../../core/team/team.service';

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

  loading = signal(true);
  isCommissioner = signal(false);
  copyMessage = signal('');
  errorMessage = signal('');
  showDraftStartedModal = signal(false);

  cycleActionMessage = signal('');
  cycleActionInProgress = signal(false);

  readonly now = signal(Date.now());

  private stopDraftListener: (() => void) | null = null;
  private stopTeamListener: (() => void) | null = null;
  private stopCycleListener: (() => void) | null = null;
  private stopMatchupsListener: (() => void) | null = null;

  private activationInProgress = false;
  private redirectTimer: ReturnType<typeof setTimeout> | null = null;
  private hasEnteredDraftRoom = false;

  private readonly countdownTimer = setInterval(() => {
    this.now.set(Date.now());
    void this.handleScheduledDraft();
  }, 1000);

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

  readonly currentCycleLabel = computed(() =>
    `Cycle ${this.currentCycleNumber()}`
  );

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
      return 'Opening Draft';
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
      return 'Starting the live draft now.';
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
      return 'Opening live draft...';
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
    clearInterval(this.countdownTimer);

    if (this.redirectTimer) {
      clearTimeout(this.redirectTimer);
    }

    this.stopDraftListener?.();
    this.stopTeamListener?.();
    this.stopCycleListener?.();
    this.stopMatchupsListener?.();
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
      this.isCommissioner.set(
        league.commissionerId === user.uid
      );

      this.stopDraftListener?.();
      this.stopTeamListener?.();
      this.stopCycleListener?.();
      this.stopMatchupsListener?.();

      this.stopDraftListener = listenToFantasyDraft(
        leagueId,
        (draft) => {
          this.draft.set(draft);
          void this.handleScheduledDraft();
        }
      );

      this.stopTeamListener = listenToLeagueTeams(
        leagueId,
        (teams) => {
          this.teams.set(teams);
        }
      );

      this.stopCycleListener = listenToLatestCycle(
        leagueId,
        (cycle) => {
          this.cycle.set(cycle);
          this.listenToCurrentCycleMatchups(cycle);
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
      return `${this.currentCycleLabel()} is complete. The next cycle will open automatically when the league flow continues.`;
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

    return `${this.getTeamName(matchup.winnerOwnerId)} won`;
  }

  canStartCycleOne(): boolean {
    return (
      this.isCommissioner() &&
      this.draft()?.status === 'complete' &&
      this.cycle() === null &&
      this.teams().length >= 2
    );
  }

  async startFirstCycle(): Promise<void> {
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
        'Cycle 1 has been started.'
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

  private async handleScheduledDraft(): Promise<void> {
    const draft = this.draft();

    if (!draft || this.hasEnteredDraftRoom) {
      return;
    }

    if (
      draft.status === 'scheduled' &&
      isDraftStartTimeReached(draft) &&
      !this.activationInProgress
    ) {
      this.activationInProgress = true;

      try {
        const activatedDraft =
          await activateScheduledDraftIfReady(
            this.leagueId
          );

        if (activatedDraft?.status === 'live') {
          this.draft.set(activatedDraft);
        }
      } finally {
        this.activationInProgress = false;
      }
    }

    if (this.draft()?.status === 'live') {
      this.openDraftStartedModal();
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
