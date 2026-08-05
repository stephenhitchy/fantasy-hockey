import { Component, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { APP_RUNTIME_CONFIG } from '../../../../environments/app-runtime.config';
import { ClientPerformanceMonitorService } from '../../../core/observability/client-performance-monitor.service';
import { CompetitiveActionMonitorService } from '../../../core/observability/competitive-action-monitor.service';

@Component({
  selector: 'app-support-home',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './support-home.html',
  styleUrl: './support-home.css',
})
export class SupportHome {
  readonly releaseLabel = APP_RUNTIME_CONFIG.releaseLabel;
  readonly diagnosticMessage = signal('');
  readonly diagnosticError = signal('');
  readonly copyingDiagnostics = signal(false);

  constructor(
    private readonly performanceMonitor: ClientPerformanceMonitorService,
    private readonly actionMonitor: CompetitiveActionMonitorService,
  ) {}

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
