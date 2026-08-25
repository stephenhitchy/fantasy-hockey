import { Component, computed, OnDestroy, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { onAuthStateChanged, User } from 'firebase/auth';

import { withOperationDeadline } from '../../../core/async/bounded-operation.util';
import { auth } from '../../../core/firebase-auth';
import {
  buildLeagueInvitePath,
  markPendingLeagueInviteTrainingCampComplete,
  pendingLeagueInviteAccountMatch,
  readPendingLeagueInvite,
} from '../../../core/league/invite-link-intent.service';
import {
  getVerificationEmailState,
  requestVerificationEmail,
  type VerificationEmailResponse,
} from '../../../core/notifications/email-notification.service';
import {
  getVerificationCooldownSeconds,
  getVerificationSendButtonLabel,
} from '../../../core/notifications/verification-email-state.util';
import { TelemetryService } from '../../../core/observability/telemetry.service';
import {
  completeTrainingCamp,
  CURRENT_TRAINING_CAMP_VERSION,
  deferTrainingCamp,
  hasCompletedTrainingCamp,
  hasResolvedTrainingCampOnboarding,
} from '../../../core/onboarding/training-camp.service';
import { getUserProfile } from '../../../core/user/user.service';
import { HockeyTermChip } from '../../../shared/hockey-terms/hockey-term-chip';
import { TRAINING_CAMP_FOOTBALL_COMPARISONS } from './training-camp-football-comparison.data';
import { TRAINING_CAMP_STEPS, TRAINING_CAMP_TOTAL_DRILLS } from './training-camp.data';

interface StoredTrainingCampProgress {
  version: number;
  stepIndex: number;
  drillIndex: number;
  unlockedStepIndex: number;
}

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

function clampInteger(value: unknown, minimum: number, maximum: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(parsed)) {
    return minimum;
  }

  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

@Component({
  selector: 'app-training-camp',
  standalone: true,
  imports: [RouterLink, HockeyTermChip],
  templateUrl: './training-camp.html',
  styleUrl: './training-camp.css',
})
export class TrainingCamp implements OnDestroy {
  readonly footballPositionComparisons = TRAINING_CAMP_FOOTBALL_COMPARISONS;
  readonly steps = TRAINING_CAMP_STEPS;

  readonly currentStepIndex = signal(0);
  readonly currentDrillIndex = signal(0);
  readonly highestUnlockedStepIndex = signal(0);

  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly completed = signal(false);
  readonly previouslyCompleted = signal(false);
  readonly errorMessage = signal('');
  readonly verificationPromptVisible = signal(false);
  readonly verificationEmail = signal('');
  readonly sendingVerification = signal(false);
  readonly refreshingVerification = signal(false);
  readonly verificationStatusMessage = signal('');
  readonly verificationEmailPreviouslySent = signal(false);
  readonly verificationEmailEligible = signal(false);
  readonly verificationCooldownSeconds = signal(0);
  readonly trainingCampOutcome = signal<'completed' | 'deferred'>('completed');
  readonly inviteContinuationActive = signal(false);
  readonly pendingInviteCode = signal('');

  readonly exitActionLabel = computed(() => {
    if (this.saving()) {
      return 'Saving...';
    }

    if (this.previouslyCompleted()) {
      return this.inviteContinuationActive() ? 'Return to Invitation' : 'Exit Training Camp';
    }

    return 'Finish Later';
  });
  readonly verificationSendButtonLabel = computed(() =>
    getVerificationSendButtonLabel({
      sending: this.sendingVerification(),
      emailPreviouslySent: this.verificationEmailPreviouslySent(),
      cooldownSeconds: this.verificationCooldownSeconds(),
    }),
  );
  readonly verificationSendDisabled = computed(() =>
    this.sendingVerification() ||
    this.refreshingVerification() ||
    !this.verificationEmailEligible() ||
    this.verificationCooldownSeconds() > 0,
  );
  readonly verificationPromptTitle = computed(() =>
    this.verificationEmailPreviouslySent()
      ? 'Check your email before the next faceoff'
      : 'Send your verification email',
  );
  readonly verificationPromptInstruction = computed(() =>
    this.verificationEmailPreviouslySent()
      ? 'Open the latest verification email, then return to RinkRat.'
      : 'Press the button below when you are ready. RinkRat will not send the first email until you do.',
  );
  readonly verifyLaterLabel = computed(() =>
    this.trainingCampOutcome() === 'completed' ? 'Verify Later' : 'Continue to Dashboard',
  );
  readonly currentStep = computed(() => this.steps[this.currentStepIndex()] ?? this.steps[0]!);
  readonly currentDrill = computed(
    () => this.currentStep().drills[this.currentDrillIndex()] ?? this.currentStep().drills[0]!,
  );
  readonly isFirstStep = computed(() => this.currentStepIndex() === 0);
  readonly isLastStep = computed(() => this.currentStepIndex() === this.steps.length - 1);
  readonly isFirstDrill = computed(
    () => this.currentStepIndex() === 0 && this.currentDrillIndex() === 0,
  );
  readonly isLastDrill = computed(
    () => this.currentDrillIndex() === this.currentStep().drills.length - 1,
  );
  readonly canAdvance = computed(() => !this.saving());
  readonly progressPercent = computed(() => {
    if (this.previouslyCompleted()) {
      return 100;
    }

    const unlockedIndex = this.highestUnlockedStepIndex();
    let completedDrills = this.steps
      .slice(0, unlockedIndex)
      .reduce((total, step) => total + step.drills.length, 0);

    if (this.currentStepIndex() === unlockedIndex) {
      completedDrills += this.currentDrillIndex();
    }

    return Math.round((completedDrills / TRAINING_CAMP_TOTAL_DRILLS) * 100);
  });
  readonly scoringGuideQueryParams = computed(() => ({
    from: 'training-camp',
    shift: this.currentStepIndex() + 1,
    drill: this.currentDrillIndex() + 1,
    continue: this.inviteContinuationActive() ? 'league-invite' : null,
  }));

  readonly primaryActionLabel = computed(() => {
    if (this.saving()) {
      return 'Saving...';
    }

    if (this.isLastStep() && this.isLastDrill()) {
      return 'Finish Training Camp';
    }

    if (this.isLastDrill()) {
      return `Start Shift ${this.currentStepIndex() + 2}`;
    }

    return 'Next Drill';
  });

  private userId = '';
  private verificationNextAllowedAtMillis = 0;
  private verificationCooldownTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly telemetry: TelemetryService,
  ) {
    void this.initialize();
  }

  ngOnDestroy(): void {
    this.clearVerificationCooldownTimer();
  }

  canOpenStep(index: number): boolean {
    return (
      index >= 0 &&
      index < this.steps.length &&
      (this.previouslyCompleted() || index <= this.highestUnlockedStepIndex())
    );
  }

  isStepCleared(index: number): boolean {
    return this.previouslyCompleted() || index < this.highestUnlockedStepIndex();
  }

  selectStep(index: number): void {
    if (!this.canOpenStep(index) || this.saving()) {
      return;
    }

    this.currentStepIndex.set(index);
    this.currentDrillIndex.set(0);
    this.persistProgress();
    this.trackStepViewed();
    this.focusHeading();
  }

  previousDrill(): void {
    if (this.saving() || this.isFirstDrill()) {
      return;
    }

    if (this.currentDrillIndex() > 0) {
      this.currentDrillIndex.update((index) => index - 1);
    } else {
      const previousStepIndex = this.currentStepIndex() - 1;
      this.currentStepIndex.set(previousStepIndex);
      this.currentDrillIndex.set(this.steps[previousStepIndex]!.drills.length - 1);
    }

    this.persistProgress();
    this.trackStepViewed();
    this.focusHeading();
  }

  advanceDrill(): void {
    if (!this.canAdvance()) {
      return;
    }

    if (this.isLastStep() && this.isLastDrill()) {
      void this.finishTrainingCamp();
      return;
    }

    if (!this.isLastDrill()) {
      this.currentDrillIndex.update((index) => index + 1);
    } else {
      const nextStepIndex = this.currentStepIndex() + 1;
      this.highestUnlockedStepIndex.update((index) => Math.max(index, nextStepIndex));
      this.currentStepIndex.set(nextStepIndex);
      this.currentDrillIndex.set(0);
      this.telemetry.track('training_camp_shift_cleared', {
        version: CURRENT_TRAINING_CAMP_VERSION,
        shift: nextStepIndex,
      });
    }

    this.persistProgress();
    this.trackStepViewed();
    this.focusHeading();
  }

  reviewTrainingCamp(): void {
    this.completed.set(false);
    this.highestUnlockedStepIndex.set(this.steps.length - 1);
    this.currentStepIndex.set(0);
    this.currentDrillIndex.set(0);
    this.trackStepViewed();
    this.focusHeading();
  }

  async finishTrainingCamp(): Promise<void> {
    if (this.saving() || !this.userId) {
      return;
    }

    this.saving.set(true);
    this.errorMessage.set('');
    this.verificationStatusMessage.set('');

    try {
      await withOperationDeadline(
        completeTrainingCamp(this.userId),
        25_000,
        'RinkRat stopped waiting for Training Camp to save. The button has been released; reload before submitting again because the completion may still have saved.',
      );

      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem(`fantasy-hockey-dashboard-v4:${this.userId}`);
        sessionStorage.removeItem(this.progressStorageKey());
      }

      this.previouslyCompleted.set(true);
      this.trainingCampOutcome.set('completed');
      this.telemetry.track('training_camp_completed', {
        version: CURRENT_TRAINING_CAMP_VERSION,
        invite_continuation: this.inviteContinuationActive(),
      });

      await this.continueAfterTrainingCamp();
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to save your Training Camp progress right now.',
      );
    } finally {
      this.saving.set(false);
    }
  }

  async leaveTrainingCamp(): Promise<void> {
    if (this.saving() || !this.userId) {
      return;
    }

    if (this.previouslyCompleted()) {
      await this.leaveCompletedTrainingCamp();
      return;
    }

    this.saving.set(true);
    this.errorMessage.set('');
    this.verificationStatusMessage.set('');

    try {
      await withOperationDeadline(
        deferTrainingCamp(this.userId),
        25_000,
        'RinkRat stopped waiting while saving Training Camp for later. The button has been released; reload before trying again because the choice may still have saved.',
      );

      this.trainingCampOutcome.set('deferred');
      this.telemetry.track('training_camp_deferred', {
        version: CURRENT_TRAINING_CAMP_VERSION,
        step: this.currentStepIndex() + 1,
        drill: this.currentDrillIndex() + 1,
        invite_continuation: this.inviteContinuationActive(),
      });

      await this.continueAfterTrainingCamp();
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to save Training Camp for later right now.',
      );
    } finally {
      this.saving.set(false);
    }
  }

  async sendVerificationEmail(): Promise<void> {
    if (this.verificationSendDisabled()) {
      return;
    }

    this.errorMessage.set('');
    this.verificationStatusMessage.set('');
    this.sendingVerification.set(true);

    try {
      const result = await requestVerificationEmail();

      if (result.alreadyVerified) {
        await this.finishVerificationStep();
        return;
      }

      this.applyVerificationEmailState(result);

      if (result.outcome === 'cooldown') {
        this.verificationStatusMessage.set(
          'A verification email was sent recently. You can send another when the countdown finishes.',
        );
      } else if (result.outcome === 'blocked') {
        this.errorMessage.set(
          'Finish Training Camp or choose Finish Later before sending the verification email.',
        );
      } else {
        this.verificationStatusMessage.set(
          `${result.firstSend ? 'Verification email sent.' : 'Another verification email sent.'} Check your inbox and spam folder, open the link, then return here.`,
        );
      }
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to send a verification email right now.',
      );
    } finally {
      this.sendingVerification.set(false);
    }
  }

  async refreshVerificationStatus(): Promise<void> {
    const user = auth.currentUser;

    if (!user || this.refreshingVerification() || this.sendingVerification()) {
      return;
    }

    this.errorMessage.set('');
    this.verificationStatusMessage.set('');
    this.refreshingVerification.set(true);

    try {
      await user.reload();

      if (!user.emailVerified) {
        this.verificationStatusMessage.set(
          'Verification is not visible yet. Open the email link, then try again.',
        );
        return;
      }

      await user.getIdToken(true);
      await this.finishVerificationStep();
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'RinkRat could not refresh your verification status.',
      );
    } finally {
      this.refreshingVerification.set(false);
    }
  }

  async verifyLater(): Promise<void> {
    await this.finishVerificationStep();
  }

  private async leaveCompletedTrainingCamp(): Promise<void> {
    this.telemetry.track('training_camp_exited', {
      completed: true,
      step: this.currentStepIndex() + 1,
      drill: this.currentDrillIndex() + 1,
      invite_continuation: this.inviteContinuationActive(),
    });

    if (this.inviteContinuationActive()) {
      const intent = markPendingLeagueInviteTrainingCampComplete(
        this.userId,
        this.pendingInviteCode(),
      );
      const invitePath = buildLeagueInvitePath(intent?.inviteCode);

      if (invitePath) {
        await this.router.navigateByUrl(invitePath);
        return;
      }
    }

    await this.router.navigate(['/dashboard']);
  }

  private async continueAfterTrainingCamp(): Promise<void> {
    if (this.inviteContinuationActive()) {
      const intent = markPendingLeagueInviteTrainingCampComplete(
        this.userId,
        this.pendingInviteCode(),
      );
      const invitePath = buildLeagueInvitePath(intent?.inviteCode);

      if (invitePath) {
        await this.router.navigateByUrl(invitePath);
        return;
      }
    }

    const user = auth.currentUser;

    if (user) {
      try {
        await user.reload();
      } catch {
        // The verification prompt remains usable if the refresh is temporarily unavailable.
      }
    }

    if (user?.emailVerified) {
      await user.getIdToken(true).catch(() => undefined);
      await this.finishVerificationStep();
      return;
    }

    this.verificationEmail.set(user?.email ?? 'your account email');
    this.verificationEmailEligible.set(true);
    this.verificationStatusMessage.set('');
    this.verificationPromptVisible.set(true);
    void this.loadVerificationEmailState();
    this.focusHeading();
  }

  private async finishVerificationStep(): Promise<void> {
    this.verificationPromptVisible.set(false);

    if (this.trainingCampOutcome() === 'completed') {
      this.completed.set(true);
      this.focusHeading();
      return;
    }

    await this.router.navigate(['/dashboard']);
  }

  private async initialize(): Promise<void> {
    const user = await waitForAuthUser();

    if (!user) {
      await this.router.navigate(['/']);
      return;
    }

    this.userId = user.uid;

    const continuationRequested =
      this.route.snapshot.queryParamMap.get('continue') === 'league-invite';
    const pendingInvite = continuationRequested ? readPendingLeagueInvite() : null;
    const inviteMatchesAccount = pendingInvite
      ? pendingLeagueInviteAccountMatch(pendingInvite, user.uid) === 'matching'
      : false;

    this.inviteContinuationActive.set(
      Boolean(continuationRequested && pendingInvite && inviteMatchesAccount),
    );
    this.pendingInviteCode.set(
      this.inviteContinuationActive() ? pendingInvite?.inviteCode ?? '' : '',
    );

    try {
      const profile = await getUserProfile(user.uid);
      const alreadyComplete = hasCompletedTrainingCamp(profile);
      const onboardingResolved = hasResolvedTrainingCampOnboarding(profile);
      this.previouslyCompleted.set(alreadyComplete);
      this.telemetry.track('training_camp_started', {
        version: CURRENT_TRAINING_CAMP_VERSION,
        replay: alreadyComplete,
        invite_continuation: this.inviteContinuationActive(),
      });

      if (onboardingResolved && this.inviteContinuationActive()) {
        const intent = markPendingLeagueInviteTrainingCampComplete(
          user.uid,
          this.pendingInviteCode(),
        );
        const invitePath = buildLeagueInvitePath(intent?.inviteCode);

        if (invitePath) {
          await this.router.navigateByUrl(invitePath);
          return;
        }
      }

      if (onboardingResolved && !user.emailVerified) {
        this.trainingCampOutcome.set(alreadyComplete ? 'completed' : 'deferred');
        this.verificationEmail.set(user.email ?? 'your account email');
        this.verificationEmailEligible.set(true);
        this.verificationPromptVisible.set(true);
        void this.loadVerificationEmailState();
        this.focusHeading();
        return;
      }

      if (alreadyComplete) {
        this.highestUnlockedStepIndex.set(this.steps.length - 1);
      } else {
        this.restoreProgress();
      }

      this.restoreRequestedLesson();
      this.trackStepViewed();
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to load Training Camp progress.',
      );
    } finally {
      this.loading.set(false);
    }
  }

  private restoreProgress(): void {
    if (typeof sessionStorage === 'undefined') {
      return;
    }

    try {
      const raw = sessionStorage.getItem(this.progressStorageKey());

      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as Partial<StoredTrainingCampProgress>;

      if (parsed.version !== CURRENT_TRAINING_CAMP_VERSION) {
        sessionStorage.removeItem(this.progressStorageKey());
        return;
      }

      const lastStepIndex = this.steps.length - 1;
      const unlockedStepIndex = clampInteger(parsed.unlockedStepIndex, 0, lastStepIndex);
      const stepIndex = clampInteger(parsed.stepIndex, 0, unlockedStepIndex);
      const lastDrillIndex = this.steps[stepIndex]!.drills.length - 1;
      const drillIndex = clampInteger(parsed.drillIndex, 0, lastDrillIndex);

      this.highestUnlockedStepIndex.set(unlockedStepIndex);
      this.currentStepIndex.set(stepIndex);
      this.currentDrillIndex.set(drillIndex);
    } catch {
      sessionStorage.removeItem(this.progressStorageKey());
    }
  }

  private restoreRequestedLesson(): void {
    const shiftValue = this.route.snapshot.queryParamMap.get('shift');
    const drillValue = this.route.snapshot.queryParamMap.get('drill');

    if (!shiftValue || !drillValue) {
      return;
    }

    const requestedStepIndex = Number(shiftValue) - 1;
    const requestedDrillIndex = Number(drillValue) - 1;

    if (
      !Number.isInteger(requestedStepIndex) ||
      !Number.isInteger(requestedDrillIndex) ||
      requestedStepIndex < 0 ||
      requestedStepIndex >= this.steps.length ||
      requestedStepIndex > this.highestUnlockedStepIndex()
    ) {
      return;
    }

    const drills = this.steps[requestedStepIndex]!.drills;

    if (requestedDrillIndex < 0 || requestedDrillIndex >= drills.length) {
      return;
    }

    this.currentStepIndex.set(requestedStepIndex);
    this.currentDrillIndex.set(requestedDrillIndex);
    this.persistProgress();
  }

  private persistProgress(): void {
    if (typeof sessionStorage === 'undefined' || !this.userId) {
      return;
    }

    const progress: StoredTrainingCampProgress = {
      version: CURRENT_TRAINING_CAMP_VERSION,
      stepIndex: this.currentStepIndex(),
      drillIndex: this.currentDrillIndex(),
      unlockedStepIndex: this.highestUnlockedStepIndex(),
    };

    sessionStorage.setItem(this.progressStorageKey(), JSON.stringify(progress));
  }

  private progressStorageKey(): string {
    return `rinkrat-training-camp-progress-v${CURRENT_TRAINING_CAMP_VERSION}:${this.userId}`;
  }

  private trackStepViewed(): void {
    const step = this.currentStep();
    const drill = this.currentDrill();

    this.telemetry.track('training_camp_step_viewed', {
      step: this.currentStepIndex() + 1,
      drill: this.currentDrillIndex() + 1,
      topic: step.id,
      lesson: drill.id,
    });
  }

  private focusHeading(): void {
    if (typeof window === 'undefined') {
      return;
    }

    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('#training-camp-step-title')?.focus();
    });
  }

  private async loadVerificationEmailState(): Promise<void> {
    try {
      const state = await getVerificationEmailState();

      if (state.alreadyVerified) {
        await this.finishVerificationStep();
        return;
      }

      this.applyVerificationEmailState(state);
    } catch {
      // The send action remains available if the optional status lookup is interrupted.
    }
  }

  private applyVerificationEmailState(state: VerificationEmailResponse): void {
    this.verificationEmailEligible.set(state.eligible);
    this.verificationEmailPreviouslySent.set(state.emailPreviouslySent);
    this.verificationNextAllowedAtMillis = state.nextAllowedAtMillis;
    this.updateVerificationCooldown(state.cooldownSecondsRemaining);
  }

  private updateVerificationCooldown(fallbackSeconds = 0): void {
    this.clearVerificationCooldownTimer();

    if (this.verificationNextAllowedAtMillis <= 0 && fallbackSeconds > 0) {
      this.verificationNextAllowedAtMillis = Date.now() + fallbackSeconds * 1_000;
    }

    const update = () => {
      const remaining = getVerificationCooldownSeconds(
        this.verificationNextAllowedAtMillis,
      );

      this.verificationCooldownSeconds.set(remaining);

      if (remaining === 0) {
        this.verificationNextAllowedAtMillis = 0;
        this.clearVerificationCooldownTimer();
      }
    };

    update();

    if (this.verificationCooldownSeconds() > 0) {
      this.verificationCooldownTimer = setInterval(update, 1_000);
    }
  }

  private clearVerificationCooldownTimer(): void {
    if (this.verificationCooldownTimer) {
      clearInterval(this.verificationCooldownTimer);
      this.verificationCooldownTimer = null;
    }
  }
}
