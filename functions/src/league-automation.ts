import { createHash, randomUUID } from 'node:crypto';

import {
  DocumentData,
  FieldValue,
  Timestamp,
} from 'firebase-admin/firestore';
import type { DocumentSnapshot } from 'firebase-admin/firestore';
import { getFunctions } from 'firebase-admin/functions';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';

import { TRUSTED_WEB_ORIGINS } from './web-security';
import { db } from './shared/core/firebase';
import {
  advanceCompletedRegularSeasonAssetWindows,
  completeCycle,
  getActiveLeagueCycles,
  getCycleMatchupsOnce,
  getCycleRosterPicksOnce,
  reconcilePendingRosterMovesForRegularSeasonCycle,
  reconcileRegularSeasonCycleMatchupCompletion,
  startCycleOne,
  startNextCycle,
  updateCycleMatchupScores,
} from './shared/core/cycle/cycle.service';
import {
  calculateCycleScoring,
  CycleScoringResult,
} from './shared/core/cycle/cycle-scoring.service';
import { syncCycleTeamWindows } from './shared/core/cycle/asset-cycle-window.service';
import { FantasyCycle } from './shared/core/cycle/cycle.models';
import { DraftableAsset, DraftPick, FantasyDraft } from './shared/core/draft/draft.models';
import { SharedCycleScoringSnapshot } from './shared/core/live-scoring/live-scoring.models';
import {
  getNhlTeamSeasonSchedule,
  getRegularSeasonGameLog,
  NhlTeamSeasonGame,
} from './shared/core/nhl/nhl-api.service';
import { getFantasyPlayoffs } from './shared/core/playoffs/playoff.service';
import {
  ensureNextPlayoffBankWindows,
  syncPlayoffWindowBankScores,
} from './shared/core/playoffs/playoff-window-bank.service';
import {
  CURRENT_SCORING_RULES_VERSION,
  defaultScoringRules,
  ScoringRules,
} from './shared/core/scoring/scoring-rules';
import {
  FantasyTeam,
  getLeagueTeams,
} from './shared/core/team/team.service';

const FUNCTION_REGION = 'us-central1';
const SERVER_WORKER_PREFIX = 'server:';
const SERVER_LEASE_MILLISECONDS = 9 * 60 * 1000;
const LIVE_REFRESH_INTERVAL_MILLISECONDS = 10 * 60 * 1000;
const NEAR_GAME_REFRESH_MAX_MILLISECONDS = 60 * 60 * 1000;
const IDLE_REFRESH_INTERVAL_MILLISECONDS = 6 * 60 * 60 * 1000;
const ERROR_RETRY_INTERVAL_MILLISECONDS = 5 * 60 * 1000;
const MAX_TRANSITION_PASSES = 3;
const MAX_PARALLEL_LEAGUES = 2;
const HISTORICAL_REPLAY_LEASE_RETRY_DELAYS_MILLISECONDS = [0, 500, 1_250, 2_250] as const;
const HISTORICAL_REPLAY_TASK_DISPATCH_DEADLINE_SECONDS = 540;
const HISTORICAL_REPLAY_REQUEST_LEASE_MILLISECONDS = 10 * 60 * 1000;
const HISTORICAL_REPLAY_REQUEST_STALE_MILLISECONDS = 12 * 60 * 1000;
const HISTORICAL_REPLAY_STALE_SWEEP_LIMIT = 100;
const LEAGUE_AUTOMATION_QUEUE_SCHEMA_VERSION = 1;
const LEAGUE_AUTOMATION_QUEUE_DEFAULT_MODE = 'shadow' as const;
const LEAGUE_AUTOMATION_QUEUE_SHARD_COUNT = 16;
const LEAGUE_AUTOMATION_QUEUE_DEFAULT_MAX_ENQUEUE_PER_RUN = 100;
const LEAGUE_AUTOMATION_QUEUE_MAX_SCAN_LIMIT = 300;
const LEAGUE_AUTOMATION_QUEUE_MAX_CONCURRENT_DISPATCHES = 4;
const LEAGUE_AUTOMATION_QUEUE_MAX_PENDING_TASKS = 24;
const LEAGUE_AUTOMATION_TASK_DISPATCH_DEADLINE_SECONDS = 540;
const LEAGUE_AUTOMATION_QUEUED_TASK_LEASE_MILLISECONDS = 75 * 60 * 1000;
const LEAGUE_AUTOMATION_PROCESSING_TASK_LEASE_MILLISECONDS = 12 * 60 * 1000;
const LEAGUE_AUTOMATION_RECOVERY_STALE_MILLISECONDS = 25 * 60 * 1000;
const LEAGUE_AUTOMATION_STALE_TASK_SWEEP_LIMIT = 100;
const LEAGUE_AUTOMATION_BOOTSTRAP_BATCH_LIMIT = 500;
const LEAGUE_AUTOMATION_TASK_HISTORY_RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
const LEAGUE_AUTOMATION_TASK_HISTORY_CLEANUP_LIMIT = 500;
const LEAGUE_AUTOMATION_ADMIN_LEAGUE_LIMIT = 200;
const LEAGUE_AUTOMATION_ADMIN_AUDIT_LIMIT = 20;
const LEAGUE_AUTOMATION_PRODUCTION_PROJECT_ID = 'nhl-fantasy-app-ab673';
const LEAGUE_AUTOMATION_CANARY_CONFIRMATION = 'ENABLE CANARY';
const LEAGUE_AUTOMATION_STAGING_PRIMARY_CONFIRMATION = 'ENABLE PRIMARY IN STAGING';
const LEAGUE_AUTOMATION_PRODUCTION_PRIMARY_CONFIRMATION = 'ENABLE PRIMARY IN PRODUCTION';

type LeagueAutomationTrigger =
  | 'scheduled'
  | 'queue-task'
  | 'draft-complete'
  | 'season-start'
  | 'historical-replay'
  | 'manual';

type LeagueAutomationQueueMode = 'shadow' | 'canary' | 'primary';

const HISTORICAL_REPLAY_TARGET_SEASON = '20262027';
const HISTORICAL_REPLAY_SOURCE_SEASON = '20252026';
const HISTORICAL_REPLAY_TEAMS = [
  'ANA', 'BOS', 'BUF', 'CAR', 'CBJ', 'CGY', 'CHI', 'COL',
  'DAL', 'DET', 'EDM', 'FLA', 'LAK', 'MIN', 'MTL', 'NJD',
  'NSH', 'NYI', 'NYR', 'OTT', 'PHI', 'PIT', 'SEA', 'SJS',
  'STL', 'TBL', 'TOR', 'UTA', 'VAN', 'VGK', 'WPG', 'WSH',
] as const;


interface ServerLeague {
  id: string;
  commissionerId: string;
  scoringRules: ScoringRules;
  scoringRulesVersion: number;
}

interface PreviousScoringSnapshot {
  season: string;
  scoringFingerprint: string;
  scoringRulesFingerprint: string;
  result: CycleScoringResult;
  createdAt?: unknown;
}

interface LeagueAutomationResult {
  leagueId: string;
  status: 'success' | 'skipped';
  skipReason?: string;
  activeCycleNumbers: number[];
  publishedSnapshotCount: number;
  skippedSnapshotCount: number;
  cycleOneCreated: boolean;
  durationMilliseconds: number;
  nextRefreshAtMilliseconds?: number;
}

interface LeaseClaimResult {
  claimed: boolean;
  reason: string;
  nextRefreshAtMilliseconds?: number;
}

interface HistoricalReplayControl {
  enabled: boolean;
  status: 'inactive' | 'queued' | 'advancing' | 'ready' | 'error';
  targetSeason: string;
  sourceSeason: string;
  simulatedDate: string | null;
  seasonStartDate: string | null;
  daysAdvanced: number;
  lastReleasedGameCount: number;
  totalReleasedGameCount: number;
  message: string;
}

interface HistoricalReplayAdvanceTaskPayload {
  requestId: string;
  leagueId: string;
  requestedBy: string;
}

interface HistoricalReplayQueuedResult {
  enabled: true;
  status: 'queued';
  requestId: string;
  message: string;
}

interface HistoricalReplayAdvanceResult {
  enabled: true;
  status: 'ready';
  simulatedDate: string;
  seasonStartDate: string;
  targetSeason: string;
  sourceSeason: string;
  daysAdvanced: number;
  releasedGameCount: number;
  activeCycleNumbers: number[];
  message: string;
}

interface LeagueAutomationQueueConfig {
  mode: LeagueAutomationQueueMode;
  canaryLeagueIds: string[];
  internalTestLeagueIds: string[];
  maxEnqueuePerRun: number;
  canarySuccessBaseline: number;
  revision: number;
}

type LeagueAutomationEnvironment = 'production' | 'staging' | 'emulator' | 'unknown';

interface LeagueAutomationPromotionGate {
  id: string;
  label: string;
  passed: boolean;
  blocking: boolean;
  detail: string;
}

interface LeagueAutomationPrimaryApproval {
  enabled: boolean;
  expiresAtMilliseconds: number;
  projectId: string;
  note: string;
}

interface LeagueAutomationAdminLeague {
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
  scoringPath: 'legacy' | 'queued-canary' | 'queued-primary' | 'historical-replay' | 'draft-incomplete' | 'paused';
}

interface LeagueAutomationQueueAdminSnapshot {
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
  health: Record<string, unknown>;
  leagues: LeagueAutomationAdminLeague[];
  truncated: boolean;
  audit: Array<{
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
  }>;
}

interface LeagueAutomationTaskPayload {
  taskSchemaVersion: 1;
  leagueId: string;
  expectedDueAtMilliseconds: number;
  dueBucket: string;
  reason: 'scheduled' | 'recovery' | 'canary-manual';
}

interface DueLeagueAutomationSchedule {
  leagueId: string;
  expectedDueAtMilliseconds: number;
  queueStatus: string;
  activeTaskId: string;
  activeTaskLeaseExpiresAtMilliseconds: number;
}

interface HistoricalReplayAssetMap {
  assetKey: string;
  assetType: 'skater' | 'team-goalie-unit';
  sourceSeason: string;
  sourceGameIds: number[];
  sourceGameDates: string[];
  sourceTeamAbbreviations: string[];
}

interface ReplayRunContext {
  control: HistoricalReplayControl;
  gamesByAssetKey: Record<string, NhlTeamSeasonGame[]>;
  snapshotSeason: string;
}


async function requireHistoricalReplayPlatformAdmin(request: {
  auth?: {
    uid: string;
    token: Record<string, unknown>;
  } | null;
}): Promise<string> {
  const userId = request.auth?.uid;

  if (!userId) {
    throw new HttpsError('unauthenticated', 'You must be signed in to advance the replay.');
  }

  if (request.auth?.token?.['platformAdmin'] === true) {
    return userId;
  }

  const adminSnapshot = await db.doc(`platformAdmins/${userId}`).get();

  if (!adminSnapshot.exists || adminSnapshot.data()?.['enabled'] !== true) {
    throw new HttpsError(
      'permission-denied',
      'Only a RinkRat platform administrator can advance historical replay time.',
    );
  }

  return userId;
}

function getHistoricalReplayControlRef(leagueId: string) {
  return db.doc(`leagues/${leagueId}/historicalReplay/control`);
}

function getHistoricalReplayRequestRef(requestId: string) {
  return db.doc(`historicalReplayRequests/${requestId}`);
}

function getHistoricalReplayTaskQueue() {
  return getFunctions().taskQueue<HistoricalReplayAdvanceTaskPayload>(
    'processHistoricalReplayAdvance',
  );
}

function getLeagueAutomationScheduleRef(leagueId: string) {
  return db.doc(`leagueAutomationSchedules/${leagueId}`);
}

function getLeagueAutomationTaskRef(taskId: string) {
  return db.doc(`leagueAutomationTasks/${taskId}`);
}

function getLeagueAutomationTaskQueue() {
  return getFunctions().taskQueue<LeagueAutomationTaskPayload>(
    'processLeagueAutomationTask',
  );
}

function normalizeLeagueAutomationQueueMode(value: unknown): LeagueAutomationQueueMode {
  return value === 'canary' || value === 'primary'
    ? value
    : LEAGUE_AUTOMATION_QUEUE_DEFAULT_MODE;
}

function normalizeLeagueAutomationLeagueIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(
    value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => /^[A-Za-z0-9_-]{6,128}$/.test(entry))
      .slice(0, 100),
  )].sort();
}

function normalizeLeagueAutomationCanaryIds(value: unknown): string[] {
  return normalizeLeagueAutomationLeagueIds(value);
}

function normalizeLeagueAutomationInternalTestIds(value: unknown): string[] {
  return normalizeLeagueAutomationLeagueIds(value);
}

function normalizeLeagueAutomationRevision(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function normalizeLeagueAutomationMaxEnqueuePerRun(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(
        LEAGUE_AUTOMATION_QUEUE_MAX_SCAN_LIMIT,
        Math.max(1, Math.trunc(value)),
      )
    : LEAGUE_AUTOMATION_QUEUE_DEFAULT_MAX_ENQUEUE_PER_RUN;
}

async function getLeagueAutomationQueueConfig(): Promise<LeagueAutomationQueueConfig> {
  const snapshot = await db.doc('appData/leagueAutomationQueueConfig').get();
  const data = snapshot.data() ?? {};

  return {
    mode: normalizeLeagueAutomationQueueMode(data['mode']),
    canaryLeagueIds: normalizeLeagueAutomationCanaryIds(data['canaryLeagueIds']),
    internalTestLeagueIds: normalizeLeagueAutomationInternalTestIds(
      data['internalTestLeagueIds'],
    ),
    maxEnqueuePerRun: normalizeLeagueAutomationMaxEnqueuePerRun(
      data['maxEnqueuePerRun'],
    ),
    canarySuccessBaseline: normalizeLeagueAutomationRevision(
      data['canarySuccessBaseline'],
    ),
    revision: normalizeLeagueAutomationRevision(data['revision']),
  };
}


async function requireLeagueAutomationPlatformAdmin(request: {
  auth?: {
    uid: string;
    token: Record<string, unknown>;
  } | null;
}): Promise<string> {
  const userId = request.auth?.uid;

  if (!userId) {
    throw new HttpsError(
      'unauthenticated',
      'Sign in before opening the scoring queue controls.',
    );
  }

  if (request.auth?.token?.['platformAdmin'] === true) {
    return userId;
  }

  const adminSnapshot = await db.doc(`platformAdmins/${userId}`).get();

  if (!adminSnapshot.exists || adminSnapshot.data()?.['enabled'] !== true) {
    throw new HttpsError(
      'permission-denied',
      'This account does not have RinkRat platform-administrator access.',
    );
  }

  return userId;
}

function getLeagueAutomationProjectId(): string {
  const direct = [
    process.env['GCLOUD_PROJECT'],
    process.env['GOOGLE_CLOUD_PROJECT'],
    process.env['GCP_PROJECT'],
  ].find((value) => typeof value === 'string' && value.trim().length > 0);

  if (direct) {
    return direct.trim();
  }

  const firebaseConfig = process.env['FIREBASE_CONFIG'];

  if (firebaseConfig) {
    try {
      const parsed = JSON.parse(firebaseConfig) as Record<string, unknown>;
      const projectId = parsed['projectId'];

      if (typeof projectId === 'string' && projectId.trim()) {
        return projectId.trim();
      }
    } catch {
      // A malformed environment value should not prevent the control center from loading.
    }
  }

  return 'unknown-project';
}

function getLeagueAutomationEnvironment(projectId: string): LeagueAutomationEnvironment {
  if (process.env['FUNCTIONS_EMULATOR'] === 'true') {
    return 'emulator';
  }

  if (projectId === LEAGUE_AUTOMATION_PRODUCTION_PROJECT_ID) {
    return 'production';
  }

  if (projectId && projectId !== 'unknown-project') {
    return 'staging';
  }

  return 'unknown';
}

function getLeagueAutomationAuditRef(auditId: string) {
  return db.doc(`leagueAutomationConfigAudit/${auditId}`);
}

function normalizeLeagueAutomationAdminRequestId(value: unknown): string {
  const cleaned = typeof value === 'string'
    ? value.trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 96)
    : '';

  return cleaned || randomUUID().replaceAll('-', '');
}

function normalizeLeagueAutomationChangeReason(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').slice(0, 500)
    : '';
}

function getLeagueAutomationString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function getLeagueAutomationNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getLeagueAutomationIso(value: unknown): string | null {
  const milliseconds = toMilliseconds(value);
  return milliseconds > 0 ? new Date(milliseconds).toISOString() : null;
}

function getLeagueAutomationAgeMilliseconds(value: unknown, now = Date.now()): number | null {
  const milliseconds = toMilliseconds(value);
  return milliseconds > 0 ? Math.max(0, now - milliseconds) : null;
}

function normalizeLeagueAutomationPrimaryApproval(
  value: DocumentData | undefined,
): LeagueAutomationPrimaryApproval {
  return {
    enabled: value?.['enabled'] === true,
    expiresAtMilliseconds: toMilliseconds(value?.['expiresAt']),
    projectId: getLeagueAutomationString(value?.['projectId']),
    note: getLeagueAutomationString(value?.['note']).slice(0, 500),
  };
}

function isLeagueAutomationPrimaryApprovalValid(
  approval: LeagueAutomationPrimaryApproval,
  projectId: string,
  now = Date.now(),
): boolean {
  return approval.enabled &&
    approval.projectId === projectId &&
    approval.expiresAtMilliseconds > now;
}

function buildLeagueAutomationPromotionGates(input: {
  config: LeagueAutomationQueueConfig;
  health: DocumentData | undefined;
  approval: LeagueAutomationPrimaryApproval;
  projectId: string;
  environment: LeagueAutomationEnvironment;
  now?: number;
}): LeagueAutomationPromotionGate[] {
  const now = input.now ?? Date.now();
  const coverageCount = getLeagueAutomationNumber(
    input.health?.['queueScheduleCoverageCount'],
  ) ?? 0;
  const coverageTarget = getLeagueAutomationNumber(
    input.health?.['queueScheduleCoverageCompletedDraftCount'],
  ) ?? 0;
  const dispatchAge = getLeagueAutomationAgeMilliseconds(
    input.health?.['queueLastDispatchAt'],
    now,
  );
  const failedEnqueueCount = getLeagueAutomationNumber(
    input.health?.['queueFailedEnqueueCount'],
  ) ?? 0;
  const recoveredStaleCount = getLeagueAutomationNumber(
    input.health?.['queueLastRecoveryCount'],
  ) ?? 0;
  const pendingCount = getLeagueAutomationNumber(
    input.health?.['queueActivePendingTaskCount'],
  ) ?? 0;
  const queueSuccessCount = getLeagueAutomationNumber(
    input.health?.['queueTaskSuccessCount'],
  ) ?? 0;
  const successfulTasksSinceCanary = Math.max(
    0,
    queueSuccessCount - input.config.canarySuccessBaseline,
  );
  const approvalValid = isLeagueAutomationPrimaryApprovalValid(
    input.approval,
    input.projectId,
    now,
  );

  return [
    {
      id: 'canary-mode-proven',
      label: 'Canary mode has been exercised',
      passed: input.config.mode === 'canary' && input.config.canaryLeagueIds.length > 0,
      blocking: true,
      detail: input.config.mode === 'canary'
        ? `${input.config.canaryLeagueIds.length} exact canary league(s) are configured.`
        : 'Primary promotion begins only after selected leagues have run in canary mode.',
    },
    {
      id: 'queue-task-success',
      label: 'Queued scoring has completed successfully',
      passed: successfulTasksSinceCanary >= 3,
      blocking: true,
      detail: `${successfulTasksSinceCanary} successful queued scoring task(s) are recorded since the current canary allowlist was activated; at least 3 are required before promotion.`,
    },
    {
      id: 'schedule-coverage',
      label: 'Every completed league has a scoring schedule',
      passed: coverageTarget > 0 && coverageCount >= coverageTarget,
      blocking: true,
      detail: `${coverageCount}/${coverageTarget || 'unknown'} completed-draft league schedules are covered.`,
    },
    {
      id: 'dispatcher-fresh',
      label: 'The one-minute dispatcher is healthy',
      passed: dispatchAge !== null && dispatchAge <= 5 * 60 * 1000,
      blocking: true,
      detail: dispatchAge === null
        ? 'No dispatcher heartbeat is available yet.'
        : `The latest dispatcher heartbeat is ${Math.max(0, Math.round(dispatchAge / 1_000))} seconds old.`,
    },
    {
      id: 'no-enqueue-failures',
      label: 'The latest dispatcher pass had no enqueue failures',
      passed: failedEnqueueCount === 0,
      blocking: true,
      detail: `${failedEnqueueCount} enqueue failure(s) were recorded in the latest pass.`,
    },
    {
      id: 'no-stale-recovery',
      label: 'The latest recovery sweep found no abandoned tasks',
      passed: recoveredStaleCount === 0,
      blocking: true,
      detail: `${recoveredStaleCount} stale task(s) were recovered in the latest sweep.`,
    },
    {
      id: 'queue-idle-for-cutover',
      label: 'No scoring task is active during the mode change',
      passed: pendingCount === 0,
      blocking: true,
      detail: `${pendingCount} queued or processing task(s) are currently active.`,
    },
    {
      id: 'known-environment',
      label: 'The Firebase project environment is identified',
      passed: input.environment !== 'unknown',
      blocking: true,
      detail: input.environment === 'unknown'
        ? 'The Function runtime could not identify its Firebase project. Primary mode remains locked.'
        : `Project ${input.projectId} is classified as ${input.environment}.`,
    },
    {
      id: 'production-approval',
      label: input.environment === 'production'
        ? 'Production primary cutover has a separate time-limited approval'
        : 'This is not the production Firebase project',
      passed: input.environment !== 'production' || approvalValid,
      blocking: true,
      detail: input.environment === 'production'
        ? approvalValid
          ? `Production approval is valid until ${new Date(input.approval.expiresAtMilliseconds).toISOString()}.`
          : 'Production primary mode remains locked until a separate server-only approval document is intentionally created.'
        : `Project ${input.projectId} is classified as ${input.environment}.`,
    },
  ];
}


