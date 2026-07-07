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
  FantasyDraft
} from '../../../core/draft/draft.models';

import {
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

  loading = signal(true);
  isCommissioner = signal(false);
  copyMessage = signal('');
  errorMessage = signal('');

  readonly now = signal(Date.now());

  private readonly countdownTimer = setInterval(() => {
    this.now.set(Date.now());
  }, 1000);

  private stopDraftListener: (() => void) | null = null;

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
      return 'Start Time Reached';
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
      return 'The scheduled draft start time has arrived.';
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
      return 'Draft start time reached.';
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
    this.stopDraftListener?.();
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

      this.stopDraftListener = listenToFantasyDraft(
        leagueId,
        (draft) => {
          this.draft.set(draft);
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
}