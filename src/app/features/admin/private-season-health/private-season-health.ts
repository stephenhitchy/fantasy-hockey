import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import type {
  PrivateSeasonCommissionerIntent,
  PrivateSeasonHealthMetric,
  PrivateSeasonHealthSnapshot,
  PrivateSeasonLeagueHealthEvidence,
  PrivateSeasonWeeklyHealthRecord,
  PrivateSeasonWeeklyLeagueHealth,
} from '../../../core/operations/private-season-health.models';
import { PrivateSeasonHealthService } from '../../../core/operations/private-season-health.service';
import { AdminSessionStepUp } from '../../../shared/admin-session-step-up/admin-session-step-up';

@Component({
  selector: 'app-private-season-health',
  standalone: true,
  imports: [FormsModule, RouterLink, AdminSessionStepUp],
  templateUrl: './private-season-health.html',
  styleUrl: './private-season-health.css',
})
export class PrivateSeasonHealth {
  readonly loading = signal(true);
  readonly refreshing = signal(false);
  readonly saving = signal(false);
  readonly snapshot = signal<PrivateSeasonHealthSnapshot | null>(null);
  readonly errorMessage = signal('');
  readonly successMessage = signal('');

  weeklyDraft: PrivateSeasonWeeklyHealthRecord | null = null;
  weeklyReason = '';

  readonly intentOptions: Array<{
    value: PrivateSeasonCommissionerIntent;
    label: string;
  }> = [
    { value: 'not-asked', label: 'Not asked' },
    { value: 'definitely', label: 'Definitely' },
    { value: 'probably', label: 'Probably' },
    { value: 'unsure', label: 'Unsure' },
    { value: 'probably-not', label: 'Probably not' },
    { value: 'no', label: 'No' },
  ];

  constructor(private readonly healthService: PrivateSeasonHealthService) {
    void this.load();
  }

  async load(refresh = false): Promise<void> {
    if (this.refreshing()) {
      return;
    }

    refresh ? this.refreshing.set(true) : this.loading.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');

    try {
      const snapshot = await this.healthService.load();
      this.applySnapshot(snapshot, this.weeklyDraft?.weekEnding || this.defaultWeekEnding());
      if (refresh) {
        this.successMessage.set('Private-season health evidence refreshed.');
      }
    } catch (error: unknown) {
      this.errorMessage.set(this.friendlyError(error, 'Unable to load private-season health evidence.'));
    } finally {
      this.loading.set(false);
      this.refreshing.set(false);
    }
  }

  selectWeek(weekEnding: string): void {
    const snapshot = this.snapshot();
    if (!snapshot) {
      return;
    }
    this.weeklyDraft = this.recordForWeek(snapshot, weekEnding || this.defaultWeekEnding());
    this.weeklyReason = '';
  }

  async saveWeekly(): Promise<void> {
    const draft = this.weeklyDraft;
    if (!draft || this.saving()) {
      return;
    }

    this.saving.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');

    try {
      const snapshot = await this.healthService.saveWeekly({
        expectedRevision: draft.revision,
        record: draft,
        reason: this.weeklyReason,
      });
      this.applySnapshot(snapshot, draft.weekEnding);
      this.weeklyReason = '';
      this.successMessage.set(`Week ending ${this.formatDateKey(draft.weekEnding)} was saved and audited.`);
    } catch (error: unknown) {
      this.errorMessage.set(this.friendlyError(error, 'Unable to save the weekly operations record.'));
    } finally {
      this.saving.set(false);
    }
  }

  async copySummary(): Promise<void> {
    const snapshot = this.snapshot();
    if (!snapshot || typeof navigator === 'undefined' || !navigator.clipboard) {
      this.errorMessage.set('Clipboard access is unavailable in this browser.');
      return;
    }

    const lines = [
      `RinkRat private-season health · ${snapshot.build.releaseLabel}`,
      snapshot.summary.headline,
      ...snapshot.summary.metrics.map((metric) =>
        `${metric.label}: ${metric.valueLabel} (${this.metricStatusLabel(metric)})`),
      `Tracked leagues: ${snapshot.summary.activeLeagueCount}`,
      `Generated: ${this.formatDate(snapshot.generatedAt)}`,
    ];

    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      this.successMessage.set('Copied the privacy-limited health summary.');
    } catch {
      this.errorMessage.set('The health summary could not be copied.');
    }
  }

  leagueEntry(leagueId: string): PrivateSeasonWeeklyLeagueHealth | null {
    return this.weeklyDraft?.leagues.find((entry) => entry.leagueId === leagueId) ?? null;
  }

  firstWeekActivationComplete(league: PrivateSeasonLeagueHealthEvidence): boolean {
    return Boolean(league.firstMatchupViewedAt && league.firstRosterActionAt);
  }

  leagueActivationLabel(league: PrivateSeasonLeagueHealthEvidence): string {
    if (!league.exists) return 'League not found';
    if (league.teamCount < 6) return `${league.teamCount} managers`;
    if (league.draftStatus !== 'complete') return 'Waiting for Draft';
    if (!league.firstMatchupViewedAt) return 'Waiting for first Game Center view';
    return 'Activated';
  }

  retentionLabel(league: PrivateSeasonLeagueHealthEvidence): string {
    if (!league.activatedAt) return 'Not activated';
    if (!league.fourWeekDue) return 'Not due';
    if (league.retainedAtFourWeeks) {
      return `Retained · ${league.fourWeekActiveManagerCount} active`;
    }
    if (!league.fourWeekWindowClosed) {
      return `Collecting · ${league.fourWeekActiveManagerCount} active`;
    }
    return `Below target · ${league.fourWeekActiveManagerCount} active`;
  }

  metricStatusLabel(metric: PrivateSeasonHealthMetric): string {
    const labels: Record<PrivateSeasonHealthMetric['status'], string> = {
      green: 'Green',
      red: 'Needs action',
      collecting: 'Collecting',
      'not-due': 'Not due',
      informational: 'Informational',
    };
    return labels[metric.status];
  }

  statusLabel(value: string): string {
    return value
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (character) => character.toUpperCase());
  }

  formatDate(value: string | null): string {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(date)
      : '—';
  }

  formatDateKey(value: string): string {
    const date = new Date(`${value}T00:00:00`);
    return Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }).format(date)
      : value;
  }

  private applySnapshot(snapshot: PrivateSeasonHealthSnapshot, preferredWeek: string): void {
    this.snapshot.set(snapshot);
    this.weeklyDraft = this.recordForWeek(snapshot, preferredWeek);
  }

  private recordForWeek(
    snapshot: PrivateSeasonHealthSnapshot,
    weekEnding: string,
  ): PrivateSeasonWeeklyHealthRecord {
    const existing = snapshot.weeklyRecords.find((record) => record.weekEnding === weekEnding);
    if (existing) {
      return structuredClone(existing);
    }

    return {
      schemaVersion: 1,
      weekEnding,
      revision: 0,
      platformCostUsd: 0,
      leagues: snapshot.leagues.map((league) => ({
        slotId: league.slotId,
        leagueId: league.leagueId,
        supportMinutes: 0,
        founderInterventions: 0,
        commissionerIntent: 'not-asked',
        note: '',
      })),
      updatedAt: null,
      updatedBy: '',
    };
  }

  private defaultWeekEnding(): string {
    const date = new Date();
    const daysUntilSunday = (7 - date.getDay()) % 7;
    date.setDate(date.getDate() + daysUntilSunday);
    return date.toISOString().slice(0, 10);
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
