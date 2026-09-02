import { Component, Input, OnDestroy, signal } from '@angular/core';

import {
  FinalScoreReconciliationFinding,
  FinalScoreReconciliationService,
  FinalScoreReconciliationSummary,
} from '../../../core/admin/final-score-reconciliation.service';

interface FinalScoreReconciliationRun {
  generatedAt: string;
  leagueId: string;
  cycleNumber: number;
  pagesScanned: number;
  scanComplete: boolean;
  teamDocumentCoverageChecked: boolean;
  inspectionIncomplete: boolean;
  findingsTruncated: boolean;
  summary: FinalScoreReconciliationSummary;
  findings: FinalScoreReconciliationFinding[];
}

const MAX_SCAN_PAGES = 8;
const MAX_DISPLAYED_FINDINGS = 120;

@Component({
  selector: 'app-final-score-reconciliation',
  templateUrl: './final-score-reconciliation.html',
  styleUrl: './final-score-reconciliation.css',
})
export class FinalScoreReconciliation implements OnDestroy {
  @Input({ required: true }) currentLeagueId = '';

  readonly cycleNumberInput = signal('');
  readonly leagueIdInput = signal('');
  readonly loading = signal(false);
  readonly progressMessage = signal('');
  readonly errorMessage = signal('');
  readonly result = signal<FinalScoreReconciliationRun | null>(null);

  private requestGeneration = 0;

  constructor(
    private readonly reconciliation: FinalScoreReconciliationService,
  ) {}

  ngOnDestroy(): void {
    this.requestGeneration += 1;
  }

  setCycleNumber(value: string): void {
    this.cycleNumberInput.set(value.replace(/[^0-9]/g, '').slice(0, 4));
  }

