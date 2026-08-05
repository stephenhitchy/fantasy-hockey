import { KeyValuePipe } from '@angular/common';
import { Component, computed, OnDestroy, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { onAuthStateChanged } from 'firebase/auth';

import { getScoringRuntimeState } from '../../../core/cycle/cycle-runtime.config';
import {
  ClientPerformanceMonitorService,
  type ClientPerformanceSnapshot,
} from '../../../core/observability/client-performance-monitor.service';
import {
  CompetitiveActionMonitorService,
} from '../../../core/observability/competitive-action-monitor.service';
import {
  getCompetitiveActionLabel,
  type CompetitiveActionHealthSnapshot,
  type CompetitiveActionKind,
  type CompetitiveActionOutcome,
} from '../../../core/observability/competitive-action-health.util';
import { auth } from '../../../core/firebase';
import { getLeagueById, League } from '../../../core/league/league.service';
import {
  ReleaseReadinessCheck,
  ReleaseReadinessSnapshot,
  SeasonLifecycleSimulationResult,
} from '../../../core/release/release-readiness.models';
import {
  clearReleaseReadinessScoringLease,
  loadReleaseReadinessSnapshot,
  regenerateReleaseReadinessProjection,
  retryReleaseReadinessInjurySync,
  retryReleaseReadinessScoring,
} from '../../../core/release/release-readiness.service';
import { runFullSeasonLifecycleSimulator } from '../../../core/release/season-lifecycle-simulator';

@Component({
  selector: 'app-release-readiness',
  imports: [KeyValuePipe, RouterLink],
  templateUrl: './release-readiness.html',
  styleUrl: './release-readiness.css',
})
export class ReleaseReadiness implements OnDestroy {
  readonly leagueId: string;
  readonly league = signal<League | null>(null);
  readonly loading = signal(true);
  readonly authorized = signal(false);
  readonly snapshot = signal<ReleaseReadinessSnapshot | null>(null);
  readonly simulation = signal<SeasonLifecycleSimulationResult | null>(null);
  readonly errorMessage = signal('');
  readonly actionMessage = signal('');
  readonly actionInProgress = signal(false);
  readonly targetProjectionCycle = signal(1);
  readonly runtime = getScoringRuntimeState();
  readonly clientPerformance = signal<ClientPerformanceSnapshot | null>(null);
  readonly competitiveActions = signal<CompetitiveActionHealthSnapshot | null>(null);

  readonly requiredChecks = computed(
    () => this.snapshot()?.checks.filter((check) => check.requiredForLiveLaunch) ?? [],
  );

  readonly advisoryChecks = computed(
    () => this.snapshot()?.checks.filter((check) => !check.requiredForLiveLaunch) ?? [],
  );

  readonly groupedRequiredChecks = computed(() => {
    const checks = this.requiredChecks();
    const categories: Array<ReleaseReadinessCheck['category']> = [
      'configuration',
      'league',
      'scoring',
      'projection',
      'injury',
      'playoffs',
    ];

    return categories
      .map((category) => ({
        category,
        label: this.getCategoryLabel(category),
        checks: checks.filter((check) => check.category === category),
      }))
      .filter((group) => group.checks.length > 0);
  });

  private clientHealthTimer: number | null = null;

  constructor(
    route: ActivatedRoute,
    private readonly performanceMonitor: ClientPerformanceMonitorService,
    private readonly actionMonitor: CompetitiveActionMonitorService,
  ) {
    this.leagueId = route.snapshot.paramMap.get('leagueId') ?? '';
    this.refreshClientHealth();

    if (typeof window !== 'undefined') {
      this.clientHealthTimer = window.setInterval(() => this.refreshClientHealth(), 2_500);
    }

    void this.initialize();
  }

  ngOnDestroy(): void {
    if (this.clientHealthTimer !== null && typeof window !== 'undefined') {
      window.clearInterval(this.clientHealthTimer);
      this.clientHealthTimer = null;
    }
  }

  async refreshReadiness(): Promise<void> {
    await this.runAction(async () => {
      const snapshot = await loadReleaseReadinessSnapshot(this.leagueId);
      this.snapshot.set(snapshot);
      this.targetProjectionCycle.set(Math.max(1, (snapshot.latestCycleNumber ?? 0) + 1));
      return 'Release-readiness checks refreshed.';
    }, false);
  }

  runSeasonSimulator(): void {
    this.simulation.set(runFullSeasonLifecycleSimulator());
    this.actionMessage.set(
      'The deterministic full-season simulation finished without NHL requests or Firestore writes.',
    );
    this.errorMessage.set('');
  }

  async requestScoreRecovery(): Promise<void> {
    await this.runAction(async () => {
      await retryReleaseReadinessScoring(this.leagueId);
      return 'Shared scoring refresh requested. The worker will publish only if data changed.';
    });
  }

  async clearStuckLease(): Promise<void> {
    await this.runAction(async () => {
      await clearReleaseReadinessScoringLease(this.leagueId);
      return 'The expired or errored scoring lease was cleared safely. A commissioner worker may claim it now.';
    });
  }

  async retryInjurySync(): Promise<void> {
    await this.runAction(async () => retryReleaseReadinessInjurySync(this.leagueId));
  }

  async regenerateProjection(): Promise<void> {
    const target = Math.max(1, Math.floor(Number(this.targetProjectionCycle()) || 1));
    this.targetProjectionCycle.set(target);

    await this.runAction(async () => regenerateReleaseReadinessProjection(this.leagueId, target));
  }

  setTargetProjectionCycle(value: string): void {
    const parsed = Number(value);
    this.targetProjectionCycle.set(Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : 1);
  }

  getOverallLabel(snapshot: ReleaseReadinessSnapshot): string {
    switch (snapshot.overallStatus) {
      case 'ready':
        return 'Ready for controlled live use';
      case 'attention':
        return 'Action required';
      default:
        return 'Testing configuration';
    }
  }

  getCheckIcon(check: ReleaseReadinessCheck): string {
    if (check.level === 'pass') {
      return '✓';
    }

    return check.level === 'warning' ? '!' : '×';
  }

  refreshClientHealth(): void {
    this.clientPerformance.set(this.performanceMonitor.getSnapshot());
    this.competitiveActions.set(this.actionMonitor.getSnapshot());
  }

  async copyClientHealthReport(): Promise<void> {
    const clientPerformance = this.performanceMonitor.getSnapshot();
    const competitiveActions = this.actionMonitor.getSnapshot();
    this.clientPerformance.set(clientPerformance);
    this.competitiveActions.set(competitiveActions);

    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      this.errorMessage.set('Clipboard access is unavailable in this browser.');
      return;
    }

    try {
      await navigator.clipboard.writeText(JSON.stringify({
        releaseLabel: this.runtime.releaseLabel,
        generatedAt: new Date().toISOString(),
        clientPerformance,
        competitiveActions,
      }, null, 2));
      this.actionMessage.set('This browser’s beta diagnostics were copied to the clipboard.');
      this.errorMessage.set('');
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to copy the beta diagnostics.',
      );
    }
  }

  formatPerformanceMilliseconds(value: number | null): string {
    return value === null ? 'Collecting' : `${Math.round(value)} ms`;
  }

  formatLayoutShift(value: number): string {
    return value.toFixed(3);
  }

  formatCompetitiveActionDuration(value: number): string {
    if (value < 1_000) {
      return `${Math.round(value)} ms`;
    }

    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)} s`;
  }

  getCompetitiveActionLabel(action: CompetitiveActionKind): string {
    return getCompetitiveActionLabel(action);
  }

  getCompetitiveActionOutcomeLabel(outcome: CompetitiveActionOutcome): string {
    switch (outcome) {
      case 'success':
        return 'Confirmed';
      case 'error':
        return 'Failed';
      case 'uncertain':
        return 'Needs roster check';
      case 'cancelled':
        return 'Cancelled';
    }
  }

  getCompetitiveActionOutcomeClass(outcome: CompetitiveActionOutcome): string {
    return `competitive-action-outcome--${outcome}`;
  }

  getConnectionSummary(snapshot: ClientPerformanceSnapshot): string {
    if (!snapshot.connection.online) {
      return 'Offline';
    }

    const type = snapshot.connection.effectiveConnectionType;
    return type === 'unknown' ? 'Online' : `Online · ${type.toUpperCase()}`;
  }

  formatTimestamp(value: string | null): string {
    if (!value) {
      return 'Not yet';
    }

    const parsed = Date.parse(value);

    if (!Number.isFinite(parsed)) {
      return 'Not recorded';
    }

    return new Date(parsed).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  private async initialize(): Promise<void> {
    if (!this.leagueId) {
      this.errorMessage.set('League id is missing.');
      this.loading.set(false);
      return;
    }

    const user = await new Promise<typeof auth.currentUser>((resolve) => {
      if (auth.currentUser) {
        resolve(auth.currentUser);
        return;
      }

      const stop = onAuthStateChanged(auth, (nextUser) => {
        stop();
        resolve(nextUser);
      });
    });
    const league = await getLeagueById(this.leagueId);

    this.league.set(league);
    this.authorized.set(Boolean(user && league?.commissionerId === user.uid));

    if (this.authorized()) {
      try {
        const snapshot = await loadReleaseReadinessSnapshot(this.leagueId);
        this.snapshot.set(snapshot);
        this.targetProjectionCycle.set(Math.max(1, (snapshot.latestCycleNumber ?? 0) + 1));
      } catch (error: unknown) {
        this.errorMessage.set(this.getErrorMessage(error));
      }
    }

    this.loading.set(false);
  }

  private async runAction(action: () => Promise<string>, refreshAfter = true): Promise<void> {
    if (this.actionInProgress()) {
      return;
    }

    this.actionInProgress.set(true);
    this.actionMessage.set('');
    this.errorMessage.set('');

    try {
      const message = await action();
      this.actionMessage.set(message);

      if (refreshAfter) {
        const snapshot = await loadReleaseReadinessSnapshot(this.leagueId);
        this.snapshot.set(snapshot);
      }
    } catch (error: unknown) {
      this.errorMessage.set(this.getErrorMessage(error));
    } finally {
      this.actionInProgress.set(false);
    }
  }

  private getCategoryLabel(category: ReleaseReadinessCheck['category']): string {
    switch (category) {
      case 'configuration':
        return 'Build configuration';
      case 'league':
        return 'League lifecycle';
      case 'scoring':
        return 'Cycle and live scoring';
      case 'projection':
        return 'Projection system';
      case 'injury':
        return 'Player availability';
      case 'playoffs':
        return 'Postseason';
    }
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error
      ? error.message
      : 'Unable to complete the release-readiness action.';
  }
}