function getLeagueAutomationScoringPath(input: {
  config: LeagueAutomationQueueConfig;
  leagueId: string;
  draftStatus: string;
  historicalReplayEnabled: boolean;
  scoringEnabled: boolean;
}): LeagueAutomationAdminLeague['scoringPath'] {
  if (input.historicalReplayEnabled) {
    return 'historical-replay';
  }

  if (input.draftStatus !== 'complete') {
    return 'draft-incomplete';
  }

  if (!input.scoringEnabled) {
    return 'paused';
  }

  if (input.config.mode === 'primary') {
    return 'queued-primary';
  }

  if (
    input.config.mode === 'canary' &&
    input.config.canaryLeagueIds.includes(input.leagueId)
  ) {
    return 'queued-canary';
  }

  return 'legacy';
}

function getLeagueAutomationCanaryEligibility(input: {
  draftStatus: string;
  historicalReplayEnabled: boolean;
  scheduleExists: boolean;
  scoringEnabled: boolean;
}): { eligible: boolean; reason: string } {
  if (input.draftStatus !== 'complete') {
    return {
      eligible: false,
      reason: 'Finish this league’s draft before using it as a live-scoring canary.',
    };
  }

  if (input.historicalReplayEnabled) {
    return {
      eligible: false,
      reason: 'Historical replay leagues use the separate serialized replay queue.',
    };
  }

  if (!input.scheduleExists) {
    return {
      eligible: false,
      reason: 'The server-owned scoring schedule has not been bootstrapped yet.',
    };
  }

  if (!input.scoringEnabled) {
    return {
      eligible: false,
      reason: 'Live scoring is paused for this league.',
    };
  }

  return {
    eligible: true,
    reason: 'This completed live league can use the queued scoring worker.',
  };
}

async function loadLeagueAutomationAdminLeagues(
  config: LeagueAutomationQueueConfig,
  focusLeagueId: string,
): Promise<{ leagues: LeagueAutomationAdminLeague[]; truncated: boolean }> {
  const snapshot = await db.collection('leagues')
    .orderBy('createdAt', 'desc')
    .limit(LEAGUE_AUTOMATION_ADMIN_LEAGUE_LIMIT)
    .get();
  const leagueDocuments: DocumentSnapshot<DocumentData, DocumentData>[] = [
    ...snapshot.docs,
  ];
  const explicitlyManagedLeagueIds = [...new Set([
    focusLeagueId,
    ...config.canaryLeagueIds,
    ...config.internalTestLeagueIds,
  ].filter(Boolean))];
  const missingManagedLeagueRefs = explicitlyManagedLeagueIds
    .filter((leagueId) =>
      !leagueDocuments.some((document) => document.id === leagueId)
    )
    .map((leagueId) => db.doc(`leagues/${leagueId}`));

  if (missingManagedLeagueRefs.length > 0) {
    const managedSnapshots = await db.getAll(...missingManagedLeagueRefs);

    for (const managedSnapshot of managedSnapshots) {
      if (managedSnapshot.exists) {
        leagueDocuments.unshift(managedSnapshot);
      }
    }
  }

  const uniqueDocuments = [...new Map(
    leagueDocuments.map((document) => [document.id, document]),
  ).values()];
  const leagueIds = uniqueDocuments.map((document) => document.id);
  const draftRefs = leagueIds.map((leagueId) =>
    db.doc(`leagues/${leagueId}/draft/current`),
  );
  const replayRefs = leagueIds.map((leagueId) =>
    getHistoricalReplayControlRef(leagueId),
  );
  const scheduleRefs = leagueIds.map((leagueId) =>
    getLeagueAutomationScheduleRef(leagueId),
  );
  const [draftSnapshots, replaySnapshots, scheduleSnapshots] = await Promise.all([
    draftRefs.length > 0 ? db.getAll(...draftRefs) : Promise.resolve([]),
    replayRefs.length > 0 ? db.getAll(...replayRefs) : Promise.resolve([]),
    scheduleRefs.length > 0 ? db.getAll(...scheduleRefs) : Promise.resolve([]),
  ]);

  const leagues = uniqueDocuments.map((leagueDocument, index) => {
    const leagueData = leagueDocument.data() ?? {};
    const draftData = draftSnapshots[index]?.data() ?? {};
    const replayData = replaySnapshots[index]?.data() ?? {};
    const scheduleSnapshot = scheduleSnapshots[index];
    const scheduleData = scheduleSnapshot?.data() ?? {};
    const draftStatus = getLeagueAutomationString(draftData['status'], 'not-created');
    const historicalReplayEnabled = replayData['enabled'] === true;
    const scheduleExists = scheduleSnapshot?.exists === true;
    const scoringEnabled = scheduleExists && scheduleData['scoringEnabled'] !== false;
    const eligibility = getLeagueAutomationCanaryEligibility({
      draftStatus,
      historicalReplayEnabled,
      scheduleExists,
      scoringEnabled,
    });

    return {
      leagueId: leagueDocument.id,
      leagueName: getLeagueAutomationString(
        leagueData['name'],
        `League ${leagueDocument.id.slice(0, 8)}`,
      ).slice(0, 140),
      createdAt: getLeagueAutomationIso(leagueData['createdAt']),
      draftStatus,
      historicalReplayEnabled,
      scheduleExists,
      scoringEnabled,
      queueStatus: getLeagueAutomationString(scheduleData['queueStatus'], 'not-scheduled'),
      nextScoringAt: getLeagueAutomationIso(scheduleData['nextScoringAt']),
      lastCompletedAt: getLeagueAutomationIso(scheduleData['lastCompletedAt']),
      lastOutcome: getLeagueAutomationString(scheduleData['lastOutcome'], 'not-run'),
      lastTrigger: getLeagueAutomationString(scheduleData['lastTrigger'], 'none'),
      lastDurationMilliseconds: getLeagueAutomationNumber(
        scheduleData['lastDurationMilliseconds'],
      ),
      lastError: getLeagueAutomationString(
        scheduleData['lastError'] || scheduleData['lastQueueError'],
      ).slice(0, 500),
      activeTaskId: getLeagueAutomationString(scheduleData['activeTaskId']),
      activeTaskLeaseExpiresAt: getLeagueAutomationIso(
        scheduleData['activeTaskLeaseExpiresAt'],
      ),
      isCanary: config.canaryLeagueIds.includes(leagueDocument.id),
      isInternalTest: config.internalTestLeagueIds.includes(leagueDocument.id),
      canaryEligible: eligibility.eligible,
      canaryEligibilityReason: eligibility.reason,
      scoringPath: getLeagueAutomationScoringPath({
        config,
        leagueId: leagueDocument.id,
        draftStatus,
        historicalReplayEnabled,
        scoringEnabled,
      }),
    } satisfies LeagueAutomationAdminLeague;
  });

  leagues.sort((left, right) => {
    if (left.leagueId === focusLeagueId) return -1;
    if (right.leagueId === focusLeagueId) return 1;
    if (left.isCanary !== right.isCanary) return left.isCanary ? -1 : 1;
    if (left.isInternalTest !== right.isInternalTest) return left.isInternalTest ? -1 : 1;
    return left.leagueName.localeCompare(right.leagueName);
  });

  return {
    leagues,
    truncated: snapshot.size >= LEAGUE_AUTOMATION_ADMIN_LEAGUE_LIMIT,
  };
}

async function loadLeagueAutomationConfigAudit(): Promise<LeagueAutomationQueueAdminSnapshot['audit']> {
  const snapshot = await db.collection('leagueAutomationConfigAudit')
    .orderBy('createdAt', 'desc')
    .limit(LEAGUE_AUTOMATION_ADMIN_AUDIT_LIMIT)
    .get();

  return snapshot.docs.map((document) => {
    const data = document.data();

    return {
      auditId: document.id,
      action: getLeagueAutomationString(data['action'], 'configuration-updated'),
      modeBefore: normalizeLeagueAutomationQueueMode(data['modeBefore']),
      modeAfter: normalizeLeagueAutomationQueueMode(data['modeAfter']),
      canaryLeagueIdsBefore: normalizeLeagueAutomationCanaryIds(
        data['canaryLeagueIdsBefore'],
      ),
      canaryLeagueIdsAfter: normalizeLeagueAutomationCanaryIds(
        data['canaryLeagueIdsAfter'],
      ),
      internalTestLeagueIdsBefore: normalizeLeagueAutomationInternalTestIds(
        data['internalTestLeagueIdsBefore'],
      ),
      internalTestLeagueIdsAfter: normalizeLeagueAutomationInternalTestIds(
        data['internalTestLeagueIdsAfter'],
      ),
      reason: getLeagueAutomationString(data['reason']).slice(0, 500),
      adminId: getLeagueAutomationString(data['adminId']),
      leagueId: getLeagueAutomationString(data['leagueId']),
      maxEnqueuePerRunBefore: normalizeLeagueAutomationMaxEnqueuePerRun(
        data['maxEnqueuePerRunBefore'],
      ),
      maxEnqueuePerRunAfter: normalizeLeagueAutomationMaxEnqueuePerRun(
        data['maxEnqueuePerRunAfter'],
      ),
      revisionBefore: normalizeLeagueAutomationRevision(data['revisionBefore']),
      revisionAfter: normalizeLeagueAutomationRevision(data['revisionAfter']),
      createdAt: getLeagueAutomationIso(data['createdAt']),
    };
  });
}

async function buildLeagueAutomationQueueAdminSnapshot(
  focusLeagueId = '',
): Promise<LeagueAutomationQueueAdminSnapshot> {
  const projectId = getLeagueAutomationProjectId();
  const environment = getLeagueAutomationEnvironment(projectId);
  const [configSnapshot, healthSnapshot, approvalSnapshot, audit] = await Promise.all([
    db.doc('appData/leagueAutomationQueueConfig').get(),
    db.doc('appData/leagueAutomation').get(),
    db.doc('appData/leagueAutomationPrimaryApproval').get(),
    loadLeagueAutomationConfigAudit(),
  ]);
  const configData = configSnapshot.data() ?? {};
  const healthData = healthSnapshot.data() ?? {};
  const approval = normalizeLeagueAutomationPrimaryApproval(
    approvalSnapshot.data(),
  );
  const config: LeagueAutomationQueueConfig = {
    mode: normalizeLeagueAutomationQueueMode(configData['mode']),
    canaryLeagueIds: normalizeLeagueAutomationCanaryIds(
      configData['canaryLeagueIds'],
    ),
    internalTestLeagueIds: normalizeLeagueAutomationInternalTestIds(
      configData['internalTestLeagueIds'],
    ),
    maxEnqueuePerRun: normalizeLeagueAutomationMaxEnqueuePerRun(
      configData['maxEnqueuePerRun'],
    ),
    canarySuccessBaseline: normalizeLeagueAutomationRevision(
      configData['canarySuccessBaseline'],
    ),
    revision: normalizeLeagueAutomationRevision(configData['revision']),
  };
  const promotionGates = buildLeagueAutomationPromotionGates({
    config,
    health: healthData,
    approval,
    projectId,
    environment,
  });
  const primaryPromotionAllowed = promotionGates
    .filter((gate) => gate.blocking)
    .every((gate) => gate.passed);
  const leagueResult = await loadLeagueAutomationAdminLeagues(
    config,
    focusLeagueId,
  );
  const approvalValid = isLeagueAutomationPrimaryApprovalValid(
    approval,
    projectId,
  );
  const totalQueueSuccessCount = getLeagueAutomationNumber(
    healthData['queueTaskSuccessCount'],
  ) ?? 0;
  const successfulTasksSinceCanary = config.mode === 'shadow'
    ? 0
    : Math.max(
        0,
        totalQueueSuccessCount - config.canarySuccessBaseline,
      );

  return {
    generatedAt: new Date().toISOString(),
    projectId,
    environment,
    production: environment === 'production',
    mode: config.mode,
    canaryLeagueIds: config.canaryLeagueIds,
    internalTestLeagueIds: config.internalTestLeagueIds,
    maxEnqueuePerRun: config.maxEnqueuePerRun,
    canarySuccessBaseline: config.canarySuccessBaseline,
    successfulTasksSinceCanary,
    revision: config.revision,
    updatedAt: getLeagueAutomationIso(configData['updatedAt']),
    updatedBy: getLeagueAutomationString(configData['updatedBy']),
    changeReason: getLeagueAutomationString(configData['changeReason']).slice(0, 500),
    primaryApproval: {
      enabled: approval.enabled,
      valid: approvalValid,
      expiresAt: approval.expiresAtMilliseconds > 0
        ? new Date(approval.expiresAtMilliseconds).toISOString()
        : null,
      note: approval.note,
    },
    primaryPromotionAllowed,
    primaryConfirmationPhrase: environment === 'production'
      ? LEAGUE_AUTOMATION_PRODUCTION_PRIMARY_CONFIRMATION
      : LEAGUE_AUTOMATION_STAGING_PRIMARY_CONFIRMATION,
    promotionGates,
    health: {
      queueMode: getLeagueAutomationString(healthData['queueMode'], 'shadow'),
      queueLastDispatchAt: getLeagueAutomationIso(healthData['queueLastDispatchAt']),
      queueLastDispatchStatus: getLeagueAutomationString(
        healthData['queueLastDispatchStatus'],
        'not-recorded',
      ),
      queueDueScheduleSampleCount: getLeagueAutomationNumber(
        healthData['queueDueScheduleSampleCount'],
      ) ?? 0,
      queueEligibleDueCount: getLeagueAutomationNumber(
        healthData['queueEligibleDueCount'],
      ) ?? 0,
      queueSelectedForEnqueueCount: getLeagueAutomationNumber(
        healthData['queueSelectedForEnqueueCount'],
      ) ?? 0,
      queueActivePendingTaskCount: getLeagueAutomationNumber(
        healthData['queueActivePendingTaskCount'],
      ) ?? 0,
      queueTaskMaxPendingTasks: getLeagueAutomationNumber(
        healthData['queueTaskMaxPendingTasks'],
      ) ?? LEAGUE_AUTOMATION_QUEUE_MAX_PENDING_TASKS,
      queueFailedEnqueueCount: getLeagueAutomationNumber(
        healthData['queueFailedEnqueueCount'],
      ) ?? 0,
      queueLastRecoveryCount: getLeagueAutomationNumber(
        healthData['queueLastRecoveryCount'],
      ) ?? 0,
      queueTaskSuccessCount: getLeagueAutomationNumber(
        healthData['queueTaskSuccessCount'],
      ) ?? 0,
      queueTaskRetryAttemptCount: getLeagueAutomationNumber(
        healthData['queueTaskRetryAttemptCount'],
      ) ?? 0,
      queueOldestDueAgeMilliseconds: getLeagueAutomationNumber(
        healthData['queueOldestDueAgeMilliseconds'],
      ),
      queueScheduleCoverageCount: getLeagueAutomationNumber(
        healthData['queueScheduleCoverageCount'],
      ) ?? 0,
      queueScheduleCoverageCompletedDraftCount: getLeagueAutomationNumber(
        healthData['queueScheduleCoverageCompletedDraftCount'],
      ) ?? 0,
      queueTaskMaxConcurrentDispatches:
        LEAGUE_AUTOMATION_QUEUE_MAX_CONCURRENT_DISPATCHES,
    },
    leagues: leagueResult.leagues,
    truncated: leagueResult.truncated,
    audit,
  };
}

async function validateLeagueAutomationAdminLeagueIds(
  leagueIds: string[],
  requireCanaryEligibility: boolean,
): Promise<void> {
  if (leagueIds.length === 0) {
    return;
  }

  const leagueRefs = leagueIds.map((leagueId) => db.doc(`leagues/${leagueId}`));
  const draftRefs = leagueIds.map((leagueId) =>
    db.doc(`leagues/${leagueId}/draft/current`),
  );
  const replayRefs = leagueIds.map((leagueId) =>
    getHistoricalReplayControlRef(leagueId),
  );
  const scheduleRefs = leagueIds.map((leagueId) =>
    getLeagueAutomationScheduleRef(leagueId),
  );
  const [leagueSnapshots, draftSnapshots, replaySnapshots, scheduleSnapshots] = await Promise.all([
    db.getAll(...leagueRefs),
    db.getAll(...draftRefs),
    db.getAll(...replayRefs),
    db.getAll(...scheduleRefs),
  ]);

  for (let index = 0; index < leagueIds.length; index += 1) {
    const leagueId = leagueIds[index];

    if (!leagueSnapshots[index]?.exists) {
      throw new HttpsError(
        'not-found',
        `League ${leagueId} no longer exists. Refresh the queue control center.`,
      );
    }

    if (!requireCanaryEligibility) {
      continue;
    }

    const draftStatus = getLeagueAutomationString(
      draftSnapshots[index]?.data()?.['status'],
      'not-created',
    );
    const replayEnabled = replaySnapshots[index]?.data()?.['enabled'] === true;
    const scheduleSnapshot = scheduleSnapshots[index];
    const eligibility = getLeagueAutomationCanaryEligibility({
      draftStatus,
      historicalReplayEnabled: replayEnabled,
      scheduleExists: scheduleSnapshot?.exists === true,
      scoringEnabled:
        scheduleSnapshot?.exists === true &&
        scheduleSnapshot.data()?.['scoringEnabled'] !== false,
    });

    if (!eligibility.eligible) {
      throw new HttpsError(
        'failed-precondition',
        `${getLeagueAutomationString(leagueSnapshots[index]?.data()?.['name'], leagueId)} cannot be a canary: ${eligibility.reason}`,
      );
    }
  }
}

async function assertLeagueAutomationPrimaryPromotionAllowed(
  config: LeagueAutomationQueueConfig,
  confirmationText: string,
): Promise<void> {
  const projectId = getLeagueAutomationProjectId();
  const environment = getLeagueAutomationEnvironment(projectId);
  const [healthSnapshot, approvalSnapshot] = await Promise.all([
    db.doc('appData/leagueAutomation').get(),
    db.doc('appData/leagueAutomationPrimaryApproval').get(),
  ]);
  const gates = buildLeagueAutomationPromotionGates({
    config,
    health: healthSnapshot.data(),
    approval: normalizeLeagueAutomationPrimaryApproval(approvalSnapshot.data()),
    projectId,
    environment,
  });
  const failedGates = gates.filter((gate) => gate.blocking && !gate.passed);
  const expectedConfirmation = environment === 'production'
    ? LEAGUE_AUTOMATION_PRODUCTION_PRIMARY_CONFIRMATION
    : LEAGUE_AUTOMATION_STAGING_PRIMARY_CONFIRMATION;

  if (confirmationText !== expectedConfirmation) {
    throw new HttpsError(
      'failed-precondition',
      `Type “${expectedConfirmation}” exactly before enabling primary mode.`,
    );
  }

  if (failedGates.length > 0) {
    throw new HttpsError(
      'failed-precondition',
      `Primary mode remains locked: ${failedGates.map((gate) => gate.label).join('; ')}.`,
    );
  }
}

function getLeagueAutomationShard(leagueId: string): number {
  const digest = createHash('sha256').update(leagueId).digest();
  return digest.readUInt32BE(0) % LEAGUE_AUTOMATION_QUEUE_SHARD_COUNT;
}

function getLeagueAutomationDueBucket(dueAtMilliseconds: number): string {
  return new Date(Math.max(0, dueAtMilliseconds))
    .toISOString()
    .slice(0, 16)
    .replace(/[^0-9]/g, '');
}

function buildLeagueAutomationTaskId(payload: LeagueAutomationTaskPayload): string {
  return createHash('sha256')
    .update(
      `${payload.taskSchemaVersion}:${payload.leagueId}:${payload.expectedDueAtMilliseconds}:${payload.reason}`,
    )
    .digest('hex')
    .slice(0, 40);
}

function isLeagueAutomationTaskAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as { code?: unknown; message?: unknown };
  const code = typeof candidate.code === 'string' ? candidate.code : '';
  const message = typeof candidate.message === 'string' ? candidate.message : '';

  return code.includes('task-already-exists') || /already exists/i.test(message);
}

function normalizeHistoricalReplayRequestId(value: unknown): string {
  const cleaned = typeof value === 'string'
    ? value.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 96)
    : '';

  return cleaned || randomUUID().replaceAll('-', '');
}

function buildHistoricalReplayTaskId(payload: HistoricalReplayAdvanceTaskPayload): string {
  return createHash('sha256')
    .update(`${payload.leagueId}:${payload.requestId}:${payload.requestedBy}`)
    .digest('hex')
    .slice(0, 40);
}

function isHistoricalReplayTaskAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as { code?: unknown; message?: unknown };
  const code = typeof candidate.code === 'string' ? candidate.code : '';
  const message = typeof candidate.message === 'string' ? candidate.message : '';

  return code.includes('task-already-exists') || /already exists/i.test(message);
}

function getHistoricalReplayAssetRef(leagueId: string, assetKey: string) {
  return db.doc(`leagues/${leagueId}/historicalReplayAssets/${assetKey}`);
}

function normalizeReplayControl(value: DocumentData | undefined): HistoricalReplayControl {
  return {
    enabled: value?.['enabled'] === true,
    status:
      value?.['status'] === 'queued' ||
      value?.['status'] === 'advancing' ||
      value?.['status'] === 'ready' ||
      value?.['status'] === 'error'
        ? value['status']
        : 'inactive',
    targetSeason:
      typeof value?.['targetSeason'] === 'string'
        ? value['targetSeason']
        : HISTORICAL_REPLAY_TARGET_SEASON,
    sourceSeason:
      typeof value?.['sourceSeason'] === 'string'
        ? value['sourceSeason']
        : HISTORICAL_REPLAY_SOURCE_SEASON,
    simulatedDate:
      typeof value?.['simulatedDate'] === 'string'
        ? value['simulatedDate']
        : null,
    seasonStartDate:
      typeof value?.['seasonStartDate'] === 'string'
        ? value['seasonStartDate']
        : null,
    daysAdvanced:
      typeof value?.['daysAdvanced'] === 'number'
        ? value['daysAdvanced']
        : 0,
    lastReleasedGameCount:
      typeof value?.['lastReleasedGameCount'] === 'number'
        ? value['lastReleasedGameCount']
        : 0,
    totalReleasedGameCount:
      typeof value?.['totalReleasedGameCount'] === 'number'
        ? value['totalReleasedGameCount']
        : 0,
    message: typeof value?.['message'] === 'string' ? value['message'] : '',
  };
}

async function getHistoricalReplayControl(
  leagueId: string,
): Promise<HistoricalReplayControl | null> {
  const snapshot = await getHistoricalReplayControlRef(leagueId).get();

  if (!snapshot.exists) {
    return null;
  }

  const control = normalizeReplayControl(snapshot.data());
  return control.enabled && (
    Boolean(control.simulatedDate) ||
    control.status === 'queued' ||
    control.status === 'advancing'
  )
    ? control
    : null;
}

