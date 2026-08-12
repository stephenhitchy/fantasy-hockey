import { Component, computed, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { PublicBetaKnownIssue } from '../../../core/beta-operations/beta-operations.models';
import { BetaOperationsService } from '../../../core/beta-operations/beta-operations.service';

@Component({
  selector: 'app-known-issues',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './known-issues.html',
  styleUrl: './known-issues.css',
})
export class KnownIssuesPage {
  readonly loading = signal(true);
  readonly errorMessage = signal('');
  readonly issues = signal<PublicBetaKnownIssue[]>([]);
  readonly openIssues = computed(() =>
    this.issues().filter((issue) => issue.status !== 'resolved'),
  );
  readonly resolvedIssues = computed(() =>
    this.issues().filter((issue) => issue.status === 'resolved'),
  );

  constructor(private readonly betaOperations: BetaOperationsService) {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set('');

    try {
      const response = await this.betaOperations.loadPublicKnownIssues();
      this.issues.set(response.issues);
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Known issues could not be loaded right now.',
      );
    } finally {
      this.loading.set(false);
    }
  }

  statusLabel(status: string): string {
    const labels: Record<string, string> = {
      investigating: 'Investigating',
      'fix-prepared': 'Fix prepared',
      monitoring: 'Monitoring fix',
      resolved: 'Resolved',
    };
    return labels[status] ?? status.replace(/-/g, ' ');
  }

  severityLabel(severity: string): string {
    const labels: Record<string, string> = {
      integrity: 'Competition integrity',
      blocker: 'Blocked action',
      serious: 'Serious usability',
      cosmetic: 'Cosmetic',
      idea: 'Improvement',
    };

    return labels[severity] ?? severity;
  }

  formatDate(value: string | null): string {
    if (!value) {
      return 'Not recorded';
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? 'Not recorded'
      : new Intl.DateTimeFormat('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }).format(date);
  }
}
