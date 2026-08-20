import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import {
  PRIVACY_REQUEST_STATUS_OPTIONS,
  PRIVACY_REQUEST_TYPE_OPTIONS,
  isPrivacyRequestClosed,
  privacyRequestStatusLabel,
  privacyRequestTypeLabel,
  type PrivacyOperationsDashboard,
  type PrivacyRequestAdminRecord,
  type PrivacyRequestStatus,
} from '../../../core/privacy/privacy-operations.models';
import { PrivacyOperationsService } from '../../../core/privacy/privacy-operations.service';
import { AdminSessionStepUp } from '../../../shared/admin-session-step-up/admin-session-step-up';

@Component({
  selector: 'app-privacy-requests',
  standalone: true,
  imports: [FormsModule, RouterLink, AdminSessionStepUp],
  templateUrl: './privacy-requests.html',
  styleUrl: './privacy-requests.css',
})
export class PrivacyRequests {
  readonly loading = signal(true);
  readonly refreshing = signal(false);
  readonly savingRequestId = signal('');
  readonly snapshot = signal<PrivacyOperationsDashboard | null>(null);
  readonly errorMessage = signal('');
  readonly successMessage = signal('');
  readonly expandedRequestId = signal('');

  readonly statusOptions = PRIVACY_REQUEST_STATUS_OPTIONS;
  readonly typeOptions = PRIVACY_REQUEST_TYPE_OPTIONS;

  statusFilter = 'open';
  typeFilter = 'all';
  search = '';
  readonly statusDraft: Record<string, PrivacyRequestStatus> = {};
  readonly publicResponseDraft: Record<string, string> = {};
  readonly adminNotesDraft: Record<string, string> = {};
  readonly auditReasonDraft: Record<string, string> = {};

  constructor(private readonly privacyOperations: PrivacyOperationsService) {
    void this.load();
  }

  async load(refresh = false): Promise<void> {
    if (this.refreshing()) return;
    refresh ? this.refreshing.set(true) : this.loading.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');

    try {
      const snapshot = await this.privacyOperations.loadOperations();
      this.snapshot.set(snapshot);
      this.initializeDrafts(snapshot.requests);
      if (refresh) this.successMessage.set('Privacy operations refreshed.');
    } catch (error: unknown) {
      this.errorMessage.set(this.friendlyError(error, 'Unable to load privacy-request operations.'));
    } finally {
      this.loading.set(false);
      this.refreshing.set(false);
    }
  }

  filteredRequests(): PrivacyRequestAdminRecord[] {
    const search = this.search.trim().toLowerCase();
    return (this.snapshot()?.requests ?? []).filter((request) => {
      const statusMatches = this.statusFilter === 'all'
        || (this.statusFilter === 'open'
          ? !isPrivacyRequestClosed(request.status)
          : request.status === this.statusFilter);
      const typeMatches = this.typeFilter === 'all' || request.requestType === this.typeFilter;
      const searchMatches = !search
        || request.subject.toLowerCase().includes(search)
        || request.details.toLowerCase().includes(search)
        || request.ownerReference.toLowerCase().includes(search)
        || request.requestId.toLowerCase().includes(search)
        || request.publicResponse.toLowerCase().includes(search);
      return statusMatches && typeMatches && searchMatches;
    });
  }

  toggleRequest(requestId: string): void {
    this.expandedRequestId.set(this.expandedRequestId() === requestId ? '' : requestId);
  }

  async save(request: PrivacyRequestAdminRecord): Promise<void> {
    if (this.savingRequestId()) return;
    const auditReason = (this.auditReasonDraft[request.requestId] ?? '').trim();
    if (auditReason.length < 12) {
      this.errorMessage.set('Enter an audit reason of at least 12 characters before saving.');
      return;
    }

    this.savingRequestId.set(request.requestId);
    this.errorMessage.set('');
    this.successMessage.set('');
    try {
      const updated = await this.privacyOperations.updateOperation({
        requestId: request.requestId,
        expectedRevision: request.revision,
        status: this.statusDraft[request.requestId] ?? request.status,
        publicResponse: this.publicResponseDraft[request.requestId] ?? '',
        adminNotes: this.adminNotesDraft[request.requestId] ?? '',
        auditReason,
      });
      this.snapshot.update((current) => current
        ? {
          ...current,
          requests: current.requests.map((entry) => entry.requestId === updated.requestId ? updated : entry),
        }
        : current);
      this.initializeDrafts([updated]);
      this.auditReasonDraft[request.requestId] = '';
      this.successMessage.set(`Privacy request ${request.requestId.slice(0, 8).toUpperCase()} was updated.`);
    } catch (error: unknown) {
      this.errorMessage.set(this.friendlyError(error, 'Unable to update the privacy request.'));
    } finally {
      this.savingRequestId.set('');
    }
  }

  typeLabel(request: PrivacyRequestAdminRecord): string {
    return privacyRequestTypeLabel(request.requestType);
  }

  statusLabel(value: PrivacyRequestStatus): string {
    return privacyRequestStatusLabel(value);
  }

  formatDate(value: string | null): string {
    if (!value) return 'Not recorded';
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat(undefined, {
        month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
      }).format(date)
      : 'Not recorded';
  }

  formatBytes(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return '0 B';
    if (value < 1_024) return `${Math.round(value)} B`;
    if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`;
    return `${(value / (1_024 * 1_024)).toFixed(2)} MB`;
  }

  private initializeDrafts(requests: readonly PrivacyRequestAdminRecord[]): void {
    for (const request of requests) {
      this.statusDraft[request.requestId] = request.status;
      this.publicResponseDraft[request.requestId] = request.publicResponse;
      this.adminNotesDraft[request.requestId] = request.adminNotes;
      this.auditReasonDraft[request.requestId] ??= '';
    }
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
