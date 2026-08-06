import { Injectable } from '@angular/core';
import { httpsCallable } from 'firebase/functions';

import { functions } from '../firebase-functions';

export type LeagueAutomationQueueMode = 'shadow' | 'canary' | 'primary';
export type LeagueAutomationEnvironment = 'production' | 'staging' | 'emulator' | 'unknown';
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
  lastError: string;
  activeTaskId: string;
  activeTaskLeaseExpiresAt: string | null;
  isCanary: boolean;
  isInternalTest: boolean;
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
}

export interface LeagueAutomationQueueAdminSnapshot {
  generatedAt: string;
  projectId: string;
  environment: LeagueAutomationEnvironment;
  production: boolean;
  mode: LeagueAutomationQueueMode;
  canaryLeagueIds: string[];
  internalTestLeagueIds: string[];
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
