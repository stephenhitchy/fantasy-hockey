import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import {
  AdminErrorGroup,
  AdminFeedbackItem,
  AdminInboxData,
  AppCheckCallableCanaryOption,
  AppCheckCallableCanarySnapshot,
  ErrorAdminStatus,
  PlatformAdminService,
} from '../../../core/admin/platform-admin.service';
import type {
  AppCheckCoverageBucket,
  BetaFeedbackCategory,
  BetaFeedbackStatus,
  BetaKnownIssueStatus,
  BetaOperationsOverview,
  BetaTriageSeverity,
} from '../../../core/beta-operations/beta-operations.models';
import { TelemetryService } from '../../../core/observability/telemetry.service';
import { AdminSessionStepUp } from '../../../shared/admin-session-step-up/admin-session-step-up';

@Component({
  selector: 'app-admin-center',
  standalone: true,
  imports: [FormsModule, RouterLink, AdminSessionStepUp],
  templateUrl: './admin-center.html',
  styleUrl: './admin-center.css',
})
export class AdminCenter {
  readonly loading = signal(true);
  readonly refreshing = signal(false);
  readonly savingId = signal('');
  readonly errorMessage = signal('');
  readonly successMessage = signal('');
  readonly inbox = signal<AdminInboxData | null>(null);
  readonly operations = signal<BetaOperationsOverview | null>(null);
  readonly appCheckCanary = signal<AppCheckCallableCanarySnapshot | null>(null);
  readonly savingAppCheckCanary = signal(false);
  readonly activeTab = signal<'feedback' | 'errors' | 'evidence'>('feedback');
  readonly expandedError = signal('');
  readonly expandedFeedback = signal('');

  feedbackStatusFilter = 'open';
  feedbackSeverityFilter = 'all';
  feedbackCategoryFilter = 'all';
  feedbackSearch = '';
  errorStatusFilter = 'open';
  errorSearch = '';
  evidenceWindowDays = 14;
  appCheckCanaryReason = '';

  readonly feedbackStatusOptions: Array<{ value: BetaFeedbackStatus; label: string }> = [
    { value: 'new', label: 'New' },
    { value: 'investigating', label: 'Investigating' },
    { value: 'confirmed', label: 'Confirmed' },
    { value: 'fix-next-release', label: 'Fix in next release' },
    { value: 'resolved', label: 'Resolved' },
    { value: 'not-reproducible', label: 'Not reproducible' },
    { value: 'deferred', label: 'Deferred' },
  ];

  readonly severityOptions: Array<{ value: BetaTriageSeverity; label: string }> = [
    { value: 'integrity', label: 'Competition integrity' },
    { value: 'blocker', label: 'Blocked action' },
    { value: 'serious', label: 'Serious usability' },
    { value: 'cosmetic', label: 'Cosmetic' },
    { value: 'idea', label: 'Idea' },
  ];

  readonly categoryOptions: Array<{ value: BetaFeedbackCategory; label: string }> = [
    { value: 'competition-integrity', label: 'Competition integrity' },
    { value: 'blocked-action', label: 'Blocked action' },
    { value: 'serious-usability', label: 'Serious usability' },
    { value: 'cosmetic', label: 'Cosmetic' },
    { value: 'feature-idea', label: 'Feature idea' },
    { value: 'account-privacy', label: 'Account or privacy' },
    { value: 'other', label: 'Other' },
  ];

  readonly knownIssueStatusOptions: Array<{ value: BetaKnownIssueStatus; label: string }> = [
    { value: 'investigating', label: 'Under investigation' },
    { value: 'fix-prepared', label: 'Fix prepared' },
    { value: 'monitoring', label: 'Monitoring after fix' },
    { value: 'resolved', label: 'Resolved' },
  ];

  readonly errorStatusOptions: Array<{ value: ErrorAdminStatus; label: string }> = [
    { value: 'new', label: 'New' },
    { value: 'investigating', label: 'Investigating' },
    { value: 'fixed', label: 'Fixed' },
    { value: 'ignored', label: 'Ignored' },
  ];

