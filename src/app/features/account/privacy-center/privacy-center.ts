import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import {
  PRIVACY_REQUEST_TYPE_OPTIONS,
  isPrivacyRequestClosed,
  privacyRequestStatusLabel,
  privacyRequestTypeLabel,
  type PrivacyCenterSnapshot,
  type PrivacyExportAudit,
  type PrivacyRequestRecord,
  type PrivacyRequestType,
} from '../../../core/privacy/privacy-operations.models';
import { PrivacyOperationsService } from '../../../core/privacy/privacy-operations.service';
import {
  RecentAuthService,
  getFriendlyReauthenticationError,
} from '../../../core/auth/recent-auth.service';

@Component({
  selector: 'app-privacy-center',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './privacy-center.html',
  styleUrl: './privacy-center.css',
})
export class PrivacyCenter {
  readonly loading = signal(true);
  readonly refreshing = signal(false);
  readonly exporting = signal(false);
  readonly savingRequest = signal(false);
  readonly savingRequestId = signal('');
  readonly verifying = signal(false);
  readonly snapshot = signal<PrivacyCenterSnapshot | null>(null);
  readonly errorMessage = signal('');
  readonly successMessage = signal('');
  readonly selectedFollowUpId = signal('');

  readonly requestTypeOptions = PRIVACY_REQUEST_TYPE_OPTIONS;

  verificationPassword = '';
  newRequestType: PrivacyRequestType = 'privacy-question';
  newRequestSubject = '';
  newRequestDetails = '';
  followUpMessage = '';

  constructor(
    readonly recentAuth: RecentAuthService,
    private readonly privacyOperations: PrivacyOperationsService,
  ) {
    void this.load();
  }

  async load(refresh = false): Promise<void> {
    if (this.refreshing()) return;
    refresh ? this.refreshing.set(true) : this.loading.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');

    try {
      const snapshot = await this.privacyOperations.loadMyCenter();
      this.snapshot.set(snapshot);
      if (refresh) this.successMessage.set('Privacy Center refreshed.');
    } catch (error: unknown) {
      this.errorMessage.set(this.friendlyError(error, 'Unable to load the Privacy Center.'));
    } finally {
      this.loading.set(false);
      this.refreshing.set(false);
    }
  }

  async verifyPassword(): Promise<void> {
    if (this.verifying()) return;
    if (!this.verificationPassword) {
      this.errorMessage.set('Enter your current password to unlock protected privacy actions.');
      return;
    }

    this.verifying.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');
    try {
      await this.recentAuth.reauthenticate(this.verificationPassword);
      this.verificationPassword = '';
      this.successMessage.set('Protected privacy actions are unlocked for this secure session.');
    } catch (error: unknown) {
      this.errorMessage.set(getFriendlyReauthenticationError(error));
    } finally {
      this.verifying.set(false);
    }
  }

