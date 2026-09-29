import { Component, computed, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { onAuthStateChanged, User } from 'firebase/auth';

import { withOperationDeadline } from '../../../core/async/bounded-operation.util';
import { auth } from '../../../core/firebase-auth';
import {
  buildLeagueInvitePath,
  pendingLeagueInviteAccountMatch,
  readPendingLeagueInvite,
} from '../../../core/league/invite-link-intent.service';
import { TelemetryService } from '../../../core/observability/telemetry.service';
import {
  completeTrainingCamp,
  CURRENT_TRAINING_CAMP_VERSION,
  deferTrainingCamp,
  hasCompletedTrainingCamp,
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
export class TrainingCamp {
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

  readonly exitActionLabel = computed(() => {
    if (this.saving()) {
      return 'Saving...';
    }

    if (this.previouslyCompleted()) {
      return 'Exit Training Camp';
    }

    return 'Finish Later';
  });
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

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly telemetry: TelemetryService,
  ) {
    void this.initialize();
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
      this.telemetry.track('training_camp_completed', {
        version: CURRENT_TRAINING_CAMP_VERSION,
        invite_continuation: false,
      });

      this.completed.set(true);
      this.focusHeading();
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

    try {
      await withOperationDeadline(
        deferTrainingCamp(this.userId),
        25_000,
        'RinkRat stopped waiting while saving Training Camp for later. The button has been released; reload before trying again because the choice may still have saved.',
      );

      this.telemetry.track('training_camp_deferred', {
        version: CURRENT_TRAINING_CAMP_VERSION,
        step: this.currentStepIndex() + 1,
        drill: this.currentDrillIndex() + 1,
        invite_continuation: false,
      });

      await this.router.navigate(['/dashboard']);
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

  private async leaveCompletedTrainingCamp(): Promise<void> {
    this.telemetry.track('training_camp_exited', {
      completed: true,
      step: this.currentStepIndex() + 1,
      drill: this.currentDrillIndex() + 1,
      invite_continuation: false,
    });

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

    if (continuationRequested && pendingInvite && inviteMatchesAccount) {
      const invitePath = buildLeagueInvitePath(pendingInvite.inviteCode);

      if (invitePath) {
        await this.router.navigateByUrl(invitePath, { replaceUrl: true });
        return;
      }
    }

    try {
      const profile = await getUserProfile(user.uid);
      const alreadyComplete = hasCompletedTrainingCamp(profile);
      this.previouslyCompleted.set(alreadyComplete);
      this.telemetry.track('training_camp_started', {
        version: CURRENT_TRAINING_CAMP_VERSION,
        replay: alreadyComplete,
        invite_continuation: false,
      });

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

}
