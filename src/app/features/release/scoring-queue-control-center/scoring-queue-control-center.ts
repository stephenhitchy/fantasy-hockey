import { FormsModule } from '@angular/forms';
import {
  Component,
  computed,
  Input,
  OnInit,
  signal,
} from '@angular/core';

import { BUNDLED_RELEASE_MANIFEST } from '../../../../environments/generated-release-manifest';
import {
  createScoringQueueRequestId,
  LeagueAutomationAdminLeague,
  LeagueAutomationQueueAdminSnapshot,
  LeagueAutomationQueueMode,
  ScoringQueueControlService,
} from '../../../core/admin/scoring-queue-control.service';
import {
  createSeasonLaunchScoringEvidenceReport,
} from '../../../core/release/season-launch-evidence.util';

@Component({
  selector: 'app-scoring-queue-control-center',
  imports: [FormsModule],
  templateUrl: './scoring-queue-control-center.html',
  styleUrl: './scoring-queue-control-center.css',
})
export class ScoringQueueControlCenter implements OnInit {
  @Input({ required: true }) currentLeagueId = '';

  readonly snapshot = signal<LeagueAutomationQueueAdminSnapshot | null>(null);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly errorMessage = signal('');
  readonly actionMessage = signal('');
  readonly searchText = signal('');
  readonly filter = signal<'all' | 'canary' | 'eligible' | 'internal' | 'attention'>('all');
  readonly selectedMode = signal<LeagueAutomationQueueMode>('shadow');
  readonly selectedCanaryLeagueIds = signal<string[]>([]);
  readonly selectedInternalTestLeagueIds = signal<string[]>([]);
  readonly selectedCanonicalAuthorityLeagueIds = signal<string[]>([]);
  readonly maxEnqueuePerRun = signal(100);
  readonly changeReason = signal('');
  readonly confirmationText = signal('');
  readonly shadowRollbackArmed = signal(false);
  readonly canaryRunArmedLeagueId = signal('');
  readonly canaryRunLeagueId = signal('');
  readonly copyingSeasonEvidence = signal(false);

  readonly filteredLeagues = computed(() => {
    const snapshot = this.snapshot();
    const query = this.searchText().trim().toLowerCase();
    const filter = this.filter();

    if (!snapshot) {
      return [];
    }

    return snapshot.leagues.filter((league) => {
      const matchesQuery = !query ||
        league.leagueName.toLowerCase().includes(query) ||
        league.leagueId.toLowerCase().includes(query);

      if (!matchesQuery) {
        return false;
      }

      switch (filter) {
        case 'canary':
          return this.selectedCanaryLeagueIds().includes(league.leagueId);
        case 'eligible':
          return league.canaryEligible;
        case 'internal':
          return this.selectedInternalTestLeagueIds().includes(league.leagueId);
        case 'attention':
          return Boolean(league.lastError) ||
            league.queueStatus === 'error' ||
            !league.scheduleExists ||
            league.historicalReplayEnabled ||
            league.canonicalAuthorityCircuitState === 'open';
        default:
          return true;
      }
    });
  });

  readonly hasChanges = computed(() => {
    const snapshot = this.snapshot();

    if (!snapshot) {
      return false;
    }

    return snapshot.mode !== this.selectedMode() ||
      snapshot.maxEnqueuePerRun !== this.maxEnqueuePerRun() ||
      !sameIds(snapshot.canaryLeagueIds, this.selectedCanaryLeagueIds()) ||
      !sameIds(snapshot.internalTestLeagueIds, this.selectedInternalTestLeagueIds()) ||
      !sameIds(
        snapshot.canonicalAuthorityLeagueIds,
        this.selectedCanonicalAuthorityLeagueIds(),
      );
  });

  readonly requiredConfirmationPhrase = computed(() => {
    const snapshot = this.snapshot();
    const mode = this.selectedMode();
    const enablingCanonicalAuthority = Boolean(
      snapshot &&
      this.selectedCanonicalAuthorityLeagueIds().some(
        (leagueId) =>
          !snapshot.canonicalAuthorityLeagueIds.includes(leagueId),
      )
    );

    if (mode === 'canary') {
      return enablingCanonicalAuthority
        ? snapshot?.canonicalAuthorityConfirmationPhrase ??
          'ENABLE CANONICAL READ CANARY'
        : 'ENABLE CANARY';
    }

    if (mode === 'primary') {
      return snapshot?.primaryConfirmationPhrase ?? 'ENABLE PRIMARY IN STAGING';
    }

    return '';
  });

