import { Component, computed, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { onAuthStateChanged, User } from 'firebase/auth';

import { auth } from '../../../core/firebase-auth';
import { withOperationDeadline } from '../../../core/async/bounded-operation.util';
import {
  completeTrainingCamp,
  CURRENT_TRAINING_CAMP_VERSION,
  hasCompletedTrainingCamp,
} from '../../../core/onboarding/training-camp.service';
import { TelemetryService } from '../../../core/observability/telemetry.service';
import { getUserProfile } from '../../../core/user/user.service';
import { HockeyTermChip } from '../../../shared/hockey-terms/hockey-term-chip';
import { TRAINING_CAMP_FOOTBALL_COMPARISONS } from './training-camp-football-comparison.data';

interface TrainingCampStep {
  id: string;
  number: string;
  eyebrow: string;
  title: string;
  summary: string;
  coachNote: string;
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

@Component({
  selector: 'app-training-camp',
  standalone: true,
  imports: [RouterLink, HockeyTermChip],
  templateUrl: './training-camp.html',
  styleUrl: './training-camp.css',
})
export class TrainingCamp {
  readonly footballPositionComparisons = TRAINING_CAMP_FOOTBALL_COMPARISONS;

  readonly steps: TrainingCampStep[] = [
    {
      id: 'cycles',
      number: '01',
      eyebrow: 'Fair Matchups',
      title: 'Every player gets exactly six NHL games',
      summary:
        'For each player, RinkRat counts the next six NHL games. Games 1 through 6 belong to the first matchup. Game 7 starts that player’s second matchup. Players do not all need to finish on the same day.',
      coachNote:
        'Think of every roster spot as having its own six-game counter. When one counter reaches six, that spot can move forward even if another counter is still catching up.',
    },
    {
      id: 'roster',
      number: '02',
      eyebrow: 'Build Your Club',
      title: 'Build a balanced team',
      summary:
        'Your team has 14 active scoring spots, 3 bench spots, and 3 Injured Reserve (IR) spots. The positions are not meant to score the same way: forwards are explosive, defensemen are steady, and the team goalie unit usually scores the most.',
      coachNote:
        'Do not judge every position by the same point total. Compare forwards with forwards, defensemen with defensemen, and goalie units with other goalie units.',
    },
    {
      id: 'moves',
      number: '03',
      eyebrow: 'Line Changes',
      title: 'Roster moves respect games already played',
      summary:
        'A move can happen immediately when neither affected roster spot has started its current six-game count. Once either side has played, RinkRat schedules the change for the first safe lineup boundary.',
      coachNote:
        'The confirmation screen always tells you whether a move happens now or after the affected roster spot finishes its six games.',
    },
    {
      id: 'cards',
      number: '04',
      eyebrow: 'Scouting Report',
      title: 'Read the information that drives a decision',
      summary:
        'Player cards combine current production, projections, schedule markers, form, reliability, availability, and the exact scoring categories behind the fantasy total.',
      coachNote:
        'Green means played, yellow means an upcoming expected game, and red means a scheduled game was missed.',
    },
    {
      id: 'season',
      number: '05',
      eyebrow: 'Road to the Cup',
      title: 'Matchups become standings, playoffs, and placements',
      summary:
        'Completed matchups update the standings automatically. In the postseason, already-played NHL games are preserved and backfilled once each bracket destination becomes known.',
      coachNote:
        'You never need to press a button to advance scoring. Server automation handles draft clocks, six-game matchups, standings, and playoff routing.',
    },
  ];

  readonly currentStepIndex = signal(0);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly completed = signal(false);
  readonly previouslyCompleted = signal(false);
  readonly errorMessage = signal('');

  readonly currentStep = computed(() => this.steps[this.currentStepIndex()] ?? this.steps[0]!);
  readonly progressPercent = computed(() =>
    Math.round(((this.currentStepIndex() + 1) / this.steps.length) * 100),
  );
  readonly isFirstStep = computed(() => this.currentStepIndex() === 0);
  readonly isLastStep = computed(() => this.currentStepIndex() === this.steps.length - 1);

  private userId = '';

  constructor(
    private readonly router: Router,
    private readonly telemetry: TelemetryService,
  ) {
    void this.initialize();
  }

  selectStep(index: number): void {
    if (index < 0 || index >= this.steps.length || this.saving()) {
      return;
    }

    this.currentStepIndex.set(index);
    this.trackStepViewed();
    this.focusHeading();
  }

  previousStep(): void {
    this.selectStep(this.currentStepIndex() - 1);
  }

  nextStep(): void {
    this.selectStep(this.currentStepIndex() + 1);
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
      }

      this.completed.set(true);
      this.previouslyCompleted.set(true);
      this.telemetry.track('training_camp_completed', {
        version: CURRENT_TRAINING_CAMP_VERSION,
      });
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
    this.telemetry.track('training_camp_exited', {
      completed: this.previouslyCompleted(),
      step: this.currentStepIndex() + 1,
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

    try {
      const profile = await getUserProfile(user.uid);
      const alreadyComplete = hasCompletedTrainingCamp(profile);
      this.previouslyCompleted.set(alreadyComplete);
      this.telemetry.track('training_camp_started', {
        version: CURRENT_TRAINING_CAMP_VERSION,
        replay: alreadyComplete,
      });
      this.trackStepViewed();
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to load Training Camp progress.',
      );
    } finally {
      this.loading.set(false);
    }
  }

  private trackStepViewed(): void {
    const step = this.currentStep();

    this.telemetry.track('training_camp_step_viewed', {
      step: this.currentStepIndex() + 1,
      topic: step.id,
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
