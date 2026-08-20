import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import type {
  PrivateSeasonResearchDashboardSnapshot,
  PrivateSeasonResearchMilestone,
  PrivateSeasonResearchResponse,
} from '../../../core/operations/private-season-research.models';
import { PrivateSeasonResearchService } from '../../../core/operations/private-season-research.service';
import { AdminSessionStepUp } from '../../../shared/admin-session-step-up/admin-session-step-up';

@Component({
  selector: 'app-private-season-research',
  standalone: true,
  imports: [FormsModule, RouterLink, AdminSessionStepUp],
  templateUrl: './private-season-research.html',
  styleUrl: './private-season-research.css',
})
export class PrivateSeasonResearch {
  readonly loading = signal(true);
  readonly refreshing = signal(false);
  readonly snapshot = signal<PrivateSeasonResearchDashboardSnapshot | null>(null);
  readonly errorMessage = signal('');
  readonly successMessage = signal('');

  leagueFilter = 'all';
  milestoneFilter: 'all' | PrivateSeasonResearchMilestone = 'all';
  followUpFilter: 'all' | 'allowed' | 'not-allowed' = 'all';
  search = '';

  constructor(private readonly researchService: PrivateSeasonResearchService) {
    void this.load();
  }

  async load(refresh = false): Promise<void> {
    if (this.refreshing()) return;
    refresh ? this.refreshing.set(true) : this.loading.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');

    try {
      this.snapshot.set(await this.researchService.loadDashboard());
      if (refresh) this.successMessage.set('Tester research refreshed.');
    } catch (error: unknown) {
      this.errorMessage.set(this.friendlyError(error, 'Unable to load tester research.'));
    } finally {
      this.loading.set(false);
      this.refreshing.set(false);
    }
  }

  filteredResponses(): PrivateSeasonResearchResponse[] {
    const search = this.search.trim().toLowerCase();
    return (this.snapshot()?.responses ?? []).filter((response) => {
      const leagueMatches = this.leagueFilter === 'all' || response.leagueId === this.leagueFilter;
      const milestoneMatches = this.milestoneFilter === 'all' || response.milestone === this.milestoneFilter;
      const followUpMatches = this.followUpFilter === 'all' ||
        (this.followUpFilter === 'allowed' ? response.answers.followUpAllowed : !response.answers.followUpAllowed);
      const searchMatches = !search || [
        response.responseId,
        response.leagueLabel,
        response.role,
        response.milestone,
        response.answers.promptResponse,
        response.answers.biggestFriction,
        response.answers.mostUsefulFeature,
      ].some((value) => value.toLowerCase().includes(search));
      return leagueMatches && milestoneMatches && followUpMatches && searchMatches;
    });
  }

  async copySummary(): Promise<void> {
    const data = this.snapshot();
    if (!data || typeof navigator === 'undefined' || !navigator.clipboard) {
      this.errorMessage.set('Clipboard access is unavailable in this browser.');
      return;
    }
    const summary = data.summary;
    const lines = [
      `RinkRat tester research · ${data.build.releaseLabel}`,
      `Responses: ${summary.responseCount}`,
      `League-manager respondents: ${summary.uniqueRespondentCount}`,
      `Average clarity: ${this.numberLabel(summary.averageClarity, 1, ' / 5')}`,
      `Average trust: ${this.numberLabel(summary.averageTrust, 1, ' / 5')}`,
      `Information about right: ${this.percentLabel(summary.informationAboutRightPercent)}`,
      `Founder-independent: ${this.percentLabel(summary.founderIndependentPercent)}`,
      `Positive next-season intent: ${this.percentLabel(summary.positiveReturnIntentPercent)}`,
      `Generated: ${this.formatDate(data.generatedAt)}`,
    ];

    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      this.successMessage.set('Copied the privacy-limited research summary.');
    } catch {
      this.errorMessage.set('The research summary could not be copied.');
    }
  }

  exportCsv(): void {
    const data = this.snapshot();
    if (!data || typeof document === 'undefined' || typeof URL === 'undefined') return;
    const header = [
      'response_reference',
      'league',
      'milestone',
      'role',
      'clarity_1_5',
      'trust_1_5',
      'information_amount',
      'founder_independence',
      'support_needed',
      'next_season_intent',
      'recommendation_0_10',
      'follow_up_allowed',
      'milestone_response',
      'biggest_friction',
      'most_useful_feature',
      'updated_at',
    ];
    const rows = data.responses.map((response) => [
      response.responseId.slice(0, 12).toUpperCase(),
      response.leagueLabel,
      response.milestone,
      response.role,
      response.answers.clarityRating ?? '',
      response.answers.trustRating ?? '',
      response.answers.informationAmount,
      response.answers.founderIndependence,
      response.answers.supportNeeded,
      response.answers.nextSeasonIntent,
      response.answers.recommendationScore ?? '',
      response.answers.followUpAllowed ? 'yes' : 'no',
      response.answers.promptResponse,
      response.answers.biggestFriction,
      response.answers.mostUsefulFeature,
      response.updatedAt ?? '',
    ]);
    const csv = [header, ...rows]
      .map((row) => row.map((value) => this.csvCell(value)).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = `rinkrat-private-season-research-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(href);
    this.successMessage.set('Downloaded the privacy-limited research CSV.');
  }

  milestoneLabel(milestone: string): string {
    return milestone
      .replace(/^after-/, 'After ')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (character) => character.toUpperCase());
  }

  valueLabel(value: string): string {
    return value.replace(/-/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
  }

  numberLabel(value: number | null, digits = 1, suffix = ''): string {
    return typeof value === 'number' ? `${value.toFixed(digits)}${suffix}` : 'Not enough data';
  }

  percentLabel(value: number | null): string {
    return typeof value === 'number' ? `${value.toFixed(1)}%` : 'Not enough data';
  }

  formatDate(value: string | null): string {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat(undefined, {
        month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
      }).format(date)
      : '—';
  }

  private csvCell(value: unknown): string {
    const text = String(value ?? '');
    const safeText = /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safeText.replace(/"/g, '""')}"`;
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