  readonly feedbackStatusDraft: Record<string, BetaFeedbackStatus> = {};
  readonly feedbackSeverityDraft: Record<string, BetaTriageSeverity> = {};
  readonly feedbackOwnerDraft: Record<string, string> = {};
  readonly feedbackDuplicateDraft: Record<string, string> = {};
  readonly feedbackResolutionDraft: Record<string, string> = {};
  readonly feedbackNotesDraft: Record<string, string> = {};
  readonly feedbackPublishDraft: Record<string, boolean> = {};
  readonly feedbackKnownIssueStatusDraft: Record<string, BetaKnownIssueStatus> = {};
  readonly feedbackPublicTitleDraft: Record<string, string> = {};
  readonly feedbackPublicSummaryDraft: Record<string, string> = {};
  readonly errorStatusDraft: Record<string, ErrorAdminStatus> = {};
  readonly errorNotesDraft: Record<string, string> = {};
  readonly appCheckCanaryCallableDraft: Record<string, boolean> = {};
  readonly appCheckCanaryLeagueDraft: Record<string, boolean> = {};

  constructor(
    private readonly platformAdmin: PlatformAdminService,
    private readonly telemetry: TelemetryService,
  ) {
    void this.loadDashboard();
  }

  filteredFeedback(): AdminFeedbackItem[] {
    const search = this.feedbackSearch.trim().toLowerCase();

    return (this.inbox()?.feedback ?? []).filter((item) => {
      const statusMatches =
        this.feedbackStatusFilter === 'all' ||
        (this.feedbackStatusFilter === 'open'
          ? !['resolved', 'not-reproducible', 'deferred'].includes(item.status)
          : item.status === this.feedbackStatusFilter);
      const severityMatches =
        this.feedbackSeverityFilter === 'all' || item.severity === this.feedbackSeverityFilter;
      const categoryMatches =
        this.feedbackCategoryFilter === 'all' || item.category === this.feedbackCategoryFilter;
      const searchMatches =
        !search ||
        item.summary.toLowerCase().includes(search) ||
        item.message.toLowerCase().includes(search) ||
        item.route.toLowerCase().includes(search) ||
        item.feedbackId.toLowerCase().includes(search) ||
        item.reportedRelease.toLowerCase().includes(search) ||
        (item.followUpEmail ?? '').toLowerCase().includes(search);

      return statusMatches && severityMatches && categoryMatches && searchMatches;
    });
  }

  filteredErrors(): AdminErrorGroup[] {
    const search = this.errorSearch.trim().toLowerCase();

    return (this.inbox()?.errorGroups ?? []).filter((item) => {
      const statusMatches =
        this.errorStatusFilter === 'all' ||
        (this.errorStatusFilter === 'open'
          ? !['fixed', 'ignored'].includes(item.status)
          : item.status === this.errorStatusFilter);
      const searchMatches =
        !search ||
        item.message.toLowerCase().includes(search) ||
        item.route.toLowerCase().includes(search) ||
        item.category.toLowerCase().includes(search) ||
        item.fingerprint.toLowerCase().includes(search);

      return statusMatches && searchMatches;
    });
  }

  async loadDashboard(refresh = false): Promise<void> {
    if (this.refreshing()) {
      return;
    }

    if (refresh) {
      this.refreshing.set(true);
    } else {
      this.loading.set(true);
    }

    this.errorMessage.set('');
    this.successMessage.set('');

    try {
      const [inbox, operations, appCheckCanary] = await Promise.all([
        this.platformAdmin.loadInbox(),
        this.platformAdmin.loadBetaOperations(this.evidenceWindowDays),
        this.platformAdmin.loadAppCheckCanaryControl(),
      ]);
      this.inbox.set(inbox);
      this.operations.set(operations);
      this.appCheckCanary.set(appCheckCanary);
      this.initializeDrafts(inbox);
      this.initializeAppCheckCanaryDrafts(appCheckCanary);
      this.telemetry.track('admin_beta_operations_opened', {
        feedback_count: inbox.summary.totalFeedbackCount,
        error_group_count: inbox.summary.totalErrorGroupCount,
        action_sample_count: operations.actionSampleCount,
        route_sample_count: operations.routeSampleCount,
      });
    } catch (error: unknown) {
      this.errorMessage.set(this.friendlyError(error, 'Unable to load the Beta Operations Center.'));
    } finally {
      this.loading.set(false);
      this.refreshing.set(false);
    }
  }

