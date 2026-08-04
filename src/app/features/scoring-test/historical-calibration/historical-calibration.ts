import { Component, computed, OnDestroy, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';

import {
  HistoricalCalibrationFinding,
  HistoricalCalibrationProgress,
  HistoricalCalibrationReport,
  runHistoricalScoringCalibration,
} from '../../../core/scoring/historical-scoring-calibration.service';
import { loadSharedProjectionSnapshot } from '../../../core/projection/projection-snapshot.service';

@Component({
  selector: 'app-historical-scoring-calibration',
  imports: [FormsModule],
  templateUrl: './historical-calibration.html',
  styleUrl: './historical-calibration.css',
})
export class HistoricalScoringCalibration implements OnDestroy {
  season = '20252026';
  leagueTeamCount = 8;
  leagueId = '';

  readonly running = signal(false);
  readonly exactAssistRun = signal(false);
  readonly progress = signal<HistoricalCalibrationProgress | null>(null);
  readonly report = signal<HistoricalCalibrationReport | null>(null);
  readonly errorMessage = signal('');
  readonly projectionStatus = signal('');

  readonly progressPercent = computed(() => {
    const progress = this.progress();

    if (!progress || progress.total <= 0) {
      return 0;
    }

    return Math.min(100, Math.max(0, (progress.completed / progress.total) * 100));
  });

  private activeController: AbortController | null = null;

  constructor(route: ActivatedRoute) {
    const queryLeagueId = route.snapshot.queryParamMap.get('leagueId')?.trim();

    if (queryLeagueId) {
      this.leagueId = queryLeagueId;
    }
  }

  ngOnDestroy(): void {
    this.activeController?.abort();
  }

  runFastReport(): Promise<void> {
    return this.runReport(false);
  }

  runExactReport(): Promise<void> {
    return this.runReport(true);
  }

  cancelRun(): void {
    this.activeController?.abort();
  }

  exportReport(): void {
    const report = this.report();

    if (!report || typeof document === 'undefined') {
      return;
    }

    const blob = new Blob([JSON.stringify(report, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `rinkrat-scoring-calibration-${report.season}-${report.assistMode}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  getRecommendationLabel(report: HistoricalCalibrationReport): string {
    switch (report.recommendation) {
      case 'keep-current-rules':
        return 'Keep the current scoring rules';
      case 'review-before-changing':
        return 'Review the flagged results before changing rules';
      case 'insufficient-data':
      default:
        return 'Collect a larger sample before changing rules';
    }
  }

  getAssistModeLabel(report: HistoricalCalibrationReport): string {
    switch (report.assistMode) {
      case 'exact':
        return 'Exact play-by-play assists';
      case 'hybrid':
        return 'Hybrid exact + estimated assists';
      case 'estimated':
      default:
        return 'Fast estimated assist order';
    }
  }

  getFindingClass(finding: HistoricalCalibrationFinding): string {
    return `finding-${finding.level}`;
  }

  getSignedNumber(value: number): string {
    return value > 0 ? `+${value.toFixed(1)}` : value.toFixed(1);
  }

  getCorrelationDisplay(report: HistoricalCalibrationReport): string {
    const correlation = report.draftComparison.spearmanCorrelation;

    return correlation == null ? '—' : correlation.toFixed(3);
  }

  private async runReport(useExactAssists: boolean): Promise<void> {
    if (this.running()) {
      return;
    }

    const season = this.season.trim();
    const teamCount = Number(this.leagueTeamCount);

    if (!/^\d{8}$/.test(season)) {
      this.errorMessage.set('Enter the season as eight digits, such as 20252026.');
      return;
    }

    if (!Number.isFinite(teamCount) || teamCount < 2 || teamCount > 32) {
      this.errorMessage.set('League team count must be between 2 and 32.');
      return;
    }

    this.activeController?.abort();
    this.activeController = new AbortController();
    this.running.set(true);
    this.exactAssistRun.set(useExactAssists);
    this.errorMessage.set('');
    this.projectionStatus.set('');
    this.report.set(null);
    this.progress.set({
      stage: 'loading-schedules',
      completed: 0,
      total: 32,
      message: 'Preparing the historical season report.',
    });

    try {
      let projectionAssets = undefined;
      const normalizedLeagueId = this.leagueId.trim();

      if (normalizedLeagueId) {
        this.projectionStatus.set('Loading the league draft board for ranking comparison...');

        try {
          const snapshot = await loadSharedProjectionSnapshot(normalizedLeagueId);
          projectionAssets = snapshot?.assets;
          this.projectionStatus.set(
            snapshot
              ? `Matched against Projection V${snapshot.metadata.projectionVersion} draft rankings.`
              : 'No shared projection snapshot was found for that league. The scoring report will still run.',
          );
        } catch (error: unknown) {
          this.projectionStatus.set(
            error instanceof Error
              ? `Draft-ranking comparison skipped: ${error.message}`
              : 'Draft-ranking comparison skipped because the league snapshot could not be loaded.',
          );
        }
      }

      const report = await runHistoricalScoringCalibration({
        season,
        leagueTeamCount: Math.floor(teamCount),
        requiredGamesPerMatchup: 6,
        useExactAssists,
        projectionAssets,
        signal: this.activeController.signal,
        onProgress: (progress) => this.progress.set(progress),
      });

      this.report.set(report);
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        this.errorMessage.set('Historical calibration was cancelled.');
      } else {
        this.errorMessage.set(
          error instanceof Error
            ? error.message
            : 'Unable to complete historical scoring calibration.',
        );
      }
    } finally {
      this.running.set(false);
      this.activeController = null;
    }
  }
}
