import { Injectable } from '@angular/core';
import { httpsCallable } from 'firebase/functions';

import { functions } from '../firebase-functions';

export type LeagueAutomationQueueMode = 'shadow' | 'canary' | 'primary';
export type LeagueAutomationEnvironment = 'production' | 'staging' | 'emulator' | 'unknown';
export type LeagueAutomationRefreshCadence = 'standard' | 'near-live-canary';
export type LeagueAutomationScoringPath =
  | 'legacy'
  | 'queued-canary'
  | 'queued-primary'
  | 'historical-replay'
  | 'draft-incomplete'
  | 'paused';

export interface LeagueAutomationPromotionGate {
  id: string;
  label: string;
  passed: boolean;
  blocking: boolean;
  detail: string;
}

export type LeagueAutomationSeasonSafetyStatus =
  | 'observing'
  | 'ready'
  | 'attention'
  | 'blocked';

export interface LeagueAutomationSeasonSafetyAlert {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  label: string;
  detail: string;
}

export type LeagueAutomationWatchdogAction =
  | 'none'
  | 'disable-canonical-authority'
  | 'return-to-shadow';

export type LeagueAutomationWatchdogStatus =
  | 'not-recorded'
  | 'observing'
  | 'healthy'
  | 'warning'
  | 'error'
  | 'canonical-fallback'
  | 'shadow-fallback';

export interface LeagueAutomationSeasonWatchdogSnapshot {
  status: LeagueAutomationWatchdogStatus;
  lastAttemptAt: string | null;
  lastSuccessfulAt: string | null;
  queueBlockingStreak: number;
  canonicalBlockingStreak: number;
  requiredBlockingStreak: number;
  lastAction: LeagueAutomationWatchdogAction;
  lastActionAt: string | null;
  lastActionReason: string;
  automaticShadowFallbackCount: number;
  automaticCanonicalFallbackCount: number;
  consecutiveFailureCount: number;
  lastError: string;
  lastQueueBlockingAlertIds: string[];
  lastCanonicalBlockingAlertIds: string[];
}

export type LeagueAutomationCapacityEvidenceLevel =
  | 'insufficient'
  | 'preliminary'
  | 'representative';

export interface LeagueAutomationCapacityEvidence {
  status: 'not-recorded' | 'healthy' | 'error';
  consecutiveFailureCount: number;
  lastError: string;
  lastAttemptAt: string | null;
  evidenceLevel: LeagueAutomationCapacityEvidenceLevel;
  queueTaskSampleCount: number;
  queueTaskSuccessCount: number;
  queueTaskErrorCount: number;
  queueTaskSkippedCount: number;
  queueTaskReliabilityRate: number;
  sampledDayCount: number;
  averageDurationMilliseconds: number;
  p95DurationMilliseconds: number;
  maximumDurationMilliseconds: number;
  workerCount: number;
  refreshIntervalMilliseconds: number;
  headroomRatio: number;
  safeAffectedLeagueCapacity: number;
  recommendedWorkersFor25Leagues: number;
  recommendedWorkersFor50Leagues: number;
  promotionEvidenceReady: boolean;
  p95WithinPrimaryTarget: boolean;
  reliabilityWithinPrimaryTarget: boolean;
  supportsActiveLeagueTarget: boolean;
  primaryCapacityReady: boolean;
  windowDays: number;
  dateFrom: string;
  dateTo: string;
  lastRefreshedAt: string | null;
  source: 'queue-task';
  allScoringSampleCount: number;
  allScoringAverageDurationMilliseconds: number;
  allScoringP95DurationMilliseconds: number;
  allScoringMaximumDurationMilliseconds: number;
}