  async refreshEvidenceWindow(): Promise<void> {
    this.errorMessage.set('');
    this.successMessage.set('');

    try {
      this.refreshing.set(true);
      const [operations, appCheckCanary] = await Promise.all([
        this.platformAdmin.loadBetaOperations(this.evidenceWindowDays),
        this.platformAdmin.loadAppCheckCanaryControl(),
      ]);
      this.operations.set(operations);
      this.appCheckCanary.set(appCheckCanary);
      this.initializeAppCheckCanaryDrafts(appCheckCanary);
      this.successMessage.set(`Live evidence refreshed for the last ${this.evidenceWindowDays} days.`);
    } catch (error: unknown) {
      this.errorMessage.set(this.friendlyError(error, 'Unable to refresh live-season evidence.'));
    } finally {
      this.refreshing.set(false);
    }
  }

  showTab(tab: 'feedback' | 'errors' | 'evidence'): void {
    this.activeTab.set(tab);
    this.successMessage.set('');
  }

  async saveFeedback(item: AdminFeedbackItem): Promise<void> {
    if (this.savingId()) {
      return;
    }

    this.savingId.set(item.feedbackId);
    this.errorMessage.set('');
    this.successMessage.set('');

    try {
      const update = {
        feedbackId: item.feedbackId,
        status: this.feedbackStatusDraft[item.feedbackId] ?? item.status,
        severity: this.feedbackSeverityDraft[item.feedbackId] ?? item.severity,
        owner: (this.feedbackOwnerDraft[item.feedbackId] ?? '').trim(),
        duplicateOf: (this.feedbackDuplicateDraft[item.feedbackId] ?? '').trim(),
        resolutionRelease: (this.feedbackResolutionDraft[item.feedbackId] ?? '').trim(),
        adminNotes: this.feedbackNotesDraft[item.feedbackId] ?? '',
        publishKnownIssue: this.feedbackPublishDraft[item.feedbackId] === true,
        knownIssueStatus:
          this.feedbackKnownIssueStatusDraft[item.feedbackId] ?? 'investigating',
        publicTitle: this.feedbackPublicTitleDraft[item.feedbackId] ?? '',
        publicSummary: this.feedbackPublicSummaryDraft[item.feedbackId] ?? '',
      } as const;

      await this.platformAdmin.updateBetaFeedbackTriage(update);
      item.status = update.status;
      item.severity = update.severity;
      item.owner = update.owner;
      item.duplicateOf = update.duplicateOf;
      item.resolutionRelease = update.resolutionRelease;
      item.adminNotes = update.adminNotes;
      item.knownIssueId = update.publishKnownIssue ? item.feedbackId : '';
      item.knownIssueStatus = update.publishKnownIssue ? update.knownIssueStatus : '';
      item.publicTitle = update.publishKnownIssue ? update.publicTitle : '';
      item.publicSummary = update.publishKnownIssue ? update.publicSummary : '';
      this.inbox.update((current) =>
        current ? { ...current, feedback: [...current.feedback] } : current,
      );
      this.successMessage.set(`Report ${item.feedbackId.slice(0, 8).toUpperCase()} was updated.`);
      this.operations.set(await this.platformAdmin.loadBetaOperations(this.evidenceWindowDays));
    } catch (error: unknown) {
      this.errorMessage.set(this.friendlyError(error, 'Unable to update that beta report.'));
    } finally {
      this.savingId.set('');
    }
  }

  async saveErrorReview(item: AdminErrorGroup): Promise<void> {
    if (this.savingId()) {
      return;
    }

    this.savingId.set(item.fingerprint);
    this.errorMessage.set('');
    this.successMessage.set('');

    try {
      const status = this.errorStatusDraft[item.fingerprint] ?? item.status;
      const notes = this.errorNotesDraft[item.fingerprint] ?? '';
      await this.platformAdmin.updateErrorReview(item.fingerprint, status, notes);
      item.status = status;
      item.adminNotes = notes;
      this.inbox.update((current) =>
        current ? { ...current, errorGroups: [...current.errorGroups] } : current,
      );
      this.successMessage.set(`Error group ${item.fingerprint.slice(0, 8).toUpperCase()} was updated.`);
    } catch (error: unknown) {
      this.errorMessage.set(this.friendlyError(error, 'Unable to update that error group.'));
    } finally {
      this.savingId.set('');
    }
  }

  toggleErrorDetails(fingerprint: string): void {
    this.expandedError.update((current) => (current === fingerprint ? '' : fingerprint));
  }

