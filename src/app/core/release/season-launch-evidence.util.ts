import type { ReleaseManifest } from './release-manifest.models';

export const SEASON_LAUNCH_SCORING_EVIDENCE_SCHEMA_VERSION = 1;
export const SEASON_LAUNCH_SCORING_EVIDENCE_REPORT_TYPE =
  'rinkrat-season-launch-scoring-evidence';
export const SEASON_LAUNCH_EVIDENCE_HEARTBEAT_MAX_AGE_MILLISECONDS =
  5 * 60 * 1000;


export interface SeasonLaunchSafetyAlert {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  label: string;
  detail: string;
}

export interface SeasonLaunchScoringSnapshot {
  generatedAt: string;
  projectId: string;
  environment: string;
  production: boolean;
  mode: string;
  canaryLeagueIds: string[];
  internalTestLeagueIds: string[];
  canonicalAuthorityLeagueIds: string[];
  revision: number;
  updatedAt: string | null;
  maxEnqueuePerRun: number;
  successfulTasksSinceCanary: number;
  seasonSafetyStatus: string;
  seasonSafetyAlerts: SeasonLaunchSafetyAlert[];
  seasonSafetyWatchdog: {
    status: string;
    lastAttemptAt: string | null;
    lastSuccessfulAt: string | null;
    queueBlockingStreak: number;
    canonicalBlockingStreak: number;
    requiredBlockingStreak: number;
    lastAction: string;
    lastActionAt: string | null;
    lastActionReason: string;
    automaticShadowFallbackCount: number;
    automaticCanonicalFallbackCount: number;
    consecutiveFailureCount: number;
    lastError: string;
  };
  capacityEvidence: {
    status: string;
    evidenceLevel: string;
    queueTaskSampleCount: number;
    queueTaskSuccessCount: number;
    queueTaskErrorCount: number;
    queueTaskReliabilityRate: number;
    sampledDayCount: number;
    p95DurationMilliseconds: number;
    maximumDurationMilliseconds: number;
    workerCount: number;
    safeAffectedLeagueCapacity: number;
    primaryCapacityReady: boolean;
    lastRefreshedAt: string | null;
    consecutiveFailureCount: number;
    lastError: string;
  };
  health: {
    queueLastDispatchAt?: string | null;
    queueLastDispatchStatus?: string;
    queueScheduleCoverageCount?: number;
    queueScheduleCoverageCompletedDraftCount?: number;
    queueActivePendingTaskCount?: number;
    queueTaskMaxPendingTasks?: number;
    queueFailedEnqueueCount?: number;
    queueLastRecoveryCount?: number;
    queueOldestDueAgeMilliseconds?: number | null;
    queueOldestObservedDueAgeMilliseconds?: number | null;
    canonicalParityCohortPassing?: boolean;
    canonicalParityMismatchLeagueCount?: number;
    canonicalParityIncompleteLeagueCount?: number;
    canonicalParityMissingLeagueCount?: number;
    canonicalParityStaleLeagueCount?: number;
  };
}

export interface SeasonLaunchEvidenceGate {
  status: 'ready' | 'blocked';
  readyForFreeze: boolean;
  blockers: string[];
  advisories: string[];
}

export interface SeasonLaunchScoringEvidenceReport {
  schemaVersion: 1;
  reportType: typeof SEASON_LAUNCH_SCORING_EVIDENCE_REPORT_TYPE;
  generatedAt: string;
  build: ReleaseManifest;
  gate: SeasonLaunchEvidenceGate;
  queue: {
    projectId: string;
    environment: string;
    production: boolean;
    mode: string;
    revision: number;
    updatedAt: string | null;
    canaryLeagueIds: string[];
    internalTestLeagueIds: string[];
    canonicalAuthorityLeagueIds: string[];
    maxEnqueuePerRun: number;
    successfulTasksSinceCanary: number;
  };
  health: {
    dispatcherStatus: string;
    dispatcherAt: string | null;
    scheduleCoverageCount: number;
    completedDraftLeagueCount: number;
    activePendingTaskCount: number;
    maximumPendingTaskCount: number;
    failedEnqueueCount: number;
    staleRecoveryCount: number;
    oldestDueAgeMilliseconds: number | null;
    oldestObservedDueAgeMilliseconds: number | null;
    canonicalParityCohortPassing: boolean;
    canonicalParityMismatchLeagueCount: number;
    canonicalParityIncompleteLeagueCount: number;
    canonicalParityMissingLeagueCount: number;
    canonicalParityStaleLeagueCount: number;
  };
  seasonSafety: {
    status: string;
    alerts: SeasonLaunchSafetyAlert[];
  };
  watchdog: SeasonLaunchScoringSnapshot['seasonSafetyWatchdog'];
  capacity: SeasonLaunchScoringSnapshot['capacityEvidence'];
}

