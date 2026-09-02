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
import {
  getLeagueById,
  League,
  migrateLeagueAuthoritySchema,
} from '../../../core/league/league.service';
import type { ReleaseUpdateSnapshot } from '../../../core/release/release-manifest.models';
import {
  ReleaseReadinessCheck,
  ReleaseReadinessSnapshot,
  SeasonLifecycleSimulationResult,
} from '../../../core/release/release-readiness.models';
import {
  clearReleaseReadinessScoringLease,
  loadReleaseReadinessSnapshot,
  regenerateReleaseReadinessProjection,
  restorePreviousReleaseReadinessProjection,
  retryReleaseReadinessInjurySync,
  retryReleaseReadinessScoring,
  verifyReleaseReadinessProjectionIntegrity,
} from '../../../core/release/release-readiness.service';
import { runFullSeasonLifecycleSimulator } from '../../../core/release/season-lifecycle-simulator';
import { ReleaseUpdateService } from '../../../core/release/release-update.service';
import { InviteBetaValidation } from '../invite-beta-validation/invite-beta-validation';
import { ScoringQueueControlCenter } from '../scoring-queue-control-center/scoring-queue-control-center';
import { FinalScoreReconciliation } from '../final-score-reconciliation/final-score-reconciliation';
import { AdminSessionStepUp } from '../../../shared/admin-session-step-up/admin-session-step-up';

@Component({
  selector: 'app-release-readiness',
  imports: [KeyValuePipe, RouterLink, InviteBetaValidation, ScoringQueueControlCenter, FinalScoreReconciliation, AdminSessionStepUp],
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
  readonly releaseDeployment = signal<ReleaseUpdateSnapshot | null>(null);
  readonly releaseReloadBlocked = computed(
    () => this.actionMonitor.activeCount() > 0 || this.releaseUpdate.reloadRequested(),
  );
  readonly validationReleaseKey = computed(
    () => this.releaseDeployment()?.bundled.buildId ?? this.runtime.releaseLabel,
  );
  readonly validationReleaseLabel = computed(
    () => this.releaseDeployment()?.bundled.releaseLabel ?? this.runtime.releaseLabel,
  );

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
    private readonly releaseUpdate: ReleaseUpdateService,
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
      this.targetProjectionCycle.set(
        Math.max(
          1,
          snapshot.projectionTargetCycleNumber ?? (snapshot.latestCycleNumber ?? 0) + 1,
        ),
      );
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

  async migrateLeagueAuthority(): Promise<void> {
    await this.runAction(async () => {
      const result = await migrateLeagueAuthoritySchema(this.leagueId);
      this.league.set(await getLeagueById(this.leagueId));

      return result.idempotentReplay
        ? 'League authority was already current. The canonical schema was verified again.'
        : `League authority migrated safely. ${result.memberCount} manager record(s), ${result.teamCount} team record(s), and all roster documents were verified. ${result.repairedRosterCount} missing roster(s) were repaired.`;
    });
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

  async verifyProjectionIntegrity(): Promise<void> {
    await this.runAction(async () =>
      verifyReleaseReadinessProjectionIntegrity(this.leagueId),
    );
  }

  async restorePreviousProjection(): Promise<void> {
    if (
      typeof window !== 'undefined' &&
      !window.confirm(
        'Restore the newest previous verified Projection V11 snapshot? This is allowed only before the Draft starts and requires Draft settings to be saved again.',
      )
    ) {
      return;
    }

    await this.runAction(async () =>
      restorePreviousReleaseReadinessProjection(this.leagueId),
    );
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
    this.releaseDeployment.set(this.releaseUpdate.getSnapshot());
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
        releaseDeployment: this.releaseUpdate.getSnapshot(),
      }, null, 2));
      this.actionMessage.set('This browser’s beta diagnostics were copied to the clipboard.');
      this.errorMessage.set('');
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to copy the beta diagnostics.',
      );
    }
  }


  async checkForReleaseUpdate(): Promise<void> {
    this.actionMessage.set('');
    this.errorMessage.set('');

    try {
      const updateAvailable = await this.releaseUpdate.checkForUpdate(true);
      this.releaseDeployment.set(this.releaseUpdate.getSnapshot());
      this.actionMessage.set(
        updateAvailable
          ? 'A different deployed build is available. Reload before another competitive action.'
          : 'This tab matches the currently deployed RinkRat build.',
      );
    } catch (error: unknown) {
      this.errorMessage.set(this.getErrorMessage(error));
    }
  }

  reloadForReleaseUpdate(): void {
    if (this.actionMonitor.activeCount() > 0) {
      this.errorMessage.set('Finish the active competitive action before reloading this tab.');
      return;
    }

    if (!this.releaseUpdate.requestReload()) {
      this.errorMessage.set('The release reload could not start. Refresh this page once manually.');
    }
  }

  formatBuildIdentifier(value: string): string {
    return value.length <= 28 ? value : `${value.slice(0, 18)}…${value.slice(-8)}`;
  }

  formatSourceRevision(value: string): string {
    if (value === 'unversioned') {
      return 'Local / unversioned';
    }

    return value.endsWith('-dirty')
      ? `${value.slice(0, 10)} · uncommitted`
      : value.slice(0, 12);
  }

  getDeploymentStatusLabel(snapshot: ReleaseUpdateSnapshot): string {
    if (snapshot.updateAvailable) {
      return snapshot.direction === 'rollback' ? 'Reload for deployed rollback' : 'Reload required';
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
        this.targetProjectionCycle.set(
          Math.max(
            1,
            snapshot.projectionTargetCycleNumber ?? (snapshot.latestCycleNumber ?? 0) + 1,
          ),
        );
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
