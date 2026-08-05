import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { httpsCallable } from 'firebase/functions';

import { auth } from '../../../core/firebase-auth';
import { functions } from '../../../core/firebase-functions';
import { TelemetryService } from '../../../core/observability/telemetry.service';

export type FeedbackCategory =
  | 'bug'
  | 'confusing'
  | 'incorrect-result'
  | 'feature-request'
  | 'account-privacy'
  | 'other';

interface SubmitFeedbackRequest {
  category: FeedbackCategory;
  message: string;
  route: string;
  leagueId: string;
  allowFollowUp: boolean;
}

interface SubmitFeedbackResponse {
  accepted: boolean;
  feedbackId: string;
}

@Component({
  selector: 'app-feedback',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './feedback.html',
  styleUrl: './feedback.css',
})
export class FeedbackPage {
  readonly submitting = signal(false);
  readonly submitted = signal(false);
  readonly successMessage = signal('');
  readonly errorMessage = signal('');

  category: FeedbackCategory = 'bug';
  message = '';
  allowFollowUp = true;

  charactersRemaining(): number {
    return 2_000 - this.message.length;
  }

  constructor(
    private readonly router: Router,
    private readonly route: ActivatedRoute,
    private readonly telemetry: TelemetryService,
  ) {}

  async submit(): Promise<void> {
    const normalizedMessage = this.message.trim();

    if (this.submitting()) {
      return;
    }

    if (!normalizedMessage) {
      this.errorMessage.set('Describe what happened or what you would like RinkRat to improve.');
      return;
    }

    if (normalizedMessage.length > 2_000) {
      this.errorMessage.set('Feedback must be 2,000 characters or fewer.');
      return;
    }

    if (!auth.currentUser) {
      this.errorMessage.set('Sign in before submitting feedback.');
      return;
    }

    this.submitting.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');

    try {
      const callable = httpsCallable<SubmitFeedbackRequest, SubmitFeedbackResponse>(
        functions,
        'submitFeedback',
        { timeout: 35_000 },
      );
      const leagueId = this.currentLeagueId();
      const result = await callable({
        category: this.category,
        message: normalizedMessage,
        route: this.feedbackContextRoute(),
        leagueId,
        allowFollowUp: this.allowFollowUp,
      });

      this.submitted.set(true);
      this.successMessage.set(
        `Feedback received. Reference ${result.data.feedbackId.slice(0, 8).toUpperCase()}.`,
      );
      this.telemetry.track('feedback_submitted', {
        category: this.category,
        has_league_context: Boolean(leagueId),
      });
      this.message = '';
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'RinkRat could not submit feedback right now.',
      );
    } finally {
      this.submitting.set(false);
    }
  }

  returnToPreviousPage(): void {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      window.history.back();
      return;
    }

    void this.router.navigate(['/dashboard']);
  }

  private feedbackContextRoute(): string {
    const from = this.route.snapshot.queryParamMap.get('from')?.trim() ?? '';

    if (!from.startsWith('/') || from.startsWith('//')) {
      return this.telemetry.sanitizedCurrentRoute();
    }

    return this.telemetry.sanitizedRoute(from);
  }

  private currentLeagueId(): string {
    const leagueId = this.route.snapshot.queryParamMap.get('leagueId')?.trim() ?? '';
    return /^[A-Za-z0-9_-]{1,128}$/.test(leagueId) ? leagueId : '';
  }
}