  toggleFeedbackDetails(feedbackId: string): void {
    this.expandedFeedback.update((current) => (current === feedbackId ? '' : feedbackId));
  }

  async copyEmail(email: string | null): Promise<void> {
    if (!email) return;

    try {
      await navigator.clipboard.writeText(email);
      this.successMessage.set(`Copied ${email}.`);
    } catch {
      this.errorMessage.set('The email could not be copied automatically. Select it manually.');
    }
  }

  formatDate(value: string | null): string {
    if (!value) return 'Not recorded';

    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? 'Not recorded'
      : new Intl.DateTimeFormat('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        }).format(date);
  }

  formatDuration(milliseconds: number): string {
    const value = Math.max(0, Math.round(milliseconds));
    if (value < 1_000) return `${value} ms`;
    if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
    return `${(value / 60_000).toFixed(1)} min`;
  }

  categoryLabel(category: string): string {
    const labels: Record<string, string> = {
      'competition-integrity': 'Competition integrity',
      'blocked-action': 'Blocked action',
      'serious-usability': 'Serious usability',
      cosmetic: 'Cosmetic',
      'feature-idea': 'Feature idea',
      'account-privacy': 'Account or privacy',
      other: 'Other',
    };
    return labels[category] ?? this.statusLabel(category);
  }

  statusLabel(status: string): string {
    return status.replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  evidenceCoveragePercent(): number {
    const data = this.operations();
    if (!data) return 0;
    const total = data.appCheckValidCount + data.appCheckMissingCount;
    return total > 0 ? Math.round((data.appCheckValidCount / total) * 100) : 0;
  }


  appCheckGateTone(): 'success' | 'warning' | 'danger' {
    const status = this.operations()?.appCheckReadiness.status;
    if (status === 'ready') return 'success';
    if (status === 'needs-attention') return 'danger';
    return 'warning';
  }

  appCheckCoverageState(item: AppCheckCoverageBucket): string {
    if (!item.required) return `${item.total} observed`;
    if (!item.sampleGatePassed) return `${item.total}/${item.minimumSamples} samples`;
    return item.verificationGatePassed
      ? `${item.validPercent}% verified`
      : `${item.validPercent}% · needs attention`;
  }


  selectedAppCheckCanaryCallables(): AppCheckCallableCanaryOption['name'][] {
    const snapshot = this.appCheckCanary();
    if (!snapshot) return [];
    return snapshot.callableOptions
      .filter((option) => this.appCheckCanaryCallableDraft[option.name] === true)
      .map((option) => option.name);
  }

  selectedAppCheckCanaryLeagueIds(): string[] {
    return (this.appCheckCanary()?.leagues ?? [])
      .filter((league) => this.appCheckCanaryLeagueDraft[league.leagueId] === true)
      .map((league) => league.leagueId);
  }

  canSelectAppCheckCanaryLeague(leagueId: string): boolean {
    const snapshot = this.appCheckCanary();
    const league = snapshot?.leagues.find((candidate) => candidate.leagueId === leagueId);
    if (!snapshot || !league?.isInternalTest) return false;
    if (this.appCheckCanaryLeagueDraft[leagueId]) return true;
    return this.selectedAppCheckCanaryLeagueIds().length < snapshot.maximumCanaryLeagues;
  }

  canStartAppCheckCanary(): boolean {
    const snapshot = this.appCheckCanary();
    const readiness = this.operations()?.appCheckReadiness;
    if (!snapshot || !readiness?.canaryEligible || this.savingAppCheckCanary()) {
      return false;
    }
    return (
      this.selectedAppCheckCanaryCallables().length > 0 &&
      this.selectedAppCheckCanaryLeagueIds().length > 0 &&
      this.appCheckCanaryReason.trim().length >= snapshot.minimumReasonLength
    );
  }

  canReturnAppCheckCanaryToMonitor(): boolean {
    const snapshot = this.appCheckCanary();
    return Boolean(
      snapshot?.control.mode === 'canary' &&
      !this.savingAppCheckCanary() &&
      this.appCheckCanaryReason.trim().length >= snapshot.minimumReasonLength,
    );
  }

  appCheckCanaryTone(): 'success' | 'warning' | 'danger' {
    const snapshot = this.appCheckCanary();
    if (!snapshot || snapshot.control.mode === 'monitor') return 'success';
    return snapshot.health.blockedCount > 0 ? 'danger' : 'warning';
  }

  appCheckCanaryHealth(optionName: string) {
    return this.appCheckCanary()?.health.byCallable[optionName] ?? {
      allowedCount: 0,
      blockedCount: 0,
      lastStatus: '',
      lastEventAt: null,
    };
  }

  async startAppCheckCanary(): Promise<void> {
    if (!this.canStartAppCheckCanary()) return;
    await this.saveAppCheckCanaryControl('canary');
  }

  async returnAppCheckCanaryToMonitor(): Promise<void> {
    if (!this.canReturnAppCheckCanaryToMonitor()) return;
    await this.saveAppCheckCanaryControl('monitor');
  }

  private async saveAppCheckCanaryControl(
    mode: 'monitor' | 'canary',
  ): Promise<void> {
    this.savingAppCheckCanary.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');

    try {
      const snapshot = await this.platformAdmin.updateAppCheckCanaryControl({
        mode,
        selectedCallables: this.selectedAppCheckCanaryCallables(),
        canaryLeagueIds: this.selectedAppCheckCanaryLeagueIds(),
        reason: this.appCheckCanaryReason.trim(),
      });
      this.appCheckCanary.set(snapshot);
      this.initializeAppCheckCanaryDrafts(snapshot);
      this.appCheckCanaryReason = '';
      this.successMessage.set(
        mode === 'canary'
          ? 'The exact-league App Check canary is active for only the selected callables and leagues.'
          : 'App Check callable enforcement returned to monitor mode. No selected league is being rejected.',
      );
    } catch (error: unknown) {
      this.errorMessage.set(this.friendlyError(
        error,
        mode === 'canary'
          ? 'Unable to start the selected App Check canary.'
          : 'Unable to return App Check to monitor mode.',
      ));
    } finally {
      this.savingAppCheckCanary.set(false);
    }
  }

  private initializeAppCheckCanaryDrafts(
    snapshot: AppCheckCallableCanarySnapshot,
  ): void {
    for (const option of snapshot.callableOptions) {
      this.appCheckCanaryCallableDraft[option.name] =
        snapshot.control.selectedCallables.includes(option.name);
    }
    for (const league of snapshot.leagues) {
      this.appCheckCanaryLeagueDraft[league.leagueId] =
        snapshot.control.canaryLeagueIds.includes(league.leagueId);
    }
  }

  private initializeDrafts(inbox: AdminInboxData): void {
    for (const item of inbox.feedback) {
      this.feedbackStatusDraft[item.feedbackId] = item.status;
      this.feedbackSeverityDraft[item.feedbackId] = item.severity;
      this.feedbackOwnerDraft[item.feedbackId] = item.owner ?? '';
      this.feedbackDuplicateDraft[item.feedbackId] = item.duplicateOf ?? '';
      this.feedbackResolutionDraft[item.feedbackId] = item.resolutionRelease ?? '';
      this.feedbackNotesDraft[item.feedbackId] = item.adminNotes ?? '';
      this.feedbackPublishDraft[item.feedbackId] = Boolean(item.knownIssueId);
      this.feedbackKnownIssueStatusDraft[item.feedbackId] =
        item.knownIssueStatus || 'investigating';
      this.feedbackPublicTitleDraft[item.feedbackId] = item.publicTitle || item.summary;
      this.feedbackPublicSummaryDraft[item.feedbackId] = item.publicSummary || item.message;
    }

    for (const item of inbox.errorGroups) {
      this.errorStatusDraft[item.fingerprint] = item.status;
      this.errorNotesDraft[item.fingerprint] = item.adminNotes ?? '';
    }
  }

  private friendlyError(error: unknown, fallback: string): string {
    const candidate = error as { code?: unknown; message?: unknown };
    const code = typeof candidate.code === 'string' ? candidate.code : '';

    if (code.includes('permission-denied')) {
      return 'This account is not configured as a RinkRat platform administrator.';
    }

    if (code.includes('unauthenticated')) {
      return 'Your login session expired. Sign in again before opening Beta Operations.';
    }

    if (
      code.includes('failed-precondition') &&
      String(candidate.message ?? '').includes('current password')
    ) {
      return 'Unlock protected administrator actions with your current password, then try again.';
    }

    return typeof candidate.message === 'string' && candidate.message.trim()
      ? candidate.message.replace(/^Firebase:\s*/i, '').trim()
      : fallback;
  }
}
