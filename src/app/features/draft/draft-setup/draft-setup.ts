import { Component, computed, HostListener, OnDestroy, signal } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { onAuthStateChanged, User } from 'firebase/auth';

import { ManagerAvatar } from '../../../shared/manager-avatar/manager-avatar';
import {
  settleOperationWithin,
  waitForOperationDelay,
  withOperationDeadline,
} from '../../../core/async/bounded-operation.util';
import {
  CompetitiveActionMonitorService,
  type CompetitiveActionHandle,
} from '../../../core/observability/competitive-action-monitor.service';
import { getFantasyTeamProfileIconId } from '../../../core/team/team.service';
import { auth } from '../../../core/firebase';

import {
  buildSnakePickPreview,
  createDefaultFantasyDraft,
  DEFAULT_DRAFT_BENCH_SLOTS,
  DEFAULT_DRAFT_PICK_SECONDS,
  DEFAULT_DRAFT_ROSTER_REQUIREMENTS,
  DEFAULT_DRAFT_TOTAL_ROUNDS,
  DRAFT_PICK_SECONDS_OPTIONS,
  getFantasyDraft,
  getFantasyDraftFromServer,
  getScheduledStartDate,
  isDraftStartTimeReached,
  saveFantasyDraft,
} from '../../../core/draft/draft.service';

import { DraftPickPreview, FantasyDraft } from '../../../core/draft/draft.models';
import {
  draftSettingsMatchExpectation,
  type DraftSettingsExpectation,
} from './draft-settings-confirmation.util';

import {
  generateSharedProjectionSnapshot,
  isSharedProjectionSnapshotFreshForDraft,
  loadSharedProjectionSnapshotMetadata,
  SHARED_PROJECTION_VERSION,
} from '../../../core/projection/projection-snapshot.service';

import { getLeagueById, League } from '../../../core/league/league.service';

import { FantasyTeam, getLeagueTeams } from '../../../core/team/team.service';

function waitForAuthUser(): Promise<User | null> {
  if (auth.currentUser) {
    return Promise.resolve(auth.currentUser);
  }

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
  imports: [FormsModule, RouterLink, ManagerAvatar],
  templateUrl: './draft-setup.html',
  styleUrl: './draft-setup.css',
})
export class DraftSetup implements OnDestroy {
  leagueId = '';

  league = signal<League | null>(null);
  teams = signal<FantasyTeam[]>([]);
  draft = signal<FantasyDraft | null>(null);
  roundOneOrder = signal<string[]>([]);

  loading = signal(true);
  saving = signal(false);
  savePhase = signal<'idle' | 'preparing' | 'saving' | 'confirming'>('idle');
  errorMessage = signal('');
  successMessage = signal('');
  projectionPreparationWarning = signal('');

  draftStartInput = '';
  pickSecondsInput = DEFAULT_DRAFT_PICK_SECONDS;
  readonly pickSecondsOptions = DRAFT_PICK_SECONDS_OPTIONS;

  readonly minimumStartInput = this.toDateTimeLocalValue(new Date());

  readonly now = signal(Date.now());

  private readonly clockTimer = setInterval(() => {
    this.now.set(Date.now());
  }, 1000);

  private draftSaveGeneration = 0;
  private pendingDraftSaveAction: CompetitiveActionHandle | null = null;

  readonly totalRounds = DEFAULT_DRAFT_TOTAL_ROUNDS;

  readonly savedStartDate = computed(() => getScheduledStartDate(this.draft()));