function normalizedIds(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function finiteInteger(value: number | null | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value ?? 0)) : 0;
}

function validIso(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function heartbeatFresh(
  value: string | null | undefined,
  generatedAtMilliseconds: number,
): boolean {
  const heartbeat = validIso(value);
  return heartbeat !== null &&
    heartbeat <= generatedAtMilliseconds + 5_000 &&
    generatedAtMilliseconds - heartbeat <=
      SEASON_LAUNCH_EVIDENCE_HEARTBEAT_MAX_AGE_MILLISECONDS;
}

function hasCriticalAlert(alerts: readonly SeasonLaunchSafetyAlert[]): boolean {
  return alerts.some((alert) => alert.severity === 'critical');
}

export function buildSeasonLaunchEvidenceGate(input: {
  snapshot: SeasonLaunchScoringSnapshot;
  build: ReleaseManifest;
  generatedAt: string;
  expectedProjectId?: string;
}): SeasonLaunchEvidenceGate {
  const { snapshot, build } = input;
  const generatedAtMilliseconds = Date.parse(input.generatedAt);
  const blockers: string[] = [];
  const advisories: string[] = [];
  const health = snapshot.health;
  const watchdog = snapshot.seasonSafetyWatchdog;
  const capacity = snapshot.capacityEvidence;
  const completedDraftLeagueCount = finiteInteger(
    health.queueScheduleCoverageCompletedDraftCount,
  );
  const scheduleCoverageCount = finiteInteger(
    health.queueScheduleCoverageCount,
  );

  if (!Number.isFinite(generatedAtMilliseconds)) {
    blockers.push('The scoring evidence does not contain a valid generated time.');
  }

  if (!/^[0-9a-f]{40}$/i.test(build.sourceRevision)) {
    blockers.push('The bundled release does not contain one clean 40-character source revision.');
  }

  if (snapshot.production !== true || snapshot.environment !== 'production') {
    blockers.push('The scoring evidence was not generated from the production environment.');
  }

  if (input.expectedProjectId && snapshot.projectId !== input.expectedProjectId) {
    blockers.push(`Expected Firebase project ${input.expectedProjectId}, but the evidence reports ${snapshot.projectId || 'unknown'}.`);
  }

  if (snapshot.mode !== 'shadow') {
    blockers.push('Freeze the season baseline while queued scoring is in Shadow. Canary can be enabled after the exact release is frozen.');
  }

  if (snapshot.canonicalAuthorityLeagueIds.length > 0) {
    blockers.push('Canonical scoring authority must be disabled while the exact season baseline is frozen.');
  }

  if (hasCriticalAlert(snapshot.seasonSafetyAlerts)) {
    blockers.push('The scoring safety panel contains one or more critical alerts.');
  }

  if (snapshot.seasonSafetyStatus === 'blocked') {
    blockers.push('The server reports that the season scoring pipeline is blocked.');
  } else if (snapshot.seasonSafetyStatus === 'attention') {
    advisories.push('The scoring panel reports attention-level evidence. Review every warning before activating Canary.');
  }

  if (!heartbeatFresh(watchdog.lastSuccessfulAt, generatedAtMilliseconds)) {
    blockers.push('The automatic scoring-safety watchdog heartbeat is missing or older than five minutes.');
  }

  if (
    watchdog.status !== 'observing' &&
    watchdog.status !== 'healthy'
  ) {
    blockers.push(`The scoring-safety watchdog status is ${watchdog.status}.`);
  }

  if (
    watchdog.queueBlockingStreak !== 0 ||
    watchdog.canonicalBlockingStreak !== 0
  ) {
    blockers.push('The scoring-safety watchdog still has an active warning streak.');
  }

  if (watchdog.consecutiveFailureCount !== 0 || watchdog.lastError) {
    blockers.push('The scoring-safety watchdog has a recorded refresh failure.');
  }

  if (!heartbeatFresh(health.queueLastDispatchAt ?? null, generatedAtMilliseconds)) {
    blockers.push('The scoring dispatcher heartbeat is missing or older than five minutes.');
  }

  if (
    health.queueLastDispatchStatus &&
    !['success', 'shadow', 'idle'].includes(health.queueLastDispatchStatus)
  ) {
    blockers.push(`The latest dispatcher status is ${health.queueLastDispatchStatus}.`);
  }

  if (
    completedDraftLeagueCount > 0 &&
    scheduleCoverageCount < completedDraftLeagueCount
  ) {
    blockers.push(`Only ${scheduleCoverageCount} of ${completedDraftLeagueCount} completed-Draft leagues have scoring schedules.`);
  }

  if (finiteInteger(health.queueActivePendingTaskCount) !== 0) {
    blockers.push('Queued or processing scoring tasks are still active. Let the queue drain before freezing.');
  }

  if (finiteInteger(health.queueFailedEnqueueCount) !== 0) {
    blockers.push('The latest dispatcher evidence contains task enqueue failures.');
  }

  if (finiteInteger(health.queueLastRecoveryCount) !== 0) {
    blockers.push('The latest queue evidence contains stale-task recovery activity.');
  }

  if (capacity.status === 'error' || capacity.consecutiveFailureCount > 0) {
    blockers.push('The measured-capacity refresher is failing.');
  } else if (capacity.evidenceLevel === 'insufficient') {
    advisories.push('Live queue capacity evidence is still limited. Keep the season cohort capped until more Canary tasks are measured.');
  }

  if (snapshot.canaryLeagueIds.length > 0) {
    advisories.push('Exact Canary selections are retained while Shadow is active. Reconfirm the intended test league after the freeze.');
  }

  if (watchdog.lastAction !== 'none') {
    advisories.push(`The watchdog previously recorded ${watchdog.lastAction}. Confirm the incident is resolved before activating Canary.`);
  }

  return {
    status: blockers.length === 0 ? 'ready' : 'blocked',
    readyForFreeze: blockers.length === 0,
    blockers,
    advisories,
  };
}

export function createSeasonLaunchScoringEvidenceReport(input: {
  snapshot: SeasonLaunchScoringSnapshot;
  build: ReleaseManifest;
  generatedAt?: string;
  expectedProjectId?: string;
}): SeasonLaunchScoringEvidenceReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const gate = buildSeasonLaunchEvidenceGate({
    ...input,
    generatedAt,
  });
  const snapshot = input.snapshot;
  const health = snapshot.health;

  return {
    schemaVersion: SEASON_LAUNCH_SCORING_EVIDENCE_SCHEMA_VERSION,
    reportType: SEASON_LAUNCH_SCORING_EVIDENCE_REPORT_TYPE,
    generatedAt,
    build: structuredClone(input.build),
    gate,
    queue: {
      projectId: snapshot.projectId,
      environment: snapshot.environment,
      production: snapshot.production,
      mode: snapshot.mode,
      revision: snapshot.revision,
      updatedAt: snapshot.updatedAt,
      canaryLeagueIds: normalizedIds(snapshot.canaryLeagueIds),
      internalTestLeagueIds: normalizedIds(snapshot.internalTestLeagueIds),
      canonicalAuthorityLeagueIds: normalizedIds(
        snapshot.canonicalAuthorityLeagueIds,
      ),
      maxEnqueuePerRun: snapshot.maxEnqueuePerRun,
      successfulTasksSinceCanary: snapshot.successfulTasksSinceCanary,
    },
    health: {
      dispatcherStatus: health.queueLastDispatchStatus ?? 'not-recorded',
      dispatcherAt: health.queueLastDispatchAt ?? null,
      scheduleCoverageCount: finiteInteger(health.queueScheduleCoverageCount),
      completedDraftLeagueCount: finiteInteger(
        health.queueScheduleCoverageCompletedDraftCount,
      ),
      activePendingTaskCount: finiteInteger(
        health.queueActivePendingTaskCount,
      ),
      maximumPendingTaskCount: finiteInteger(
        health.queueTaskMaxPendingTasks,
      ),
      failedEnqueueCount: finiteInteger(health.queueFailedEnqueueCount),
      staleRecoveryCount: finiteInteger(health.queueLastRecoveryCount),
      oldestDueAgeMilliseconds:
        health.queueOldestDueAgeMilliseconds ?? null,
      oldestObservedDueAgeMilliseconds:
        health.queueOldestObservedDueAgeMilliseconds ?? null,
      canonicalParityCohortPassing:
        health.canonicalParityCohortPassing === true,
      canonicalParityMismatchLeagueCount: finiteInteger(
        health.canonicalParityMismatchLeagueCount,
      ),
      canonicalParityIncompleteLeagueCount: finiteInteger(
        health.canonicalParityIncompleteLeagueCount,
      ),
      canonicalParityMissingLeagueCount: finiteInteger(
        health.canonicalParityMissingLeagueCount,
      ),
      canonicalParityStaleLeagueCount: finiteInteger(
        health.canonicalParityStaleLeagueCount,
      ),
    },
    seasonSafety: {
      status: snapshot.seasonSafetyStatus,
      alerts: structuredClone(snapshot.seasonSafetyAlerts),
    },
    watchdog: structuredClone(snapshot.seasonSafetyWatchdog),
    capacity: structuredClone(snapshot.capacityEvidence),
  };
}
