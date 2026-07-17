import { Component, computed, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { onAuthStateChanged } from 'firebase/auth';

import { getScoringRuntimeState } from '../../../core/cycle/cycle-runtime.config';
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
  imports: [RouterLink],
  templateUrl: './release-readiness.html',
  styleUrl: './release-readiness.css',
})
export class ReleaseReadiness {
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

  constructor(route: ActivatedRoute) {
    this.leagueId = route.snapshot.paramMap.get('leagueId') ?? '';
    void this.initialize();
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