  readonly canSave = computed(() => {
    const snapshot = this.snapshot();

    if (!snapshot || this.busy() || !this.hasChanges()) {
      return false;
    }

    if (this.changeReason().trim().length < 8) {
      return false;
    }

    if (this.selectedMode() === 'canary') {
      const canaryLeagueIds = this.selectedCanaryLeagueIds();
      const internalTestLeagueIds = this.selectedInternalTestLeagueIds();
      const maxCanaryLeagueCount =
        snapshot.health.queueNearLiveCanaryMaxLeagueCount ?? 4;

      if (
        canaryLeagueIds.length === 0 ||
        canaryLeagueIds.length > maxCanaryLeagueCount ||
        canaryLeagueIds.some((leagueId) => !internalTestLeagueIds.includes(leagueId))
      ) {
        return false;
      }

      const canonicalAuthorityLeagueIds =
        this.selectedCanonicalAuthorityLeagueIds();
      const maximumCanonicalAuthorityLeagueCount =
        snapshot.canonicalAuthorityMaximumLeagueCount ?? 1;

      if (
        canonicalAuthorityLeagueIds.length >
          maximumCanonicalAuthorityLeagueCount ||
        canonicalAuthorityLeagueIds.some(
          (leagueId) =>
            !canaryLeagueIds.includes(leagueId) ||
            !internalTestLeagueIds.includes(leagueId),
        )
      ) {
        return false;
      }
    }

    if (
      this.selectedMode() !== 'canary' &&
      this.selectedCanonicalAuthorityLeagueIds().length > 0
    ) {
      return false;
    }

    if (
      this.selectedMode() === 'primary' &&
      !snapshot.primaryPromotionAllowed
    ) {
      return false;
    }

    const phrase = this.requiredConfirmationPhrase();
    return !phrase || this.confirmationText().trim() === phrase;
  });

  constructor(
    private readonly queueControl: ScoringQueueControlService,
  ) {}

  ngOnInit(): void {
    void this.refresh();
  }

  async refresh(preserveMessage = false): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set('');

    if (!preserveMessage) {
      this.actionMessage.set('');
    }

