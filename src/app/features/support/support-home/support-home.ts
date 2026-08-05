import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { BUNDLED_RELEASE_MANIFEST } from '../../../../environments/generated-release-manifest';
import { ClientPerformanceMonitorService } from '../../../core/observability/client-performance-monitor.service';
import { CompetitiveActionMonitorService } from '../../../core/observability/competitive-action-monitor.service';
import type { ReleaseUpdateSnapshot } from '../../../core/release/release-manifest.models';
import { ReleaseUpdateService } from '../../../core/release/release-update.service';

@Component({
  selector: 'app-support-home',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './support-home.html',
  styleUrl: './support-home.css',
})
export class SupportHome {
  private readonly releaseUpdate = inject(ReleaseUpdateService);

  readonly releaseLabel = BUNDLED_RELEASE_MANIFEST.releaseLabel;
  readonly releaseDeployment = computed<ReleaseUpdateSnapshot>(() =>
    this.releaseUpdate.getSnapshot(),
  );
  readonly releaseReloadBlocked = computed(
    () => this.actionMonitor.activeCount() > 0 || this.releaseUpdate.reloadRequested(),
  );
  readonly diagnosticMessage = signal('');
  readonly diagnosticError = signal('');
  readonly copyingDiagnostics = signal(false);

  constructor(
    private readonly performanceMonitor: ClientPerformanceMonitorService,
    private readonly actionMonitor: CompetitiveActionMonitorService,
  ) {}


  async checkForUpdates(): Promise<void> {
    this.diagnosticMessage.set('');
    this.diagnosticError.set('');

    try {
      const updateAvailable = await this.releaseUpdate.checkForUpdate(true);
      this.diagnosticMessage.set(
        updateAvailable
          ? 'A different RinkRat build is deployed. Reload before your next competitive action.'
          : 'This tab matches the deployed RinkRat build.',
      );
    } catch (error: unknown) {
      this.diagnosticError.set(
        error instanceof Error ? error.message : 'Unable to check the deployed build.',
      );
    }
  }

  reloadForUpdate(): void {
    if (this.actionMonitor.activeCount() > 0) {
      this.diagnosticError.set('Finish the active competitive action before reloading.');
      return;
    }

    if (!this.releaseUpdate.requestReload()) {
      this.diagnosticError.set('The update reload could not start. Refresh the page once manually.');
    }
  }

  formatBuildIdentifier(value: string): string {
    return value.length <= 26 ? value : `${value.slice(0, 16)}…${value.slice(-8)}`;
  }

  getDeploymentStatusLabel(snapshot: ReleaseUpdateSnapshot): string {
    if (snapshot.updateAvailable) {
      return snapshot.direction === 'rollback' ? 'Reload for rollback' : 'Reload required';
    }

    switch (snapshot.status) {
      case 'checking':
        return 'Checking deployment';
      case 'offline':
        return 'Offline';
      case 'error':
        return 'Check unavailable';
      case 'idle':
        return snapshot.latest ? 'Current build' : 'Not checked yet';
      default:
        return 'Current build';
    }
  }

  async copyBetaDiagnostics(): Promise<void> {
    if (this.copyingDiagnostics()) {
      return;
    }

    this.copyingDiagnostics.set(true);
    this.diagnosticMessage.set('');
    this.diagnosticError.set('');

    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      this.diagnosticError.set('Clipboard access is unavailable in this browser.');
      this.copyingDiagnostics.set(false);
      return;
    }

    const report = {
      releaseLabel: this.releaseLabel,
      generatedAt: new Date().toISOString(),
      clientPerformance: this.performanceMonitor.getSnapshot(),
      competitiveActions: this.actionMonitor.getSnapshot(),
      releaseDeployment: this.releaseUpdate.getSnapshot(),
    };

    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      this.diagnosticMessage.set(
        'Beta diagnostics copied. Paste them into the feedback form with a description of what happened.',
      );
    } catch (error: unknown) {
      this.diagnosticError.set(
        error instanceof Error ? error.message : 'Unable to copy the beta diagnostics.',
      );
    } finally {
      this.copyingDiagnostics.set(false);
    }
  }
}