export interface LeagueAutomationAdminLeague {
  leagueId: string;
  leagueName: string;
  createdAt: string | null;
  draftStatus: string;
  historicalReplayEnabled: boolean;
  scheduleExists: boolean;
  scoringEnabled: boolean;
  queueStatus: string;
  nextScoringAt: string | null;
  lastCompletedAt: string | null;
  lastOutcome: string;
  lastTrigger: string;
  lastDurationMilliseconds: number | null;
  lastRefreshCadence: LeagueAutomationRefreshCadence;
  lastRefreshDelayMilliseconds: number | null;
  lastError: string;
  activeTaskId: string;
  activeTaskLeaseExpiresAt: string | null;
  isCanary: boolean;
  isInternalTest: boolean;
  canonicalAuthorityConfigured: boolean;
  canonicalAuthorityEligible: boolean;
  canonicalAuthorityEligibilityReason: string;
  canonicalAuthorityCircuitState: 'closed' | 'open' | 'not-configured';
  canonicalAuthorityLastDecision: string;
  canonicalAuthorityLastFallbackReason: string;
  canonicalAuthorityCanonicalUseCount: number;
  canonicalAuthorityDirectFallbackCount: number;
  canonicalParityConsecutivePassingRunCount: number;
  canonicalParityRequiredPassingRunCount: number;
  canaryEligible: boolean;
  canaryEligibilityReason: string;
  scoringPath: LeagueAutomationScoringPath;
}

export interface LeagueAutomationQueueAuditEntry {
  auditId: string;
  action: string;
  modeBefore: LeagueAutomationQueueMode;
  modeAfter: LeagueAutomationQueueMode;
  canaryLeagueIdsBefore: string[];
  canaryLeagueIdsAfter: string[];
  internalTestLeagueIdsBefore: string[];
  internalTestLeagueIdsAfter: string[];
  canonicalAuthorityLeagueIdsBefore: string[];
  canonicalAuthorityLeagueIdsAfter: string[];
  reason: string;
  adminId: string;
  leagueId: string;
  maxEnqueuePerRunBefore: number;
  maxEnqueuePerRunAfter: number;
  revisionBefore: number;
  revisionAfter: number;
  createdAt: string | null;
}

export interface LeagueAutomationQueueHealth {
  queueMode?: string;
  queueLastDispatchAt?: string | null;
  queueLastDispatchStatus?: string;
  queueDueScheduleSampleCount?: number;
  queueEligibleDueCount?: number;
  queueSelectedForEnqueueCount?: number;
  queueActivePendingTaskCount?: number;
  queueTaskMaxPendingTasks?: number;
  queueFailedEnqueueCount?: number;
  queueLastRecoveryCount?: number;
  queueTaskSuccessCount?: number;
  queueTaskRetryAttemptCount?: number;
  queueOldestDueAgeMilliseconds?: number | null;
  queueScheduleCoverageCount?: number;
  queueScheduleCoverageCompletedDraftCount?: number;
  queueTaskMaxConcurrentDispatches?: number;
  queueNearLiveCanaryRefreshIntervalMilliseconds?: number;
  queueNearLiveCanaryMaxLeagueCount?: number;
  canonicalParityShadowOnly?: boolean;
  canonicalParityAuthoritativeReadsEnabled?: boolean;
  canonicalParityLastLeagueId?: string;
  canonicalParityLastStatus?: string;
  canonicalParityLastTaskVersionAligned?: boolean;
  canonicalParityLastComparedCount?: number;
  canonicalParityLastMatchedCount?: number;
  canonicalParityLastMismatchCount?: number;
  canonicalParityLastIncompleteCount?: number;
  canonicalParityLastMaximumAbsolutePointDelta?: number;
  canonicalParityLastComparedAt?: string | null;
  canonicalParityExpectedLeagueCount?: number;
  canonicalParityPassingLeagueCount?: number;
  canonicalParityMismatchLeagueCount?: number;
  canonicalParityIncompleteLeagueCount?: number;
  canonicalParityMissingLeagueCount?: number;
  canonicalParityStaleLeagueCount?: number;
  canonicalParityTotalComparedCount?: number;
  canonicalParityCohortMaximumAbsolutePointDelta?: number;
  canonicalParityCohortPassing?: boolean;
  canonicalAuthorityConfiguredLeagueId?: string;
  canonicalAuthorityCircuitState?: string;
  canonicalAuthorityLastDecision?: string;
  canonicalAuthorityLastFallbackReason?: string;
  canonicalAuthorityLastRuntimeEnabled?: boolean;
  canonicalAuthorityLastRuntimeReason?: string;
  canonicalAuthorityLastCanonicalUseCount?: number;
  canonicalAuthorityLastDirectFallbackCount?: number;
  canonicalAuthorityCircuitOpenCount?: number;
  canonicalAuthorityLastOpenedAt?: string | null;
}