    try {
      const snapshot = await this.queueControl.load(this.currentLeagueId);
      this.applySnapshot(snapshot);
    } catch (error: unknown) {
      this.errorMessage.set(getErrorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  selectMode(mode: LeagueAutomationQueueMode): void {
    const snapshot = this.snapshot();

    if (mode === 'primary' && snapshot && !snapshot.primaryPromotionAllowed) {
      return;
    }

    this.selectedMode.set(mode);

    if (mode !== 'canary') {
      this.selectedCanonicalAuthorityLeagueIds.set([]);
    }

    this.confirmationText.set('');
    this.shadowRollbackArmed.set(false);
  }

  toggleCanary(league: LeagueAutomationAdminLeague): void {
    if (!league.canaryEligible || this.busy()) {
      return;
    }

    const selectingCanary = !this.isSelectedCanary(league.leagueId);
    const maxCanaryLeagueCount =
      this.snapshot()?.health.queueNearLiveCanaryMaxLeagueCount ?? 4;

    if (
      selectingCanary &&
      this.selectedCanaryLeagueIds().length >= maxCanaryLeagueCount
    ) {
      this.errorMessage.set(
        `Near-live Canary is limited to ${maxCanaryLeagueCount} Internal Test leagues during this measured rollout.`,
      );
      return;
    }

    this.errorMessage.set('');
    this.selectedCanaryLeagueIds.update((current) =>
      toggleId(current, league.leagueId),
    );

    if (!selectingCanary && this.isSelectedCanonicalAuthority(league.leagueId)) {
      this.selectedCanonicalAuthorityLeagueIds.set([]);
    }

    if (selectingCanary && !this.isSelectedInternalTest(league.leagueId)) {
      this.selectedInternalTestLeagueIds.update((current) =>
        normalizeIds([...current, league.leagueId]),
      );
    }

    this.canaryRunArmedLeagueId.set('');
  }

  toggleInternalTest(leagueId: string): void {
    if (this.busy()) {
      return;
    }

    const removingInternalTest = this.isSelectedInternalTest(leagueId);

    this.selectedInternalTestLeagueIds.update((current) =>
      toggleId(current, leagueId),
    );

    if (removingInternalTest && this.isSelectedCanary(leagueId)) {
      this.selectedCanaryLeagueIds.update((current) =>
        current.filter((candidate) => candidate !== leagueId),
      );
      this.canaryRunArmedLeagueId.set('');
    }

    if (
      removingInternalTest &&
      this.isSelectedCanonicalAuthority(leagueId)
    ) {
      this.selectedCanonicalAuthorityLeagueIds.set([]);
    }
  }

  isSelectedCanary(leagueId: string): boolean {
    return this.selectedCanaryLeagueIds().includes(leagueId);
  }

  isSelectedInternalTest(leagueId: string): boolean {
    return this.selectedInternalTestLeagueIds().includes(leagueId);
  }

  isSelectedCanonicalAuthority(leagueId: string): boolean {
    return this.selectedCanonicalAuthorityLeagueIds().includes(leagueId);
  }

  toggleCanonicalAuthority(league: LeagueAutomationAdminLeague): void {
    if (this.busy()) {
      return;
    }

    if (this.isSelectedCanonicalAuthority(league.leagueId)) {
      this.selectedCanonicalAuthorityLeagueIds.set([]);
      this.confirmationText.set('');
      return;
    }

    if (!league.canonicalAuthorityEligible) {
      this.errorMessage.set(league.canonicalAuthorityEligibilityReason);
      return;
    }

    this.errorMessage.set('');
    this.selectedCanonicalAuthorityLeagueIds.set([league.leagueId]);
    this.confirmationText.set('');
  }

  async saveConfiguration(): Promise<void> {
    const snapshot = this.snapshot();

    if (!snapshot || !this.canSave()) {
      return;
    }

    this.busy.set(true);
    this.errorMessage.set('');
    this.actionMessage.set('Saving the scoring queue configuration…');

    try {
      const result = await this.queueControl.updateConfiguration({
        requestId: createScoringQueueRequestId('config'),
        expectedRevision: snapshot.revision,
        mode: this.selectedMode(),
        canaryLeagueIds: normalizeIds(this.selectedCanaryLeagueIds()),
        internalTestLeagueIds: normalizeIds(this.selectedInternalTestLeagueIds()),
        canonicalAuthorityLeagueIds: normalizeIds(
          this.selectedCanonicalAuthorityLeagueIds(),
        ),
        maxEnqueuePerRun: this.maxEnqueuePerRun(),
        confirmationText: this.confirmationText().trim(),
        changeReason: this.changeReason().trim(),
      });
      this.actionMessage.set(result.message);
      this.confirmationText.set('');
      this.changeReason.set('');
      await this.refresh(true);
    } catch (error: unknown) {
      this.errorMessage.set(getErrorMessage(error));
      this.actionMessage.set('');
    } finally {
      this.busy.set(false);
    }
  }

  armShadowRollback(): void {
    if (this.busy()) {
      return;
    }

    if (!this.shadowRollbackArmed()) {
      this.shadowRollbackArmed.set(true);
      this.actionMessage.set(
        'Shadow rollback is armed. Press the confirmation button once more to return every live league to the legacy scorer.',
      );
      return;
    }

    void this.returnToShadow();
  }

  cancelShadowRollback(): void {
    this.shadowRollbackArmed.set(false);
    this.actionMessage.set('Shadow rollback cancelled.');
  }

  async returnToShadow(): Promise<void> {
    const snapshot = this.snapshot();

    if (!snapshot || snapshot.mode === 'shadow' || this.busy()) {
      return;
    }

    this.busy.set(true);
    this.errorMessage.set('');

    try {
      const result = await this.queueControl.updateConfiguration({
        requestId: createScoringQueueRequestId('rollback'),
        expectedRevision: snapshot.revision,
        mode: 'shadow',
        canaryLeagueIds: normalizeIds(snapshot.canaryLeagueIds),
        internalTestLeagueIds: normalizeIds(snapshot.internalTestLeagueIds),
        canonicalAuthorityLeagueIds: [],
        maxEnqueuePerRun: snapshot.maxEnqueuePerRun,
        confirmationText: '',
        changeReason: 'Safe rollback to shadow mode from the platform-admin control center.',
      });
      this.actionMessage.set(result.message);
      this.shadowRollbackArmed.set(false);
      await this.refresh(true);
    } catch (error: unknown) {
      this.errorMessage.set(getErrorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }

  armCanaryRun(leagueId: string): void {
    if (this.busy()) {
      return;
    }

    if (this.canaryRunArmedLeagueId() === leagueId) {
      void this.runCanaryNow(leagueId);
      return;
    }

    this.canaryRunArmedLeagueId.set(leagueId);
    this.actionMessage.set(
      'The canary run is armed. Press Confirm Live Scoring Run to enqueue one real scoring pass for this test league.',
    );
  }

  cancelCanaryRun(): void {
    this.canaryRunArmedLeagueId.set('');
    this.actionMessage.set('Manual canary run cancelled.');
  }

  async runCanaryNow(leagueId: string): Promise<void> {
    if (this.busy()) {
      return;
    }

    this.busy.set(true);
    this.canaryRunLeagueId.set(leagueId);
    this.errorMessage.set('');
    this.actionMessage.set('Queueing one exact canary scoring pass…');

    try {
      const result = await this.queueControl.queueCanaryCheck(leagueId);
      this.actionMessage.set(result.message);
      this.canaryRunArmedLeagueId.set('');
      await this.refresh(true);
    } catch (error: unknown) {
      this.errorMessage.set(getErrorMessage(error));
      this.actionMessage.set('');
    } finally {
      this.canaryRunLeagueId.set('');
      this.busy.set(false);
    }
  }

  async copySeasonLaunchEvidence(): Promise<void> {
    const snapshot = this.snapshot();

    if (!snapshot || this.copyingSeasonEvidence()) {
      return;
    }

    if (
      typeof navigator === 'undefined' ||
      !navigator.clipboard?.writeText
    ) {
      this.errorMessage.set('Clipboard access is unavailable in this browser.');
      return;
    }

    this.copyingSeasonEvidence.set(true);
    this.errorMessage.set('');

    const report = createSeasonLaunchScoringEvidenceReport({
      snapshot,
      build: BUNDLED_RELEASE_MANIFEST,
      expectedProjectId: 'nhl-fantasy-app-ab673',
    });

    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      this.actionMessage.set(
        report.gate.readyForFreeze
          ? 'Season-launch scoring evidence copied. The scoring gate is ready for the exact-release freeze.'
          : `Season-launch scoring evidence copied with ${report.gate.blockers.length} freeze blocker(s).`,
      );
    } catch (error: unknown) {
      this.errorMessage.set(getErrorMessage(error));
      this.actionMessage.set('');
    } finally {
      this.copyingSeasonEvidence.set(false);
    }
  }

  async copyRollbackConfiguration(): Promise<void> {
    const snapshot = this.snapshot();

    if (!snapshot || !navigator.clipboard?.writeText) {
      this.errorMessage.set('Clipboard access is unavailable in this browser.');
      return;
    }

    const rollback = {
      generatedAt: new Date().toISOString(),
      projectId: snapshot.projectId,
      revision: snapshot.revision,
      mode: snapshot.mode,
      canaryLeagueIds: snapshot.canaryLeagueIds,
      internalTestLeagueIds: snapshot.internalTestLeagueIds,
      canonicalAuthorityLeagueIds: snapshot.canonicalAuthorityLeagueIds,
      maxEnqueuePerRun: snapshot.maxEnqueuePerRun,
      canarySuccessBaseline: snapshot.canarySuccessBaseline,
      successfulTasksSinceCanary: snapshot.successfulTasksSinceCanary,
    };

    try {
      await navigator.clipboard.writeText(JSON.stringify(rollback, null, 2));
      this.actionMessage.set('The current rollback configuration was copied.');
      this.errorMessage.set('');
    } catch (error: unknown) {
      this.errorMessage.set(getErrorMessage(error));
    }
  }

  async copyLeagueId(leagueId: string): Promise<void> {
    if (!navigator.clipboard?.writeText) {
      this.errorMessage.set('Clipboard access is unavailable in this browser.');
      return;
    }

    try {
      await navigator.clipboard.writeText(leagueId);
      this.actionMessage.set('League ID copied.');
      this.errorMessage.set('');
    } catch (error: unknown) {
      this.errorMessage.set(getErrorMessage(error));
    }
  }

  setSearchText(value: string): void {
    this.searchText.set(value);
  }

  setFilter(value: string): void {
    if (
      value === 'canary' ||
      value === 'eligible' ||
      value === 'internal' ||
      value === 'attention'
    ) {
      this.filter.set(value);
      return;
    }

    this.filter.set('all');
  }

  setMaxEnqueuePerRun(value: string | number): void {
    const parsed = Number(value);
    this.maxEnqueuePerRun.set(
      Number.isFinite(parsed)
        ? Math.min(300, Math.max(1, Math.trunc(parsed)))
        : 100,
    );
  }

  getModeLabel(mode: LeagueAutomationQueueMode): string {
    switch (mode) {
      case 'canary':
        return 'Canary';
      case 'primary':
        return 'Primary';
      default:
        return 'Shadow';
    }
  }

  getModeDescription(mode: LeagueAutomationQueueMode): string {
    switch (mode) {
      case 'canary':
        return 'Only exact allowlisted Internal Test leagues use queued scoring. During live NHL games, those controlled canaries target a healthy two-minute refresh cadence while every other live league remains on the legacy scorer.';
      case 'primary':
        return 'Every eligible live league uses queued per-league scoring. The legacy sweep remains available only for recovery.';
      default:
        return 'The queued system observes schedules and health without scoring any live league. The legacy scorer remains primary.';
    }
  }

  getSeasonSafetyLabel(
    status: LeagueAutomationQueueAdminSnapshot['seasonSafetyStatus'],
  ): string {
    switch (status) {
      case 'ready':
        return 'Ready for controlled season use';
      case 'attention':
        return 'Needs attention';
      case 'blocked':
        return 'Blocked — use direct fallback or Shadow';
      default:
        return 'Observing';
    }
  }

  getSeasonSafetyClass(
    status: LeagueAutomationQueueAdminSnapshot['seasonSafetyStatus'],
  ): string {
    return `season-safety-${status}`;
  }

  getWatchdogLabel(
    status: LeagueAutomationQueueAdminSnapshot['seasonSafetyWatchdog']['status'],
  ): string {
    switch (status) {
      case 'healthy':
        return 'Healthy and armed';
      case 'warning':
        return 'Confirming a warning';
      case 'error':
        return 'Watchdog check failed';
      case 'canonical-fallback':
        return 'Canonical authority disabled';
      case 'shadow-fallback':
        return 'Returned to Shadow';
      case 'observing':
        return 'Observing in Shadow';
      default:
        return 'Awaiting first heartbeat';
    }
  }

  getWatchdogClass(
    status: LeagueAutomationQueueAdminSnapshot['seasonSafetyWatchdog']['status'],
  ): string {
    return `watchdog-status-${status}`;
  }

  getCapacityEvidenceLabel(
    level: LeagueAutomationQueueAdminSnapshot['capacityEvidence']['evidenceLevel'],
  ): string {
    switch (level) {
      case 'representative':
        return 'Representative live evidence';
      case 'preliminary':
        return 'Preliminary live evidence';
      default:
        return 'Not enough live evidence';
    }
  }

  formatHeadroomRatio(value: number): string {
    return Number.isFinite(value)
      ? `${Math.round(value * 100)}%`
      : 'Not recorded';
  }

  formatPercentage(value: number, sampleCount: number): string {
    return Number.isFinite(value) && sampleCount > 0
      ? `${(value * 100).toFixed(1)}%`
      : 'Not recorded';
  }

  getEnvironmentLabel(environment: LeagueAutomationQueueAdminSnapshot['environment']): string {
    switch (environment) {
      case 'production':
        return 'Production';
      case 'staging':
        return 'Staging';
      case 'emulator':
        return 'Local Emulator';
      default:
        return 'Unknown Environment';
    }
  }

  isNearLiveCanary(league: LeagueAutomationAdminLeague): boolean {
    const snapshot = this.snapshot();
    const maxCanaryLeagueCount =
      snapshot?.health.queueNearLiveCanaryMaxLeagueCount ?? 4;

    return Boolean(
      snapshot &&
      snapshot.mode === 'canary' &&
      snapshot.canaryLeagueIds.length > 0 &&
      snapshot.canaryLeagueIds.length <= maxCanaryLeagueCount &&
      league.scoringPath === 'queued-canary' &&
      league.isCanary &&
      league.isInternalTest
    );
  }

  getScoringPathLabel(league: LeagueAutomationAdminLeague): string {
    switch (league.scoringPath) {
      case 'queued-canary':
        return this.isNearLiveCanary(league) ? 'Near-Live Canary' : 'Queued Canary';
      case 'queued-primary':
        return 'Queued Primary';
      case 'historical-replay':
        return 'Historical Replay';
      case 'draft-incomplete':
        return 'Draft Not Complete';
      case 'paused':
        return 'Live Scoring Paused';
      default:
        return 'Legacy Scorer';
    }
  }

  getScoringCadenceLabel(league: LeagueAutomationAdminLeague): string {
    if (this.isNearLiveCanary(league)) {
      return '2-minute live target';
    }

    if (
      league.lastRefreshCadence === 'near-live-canary' &&
      league.isInternalTest
    ) {
      return 'Near-live Canary';
    }

    return 'Standard';
  }

  getScoringPathClass(league: LeagueAutomationAdminLeague): string {
    return `queue-path-${league.scoringPath}`;
  }

  getAuditActionLabel(action: string): string {
    switch (action) {
      case 'queue-promoted-to-canary':
        return 'Promoted to Canary';
      case 'queue-promoted-to-primary':
        return 'Promoted to Primary';
      case 'queue-returned-to-shadow':
        return 'Returned to Shadow';
      case 'queue-selection-updated':
        return 'League Selection Updated';
      case 'manual-canary-run-requested':
        return 'Manual Canary Run';
      case 'canonical-authority-canary-enabled':
        return 'Canonical Read Canary Enabled';
      case 'canonical-authority-canary-disabled':
        return 'Canonical Read Canary Disabled';
      case 'canonical-authority-circuit-opened':
        return 'Canonical Circuit Breaker Opened';
      case 'season-watchdog-canonical-fallback':
        return 'Season Watchdog Disabled Canonical Authority';
      case 'season-watchdog-returned-to-shadow':
        return 'Season Watchdog Returned to Shadow';
      case 'configuration-no-change':
        return 'Configuration Rechecked';
      default:
        return action
          .split('-')
          .filter(Boolean)
          .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
          .join(' ');
    }
  }

  formatTimestamp(value: string | null): string {
    if (!value) {
      return 'Not recorded';
    }

    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? date.toLocaleString([], {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : 'Not recorded';
  }

  formatDuration(value: number | null | undefined): string {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return 'Not recorded';
    }

    if (value < 1_000) {
      return `${Math.round(value)} ms`;
    }

    if (value < 60_000) {
      return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} sec`;
    }

    return `${(value / 60_000).toFixed(1)} min`;
  }

  private applySnapshot(snapshot: LeagueAutomationQueueAdminSnapshot): void {
    this.snapshot.set(snapshot);
    this.selectedMode.set(snapshot.mode);
    this.selectedCanaryLeagueIds.set(normalizeIds(snapshot.canaryLeagueIds));
    this.selectedInternalTestLeagueIds.set(
      normalizeIds(snapshot.internalTestLeagueIds),
    );
    this.selectedCanonicalAuthorityLeagueIds.set(
      normalizeIds(snapshot.canonicalAuthorityLeagueIds),
    );
    this.maxEnqueuePerRun.set(snapshot.maxEnqueuePerRun);
    this.confirmationText.set('');
    this.shadowRollbackArmed.set(false);
    this.canaryRunArmedLeagueId.set('');
  }
}

function normalizeIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].sort();
}

function sameIds(left: string[], right: string[]): boolean {
  return JSON.stringify(normalizeIds(left)) === JSON.stringify(normalizeIds(right));
}

function toggleId(ids: string[], id: string): string[] {
  const next = new Set(ids);

  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }

  return [...next].sort();
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

  return 'The scoring queue control could not complete that request.';
}
