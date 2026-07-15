import {
  Component,
  computed,
  OnDestroy,
  signal
} from '@angular/core';

import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { onAuthStateChanged, User } from 'firebase/auth';

import { auth } from '../../../core/firebase';

import {
  buildSnakePickPreview,
  createDefaultFantasyDraft,
  DEFAULT_DRAFT_PICK_SECONDS,
  DEFAULT_DRAFT_ROSTER_REQUIREMENTS,
  DEFAULT_DRAFT_TOTAL_ROUNDS,
  DRAFT_PICK_SECONDS_OPTIONS,
  getFantasyDraft,
  getScheduledStartDate,
  isDraftStartTimeReached,
  saveFantasyDraft
} from '../../../core/draft/draft.service';

import {
  DraftPickPreview,
  FantasyDraft
} from '../../../core/draft/draft.models';

import {
  generateSharedProjectionSnapshot,
  PRE_DRAFT_PROJECTION_WARMUP_MINUTES
} from '../../../core/projection/projection-snapshot.service';

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

interface DraftRoundPreview {
  round: number;
  picks: DraftPickPreview[];
}

@Component({
  selector: 'app-draft-setup',
  imports: [FormsModule, RouterLink],
  templateUrl: './draft-setup.html',
  styleUrl: './draft-setup.css'
})
export class DraftSetup implements OnDestroy {
  leagueId = '';

  league = signal<League | null>(null);
  teams = signal<FantasyTeam[]>([]);
  draft = signal<FantasyDraft | null>(null);
  roundOneOrder = signal<string[]>([]);

  loading = signal(true);
  saving = signal(false);
  errorMessage = signal('');
  successMessage = signal('');
  projectionPreparationWarning = signal('');

  draftStartInput = '';
  pickSecondsInput = DEFAULT_DRAFT_PICK_SECONDS;
  readonly pickSecondsOptions = DRAFT_PICK_SECONDS_OPTIONS;

  readonly minimumStartInput = this.toDateTimeLocalValue(
    new Date()
  );

  readonly now = signal(Date.now());

  private readonly clockTimer = setInterval(() => {
    this.now.set(Date.now());
  }, 1000);

  readonly totalRounds = DEFAULT_DRAFT_TOTAL_ROUNDS;

  readonly savedStartDate = computed(() =>
    getScheduledStartDate(this.draft())
  );

  readonly startTimeReached = computed(() =>
    isDraftStartTimeReached(
      this.draft(),
      new Date(this.now())
    )
  );

  readonly scheduleStatus = computed(() => {
    const draft = this.draft();
    const startDate = this.savedStartDate();

    if (!startDate) {
      return 'No draft time scheduled';
    }

    if (draft?.status === 'live') {
      return 'Draft is live';
    }

    if (draft?.status === 'complete') {
      return 'Draft complete';
    }

    if (this.startTimeReached()) {
      return 'Scheduled start time reached';
    }

    return 'Draft scheduled';
  });

