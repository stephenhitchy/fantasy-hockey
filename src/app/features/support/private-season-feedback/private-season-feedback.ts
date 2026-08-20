import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import {
  emptyPrivateSeasonResearchAnswers,
  type PrivateSeasonFounderIndependence,
  type PrivateSeasonInformationAmount,
  type PrivateSeasonResearchAnswers,
  type PrivateSeasonResearchLeagueState,
  type PrivateSeasonResearchManagerSnapshot,
  type PrivateSeasonResearchMilestone,
  type PrivateSeasonResearchMilestoneState,
  type PrivateSeasonReturnIntent,
  type PrivateSeasonSupportNeed,
} from '../../../core/operations/private-season-research.models';
import { PrivateSeasonResearchService } from '../../../core/operations/private-season-research.service';

@Component({
  selector: 'app-private-season-feedback',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './private-season-feedback.html',
  styleUrl: './private-season-feedback.css',
})
export class PrivateSeasonFeedback {
  readonly loading = signal(true);
  readonly refreshing = signal(false);
  readonly saving = signal(false);
  readonly snapshot = signal<PrivateSeasonResearchManagerSnapshot | null>(null);
  readonly errorMessage = signal('');
  readonly successMessage = signal('');
  readonly selectedLeagueId = signal('');
  readonly selectedMilestone = signal<PrivateSeasonResearchMilestone | null>(null);

  draft: PrivateSeasonResearchAnswers = emptyPrivateSeasonResearchAnswers();
  expectedRevision = 0;

  readonly ratingOptions = [1, 2, 3, 4, 5];
  readonly informationOptions: Array<{ value: PrivateSeasonInformationAmount; label: string }> = [
    { value: 'not-answered', label: 'Choose one' },
    { value: 'too-little', label: 'Too little' },
    { value: 'about-right', label: 'About right' },
    { value: 'too-much', label: 'Too much' },
  ];
  readonly independenceOptions: Array<{ value: PrivateSeasonFounderIndependence; label: string }> = [
    { value: 'yes', label: 'Yes' },
    { value: 'mostly', label: 'Mostly' },
    { value: 'no', label: 'No' },
    { value: 'not-applicable', label: 'Not sure yet' },
  ];
  readonly supportOptions: Array<{ value: PrivateSeasonSupportNeed; label: string }> = [
    { value: 'not-answered', label: 'Choose one' },
    { value: 'none', label: 'None' },
    { value: 'once', label: 'One-time help' },
    { value: 'monthly', label: 'About monthly' },
    { value: 'weekly', label: 'About weekly' },
    { value: 'more', label: 'More than weekly' },
  ];
  readonly returnOptions: Array<{ value: PrivateSeasonReturnIntent; label: string }> = [
    { value: 'not-asked', label: 'Not sure yet' },
    { value: 'definitely', label: 'Definitely' },
    { value: 'probably', label: 'Probably' },
    { value: 'unsure', label: 'Unsure' },
    { value: 'probably-not', label: 'Probably not' },
    { value: 'no', label: 'No' },
  ];

  constructor(private readonly researchService: PrivateSeasonResearchService) {
    void this.load();
  }

  async load(refresh = false): Promise<void> {
    if (this.refreshing()) return;
    refresh ? this.refreshing.set(true) : this.loading.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');

    try {
      const snapshot = await this.researchService.loadMine();
      this.snapshot.set(snapshot);
      this.reconcileSelection(snapshot);
      if (refresh) this.successMessage.set('Tester-season milestones refreshed.');
    } catch (error: unknown) {
      this.errorMessage.set(this.friendlyError(error, 'Unable to load tester-season feedback.'));
    } finally {
      this.loading.set(false);
      this.refreshing.set(false);
    }
  }

  selectMilestone(league: PrivateSeasonResearchLeagueState, state: PrivateSeasonResearchMilestoneState): void {
    if (state.availability === 'locked') return;
    this.selectedLeagueId.set(league.leagueId);
    this.selectedMilestone.set(state.milestone);
    this.draft = state.response
      ? structuredClone(state.response.answers)
      : emptyPrivateSeasonResearchAnswers();
    this.expectedRevision = state.response?.revision ?? 0;
    this.errorMessage.set('');
    this.successMessage.set('');
  }