  readonly startTimeReached = computed(() =>
    isDraftStartTimeReached(this.draft(), new Date(this.now())),
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

    const millisecondsRemaining = startDate.getTime() - this.now();

    if (millisecondsRemaining <= 0) {
      return 'The scheduled start time has arrived.';
    }

    const totalSeconds = Math.floor(millisecondsRemaining / 1000);

    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
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

    return Array.from({ length: this.totalRounds }, (_, index) => {
      const round = index + 1;

      return {
        round,
        picks: picks.filter((pick) => pick.round === round),
      };
    });
  });

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private readonly actionMonitor: CompetitiveActionMonitorService,
  ) {
    this.loadDraftSetup();
  }

  ngOnDestroy(): void {
    clearInterval(this.clockTimer);
    this.draftSaveGeneration += 1;
    this.pendingDraftSaveAction?.finish('cancelled');
    this.pendingDraftSaveAction = null;
  }

  canLeaveDraftSetup(): boolean {
    return !this.saving();
  }

  @HostListener('window:beforeunload', ['$event'])
  preventWindowExitWhileSaving(event: BeforeUnloadEvent): void {
    if (!this.saving()) {
      return;
    }

    event.preventDefault();
    event.returnValue = '';
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
        getFantasyDraft(leagueId),
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
        existingDraft.roundOneOrder.every((ownerId) => teamIds.includes(ownerId)) &&
        teamIds.every((ownerId) => existingDraft.roundOneOrder.includes(ownerId));

      this.league.set(league);
      this.teams.set(teams);
      this.draft.set(existingDraft);

      this.roundOneOrder.set(savedOrderIsValid ? [...existingDraft.roundOneOrder] : teamIds);

      this.draftStartInput = this.toDateTimeLocalValue(getScheduledStartDate(existingDraft));

      this.pickSecondsInput = existingDraft?.pickSeconds ?? DEFAULT_DRAFT_PICK_SECONDS;
    } catch (error: unknown) {
      this.errorMessage.set(error instanceof Error ? error.message : 'Unable to load draft setup.');
    } finally {
      this.loading.set(false);
    }
  }

  getTeamName(ownerId: string): string {
    return this.teams().find((team) => team.ownerId === ownerId)?.teamName ?? 'Unknown Team';
  }

  formatScheduledStart(): string {
    const startDate = this.savedStartDate();

    if (!startDate) {
      return 'Not scheduled';
    }

    return startDate.toLocaleString(undefined, {
      dateStyle: 'full',
      timeStyle: 'short',
    });
  }

  randomizeOrder(): void {
    if (this.isDraftLocked()) {
      return;
    }

    const shuffledOrder = [...this.roundOneOrder()];

    for (let index = shuffledOrder.length - 1; index > 0; index--) {
      const randomIndex = Math.floor(Math.random() * (index + 1));

      [shuffledOrder[index], shuffledOrder[randomIndex]] = [
        shuffledOrder[randomIndex],
        shuffledOrder[index],
      ];
    }

    this.roundOneOrder.set(shuffledOrder);
    this.successMessage.set('');
  }

  resetOrder(): void {
    if (this.isDraftLocked()) {
      return;
    }

    this.roundOneOrder.set(this.teams().map((team) => team.ownerId));

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

    if (newIndex < 0 || newIndex >= currentOrder.length) {
      return;
    }

    [currentOrder[index], currentOrder[newIndex]] = [currentOrder[newIndex], currentOrder[index]];

    this.roundOneOrder.set(currentOrder);
    this.successMessage.set('');
  }

  isDraftLocked(): boolean {
    const status = this.draft()?.status;

    return status === 'live' || status === 'complete' || this.startTimeReached();
  }

  getDraftSaveStatusTitle(): string {
    switch (this.savePhase()) {
      case 'preparing':
        return `Preparing Projection V${SHARED_PROJECTION_VERSION} rankings…`;
      case 'saving':
        return 'Sending draft settings…';
      case 'confirming':
        return 'Confirming the saved draft time…';
      default:
        return 'Draft settings are ready.';
    }
  }

  getDraftSaveStatusDetail(): string {
    switch (this.savePhase()) {
      case 'preparing':
        return 'RinkRat is building the verified draft board. The page stays readable and the operation releases automatically if a data request stops responding.';
      case 'saving':
        return 'The secure draft command is being sent. Navigation remains protected until the server or the authoritative draft document confirms the save.';
      case 'confirming':
        return 'RinkRat is checking the saved draft document directly. A slow browser response cannot keep this page pending forever.';
      default:
        return '';
    }
  }

  private createDraftSettingsSubmissionId(): string {
    const randomPart =
      typeof globalThis.crypto !== 'undefined' &&
      typeof globalThis.crypto.randomUUID === 'function'
        ? globalThis.crypto.randomUUID().replaceAll('-', '')
        : `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;

    return `settings_${Date.now().toString(36)}_${randomPart}`.slice(0, 120);
  }

  async saveDraftOrder(): Promise<void> {
    if (this.saving()) {
      return;
    }

    this.errorMessage.set('');
    this.successMessage.set('');
    this.projectionPreparationWarning.set('');

    if (this.isDraftLocked()) {
      this.errorMessage.set(
        'Draft settings are locked because the draft has started or its scheduled start time has arrived.',
      );
      return;
    }

    const order = this.roundOneOrder();

    if (order.length === 0) {
      this.errorMessage.set('At least one team is required before saving a draft order.');
      return;
    }

    const scheduledStartDate = this.getSelectedDraftStartDate();

    if (this.draftStartInput && !scheduledStartDate) {
      this.errorMessage.set('Choose a valid draft date and start time.');
      return;
    }

    if (scheduledStartDate && scheduledStartDate.getTime() <= Date.now()) {
      this.errorMessage.set('Draft start time must be in the future.');
      return;
    }

    const generation = ++this.draftSaveGeneration;
    const submissionId = this.createDraftSettingsSubmissionId();
    this.saving.set(true);
    this.savePhase.set(scheduledStartDate ? 'preparing' : 'saving');
    this.pendingDraftSaveAction?.finish('cancelled');
    this.pendingDraftSaveAction = this.actionMonitor.begin('draft-settings');
    let outcome: 'success' | 'error' | 'uncertain' = 'error';

    try {
      const existingDraft = this.draft();
      let preparedAssetCount: number | null = null;

      if (scheduledStartDate) {
        this.successMessage.set(
          `Checking verified Projection V${SHARED_PROJECTION_VERSION} rankings before the schedule is saved…`,
        );

        try {
          const projectionInput = {
            leagueId: this.leagueId,
            teamCount: Math.max(this.teams().length, 2),
            requiredGamesPerCycle: this.league()?.scoringRules?.requiredGamesPerCycle ?? 6,
            generationReason: 'draft-setup' as const,
          };
          const metadataResult = await settleOperationWithin(
            loadSharedProjectionSnapshotMetadata(this.leagueId),
            7_000,
          );
          const existingMetadata = metadataResult.status === 'fulfilled'
            ? metadataResult.value
            : null;

          if (
            isSharedProjectionSnapshotFreshForDraft(existingMetadata, {
              teamCount: projectionInput.teamCount,
              requiredGamesPerCycle: projectionInput.requiredGamesPerCycle,
              now: new Date(),
            })
          ) {
            preparedAssetCount = existingMetadata?.assetCount ?? null;
            this.successMessage.set(
              `Using the existing verified Projection V${SHARED_PROJECTION_VERSION} draft board…`,
            );
          } else {
            this.successMessage.set(
              `Building verified Projection V${SHARED_PROJECTION_VERSION} rankings before the schedule is saved…`,
            );
            const snapshot = await withOperationDeadline(
              generateSharedProjectionSnapshot(projectionInput),
              75_000,
              `Projection V${SHARED_PROJECTION_VERSION} preparation took too long. The page has been released without changing the saved draft settings. Check the connection and try again.`,
            );

            if (generation !== this.draftSaveGeneration) {
              return;
            }

            if (
              snapshot.metadata.status !== 'ready' ||
              snapshot.metadata.generationReason === 'server-emergency' ||
              snapshot.assets.length === 0
            ) {
              throw new Error('The verified ranking snapshot was incomplete.');
            }

            preparedAssetCount = snapshot.metadata.assetCount;
          }
        } catch (projectionError: unknown) {
          const detail = projectionError instanceof Error
            ? projectionError.message
            : 'The projection build did not finish.';

          throw new Error(
            `The draft was not scheduled because verified Projection V${SHARED_PROJECTION_VERSION} rankings could not be prepared. ${detail} Your previous saved draft settings were left unchanged.`,
          );
        }
      }

      const draftToSave: FantasyDraft = {
        ...(existingDraft ?? createDefaultFantasyDraft(order)),
        schemaVersion: 3,
        status: scheduledStartDate ? 'scheduled' : 'setup',
        format: 'snake',
        totalRounds: this.totalRounds,
        rosterRequirements: {
          ...DEFAULT_DRAFT_ROSTER_REQUIREMENTS,
        },
        benchSlots: DEFAULT_DRAFT_BENCH_SLOTS,
        roundOneOrder: [...order],
        scheduledStartAt: scheduledStartDate,
        pickSeconds: this.pickSecondsInput,
        clockStatus: 'stopped',
        pickStartedAt: null,
        currentPickSeconds: this.pickSecondsInput,
        pausedRemainingSeconds: null,
        clockUpdatedBy: null,
        lastPickId: existingDraft?.lastPickId ?? null,
        lastSettingsSubmissionId: submissionId,
        serverDraftProjectionSnapshotId: null,
        serverDraftProjectionSnapshotHash: null,
        serverDraftProjectionAuthorityVersion: null,
        serverDraftProjectionCatalogHash: null,
      };
      const expectation: DraftSettingsExpectation = {
        submissionId,
        roundOneOrder: [...order],
        scheduledStartAtMilliseconds: scheduledStartDate?.getTime() ?? null,
        pickSeconds: this.pickSecondsInput,
        status: scheduledStartDate ? 'scheduled' : 'setup',
      };

      this.savePhase.set('saving');
      const savePromise = saveFantasyDraft(this.leagueId, draftToSave, submissionId);
      this.savePhase.set('confirming');
      const observedDraft = await this.awaitDraftSettingsConfirmation(
        savePromise,
        expectation,
        generation,
      );

      if (generation !== this.draftSaveGeneration) {
        return;
      }

      this.draft.set(observedDraft ?? draftToSave);

      if (scheduledStartDate) {
        this.successMessage.set(
          `Draft settings saved with ${preparedAssetCount ?? 0} verified shared projections. The server can open and complete the draft even when every browser is closed.`,
        );
      } else {
        this.successMessage.set('Draft order saved. No start time is scheduled yet.');
      }
      outcome = 'success';
    } catch (error: unknown) {
      const message = error instanceof Error
        ? error.message
        : 'Unable to save the draft settings.';
      this.errorMessage.set(message);
      outcome = /may still have saved|check the saved draft settings|could not confirm/i.test(message)
        ? 'uncertain'
        : 'error';
    } finally {
      if (generation === this.draftSaveGeneration) {
        this.saving.set(false);
        this.savePhase.set('idle');
        this.pendingDraftSaveAction?.finish(outcome);
        this.pendingDraftSaveAction = null;
      }
    }
  }

  private isPossiblyCommittedDraftSettingsError(error: unknown): boolean {
    const rawCode =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
    const code = rawCode.toLowerCase();

    return [
      'deadline-exceeded',
      'unavailable',
      'internal',
      'unknown',
      'cancelled',
      'network-request-failed',
    ].some((candidate) => code.includes(candidate));
  }

  private async awaitDraftSettingsConfirmation(
    actionPromise: Promise<void>,
    expectation: DraftSettingsExpectation,
    generation: number,
  ): Promise<FantasyDraft | null> {
    let actionSettled = false;
    let actionRejected = false;
    let actionError: unknown;

    void actionPromise.then(
      () => {
        actionSettled = true;
      },
      (error: unknown) => {
        actionSettled = true;
        actionRejected = true;
        actionError = error;
      },
    );

    const deadline = Date.now() + 35_000;

    while (generation === this.draftSaveGeneration && Date.now() <= deadline) {
      if (actionSettled && !actionRejected) {
        return null;
      }

      const probe = await settleOperationWithin(
        getFantasyDraftFromServer(this.leagueId),
        4_000,
      );

      if (generation !== this.draftSaveGeneration) {
        return null;
      }

      if (
        probe.status === 'fulfilled' &&
        draftSettingsMatchExpectation(probe.value, expectation)
      ) {
        return probe.value;
      }

      if (
        actionSettled &&
        actionRejected &&
        !this.isPossiblyCommittedDraftSettingsError(actionError)
      ) {
        throw actionError;
      }

      await waitForOperationDelay(1_000);
    }

    if (actionSettled && !actionRejected) {
      return null;
    }

    const finalProbe = await settleOperationWithin(
      getFantasyDraftFromServer(this.leagueId),
      5_000,
    );

    if (
      finalProbe.status === 'fulfilled' &&
      draftSettingsMatchExpectation(finalProbe.value, expectation)
    ) {
      return finalProbe.value;
    }

    if (
      actionSettled &&
      actionRejected &&
      !this.isPossiblyCommittedDraftSettingsError(actionError)
    ) {
      throw actionError;
    }

    throw new Error(
      'RinkRat could not confirm the saved draft settings within the safety window. The page has been unlocked. Check the saved draft time before retrying because the server request may still have saved it.',
    );
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

  private toDateTimeLocalValue(date: Date | null): string {
    if (!date) {
      return '';
    }

    const pad = (value: number) => value.toString().padStart(2, '0');

    return (
      [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-') +
      'T' +
      [pad(date.getHours()), pad(date.getMinutes())].join(':')
    );
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
