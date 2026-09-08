import { Component, computed, HostListener, OnDestroy, signal } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { onAuthStateChanged, User } from 'firebase/auth';

import { ManagerAvatar } from '../../../shared/manager-avatar/manager-avatar';
import {
  settleOperationWithin,
  waitForOperationDelay,
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
  DRAFT_MINIMUM_UNPREPARED_START_LEAD_MILLISECONDS,
  getDraftSetupSchedulingGateState,
  getEarliestSafeDraftStartMilliseconds,
  hasStoredExactDraftReadinessForSchedule,
  type DraftSetupSchedulingGateState,
} from '../../../core/draft/draft-scheduling-gate.util';

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
  savePhase = signal<'idle' | 'saving' | 'confirming'>('idle');
  errorMessage = signal('');
  successMessage = signal('');

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

  getDraftSchedulingGateState(): DraftSetupSchedulingGateState {
    return getDraftSetupSchedulingGateState({
      draft: this.draft(),
      selectedStartMilliseconds: this.getSelectedDraftStartDate()?.getTime() ?? null,
      nowMilliseconds: this.now(),
    });
  }

  getDraftPreparationStatusTitle(): string {
    if (this.draftStartInput && !this.getSelectedDraftStartDate()) {
      return 'Choose a valid start time';
    }

    switch (this.getDraftSchedulingGateState()) {
      case 'past':
        return 'Choose a future start time';
      case 'unsafe-near-term':
        return 'More preparation time is required';
      case 'exact-ready':
        return 'Exact Draft data is ready';
      case 'safe-lead':
        return 'Safe preparation window';
      default:
        return 'Preparation starts after scheduling';
    }
  }

  getDraftPreparationStatusDetail(): string {
    const selectedStartDate = this.getSelectedDraftStartDate();
    const selectedStartMilliseconds = selectedStartDate?.getTime() ?? null;
    const gateState = this.getDraftSchedulingGateState();

    if (this.draftStartInput && !selectedStartDate) {
      return 'Enter a complete date and time before saving Draft settings.';
    }

    if (gateState === 'past') {
      return 'The Draft server cannot schedule a start time that has already arrived.';
    }

    if (gateState === 'unsafe-near-term') {
      return `This start is less than ${DRAFT_MINIMUM_UNPREPARED_START_LEAD_MILLISECONDS / 60_000} minutes away, but its exact injury-bound Projection V11 snapshot is not verified. Choose ${this.getEarliestSafeStartText()} or later. The server will leave the Draft stopped at zero picks if NHL data is delayed or rate-limited.`;
    }

    if (gateState === 'exact-ready') {
      return 'The saved start time, current injury revision, Projection V11 request, snapshot, and integrity hash are bound together. The server will verify them again when you save.';
    }

    if (gateState === 'safe-lead') {
      const draft = this.draft();
      const savedStartMilliseconds = getScheduledStartDate(draft)?.getTime() ?? null;

      if (savedStartMilliseconds === selectedStartMilliseconds) {
        switch (draft?.serverDraftReadinessStatus) {
          case 'waiting-injury':
            return 'The server is waiting for a successful NHL injury update. The Draft remains scheduled, stopped, and at zero picks.';
          case 'preparing-projection':
            return 'The one authoritative server request is preparing the exact injury-bound Projection V11 Draft board.';
          case 'error':
            return 'Preparation is waiting for its bounded server retry. The Draft remains scheduled, stopped, and at zero picks.';
          case 'ready':
            return 'Stored readiness is being revalidated because one or more exact evidence fields do not match this selected time.';
        }
      }

      return 'After save, the server will start one authoritative preparation inside the 20-minute readiness window. No browser-generated setup build is needed.';
    }

    return `Choose a start at least ${DRAFT_MINIMUM_UNPREPARED_START_LEAD_MILLISECONDS / 60_000} minutes away. A nearer start is allowed only when that exact saved schedule is already verified.`;
  }

  getEarliestSafeStartText(): string {
    const earliestMilliseconds = getEarliestSafeDraftStartMilliseconds(this.now());

    return earliestMilliseconds === null
      ? 'a later time'
      : new Date(earliestMilliseconds).toLocaleString(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        });
  }

  getDraftSaveStatusTitle(): string {
    switch (this.savePhase()) {
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
      case 'saving':
        return 'The secure server is validating the start time and exact readiness evidence. Navigation remains protected until it responds.';
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
    this.savePhase.set('saving');
    this.pendingDraftSaveAction?.finish('cancelled');
    this.pendingDraftSaveAction = this.actionMonitor.begin('draft-settings');
    let outcome: 'success' | 'error' | 'uncertain' = 'error';

    try {
      const existingDraft = this.draft();
      const preserveExactReadiness = scheduledStartDate
        ? hasStoredExactDraftReadinessForSchedule(
            existingDraft,
            scheduledStartDate.getTime(),
          )
        : false;

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
        projectionPreparationRequestId: preserveExactReadiness
          ? existingDraft?.serverDraftReadinessProjectionRequestId ?? null
          : null,
        projectionPreparationStatus: preserveExactReadiness ? 'ready' : null,
        serverDraftReadinessStatus: preserveExactReadiness ? 'ready' : null,
        serverDraftReadinessScheduledStartAt: preserveExactReadiness
          ? existingDraft?.serverDraftReadinessScheduledStartAt ?? null
          : null,
        serverDraftReadinessAvailabilityRevision: preserveExactReadiness
          ? existingDraft?.serverDraftReadinessAvailabilityRevision ?? null
          : null,
        serverDraftReadinessProjectionRequestId: preserveExactReadiness
          ? existingDraft?.serverDraftReadinessProjectionRequestId ?? null
          : null,
        serverDraftReadinessProjectionSnapshotId: preserveExactReadiness
          ? existingDraft?.serverDraftReadinessProjectionSnapshotId ?? null
          : null,
        serverDraftReadinessProjectionSnapshotHash: preserveExactReadiness
          ? existingDraft?.serverDraftReadinessProjectionSnapshotHash ?? null
          : null,
        serverDraftReadinessAttemptCount: preserveExactReadiness
          ? existingDraft?.serverDraftReadinessAttemptCount ?? 0
          : 0,
        serverDraftReadinessRetryAfterAt: null,
        serverDraftReadinessMessage: preserveExactReadiness
          ? existingDraft?.serverDraftReadinessMessage ?? null
          : null,
        serverDraftProjectionSnapshotId: preserveExactReadiness
          ? existingDraft?.serverDraftProjectionSnapshotId ?? null
          : null,
        serverDraftProjectionSnapshotHash: preserveExactReadiness
          ? existingDraft?.serverDraftProjectionSnapshotHash ?? null
          : null,
        serverDraftProjectionAuthorityVersion: preserveExactReadiness
          ? existingDraft?.serverDraftProjectionAuthorityVersion ?? null
          : null,
        serverDraftProjectionCatalogHash: preserveExactReadiness
          ? existingDraft?.serverDraftProjectionCatalogHash ?? null
          : null,
      };
      const expectation: DraftSettingsExpectation = {
        submissionId,
        roundOneOrder: [...order],
        scheduledStartAtMilliseconds: scheduledStartDate?.getTime() ?? null,
        pickSeconds: this.pickSecondsInput,
        status: scheduledStartDate ? 'scheduled' : 'setup',
      };

      this.savePhase.set('saving');
      const savePromise = saveFantasyDraft(
        this.leagueId,
        draftToSave,
        submissionId,
      );
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
          preserveExactReadiness
            ? 'Draft settings saved with the exact verified injury-bound Projection V11 snapshot. The server will revalidate it before opening the Draft.'
            : 'Draft time saved. One authoritative server preparation will begin inside the 20-minute readiness window. You may leave this page.',
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