  setLeagueId(value: string): void {
    this.leagueIdInput.set(value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128));
  }

  async runAudit(): Promise<void> {
    const leagueId = this.leagueIdInput().trim() || this.currentLeagueId;

    if (this.loading() || !leagueId) {
      return;
    }

    if (!/^[A-Za-z0-9_-]{3,128}$/.test(leagueId)) {
      this.errorMessage.set('Enter a valid exact league ID.');
      return;
    }

    const requestedCycleNumber = this.parseCycleNumber();

    if (requestedCycleNumber === 'invalid') {
      this.errorMessage.set('Enter a cycle number from 1 to 1000, or leave it blank for the latest cycle.');
      return;
    }

    const requestGeneration = ++this.requestGeneration;
    let afterTeamId = '';
    let resolvedCycleNumber = requestedCycleNumber;
    let aggregate = this.emptyRun(leagueId);

    this.loading.set(true);
    this.errorMessage.set('');
    this.result.set(null);
    this.progressMessage.set('Reading the first bounded page…');

    try {
      for (let pageIndex = 0; pageIndex < MAX_SCAN_PAGES; pageIndex += 1) {
        const page = await this.reconciliation.loadPage({
          leagueId,
          cycleNumber: resolvedCycleNumber,
          afterTeamId,
        });

        if (requestGeneration !== this.requestGeneration) {
          return;
        }

        if (resolvedCycleNumber === null) {
          resolvedCycleNumber = page.cycleNumber;
        }

        if (page.cycleNumber !== resolvedCycleNumber) {
          throw new Error('The server returned a different cycle while the audit was in progress.');
        }

        if (page.leagueId !== leagueId) {
          throw new Error('The server returned a different league while the audit was in progress.');
        }

        aggregate = this.mergePage(aggregate, page);
        this.result.set(aggregate);

        if (page.scanComplete) {
          this.progressMessage.set(
            !this.isAuditComplete(aggregate)
              ? 'The team scan finished, but some evidence could not be completely inspected.'
              : 'Detect-only scan complete. No score or league data was changed.',
          );
          return;
        }

        if (!page.nextCursor) {
          throw new Error('The audit page was incomplete and did not provide a safe continuation cursor.');
        }

        afterTeamId = page.nextCursor;
        this.progressMessage.set(
          `Read ${aggregate.summary.teamDocumentCount} team document(s); loading the next bounded page…`,
        );
      }

      aggregate = { ...aggregate, scanComplete: false };
      this.result.set(aggregate);
      this.progressMessage.set(
        'The eight-page safety ceiling was reached. Treat this audit as incomplete.',
      );
    } catch (error: unknown) {
      if (requestGeneration === this.requestGeneration) {
        this.errorMessage.set(getErrorMessage(error));
        this.progressMessage.set(
          aggregate.pagesScanned > 0
            ? 'Partial read-only results remain visible. Retry to restart from the first page.'
            : '',
        );
      }
    } finally {
      if (requestGeneration === this.requestGeneration) {
        this.loading.set(false);
      }
    }
  }

  getOutcomeLabel(run: FinalScoreReconciliationRun): string {
    if (!this.isAuditComplete(run)) {
      return 'Audit incomplete';
    }

    if (run.summary.candidateGameCount > 0 || run.summary.integrityIssueCount > 0) {
      return 'Review candidates detected';
    }

    if (run.summary.unverifiableGameCount > 0) {
      return 'Some finals are unverifiable';
    }

    if (run.summary.finalizedGameCount === 0) {
      return 'No finalized games found';
    }

    return 'Current canonical evidence matches';
  }

  getOutcomeClass(run: FinalScoreReconciliationRun): string {
    if (
      !this.isAuditComplete(run) ||
      run.summary.candidateGameCount > 0 ||
      run.summary.integrityIssueCount > 0
    ) {
      return 'reconciliation-outcome-attention';
    }

    return run.summary.unverifiableGameCount > 0
      ? 'reconciliation-outcome-warning'
      : 'reconciliation-outcome-pass';
  }

  isAuditComplete(run: FinalScoreReconciliationRun): boolean {
    return run.scanComplete &&
      run.teamDocumentCoverageChecked &&
      !run.inspectionIncomplete &&
      !run.findingsTruncated;
  }

  getFindingLabel(finding: FinalScoreReconciliationFinding): string {
    return finding.code
      .split('-')
      .filter(Boolean)
      .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
      .join(' ');
  }

  formatPoints(value: number | null): string {
    return value === null ? '—' : value.toFixed(1);
  }

  formatSourceVersion(value: string): string {
    return value ? `${value.slice(0, 12)}…` : 'Unavailable';
  }

  formatTimestamp(value: string): string {
    const parsed = new Date(value);

    return Number.isFinite(parsed.getTime())
      ? parsed.toLocaleString([], {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : 'Not recorded';
  }

  private parseCycleNumber(): number | null | 'invalid' {
    const value = this.cycleNumberInput().trim();

    if (!value) {
      return null;
    }

    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 1_000
      ? parsed
      : 'invalid';
  }

  private emptyRun(leagueId: string): FinalScoreReconciliationRun {
    return {
      generatedAt: '',
      leagueId,
      cycleNumber: 0,
      pagesScanned: 0,
      scanComplete: false,
      teamDocumentCoverageChecked: false,
      inspectionIncomplete: false,
      findingsTruncated: false,
      summary: {
        teamDocumentCount: 0,
        windowCount: 0,
        finalizedGameCount: 0,
        verifiedGameCount: 0,
        candidateGameCount: 0,
        unverifiableGameCount: 0,
        integrityIssueCount: 0,
        findingCount: 0,
      },
      findings: [],
    };
  }

  private mergePage(
    current: FinalScoreReconciliationRun,
    page: Awaited<ReturnType<FinalScoreReconciliationService['loadPage']>>,
  ): FinalScoreReconciliationRun {
    return {
      generatedAt: page.generatedAt,
      leagueId: page.leagueId,
      cycleNumber: page.cycleNumber,
      pagesScanned: current.pagesScanned + 1,
      scanComplete: page.scanComplete,
      teamDocumentCoverageChecked:
        current.teamDocumentCoverageChecked || page.teamDocumentCoverageChecked,
      inspectionIncomplete:
        current.inspectionIncomplete ||
        page.canonicalGameReadLimitReached ||
        page.teamWindowLimitReached ||
        page.windowGameLimitReached ||
        page.teamWindowStructureIncomplete,
      findingsTruncated: current.findingsTruncated || page.findingsTruncated ||
        current.findings.length + page.findings.length > MAX_DISPLAYED_FINDINGS,
      summary: {
        teamDocumentCount:
          current.summary.teamDocumentCount + page.summary.teamDocumentCount,
        windowCount: current.summary.windowCount + page.summary.windowCount,
        finalizedGameCount:
          current.summary.finalizedGameCount + page.summary.finalizedGameCount,
        verifiedGameCount:
          current.summary.verifiedGameCount + page.summary.verifiedGameCount,
        candidateGameCount:
          current.summary.candidateGameCount + page.summary.candidateGameCount,
        unverifiableGameCount:
          current.summary.unverifiableGameCount + page.summary.unverifiableGameCount,
        integrityIssueCount:
          current.summary.integrityIssueCount + page.summary.integrityIssueCount,
        findingCount: current.summary.findingCount + page.summary.findingCount,
      },
      findings: [...current.findings, ...page.findings]
        .slice(0, MAX_DISPLAYED_FINDINGS),
    };
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }

  return 'The detect-only final-score audit could not complete.';
}
