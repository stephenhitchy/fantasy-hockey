import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import {
  AdminErrorGroup,
  AdminFeedbackItem,
  AdminInboxData,
  ErrorAdminStatus,
  FeedbackAdminStatus,
  PlatformAdminService,
} from '../../../core/admin/platform-admin.service';
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
  readonly activeTab = signal<'feedback' | 'errors'>('feedback');
  readonly expandedError = signal('');

  feedbackStatusFilter = 'open';
  feedbackCategoryFilter = 'all';
  feedbackSearch = '';
  errorStatusFilter = 'open';
  errorSearch = '';

  readonly feedbackStatusOptions: Array<{ value: FeedbackAdminStatus; label: string }> = [
    { value: 'new', label: 'New' },
    { value: 'reviewing', label: 'Reviewing' },
    { value: 'planned', label: 'Planned' },
    { value: 'in-progress', label: 'In progress' },
    { value: 'resolved', label: 'Resolved' },
    { value: 'not-planned', label: 'Not planned' },
  ];

  readonly errorStatusOptions: Array<{ value: ErrorAdminStatus; label: string }> = [
    { value: 'new', label: 'New' },
    { value: 'investigating', label: 'Investigating' },
    { value: 'fixed', label: 'Fixed' },
    { value: 'ignored', label: 'Ignored' },
  ];

  readonly feedbackStatusDraft: Record<string, FeedbackAdminStatus> = {};
  readonly feedbackNotesDraft: Record<string, string> = {};
  readonly errorStatusDraft: Record<string, ErrorAdminStatus> = {};
  readonly errorNotesDraft: Record<string, string> = {};

  filteredFeedback(): AdminFeedbackItem[] {
    const search = this.feedbackSearch.trim().toLowerCase();

    return (this.inbox()?.feedback ?? []).filter((item) => {
      const statusMatches =
        this.feedbackStatusFilter === 'all' ||
        (this.feedbackStatusFilter === 'open'
          ? !['resolved', 'not-planned'].includes(item.status)
          : item.status === this.feedbackStatusFilter);
      const categoryMatches =
        this.feedbackCategoryFilter === 'all' || item.category === this.feedbackCategoryFilter;
      const searchMatches =
        !search ||
        item.message.toLowerCase().includes(search) ||
        item.route.toLowerCase().includes(search) ||
        item.feedbackId.toLowerCase().includes(search) ||
        (item.followUpEmail ?? '').toLowerCase().includes(search);

      return statusMatches && categoryMatches && searchMatches;
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

  constructor(
    private readonly platformAdmin: PlatformAdminService,
    private readonly telemetry: TelemetryService,
  ) {
    void this.loadInbox();
  }

  async loadInbox(refresh = false): Promise<void> {
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
      const inbox = await this.platformAdmin.loadInbox();
      this.inbox.set(inbox);
      this.initializeDrafts(inbox);
      this.telemetry.track('admin_inbox_opened', {
        feedback_count: inbox.summary.totalFeedbackCount,
        error_group_count: inbox.summary.totalErrorGroupCount,
      });
    } catch (error: unknown) {
      this.errorMessage.set(this.friendlyError(error, 'Unable to load the Admin Center inbox.'));
    } finally {
      this.loading.set(false);
      this.refreshing.set(false);
    }
  }

  showTab(tab: 'feedback' | 'errors'): void {
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
      const status = this.feedbackStatusDraft[item.feedbackId] ?? item.status;
      const notes = this.feedbackNotesDraft[item.feedbackId] ?? '';
      await this.platformAdmin.updateFeedback(item.feedbackId, status, notes);
      item.status = status;
      item.adminNotes = notes;
      this.inbox.update((current) => (current ? { ...current, feedback: [...current.feedback] } : current));
      this.successMessage.set(`Feedback ${item.feedbackId.slice(0, 8).toUpperCase()} was updated.`);
    } catch (error: unknown) {
      this.errorMessage.set(this.friendlyError(error, 'Unable to update that feedback report.'));
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

  async copyEmail(email: string | null): Promise<void> {
    if (!email) {
      return;
    }

    try {
      await navigator.clipboard.writeText(email);
      this.successMessage.set(`Copied ${email}.`);
    } catch {
      this.errorMessage.set('The email could not be copied automatically. Select it manually.');
    }
  }

  formatDate(value: string | null): string {
    if (!value) {
      return 'Unknown time';
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? 'Unknown time'
      : new Intl.DateTimeFormat('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        }).format(date);
  }

  categoryLabel(category: string): string {
    const labels: Record<string, string> = {
      bug: 'Something is broken',
      confusing: 'Confusing screen or rule',
      'incorrect-result': 'Incorrect fantasy result',
      'feature-request': 'Feature request',
      'account-privacy': 'Account or privacy',
      other: 'Other',
    };

    return labels[category] ?? category;
  }

  statusLabel(status: string): string {
    return status.replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  private initializeDrafts(inbox: AdminInboxData): void {
    for (const item of inbox.feedback) {
      this.feedbackStatusDraft[item.feedbackId] = item.status;
      this.feedbackNotesDraft[item.feedbackId] = item.adminNotes ?? '';
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
      return 'Your login session expired. Sign in again before opening the Admin Center.';
    }

    if (code.includes('failed-precondition') && String(candidate.message ?? '').includes('current password')) {
      return 'Unlock protected administrator actions with your current password, then try again.';
    }

    return typeof candidate.message === 'string' && candidate.message.trim()
      ? candidate.message.replace(/^Firebase:\s*/i, '').trim()
      : fallback;
  }
}