  readonly countdownText = computed(() => {
    const startDate = this.savedStartDate();

    if (!startDate) {
      return 'Choose a date and time when you are ready.';
    }

    const millisecondsRemaining =
      startDate.getTime() - this.now();

    if (millisecondsRemaining <= 0) {
      return 'The scheduled start time has arrived.';
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

  readonly previewRounds = computed<DraftRoundPreview[]>(() => {
    const order = this.roundOneOrder();

    if (order.length === 0) {
      return [];
    }

    const picks = buildSnakePickPreview(order, this.totalRounds);

    return Array.from(
      { length: this.totalRounds },
      (_, index) => {
        const round = index + 1;

        return {
          round,
          picks: picks.filter(
            (pick) => pick.round === round
          )
        };
      }
    );
  });

  constructor(
    private route: ActivatedRoute,
    private router: Router
  ) {
    this.loadDraftSetup();
  }

  ngOnDestroy(): void {
    clearInterval(this.clockTimer);
  }

  async loadDraftSetup(): Promise<void> {
    const leagueId = this.route.snapshot.paramMap.get('leagueId');
    const user = await waitForAuthUser();

    if (!leagueId || !user) {
      await this.router.navigate(['/']);
      return;
    }

    this.leagueId = leagueId;

    try {
      const [league, teams, existingDraft] = await Promise.all([
        getLeagueById(leagueId),
        getLeagueTeams(leagueId),
        getFantasyDraft(leagueId)
      ]);

      if (!league) {
        await this.router.navigate(['/dashboard']);
        return;
      }

      if (league.commissionerId !== user.uid) {
        await this.router.navigate(['/leagues', leagueId]);
        return;
      }

      const teamIds = teams.map((team) => team.ownerId);

      const savedOrderIsValid =
        existingDraft &&
        existingDraft.roundOneOrder.length === teamIds.length &&
        existingDraft.roundOneOrder.every((ownerId) =>
          teamIds.includes(ownerId)
        ) &&
        teamIds.every((ownerId) =>
          existingDraft.roundOneOrder.includes(ownerId)
        );

      this.league.set(league);
      this.teams.set(teams);
      this.draft.set(existingDraft);

      this.roundOneOrder.set(
        savedOrderIsValid
          ? [...existingDraft.roundOneOrder]
          : teamIds
      );

      this.draftStartInput = this.toDateTimeLocalValue(
        getScheduledStartDate(existingDraft)
      );

      this.pickSecondsInput =
        existingDraft?.pickSeconds ??
        DEFAULT_DRAFT_PICK_SECONDS;
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to load draft setup.'
      );
    } finally {
      this.loading.set(false);
    }
  }

  getTeamName(ownerId: string): string {
    return this.teams().find(
      (team) => team.ownerId === ownerId
    )?.teamName ?? 'Unknown Team';
  }

  formatScheduledStart(): string {
    const startDate = this.savedStartDate();

    if (!startDate) {
      return 'Not scheduled';
    }

    return startDate.toLocaleString(undefined, {
      dateStyle: 'full',
      timeStyle: 'short'
    });
  }

  randomizeOrder(): void {
    if (this.isDraftLocked()) {
      return;
    }

    const shuffledOrder = [...this.roundOneOrder()];

    for (
      let index = shuffledOrder.length - 1;
      index > 0;
      index--
    ) {
      const randomIndex = Math.floor(
        Math.random() * (index + 1)
      );

      [shuffledOrder[index], shuffledOrder[randomIndex]] = [
        shuffledOrder[randomIndex],
        shuffledOrder[index]
      ];
    }

    this.roundOneOrder.set(shuffledOrder);
    this.successMessage.set('');
  }

  resetOrder(): void {
    if (this.isDraftLocked()) {
      return;
    }

    this.roundOneOrder.set(
      this.teams().map((team) => team.ownerId)
    );

    this.successMessage.set('');
  }

  clearDraftStartTime(): void {
    if (this.isDraftLocked()) {
      return;
    }

    this.draftStartInput = '';
    this.successMessage.set('');
  }

  moveTeam(index: number, direction: -1 | 1): void {
    if (this.isDraftLocked()) {
      return;
    }

    const newIndex = index + direction;
    const currentOrder = [...this.roundOneOrder()];

    if (
      newIndex < 0 ||
      newIndex >= currentOrder.length
    ) {
      return;
    }

    [currentOrder[index], currentOrder[newIndex]] = [
      currentOrder[newIndex],
      currentOrder[index]
    ];

    this.roundOneOrder.set(currentOrder);
    this.successMessage.set('');
  }

  isDraftLocked(): boolean {
    const status = this.draft()?.status;

    return (
      status === 'live' ||
      status === 'complete' ||
      this.startTimeReached()
    );
  }

  async saveDraftOrder(): Promise<void> {
    this.errorMessage.set('');
    this.successMessage.set('');
    this.projectionPreparationWarning.set('');

    if (this.isDraftLocked()) {
      this.errorMessage.set(
        'Draft settings are locked because the draft has started or its scheduled start time has arrived.'
      );
      return;
    }

    const order = this.roundOneOrder();

    if (order.length === 0) {
      this.errorMessage.set(
        'At least one team is required before saving a draft order.'
      );
      return;
    }

    const scheduledStartDate =
      this.getSelectedDraftStartDate();

    if (
      this.draftStartInput &&
      !scheduledStartDate
    ) {
      this.errorMessage.set(
        'Choose a valid draft date and start time.'
      );
      return;
    }

    if (
      scheduledStartDate &&
      scheduledStartDate.getTime() <= Date.now()
    ) {
      this.errorMessage.set(
        'Draft start time must be in the future.'
      );
      return;
    }

    this.saving.set(true);

    try {
      const existingDraft = this.draft();

      const draftToSave: FantasyDraft = {
        ...(existingDraft ?? createDefaultFantasyDraft(order)),
        schemaVersion: 2,
        status: scheduledStartDate
          ? 'scheduled'
          : 'setup',
        format: 'snake',
        totalRounds: this.totalRounds,
        rosterRequirements: {
          ...DEFAULT_DRAFT_ROSTER_REQUIREMENTS
        },
        roundOneOrder: [...order],
        scheduledStartAt: scheduledStartDate,
        pickSeconds: this.pickSecondsInput,
        clockStatus: 'stopped',
        pickStartedAt: null,
        currentPickSeconds: this.pickSecondsInput,
        pausedRemainingSeconds: null,
        clockUpdatedBy: null,
        lastPickId: existingDraft?.lastPickId ?? null
      };

      await saveFantasyDraft(
        this.leagueId,
        draftToSave
      );

      this.draft.set(draftToSave);

      if (scheduledStartDate) {
        this.successMessage.set(
          'Draft settings saved. Preparing an initial shared ranking now.'
        );

        try {
          const snapshot =
            await generateSharedProjectionSnapshot({
              leagueId: this.leagueId,
              teamCount: Math.max(
                this.league()?.maxTeams ??
                  this.teams().length,
                2
              ),
              requiredGamesPerCycle:
                this.league()?.scoringRules
                  ?.requiredGamesPerCycle ?? 6,
              generationReason: 'draft-setup'
            });

          this.successMessage.set(
            `Draft settings saved and ${snapshot.metadata.assetCount} shared projections prepared. They will refresh again ${PRE_DRAFT_PROJECTION_WARMUP_MINUTES} minutes before the draft when the commissioner has the Draft Room open.`
          );
        } catch (projectionError: unknown) {
          this.successMessage.set(
            'Draft settings were saved.'
          );

          this.projectionPreparationWarning.set(
            projectionError instanceof Error
              ? `The initial shared projection build did not finish: ${projectionError.message} The Draft Room will retry before the scheduled start.`
              : 'The initial shared projection build did not finish. The Draft Room will retry before the scheduled start.'
          );
        }
      } else {
        this.successMessage.set(
          'Draft order saved. No start time is scheduled yet.'
        );
      }
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to save draft setup.'
      );
    } finally {
      this.saving.set(false);
    }
  }

  private getSelectedDraftStartDate(): Date | null {
    if (!this.draftStartInput) {
      return null;
    }

    const date = new Date(this.draftStartInput);

    if (Number.isNaN(date.getTime())) {
      return null;
    }

    return date;
  }

  private toDateTimeLocalValue(
    date: Date | null
  ): string {
    if (!date) {
      return '';
    }

    const pad = (value: number) =>
      value.toString().padStart(2, '0');

    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate())
    ].join('-') +
      'T' +
      [
        pad(date.getHours()),
        pad(date.getMinutes())
      ].join(':');
  }
}