import { Component, computed, OnDestroy, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { onAuthStateChanged } from 'firebase/auth';

import { auth } from '../../../core/firebase';
import { areDeveloperToolsEnabled } from '../../../core/cycle/cycle-runtime.config';
import { getLeagueById, League } from '../../../core/league/league.service';
import {
  getLeagueLiveScoringSessionInfo,
  listenToSharedCycleScoring,
  listenToSharedLiveScoringControl,
  releaseLeagueLiveScoringLeaseForHandoff,
  requestLeagueLiveScoringRefresh,
  resumeLeagueLiveScoringSession,
} from '../../../core/live-scoring/live-scoring.service';
import {
  LiveScoringSimulationResult,
  SharedCycleScoringSnapshot,
  SharedLiveScoringControl,
} from '../../../core/live-scoring/live-scoring.models';
import { runLiveScoringDeterministicSimulator } from '../../../core/live-scoring/live-scoring-simulator';

import {
  runWindowProjectionDeterministicSimulator,
  WindowProjectionSimulationResult,
} from '../../../core/projection/window-projection-simulator';

@Component({
  selector: 'app-live-scoring-diagnostics',
  imports: [RouterLink],
  templateUrl: './live-scoring-diagnostics.html',
  styleUrl: './live-scoring-diagnostics.css',
})
export class LiveScoringDiagnostics implements OnDestroy {
  readonly developerToolsEnabled = areDeveloperToolsEnabled();
  readonly leagueId: string;
  readonly league = signal<League | null>(null);
  readonly loading = signal(true);
  readonly authorized = signal(false);
  readonly control = signal<SharedLiveScoringControl | null>(null);
  readonly snapshots = signal<Record<number, SharedCycleScoringSnapshot | null>>({});
  readonly simulatorResult = signal<LiveScoringSimulationResult | null>(null);
  readonly windowProjectionSimulatorResult = signal<WindowProjectionSimulationResult | null>(null);
  readonly actionInProgress = signal(false);
  readonly actionMessage = signal('');
  readonly errorMessage = signal('');
  readonly now = signal(Date.now());

  private stopControlListener: (() => void) | null = null;
  private readonly snapshotListeners = new Map<number, () => void>();
  private readonly timer = setInterval(() => this.now.set(Date.now()), 1000);

  readonly activeSnapshots = computed(() =>
    Object.entries(this.snapshots())
      .map(([cycleNumber, snapshot]) => ({
        cycleNumber: Number(cycleNumber),
        snapshot,
      }))
      .sort((first, second) => first.cycleNumber - second.cycleNumber),
  );

  readonly sessionInfo = computed(() => {
    this.now();
    return getLeagueLiveScoringSessionInfo(this.leagueId);
  });

  readonly isLeaseHolder = computed(() => {
    const control = this.control();
    const session = this.sessionInfo();
    const leaseExpiresAt = this.toMillis(control?.leaseExpiresAt);

    return Boolean(
      control?.holderClientId &&
      control.holderClientId === session.clientId &&
      leaseExpiresAt &&
      leaseExpiresAt > this.now(),
    );
  });

  readonly isPaused = computed(() => {
    const pausedUntil = this.sessionInfo().pausedUntilMs;
    return Boolean(pausedUntil && pausedUntil > this.now());
  });

  constructor(route: ActivatedRoute) {
    this.leagueId = route.snapshot.paramMap.get('leagueId') ?? '';
    void this.initialize();
  }

  ngOnDestroy(): void {
    clearInterval(this.timer);
    this.stopControlListener?.();
    this.snapshotListeners.forEach((stop) => stop());
    this.snapshotListeners.clear();
  }

  async requestRefresh(): Promise<void> {
    this.actionInProgress.set(true);
    this.actionMessage.set('');
    this.errorMessage.set('');

    try {
      await requestLeagueLiveScoringRefresh(this.leagueId);
      this.actionMessage.set(
        'Refresh requested. The worker will publish only if scoring data changed.',
      );
    } catch (error: unknown) {
      this.errorMessage.set(this.getErrorMessage(error));
    } finally {
      this.actionInProgress.set(false);
    }
  }

  async releaseForHandoff(): Promise<void> {
    this.actionInProgress.set(true);
    this.actionMessage.set('');
    this.errorMessage.set('');

    try {
      await releaseLeagueLiveScoringLeaseForHandoff(this.leagueId);
      this.actionMessage.set(
        'This tab released the lease and paused for 20 minutes. Open or refresh another commissioner tab to verify takeover.',
      );
    } catch (error: unknown) {
      this.errorMessage.set(this.getErrorMessage(error));
    } finally {
      this.actionInProgress.set(false);
    }
  }

  resumeThisTab(): void {
    resumeLeagueLiveScoringSession(this.leagueId);
    this.actionMessage.set(
      'This tab resumed and will compete for the next available scoring lease.',
    );
    this.errorMessage.set('');
    this.now.set(Date.now());
  }

  runSimulator(): void {
    this.simulatorResult.set(runLiveScoringDeterministicSimulator());
  }

  runWindowProjectionSimulator(): void {
    this.windowProjectionSimulatorResult.set(runWindowProjectionDeterministicSimulator());
  }

  getStatusLabel(): string {
    const control = this.control();

    if (!control) {
      return 'Not initialized';
    }

    if (control.status === 'error') {
      return 'Needs attention';
    }

    if (control.status === 'refreshing') {
      return 'Refreshing now';
    }

    if (this.isLeaseHolder()) {
      return 'This tab holds the lease';
    }

    if (control.holderClientId && this.isLeaseActive()) {
      return 'Another tab holds the lease';
    }

    return 'Ready for a worker';
  }

  getStatusDescription(): string {
    const control = this.control();

    if (!control) {
      return 'The control document will be created when the commissioner worker performs its first refresh.';
    }

    if (control.lastError) {
      return control.lastError;
    }

    if (this.isPaused()) {
      return 'This tab is intentionally paused so another commissioner tab can take over.';
    }

    if (this.isLeaseHolder()) {
      return 'Only this browser tab should request NHL data until the lease is released or expires.';
    }

    if (control.holderClientId && this.isLeaseActive()) {
      return 'This tab is listening to the shared results and will not duplicate the active worker.';
    }

    return 'No active lease is blocking the next eligible commissioner refresh.';
  }

  getRefreshReasonLabel(): string {
    const reason = this.control()?.lastRefreshReason ?? 'unknown';

    switch (reason) {
      case 'startup':
        return 'League page startup';
      case 'scheduled':
        return 'Scheduled cadence';
      case 'manual':
        return 'Commissioner request';
      case 'handoff':
        return 'Lease handoff';
      default:
        return 'Not recorded';
    }
  }

  formatTimestamp(value: unknown): string {
    const milliseconds = this.toMillis(value);

    if (!milliseconds) {
      return 'Not yet';
    }

    return new Date(milliseconds).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  formatDuration(milliseconds: number): string {
    if (!milliseconds) {
      return 'Not recorded';
    }

    if (milliseconds < 1000) {
      return `${milliseconds} ms`;
    }

    return `${(milliseconds / 1000).toFixed(1)} sec`;
  }

  formatCountdown(value: unknown): string {
    const milliseconds = this.toMillis(value);

    if (!milliseconds) {
      return 'Available now';
    }

    const remaining = milliseconds - this.now();

    if (remaining <= 0) {
      return 'Available now';
    }

    const totalSeconds = Math.ceil(remaining / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    return minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, '0')}s` : `${seconds}s`;
  }

  getSnapshotState(snapshot: SharedCycleScoringSnapshot | null): string {
    if (!snapshot) {
      return 'Waiting for first shared snapshot';
    }

    if (snapshot.result.hasLiveGames) {
      return 'Live NHL game detected';
    }

    const completionValues = Object.values(snapshot.result.teamCycleComplete);

    if (completionValues.length > 0 && completionValues.every(Boolean)) {
      return 'All team windows complete';
    }

    return 'Tracking scheduled and final games';
  }

  getSnapshotTeamCount(snapshot: SharedCycleScoringSnapshot | null): number {
    return snapshot ? Object.keys(snapshot.result.teamScores).length : 0;
  }

  getSnapshotCompletedTeamCount(snapshot: SharedCycleScoringSnapshot | null): number {
    return snapshot ? Object.values(snapshot.result.teamCycleComplete).filter(Boolean).length : 0;
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
    this.loading.set(false);

    if (!this.authorized()) {
      return;
    }

    this.stopControlListener = listenToSharedLiveScoringControl(
      this.leagueId,
      (control) => {
        this.control.set(control);
        this.syncSnapshotListeners(control?.activeCycleNumbers ?? []);
      },
      (error) => this.errorMessage.set(error.message),
    );
  }

  private syncSnapshotListeners(cycleNumbers: number[]): void {
    const expected = new Set(cycleNumbers);

    for (const [cycleNumber, stop] of this.snapshotListeners.entries()) {
      if (!expected.has(cycleNumber)) {
        stop();
        this.snapshotListeners.delete(cycleNumber);
        this.snapshots.update((current) => {
          const next = { ...current };
          delete next[cycleNumber];
          return next;
        });
      }
    }

    for (const cycleNumber of expected) {
      if (this.snapshotListeners.has(cycleNumber)) {
        continue;
      }

      const stop = listenToSharedCycleScoring(
        this.leagueId,
        cycleNumber,
        (snapshot) => {
          this.snapshots.update((current) => ({
            ...current,
            [cycleNumber]: snapshot,
          }));
        },
        (error) => this.errorMessage.set(error.message),
      );

      this.snapshotListeners.set(cycleNumber, stop);
    }
  }

  private isLeaseActive(): boolean {
    const leaseExpiresAt = this.toMillis(this.control()?.leaseExpiresAt);
    return Boolean(leaseExpiresAt && leaseExpiresAt > this.now());
  }

  private toMillis(value: unknown): number | null {
    if (
      value &&
      typeof value === 'object' &&
      'toMillis' in value &&
      typeof (value as { toMillis?: unknown }).toMillis === 'function'
    ) {
      return (value as { toMillis: () => number }).toMillis();
    }

    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error
      ? error.message
      : 'Unable to complete the scoring diagnostic action.';
  }
}