function addUtcDays(dateString: string, days: number): string {
  const date = new Date(`${dateString}T12:00:00Z`);

  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid replay date: ${dateString}`);
  }

  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getAssetTeamAbbreviation(asset: DraftableAsset): string {
  return asset.assetType === 'skater'
    ? asset.player.nhlTeamAbbreviation
    : asset.teamAbbreviation;
}

function normalizeReplayAssetMap(
  value: DocumentData | undefined,
): HistoricalReplayAssetMap | null {
  if (
    !value ||
    typeof value['assetKey'] !== 'string' ||
    !Array.isArray(value['sourceGameIds'])
  ) {
    return null;
  }

  const sourceGameIds = value['sourceGameIds'].filter(
    (entry: unknown): entry is number => typeof entry === 'number' && Number.isFinite(entry),
  );

  if (sourceGameIds.length === 0) {
    return null;
  }

  return {
    assetKey: value['assetKey'],
    assetType:
      value['assetType'] === 'team-goalie-unit'
        ? 'team-goalie-unit'
        : 'skater',
    sourceSeason:
      typeof value['sourceSeason'] === 'string'
        ? value['sourceSeason']
        : HISTORICAL_REPLAY_SOURCE_SEASON,
    sourceGameIds,
    sourceGameDates: Array.isArray(value['sourceGameDates'])
      ? value['sourceGameDates'].filter(
          (entry: unknown): entry is string => typeof entry === 'string',
        )
      : [],
    sourceTeamAbbreviations: Array.isArray(value['sourceTeamAbbreviations'])
      ? value['sourceTeamAbbreviations'].filter(
          (entry: unknown): entry is string => typeof entry === 'string',
        )
      : [],
  };
}

async function buildHistoricalSkaterTimeline(
  asset: DraftableAsset,
  sourceSeason: string,
): Promise<HistoricalReplayAssetMap> {
  if (asset.assetType !== 'skater') {
    throw new Error('A goalie unit cannot use the skater replay timeline builder.');
  }

  const gameLogResponse = await getRegularSeasonGameLog(
    asset.player.id,
    sourceSeason,
    true,
  );
  const gameLogs = [...(gameLogResponse.gameLog ?? [])].sort(
    (first, second) => first.gameDate.localeCompare(second.gameDate),
  );
  const historicalTeams = [
    ...new Set(
      gameLogs
        .map((game) => game.teamAbbrev?.toUpperCase())
        .filter((team): team is string => Boolean(team)),
    ),
  ];

  if (historicalTeams.length === 0) {
    historicalTeams.push(asset.player.nhlTeamAbbreviation.toUpperCase());
  }

  const schedules = new Map<string, NhlTeamSeasonGame[]>();

  for (const team of historicalTeams) {
    schedules.set(team, await getNhlTeamSeasonSchedule(team, sourceSeason));
  }

  const segments: Array<{ team: string; startDate: string | null }> = [];

  for (const game of gameLogs) {
    const team = game.teamAbbrev?.toUpperCase();

    if (!team || segments.at(-1)?.team === team) {
      continue;
    }

    segments.push({
      team,
      startDate: segments.length === 0 ? null : game.gameDate,
    });
  }

  if (segments.length === 0) {
    segments.push({
      team: historicalTeams[0],
      startDate: null,
    });
  }

  const timeline: NhlTeamSeasonGame[] = [];
  const seenGameIds = new Set<number>();

  segments.forEach((segment, index) => {
    const nextStartDate = segments[index + 1]?.startDate ?? null;
    const schedule = schedules.get(segment.team) ?? [];

    for (const game of schedule) {
      const afterSegmentStart = !segment.startDate || game.gameDate >= segment.startDate;
      const beforeNextSegment = !nextStartDate || game.gameDate < nextStartDate;

      if (afterSegmentStart && beforeNextSegment && !seenGameIds.has(game.id)) {
        seenGameIds.add(game.id);
        timeline.push(game);
      }
    }
  });

  timeline.sort((first, second) => first.gameDate.localeCompare(second.gameDate));

  // If transaction timing produces a short timeline, retain every historical
  // appearance as a deterministic fallback instead of inventing statistics.
  for (const log of gameLogs) {
    if (!seenGameIds.has(log.gameId)) {
      seenGameIds.add(log.gameId);
      timeline.push({
        id: log.gameId,
        gameDate: log.gameDate,
        gameType: 2,
        gameState: 'FINAL',
        homeTeam: { abbrev: log.homeRoadFlag === 'H' ? log.teamAbbrev : log.opponentAbbrev },
        awayTeam: { abbrev: log.homeRoadFlag === 'R' ? log.teamAbbrev : log.opponentAbbrev },
      });
    }
  }

  timeline.sort((first, second) => first.gameDate.localeCompare(second.gameDate));

  return {
    assetKey: asset.assetKey,
    assetType: 'skater',
    sourceSeason,
    sourceGameIds: timeline.map((game) => game.id).slice(0, 82),
    sourceGameDates: timeline.map((game) => game.gameDate).slice(0, 82),
    sourceTeamAbbreviations: timeline.map((game) => {
      const matchingLog = gameLogs.find((entry) => entry.gameId === game.id);
      return matchingLog?.teamAbbrev?.toUpperCase() ?? historicalTeams[0];
    }).slice(0, 82),
  };
}

async function buildHistoricalReplayAssetMap(
  leagueId: string,
  asset: DraftableAsset,
  sourceSeason: string,
): Promise<HistoricalReplayAssetMap> {
  const reference = getHistoricalReplayAssetRef(leagueId, asset.assetKey);
  const snapshot = await reference.get();
  const existing = normalizeReplayAssetMap(snapshot.data());

  if (existing?.sourceSeason === sourceSeason) {
    return existing;
  }

  let mapping: HistoricalReplayAssetMap;

  if (asset.assetType === 'team-goalie-unit') {
    const schedule = await getNhlTeamSeasonSchedule(
      asset.teamAbbreviation,
      sourceSeason,
    );

    mapping = {
      assetKey: asset.assetKey,
      assetType: 'team-goalie-unit',
      sourceSeason,
      sourceGameIds: schedule.map((game) => game.id),
      sourceGameDates: schedule.map((game) => game.gameDate),
      sourceTeamAbbreviations: schedule.map(() => asset.teamAbbreviation),
    };
  } else {
    mapping = await buildHistoricalSkaterTimeline(asset, sourceSeason);
  }

  await reference.set(
    {
      ...mapping,
      schemaVersion: 1,
      playerId: asset.assetType === 'skater' ? asset.player.id : null,
      currentTeamAbbreviation: getAssetTeamAbbreviation(asset),
      createdAt: snapshot.exists
        ? snapshot.data()?.['createdAt'] ?? FieldValue.serverTimestamp()
        : FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return mapping;
}

async function buildReplayGamesByAssetKey(
  leagueId: string,
  picks: DraftPick[],
  control: HistoricalReplayControl,
): Promise<Record<string, NhlTeamSeasonGame[]>> {
  const uniqueAssets = new Map<string, DraftableAsset>();

  for (const pick of picks) {
    uniqueAssets.set(pick.asset.assetKey, pick.asset);
  }

  const assets = [...uniqueAssets.values()];
  const targetTeams = [
    ...new Set(assets.map((asset) => getAssetTeamAbbreviation(asset).toUpperCase())),
  ];
  const targetSchedules = new Map<string, NhlTeamSeasonGame[]>();

  for (let index = 0; index < targetTeams.length; index += 6) {
    const batch = targetTeams.slice(index, index + 6);
    const schedules = await Promise.all(
      batch.map((team) => getNhlTeamSeasonSchedule(team, control.targetSeason)),
    );

    batch.forEach((team, batchIndex) => {
      targetSchedules.set(team, schedules[batchIndex]);
    });
  }

  const mappings = new Map<string, HistoricalReplayAssetMap>();

  for (let index = 0; index < assets.length; index += 6) {
    const batch = assets.slice(index, index + 6);
    const batchMappings = await Promise.all(
      batch.map((asset) =>
        buildHistoricalReplayAssetMap(leagueId, asset, control.sourceSeason),
      ),
    );

    batch.forEach((asset, batchIndex) => {
      mappings.set(asset.assetKey, batchMappings[batchIndex]);
    });
  }

  const result: Record<string, NhlTeamSeasonGame[]> = {};

  for (const asset of assets) {
    const targetTeam = getAssetTeamAbbreviation(asset).toUpperCase();
    const targetSchedule = targetSchedules.get(targetTeam) ?? [];
    const mapping = mappings.get(asset.assetKey);

    if (!mapping) {
      continue;
    }

    result[asset.assetKey] = targetSchedule
      .map((targetGame, index): NhlTeamSeasonGame | null => {
        const sourceGameId = mapping.sourceGameIds[index];

        if (!sourceGameId) {
          return null;
        }

        const released = targetGame.gameDate <= (control.simulatedDate ?? '0000-00-00');

        return {
          ...targetGame,
          id: sourceGameId,
          gameState: released ? 'FINAL' : 'FUT',
          homeTeam: {
            abbrev: targetGame.homeTeam.abbrev,
          },
          awayTeam: {
            abbrev: targetGame.awayTeam.abbrev,
          },
        };
      })
      .filter((game): game is NhlTeamSeasonGame => Boolean(game));
  }

  return result;
}

async function buildReplayRunContext(
  leagueId: string,
  picks: DraftPick[],
  control: HistoricalReplayControl,
): Promise<ReplayRunContext> {
  return {
    control,
    gamesByAssetKey: await buildReplayGamesByAssetKey(leagueId, picks, control),
    snapshotSeason: `replay-${control.targetSeason}-from-${control.sourceSeason}`,
  };
}

async function getHistoricalReplaySeasonStartDate(targetSeason: string): Promise<string> {
  let earliestDate = '';

  for (let index = 0; index < HISTORICAL_REPLAY_TEAMS.length; index += 4) {
    const batch = HISTORICAL_REPLAY_TEAMS.slice(index, index + 4);
    const schedules = await Promise.all(
      batch.map((team) => getNhlTeamSeasonSchedule(team, targetSeason)),
    );

    for (const schedule of schedules) {
      const firstDate = schedule[0]?.gameDate;

      if (firstDate && (!earliestDate || firstDate < earliestDate)) {
        earliestDate = firstDate;
      }
    }
  }

  if (!earliestDate) {
    throw new Error(`No regular-season NHL schedule was found for ${targetSeason}.`);
  }

  return earliestDate;
}

async function countNhlGamesOnReplayDate(
  date: string,
  targetSeason: string,
): Promise<number> {
  const gameIds = new Set<number>();

  for (let index = 0; index < HISTORICAL_REPLAY_TEAMS.length; index += 4) {
    const batch = HISTORICAL_REPLAY_TEAMS.slice(index, index + 4);
    const schedules = await Promise.all(
      batch.map((team) => getNhlTeamSeasonSchedule(team, targetSeason)),
    );

    for (const schedule of schedules) {
      for (const game of schedule) {
        if (game.gameDate === date) {
          gameIds.add(game.id);
        }
      }
    }
  }

  return gameIds.size;
}

function getControlRef(leagueId: string) {
  return db.doc(`leagues/${leagueId}/liveScoring/control`);
}

function getCycleSnapshotRef(leagueId: string, cycleNumber: number) {
  return db.doc(`leagues/${leagueId}/liveScoring/cycle-${cycleNumber}`);
}

function normalizeScoringRules(value: unknown, version: unknown): ScoringRules {
  const stored = value && typeof value === 'object'
    ? value as Partial<ScoringRules>
    : {};

  const normalized: ScoringRules = {
    ...defaultScoringRules,
    ...stored,
    forward: {
      ...defaultScoringRules.forward,
      ...(stored.forward ?? {}),
      goal: {
        ...defaultScoringRules.forward.goal,
        ...(stored.forward?.goal ?? {}),
      },
      primaryAssist: {
        ...defaultScoringRules.forward.primaryAssist,
        ...(stored.forward?.primaryAssist ?? {}),
      },
      secondaryAssist: {
        ...defaultScoringRules.forward.secondaryAssist,
        ...(stored.forward?.secondaryAssist ?? {}),
      },
    },
    defense: {
      ...defaultScoringRules.defense,
      ...(stored.defense ?? {}),
      goal: {
        ...defaultScoringRules.defense.goal,
        ...(stored.defense?.goal ?? {}),
      },
      primaryAssist: {
        ...defaultScoringRules.defense.primaryAssist,
        ...(stored.defense?.primaryAssist ?? {}),
      },
      secondaryAssist: {
        ...defaultScoringRules.defense.secondaryAssist,
        ...(stored.defense?.secondaryAssist ?? {}),
      },
    },
    goalieSavePercentageTiers:
      Array.isArray(stored.goalieSavePercentageTiers) &&
      stored.goalieSavePercentageTiers.length > 0
        ? stored.goalieSavePercentageTiers
        : defaultScoringRules.goalieSavePercentageTiers,
  };

  if (typeof version !== 'number' || version < CURRENT_SCORING_RULES_VERSION) {
    normalized.defense = {
      ...defaultScoringRules.defense,
      goal: { ...defaultScoringRules.defense.goal },
      primaryAssist: { ...defaultScoringRules.defense.primaryAssist },
      secondaryAssist: { ...defaultScoringRules.defense.secondaryAssist },
    };
    normalized.defenseToiBaseMultiplier = defaultScoringRules.defenseToiBaseMultiplier;
    normalized.defenseToiPlusMinusModifier = defaultScoringRules.defenseToiPlusMinusModifier;
    normalized.defenseToiFloor = defaultScoringRules.defenseToiFloor;
    normalized.defenseToiCeiling = defaultScoringRules.defenseToiCeiling;

    normalized.goalieGameBase = defaultScoringRules.goalieGameBase;
    normalized.goalieSave = defaultScoringRules.goalieSave;
    normalized.goalieWin = defaultScoringRules.goalieWin;
    normalized.goalieShutout = defaultScoringRules.goalieShutout;
    normalized.goalieSavePercentageBaseline =
      defaultScoringRules.goalieSavePercentageBaseline;
    normalized.goalieSavePercentageBasePoints =
      defaultScoringRules.goalieSavePercentageBasePoints;
    normalized.goalieSavePercentagePointsPerPercentagePoint =
      defaultScoringRules.goalieSavePercentagePointsPerPercentagePoint;
    normalized.goalieSavePercentageMinimum =
      defaultScoringRules.goalieSavePercentageMinimum;
    normalized.goalieSavePercentageMaximum =
      defaultScoringRules.goalieSavePercentageMaximum;
    normalized.goalieGameMaximum = defaultScoringRules.goalieGameMaximum;
  }

  return normalized;
}

async function getServerLeague(leagueId: string): Promise<ServerLeague | null> {
  const snapshot = await db.doc(`leagues/${leagueId}`).get();

  if (!snapshot.exists) {
    return null;
  }

  const data = snapshot.data() ?? {};

  return {
    id: leagueId,
    commissionerId:
      typeof data['commissionerId'] === 'string'
        ? data['commissionerId']
        : '',
    scoringRules: normalizeScoringRules(data['scoringRules'], data['scoringRulesVersion']),
    scoringRulesVersion:
      typeof data['scoringRulesVersion'] === 'number'
        ? data['scoringRulesVersion']
        : 0,
  };
}

function getNhlSeasonForDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const seasonStartYear = month >= 7 ? year : year - 1;

  return `${seasonStartYear}${seasonStartYear + 1}`;
}

function toMilliseconds(value: unknown): number {
  if (value instanceof Timestamp) {
    return value.toMillis();
  }

  if (
    value &&
    typeof value === 'object' &&
    'toMillis' in value &&
    typeof (value as { toMillis?: unknown }).toMillis === 'function'
  ) {
    return (value as { toMillis: () => number }).toMillis();
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function getSafeAutomationErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return 'unknown';
  }

  const candidate = error as { code?: unknown; name?: unknown };
  const code = typeof candidate.code === 'string' ? candidate.code : '';
  const name = typeof candidate.name === 'string' ? candidate.name : '';
  const normalized = (code || name || 'unknown')
    .trim()
    .replace(/[^a-zA-Z0-9:_-]/g, '-')
    .slice(0, 80);

  return normalized || 'unknown';
}

async function recordLeagueAutomationPaused(
  leagueId: string,
  reason: string,
): Promise<void> {
  await getLeagueAutomationScheduleRef(leagueId).set(
    {
      schemaVersion: LEAGUE_AUTOMATION_QUEUE_SCHEMA_VERSION,
      leagueId,
      shard: getLeagueAutomationShard(leagueId),
      scoringEnabled: false,
      queueStatus: 'paused',
      pausedReason: reason.slice(0, 120),
      nextScoringAt: FieldValue.delete(),
      activeTaskId: null,
      activeTaskLeaseExpiresAt: FieldValue.delete(),
      lastOutcome: 'paused',
      lastTrigger: 'historical-replay',
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

async function recordLeagueAutomationSuccess(
  leagueId: string,
  trigger: LeagueAutomationTrigger,
  nextRefreshAtMilliseconds: number,
  durationMilliseconds: number,
  publishedSnapshotCount: number,
  skippedSnapshotCount: number,
): Promise<void> {
  const queueTaskOwnsSchedule = trigger === 'queue-task';
  const data: Record<string, unknown> = {
    schemaVersion: LEAGUE_AUTOMATION_QUEUE_SCHEMA_VERSION,
    leagueId,
    shard: getLeagueAutomationShard(leagueId),
    scoringEnabled: true,
    pausedReason: '',
    nextScoringAt: Timestamp.fromMillis(nextRefreshAtMilliseconds),
    lastCompletedAt: FieldValue.serverTimestamp(),
    lastDurationMilliseconds: Math.max(0, durationMilliseconds),
    lastPublishedSnapshotCount: Math.max(0, publishedSnapshotCount),
    lastSkippedSnapshotCount: Math.max(0, skippedSnapshotCount),
    lastOutcome: 'success',
    lastTrigger: trigger,
    consecutiveFailureCount: 0,
    lastErrorCode: '',
    lastError: '',
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (!queueTaskOwnsSchedule) {
    data['queueStatus'] = 'idle';
    data['activeTaskId'] = null;
    data['activeTaskLeaseExpiresAt'] = FieldValue.delete();
  }

  await getLeagueAutomationScheduleRef(leagueId).set(data, { merge: true });
}

async function recordLeagueAutomationFailure(
  leagueId: string,
  trigger: LeagueAutomationTrigger,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error
    ? error.message
    : 'Server league automation failed.';
  const data: Record<string, unknown> = {
    schemaVersion: LEAGUE_AUTOMATION_QUEUE_SCHEMA_VERSION,
    leagueId,
    shard: getLeagueAutomationShard(leagueId),
    scoringEnabled: true,
    pausedReason: '',
    nextScoringAt: Timestamp.fromMillis(
      Date.now() + ERROR_RETRY_INTERVAL_MILLISECONDS,
    ),
    lastFailedAt: FieldValue.serverTimestamp(),
    lastOutcome: 'error',
    lastTrigger: trigger,
    consecutiveFailureCount: FieldValue.increment(1),
    lastErrorCode: getSafeAutomationErrorCode(error),
    lastError: message.slice(0, 500),
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (trigger !== 'queue-task') {
    data['queueStatus'] = 'error';
    data['activeTaskId'] = null;
    data['activeTaskLeaseExpiresAt'] = FieldValue.delete();
  }

  await getLeagueAutomationScheduleRef(leagueId).set(data, { merge: true });
}

async function recordLeagueAutomationSkip(
  leagueId: string,
  trigger: LeagueAutomationTrigger,
  reason: string,
  nextRefreshAtMilliseconds?: number,
): Promise<void> {
  const data: Record<string, unknown> = {
    schemaVersion: LEAGUE_AUTOMATION_QUEUE_SCHEMA_VERSION,
    leagueId,
    shard: getLeagueAutomationShard(leagueId),
    scoringEnabled: true,
    lastSkippedAt: FieldValue.serverTimestamp(),
    lastSkipReason: reason.slice(0, 120),
    lastTrigger: trigger,
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (
    typeof nextRefreshAtMilliseconds === 'number' &&
    Number.isFinite(nextRefreshAtMilliseconds) &&
    nextRefreshAtMilliseconds > 0
  ) {
    data['nextScoringAt'] = Timestamp.fromMillis(nextRefreshAtMilliseconds);
  }

  await getLeagueAutomationScheduleRef(leagueId).set(
    data,
    { merge: true },
  );
}

async function claimLeagueAutomationLease(
  leagueId: string,
  workerId: string,
  force: boolean,
  trigger: LeagueAutomationTrigger,
): Promise<LeaseClaimResult> {
  const controlRef = getControlRef(leagueId);
  const now = Date.now();

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(controlRef);
    const data = snapshot.data() ?? {};
    const holderClientId =
      typeof data['holderClientId'] === 'string'
        ? data['holderClientId']
        : '';
    const leaseExpiresAt = toMilliseconds(data['leaseExpiresAt']);
    const nextRefreshAt = toMilliseconds(data['nextRefreshAt']);
    const currentStatus =
      typeof data['status'] === 'string'
        ? data['status']
        : '';
    const anotherServerWorkerOwnsLease =
      currentStatus === 'refreshing' &&
      holderClientId.startsWith(SERVER_WORKER_PREFIX) &&
      holderClientId !== workerId &&
      leaseExpiresAt > now;

    if (anotherServerWorkerOwnsLease) {
      return {
        claimed: false,
        reason: 'another-server-worker',
      };
    }

    if (!force && nextRefreshAt > now) {
      return {
        claimed: false,
        reason: 'not-due',
        nextRefreshAtMilliseconds: nextRefreshAt,
      };
    }

    transaction.set(
      controlRef,
      {
        id: 'control',
        schemaVersion: 2,
        automationMode: 'server',
        serverAutomationEnabled: true,
        status: 'refreshing',
        holderUserId: null,
        holderClientId: workerId,
        leaseExpiresAt: Timestamp.fromMillis(
          now + SERVER_LEASE_MILLISECONDS,
        ),
        lastRefreshStartedAt: FieldValue.serverTimestamp(),
        lastRefreshReason: trigger,
        serverTrigger: trigger,
        lastError: '',
        updatedAt: FieldValue.serverTimestamp(),
        ...(!snapshot.exists
          ? {
              nextRefreshAt: Timestamp.fromMillis(now),
              lastRefreshCompletedAt: null,
            }
          : {}),
      },
      { merge: true },
    );

    return {
      claimed: true,
      reason: 'claimed',
    };
  });
}

async function getPreviousScoringSnapshot(
  leagueId: string,
  cycleNumber: number,
): Promise<PreviousScoringSnapshot | null> {
  const snapshot = await getCycleSnapshotRef(leagueId, cycleNumber).get();

  if (!snapshot.exists) {
    return null;
  }

  const data = snapshot.data() ?? {};
  const result = data['result'] as CycleScoringResult | undefined;

  if (
    !result ||
    result.scoringSchemaVersion !== 2 ||
    typeof data['scoringFingerprint'] !== 'string'
  ) {
    return null;
  }

  return {
    season: typeof data['season'] === 'string' ? data['season'] : '',
    scoringFingerprint: data['scoringFingerprint'],
    scoringRulesFingerprint:
      typeof data['scoringRulesFingerprint'] === 'string'
        ? data['scoringRulesFingerprint']
        : '',
    result,
    createdAt: data['createdAt'],
  };
}

async function publishCycleSnapshot(
  leagueId: string,
  workerId: string,
  cycle: FantasyCycle,
  season: string,
  result: CycleScoringResult,
  scoringRulesFingerprint: string,
  previous: PreviousScoringSnapshot | null,
): Promise<boolean> {
  const scoringFingerprint =
    `${scoringRulesFingerprint}::${result.dataFingerprint}`;

  if (previous?.scoringFingerprint === scoringFingerprint) {
    return false;
  }

  const snapshot: SharedCycleScoringSnapshot = {
    id: `cycle-${cycle.cycleNumber}`,
    schemaVersion: 1,
    leagueId,
    cycleNumber: cycle.cycleNumber,
    season,
    scoringFingerprint,
    scoringRulesFingerprint,
    result,
    workerUserId: 'server',
    workerClientId: workerId,
  };

  await getCycleSnapshotRef(leagueId, cycle.cycleNumber).set(
    {
      ...snapshot,
      refreshedAt: FieldValue.serverTimestamp(),
      createdAt: previous?.createdAt ?? FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return true;
}

function allCycleTeamsComplete(result: CycleScoringResult): boolean {
  const values = Object.values(result.teamCycleComplete);
  return values.length > 0 && values.every(Boolean);
}

async function persistServerScoring(
  leagueId: string,
  teams: FantasyTeam[],
  cycle: FantasyCycle,
  picks: DraftPick[],
  result: CycleScoringResult,
  season: string,
  scoringRules: ScoringRules,
  replayGamesByAssetKey?: Record<string, NhlTeamSeasonGame[]>,
  gameLogSeason?: string,
  projectionRefreshPolicy: 'refresh-if-needed' | 'saved-only' = 'refresh-if-needed',
): Promise<boolean> {
  const matchups = await getCycleMatchupsOnce(
    leagueId,
    cycle.cycleNumber,
  );

  await syncCycleTeamWindows(leagueId, cycle, picks, result);

  if (matchups.length > 0) {
    await updateCycleMatchupScores(
      leagueId,
      cycle.cycleNumber,
      matchups,
      result.teamScores,
    );
  }

  if (cycle.phase === 'regular_season') {
    const completion =
      await reconcileRegularSeasonCycleMatchupCompletion(
        leagueId,
        cycle.cycleNumber,
      );

    await advanceCompletedRegularSeasonAssetWindows(
      leagueId,
      teams,
      cycle,
      picks,
      result,
      { projectionRefreshPolicy },
    );

    if (completion.cycleCompleted) {
      await startNextCycle(
        leagueId,
        teams,
        cycle.cycleNumber,
        { projectionRefreshPolicy },
      ).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : '';

        if (
          !message.includes('already') &&
          !message.includes('does not have any playable matchups')
        ) {
          throw error;
        }
      });
    }

    return completion.cycleCompleted;
  }

  const playoffs = await getFantasyPlayoffs(leagueId);

  if (playoffs) {
    const banks = await syncPlayoffWindowBankScores({
      leagueId,
      playoffs,
      season,
      requiredGamesPerCycle:
        scoringRules.requiredGamesPerCycle ??
        defaultScoringRules.requiredGamesPerCycle,
      scoringRules,
      assignedPicks: picks,
      assignedScoring: result,
      replayGamesByAssetKey,
      gameLogSeason,
    });

    await ensureNextPlayoffBankWindows({
      leagueId,
      playoffs,
      banks,
    });
  }

  if (!allCycleTeamsComplete(result) || matchups.length === 0) {
    return false;
  }

  try {
    await completeCycle(
      leagueId,
      cycle.cycleNumber,
      matchups,
      result.teamScores,
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '';

    if (!message.includes('already been completed')) {
      throw error;
    }
  }

  await startNextCycle(
    leagueId,
    teams,
    cycle.cycleNumber,
    { projectionRefreshPolicy },
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : '';

    if (
      !message.includes('already') &&
      !message.includes('playoffs have already been completed')
    ) {
      throw error;
    }
  });

  return true;
}

function getLiveScoringRefreshDelay(
  results: Array<Pick<CycleScoringResult, 'hasLiveGames' | 'nextScheduledGameStart'>>,
  transitionOccurred: boolean,
  nowMilliseconds = Date.now(),
): number {
  if (transitionOccurred || results.some((result) => result.hasLiveGames)) {
    return LIVE_REFRESH_INTERVAL_MILLISECONDS;
  }

  const nextStart = results
    .map((result) => result.nextScheduledGameStart)
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter(Number.isFinite)
    .sort((first, second) => first - second)[0];

  if (typeof nextStart === 'number') {
    const untilStart = nextStart - nowMilliseconds;

    if (untilStart <= 0) {
      return LIVE_REFRESH_INTERVAL_MILLISECONDS;
    }

    return Math.max(
      LIVE_REFRESH_INTERVAL_MILLISECONDS,
      Math.min(
        untilStart + 2 * 60 * 1000,
        NEAR_GAME_REFRESH_MAX_MILLISECONDS,
      ),
    );
  }

  return IDLE_REFRESH_INTERVAL_MILLISECONDS;
}

async function ensureCycleOneStarted(
  leagueId: string,
  teams?: FantasyTeam[],
): Promise<boolean> {
  const [draftSnapshot, cycleSnapshot] = await Promise.all([
    db.doc(`leagues/${leagueId}/draft/current`).get(),
    db.doc(`leagues/${leagueId}/cycles/cycle-1`).get(),
  ]);

  if (cycleSnapshot.exists || !draftSnapshot.exists) {
    return false;
  }

  const draft = draftSnapshot.data() as FantasyDraft;

  if (draft.status !== 'complete') {
    return false;
  }

  const leagueTeams = teams ?? await getLeagueTeams(leagueId);

  if (leagueTeams.length < 2) {
    throw new Error(
      'The draft completed, but at least two teams are required to create Cycle 1.',
    );
  }

  try {
    await startCycleOne(leagueId, leagueTeams);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '';

    if (!message.includes('already been started')) {
      throw error;
    }

    return false;
  }

  await db.doc(`leagues/${leagueId}/draft/current`).set(
    {
      cycleOneStartedAt: FieldValue.serverTimestamp(),
      cycleOneStartSource: 'server-after-draft',
      cycleOneStartStatus: 'started',
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return true;
}

async function runLeagueAutomation(
  leagueId: string,
  force: boolean,
  trigger: LeagueAutomationTrigger,
): Promise<LeagueAutomationResult> {
  const startedAt = Date.now();

  // Historical replay leagues advance only when a platform administrator
  // releases the next simulated NHL date. The scheduled live scorer must not
  // compete for the same league lease or process that replay date on its own.
  if (
    (trigger === 'scheduled' || trigger === 'queue-task') &&
    await getHistoricalReplayControl(leagueId)
  ) {
    await recordLeagueAutomationPaused(leagueId, 'historical-replay')
      .catch((error) => {
        console.warn('Unable to record the historical-replay queue pause.', {
          leagueId,
          error,
        });
      });

    return {
      leagueId,
      status: 'skipped',
      skipReason: 'historical-replay',
      activeCycleNumbers: [],
      publishedSnapshotCount: 0,
      skippedSnapshotCount: 0,
      cycleOneCreated: false,
      durationMilliseconds: Date.now() - startedAt,
    };
  }

  const workerId = `${SERVER_WORKER_PREFIX}${randomUUID()}`;
  const lease = await claimLeagueAutomationLease(
    leagueId,
    workerId,
    force,
    trigger,
  );

  if (!lease.claimed) {
    await recordLeagueAutomationSkip(
      leagueId,
      trigger,
      lease.reason,
      lease.nextRefreshAtMilliseconds,
    )
      .catch((error) => {
        console.warn('Unable to record a skipped league-automation run.', {
          leagueId,
          trigger,
          reason: lease.reason,
          error,
        });
      });

    return {
      leagueId,
      status: 'skipped',
      skipReason: lease.reason,
      activeCycleNumbers: [],
      publishedSnapshotCount: 0,
      skippedSnapshotCount: 0,
      cycleOneCreated: false,
      durationMilliseconds: Date.now() - startedAt,
      nextRefreshAtMilliseconds: lease.nextRefreshAtMilliseconds,
    };
  }

  let publishedSnapshotCount = 0;
  let skippedSnapshotCount = 0;
  let cycleOneCreated = false;
  let activeCycleNumbers: number[] = [];
  let transitionOccurred = false;
  let replayControl: HistoricalReplayControl | null = null;
  const allResults: CycleScoringResult[] = [];

  try {
    const league = await getServerLeague(leagueId);

    if (!league) {
      throw new Error('League not found for server automation.');
    }

    const teams = await getLeagueTeams(leagueId);
    cycleOneCreated = await ensureCycleOneStarted(
      leagueId,
      teams,
    );
    replayControl = await getHistoricalReplayControl(leagueId);
    const projectionRefreshPolicy = replayControl
      ? 'saved-only' as const
      : 'refresh-if-needed' as const;
    const liveSeason = getNhlSeasonForDate(new Date());
    const dataSeason = replayControl?.sourceSeason ?? liveSeason;
    const snapshotSeason = replayControl
      ? `replay-${replayControl.targetSeason}-from-${replayControl.sourceSeason}`
      : liveSeason;
    const scoringRules = league.scoringRules;
    const requiredGamesPerCycle =
      scoringRules.requiredGamesPerCycle ??
      defaultScoringRules.requiredGamesPerCycle;
    const scoringRulesFingerprint = JSON.stringify(scoringRules);
    let previousCycleNumbers = new Set<number>();

    for (
      let pass = 0;
      pass < MAX_TRANSITION_PASSES;
      pass += 1
    ) {
      const activeCycles = await getActiveLeagueCycles(leagueId);
      activeCycleNumbers = activeCycles.map((cycle) => cycle.cycleNumber);
      const newCycleNumbers = activeCycleNumbers.filter(
        (cycleNumber) => !previousCycleNumbers.has(cycleNumber),
      );

      if (pass > 0 && newCycleNumbers.length === 0) {
        break;
      }

      previousCycleNumbers = new Set(activeCycleNumbers);
      let passTransitionOccurred = false;

      for (const cycle of activeCycles) {
        const pendingMoveReconciliation =
          await reconcilePendingRosterMovesForRegularSeasonCycle(
            leagueId,
            teams,
            cycle,
          );

        if (pendingMoveReconciliation.activatedMoveCount > 0) {
          passTransitionOccurred = true;
        }

        const picks = await getCycleRosterPicksOnce(
          leagueId,
          cycle.cycleNumber,
        );

        if (picks.length === 0) {
          continue;
        }

        const previous = await getPreviousScoringSnapshot(
          leagueId,
          cycle.cycleNumber,
        );
        const replayContext = replayControl
          ? await buildReplayRunContext(leagueId, picks, replayControl)
          : null;
        const result = await calculateCycleScoring({
          picks,
          cycleNumber: cycle.cycleNumber,
          season: dataSeason,
          requiredGamesPerCycle,
          scoringRules,
          expectedRosterSlotIdsByOwner:
            cycle.expectedRosterSlotIdsByOwner ?? {},
          previousResult:
            previous?.season === snapshotSeason &&
            previous.scoringRulesFingerprint === scoringRulesFingerprint
              ? previous.result
              : null,
          replayGamesByAssetKey: replayContext?.gamesByAssetKey,
          gameLogSeason: replayControl?.sourceSeason,
        });
        const published = await publishCycleSnapshot(
          leagueId,
          workerId,
          cycle,
          snapshotSeason,
          result,
          scoringRulesFingerprint,
          previous,
        );

        if (published) {
          publishedSnapshotCount += 1;
        } else {
          skippedSnapshotCount += 1;
        }

        allResults.push(result);

        const changedPeriod = await persistServerScoring(
          leagueId,
          teams,
          cycle,
          picks,
          result,
          dataSeason,
          scoringRules,
          replayContext?.gamesByAssetKey,
          replayControl?.sourceSeason,
          projectionRefreshPolicy,
        );

        passTransitionOccurred =
          passTransitionOccurred || changedPeriod;
      }

      const refreshedActiveCycles = await getActiveLeagueCycles(leagueId);
      const refreshedCycleNumbers = refreshedActiveCycles.map(
        (cycle) => cycle.cycleNumber,
      );
      const openedNewCycle = refreshedCycleNumbers.some(
        (cycleNumber) => !previousCycleNumbers.has(cycleNumber),
      );

      transitionOccurred =
        transitionOccurred ||
        passTransitionOccurred ||
        openedNewCycle;

      if (!passTransitionOccurred && !openedNewCycle) {
        activeCycleNumbers = refreshedCycleNumbers;
        break;
      }
    }

    const refreshDelay = getLiveScoringRefreshDelay(
      allResults,
      transitionOccurred,
    );
    const nextRefreshAtMilliseconds = Date.now() + refreshDelay;

    await getControlRef(leagueId).set(
      {
        id: 'control',
        schemaVersion: 2,
        automationMode: replayControl ? 'historical-replay' : 'server',
        serverAutomationEnabled: true,
        historicalReplayEnabled: Boolean(replayControl),
        historicalReplayDate: replayControl?.simulatedDate ?? null,
        status: 'idle',
        holderUserId: null,
        holderClientId: '',
        leaseExpiresAt: Timestamp.fromMillis(Date.now()),
        nextRefreshAt: Timestamp.fromMillis(nextRefreshAtMilliseconds),
        lastRefreshCompletedAt: FieldValue.serverTimestamp(),
        lastRefreshReason: trigger,
        serverTrigger: trigger,
        serverHeartbeatAt: FieldValue.serverTimestamp(),
        lastRefreshDurationMs: Math.max(0, Date.now() - startedAt),
        lastPublishedSnapshotCount: publishedSnapshotCount,
        lastSkippedSnapshotWriteCount: skippedSnapshotCount,
        totalSuccessfulRefreshCount: FieldValue.increment(1),
        totalPublishedSnapshotCount:
          FieldValue.increment(publishedSnapshotCount),
        totalSkippedSnapshotWriteCount:
          FieldValue.increment(skippedSnapshotCount),
        activeCycleNumbers,
        cycleOneCreatedInLastRun: cycleOneCreated,
        lastError: '',
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    await recordLeagueAutomationSuccess(
      leagueId,
      trigger,
      nextRefreshAtMilliseconds,
      Date.now() - startedAt,
      publishedSnapshotCount,
      skippedSnapshotCount,
    ).catch((error) => {
      console.error('League scoring completed, but its queue schedule was not recorded.', {
        leagueId,
        trigger,
        error,
      });
    });

    return {
      leagueId,
      status: 'success',
      activeCycleNumbers,
      publishedSnapshotCount,
      skippedSnapshotCount,
      cycleOneCreated,
      durationMilliseconds: Date.now() - startedAt,
      nextRefreshAtMilliseconds,
    };
  } catch (error: unknown) {
    const message = error instanceof Error
      ? error.message
      : 'Server league automation failed.';

    await getControlRef(leagueId).set(
      {
        id: 'control',
        schemaVersion: 2,
        automationMode: replayControl ? 'historical-replay' : 'server',
        serverAutomationEnabled: true,
        historicalReplayEnabled: Boolean(replayControl),
        historicalReplayDate: replayControl?.simulatedDate ?? null,
        status: 'error',
        holderUserId: null,
        holderClientId: '',
        leaseExpiresAt: Timestamp.fromMillis(Date.now()),
        nextRefreshAt: Timestamp.fromMillis(
          Date.now() + ERROR_RETRY_INTERVAL_MILLISECONDS,
        ),
        lastRefreshReason: trigger,
        serverTrigger: trigger,
        serverHeartbeatAt: FieldValue.serverTimestamp(),
        lastError: message.slice(0, 500),
        totalFailedRefreshCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    ).catch(() => undefined);

    await recordLeagueAutomationFailure(leagueId, trigger, error)
      .catch((scheduleError) => {
        console.error('Unable to record the failed league-automation schedule.', {
          leagueId,
          trigger,
          scheduleError,
        });
      });

    throw error;
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, milliseconds));
  });
}

/**
 * A manual replay step can briefly overlap the final seconds of a worker that
 * already owned the league lease. Scheduled scoring now excludes replay-enabled
 * leagues, so retries are deliberately short. Reprocessing the same saved
 * simulated date is safe because scoring is ledger-based and the replay date is
 * advanced only once before this helper runs.
 */
async function runHistoricalReplayAutomationWithRetry(
  leagueId: string,
): Promise<LeagueAutomationResult> {
  let lastResult: LeagueAutomationResult | null = null;

  for (const retryDelay of HISTORICAL_REPLAY_LEASE_RETRY_DELAYS_MILLISECONDS) {
    if (retryDelay > 0) {
      await delay(retryDelay);
    }

    const result = await runLeagueAutomation(
      leagueId,
      true,
      'historical-replay',
    );
    lastResult = result;

    if (result.status !== 'skipped') {
      return result;
    }
  }

  return lastResult ?? {
    leagueId,
    status: 'skipped',
    skipReason: 'unknown',
    activeCycleNumbers: [],
    publishedSnapshotCount: 0,
    skippedSnapshotCount: 0,
    cycleOneCreated: false,
    durationMilliseconds: 0,
  };
}

async function getCompletedDraftLeagueIds(): Promise<string[]> {
  const draftSnapshot = await db.collectionGroup('draft')
    .where('status', '==', 'complete')
    .get();

  return [...new Set(
    draftSnapshot.docs
      .filter((document) => document.id === 'current')
      .map((document) => document.ref.parent.parent?.id ?? '')
      .filter(Boolean),
  )].sort();
}

async function mapWithConcurrency<TValue, TResult>(
  values: TValue[],
  worker: (value: TValue) => Promise<TResult>,
  concurrency = MAX_PARALLEL_LEAGUES,
): Promise<Array<PromiseSettledResult<TResult>>> {
  const results: Array<PromiseSettledResult<TResult>> = [];
  let nextIndex = 0;

  async function consume(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;

      try {
        const value = await worker(values[index]);
        results[index] = {
          status: 'fulfilled',
          value,
        };
      } catch (reason: unknown) {
        results[index] = {
          status: 'rejected',
          reason,
        };
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), values.length) },
      () => consume(),
    ),
  );

  return results;
}

function normalizeDueLeagueAutomationSchedule(
  leagueId: string,
  value: DocumentData | undefined,
): DueLeagueAutomationSchedule | null {
  const expectedDueAtMilliseconds = toMilliseconds(value?.['nextScoringAt']);

  if (!leagueId || expectedDueAtMilliseconds <= 0 || value?.['scoringEnabled'] === false) {
    return null;
  }

  return {
    leagueId,
    expectedDueAtMilliseconds,
    queueStatus:
      typeof value?.['queueStatus'] === 'string'
        ? value['queueStatus']
        : 'idle',
    activeTaskId:
      typeof value?.['activeTaskId'] === 'string'
        ? value['activeTaskId']
        : '',
    activeTaskLeaseExpiresAtMilliseconds: toMilliseconds(
      value?.['activeTaskLeaseExpiresAt'],
    ),
  };
}

async function getDueLeagueAutomationSchedules(
  nowMilliseconds: number,
  scanLimit: number,
): Promise<DueLeagueAutomationSchedule[]> {
  const snapshot = await db.collection('leagueAutomationSchedules')
    .where('nextScoringAt', '<=', Timestamp.fromMillis(nowMilliseconds))
    .orderBy('nextScoringAt', 'asc')
    .limit(Math.min(LEAGUE_AUTOMATION_QUEUE_MAX_SCAN_LIMIT, Math.max(1, scanLimit)))
    .get();

  return snapshot.docs
    .map((document) => normalizeDueLeagueAutomationSchedule(
      document.id,
      document.data(),
    ))
    .filter((entry): entry is DueLeagueAutomationSchedule => Boolean(entry));
}

function isLeagueAutomationScheduleActive(
  schedule: DueLeagueAutomationSchedule,
  nowMilliseconds: number,
): boolean {
  return (
    (schedule.queueStatus === 'queued' || schedule.queueStatus === 'processing') &&
    schedule.activeTaskLeaseExpiresAtMilliseconds > nowMilliseconds
  );
}

async function countActiveLeagueAutomationTasks(
  nowMilliseconds: number,
): Promise<number> {
  const snapshot = await db.collection('leagueAutomationSchedules')
    .where(
      'activeTaskLeaseExpiresAt',
      '>',
      Timestamp.fromMillis(nowMilliseconds),
    )
    .limit(LEAGUE_AUTOMATION_QUEUE_MAX_PENDING_TASKS)
    .get();

  return snapshot.docs.filter((document) => {
    const queueStatus = document.data()['queueStatus'];
    return queueStatus === 'queued' || queueStatus === 'processing';
  }).length;
}

async function getLeagueAutomationDispatchSchedules(
  config: LeagueAutomationQueueConfig,
  nowMilliseconds: number,
  scanLimit: number,
): Promise<{
  dueSchedules: DueLeagueAutomationSchedule[];
  eligibleSchedules: DueLeagueAutomationSchedule[];
}> {
  if (config.mode === 'canary') {
    const refs = config.canaryLeagueIds.map((leagueId) =>
      getLeagueAutomationScheduleRef(leagueId),
    );
    const snapshots = refs.length > 0 ? await db.getAll(...refs) : [];
    const dueSchedules = snapshots
      .map((snapshot) => normalizeDueLeagueAutomationSchedule(
        snapshot.id,
        snapshot.data(),
      ))
      .filter((entry): entry is DueLeagueAutomationSchedule =>
        entry !== null && entry.expectedDueAtMilliseconds <= nowMilliseconds
      )
      .sort((left, right) =>
        left.expectedDueAtMilliseconds - right.expectedDueAtMilliseconds
      );

    return {
      dueSchedules,
      eligibleSchedules: dueSchedules,
    };
  }

  const dueSchedules = await getDueLeagueAutomationSchedules(
    nowMilliseconds,
    scanLimit,
  );

  return {
    dueSchedules,
    eligibleSchedules: dueSchedules.filter((schedule) =>
      isLeagueEligibleForQueueMode(schedule, config)
    ),
  };
}

function isLeagueEligibleForQueueMode(
  schedule: DueLeagueAutomationSchedule,
  config: LeagueAutomationQueueConfig,
): boolean {
  if (config.mode === 'shadow') {
    return false;
  }

  if (config.mode === 'canary') {
    return config.canaryLeagueIds.includes(schedule.leagueId);
  }

  return true;
}

function buildLeagueAutomationTaskPayload(
  schedule: DueLeagueAutomationSchedule,
  reason: LeagueAutomationTaskPayload['reason'],
): LeagueAutomationTaskPayload {
  return {
    taskSchemaVersion: LEAGUE_AUTOMATION_QUEUE_SCHEMA_VERSION,
    leagueId: schedule.leagueId,
    expectedDueAtMilliseconds: Math.trunc(schedule.expectedDueAtMilliseconds),
    dueBucket: getLeagueAutomationDueBucket(schedule.expectedDueAtMilliseconds),
    reason,
  };
}

async function claimLeagueAutomationTask(
  payload: LeagueAutomationTaskPayload,
  taskId: string,
): Promise<boolean> {
  const scheduleRef = getLeagueAutomationScheduleRef(payload.leagueId);
  const taskRef = getLeagueAutomationTaskRef(taskId);
  const now = Date.now();

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(scheduleRef);

    if (!snapshot.exists) {
      return false;
    }

    const data = snapshot.data() ?? {};
    const nextScoringAt = toMilliseconds(data['nextScoringAt']);
    const activeTaskLeaseExpiresAt = toMilliseconds(data['activeTaskLeaseExpiresAt']);
    const activeTaskId =
      typeof data['activeTaskId'] === 'string'
        ? data['activeTaskId']
        : '';
    const queueStatus =
      typeof data['queueStatus'] === 'string'
        ? data['queueStatus']
        : 'idle';
    const alreadyActive =
      (queueStatus === 'queued' || queueStatus === 'processing') &&
      activeTaskLeaseExpiresAt > now;

    if (
      data['scoringEnabled'] === false ||
      nextScoringAt <= 0 ||
      nextScoringAt > now ||
      nextScoringAt !== payload.expectedDueAtMilliseconds
    ) {
      return false;
    }

    if (alreadyActive && activeTaskId !== taskId) {
      return false;
    }

    transaction.set(
      scheduleRef,
      {
        queueStatus: 'queued',
        activeTaskId: taskId,
        activeTaskDueAt: Timestamp.fromMillis(payload.expectedDueAtMilliseconds),
        activeTaskLeaseExpiresAt: Timestamp.fromMillis(
          now + LEAGUE_AUTOMATION_QUEUED_TASK_LEASE_MILLISECONDS,
        ),
        lastEnqueuedAt: FieldValue.serverTimestamp(),
        lastEnqueuedTaskId: taskId,
        lastEnqueuedDueBucket: payload.dueBucket,
        lastQueueReason: payload.reason,
        lastQueueError: '',
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    transaction.set(
      taskRef,
      {
        schemaVersion: LEAGUE_AUTOMATION_QUEUE_SCHEMA_VERSION,
        taskId,
        leagueId: payload.leagueId,
        expectedDueAt: Timestamp.fromMillis(payload.expectedDueAtMilliseconds),
        dueBucket: payload.dueBucket,
        reason: payload.reason,
        status: 'queued',
        attemptCount: 0,
        queuedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return true;
  });
}

async function releaseFailedLeagueAutomationEnqueue(
  payload: LeagueAutomationTaskPayload,
  taskId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error
    ? error.message
    : 'Cloud Tasks rejected the league scoring task.';
  const retryAt = Date.now() + 60_000;

  await Promise.all([
    getLeagueAutomationScheduleRef(payload.leagueId).set(
      {
        queueStatus: 'error',
        activeTaskId: null,
        activeTaskLeaseExpiresAt: FieldValue.delete(),
        nextScoringAt: Timestamp.fromMillis(retryAt),
        lastQueueError: message.slice(0, 500),
        lastQueueErrorCode: getSafeAutomationErrorCode(error),
        lastQueueErrorAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    ),
    getLeagueAutomationTaskRef(taskId).set(
      {
        status: 'enqueue-error',
        lastError: message.slice(0, 500),
        lastErrorCode: getSafeAutomationErrorCode(error),
        expiresAt: Timestamp.fromMillis(
          Date.now() + LEAGUE_AUTOMATION_TASK_HISTORY_RETENTION_MILLISECONDS,
        ),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    ),
  ]);
}

async function enqueueLeagueAutomationSchedule(
  schedule: DueLeagueAutomationSchedule,
  reason: LeagueAutomationTaskPayload['reason'],
): Promise<'enqueued' | 'active' | 'stale'> {
  const now = Date.now();

  if (isLeagueAutomationScheduleActive(schedule, now)) {
    return 'active';
  }

  const payload = buildLeagueAutomationTaskPayload(schedule, reason);
  const taskId = buildLeagueAutomationTaskId(payload);
  const claimed = await claimLeagueAutomationTask(payload, taskId);

  if (!claimed) {
    return 'stale';
  }

  try {
    await getLeagueAutomationTaskQueue().enqueue(payload, {
      id: taskId,
      dispatchDeadlineSeconds: LEAGUE_AUTOMATION_TASK_DISPATCH_DEADLINE_SECONDS,
    });

    return 'enqueued';
  } catch (error: unknown) {
    if (isLeagueAutomationTaskAlreadyExistsError(error)) {
      return 'enqueued';
    }

    await releaseFailedLeagueAutomationEnqueue(payload, taskId, error);
    throw error;
  }
}

async function markLeagueAutomationTaskCompleted(
  payload: LeagueAutomationTaskPayload,
  taskId: string,
  result: LeagueAutomationResult,
  startedAt: number,
): Promise<void> {
  const scheduleRef = getLeagueAutomationScheduleRef(payload.leagueId);
  const taskRef = getLeagueAutomationTaskRef(taskId);

  await db.runTransaction(async (transaction) => {
    const scheduleSnapshot = await transaction.get(scheduleRef);
    const scheduleData = scheduleSnapshot.data() ?? {};
    const activeTaskId =
      typeof scheduleData['activeTaskId'] === 'string'
        ? scheduleData['activeTaskId']
        : '';

    if (activeTaskId === taskId) {
      const scheduleCompletionData: Record<string, unknown> = {
        queueStatus: result.status === 'success' ? 'idle' : 'skipped',
        activeTaskId: null,
        activeTaskLeaseExpiresAt: FieldValue.delete(),
        lastQueueCompletedAt: FieldValue.serverTimestamp(),
        lastQueueTaskId: taskId,
        lastQueueTaskDurationMilliseconds: Math.max(0, Date.now() - startedAt),
        lastQueueTaskOutcome: result.status,
        lastQueueTaskSkipReason: result.skipReason ?? '',
        lastQueueError: '',
        updatedAt: FieldValue.serverTimestamp(),
      };

      if (
        result.status === 'skipped' &&
        result.skipReason === 'not-due' &&
        typeof result.nextRefreshAtMilliseconds === 'number'
      ) {
        scheduleCompletionData['nextScoringAt'] = Timestamp.fromMillis(
          result.nextRefreshAtMilliseconds,
        );
      }

      transaction.set(
        scheduleRef,
        scheduleCompletionData,
        { merge: true },
      );
    }

    transaction.set(
      taskRef,
      {
        status: result.status === 'success' ? 'completed' : 'skipped',
        skipReason: result.skipReason ?? '',
        durationMilliseconds: Math.max(0, Date.now() - startedAt),
        publishedSnapshotCount: result.publishedSnapshotCount,
        skippedSnapshotCount: result.skippedSnapshotCount,
        activeCycleNumbers: result.activeCycleNumbers,
        completedAt: FieldValue.serverTimestamp(),
        expiresAt: Timestamp.fromMillis(
          Date.now() + LEAGUE_AUTOMATION_TASK_HISTORY_RETENTION_MILLISECONDS,
        ),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
}

async function markLeagueAutomationTaskRetrying(
  payload: LeagueAutomationTaskPayload,
  taskId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error
    ? error.message
    : 'Queued league scoring failed.';
  const leaseExpiresAt =
    Date.now() + LEAGUE_AUTOMATION_PROCESSING_TASK_LEASE_MILLISECONDS;

  await Promise.all([
    getLeagueAutomationScheduleRef(payload.leagueId).set(
      {
        queueStatus: 'processing',
        activeTaskId: taskId,
        activeTaskLeaseExpiresAt: Timestamp.fromMillis(leaseExpiresAt),
        lastQueueError: message.slice(0, 500),
        lastQueueErrorCode: getSafeAutomationErrorCode(error),
        lastQueueErrorAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    ),
    getLeagueAutomationTaskRef(taskId).set(
      {
        status: 'retrying',
        lastError: message.slice(0, 500),
        lastErrorCode: getSafeAutomationErrorCode(error),
        lastAttemptAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    ),
  ]);
}

async function getLegacySweepLeagueIds(
  config: LeagueAutomationQueueConfig,
  nowMilliseconds: number,
): Promise<string[]> {
  const recoveryCutoff =
    nowMilliseconds - LEAGUE_AUTOMATION_RECOVERY_STALE_MILLISECONDS;
  const needsLegacyRecovery = (data: DocumentData | undefined): boolean => {
    const nextScoringAt = toMilliseconds(data?.['nextScoringAt']);
    const queueStatus =
      typeof data?.['queueStatus'] === 'string'
        ? data['queueStatus']
        : 'idle';
    const activeLeaseExpiresAt = toMilliseconds(data?.['activeTaskLeaseExpiresAt']);
    const activeTaskStillHealthy =
      (queueStatus === 'queued' || queueStatus === 'processing') &&
      activeLeaseExpiresAt > nowMilliseconds;

    return data?.['scoringEnabled'] !== false &&
      nextScoringAt > 0 &&
      nextScoringAt <= recoveryCutoff &&
      !activeTaskStillHealthy;
  };

  if (config.mode === 'primary') {
    const staleSnapshot = await db.collection('leagueAutomationSchedules')
      .where(
        'nextScoringAt',
        '<=',
        Timestamp.fromMillis(recoveryCutoff),
      )
      .orderBy('nextScoringAt', 'asc')
      .limit(LEAGUE_AUTOMATION_STALE_TASK_SWEEP_LIMIT)
      .get();

    return staleSnapshot.docs
      .filter((document) => needsLegacyRecovery(document.data()))
      .map((document) => document.id);
  }

  const leagueIds = await getCompletedDraftLeagueIds();

  if (config.mode !== 'canary' || config.canaryLeagueIds.length === 0) {
    return leagueIds;
  }

  const canarySet = new Set(config.canaryLeagueIds);
  const canaryRefs = config.canaryLeagueIds.map((leagueId) =>
    getLeagueAutomationScheduleRef(leagueId),
  );
  const canarySchedules = canaryRefs.length > 0
    ? await db.getAll(...canaryRefs)
    : [];
  const canarySchedulesById = new Map(
    canarySchedules.map((snapshot) => [snapshot.id, snapshot]),
  );

  return leagueIds.filter((leagueId) => {
    if (!canarySet.has(leagueId)) {
      return true;
    }

    const schedule = canarySchedulesById.get(leagueId);
    return !schedule?.exists || needsLegacyRecovery(schedule.data());
  });
}

async function bootstrapMissingLeagueAutomationSchedules(): Promise<{
  completedDraftLeagueCount: number;
  existingScheduleCount: number;
  createdScheduleCount: number;
  repairedScheduleCount: number;
}> {
  const leagueIds = await getCompletedDraftLeagueIds();
  const now = Date.now();
  let existingScheduleCount = 0;
  let createdScheduleCount = 0;
  let repairedScheduleCount = 0;

  for (let offset = 0; offset < leagueIds.length; offset += LEAGUE_AUTOMATION_BOOTSTRAP_BATCH_LIMIT) {
    const batchIds = leagueIds.slice(offset, offset + LEAGUE_AUTOMATION_BOOTSTRAP_BATCH_LIMIT);
    const refs = batchIds.map((leagueId) => getLeagueAutomationScheduleRef(leagueId));
    const snapshots = refs.length > 0 ? await db.getAll(...refs) : [];
    const writeBatch = db.batch();
    let batchWriteCount = 0;

    snapshots.forEach((snapshot, index) => {
      if (snapshot.exists) {
        const data = snapshot.data() ?? {};
        const queueStatus =
          typeof data['queueStatus'] === 'string'
            ? data['queueStatus']
            : 'idle';
        const activeTaskHealthy =
          (queueStatus === 'queued' || queueStatus === 'processing') &&
          toMilliseconds(data['activeTaskLeaseExpiresAt']) > now;
        const scheduleComplete =
          data['scoringEnabled'] === false ||
          toMilliseconds(data['nextScoringAt']) > 0 ||
          activeTaskHealthy;

        if (scheduleComplete) {
          existingScheduleCount += 1;
          return;
        }
      }

      const leagueId = batchIds[index];
      const repairingExistingSchedule = snapshot.exists;
      writeBatch.set(
        refs[index],
        {
          schemaVersion: LEAGUE_AUTOMATION_QUEUE_SCHEMA_VERSION,
          leagueId,
          shard: getLeagueAutomationShard(leagueId),
          scoringEnabled: true,
          queueStatus: 'idle',
          activeTaskId: null,
          activeTaskDueAt: FieldValue.delete(),
          activeTaskLeaseExpiresAt: FieldValue.delete(),
          nextScoringAt: Timestamp.fromMillis(now),
          lastOutcome: repairingExistingSchedule
            ? 'bootstrap-repair'
            : 'bootstrap',
          consecutiveFailureCount: 0,
          ...(repairingExistingSchedule
            ? { lastBootstrapRepairAt: FieldValue.serverTimestamp() }
            : { createdAt: FieldValue.serverTimestamp() }),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      if (repairingExistingSchedule) {
        repairedScheduleCount += 1;
      } else {
        createdScheduleCount += 1;
      }
      batchWriteCount += 1;
    });

    if (batchWriteCount > 0) {
      await writeBatch.commit();
    }
  }

  return {
    completedDraftLeagueCount: leagueIds.length,
    existingScheduleCount,
    createdScheduleCount,
    repairedScheduleCount,
  };
}


export const getLeagueAutomationQueueControlCenter = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 60,
    memory: '512MiB',
    maxInstances: 5,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<LeagueAutomationQueueAdminSnapshot> => {
    await requireLeagueAutomationPlatformAdmin(request);
    const data = request.data && typeof request.data === 'object'
      ? request.data as Record<string, unknown>
      : {};
    const focusLeagueId = getLeagueAutomationString(data['focusLeagueId']);

    if (
      focusLeagueId &&
      !/^[A-Za-z0-9_-]{6,128}$/.test(focusLeagueId)
    ) {
      throw new HttpsError('invalid-argument', 'The focus league id is invalid.');
    }

    return buildLeagueAutomationQueueAdminSnapshot(focusLeagueId);
  },
);

export const updateLeagueAutomationQueueConfig = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 60,
    memory: '512MiB',
    maxInstances: 3,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<{
    updated: boolean;
    revision: number;
    mode: LeagueAutomationQueueMode;
    message: string;
  }> => {
    const adminId = await requireLeagueAutomationPlatformAdmin(request);
    const data = request.data && typeof request.data === 'object'
      ? request.data as Record<string, unknown>
      : {};
    const requestId = normalizeLeagueAutomationAdminRequestId(data['requestId']);
    const requestedMode = data['mode'];
    const mode: LeagueAutomationQueueMode =
      requestedMode === 'shadow' ||
      requestedMode === 'canary' ||
      requestedMode === 'primary'
        ? requestedMode
        : 'shadow';
    const canaryLeagueIds = normalizeLeagueAutomationCanaryIds(
      data['canaryLeagueIds'],
    );
    const internalTestLeagueIds = normalizeLeagueAutomationInternalTestIds(
      data['internalTestLeagueIds'],
    );
    const maxEnqueuePerRun = normalizeLeagueAutomationMaxEnqueuePerRun(
      data['maxEnqueuePerRun'],
    );
    const expectedRevision = normalizeLeagueAutomationRevision(
      data['expectedRevision'],
    );
    const confirmationText = getLeagueAutomationString(data['confirmationText']);
    const changeReason = normalizeLeagueAutomationChangeReason(data['changeReason']);

    if (
      requestedMode !== 'shadow' &&
      requestedMode !== 'canary' &&
      requestedMode !== 'primary'
    ) {
      throw new HttpsError('invalid-argument', 'Choose shadow, canary, or primary mode.');
    }

    if (changeReason.length < 8) {
      throw new HttpsError(
        'invalid-argument',
        'Add a short reason for this queue configuration change.',
      );
    }

    if (mode === 'canary') {
      if (canaryLeagueIds.length === 0) {
        throw new HttpsError(
          'failed-precondition',
          'Select at least one completed live league before enabling canary mode.',
        );
      }

      if (confirmationText !== LEAGUE_AUTOMATION_CANARY_CONFIRMATION) {
        throw new HttpsError(
          'failed-precondition',
          `Type “${LEAGUE_AUTOMATION_CANARY_CONFIRMATION}” exactly before enabling canary mode.`,
        );
      }
    }

    if (mode !== 'shadow') {
      await Promise.all([
        validateLeagueAutomationAdminLeagueIds(canaryLeagueIds, true),
        validateLeagueAutomationAdminLeagueIds(internalTestLeagueIds, false),
      ]);
    }

    const currentConfig = await getLeagueAutomationQueueConfig();

    if (mode === 'primary') {
      await assertLeagueAutomationPrimaryPromotionAllowed(
        currentConfig,
        confirmationText,
      );
    }

    const configRef = db.doc('appData/leagueAutomationQueueConfig');
    const healthRef = db.doc('appData/leagueAutomation');
    const approvalRef = db.doc('appData/leagueAutomationPrimaryApproval');
    const auditRef = getLeagueAutomationAuditRef(requestId);
    const projectId = getLeagueAutomationProjectId();
    const environment = getLeagueAutomationEnvironment(projectId);
    const transactionResult = await db.runTransaction(async (transaction) => {
      const [configSnapshot, auditSnapshot, healthSnapshot, approvalSnapshot] = await Promise.all([
        transaction.get(configRef),
        transaction.get(auditRef),
        transaction.get(healthRef),
        transaction.get(approvalRef),
      ]);
      const configData = configSnapshot.data() ?? {};
      const before: LeagueAutomationQueueConfig = {
        mode: normalizeLeagueAutomationQueueMode(configData['mode']),
        canaryLeagueIds: normalizeLeagueAutomationCanaryIds(
          configData['canaryLeagueIds'],
        ),
        internalTestLeagueIds: normalizeLeagueAutomationInternalTestIds(
          configData['internalTestLeagueIds'],
        ),
        maxEnqueuePerRun: normalizeLeagueAutomationMaxEnqueuePerRun(
          configData['maxEnqueuePerRun'],
        ),
        canarySuccessBaseline: normalizeLeagueAutomationRevision(
          configData['canarySuccessBaseline'],
        ),
        revision: normalizeLeagueAutomationRevision(configData['revision']),
      };

      if (auditSnapshot.exists) {
        const auditData = auditSnapshot.data() ?? {};
        return {
          updated: false,
          revision: normalizeLeagueAutomationRevision(
            auditData['revisionAfter'],
          ),
          mode: normalizeLeagueAutomationQueueMode(auditData['modeAfter']),
          message: 'This exact queue configuration request was already applied.',
        };
      }

      if (before.revision !== expectedRevision) {
        throw new HttpsError(
          'aborted',
          'The scoring queue configuration changed in another tab. Refresh before saving again.',
        );
      }

      if (mode === 'primary' && before.mode !== 'canary') {
        throw new HttpsError(
          'failed-precondition',
          'Promote from canary mode only. Shadow cannot jump directly to primary.',
        );
      }

      if (mode === 'primary') {
        const transactionGates = buildLeagueAutomationPromotionGates({
          config: before,
          health: healthSnapshot.data(),
          approval: normalizeLeagueAutomationPrimaryApproval(
            approvalSnapshot.data(),
          ),
          projectId,
          environment,
        });
        const failedTransactionGates = transactionGates.filter(
          (gate) => gate.blocking && !gate.passed,
        );

        if (failedTransactionGates.length > 0) {
          throw new HttpsError(
            'failed-precondition',
            `Primary mode remains locked: ${failedTransactionGates.map((gate) => gate.label).join('; ')}.`,
          );
        }
      }

      const canaryLeagueSelectionChanged =
        JSON.stringify(before.canaryLeagueIds) !== JSON.stringify(canaryLeagueIds);
      const enteringOrChangingCanary =
        mode === 'canary' &&
        (before.mode !== 'canary' || canaryLeagueSelectionChanged);
      const currentQueueSuccessCount = getLeagueAutomationNumber(
        healthSnapshot.data()?.['queueTaskSuccessCount'],
      ) ?? 0;
      const nextCanarySuccessBaseline = enteringOrChangingCanary
        ? currentQueueSuccessCount
        : before.canarySuccessBaseline;
      const unchanged =
        before.mode === mode &&
        before.maxEnqueuePerRun === maxEnqueuePerRun &&
        !canaryLeagueSelectionChanged &&
        JSON.stringify(before.internalTestLeagueIds) === JSON.stringify(internalTestLeagueIds);

      if (unchanged) {
        transaction.set(
          auditRef,
          {
            schemaVersion: 1,
            action: 'configuration-no-change',
            requestId,
            adminId,
            projectId,
            environment,
            modeBefore: before.mode,
            modeAfter: before.mode,
            canaryLeagueIdsBefore: before.canaryLeagueIds,
            canaryLeagueIdsAfter: before.canaryLeagueIds,
            internalTestLeagueIdsBefore: before.internalTestLeagueIds,
            internalTestLeagueIdsAfter: before.internalTestLeagueIds,
            maxEnqueuePerRunBefore: before.maxEnqueuePerRun,
            maxEnqueuePerRunAfter: before.maxEnqueuePerRun,
            canarySuccessBaselineBefore: before.canarySuccessBaseline,
            canarySuccessBaselineAfter: before.canarySuccessBaseline,
            revisionBefore: before.revision,
            revisionAfter: before.revision,
            reason: changeReason,
            createdAt: FieldValue.serverTimestamp(),
          },
          { merge: false },
        );

        return {
          updated: false,
          revision: before.revision,
          mode: before.mode,
          message: 'No scoring queue settings changed.',
        };
      }

      const nextRevision = before.revision + 1;
      const action = mode !== before.mode
        ? mode === 'shadow'
          ? 'queue-returned-to-shadow'
          : mode === 'canary'
            ? 'queue-promoted-to-canary'
            : 'queue-promoted-to-primary'
        : 'queue-selection-updated';

      transaction.set(
        configRef,
        {
          schemaVersion: 2,
          mode,
          canaryLeagueIds,
          internalTestLeagueIds,
          maxEnqueuePerRun,
          canarySuccessBaseline: nextCanarySuccessBaseline,
          revision: nextRevision,
          updatedBy: adminId,
          updatedAt: FieldValue.serverTimestamp(),
          changeReason,
          configuredProjectId: projectId,
          configuredEnvironment: environment,
          lastMutationId: requestId,
        },
        { merge: true },
      );
      transaction.set(
        healthRef,
        {
          queueConfiguredMode: mode,
          queueConfiguredCanaryLeagueCount: canaryLeagueIds.length,
          queueConfiguredInternalTestLeagueCount: internalTestLeagueIds.length,
          queueConfigRevision: nextRevision,
          queueConfigUpdatedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      transaction.set(
        auditRef,
        {
          schemaVersion: 1,
          action,
          requestId,
          adminId,
          projectId,
          environment,
          modeBefore: before.mode,
          modeAfter: mode,
          canaryLeagueIdsBefore: before.canaryLeagueIds,
          canaryLeagueIdsAfter: canaryLeagueIds,
          internalTestLeagueIdsBefore: before.internalTestLeagueIds,
          internalTestLeagueIdsAfter: internalTestLeagueIds,
          maxEnqueuePerRunBefore: before.maxEnqueuePerRun,
          maxEnqueuePerRunAfter: maxEnqueuePerRun,
          canarySuccessBaselineBefore: before.canarySuccessBaseline,
          canarySuccessBaselineAfter: nextCanarySuccessBaseline,
          revisionBefore: before.revision,
          revisionAfter: nextRevision,
          reason: changeReason,
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: false },
      );

      return {
        updated: true,
        revision: nextRevision,
        mode,
        message: mode === 'shadow'
          ? 'The queued scorer returned to observation mode. The legacy scorer remains primary.'
          : mode === 'canary'
            ? `${canaryLeagueIds.length} exact league(s) are now routed through queued scoring.`
            : 'Queued scoring is now the primary live-league dispatcher for this Firebase project.',
      };
    });

    return transactionResult;
  },
);

export const queueLeagueAutomationCanaryCheck = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 60,
    memory: '512MiB',
    maxInstances: 3,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<{
    queued: boolean;
    status: 'enqueued' | 'active' | 'stale';
    taskId: string;
    message: string;
  }> => {
    const adminId = await requireLeagueAutomationPlatformAdmin(request);
    const data = request.data && typeof request.data === 'object'
      ? request.data as Record<string, unknown>
      : {};
    const requestId = normalizeLeagueAutomationAdminRequestId(data['requestId']);
    const leagueId = getLeagueAutomationString(data['leagueId']);
    const confirmationText = getLeagueAutomationString(data['confirmationText']);

    if (!/^[A-Za-z0-9_-]{6,128}$/.test(leagueId)) {
      throw new HttpsError('invalid-argument', 'Choose a valid canary league.');
    }

    if (confirmationText !== 'RUN CANARY') {
      throw new HttpsError(
        'failed-precondition',
        'Type “RUN CANARY” exactly before requesting an immediate scoring task.',
      );
    }

    const config = await getLeagueAutomationQueueConfig();

    if (config.mode !== 'canary' || !config.canaryLeagueIds.includes(leagueId)) {
      throw new HttpsError(
        'failed-precondition',
        'This league must be included in the active canary allowlist before it can run a canary check.',
      );
    }

    await validateLeagueAutomationAdminLeagueIds([leagueId], true);

    const scheduleRef = getLeagueAutomationScheduleRef(leagueId);
    const auditRef = getLeagueAutomationAuditRef(`canary-${requestId}`);
    const now = Date.now();
    const prepared = await db.runTransaction(async (transaction) => {
      const [scheduleSnapshot, auditSnapshot] = await Promise.all([
        transaction.get(scheduleRef),
        transaction.get(auditRef),
      ]);

      if (auditSnapshot.exists) {
        const auditData = auditSnapshot.data() ?? {};
        return {
          alreadyHandled: true,
          expectedDueAtMilliseconds: getLeagueAutomationNumber(
            auditData['expectedDueAtMilliseconds'],
          ) ?? now,
          activeTaskId: getLeagueAutomationString(auditData['taskId']),
          active: auditData['queueResult'] === 'active',
        };
      }

      if (!scheduleSnapshot.exists) {
        throw new HttpsError(
          'failed-precondition',
          'The scoring schedule is missing. Wait for the hourly bootstrap or refresh the control center.',
        );
      }

      const scheduleData = scheduleSnapshot.data() ?? {};
      const queueStatus = getLeagueAutomationString(
        scheduleData['queueStatus'],
        'idle',
      );
      const activeTaskId = getLeagueAutomationString(scheduleData['activeTaskId']);
      const activeLeaseExpiresAt = toMilliseconds(
        scheduleData['activeTaskLeaseExpiresAt'],
      );
      const active =
        (queueStatus === 'queued' || queueStatus === 'processing') &&
        activeLeaseExpiresAt > now;

      transaction.set(
        auditRef,
        {
          schemaVersion: 1,
          action: 'manual-canary-run-requested',
          requestId,
          adminId,
          projectId: getLeagueAutomationProjectId(),
          environment: getLeagueAutomationEnvironment(getLeagueAutomationProjectId()),
          modeBefore: config.mode,
          modeAfter: config.mode,
          canaryLeagueIdsBefore: config.canaryLeagueIds,
          canaryLeagueIdsAfter: config.canaryLeagueIds,
          internalTestLeagueIdsBefore: config.internalTestLeagueIds,
          internalTestLeagueIdsAfter: config.internalTestLeagueIds,
          maxEnqueuePerRunBefore: config.maxEnqueuePerRun,
          maxEnqueuePerRunAfter: config.maxEnqueuePerRun,
          canarySuccessBaselineBefore: config.canarySuccessBaseline,
          canarySuccessBaselineAfter: config.canarySuccessBaseline,
          revisionBefore: config.revision,
          revisionAfter: config.revision,
          leagueId,
          expectedDueAtMilliseconds: now,
          taskId: activeTaskId,
          queueResult: active ? 'active' : 'preparing',
          reason: 'Manual platform-admin canary scoring verification.',
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: false },
      );

      if (active) {
        return {
          alreadyHandled: false,
          expectedDueAtMilliseconds: now,
          activeTaskId,
          active: true,
        };
      }

      transaction.set(
        scheduleRef,
        {
          nextScoringAt: Timestamp.fromMillis(now),
          queueStatus: 'idle',
          activeTaskId: null,
          activeTaskDueAt: FieldValue.delete(),
          activeTaskLeaseExpiresAt: FieldValue.delete(),
          lastManualCanaryRequestedAt: FieldValue.serverTimestamp(),
          lastManualCanaryRequestedBy: adminId,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      return {
        alreadyHandled: false,
        expectedDueAtMilliseconds: now,
        activeTaskId: '',
        active: false,
      };
    });

    if (prepared.active) {
      return {
        queued: false,
        status: 'active',
        taskId: prepared.activeTaskId,
        message: 'This canary league already has a healthy scoring task in progress.',
      };
    }

    const schedule: DueLeagueAutomationSchedule = {
      leagueId,
      expectedDueAtMilliseconds: prepared.expectedDueAtMilliseconds,
      queueStatus: 'idle',
      activeTaskId: '',
      activeTaskLeaseExpiresAtMilliseconds: 0,
    };
    const queueResult = await enqueueLeagueAutomationSchedule(
      schedule,
      'canary-manual',
    );
    const payload = buildLeagueAutomationTaskPayload(schedule, 'canary-manual');
    const taskId = buildLeagueAutomationTaskId(payload);

    await auditRef.set(
      {
        taskId,
        queueResult,
        queuedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return {
      queued: queueResult === 'enqueued',
      status: queueResult,
      taskId,
      message: queueResult === 'enqueued'
        ? 'The exact canary league scoring task was queued. Watch its schedule status and Game Center results.'
        : queueResult === 'active'
          ? 'A scoring task became active before the manual request completed.'
          : 'The schedule changed before the canary task could be claimed. Refresh before trying again.',
    };
  },
);

export const bootstrapLeagueAutomationSchedules = onSchedule(
  {
    schedule: 'every 60 minutes',
    region: FUNCTION_REGION,
    timeoutSeconds: 540,
    memory: '512MiB',
    retryCount: 0,
    maxInstances: 1,
  },
  async () => {
    const startedAt = Date.now();
    const result = await bootstrapMissingLeagueAutomationSchedules();

    await db.doc('appData/leagueAutomation').set(
      {
        queueFoundationSchemaVersion: LEAGUE_AUTOMATION_QUEUE_SCHEMA_VERSION,
        queueScheduleCoverageCompletedDraftCount: result.completedDraftLeagueCount,
        queueScheduleCoverageExistingCount: result.existingScheduleCount,
        queueScheduleCoverageCreatedCount: result.createdScheduleCount,
        queueScheduleCoverageRepairedCount: result.repairedScheduleCount,
        queueScheduleCoverageCount:
          result.existingScheduleCount +
          result.createdScheduleCount +
          result.repairedScheduleCount,
        queueLastBootstrapDurationMilliseconds: Date.now() - startedAt,
        queueLastBootstrapAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  },
);

export const dispatchDueLeagueAutomation = onSchedule(
  {
    schedule: '* * * * *',
    region: FUNCTION_REGION,
    timeoutSeconds: 120,
    memory: '512MiB',
    retryCount: 0,
    maxInstances: 1,
  },
  async () => {
    const startedAt = Date.now();
    const now = Date.now();
    const config = await getLeagueAutomationQueueConfig();
    const scanLimit = Math.min(
      LEAGUE_AUTOMATION_QUEUE_MAX_SCAN_LIMIT,
      Math.max(
        config.maxEnqueuePerRun * 2,
        LEAGUE_AUTOMATION_QUEUE_MAX_PENDING_TASKS * 2,
      ),
    );
    const { dueSchedules, eligibleSchedules } =
      await getLeagueAutomationDispatchSchedules(
        config,
        now,
        scanLimit,
      );
    const sampleActivePendingCount = eligibleSchedules.filter((schedule) =>
      isLeagueAutomationScheduleActive(schedule, now)
    ).length;
    const activePendingCount = await countActiveLeagueAutomationTasks(now);
    const availablePendingSlots = Math.max(
      0,
      LEAGUE_AUTOMATION_QUEUE_MAX_PENDING_TASKS - activePendingCount,
    );
    const schedulesToEnqueue = eligibleSchedules
      .filter((schedule) => !isLeagueAutomationScheduleActive(schedule, now))
      .slice(
        0,
        Math.min(config.maxEnqueuePerRun, availablePendingSlots),
      );
    const results = config.mode === 'shadow'
      ? []
      : await mapWithConcurrency(
          schedulesToEnqueue,
          (schedule) => enqueueLeagueAutomationSchedule(schedule, 'scheduled'),
          10,
        );
    const enqueuedCount = results.filter(
      (result) => result.status === 'fulfilled' && result.value === 'enqueued',
    ).length;
    const activeCount = results.filter(
      (result) => result.status === 'fulfilled' && result.value === 'active',
    ).length;
    const staleCount = results.filter(
      (result) => result.status === 'fulfilled' && result.value === 'stale',
    ).length;
    const failedCount = results.filter((result) => result.status === 'rejected').length;
    const oldestDueAt = dueSchedules[0]?.expectedDueAtMilliseconds ?? null;

    await db.doc('appData/leagueAutomation').set(
      {
        queueFoundationSchemaVersion: LEAGUE_AUTOMATION_QUEUE_SCHEMA_VERSION,
        queueMode: config.mode,
        queueCanaryLeagueCount: config.canaryLeagueIds.length,
        queueScanLimit: scanLimit,
        queueDueScheduleSampleCount: dueSchedules.length,
        queueEligibleDueCount: eligibleSchedules.length,
        queueSelectedForEnqueueCount: schedulesToEnqueue.length,
        queueActivePendingTaskCount: activePendingCount,
        queueSampleActivePendingTaskCount: sampleActivePendingCount,
        queueAvailablePendingTaskSlots: availablePendingSlots,
        queueEnqueuedCount: enqueuedCount,
        queueAlreadyActiveCount: activeCount,
        queueStaleCandidateCount: staleCount,
        queueFailedEnqueueCount: failedCount,
        queueOldestDueAgeMilliseconds:
          oldestDueAt === null ? null : Math.max(0, now - oldestDueAt),
        queueTaskMaxConcurrentDispatches:
          LEAGUE_AUTOMATION_QUEUE_MAX_CONCURRENT_DISPATCHES,
        queueTaskMaxPendingTasks: LEAGUE_AUTOMATION_QUEUE_MAX_PENDING_TASKS,
        queueLastDispatchDurationMilliseconds: Date.now() - startedAt,
        queueLastDispatchAt: FieldValue.serverTimestamp(),
        queueLastDispatchStatus: failedCount > 0 ? 'partial-error' : 'success',
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('Unable to enqueue a due league automation task.', result.reason);
      }
    }
  },
);

export const processLeagueAutomationTask = onTaskDispatched<LeagueAutomationTaskPayload>(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 540,
    memory: '1GiB',
    retryConfig: {
      maxAttempts: 5,
      minBackoffSeconds: 30,
    },
    rateLimits: {
      maxConcurrentDispatches: LEAGUE_AUTOMATION_QUEUE_MAX_CONCURRENT_DISPATCHES,
    },
  },
  async (request) => {
    const payload = request.data;

    if (
      !payload ||
      payload.taskSchemaVersion !== LEAGUE_AUTOMATION_QUEUE_SCHEMA_VERSION ||
      typeof payload.leagueId !== 'string' ||
      !payload.leagueId ||
      !Number.isFinite(payload.expectedDueAtMilliseconds) ||
      typeof payload.dueBucket !== 'string' ||
      !payload.dueBucket ||
      (payload.reason !== 'scheduled' &&
        payload.reason !== 'recovery' &&
        payload.reason !== 'canary-manual')
    ) {
      console.warn('Ignored malformed league automation task.', { payload });
      return;
    }

    const taskId = buildLeagueAutomationTaskId(payload);
    const scheduleRef = getLeagueAutomationScheduleRef(payload.leagueId);
    const taskRef = getLeagueAutomationTaskRef(taskId);
    const scheduleSnapshot = await scheduleRef.get();

    if (!scheduleSnapshot.exists) {
      await taskRef.set(
        {
          status: 'skipped',
          skipReason: 'schedule-missing',
          completedAt: FieldValue.serverTimestamp(),
          expiresAt: Timestamp.fromMillis(
            Date.now() + LEAGUE_AUTOMATION_TASK_HISTORY_RETENTION_MILLISECONDS,
          ),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return;
    }

    const scheduleData = scheduleSnapshot.data() ?? {};
    const activeTaskId =
      typeof scheduleData['activeTaskId'] === 'string'
        ? scheduleData['activeTaskId']
        : '';
    const expectedDueAt = toMilliseconds(scheduleData['activeTaskDueAt']);

    if (
      scheduleData['scoringEnabled'] === false ||
      activeTaskId !== taskId ||
      expectedDueAt !== Math.trunc(payload.expectedDueAtMilliseconds)
    ) {
      await taskRef.set(
        {
          status: 'skipped',
          skipReason: scheduleData['scoringEnabled'] === false
            ? 'scoring-disabled'
            : 'stale-task',
          completedAt: FieldValue.serverTimestamp(),
          expiresAt: Timestamp.fromMillis(
            Date.now() + LEAGUE_AUTOMATION_TASK_HISTORY_RETENTION_MILLISECONDS,
          ),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return;
    }

    const startedAt = Date.now();
    await Promise.all([
      scheduleRef.set(
        {
          queueStatus: 'processing',
          activeTaskLeaseExpiresAt: Timestamp.fromMillis(
            startedAt + LEAGUE_AUTOMATION_PROCESSING_TASK_LEASE_MILLISECONDS,
          ),
          lastQueueStartedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      ),
      taskRef.set(
        {
          status: 'processing',
          attemptCount: FieldValue.increment(1),
          startedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      ),
    ]);

    try {
      const result = await runLeagueAutomation(
        payload.leagueId,
        payload.reason === 'canary-manual',
        'queue-task',
      );

      if (result.status === 'skipped' && result.skipReason === 'another-server-worker') {
        throw new Error('league-automation-lease-busy');
      }

      await markLeagueAutomationTaskCompleted(payload, taskId, result, startedAt);
      await db.doc('appData/leagueAutomation').set(
        {
          queueTaskSuccessCount: FieldValue.increment(
            result.status === 'success' ? 1 : 0,
          ),
          queueTaskSkippedCount: FieldValue.increment(
            result.status === 'skipped' ? 1 : 0,
          ),
          queueLastTaskDurationMilliseconds: Date.now() - startedAt,
          queueLastTaskCompletedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    } catch (error: unknown) {
      await markLeagueAutomationTaskRetrying(payload, taskId, error);
      await db.doc('appData/leagueAutomation').set(
        {
          queueTaskRetryAttemptCount: FieldValue.increment(1),
          queueLastTaskErrorCode: getSafeAutomationErrorCode(error),
          queueLastTaskErrorAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      throw error;
    }
  },
);

export const recoverStaleLeagueAutomationQueue = onSchedule(
  {
    schedule: 'every 5 minutes',
    region: FUNCTION_REGION,
    timeoutSeconds: 120,
    memory: '512MiB',
    retryCount: 0,
    maxInstances: 1,
  },
  async () => {
    const now = Date.now();
    const snapshot = await db.collection('leagueAutomationSchedules')
      .where('activeTaskLeaseExpiresAt', '<=', Timestamp.fromMillis(now))
      .orderBy('activeTaskLeaseExpiresAt', 'asc')
      .limit(LEAGUE_AUTOMATION_STALE_TASK_SWEEP_LIMIT)
      .get();
    let recoveredCount = 0;

    for (const document of snapshot.docs) {
      const recoveredTaskId = await db.runTransaction(async (transaction) => {
        const current = await transaction.get(document.ref);
        const data = current.data() ?? {};
        const queueStatus =
          typeof data['queueStatus'] === 'string'
            ? data['queueStatus']
            : '';
        const leaseExpiresAt = toMilliseconds(data['activeTaskLeaseExpiresAt']);
        const activeTaskId =
          typeof data['activeTaskId'] === 'string'
            ? data['activeTaskId']
            : '';

        if (
          (queueStatus !== 'queued' && queueStatus !== 'processing') ||
          leaseExpiresAt <= 0 ||
          leaseExpiresAt > now
        ) {
          return '';
        }

        transaction.set(
          document.ref,
          {
            queueStatus: 'error',
            activeTaskId: null,
            activeTaskLeaseExpiresAt: FieldValue.delete(),
            nextScoringAt: Timestamp.fromMillis(now),
            lastQueueError: 'A queued scoring worker stopped reporting progress. The league was released for a safe retry.',
            lastQueueErrorCode: 'stale-task-recovered',
            lastQueueErrorAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        return activeTaskId;
      });

      if (!recoveredTaskId) {
        continue;
      }

      recoveredCount += 1;
      await getLeagueAutomationTaskRef(recoveredTaskId).set(
        {
          status: 'stale-recovered',
          lastErrorCode: 'stale-task-recovered',
          completedAt: FieldValue.serverTimestamp(),
          expiresAt: Timestamp.fromMillis(
            Date.now() + LEAGUE_AUTOMATION_TASK_HISTORY_RETENTION_MILLISECONDS,
          ),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }

    await db.doc('appData/leagueAutomation').set(
      {
        queueRecoveredStaleTaskCount: FieldValue.increment(recoveredCount),
        queueLastRecoveryCount: recoveredCount,
        queueLastRecoveryAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  },
);

export const cleanupLeagueAutomationTaskHistory = onSchedule(
  {
    schedule: 'every 24 hours',
    region: FUNCTION_REGION,
    timeoutSeconds: 120,
    memory: '256MiB',
    retryCount: 0,
    maxInstances: 1,
  },
  async () => {
    const snapshot = await db.collection('leagueAutomationTasks')
      .where('expiresAt', '<=', Timestamp.fromMillis(Date.now()))
      .orderBy('expiresAt', 'asc')
      .limit(LEAGUE_AUTOMATION_TASK_HISTORY_CLEANUP_LIMIT)
      .get();

    if (snapshot.empty) {
      return;
    }

    const batch = db.batch();
    snapshot.docs.forEach((document) => batch.delete(document.ref));
    await batch.commit();

    await db.doc('appData/leagueAutomation').set(
      {
        queueLastTaskHistoryCleanupCount: snapshot.size,
        queueLastTaskHistoryCleanupAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  },
);

export const runScheduledLeagueAutomation = onSchedule(
  {
    schedule: 'every 10 minutes',
    region: FUNCTION_REGION,
    timeoutSeconds: 540,
    memory: '1GiB',
    retryCount: 0,
  },
  async () => {
    const startedAt = Date.now();
    const config = await getLeagueAutomationQueueConfig();
    const leagueIds = await getLegacySweepLeagueIds(config, startedAt);
    const results = await mapWithConcurrency(
      leagueIds,
      (leagueId) => runLeagueAutomation(
        leagueId,
        false,
        'scheduled',
      ),
    );
    const successful = results.filter(
      (result) =>
        result.status === 'fulfilled' &&
        result.value.status === 'success',
    ).length;
    const skipped = results.filter(
      (result) =>
        result.status === 'fulfilled' &&
        result.value.status === 'skipped',
    ).length;
    const failed = results.filter(
      (result) => result.status === 'rejected',
    ).length;

    await db.doc('appData/leagueAutomation').set(
      {
        schemaVersion: 1,
        status: failed > 0 ? 'partial-error' : 'success',
        queueFoundationSchemaVersion: LEAGUE_AUTOMATION_QUEUE_SCHEMA_VERSION,
        queueMode: config.mode,
        queueCanaryLeagueCount: config.canaryLeagueIds.length,
        legacySweepRole:
          config.mode === 'primary'
            ? 'stale-league-recovery'
            : config.mode === 'canary'
              ? 'primary-except-canary'
              : 'primary-shadow-baseline',
        completedDraftLeagueCount: leagueIds.length,
        successfulLeagueCount: successful,
        skippedLeagueCount: skipped,
        failedLeagueCount: failed,
        durationMilliseconds: Date.now() - startedAt,
        lastRunAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('A scheduled league automation run failed.', result.reason);
      }
    }
  },
);


async function getCompletedDraftLeagueIdsWithoutCycleOne(): Promise<string[]> {
  const completedDraftLeagueIds = await getCompletedDraftLeagueIds();
  const cycleReferences = completedDraftLeagueIds.map((leagueId) =>
    db.doc(`leagues/${leagueId}/cycles/cycle-1`),
  );
  const cycleSnapshots = cycleReferences.length > 0
    ? await db.getAll(...cycleReferences)
    : [];

  return completedDraftLeagueIds.filter(
    (_leagueId, index) => !cycleSnapshots[index]?.exists,
  );
}

export const runSeasonStartAutomation = onSchedule(
  {
    schedule: '* * * * *',
    timeZone: 'America/Los_Angeles',
    region: FUNCTION_REGION,
    timeoutSeconds: 540,
    memory: '1GiB',
    retryCount: 0,
    maxInstances: 1,
  },
  async () => {
    // This worker is now a recovery sweep rather than a calendar gate.
    // The draft-complete Firestore trigger starts Cycle 1 immediately; this
    // minute-by-minute pass repairs any league whose trigger was interrupted.
    const leagueIds = await getCompletedDraftLeagueIdsWithoutCycleOne();
    const results = await mapWithConcurrency(
      leagueIds,
      (leagueId) => runLeagueAutomation(
        leagueId,
        true,
        'season-start',
      ),
    );
    const failures = results.filter((result) => result.status === 'rejected');
    const completed = results.filter(
      (result) => result.status === 'fulfilled' && result.value.cycleOneCreated,
    ).length;

    await db.doc('appData/seasonAutomation').set(
      {
        schemaVersion: 2,
        enabled: true,
        mode: 'immediate-after-draft',
        status: failures.length > 0 ? 'partial-error' : 'active',
        pendingLeagueCount: failures.length,
        processedLeagueCount: leagueIds.length,
        startedCycleCount: completed,
        failedLeagueCount: failures.length,
        lastRunAt: FieldValue.serverTimestamp(),
        ...(failures.length === 0
          ? {
              lastSuccessfulRunAt: FieldValue.serverTimestamp(),
              lastError: '',
              message: leagueIds.length > 0
                ? `Recovered Cycle 1 for ${completed} completed-draft league(s).`
                : 'No completed drafts are waiting for Cycle 1.',
            }
          : {
              lastError: `${failures.length} automatic Cycle 1 recovery run(s) failed.`,
              message: `${failures.length} automatic Cycle 1 recovery run(s) failed.`,
            }),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    for (const failure of failures) {
      console.error('An automatic Cycle 1 recovery run failed.', failure.reason);
    }
  },
);

export const initializeSeasonAfterDraft = onDocumentWritten(
  {
    document: 'leagues/{leagueId}/draft/current',
    region: FUNCTION_REGION,
    timeoutSeconds: 540,
    memory: '1GiB',
    retry: false,
  },
  async (event) => {
    const beforeStatus = event.data?.before.exists
      ? (event.data.before.data() as DocumentData)['status']
      : null;
    const afterStatus = event.data?.after.exists
      ? (event.data.after.data() as DocumentData)['status']
      : null;

    if (afterStatus !== 'complete' || beforeStatus === 'complete') {
      return;
    }

    await runLeagueAutomation(
      event.params.leagueId,
      true,
      'draft-complete',
    );
  },
);

interface ManualLiveScoringRefreshResult {
  status: 'success';
  activeCycleNumbers: number[];
  publishedSnapshotCount: number;
  skippedSnapshotCount: number;
  cycleOneCreated: boolean;
  durationMilliseconds: number;
}

interface LiveScoringControlResetResult {
  reset: true;
  message: string;
}

interface OpenNextCompetitionPeriodResult {
  status: 'opened' | 'season-complete';
  currentCycleNumber: number;
  nextCycleNumber: number | null;
  nextCycleId: string | null;
  phase: FantasyCycle['phase'] | null;
  alreadyExisted: boolean;
}

function requestedLeagueId(data: unknown): string {
  if (!data || typeof data !== 'object') {
    return '';
  }

  const leagueId = (data as Record<string, unknown>)['leagueId'];
  return typeof leagueId === 'string' ? leagueId.trim() : '';
}

async function requireLeagueCommissioner(
  userId: string | undefined,
  leagueId: string,
): Promise<ServerLeague> {
  if (!userId) {
    throw new HttpsError(
      'unauthenticated',
      'You must be signed in to manage live scoring.',
    );
  }

  if (!leagueId) {
    throw new HttpsError('invalid-argument', 'A league id is required.');
  }

  const league = await getServerLeague(leagueId);

  if (!league) {
    throw new HttpsError('not-found', 'League not found.');
  }

  if (league.commissionerId !== userId) {
    throw new HttpsError(
      'permission-denied',
      'Only the league commissioner can manage live scoring.',
    );
  }

  return league;
}

/**
 * Runs the same Admin-SDK scoring path used by the ten-minute scheduler.
 * Browsers never write liveScoring/control or cycle snapshots directly.
 */
export const requestLeagueLiveScoringRefresh = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 540,
    memory: '1GiB',
    cors: TRUSTED_WEB_ORIGINS,
  },
  async (request): Promise<ManualLiveScoringRefreshResult> => {
    const leagueId = requestedLeagueId(request.data);
    await requireLeagueCommissioner(request.auth?.uid, leagueId);

    const replayControl = await getHistoricalReplayControl(leagueId);

    if (replayControl) {
      throw new HttpsError(
        'failed-precondition',
        'Live score refresh is disabled while historical replay is active. Use Advance One Day instead.',
      );
    }

    try {
      const result = await runLeagueAutomation(leagueId, true, 'manual');

      if (result.status === 'skipped') {
        throw new HttpsError(
          'aborted',
          'Another server scoring update is already finishing. Wait a moment and try again.',
        );
      }

      return {
        status: 'success',
        activeCycleNumbers: result.activeCycleNumbers,
        publishedSnapshotCount: result.publishedSnapshotCount,
        skippedSnapshotCount: result.skippedSnapshotCount,
        cycleOneCreated: result.cycleOneCreated,
        durationMilliseconds: result.durationMilliseconds,
      };
    } catch (error: unknown) {
      if (error instanceof HttpsError) {
        throw error;
      }

      const message = error instanceof Error
        ? error.message
        : 'The server scoring refresh failed.';

      throw new HttpsError('unavailable', message);
    }
  },
);

/**
 * Opens the next regular-season cycle or playoff round through the same
 * Admin-SDK lifecycle code used by scheduled scoring. This is intentionally
 * idempotent: if the next period already exists, the saved period is returned.
 */
export const openNextCompetitionPeriod = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 540,
    memory: '1GiB',
    cors: TRUSTED_WEB_ORIGINS,
  },
  async (request): Promise<OpenNextCompetitionPeriodResult> => {
    const leagueId = requestedLeagueId(request.data);
    await requireLeagueCommissioner(request.auth?.uid, leagueId);

    const rawCycleNumber =
      request.data && typeof request.data === 'object'
        ? (request.data as Record<string, unknown>)['currentCycleNumber']
        : null;
    const currentCycleNumber =
      typeof rawCycleNumber === 'number' && Number.isInteger(rawCycleNumber)
        ? rawCycleNumber
        : Number.NaN;

    if (!Number.isInteger(currentCycleNumber) || currentCycleNumber < 1) {
      throw new HttpsError(
        'invalid-argument',
        'A valid current cycle number is required.',
      );
    }

    const teams = await getLeagueTeams(leagueId);
    const nextCycleNumber = currentCycleNumber + 1;
    const nextCycleRef = db.doc(
      `leagues/${leagueId}/cycles/cycle-${nextCycleNumber}`,
    );
    const existingNextCycle = await nextCycleRef.get();

    try {
      const nextCycle = await startNextCycle(
        leagueId,
        teams,
        currentCycleNumber,
      );

      if (!nextCycle) {
        return {
          status: 'season-complete',
          currentCycleNumber,
          nextCycleNumber: null,
          nextCycleId: null,
          phase: null,
          alreadyExisted: false,
        };
      }

      // `startNextCycle` is also used as a manual recovery path. Older builds
      // could create the next period from the outgoing roster before applying
      // queued slot-boundary moves. Reconcile immediately so the roster and
      // the immutable slot snapshot agree before the manager enters the page.
      await reconcilePendingRosterMovesForRegularSeasonCycle(
        leagueId,
        teams,
        nextCycle,
      );

      return {
        status: 'opened',
        currentCycleNumber,
        nextCycleNumber: nextCycle.cycleNumber,
        nextCycleId: nextCycle.id,
        phase: nextCycle.phase,
        alreadyExisted: existingNextCycle.exists,
      };
    } catch (error: unknown) {
      if (error instanceof HttpsError) {
        throw error;
      }

      const message = error instanceof Error
        ? error.message
        : 'The next matchup period could not be opened.';

      throw new HttpsError('failed-precondition', message);
    }
  },
);

/**
 * Clears a stale browser-era lease without interrupting an active server run.
 * Kept for the diagnostics screen while the broader scoring UI is refactored.
 */
export const releaseLeagueLiveScoringHandoff = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 30,
    memory: '256MiB',
    cors: TRUSTED_WEB_ORIGINS,
  },
  async (request): Promise<LiveScoringControlResetResult> => {
    const leagueId = requestedLeagueId(request.data);
    await requireLeagueCommissioner(request.auth?.uid, leagueId);

    const controlRef = getControlRef(leagueId);
    const now = Date.now();

    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(controlRef);
      const data = snapshot.data() ?? {};
      const holderClientId =
        typeof data['holderClientId'] === 'string' ? data['holderClientId'] : '';
      const leaseExpiresAt = toMilliseconds(data['leaseExpiresAt']);
      const serverWorkerActive =
        data['status'] === 'refreshing' &&
        holderClientId.startsWith(SERVER_WORKER_PREFIX) &&
        leaseExpiresAt > now;

      if (serverWorkerActive) {
        throw new HttpsError(
          'failed-precondition',
          'A server scoring update is currently running. Wait for it to finish before resetting the control record.',
        );
      }

      transaction.set(
        controlRef,
        {
          id: 'control',
          schemaVersion: 2,
          automationMode: 'server',
          serverAutomationEnabled: true,
          status: 'idle',
          holderUserId: null,
          holderClientId: '',
          leaseExpiresAt: Timestamp.fromMillis(now),
          nextRefreshAt: Timestamp.fromMillis(now),
          lastRefreshReason: 'manual',
          serverTrigger: 'manual-control-reset',
          lastError: '',
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });

    return {
      reset: true,
      message: 'The stale live-scoring control lease was released.',
    };
  },
);

/**
 * Recovery action used by Release Readiness. It only resets an expired lease
 * or an error state and refuses to interrupt a healthy active worker.
 */
export const clearExpiredOrErroredLiveScoringLease = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 30,
    memory: '256MiB',
    cors: TRUSTED_WEB_ORIGINS,
  },
  async (request): Promise<LiveScoringControlResetResult> => {
    const leagueId = requestedLeagueId(request.data);
    await requireLeagueCommissioner(request.auth?.uid, leagueId);

    const controlRef = getControlRef(leagueId);
    const now = Date.now();

    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(controlRef);

      if (!snapshot.exists) {
        return;
      }

      const data = snapshot.data() ?? {};
      const holderClientId =
        typeof data['holderClientId'] === 'string' ? data['holderClientId'] : '';
      const leaseExpiresAt = toMilliseconds(data['leaseExpiresAt']);
      const healthyActiveLease =
        data['status'] !== 'error' &&
        Boolean(holderClientId) &&
        leaseExpiresAt > now;

      if (healthyActiveLease) {
        throw new HttpsError(
          'failed-precondition',
          'The scoring worker still has a healthy active lease. Wait for it to finish before using recovery.',
        );
      }

      transaction.set(
        controlRef,
        {
          id: 'control',
          schemaVersion: 2,
          automationMode: 'server',
          serverAutomationEnabled: true,
          status: 'idle',
          holderUserId: null,
          holderClientId: '',
          leaseExpiresAt: Timestamp.fromMillis(now),
          nextRefreshAt: Timestamp.fromMillis(now),
          lastRefreshReason: 'manual',
          serverTrigger: 'manual-recovery',
          lastError: '',
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });

    return {
      reset: true,
      message: 'The expired or errored live-scoring lease was cleared.',
    };
  },
);

async function requireHistoricalReplayReadyLeague(leagueId: string): Promise<void> {
  const league = await getServerLeague(leagueId);

  if (!league) {
    throw new HttpsError('not-found', 'League not found.');
  }

  const draftSnapshot = await db.doc(`leagues/${leagueId}/draft/current`).get();

  if (!draftSnapshot.exists || draftSnapshot.data()?.['status'] !== 'complete') {
    throw new HttpsError(
      'failed-precondition',
      'Complete the draft before starting the historical season replay.',
    );
  }
}

function getReplayRequestRetryDate(controlData: DocumentData | undefined): string | null {
  const previous = normalizeReplayControl(controlData);
  const savedFailedSimulatedDate =
    typeof controlData?.['lastFailedSimulatedDate'] === 'string'
      ? controlData['lastFailedSimulatedDate']
      : null;
  const retryLegacyFailedDate =
    previous.status === 'error' &&
    Boolean(previous.simulatedDate) &&
    !Object.prototype.hasOwnProperty.call(controlData ?? {}, 'lastFailedSimulatedDate');

  return previous.status === 'error' &&
    Boolean(previous.simulatedDate) &&
    (savedFailedSimulatedDate === previous.simulatedDate || retryLegacyFailedDate)
      ? previous.simulatedDate
      : null;
}

function isHistoricalReplayRequestStale(
  value: DocumentData | undefined,
  nowMilliseconds: number,
): boolean {
  if (!value) {
    return true;
  }

  const status = typeof value['status'] === 'string' ? value['status'] : '';
  const leaseExpiresAt = toMilliseconds(value['leaseExpiresAt']);
  const updatedAt = toMilliseconds(value['updatedAt']);

  if (status === 'processing') {
    return leaseExpiresAt <= nowMilliseconds;
  }

  if (status === 'queued') {
    return updatedAt > 0 && nowMilliseconds - updatedAt >= HISTORICAL_REPLAY_REQUEST_STALE_MILLISECONDS;
  }

  return status === 'error' || status === 'cancelled' || status === 'completed';
}

async function performHistoricalReplayAdvance(
  leagueId: string,
  userId: string,
  requestId: string,
  retrySimulatedDate: string | null,
): Promise<HistoricalReplayAdvanceResult> {
  await requireHistoricalReplayReadyLeague(leagueId);

  const controlRef = getHistoricalReplayControlRef(leagueId);
  const controlSnapshot = await controlRef.get();
  const previous = normalizeReplayControl(controlSnapshot.data());
  const retryFailedDate = Boolean(
    retrySimulatedDate && previous.simulatedDate === retrySimulatedDate,
  );
  let attemptedDate: string | null = null;

  try {
    const seasonStartDate = previous.seasonStartDate ??
      await getHistoricalReplaySeasonStartDate(HISTORICAL_REPLAY_TARGET_SEASON);
    const currentDate = retryFailedDate && previous.simulatedDate
      ? addUtcDays(previous.simulatedDate, -1)
      : previous.enabled && previous.simulatedDate
        ? previous.simulatedDate
        : addUtcDays(seasonStartDate, -1);
    const nextDate = addUtcDays(currentDate, 1);
    attemptedDate = nextDate;
    const releasedGameCount = await countNhlGamesOnReplayDate(
      nextDate,
      HISTORICAL_REPLAY_TARGET_SEASON,
    );
    const nextDaysAdvanced = retryFailedDate
      ? Math.max(1, previous.daysAdvanced)
      : previous.enabled
        ? previous.daysAdvanced + 1
        : 1;
    const nextTotalReleasedGameCount = retryFailedDate
      ? previous.totalReleasedGameCount
      : (previous.enabled ? previous.totalReleasedGameCount : 0) + releasedGameCount;

    await Promise.all([
      controlRef.set(
        {
          schemaVersion: 2,
          enabled: true,
          status: 'advancing',
          activeRequestId: requestId,
          targetSeason: HISTORICAL_REPLAY_TARGET_SEASON,
          sourceSeason: HISTORICAL_REPLAY_SOURCE_SEASON,
          seasonStartDate,
          simulatedDate: nextDate,
          daysAdvanced: nextDaysAdvanced,
          lastReleasedGameCount: releasedGameCount,
          totalReleasedGameCount: nextTotalReleasedGameCount,
          requestedBy: userId,
          lastAdvanceStartedAt: FieldValue.serverTimestamp(),
          message: retryFailedDate
            ? `Retrying the simulated NHL date ${nextDate}.`
            : `Processing the simulated NHL date ${nextDate}.`,
          lastError: '',
          lastFailedSimulatedDate: null,
          createdAt: controlSnapshot.exists
            ? controlSnapshot.data()?.['createdAt'] ?? FieldValue.serverTimestamp()
            : FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      ),
      getControlRef(leagueId).set(
        {
          id: 'control',
          schemaVersion: 2,
          automationMode: 'historical-replay',
          serverAutomationEnabled: true,
          historicalReplayEnabled: true,
          historicalReplayDate: nextDate,
          nextRefreshAt: Timestamp.fromMillis(Date.now()),
          refreshRequestedAt: FieldValue.serverTimestamp(),
          lastRefreshReason: 'manual',
          lastError: '',
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      ),
    ]);

    const result = await runHistoricalReplayAutomationWithRetry(leagueId);

    if (result.status === 'skipped') {
      throw new HttpsError(
        'aborted',
        'Another server scoring update kept the league lease through every automatic retry. The simulated date was not skipped; RinkRat will preserve this date so it can be retried safely.',
      );
    }

    const message = releasedGameCount > 0
      ? `${nextDate} processed. ${releasedGameCount} NHL ${releasedGameCount === 1 ? 'game was' : 'games were'} released into the replay ledger.`
      : `${nextDate} processed. No NHL games were scheduled, so individual player windows remained where they were.`;

    await controlRef.set(
      {
        status: 'ready',
        activeRequestId: null,
        lastCompletedRequestId: requestId,
        lastAdvanceCompletedAt: FieldValue.serverTimestamp(),
        lastActiveCycleNumbers: result.activeCycleNumbers,
        lastPublishedSnapshotCount: result.publishedSnapshotCount,
        message,
        lastError: '',
        lastFailedSimulatedDate: null,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return {
      enabled: true,
      status: 'ready',
      simulatedDate: nextDate,
      seasonStartDate,
      targetSeason: HISTORICAL_REPLAY_TARGET_SEASON,
      sourceSeason: HISTORICAL_REPLAY_SOURCE_SEASON,
      daysAdvanced: nextDaysAdvanced,
      releasedGameCount,
      activeCycleNumbers: result.activeCycleNumbers,
      message,
    };
  } catch (error: unknown) {
    const message = error instanceof Error
      ? error.message
      : 'Unable to advance the historical replay.';

    await controlRef.set(
      {
        enabled: true,
        status: 'error',
        activeRequestId: null,
        lastFailedRequestId: requestId,
        message,
        lastError: message.slice(0, 500),
        lastFailedSimulatedDate: attemptedDate,
        lastAdvanceFailedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    ).catch(() => undefined);

    throw error instanceof HttpsError
      ? error
      : new HttpsError('unavailable', message);
  }
}

export const advanceHistoricalReplayDay = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 60,
    memory: '256MiB',
    cors: TRUSTED_WEB_ORIGINS,
  },
  async (request): Promise<HistoricalReplayQueuedResult> => {
    const userId = await requireHistoricalReplayPlatformAdmin(request);
    const leagueId =
      request.data && typeof request.data.leagueId === 'string'
        ? request.data.leagueId.trim()
        : '';
    const requestId = normalizeHistoricalReplayRequestId(
      request.data && typeof request.data === 'object'
        ? (request.data as Record<string, unknown>)['requestId']
        : null,
    );

    if (!leagueId) {
      throw new HttpsError('invalid-argument', 'A league id is required.');
    }

    await requireHistoricalReplayReadyLeague(leagueId);

    const controlRef = getHistoricalReplayControlRef(leagueId);
    const requestRef = getHistoricalReplayRequestRef(requestId);
    const now = Date.now();
    const queueState = await db.runTransaction(async (transaction) => {
      const [controlSnapshot, requestSnapshot] = await Promise.all([
        transaction.get(controlRef),
        transaction.get(requestRef),
      ]);
      const controlData = controlSnapshot.data() ?? {};
      const existingRequest = requestSnapshot.data();

      if (requestSnapshot.exists) {
        if (
          existingRequest?.['leagueId'] !== leagueId ||
          existingRequest?.['requestedBy'] !== userId
        ) {
          throw new HttpsError(
            'permission-denied',
            'This replay request identifier belongs to a different operation.',
          );
        }

        return {
          retrySimulatedDate:
            typeof existingRequest?.['retrySimulatedDate'] === 'string'
              ? existingRequest['retrySimulatedDate']
              : null,
          alreadyQueued: true,
        };
      }

      const activeRequestId =
        typeof controlData['activeRequestId'] === 'string'
          ? controlData['activeRequestId']
          : '';
      const controlStatus =
        typeof controlData['status'] === 'string'
          ? controlData['status']
          : 'inactive';

      if (
        activeRequestId &&
        activeRequestId !== requestId &&
        (controlStatus === 'queued' || controlStatus === 'advancing')
      ) {
        const activeRequestRef = getHistoricalReplayRequestRef(activeRequestId);
        const activeRequestSnapshot = await transaction.get(activeRequestRef);

        if (!isHistoricalReplayRequestStale(activeRequestSnapshot.data(), now)) {
          throw new HttpsError(
            'failed-precondition',
            'This league already has a replay day queued or processing. Wait for that request to finish before adding another day.',
          );
        }

        if (activeRequestSnapshot.exists) {
          transaction.set(
            activeRequestRef,
            {
              status: 'cancelled',
              cancellationReason: 'stale-request-replaced',
              cancelledAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true },
          );
        }
      }

      const retrySimulatedDate = getReplayRequestRetryDate(controlData);
      transaction.create(requestRef, {
        documentType: 'historical-replay-advance-request',
        schemaVersion: 1,
        requestId,
        leagueId,
        requestedBy: userId,
        status: 'queued',
        retrySimulatedDate,
        targetSeason: HISTORICAL_REPLAY_TARGET_SEASON,
        sourceSeason: HISTORICAL_REPLAY_SOURCE_SEASON,
        queuedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.set(
        controlRef,
        {
          schemaVersion: 2,
          enabled: true,
          status: 'queued',
          activeRequestId: requestId,
          requestedBy: userId,
          targetSeason: HISTORICAL_REPLAY_TARGET_SEASON,
          sourceSeason: HISTORICAL_REPLAY_SOURCE_SEASON,
          message: 'Queued safely. RinkRat processes historical test leagues one at a time so they cannot compete for scoring resources.',
          lastError: '',
          queuedAt: FieldValue.serverTimestamp(),
          createdAt: controlSnapshot.exists
            ? controlData['createdAt'] ?? FieldValue.serverTimestamp()
            : FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      return {
        retrySimulatedDate,
        alreadyQueued: false,
      };
    });

    const payload: HistoricalReplayAdvanceTaskPayload = {
      requestId,
      leagueId,
      requestedBy: userId,
    };

    try {
      await getHistoricalReplayTaskQueue().enqueue(payload, {
        id: buildHistoricalReplayTaskId(payload),
        scheduleTime: new Date(Date.now() + 250),
        dispatchDeadlineSeconds: HISTORICAL_REPLAY_TASK_DISPATCH_DEADLINE_SECONDS,
      });
    } catch (error: unknown) {
      if (!isHistoricalReplayTaskAlreadyExistsError(error)) {
        const message = error instanceof Error
          ? error.message
          : 'The historical replay queue could not accept this request.';

        await Promise.all([
          requestRef.set(
            {
              status: 'error',
              lastError: message.slice(0, 500),
              failedAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true },
          ),
          controlRef.set(
            {
              status: 'error',
              activeRequestId: null,
              message,
              lastError: message.slice(0, 500),
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true },
          ),
        ]).catch(() => undefined);

        throw new HttpsError('unavailable', message);
      }
    }

    return {
      enabled: true,
      status: 'queued',
      requestId,
      message: queueState.alreadyQueued
        ? 'This replay request was already queued. RinkRat will keep following its saved status.'
        : 'Replay day queued. Multiple test leagues are processed one at a time, so you can safely queue another league without starting competing score workers.',
    };
  },
);

export const processHistoricalReplayAdvance = onTaskDispatched<HistoricalReplayAdvanceTaskPayload>(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 540,
    memory: '1GiB',
    retryConfig: {
      maxAttempts: 1,
    },
    rateLimits: {
      maxConcurrentDispatches: 1,
    },
  },
  async (request) => {
    const payload = request.data;

    if (
      !payload ||
      typeof payload.requestId !== 'string' ||
      !payload.requestId ||
      typeof payload.leagueId !== 'string' ||
      !payload.leagueId ||
      typeof payload.requestedBy !== 'string' ||
      !payload.requestedBy
    ) {
      console.warn('Ignored malformed historical replay task.', { payload });
      return;
    }

    const requestRef = getHistoricalReplayRequestRef(payload.requestId);
    const controlRef = getHistoricalReplayControlRef(payload.leagueId);
    const now = Date.now();
    const claimed = await db.runTransaction(async (transaction) => {
      const [requestSnapshot, controlSnapshot] = await Promise.all([
        transaction.get(requestRef),
        transaction.get(controlRef),
      ]);

      if (!requestSnapshot.exists) {
        return false;
      }

      const requestData = requestSnapshot.data() ?? {};
      const status = typeof requestData['status'] === 'string'
        ? requestData['status']
        : '';

      if (status === 'completed' || status === 'error' || status === 'cancelled') {
        return false;
      }

      if (
        requestData['leagueId'] !== payload.leagueId ||
        requestData['requestedBy'] !== payload.requestedBy
      ) {
        transaction.set(
          requestRef,
          {
            status: 'error',
            lastError: 'Historical replay task payload did not match the queued request.',
            failedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        return false;
      }

      if (
        status === 'processing' &&
        toMilliseconds(requestData['leaseExpiresAt']) > now
      ) {
        return false;
      }

      const controlData = controlSnapshot.data() ?? {};
      const activeRequestId =
        typeof controlData['activeRequestId'] === 'string'
          ? controlData['activeRequestId']
          : '';

      if (activeRequestId && activeRequestId !== payload.requestId) {
        transaction.set(
          requestRef,
          {
            status: 'cancelled',
            cancellationReason: 'league-request-replaced',
            cancelledAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        return false;
      }

      transaction.set(
        requestRef,
        {
          status: 'processing',
          attemptCount: FieldValue.increment(1),
          startedAt: FieldValue.serverTimestamp(),
          leaseExpiresAt: Timestamp.fromMillis(
            now + HISTORICAL_REPLAY_REQUEST_LEASE_MILLISECONDS,
          ),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      transaction.set(
        controlRef,
        {
          schemaVersion: 2,
          enabled: true,
          status: 'advancing',
          activeRequestId: payload.requestId,
          message: 'Replay worker started. Scores and roster windows will update from the saved historical NHL ledger.',
          lastError: '',
          workerStartedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      return true;
    });

    if (!claimed) {
      return;
    }

    const requestSnapshot = await requestRef.get();
    const retrySimulatedDate =
      typeof requestSnapshot.data()?.['retrySimulatedDate'] === 'string'
        ? requestSnapshot.data()?.['retrySimulatedDate'] as string
        : null;

    try {
      const result = await performHistoricalReplayAdvance(
        payload.leagueId,
        payload.requestedBy,
        payload.requestId,
        retrySimulatedDate,
      );

      await requestRef.set(
        {
          status: 'completed',
          simulatedDate: result.simulatedDate,
          daysAdvanced: result.daysAdvanced,
          releasedGameCount: result.releasedGameCount,
          activeCycleNumbers: result.activeCycleNumbers,
          message: result.message,
          leaseExpiresAt: Timestamp.fromMillis(Date.now()),
          completedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    } catch (error: unknown) {
      const message = error instanceof Error
        ? error.message
        : 'Unable to advance the historical replay.';

      await requestRef.set(
        {
          status: 'error',
          lastError: message.slice(0, 500),
          leaseExpiresAt: Timestamp.fromMillis(Date.now()),
          failedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      ).catch(() => undefined);

      console.error('Historical replay queue task failed.', {
        requestId: payload.requestId,
        leagueId: payload.leagueId,
        message,
      });
    }
  },
);

export const recoverStaleHistoricalReplayQueue = onSchedule(
  {
    schedule: 'every 5 minutes',
    timeZone: 'America/Los_Angeles',
    region: FUNCTION_REGION,
    timeoutSeconds: 60,
    memory: '256MiB',
    retryCount: 0,
    maxInstances: 1,
  },
  async () => {
    const now = Date.now();
    const requestSnapshot = await db.collection('historicalReplayRequests')
      .where('status', 'in', ['queued', 'processing'])
      .limit(HISTORICAL_REPLAY_STALE_SWEEP_LIMIT)
      .get();
    let recoveredCount = 0;

    for (const requestDocument of requestSnapshot.docs) {
      const requestData = requestDocument.data();

      if (!isHistoricalReplayRequestStale(requestData, now)) {
        continue;
      }

      const leagueId =
        typeof requestData['leagueId'] === 'string'
          ? requestData['leagueId']
          : '';

      if (!leagueId) {
        await requestDocument.ref.set(
          {
            status: 'error',
            lastError: 'Stale replay request did not contain a league identifier.',
            failedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        recoveredCount += 1;
        continue;
      }

      const controlRef = getHistoricalReplayControlRef(leagueId);
      await db.runTransaction(async (transaction) => {
        const [freshRequestSnapshot, controlSnapshot] = await Promise.all([
          transaction.get(requestDocument.ref),
          transaction.get(controlRef),
        ]);

        if (!freshRequestSnapshot.exists) {
          return;
        }

        const freshRequestData = freshRequestSnapshot.data() ?? {};

        if (!isHistoricalReplayRequestStale(freshRequestData, now)) {
          return;
        }

        const controlData = controlSnapshot.data() ?? {};
        const activeRequestId =
          typeof controlData['activeRequestId'] === 'string'
            ? controlData['activeRequestId']
            : '';
        const controlStatus =
          typeof controlData['status'] === 'string'
            ? controlData['status']
            : '';
        const simulatedDate =
          typeof controlData['simulatedDate'] === 'string'
            ? controlData['simulatedDate']
            : null;
        const message =
          'The historical replay queue stopped reporting progress and was released automatically. No date was intentionally skipped; press Advance One NHL Day to retry after reviewing the saved scores.';

        transaction.set(
          requestDocument.ref,
          {
            status: 'error',
            lastError: message,
            recoveryReason: 'stale-queue-request',
            leaseExpiresAt: Timestamp.fromMillis(now),
            failedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        if (activeRequestId === requestDocument.id) {
          transaction.set(
            controlRef,
            {
              status: 'error',
              activeRequestId: null,
              lastFailedRequestId: requestDocument.id,
              ...(controlStatus === 'advancing' && simulatedDate
                ? { lastFailedSimulatedDate: simulatedDate }
                : {}),
              message,
              lastError: message,
              lastAdvanceFailedAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true },
          );
        }
      });

      recoveredCount += 1;
    }

    if (recoveredCount > 0) {
      console.warn('Recovered stale historical replay queue requests.', {
        recoveredCount,
        inspectedCount: requestSnapshot.size,
      });
    }
  },
);