export interface LeagueAutomationQueueAdminSnapshot {
  generatedAt: string;
  projectId: string;
  environment: LeagueAutomationEnvironment;
  production: boolean;
  mode: LeagueAutomationQueueMode;
  canaryLeagueIds: string[];
  internalTestLeagueIds: string[];
  canonicalAuthorityLeagueIds: string[];
  canonicalAuthorityConfirmationPhrase: string;
  canonicalAuthorityMaximumLeagueCount: number;
  canonicalAuthorityMinimumParityStreak: number;
  seasonSafetyStatus: LeagueAutomationSeasonSafetyStatus;
  seasonSafetyAlerts: LeagueAutomationSeasonSafetyAlert[];
  seasonSafetyWatchdog: LeagueAutomationSeasonWatchdogSnapshot;
  capacityEvidence: LeagueAutomationCapacityEvidence;
  maxEnqueuePerRun: number;
  canarySuccessBaseline: number;
  successfulTasksSinceCanary: number;
  revision: number;
  updatedAt: string | null;
  updatedBy: string;
  changeReason: string;
  primaryApproval: {
    enabled: boolean;
    valid: boolean;
    expiresAt: string | null;
    note: string;
  };
  primaryPromotionAllowed: boolean;
  primaryConfirmationPhrase: string;
  promotionGates: LeagueAutomationPromotionGate[];
  health: LeagueAutomationQueueHealth;
  leagues: LeagueAutomationAdminLeague[];
  truncated: boolean;
  audit: LeagueAutomationQueueAuditEntry[];
}

interface LoadQueueControlCenterRequest {
  focusLeagueId: string;
}

export interface UpdateLeagueAutomationQueueConfigRequest {
  requestId: string;
  expectedRevision: number;
  mode: LeagueAutomationQueueMode;
  canaryLeagueIds: string[];
  internalTestLeagueIds: string[];
  canonicalAuthorityLeagueIds: string[];
  maxEnqueuePerRun: number;
  confirmationText: string;
  changeReason: string;
}

export interface UpdateLeagueAutomationQueueConfigResponse {
  updated: boolean;
  revision: number;
  mode: LeagueAutomationQueueMode;
  message: string;
}

interface QueueCanaryCheckRequest {
  requestId: string;
  leagueId: string;
  confirmationText: 'RUN CANARY';
}

export interface QueueCanaryCheckResponse {
  queued: boolean;
  status: 'enqueued' | 'active' | 'stale';
  taskId: string;
  message: string;
}

@Injectable({ providedIn: 'root' })
export class ScoringQueueControlService {
  async load(
    focusLeagueId: string,
  ): Promise<LeagueAutomationQueueAdminSnapshot> {
    const callable = httpsCallable<
      LoadQueueControlCenterRequest,
      LeagueAutomationQueueAdminSnapshot
    >(
      functions,
      'getLeagueAutomationQueueControlCenter',
      { timeout: 65_000 },
    );
    const response = await callable({ focusLeagueId });
    return response.data;
  }

  async updateConfiguration(
    request: UpdateLeagueAutomationQueueConfigRequest,
  ): Promise<UpdateLeagueAutomationQueueConfigResponse> {
    const callable = httpsCallable<
      UpdateLeagueAutomationQueueConfigRequest,
      UpdateLeagueAutomationQueueConfigResponse
    >(
      functions,
      'updateLeagueAutomationQueueConfig',
      { timeout: 65_000 },
    );
    const response = await callable(request);
    return response.data;
  }

  async queueCanaryCheck(
    leagueId: string,
  ): Promise<QueueCanaryCheckResponse> {
    const callable = httpsCallable<QueueCanaryCheckRequest, QueueCanaryCheckResponse>(
      functions,
      'queueLeagueAutomationCanaryCheck',
      { timeout: 65_000 },
    );
    const response = await callable({
      requestId: createScoringQueueRequestId('canary'),
      leagueId,
      confirmationText: 'RUN CANARY',
    });
    return response.data;
  }
}

export function createScoringQueueRequestId(prefix = 'queue'): string {
  const randomPart = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID().replaceAll('-', '')
    : `${Date.now()}${Math.random().toString(36).slice(2)}`;

  return `${prefix}-${randomPart}`.slice(0, 96);
}
