import { Component, Input, OnChanges, OnDestroy, SimpleChanges, signal } from '@angular/core';

import type { ClientPerformanceSnapshot } from '../../../core/observability/client-performance-monitor.service';
import type { CompetitiveActionHealthSnapshot } from '../../../core/observability/competitive-action-health.util';
import { InviteBetaValidationStore } from '../../../core/release/invite-beta-validation.store';
import {
  buildInviteBetaValidationGroups,
  calculateInviteBetaLaunchGate,
  createInviteBetaValidationReport,
  createInviteBetaValidationSession,
  InviteBetaLaunchGate,
  InviteBetaValidationGroupView,
  InviteBetaValidationItemState,
  InviteBetaValidationSession,
  InviteBetaValidationStatus,
  updateInviteBetaValidationIdentity,
  updateInviteBetaValidationItem,
} from '../../../core/release/invite-beta-validation.util';
import type {
  ReleaseManifest,
  ReleaseUpdateStatus,
} from '../../../core/release/release-manifest.models';
import type {
  ReleaseReadinessCheck,
  SeasonLifecycleSimulationResult,
} from '../../../core/release/release-readiness.models';

@Component({
  selector: 'app-invite-beta-validation',
  standalone: true,
  templateUrl: './invite-beta-validation.html',
  styleUrl: './invite-beta-validation.css',
})
export class InviteBetaValidation implements OnChanges, OnDestroy {
  @Input({ required: true }) leagueId = '';
  @Input({ required: true }) releaseKey = '';
  @Input({ required: true }) releaseLabel = '';
  @Input() releaseManifest: ReleaseManifest | null = null;
  @Input() releaseUpdateAvailable = false;
  @Input() releaseCheckStatus: ReleaseUpdateStatus = 'idle';
  @Input() automatedChecks: ReleaseReadinessCheck[] = [];
  @Input() simulation: SeasonLifecycleSimulationResult | null = null;
  @Input() clientPerformance: ClientPerformanceSnapshot | null = null;
  @Input() competitiveActions: CompetitiveActionHealthSnapshot | null = null;

  readonly session = signal<InviteBetaValidationSession>(
    createInviteBetaValidationSession('loading-release', 'Loading release'),
  );
  readonly message = signal('');
  readonly error = signal('');
  readonly copying = signal(false);
  readonly resetArmed = signal(false);
  readonly storageAvailable = signal(true);

  private loadedStorageKey = '';
  private resetTimer: number | null = null;

