import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { httpsCallable } from 'firebase/functions';

import type {
  BetaFeedbackCategory,
  BetaFeedbackTechnicalContext,
} from '../../../core/beta-operations/beta-operations.models';
import { BetaOperationsService } from '../../../core/beta-operations/beta-operations.service';
import { auth } from '../../../core/firebase-auth';
import { functions } from '../../../core/firebase-functions';
import { CompetitiveActionMonitorService } from '../../../core/observability/competitive-action-monitor.service';
import { TelemetryService } from '../../../core/observability/telemetry.service';

interface SubmitFeedbackRequest {
  category: BetaFeedbackCategory;
  summary: string;
  message: string;
  expectedResult: string;
  reproductionSteps: string;
  route: string;
  leagueId: string;
  allowFollowUp: boolean;
  technicalContext: BetaFeedbackTechnicalContext;
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
  readonly technicalContextExpanded = signal(false);

  category: BetaFeedbackCategory = 'blocked-action';
  summary = '';
  message = '';
  expectedResult = '';
  reproductionSteps = '';
  allowFollowUp = true;

  readonly categoryOptions: Array<{
    value: BetaFeedbackCategory;
    label: string;
    help: string;
  }> = [
    {
      value: 'competition-integrity',
      label: 'Competition or score looks wrong',
      help: 'Incorrect points, roster timing, Draft results, standings, matchup windows, or repeated/missing actions.',
    },
    {
      value: 'blocked-action',
      label: 'An action is blocked or will not finish',
      help: 'Draft, add/drop, waiver, roster, login, or commissioner action cannot be completed.',
    },
    {
      value: 'serious-usability',
      label: 'A screen or rule is hard to use',
      help: 'The feature works, but the wording, flow, mobile layout, or result is difficult to understand.',
    },
    {
      value: 'cosmetic',
      label: 'Minor visual issue',
      help: 'Spacing, color, animation, alignment, or styling that does not prevent the feature from working.',
    },
    {
      value: 'feature-idea',
      label: 'Feature idea',
      help: 'A new capability or improvement that could make RinkRat more useful or fun.',
    },
    {
      value: 'account-privacy',
      label: 'Account or privacy request',
      help: 'Account access, deletion, notification, personal data, or privacy question.',
    },
    {
      value: 'other',
      label: 'Other',
      help: 'Anything that does not fit the choices above.',
    },
  ];

  constructor(
    private readonly router: Router,
    private readonly route: ActivatedRoute,
    private readonly telemetry: TelemetryService,
    private readonly betaOperations: BetaOperationsService,
    private readonly competitiveActions: CompetitiveActionMonitorService,
  ) {}

  summaryCharactersRemaining(): number {
    return 120 - this.summary.length;
  }

  messageCharactersRemaining(): number {
    return 2_000 - this.message.length;
  }

  selectedCategoryHelp(): string {
    return this.categoryOptions.find((option) => option.value === this.category)?.help ?? '';
  }

  currentTechnicalContext(): BetaFeedbackTechnicalContext {
    const recentAction = this.competitiveActions.getSnapshot().recent[0] ?? null;
    return this.betaOperations.buildFeedbackContext(this.feedbackContextRoute(), recentAction);
  }

  toggleTechnicalContext(): void {
    this.technicalContextExpanded.update((expanded) => !expanded);
  }

  async submit(): Promise<void> {
    const normalizedSummary = this.summary.trim();
    const normalizedMessage = this.message.trim();
    const normalizedExpected = this.expectedResult.trim();
    const normalizedSteps = this.reproductionSteps.trim();

    if (this.submitting()) {
      return;
    }

    if (!normalizedSummary) {
      this.errorMessage.set('Add a short title so the report is easy to recognize.');
      return;
    }

    if (normalizedSummary.length > 120) {
      this.errorMessage.set('The report title must be 120 characters or fewer.');
      return;
    }

    if (!normalizedMessage) {
      this.errorMessage.set('Describe what happened or what you would like RinkRat to improve.');
      return;
    }

    if (normalizedMessage.length > 2_000) {
      this.errorMessage.set('The main report must be 2,000 characters or fewer.');
      return;
    }

    if (normalizedExpected.length > 1_000 || normalizedSteps.length > 1_500) {
      this.errorMessage.set(
        'Expected results must be 1,000 characters or fewer and steps must be 1,500 characters or fewer.',
      );
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
        summary: normalizedSummary,
        message: normalizedMessage,
        expectedResult: normalizedExpected,
        reproductionSteps: normalizedSteps,
        route: this.feedbackContextRoute(),
        leagueId,
        allowFollowUp: this.allowFollowUp,
        technicalContext: this.currentTechnicalContext(),
      });

      this.submitted.set(true);
      this.successMessage.set(
        `Report received. Reference ${result.data.feedbackId.slice(0, 8).toUpperCase()}.`,
      );
      this.telemetry.track('feedback_submitted', {
        category: this.category,
        has_league_context: Boolean(leagueId),
      });
      this.summary = '';
      this.message = '';
      this.expectedResult = '';
      this.reproductionSteps = '';
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
