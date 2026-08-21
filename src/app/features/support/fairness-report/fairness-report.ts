import { Component, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import type {
  PublicFairnessArchetypeCheck,
  PublicFairnessMetric,
  PublicFairnessPositionProfile,
  PublicFairnessReport,
} from '../../../core/fairness/public-fairness-report.models';
import {
  fairnessCheckStatusLabel,
  fairnessEvidenceLabel,
  formatFairnessMetric,
  isPublicFairnessReport,
} from '../../../core/fairness/public-fairness-report.util';

@Component({
  selector: 'app-fairness-report',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './fairness-report.html',
  styleUrl: './fairness-report.css',
})
export class FairnessReportPage {
  readonly report = signal<PublicFairnessReport | null>(null);
  readonly loading = signal(true);
  readonly errorMessage = signal('');

  constructor() {
    void this.loadReport();
  }

  formatMetric(metric: PublicFairnessMetric): string {
    return formatFairnessMetric(metric);
  }

  evidenceLabel(profile: PublicFairnessPositionProfile | PublicFairnessMetric): string {
    return fairnessEvidenceLabel(profile.evidenceType);
  }

  checkStatusLabel(check: PublicFairnessArchetypeCheck): string {
    return fairnessCheckStatusLabel(check.status);
  }

  formatNumber(value: number): string {
    return new Intl.NumberFormat('en-US').format(value);
  }

  formatPoints(value: number): string {
    return value.toFixed(1);
  }

  formatPercent(value: number): string {
    return `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
  }

  formatRatio(value: number): string {
    return value.toFixed(3);
  }

  printReport(): void {
    window.print();
  }

  private async loadReport(): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set('');

    try {
      const response = await fetch('/data/rinkrat-fairness-report-v1.json', {
        cache: 'no-cache',
        credentials: 'same-origin',
      });

      if (!response.ok) {
        throw new Error(`Fairness report request failed with status ${response.status}.`);
      }

      const data: unknown = await response.json();

      if (!isPublicFairnessReport(data)) {
        throw new Error('The fairness report did not match the supported public schema.');
      }

      this.report.set(data);
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'The fairness report could not be loaded.',
      );
    } finally {
      this.loading.set(false);
    }
  }
}