  async downloadMyData(): Promise<void> {
    if (this.exporting()) return;
    if (!this.recentAuth.isRecent()) {
      this.errorMessage.set('Verify your current password before downloading account data.');
      return;
    }

    this.exporting.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');
    try {
      const result = await this.privacyOperations.prepareMyExport();
      const blob = new Blob([result.json], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.fileName;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      this.successMessage.set(
        `Downloaded ${result.fileName} (${this.formatBytes(result.byteSize)}). Package SHA-256 begins ${result.packageHash.slice(0, 12)}.`,
      );
      await this.reloadQuietly();
    } catch (error: unknown) {
      this.errorMessage.set(this.friendlyError(error, 'Unable to prepare your RinkRat data export.'));
    } finally {
      this.exporting.set(false);
    }
  }

  async createRequest(): Promise<void> {
    if (this.savingRequest()) return;
    if (!this.recentAuth.isRecent()) {
      this.errorMessage.set('Verify your current password before submitting a privacy request.');
      return;
    }
    if (this.newRequestSubject.trim().length < 4 || this.newRequestDetails.trim().length < 10) {
      this.errorMessage.set('Add a short subject and at least ten characters of detail.');
      return;
    }

    this.savingRequest.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');
    try {
      const request = await this.privacyOperations.createRequest({
        requestType: this.newRequestType,
        subject: this.newRequestSubject,
        details: this.newRequestDetails,
      });
      this.upsertRequest(request);
      this.newRequestType = 'privacy-question';
      this.newRequestSubject = '';
      this.newRequestDetails = '';
      this.successMessage.set(`Privacy request ${request.requestId.slice(0, 8).toUpperCase()} was submitted.`);
    } catch (error: unknown) {
      this.errorMessage.set(this.friendlyError(error, 'Unable to submit the privacy request.'));
    } finally {
      this.savingRequest.set(false);
    }
  }

  startFollowUp(request: PrivacyRequestRecord): void {
    this.selectedFollowUpId.set(request.requestId);
    this.followUpMessage = '';
    this.errorMessage.set('');
    this.successMessage.set('');
  }

  cancelFollowUp(): void {
    this.selectedFollowUpId.set('');
    this.followUpMessage = '';
  }

  async submitFollowUp(request: PrivacyRequestRecord): Promise<void> {
    if (this.savingRequestId()) return;
    if (!this.recentAuth.isRecent()) {
      this.errorMessage.set('Verify your current password before sending a follow-up.');
      return;
    }
    if (this.followUpMessage.trim().length < 4) {
      this.errorMessage.set('Add a short response before sending the follow-up.');
      return;
    }

    this.savingRequestId.set(request.requestId);
    this.errorMessage.set('');
    this.successMessage.set('');
    try {
      const updated = await this.privacyOperations.respondToRequest({
        requestId: request.requestId,
        expectedRevision: request.revision,
        message: this.followUpMessage,
      });
      this.upsertRequest(updated);
      this.cancelFollowUp();
      this.successMessage.set('Your follow-up was added to the privacy request.');
    } catch (error: unknown) {
      this.errorMessage.set(this.friendlyError(error, 'Unable to send the follow-up.'));
    } finally {
      this.savingRequestId.set('');
    }
  }

  async cancelRequest(request: PrivacyRequestRecord): Promise<void> {
    if (this.savingRequestId()) return;
    if (!this.recentAuth.isRecent()) {
      this.errorMessage.set('Verify your current password before cancelling a privacy request.');
      return;
    }

    this.savingRequestId.set(request.requestId);
    this.errorMessage.set('');
    this.successMessage.set('');
    try {
      const updated = await this.privacyOperations.cancelRequest({
        requestId: request.requestId,
        expectedRevision: request.revision,
      });
      this.upsertRequest(updated);
      this.successMessage.set('The privacy request was cancelled.');
    } catch (error: unknown) {
      this.errorMessage.set(this.friendlyError(error, 'Unable to cancel the privacy request.'));
    } finally {
      this.savingRequestId.set('');
    }
  }

  requestTypeLabel(value: PrivacyRequestType): string {
    return privacyRequestTypeLabel(value);
  }

  selectedRequestTypeDetail(): string {
    return this.requestTypeOptions.find((option) => option.value === this.newRequestType)?.detail ?? '';
  }

  statusLabel(value: PrivacyRequestRecord['status']): string {
    return privacyRequestStatusLabel(value);
  }

  requestStatusLabel(request: PrivacyRequestRecord): string {
    return privacyRequestStatusLabel(request.status);
  }

  requestClosed(request: PrivacyRequestRecord): boolean {
    return isPrivacyRequestClosed(request.status);
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

  exportSummary(item: PrivacyExportAudit): string {
    const count = Object.values(item.recordCounts).reduce((sum, value) => sum + value, 0);
    return `${count} indexed record${count === 1 ? '' : 's'} · SHA ${item.packageHash.slice(0, 12)}`;
  }

  private async reloadQuietly(): Promise<void> {
    try {
      this.snapshot.set(await this.privacyOperations.loadMyCenter());
    } catch {
      // The file is already downloaded. Export history can refresh on the next page load.
    }
  }

  private upsertRequest(request: PrivacyRequestRecord): void {
    this.snapshot.update((current) => {
      if (!current) return current;
      const requests = [request, ...current.requests.filter((entry) => entry.requestId !== request.requestId)]
        .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''));
      return { ...current, requests };
    });
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