  constructor(private readonly store: InviteBetaValidationStore) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['leagueId'] || changes['releaseKey'] || changes['releaseLabel']) {
      this.loadSession();
    }
  }

  ngOnDestroy(): void {
    if (this.resetTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
  }

  get groups(): InviteBetaValidationGroupView[] {
    return buildInviteBetaValidationGroups(this.session());
  }

  get gate(): InviteBetaLaunchGate {
    return calculateInviteBetaLaunchGate({
      automatedChecks: this.automatedChecks,
      simulation: this.simulation,
      manualSession: this.session(),
      connectionOnline: this.connectionOnline,
      activeActionCount: this.competitiveActions?.activeCount ?? 0,
      actionErrorCount: this.competitiveActions?.errorCount ?? 0,
      actionUncertainCount: this.competitiveActions?.uncertainCount ?? 0,
      releaseUpdateAvailable: this.releaseUpdateAvailable,
      releaseCheckStatus: this.releaseCheckStatus,
    });
  }

  get connectionOnline(): boolean {
    if (this.clientPerformance) {
      return this.clientPerformance.connection.online;
    }

    return typeof navigator === 'undefined' ? true : navigator.onLine;
  }

  get buildLabel(): string {
    return this.releaseManifest?.buildId || this.releaseKey || this.releaseLabel;
  }

  getStatusLabel(status: InviteBetaValidationStatus): string {
    switch (status) {
      case 'pass':
        return 'Passed';
      case 'attention':
        return 'Needs attention';
      case 'untested':
        return 'Not tested';
    }
  }

  getItemState(itemId: string): InviteBetaValidationItemState {
    return this.session().items[itemId] ?? {
      status: 'untested',
      note: '',
      updatedAt: null,
    };
  }

  setItemStatus(itemId: string, status: InviteBetaValidationStatus): void {
    this.commitSession(updateInviteBetaValidationItem(this.session(), itemId, { status }));
  }

  setItemNote(itemId: string, note: string): void {
    this.commitSession(updateInviteBetaValidationItem(this.session(), itemId, { note }));
  }

  setIdentity(field: 'testerLabel' | 'deviceLabel', value: string): void {
    this.commitSession(updateInviteBetaValidationIdentity(this.session(), field, value));
  }

  formatTimestamp(value: string | null): string {
    if (!value) {
      return 'Not recorded';
    }

    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
      return 'Not recorded';
    }

    return new Date(parsed).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  async copyReport(): Promise<void> {
    if (this.copying()) {
      return;
    }

    this.copying.set(true);
    this.message.set('');
    this.error.set('');

    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      this.error.set('Clipboard access is unavailable in this browser.');
      this.copying.set(false);
      return;
    }

    const report = createInviteBetaValidationReport({
      releaseLabel: this.releaseLabel,
      generatedAt: new Date().toISOString(),
      session: this.session(),
      gate: this.gate,
      automatedChecks: this.automatedChecks,
      simulation: this.simulation,
      clientPerformance: this.clientPerformance,
      competitiveActions: this.competitiveActions,
      releaseManifest: this.releaseManifest,
      viewport: this.getViewportLabel(),
      browser: this.getBrowserLabel(),
    });

    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      this.message.set(
        'Invite-beta validation report copied. Manual notes are included; review them before sharing.',
      );
    } catch (copyError: unknown) {
      this.error.set(
        copyError instanceof Error
          ? copyError.message
          : 'Unable to copy the invite-beta validation report.',
      );
    } finally {
      this.copying.set(false);
    }
  }

  requestReset(): void {
    if (!this.resetArmed()) {
      this.resetArmed.set(true);
      this.message.set('Press Reset Validation again within five seconds to clear this build board.');
      this.error.set('');

      if (typeof window !== 'undefined') {
        if (this.resetTimer !== null) {
          window.clearTimeout(this.resetTimer);
        }
        this.resetTimer = window.setTimeout(() => {
          this.resetArmed.set(false);
          this.resetTimer = null;
        }, 5_000);
      }
      return;
    }

    if (this.resetTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }

    this.store.clear(this.leagueId, this.releaseKey);
    const next = createInviteBetaValidationSession(this.releaseKey, this.releaseLabel);
    this.session.set(next);
    this.storageAvailable.set(this.store.save(this.leagueId, this.releaseKey, next));
    this.resetArmed.set(false);
    this.message.set('This build’s manual validation board was reset.');
    this.error.set('');
  }

  private loadSession(): void {
    const nextKey = `${this.releaseKey}::${this.leagueId}`;
    if (!this.releaseKey || !this.releaseLabel || !this.leagueId || nextKey === this.loadedStorageKey) {
      return;
    }

    this.loadedStorageKey = nextKey;
    this.session.set(this.store.load(this.leagueId, this.releaseKey, this.releaseLabel));
    this.message.set('');
    this.error.set('');
  }

  private commitSession(next: InviteBetaValidationSession): void {
    this.session.set(next);
    const saved = this.store.save(this.leagueId, this.releaseKey, next);
    this.storageAvailable.set(saved);

    if (!saved) {
      this.error.set(
        'This browser could not save the validation board. Keep the page open or copy the report before leaving.',
      );
      return;
    }

    this.error.set('');
  }

  private getViewportLabel(): string {
    if (typeof window === 'undefined') {
      return 'Unknown';
    }

    return `${Math.round(window.innerWidth)}x${Math.round(window.innerHeight)} @ ${window.devicePixelRatio || 1}x`;
  }

  private getBrowserLabel(): string {
    if (typeof navigator === 'undefined') {
      return 'Unknown';
    }

    const userAgent = navigator.userAgent;
    if (/Edg\//.test(userAgent)) {
      return 'Edge';
    }
    if (/CriOS\//.test(userAgent)) {
      return 'Chrome on iOS';
    }
    if (/Chrome\//.test(userAgent)) {
      return 'Chrome';
    }
    if (/FxiOS\//.test(userAgent)) {
      return 'Firefox on iOS';
    }
    if (/Firefox\//.test(userAgent)) {
      return 'Firefox';
    }
    if (/Safari\//.test(userAgent) && /Mobile\//.test(userAgent)) {
      return 'Mobile Safari';
    }
    if (/Safari\//.test(userAgent)) {
      return 'Safari';
    }

    return 'Other browser';
  }
}