  cancelEdit(): void {
    this.selectedLeagueId.set('');
    this.selectedMilestone.set(null);
    this.draft = emptyPrivateSeasonResearchAnswers();
    this.expectedRevision = 0;
  }

  async save(): Promise<void> {
    const leagueId = this.selectedLeagueId();
    const milestone = this.selectedMilestone();
    if (!leagueId || !milestone || this.saving()) return;

    if (this.draft.promptResponse.trim().length < 10) {
      this.errorMessage.set('Add at least 10 characters to the milestone response.');
      return;
    }
    if (this.containsContactDetails(this.freeText())) {
      this.errorMessage.set('Remove email addresses and phone numbers from the free-text fields.');
      return;
    }

    this.saving.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');

    try {
      const snapshot = await this.researchService.submit({
        leagueId,
        milestone,
        expectedRevision: this.expectedRevision,
        answers: this.draft,
      });
      this.snapshot.set(snapshot);
      this.successMessage.set('Your privacy-limited tester feedback was saved.');
      this.reconcileSelection(snapshot);
    } catch (error: unknown) {
      this.errorMessage.set(this.friendlyError(error, 'Unable to save tester feedback.'));
    } finally {
      this.saving.set(false);
    }
  }

  selectedLeague(): PrivateSeasonResearchLeagueState | null {
    return this.snapshot()?.leagues.find((league) => league.leagueId === this.selectedLeagueId()) ?? null;
  }

  selectedState(): PrivateSeasonResearchMilestoneState | null {
    const milestone = this.selectedMilestone();
    return milestone
      ? this.selectedLeague()?.milestones.find((state) => state.milestone === milestone) ?? null
      : null;
  }

  completedCount(league: PrivateSeasonResearchLeagueState): number {
    return league.milestones.filter((milestone) => milestone.response).length;
  }

  availableCount(league: PrivateSeasonResearchLeagueState): number {
    return league.milestones.filter((milestone) => milestone.availability !== 'locked').length;
  }

  milestoneButtonLabel(state: PrivateSeasonResearchMilestoneState): string {
    if (state.response) return 'Review response';
    if (state.availability === 'available') return 'Start survey';
    return 'Not available';
  }

  showFounderIndependence(): boolean {
    return this.selectedMilestone() !== 'after-join';
  }

  showNextSeasonIntent(): boolean {
    return ['week-4', 'midseason', 'season-end'].includes(this.selectedMilestone() ?? '');
  }

  showRecommendation(): boolean {
    return ['midseason', 'season-end'].includes(this.selectedMilestone() ?? '');
  }

  ratingLabel(value: number | null): string {
    if (value === null) return 'Not answered';
    const labels = ['Very low', 'Low', 'Neutral', 'High', 'Very high'];
    return labels[value - 1] ?? `${value}`;
  }

  formatDate(value: string | null): string {
    if (!value) return 'Not submitted';
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat(undefined, {
        month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
      }).format(date)
      : 'Not submitted';
  }

  private reconcileSelection(snapshot: PrivateSeasonResearchManagerSnapshot): void {
    const league = snapshot.leagues.find((item) => item.leagueId === this.selectedLeagueId());
    const milestone = this.selectedMilestone();
    const state = milestone ? league?.milestones.find((item) => item.milestone === milestone) : null;
    if (!league || !state || state.availability === 'locked') {
      this.cancelEdit();
      return;
    }
    this.draft = state.response
      ? structuredClone(state.response.answers)
      : emptyPrivateSeasonResearchAnswers();
    this.expectedRevision = state.response?.revision ?? 0;
  }

  private freeText(): string {
    return [this.draft.promptResponse, this.draft.biggestFriction, this.draft.mostUsefulFeature].join(' ');
  }

  private containsContactDetails(value: string): boolean {
    return /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?\d[\s().-]*){7,})/i.test(value);
  }

  private friendlyError(error: unknown, fallback: string): string {
    const candidate = error !== null && typeof error === 'object'
      ? error as { message?: unknown }
      : null;
    return typeof candidate?.message === 'string' && candidate.message.trim()
      ? candidate.message.trim().replace(/^Firebase:\s*/i, '')
      : fallback;
  }
}
