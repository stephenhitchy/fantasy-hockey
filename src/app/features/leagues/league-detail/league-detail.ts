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
  listenToCycleOne,
  listenToCycleOneMatchups,
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
  getLeagueTeams
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
  private stopCycleListener: (() => void) | null = null;
  private stopMatchupsListener: (() => void) | null = null;

  private activationInProgress = false;
  private redirectTimer: ReturnType<typeof setTimeout> | null = null;
  private hasEnteredDraftRoom = false;

  private readonly countdownTimer = setInterval(() => {
    this.now.set(Date.now());
    void this.handleScheduledDraft();
  }, 1000);

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
      const [league, teams] = await Promise.all([
        getLeagueById(leagueId),
        getLeagueTeams(leagueId)
      ]);

      if (!league) {
        this.errorMessage.set('League not found.');
        return;
      }

      this.league.set(league);
      this.teams.set(teams);
      this.isCommissioner.set(
        league.commissionerId === user.uid
      );

      this.stopDraftListener?.();
      this.stopCycleListener?.();
      this.stopMatchupsListener?.();

      this.stopDraftListener = listenToFantasyDraft(
        leagueId,
        (draft) => {
          this.draft.set(draft);
          void this.handleScheduledDraft();
        }
      );

      this.stopCycleListener = listenToCycleOne(
        leagueId,
        (cycle) => {
          this.cycle.set(cycle);
        }
      );

      this.stopMatchupsListener = listenToCycleOneMatchups(
        leagueId,
        (matchups) => {
          this.matchups.set(matchups);
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