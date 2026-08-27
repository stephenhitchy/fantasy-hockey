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
import { enforceAppCheckCallableCanaryForLeague } from './app-check-canary-authority';
import { queueServerProjectionSnapshotRefresh } from './projection-authority';
import { db } from './shared/core/firebase';
import { requireVerifiedRecentAuthentication } from './shared/security/auth-security.util';
import {
  BETA_OPERATION_DAILY_RETENTION_MILLISECONDS,
  BETA_OPERATION_SHARD_COUNT,
  addBetaDurationSample,
  betaHistogramPercentile,
  betaOperationsDateKey,
  betaOperationsDateKeys,
  betaOperationsShardId,
  emptyBetaDurationAccumulator,
  mergeBetaDurationAccumulators,
  normalizeBetaDurationAccumulator,
} from './shared/core/observability/beta-operations.util';
import {
  SCORING_PHASE_NAMES,
  ScoringPhaseTimer,
  scoringPhaseTimingForFirestore,
  type ScoringPhaseTimingSnapshot,
} from './shared/core/observability/scoring-phase-timing.util';
import {
  isSafeFirestoreDocumentId,
  optionalFirestoreDocumentId,
  requireFirestoreDocumentId,
  requireFirestoreDocumentIds,
  requireServerFirestoreDocumentId,
  resolveSafeFirestoreDocumentId,
} from './shared/security/firestore-document-id.util';
import {
  FIRESTORE_ASSET_KEY_OPTIONS,
  FIRESTORE_AUTH_USER_ID_OPTIONS,
  FIRESTORE_LEAGUE_ID_OPTIONS,
  FIRESTORE_REQUEST_ID_OPTIONS,
  FIRESTORE_TASK_ID_OPTIONS,
} from './shared/security/firestore-document-id-policies';
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
  decideCanonicalRequestCompletion,
} from './shared/core/live-scoring/canonical-request-completion.util';
import {
  NEAR_LIVE_CANARY_MAX_LEAGUE_COUNT,
  NEAR_LIVE_CANARY_REFRESH_INTERVAL_MILLISECONDS,
  getLiveScoringRefreshDelay,
  selectLeagueAutomationRefreshCadence,
  type LeagueAutomationRefreshCadence,
} from './shared/core/live-scoring/live-scoring-cadence.util';
import {
  LEAGUE_AUTOMATION_CAPACITY_MIN_SAMPLE_COUNT,
  LEAGUE_AUTOMATION_CAPACITY_PRIMARY_MAX_P95_MILLISECONDS,
  LEAGUE_AUTOMATION_CAPACITY_PRIMARY_MIN_RELIABILITY_RATE,
  LEAGUE_AUTOMATION_WATCHDOG_REQUIRED_BLOCKING_STREAK,
  buildLeagueAutomationCapacityRecommendation,
  decideLeagueAutomationWatchdogAction,
  type LeagueAutomationCapacityRecommendation,
  type LeagueAutomationWatchdogAction,
  type LeagueAutomationWatchdogStatus,
} from './shared/core/live-scoring/league-automation-season-safety.util';
import {
  getNhlTeamSeasonSchedule,
  getRegularSeasonGameLog,
  NhlTeamSeasonGame,
} from './shared/core/nhl/nhl-api.service';
import {
  CANONICAL_NHL_FACTS_SCHEMA_VERSION,
  canonicalNhlSha256,
  type CanonicalNhlGameFacts,
} from './shared/core/nhl/nhl-canonical-facts.util';
import type {
  CanonicalScoringParityGame,
  CanonicalScoringParityObservation,
} from './shared/core/nhl/nhl-canonical-scoring-parity.util';
import {
  summarizeCanonicalScoringAuthorityTask,
  type CanonicalScoringAuthorityDecision,
  type CanonicalScoringAuthorityTaskSummary,
} from './shared/core/nhl/nhl-canonical-scoring-authority.util';
import { getFantasyPlayoffs } from './shared/core/playoffs/playoff.service';
import {
  ensureNextPlayoffBankWindows,
  syncPlayoffWindowBankScores,
} from './shared/core/playoffs/playoff-window-bank.service';
import {
  CURRENT_SCORING_RULES_VERSION,
  SCORING_RULES_V3_VERSION,
  defaultScoringRules,
  scoringRulesForVersion,
  ScoringRules,
} from './shared/core/scoring/scoring-rules';
import {
  FantasyTeam,
  getLeagueTeams,
} from './shared/core/team/team.service';

const FUNCTION_REGION = 'us-central1';
const SERVER_WORKER_PREFIX = 'server:';
const SERVER_LEASE_MILLISECONDS = 9 * 60 * 1000;
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
const LEAGUE_AUTOMATION_CANONICAL_AUTHORITY_CONFIRMATION =
  'ENABLE CANONICAL READ CANARY';
const LEAGUE_AUTOMATION_CANONICAL_AUTHORITY_MAX_LEAGUE_COUNT = 1;
const LEAGUE_AUTOMATION_CANONICAL_AUTHORITY_MIN_PARITY_STREAK = 3;
const LEAGUE_AUTOMATION_SEASON_SAFETY_DISPATCH_STALE_MILLISECONDS = 5 * 60 * 1000;
const LEAGUE_AUTOMATION_SEASON_SAFETY_FEED_STALE_MILLISECONDS = 5 * 60 * 1000;
const LEAGUE_AUTOMATION_SEASON_SAFETY_BACKLOG_WARNING_MILLISECONDS = 4 * 60 * 1000;
const LEAGUE_AUTOMATION_SEASON_SAFETY_BACKLOG_BLOCKING_MILLISECONDS = 10 * 60 * 1000;
const LEAGUE_AUTOMATION_SEASON_WATCHDOG_STALE_MILLISECONDS = 3 * 60 * 1000;
const LEAGUE_AUTOMATION_CAPACITY_EVIDENCE_STALE_MILLISECONDS = 2 * 60 * 60 * 1000;
const LEAGUE_AUTOMATION_SEASON_WATCHDOG_ACTOR = 'server:season-safety-watchdog';
const LEAGUE_AUTOMATION_CAPACITY_WINDOW_DAYS = 14;
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
  refreshCadence?: LeagueAutomationRefreshCadence;
  refreshDelayMilliseconds?: number;
  phaseTiming?: ScoringPhaseTimingSnapshot;
  canonicalAuthorityUsedCount?: number;
  canonicalAuthorityFallbackCount?: number;
  canonicalAuthorityCircuitOpened?: boolean;
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
  scoringDurationMilliseconds: number;
  scoringPhaseTiming?: ScoringPhaseTimingSnapshot;
}

interface LeagueAutomationQueueConfig {
  mode: LeagueAutomationQueueMode;
  canaryLeagueIds: string[];
  internalTestLeagueIds: string[];
  canonicalAuthorityLeagueIds: string[];
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

type LeagueAutomationSeasonSafetyStatus =
  | 'observing'
  | 'ready'
  | 'attention'
  | 'blocked';

interface LeagueAutomationSeasonSafetyAlert {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  label: string;
  detail: string;
}

interface LeagueAutomationSeasonWatchdogSnapshot {
  status: LeagueAutomationWatchdogStatus | 'not-recorded';
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

interface LeagueAutomationCapacityEvidence
  extends LeagueAutomationCapacityRecommendation {
  status: 'not-recorded' | 'healthy' | 'error';
  consecutiveFailureCount: number;
  lastError: string;
  lastAttemptAt: string | null;
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
  }>;
}

interface LeagueAutomationTaskPayload {
  taskSchemaVersion: 1;
  leagueId: string;
  expectedDueAtMilliseconds: number;
  dueBucket: string;
  reason: 'scheduled' | 'recovery' | 'canary-manual';
  canonicalSourceVersion?: string;
  canonicalRequestedAtMilliseconds?: number;
  canonicalGameIds?: number[];
  canonicalGameVersions?: CanonicalLeagueAutomationGameVersion[];
}

interface DueLeagueAutomationSchedule {
  leagueId: string;
  expectedDueAtMilliseconds: number;
  queueStatus: string;
  activeTaskId: string;
  activeTaskLeaseExpiresAtMilliseconds: number;
  canonicalSourceVersion: string;
  canonicalRequestedAtMilliseconds: number;
  canonicalGameIds: number[];
  canonicalGameVersions: CanonicalLeagueAutomationGameVersion[];
}

export interface LeagueAutomationCanonicalCanaryScope {
  mode: LeagueAutomationQueueMode;
  canaryLeagueIds: string[];
  internalTestLeagueIds: string[];
  eligibleLeagueIds: string[];
  valid: boolean;
  reason: string;
}

export interface CanonicalLeagueAutomationRequestInput {
  leagueId: string;
  sourceVersion: string;
  observedAtMilliseconds: number;
  gameIds: number[];
  gameVersions: CanonicalLeagueAutomationGameVersion[];
  changeKinds: string[];
}

export interface CanonicalLeagueAutomationGameVersion {
  gameId: number;
  sourceVersion: string;
}

interface CanonicalScoringParityTaskContext {
  sourceVersion: string;
  requestedAtMilliseconds: number;
  gameIds: number[];
}

interface CanonicalScoringAuthorityRuntimeContext {
  configured: boolean;
  circuitState: 'closed' | 'open';
  enabled: boolean;
  reason: string;
}

interface CanonicalScoringParityLoadResult {
  gamesById: Map<number, CanonicalScoringParityGame>;
  requestedGameIds: number[];
  loadedGameIds: number[];
  missingGameIds: number[];
  invalidGameIds: number[];
  calculatedAggregateSourceVersion: string;
  taskSourceVersion: string;
  taskVersionAligned: boolean;
}

interface CanonicalScoringParitySummary {
  status: 'pass' | 'mismatch' | 'incomplete' | 'no-data';
  comparedCount: number;
  matchedCount: number;
  mismatchCount: number;
  incompleteCount: number;
  canonicalMissingCount: number;
  maximumAbsolutePointDelta: number;
}

interface CanonicalScoringParityCohortSummary {
  expectedLeagueCount: number;
  passingLeagueCount: number;
  mismatchLeagueCount: number;
  incompleteLeagueCount: number;
  missingLeagueCount: number;
  staleLeagueCount: number;
  totalComparedCount: number;
  maximumAbsolutePointDelta: number;
  passing: boolean;
}

interface CanonicalScoringAuthorityEligibility {
  eligible: boolean;
  reason: string;
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
  const userId = resolveSafeFirestoreDocumentId(
    request.auth?.uid,
    FIRESTORE_AUTH_USER_ID_OPTIONS,
  );

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
  const safeLeagueId = requireServerFirestoreDocumentId(
    leagueId,
    'historical replay league identifier',
    FIRESTORE_LEAGUE_ID_OPTIONS,
  );
  return db.doc(`leagues/${safeLeagueId}/historicalReplay/control`);
}

function getHistoricalReplayRequestRef(requestId: string) {
  const safeRequestId = requireServerFirestoreDocumentId(
    requestId,
    'historical replay request identifier',
    FIRESTORE_REQUEST_ID_OPTIONS,
  );
  return db.doc(`historicalReplayRequests/${safeRequestId}`);
}

function getHistoricalReplayTaskQueue() {
  return getFunctions().taskQueue<HistoricalReplayAdvanceTaskPayload>(
    'processHistoricalReplayAdvance',
  );
}

function getLeagueAutomationScheduleRef(leagueId: string) {
  const safeLeagueId = requireServerFirestoreDocumentId(
    leagueId,
    'league automation schedule identifier',
    FIRESTORE_LEAGUE_ID_OPTIONS,
  );
  return db.doc(`leagueAutomationSchedules/${safeLeagueId}`);
}

function getLeagueAutomationTaskRef(taskId: string) {
  const safeTaskId = requireServerFirestoreDocumentId(
    taskId,
    'league automation task identifier',
    FIRESTORE_TASK_ID_OPTIONS,
  );
  return db.doc(`leagueAutomationTasks/${safeTaskId}`);
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
      .map((entry) =>
        resolveSafeFirestoreDocumentId(entry, FIRESTORE_LEAGUE_ID_OPTIONS),
      )
      .filter((entry): entry is string => entry !== null)
      .slice(0, 100),
  )].sort();
}

function normalizeLeagueAutomationCanaryIds(value: unknown): string[] {
  return normalizeLeagueAutomationLeagueIds(value);
}

function normalizeLeagueAutomationInternalTestIds(value: unknown): string[] {
  return normalizeLeagueAutomationLeagueIds(value);
}

function normalizeLeagueAutomationCanonicalAuthorityIds(value: unknown): string[] {
  return normalizeLeagueAutomationLeagueIds(value).slice(
    0,
    LEAGUE_AUTOMATION_CANONICAL_AUTHORITY_MAX_LEAGUE_COUNT,
  );
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
    canonicalAuthorityLeagueIds:
      normalizeLeagueAutomationCanonicalAuthorityIds(
        data['canonicalAuthorityLeagueIds'],
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


function getConfiguredLeagueAutomationRefreshCadence(
  config: LeagueAutomationQueueConfig,
  leagueId: string,
): LeagueAutomationRefreshCadence {
  return selectLeagueAutomationRefreshCadence({
    queueMode: config.mode,
    leagueId,
    canaryLeagueIds: config.canaryLeagueIds,
    internalTestLeagueIds: config.internalTestLeagueIds,
  });
}

function normalizeCanonicalSourceVersion(value: unknown): string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : '';
}

export async function getLeagueAutomationCanonicalCanaryScope(): Promise<
  LeagueAutomationCanonicalCanaryScope
> {
  const config = await getLeagueAutomationQueueConfig();
  const internalSet = new Set(config.internalTestLeagueIds);
  const eligibleLeagueIds = config.canaryLeagueIds.filter((leagueId) =>
    internalSet.has(leagueId)
  );
  const valid = config.mode === 'canary' &&
    config.canaryLeagueIds.length > 0 &&
    config.canaryLeagueIds.length <= NEAR_LIVE_CANARY_MAX_LEAGUE_COUNT &&
    eligibleLeagueIds.length === config.canaryLeagueIds.length;

  return {
    mode: config.mode,
    canaryLeagueIds: [...config.canaryLeagueIds],
    internalTestLeagueIds: [...config.internalTestLeagueIds],
    eligibleLeagueIds: valid ? eligibleLeagueIds : [],
    valid,
    reason: valid
      ? 'exact-internal-canary'
      : config.mode !== 'canary'
        ? 'queue-mode-not-canary'
        : config.canaryLeagueIds.length === 0
          ? 'canary-empty'
          : config.canaryLeagueIds.length > NEAR_LIVE_CANARY_MAX_LEAGUE_COUNT
            ? 'canary-too-large'
            : 'canary-not-fully-internal-test',
  };
}

export async function requestLeagueAutomationForCanonicalChange(
  input: CanonicalLeagueAutomationRequestInput,
): Promise<'requested' | 'coalesced' | 'ineligible'> {
  const leagueId = requireServerFirestoreDocumentId(
    input.leagueId,
    'canonical scoring league identifier',
    FIRESTORE_LEAGUE_ID_OPTIONS,
  );
  const sourceVersion = normalizeCanonicalSourceVersion(input.sourceVersion);

  if (!sourceVersion) {
    throw new Error('canonical-source-version-invalid');
  }

  const gameVersions = normalizeCanonicalGameVersions(input.gameVersions);

  const scope = await getLeagueAutomationCanonicalCanaryScope();

  if (!scope.valid || !scope.eligibleLeagueIds.includes(leagueId)) {
    return 'ineligible';
  }

  const observedAtMilliseconds = Number.isFinite(input.observedAtMilliseconds)
    ? Math.max(0, Math.trunc(input.observedAtMilliseconds))
    : Date.now();
  const gameIds = [...new Set(
    input.gameIds
      .filter((gameId) => Number.isFinite(gameId) && gameId > 0)
      .map((gameId) => Math.trunc(gameId)),
  )].sort((left, right) => left - right).slice(0, 32);
  const versionGameIds = gameVersions.map((entry) => entry.gameId);
  const currentRequestSourceVersion = buildCanonicalLeagueAggregateSourceVersion({
    leagueId,
    gameVersions,
  });

  if (
    gameIds.length === 0 ||
    gameIds.length !== versionGameIds.length ||
    gameIds.some((gameId, index) => gameId !== versionGameIds[index]) ||
    currentRequestSourceVersion !== sourceVersion
  ) {
    throw new Error('canonical-game-version-set-invalid');
  }
  const changeKinds = [...new Set(
    input.changeKinds
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => value.trim().slice(0, 40)),
  )].sort().slice(0, 12);
  const scheduleRef = getLeagueAutomationScheduleRef(leagueId);
  const now = Date.now();

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(scheduleRef);
    const data = snapshot.data() ?? {};
    const currentVersion = normalizeCanonicalSourceVersion(
      data['canonicalRequestedSourceVersion'],
    );
    const existingGameIds = Array.isArray(data['canonicalPendingGameIds'])
      ? data['canonicalPendingGameIds']
          .filter((gameId): gameId is number =>
            typeof gameId === 'number' && Number.isFinite(gameId) && gameId > 0
          )
          .map((gameId) => Math.trunc(gameId))
      : [];
    const existingGameVersions = normalizeCanonicalGameVersions(
      data['canonicalPendingGameVersions'],
    );
    const existingChangeKinds = Array.isArray(data['canonicalPendingChangeKinds'])
      ? data['canonicalPendingChangeKinds']
          .filter((value): value is string =>
            typeof value === 'string' && value.trim().length > 0
          )
          .map((value) => value.trim().slice(0, 40))
      : [];
    const mergedGameIds = [...new Set([...existingGameIds, ...gameIds])]
      .sort((left, right) => left - right)
      .slice(0, 32);
    const mergedGameVersionMap = new Map(
      existingGameVersions.map((entry) => [entry.gameId, entry.sourceVersion] as const),
    );

    for (const entry of gameVersions) {
      mergedGameVersionMap.set(entry.gameId, entry.sourceVersion);
    }

    const mergedGameVersions = mergedGameIds
      .map((gameId) => {
        const gameSourceVersion = mergedGameVersionMap.get(gameId);
        return gameSourceVersion
          ? { gameId, sourceVersion: gameSourceVersion }
          : null;
      })
      .filter((entry): entry is CanonicalLeagueAutomationGameVersion =>
        entry !== null
      );
    const mergedGameVersionsComplete =
      mergedGameVersions.length === mergedGameIds.length;
    const mergedSourceVersion = mergedGameVersionsComplete
      ? buildCanonicalLeagueAggregateSourceVersion({
          leagueId,
          gameVersions: mergedGameVersions,
        })
      : sourceVersion;
    const mergedChangeKinds = [...new Set([
      ...existingChangeKinds,
      ...changeKinds,
    ])].sort().slice(0, 12);
    const alreadyRequested = currentVersion === mergedSourceVersion;
    const existingNextScoringAt = toMilliseconds(data['nextScoringAt']);
    const nextScoringAt = existingNextScoringAt > 0
      ? Math.min(existingNextScoringAt, now)
      : now;

    transaction.set(
      scheduleRef,
      {
        schemaVersion: LEAGUE_AUTOMATION_QUEUE_SCHEMA_VERSION,
        leagueId,
        shard: getLeagueAutomationShard(leagueId),
        scoringEnabled: data['scoringEnabled'] !== false,
        nextScoringAt: Timestamp.fromMillis(nextScoringAt),
        canonicalRequestedSourceVersion: mergedSourceVersion,
        canonicalRequestedAt: Timestamp.fromMillis(observedAtMilliseconds),
        canonicalRequestStatus: alreadyRequested
          ? getLeagueAutomationString(data['canonicalRequestStatus'], 'pending')
          : 'pending',
        canonicalPendingGameIds: mergedGameIds,
        canonicalPendingGameVersions: mergedGameVersions,
        canonicalPendingGameVersionsComplete: mergedGameVersionsComplete,
        canonicalPendingChangeKinds: mergedChangeKinds,
        canonicalRequestSequence: alreadyRequested
          ? getLeagueAutomationNumber(data['canonicalRequestSequence']) ?? 1
          : FieldValue.increment(1),
        canonicalLastObservedAt: FieldValue.serverTimestamp(),
        canonicalLastRequestedAt: alreadyRequested
          ? data['canonicalLastRequestedAt'] ?? FieldValue.serverTimestamp()
          : FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return alreadyRequested ? 'coalesced' : 'requested';
  });
}


function normalizeCanonicalParityGameIds(value: unknown): number[] {
  return Array.isArray(value)
    ? [...new Set(
        value
          .filter((gameId): gameId is number =>
            typeof gameId === 'number' && Number.isFinite(gameId) && gameId > 0
          )
          .map((gameId) => Math.trunc(gameId)),
      )].sort((left, right) => left - right).slice(0, 32)
    : [];
}

function normalizeCanonicalGameVersions(
  value: unknown,
): CanonicalLeagueAutomationGameVersion[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const byGameId = new Map<number, string>();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }

    const candidate = entry as Record<string, unknown>;
    const gameId = candidate['gameId'];
    const sourceVersion = normalizeCanonicalSourceVersion(
      candidate['sourceVersion'],
    );

    if (
      typeof gameId !== 'number' ||
      !Number.isFinite(gameId) ||
      gameId <= 0 ||
      !sourceVersion
    ) {
      continue;
    }

    byGameId.set(Math.trunc(gameId), sourceVersion);
  }

  return [...byGameId.entries()]
    .map(([gameId, sourceVersion]) => ({ gameId, sourceVersion }))
    .sort((left, right) => left.gameId - right.gameId)
    .slice(0, 32);
}

function buildCanonicalLeagueAggregateSourceVersion(input: {
  leagueId: string;
  gameVersions: readonly CanonicalLeagueAutomationGameVersion[];
}): string {
  if (input.gameVersions.length === 0) {
    return '';
  }

  return canonicalNhlSha256({
    schemaVersion: CANONICAL_NHL_FACTS_SCHEMA_VERSION,
    leagueId: input.leagueId,
    gameVersions: input.gameVersions
      .map((entry) => entry.sourceVersion)
      .sort(),
  });
}

function normalizeCanonicalParityFacts(
  value: unknown,
  expectedGameId: number,
): CanonicalNhlGameFacts | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const facts = value as Partial<CanonicalNhlGameFacts>;

  if (
    facts.schemaVersion !== CANONICAL_NHL_FACTS_SCHEMA_VERSION ||
    facts.gameId !== expectedGameId ||
    !Array.isArray(facts.skaters) ||
    !Array.isArray(facts.goalies) ||
    !Array.isArray(facts.goals) ||
    !Array.isArray(facts.finalSettlements)
  ) {
    return null;
  }

  return facts as CanonicalNhlGameFacts;
}

async function loadCanonicalScoringParityGames(input: {
  leagueId: string;
  context: CanonicalScoringParityTaskContext;
}): Promise<CanonicalScoringParityLoadResult> {
  const requestedGameIds = normalizeCanonicalParityGameIds(input.context.gameIds);
  const references = requestedGameIds.map((gameId) =>
    db.doc(`nhlCanonicalGameFacts/${gameId}`)
  );
  const snapshots = references.length > 0
    ? await db.getAll(...references)
    : [];
  const gamesById = new Map<number, CanonicalScoringParityGame>();
  const missingGameIds: number[] = [];
  const invalidGameIds: number[] = [];

  snapshots.forEach((snapshot, index) => {
    const gameId = requestedGameIds[index];

    if (!snapshot.exists) {
      missingGameIds.push(gameId);
      return;
    }

    const data = snapshot.data() ?? {};
    const sourceVersion = normalizeCanonicalSourceVersion(data['sourceVersion']);
    const facts = normalizeCanonicalParityFacts(data['facts'], gameId);

    if (!sourceVersion || !facts) {
      invalidGameIds.push(gameId);
      return;
    }

    gamesById.set(gameId, { sourceVersion, facts });
  });

  const loadedGameIds = [...gamesById.keys()].sort((left, right) => left - right);
  const gameVersions = [...gamesById.values()]
    .map((entry) => entry.sourceVersion)
    .sort();
  const calculatedAggregateSourceVersion = gameVersions.length > 0
    ? canonicalNhlSha256({
        schemaVersion: CANONICAL_NHL_FACTS_SCHEMA_VERSION,
        leagueId: input.leagueId,
        gameVersions,
      })
    : '';

  return {
    gamesById,
    requestedGameIds,
    loadedGameIds,
    missingGameIds,
    invalidGameIds,
    calculatedAggregateSourceVersion,
    taskSourceVersion: input.context.sourceVersion,
    taskVersionAligned:
      requestedGameIds.length > 0 &&
      missingGameIds.length === 0 &&
      invalidGameIds.length === 0 &&
      calculatedAggregateSourceVersion === input.context.sourceVersion,
  };
}

function summarizeCanonicalScoringParity(
  observations: readonly CanonicalScoringParityObservation[],
): CanonicalScoringParitySummary {
  const matchedCount = observations.filter((entry) => entry.status === 'matched').length;
  const mismatchCount = observations.filter((entry) => entry.status === 'mismatch').length;
  const incompleteCount = observations.filter((entry) => entry.status === 'incomplete').length;
  const canonicalMissingCount = observations.filter(
    (entry) => entry.status === 'canonical-missing',
  ).length;
  const comparedCount = matchedCount + mismatchCount;
  const maximumAbsolutePointDelta = observations.reduce(
    (maximum, entry) => Math.max(
      maximum,
      typeof entry.pointDelta === 'number'
        ? Math.abs(entry.pointDelta)
        : 0,
    ),
    0,
  );
  const status = mismatchCount > 0
    ? 'mismatch'
    : incompleteCount > 0 || canonicalMissingCount > 0
      ? 'incomplete'
      : comparedCount > 0
        ? 'pass'
        : 'no-data';

  return {
    status,
    comparedCount,
    matchedCount,
    mismatchCount,
    incompleteCount,
    canonicalMissingCount,
    maximumAbsolutePointDelta: Number(maximumAbsolutePointDelta.toFixed(1)),
  };
}

async function recordCanonicalScoringParityEvidence(input: {
  leagueId: string;
  context: CanonicalScoringParityTaskContext;
  load: CanonicalScoringParityLoadResult;
  observations: readonly CanonicalScoringParityObservation[];
  authorityEnabled?: boolean;
}): Promise<void> {
  const summary = summarizeCanonicalScoringParity(input.observations);
  const details = input.observations
    .filter((entry) => entry.status !== 'matched')
    .slice(0, 24)
    .map((entry) => ({
      gameId: entry.gameId,
      assetKey: entry.assetKey.slice(0, 160),
      assetType: entry.assetType,
      sourceVersion: entry.sourceVersion.slice(0, 64),
      status: entry.status,
      directPoints: entry.directPoints,
      canonicalPoints: entry.canonicalPoints,
      pointDelta: entry.pointDelta,
      directAppeared: entry.directAppeared,
      canonicalAppeared: entry.canonicalAppeared,
      reason: entry.reason.slice(0, 100),
    }));
  const parityStatus = !input.load.taskVersionAligned && summary.status === 'pass'
    ? 'incomplete'
    : summary.status;
  const perfectShadowPass =
    input.authorityEnabled !== true &&
    input.load.taskVersionAligned &&
    parityStatus === 'pass' &&
    summary.comparedCount > 0 &&
    summary.mismatchCount === 0 &&
    summary.incompleteCount === 0 &&
    summary.canonicalMissingCount === 0;
  const evidence = {
    schemaVersion: 1,
    leagueId: input.leagueId,
    status: parityStatus,
    shadowOnly: input.authorityEnabled !== true,
    authoritativeReadsEnabled: input.authorityEnabled === true,
    taskSourceVersion: input.context.sourceVersion,
    requestedAt: input.context.requestedAtMilliseconds > 0
      ? Timestamp.fromMillis(input.context.requestedAtMilliseconds)
      : null,
    calculatedAggregateSourceVersion:
      input.load.calculatedAggregateSourceVersion || null,
    taskVersionAligned: input.load.taskVersionAligned,
    requestedGameIds: input.load.requestedGameIds,
    loadedGameIds: input.load.loadedGameIds,
    missingGameIds: input.load.missingGameIds,
    invalidGameIds: input.load.invalidGameIds,
    observationCount: input.observations.length,
    comparedCount: summary.comparedCount,
    matchedCount: summary.matchedCount,
    mismatchCount: summary.mismatchCount,
    incompleteCount: summary.incompleteCount,
    canonicalMissingCount: summary.canonicalMissingCount,
    maximumAbsolutePointDelta: summary.maximumAbsolutePointDelta,
    totalComparisonRunCount: FieldValue.increment(1),
    totalPassingRunCount: FieldValue.increment(perfectShadowPass ? 1 : 0),
    consecutivePassingRunCount: perfectShadowPass
      ? FieldValue.increment(1)
      : 0,
    ...(perfectShadowPass
      ? { lastPassingAt: FieldValue.serverTimestamp() }
      : { lastNonPassingAt: FieldValue.serverTimestamp() }),
    details,
    comparedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  await Promise.all([
    db.doc(`leagueAutomationCanonicalParity/${input.leagueId}`).set(
      evidence,
      { merge: true },
    ),
    getLeagueAutomationScheduleRef(input.leagueId).set(
      {
        canonicalParityStatus: parityStatus,
        canonicalParityTaskSourceVersion: input.context.sourceVersion,
        canonicalParityTaskVersionAligned: input.load.taskVersionAligned,
        canonicalParityComparedCount: summary.comparedCount,
        canonicalParityMatchedCount: summary.matchedCount,
        canonicalParityMismatchCount: summary.mismatchCount,
        canonicalParityIncompleteCount:
          summary.incompleteCount + summary.canonicalMissingCount,
        canonicalParityMaximumAbsolutePointDelta:
          summary.maximumAbsolutePointDelta,
        canonicalParityConsecutivePassingRunCount: perfectShadowPass
          ? FieldValue.increment(1)
          : 0,
        canonicalParityComparedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    ),
    db.doc('appData/leagueAutomationCanonicalParity').set(
      {
        schemaVersion: 1,
        shadowOnly: input.authorityEnabled !== true,
        authoritativeReadsEnabled: input.authorityEnabled === true,
        lastLeagueId: input.leagueId,
        lastStatus: parityStatus,
        lastTaskVersionAligned: input.load.taskVersionAligned,
        lastComparedCount: summary.comparedCount,
        lastMatchedCount: summary.matchedCount,
        lastMismatchCount: summary.mismatchCount,
        lastIncompleteCount:
          summary.incompleteCount + summary.canonicalMissingCount,
        lastMaximumAbsolutePointDelta: summary.maximumAbsolutePointDelta,
        totalComparisonRunCount: FieldValue.increment(1),
        totalMismatchRunCount: FieldValue.increment(
          summary.mismatchCount > 0 ? 1 : 0,
        ),
        lastComparedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    ),
    db.doc('appData/leagueAutomation').set(
      {
        canonicalParityShadowOnly: input.authorityEnabled !== true,
        canonicalParityAuthoritativeReadsEnabled:
          input.authorityEnabled === true,
        canonicalParityLastLeagueId: input.leagueId,
        canonicalParityLastStatus: parityStatus,
        canonicalParityLastTaskVersionAligned: input.load.taskVersionAligned,
        canonicalParityLastComparedCount: summary.comparedCount,
        canonicalParityLastMatchedCount: summary.matchedCount,
        canonicalParityLastMismatchCount: summary.mismatchCount,
        canonicalParityLastIncompleteCount:
          summary.incompleteCount + summary.canonicalMissingCount,
        canonicalParityLastMaximumAbsolutePointDelta:
          summary.maximumAbsolutePointDelta,
        canonicalParityLastComparedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    ),
  ]);

  if (summary.mismatchCount > 0) {
    console.error('Canonical scoring shadow parity mismatch.', {
      leagueId: input.leagueId,
      taskSourceVersion: input.context.sourceVersion,
      summary,
      details,
    });
  } else {
    console.info('Canonical scoring shadow parity completed.', {
      leagueId: input.leagueId,
      taskSourceVersion: input.context.sourceVersion,
      taskVersionAligned: input.load.taskVersionAligned,
      summary,
    });
  }
}

function getCanonicalScoringAuthorityRef(leagueId: string) {
  return db.doc(`leagueAutomationCanonicalAuthority/${leagueId}`);
}

async function loadCanonicalScoringAuthorityRuntimeContext(input: {
  config: LeagueAutomationQueueConfig;
  leagueId: string;
  canonicalContext?: CanonicalScoringParityTaskContext;
}): Promise<CanonicalScoringAuthorityRuntimeContext> {
  const configured = input.config.canonicalAuthorityLeagueIds.includes(
    input.leagueId,
  );

  if (!configured) {
    return {
      configured: false,
      circuitState: 'closed',
      enabled: false,
      reason: 'canonical-authority-not-configured',
    };
  }

  if (
    input.config.mode !== 'canary' ||
    !input.config.canaryLeagueIds.includes(input.leagueId) ||
    !input.config.internalTestLeagueIds.includes(input.leagueId)
  ) {
    return {
      configured: true,
      circuitState: 'open',
      enabled: false,
      reason: 'canonical-authority-cohort-invalid',
    };
  }

  const authoritySnapshot = await getCanonicalScoringAuthorityRef(
    input.leagueId,
  ).get();
  const authorityData = authoritySnapshot.data() ?? {};
  const circuitState = authorityData['circuitState'] === 'open'
    ? 'open' as const
    : 'closed' as const;

  if (circuitState === 'open') {
    return {
      configured: true,
      circuitState,
      enabled: false,
      reason: getLeagueAutomationString(
        authorityData['openedReason'],
        'canonical-authority-circuit-open',
      ),
    };
  }

  if (!input.canonicalContext?.sourceVersion) {
    return {
      configured: true,
      circuitState,
      enabled: false,
      reason: 'canonical-authority-task-not-versioned',
    };
  }

  return {
    configured: true,
    circuitState,
    enabled: true,
    reason: 'canonical-authority-verified-read',
  };
}

async function recordCanonicalScoringAuthorityOutcome(input: {
  leagueId: string;
  sourceVersion: string;
  summary: CanonicalScoringAuthorityTaskSummary;
}): Promise<void> {
  if (!input.summary.configured) {
    return;
  }

  const authorityRef = getCanonicalScoringAuthorityRef(input.leagueId);
  const now = Date.now();

  if (!input.summary.tripCircuitBreaker) {
    await Promise.all([
      authorityRef.set(
        {
          schemaVersion: 1,
          leagueId: input.leagueId,
          circuitState: 'closed',
          lastDecision: input.summary.canonicalUsedCount > 0
            ? 'canonical-verified'
            : 'no-relevant-comparison',
          lastSourceVersion: input.sourceVersion,
          lastTaskVersionAligned: input.summary.taskVersionAligned,
          lastObservationCount: input.summary.observationCount,
          lastCanonicalUseCount: input.summary.canonicalUsedCount,
          lastDirectFallbackCount: input.summary.directFallbackCount,
          totalCanonicalUseCount: FieldValue.increment(
            input.summary.canonicalUsedCount,
          ),
          totalDirectFallbackCount: FieldValue.increment(0),
          consecutiveSuccessfulTaskCount: FieldValue.increment(1),
          lastSuccessfulAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      ),
      db.doc('appData/leagueAutomation').set(
        {
          canonicalAuthorityConfiguredLeagueId: input.leagueId,
          canonicalAuthorityCircuitState: 'closed',
          canonicalAuthorityLastDecision:
            input.summary.canonicalUsedCount > 0
              ? 'canonical-verified'
              : 'no-relevant-comparison',
          canonicalAuthorityLastSourceVersion: input.sourceVersion,
          canonicalAuthorityLastCanonicalUseCount:
            input.summary.canonicalUsedCount,
          canonicalAuthorityLastDirectFallbackCount: 0,
          canonicalAuthorityLastCompletedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      ),
    ]);
    return;
  }

  const breakerHash = createHash('sha256')
    .update([
      input.leagueId,
      input.sourceVersion,
      input.summary.circuitBreakerReason,
    ].join(':'))
    .digest('hex')
    .slice(0, 32);
  const auditRef = getLeagueAutomationAuditRef(
    `canonical-breaker-${breakerHash}`,
  );
  const configRef = db.doc('appData/leagueAutomationQueueConfig');
  const healthRef = db.doc('appData/leagueAutomation');

  await db.runTransaction(async (transaction) => {
    const [configSnapshot, auditSnapshot] = await Promise.all([
      transaction.get(configRef),
      transaction.get(auditRef),
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
      canonicalAuthorityLeagueIds:
        normalizeLeagueAutomationCanonicalAuthorityIds(
          configData['canonicalAuthorityLeagueIds'],
        ),
      maxEnqueuePerRun: normalizeLeagueAutomationMaxEnqueuePerRun(
        configData['maxEnqueuePerRun'],
      ),
      canarySuccessBaseline: normalizeLeagueAutomationRevision(
        configData['canarySuccessBaseline'],
      ),
      revision: normalizeLeagueAutomationRevision(configData['revision']),
    };
    const canonicalAuthorityLeagueIds = before.canonicalAuthorityLeagueIds
      .filter((leagueId) => leagueId !== input.leagueId);
    const nextRevision = canonicalAuthorityLeagueIds.length ===
      before.canonicalAuthorityLeagueIds.length
        ? before.revision
        : before.revision + 1;

    transaction.set(
      authorityRef,
      {
        schemaVersion: 1,
        leagueId: input.leagueId,
        circuitState: 'open',
        openedReason: input.summary.circuitBreakerReason,
        openedSourceVersion: input.sourceVersion,
        openedAt: FieldValue.serverTimestamp(),
        lastDecision: 'direct-fallback',
        lastSourceVersion: input.sourceVersion,
        lastTaskVersionAligned: input.summary.taskVersionAligned,
        lastObservationCount: input.summary.observationCount,
        lastCanonicalUseCount: input.summary.canonicalUsedCount,
        lastDirectFallbackCount: input.summary.directFallbackCount,
        totalCanonicalUseCount: FieldValue.increment(
          input.summary.canonicalUsedCount,
        ),
        totalDirectFallbackCount: FieldValue.increment(
          Math.max(1, input.summary.directFallbackCount),
        ),
        totalCircuitOpenCount: FieldValue.increment(1),
        consecutiveSuccessfulTaskCount: 0,
        lastFallbackAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    if (nextRevision !== before.revision) {
      transaction.set(
        configRef,
        {
          canonicalAuthorityLeagueIds,
          revision: nextRevision,
          updatedBy: 'server:canonical-circuit-breaker',
          updatedAt: FieldValue.serverTimestamp(),
          changeReason:
            `Canonical authority automatically disabled: ${input.summary.circuitBreakerReason}`,
        },
        { merge: true },
      );
    }

    transaction.set(
      healthRef,
      {
        canonicalAuthorityConfiguredLeagueId: null,
        canonicalAuthorityCircuitState: 'open',
        canonicalAuthorityLastLeagueId: input.leagueId,
        canonicalAuthorityLastDecision: 'direct-fallback',
        canonicalAuthorityLastFallbackReason:
          input.summary.circuitBreakerReason,
        canonicalAuthorityLastSourceVersion: input.sourceVersion,
        canonicalAuthorityLastCanonicalUseCount:
          input.summary.canonicalUsedCount,
        canonicalAuthorityLastDirectFallbackCount:
          input.summary.directFallbackCount,
        canonicalAuthorityCircuitOpenCount: FieldValue.increment(1),
        canonicalAuthorityLastOpenedAt: FieldValue.serverTimestamp(),
        queueConfigRevision: nextRevision,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    if (!auditSnapshot.exists) {
      transaction.set(
        auditRef,
        {
          schemaVersion: 1,
          action: 'canonical-authority-circuit-opened',
          requestId: auditRef.id,
          adminId: 'server:canonical-circuit-breaker',
          projectId: getLeagueAutomationProjectId(),
          environment: getLeagueAutomationEnvironment(
            getLeagueAutomationProjectId(),
          ),
          modeBefore: before.mode,
          modeAfter: before.mode,
          canaryLeagueIdsBefore: before.canaryLeagueIds,
          canaryLeagueIdsAfter: before.canaryLeagueIds,
          internalTestLeagueIdsBefore: before.internalTestLeagueIds,
          internalTestLeagueIdsAfter: before.internalTestLeagueIds,
          canonicalAuthorityLeagueIdsBefore:
            before.canonicalAuthorityLeagueIds,
          canonicalAuthorityLeagueIdsAfter: canonicalAuthorityLeagueIds,
          maxEnqueuePerRunBefore: before.maxEnqueuePerRun,
          maxEnqueuePerRunAfter: before.maxEnqueuePerRun,
          canarySuccessBaselineBefore: before.canarySuccessBaseline,
          canarySuccessBaselineAfter: before.canarySuccessBaseline,
          revisionBefore: before.revision,
          revisionAfter: nextRevision,
          leagueId: input.leagueId,
          reason:
            `Automatic direct-source fallback: ${input.summary.circuitBreakerReason}`,
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: false },
      );
    }
  });

  console.error('Canonical scoring authority circuit breaker opened.', {
    leagueId: input.leagueId,
    sourceVersion: input.sourceVersion,
    summary: input.summary,
    openedAtMilliseconds: now,
  });
}


async function requireLeagueAutomationPlatformAdmin(request: {
  auth?: {
    uid: string;
    token: Record<string, unknown>;
  } | null;
}): Promise<string> {
  const authenticatedUserId = request.auth?.uid;

  if (!authenticatedUserId) {
    throw new HttpsError(
      'unauthenticated',
      'Sign in before opening the scoring queue controls.',
    );
  }

  const userId = requireFirestoreDocumentId(
    authenticatedUserId,
    'platform administrator ID',
    { maxBytes: 128 },
  );

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
  return typeof value === 'string' && value.trim()
    ? requireFirestoreDocumentId(value, 'queue configuration request ID', {
        maxBytes: 96,
        pattern: /^[A-Za-z0-9_-]+$/,
      })
    : randomUUID().replaceAll('-', '');
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

function normalizeLeagueAutomationWatchdogAction(
  value: unknown,
): LeagueAutomationWatchdogAction {
  return value === 'disable-canonical-authority' || value === 'return-to-shadow'
    ? value
    : 'none';
}

function normalizeLeagueAutomationWatchdogStatus(
  value: unknown,
): LeagueAutomationSeasonWatchdogSnapshot['status'] {
  return value === 'observing' ||
    value === 'healthy' ||
    value === 'warning' ||
    value === 'error' ||
    value === 'canonical-fallback' ||
    value === 'shadow-fallback'
      ? value
      : 'not-recorded';
}

function normalizeLeagueAutomationWatchdogAlertIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(
    value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim().slice(0, 80))
      .filter(Boolean),
  )].sort().slice(0, 20);
}

function normalizeLeagueAutomationSeasonWatchdog(
  value: DocumentData | undefined,
): LeagueAutomationSeasonWatchdogSnapshot {
  return {
    status: normalizeLeagueAutomationWatchdogStatus(value?.['status']),
    lastAttemptAt: getLeagueAutomationIso(value?.['lastAttemptAt']),
    lastSuccessfulAt: getLeagueAutomationIso(value?.['lastSuccessfulAt']),
    queueBlockingStreak: normalizeLeagueAutomationRevision(
      value?.['queueBlockingStreak'],
    ),
    canonicalBlockingStreak: normalizeLeagueAutomationRevision(
      value?.['canonicalBlockingStreak'],
    ),
    requiredBlockingStreak:
      LEAGUE_AUTOMATION_WATCHDOG_REQUIRED_BLOCKING_STREAK,
    lastAction: normalizeLeagueAutomationWatchdogAction(value?.['lastAction']),
    lastActionAt: getLeagueAutomationIso(value?.['lastActionAt']),
    lastActionReason: getLeagueAutomationString(
      value?.['lastActionReason'],
    ).slice(0, 500),
    automaticShadowFallbackCount: normalizeLeagueAutomationRevision(
      value?.['automaticShadowFallbackCount'],
    ),
    automaticCanonicalFallbackCount: normalizeLeagueAutomationRevision(
      value?.['automaticCanonicalFallbackCount'],
    ),
    consecutiveFailureCount: normalizeLeagueAutomationRevision(
      value?.['consecutiveFailureCount'],
    ),
    lastError: getLeagueAutomationString(value?.['lastError']).slice(0, 500),
    lastQueueBlockingAlertIds: normalizeLeagueAutomationWatchdogAlertIds(
      value?.['lastQueueBlockingAlertIds'],
    ),
    lastCanonicalBlockingAlertIds: normalizeLeagueAutomationWatchdogAlertIds(
      value?.['lastCanonicalBlockingAlertIds'],
    ),
  };
}

function emptyLeagueAutomationCapacityEvidence(
  activeLeagueTarget: number,
): LeagueAutomationCapacityEvidence {
  return {
    ...buildLeagueAutomationCapacityRecommendation({
      queueTaskSampleCount: 0,
      queueTaskSuccessCount: 0,
      sampledDayCount: 0,
      averageDurationMilliseconds: 0,
      p95DurationMilliseconds: 0,
      maximumDurationMilliseconds: 0,
      workerCount: LEAGUE_AUTOMATION_QUEUE_MAX_CONCURRENT_DISPATCHES,
      refreshIntervalMilliseconds:
        NEAR_LIVE_CANARY_REFRESH_INTERVAL_MILLISECONDS,
      activeLeagueTarget,
    }),
    status: 'not-recorded',
    consecutiveFailureCount: 0,
    lastError: '',
    lastAttemptAt: null,
    windowDays: LEAGUE_AUTOMATION_CAPACITY_WINDOW_DAYS,
    dateFrom: '',
    dateTo: '',
    lastRefreshedAt: null,
    source: 'queue-task',
    allScoringSampleCount: 0,
    allScoringAverageDurationMilliseconds: 0,
    allScoringP95DurationMilliseconds: 0,
    allScoringMaximumDurationMilliseconds: 0,
  };
}

function normalizeStoredLeagueAutomationCapacityEvidence(
  value: DocumentData | undefined,
  activeLeagueTarget: number,
): LeagueAutomationCapacityEvidence {
  if (!value) {
    return emptyLeagueAutomationCapacityEvidence(activeLeagueTarget);
  }

  const recommendation = buildLeagueAutomationCapacityRecommendation({
    queueTaskSampleCount:
      getLeagueAutomationNumber(value['queueTaskSampleCount']) ?? 0,
    queueTaskSuccessCount:
      getLeagueAutomationNumber(value['queueTaskSuccessCount']) ?? 0,
    queueTaskErrorCount:
      getLeagueAutomationNumber(value['queueTaskErrorCount']) ?? 0,
    queueTaskSkippedCount:
      getLeagueAutomationNumber(value['queueTaskSkippedCount']) ?? 0,
    sampledDayCount:
      getLeagueAutomationNumber(value['sampledDayCount']) ?? 0,
    averageDurationMilliseconds:
      getLeagueAutomationNumber(value['averageDurationMilliseconds']) ?? 0,
    p95DurationMilliseconds:
      getLeagueAutomationNumber(value['p95DurationMilliseconds']) ?? 0,
    maximumDurationMilliseconds:
      getLeagueAutomationNumber(value['maximumDurationMilliseconds']) ?? 0,
    workerCount: LEAGUE_AUTOMATION_QUEUE_MAX_CONCURRENT_DISPATCHES,
    refreshIntervalMilliseconds:
      NEAR_LIVE_CANARY_REFRESH_INTERVAL_MILLISECONDS,
    activeLeagueTarget,
  });

  return {
    ...recommendation,
    status: value['status'] === 'healthy' || value['status'] === 'error'
      ? value['status']
      : 'not-recorded',
    consecutiveFailureCount: normalizeLeagueAutomationRevision(
      value['consecutiveFailureCount'],
    ),
    lastError: getLeagueAutomationString(value['lastError']).slice(0, 500),
    lastAttemptAt: getLeagueAutomationIso(value['lastAttemptAt']),
    windowDays:
      getLeagueAutomationNumber(value['windowDays']) ??
      LEAGUE_AUTOMATION_CAPACITY_WINDOW_DAYS,
    dateFrom: getLeagueAutomationString(value['dateFrom']),
    dateTo: getLeagueAutomationString(value['dateTo']),
    lastRefreshedAt: getLeagueAutomationIso(value['lastSuccessfulAt']),
    source: 'queue-task',
    allScoringSampleCount:
      getLeagueAutomationNumber(value['allScoringSampleCount']) ?? 0,
    allScoringAverageDurationMilliseconds:
      getLeagueAutomationNumber(
        value['allScoringAverageDurationMilliseconds'],
      ) ?? 0,
    allScoringP95DurationMilliseconds:
      getLeagueAutomationNumber(
        value['allScoringP95DurationMilliseconds'],
      ) ?? 0,
    allScoringMaximumDurationMilliseconds:
      getLeagueAutomationNumber(
        value['allScoringMaximumDurationMilliseconds'],
      ) ?? 0,
  };
}

async function loadLeagueAutomationCapacityEvidence(
  activeLeagueTarget: number,
): Promise<LeagueAutomationCapacityEvidence> {
  const dateKeys = betaOperationsDateKeys(
    LEAGUE_AUTOMATION_CAPACITY_WINDOW_DAYS,
  );
  const references = dateKeys.flatMap((dateKey) =>
    Array.from({ length: BETA_OPERATION_SHARD_COUNT }, (_, shard) =>
      db.doc(
        `betaOperationsDaily/${dateKey}-${shard.toString().padStart(2, '0')}`,
      )
    )
  );
  const snapshots = references.length > 0
    ? await db.getAll(...references)
    : [];
  let queueTaskAttempts = emptyBetaDurationAccumulator();
  let queueTaskSuccesses = emptyBetaDurationAccumulator();
  let allScoring = emptyBetaDurationAccumulator();
  const sampledDays = new Set<string>();

  for (const snapshot of snapshots) {
    if (!snapshot.exists) {
      continue;
    }

    const data = snapshot.data() ?? {};
    const dateKey = getLeagueAutomationString(data['dateKey']);
    const byTrigger = data['serverScoringByTrigger'] &&
      typeof data['serverScoringByTrigger'] === 'object' &&
      !Array.isArray(data['serverScoringByTrigger'])
        ? data['serverScoringByTrigger'] as Record<string, unknown>
        : {};
    const queueTaskAttemptAccumulator = normalizeBetaDurationAccumulator(
      byTrigger['queue-task'],
    );
    const successfulByTrigger = data['serverScoringSuccessfulByTrigger'] &&
      typeof data['serverScoringSuccessfulByTrigger'] === 'object' &&
      !Array.isArray(data['serverScoringSuccessfulByTrigger'])
        ? data['serverScoringSuccessfulByTrigger'] as Record<string, unknown>
        : {};
    const explicitQueueTaskSuccessAccumulator =
      normalizeBetaDurationAccumulator(successfulByTrigger['queue-task']);
    const legacyQueueTaskSuccessAccumulator =
      explicitQueueTaskSuccessAccumulator.total === 0 &&
      queueTaskAttemptAccumulator.total > 0 &&
      queueTaskAttemptAccumulator.successes === queueTaskAttemptAccumulator.total
        ? queueTaskAttemptAccumulator
        : explicitQueueTaskSuccessAccumulator;

    queueTaskAttempts = mergeBetaDurationAccumulators(
      queueTaskAttempts,
      queueTaskAttemptAccumulator,
    );
    queueTaskSuccesses = mergeBetaDurationAccumulators(
      queueTaskSuccesses,
      legacyQueueTaskSuccessAccumulator,
    );
    allScoring = mergeBetaDurationAccumulators(
      allScoring,
      normalizeBetaDurationAccumulator(data['serverScoring']),
    );

    if (legacyQueueTaskSuccessAccumulator.total > 0 && dateKey) {
      sampledDays.add(dateKey);
    }
  }

  const queueAverage = queueTaskSuccesses.total > 0
    ? Math.round(
        queueTaskSuccesses.durationSumMilliseconds /
        queueTaskSuccesses.total,
      )
    : 0;
  const queueP95 = betaHistogramPercentile(
    queueTaskSuccesses.durationBuckets,
    queueTaskSuccesses.total,
    0.95,
  );
  const allAverage = allScoring.total > 0
    ? Math.round(allScoring.durationSumMilliseconds / allScoring.total)
    : 0;
  const allP95 = betaHistogramPercentile(
    allScoring.durationBuckets,
    allScoring.total,
    0.95,
  );
  const recommendation = buildLeagueAutomationCapacityRecommendation({
    queueTaskSampleCount: queueTaskAttempts.total,
    queueTaskSuccessCount: queueTaskSuccesses.total,
    queueTaskErrorCount: queueTaskAttempts.errors,
    queueTaskSkippedCount: queueTaskAttempts.skipped,
    sampledDayCount: sampledDays.size,
    averageDurationMilliseconds: queueAverage,
    p95DurationMilliseconds: queueP95,
    maximumDurationMilliseconds:
      queueTaskSuccesses.durationMaximumMilliseconds,
    workerCount: LEAGUE_AUTOMATION_QUEUE_MAX_CONCURRENT_DISPATCHES,
    refreshIntervalMilliseconds:
      NEAR_LIVE_CANARY_REFRESH_INTERVAL_MILLISECONDS,
    activeLeagueTarget,
  });

  return {
    ...recommendation,
    status: 'healthy',
    consecutiveFailureCount: 0,
    lastError: '',
    lastAttemptAt: new Date().toISOString(),
    windowDays: LEAGUE_AUTOMATION_CAPACITY_WINDOW_DAYS,
    dateFrom: dateKeys[0] ?? '',
    dateTo: dateKeys[dateKeys.length - 1] ?? '',
    lastRefreshedAt: new Date().toISOString(),
    source: 'queue-task',
    allScoringSampleCount: allScoring.total,
    allScoringAverageDurationMilliseconds: allAverage,
    allScoringP95DurationMilliseconds: allP95,
    allScoringMaximumDurationMilliseconds:
      allScoring.durationMaximumMilliseconds,
  };
}

function getCanonicalScoringAuthorityEligibility(input: {
  config: LeagueAutomationQueueConfig;
  leagueId: string;
  configUpdatedAtMilliseconds: number;
  parityData: DocumentData | undefined;
  authorityData: DocumentData | undefined;
  healthData: DocumentData | undefined;
}): CanonicalScoringAuthorityEligibility {
  if (input.config.mode !== 'canary') {
    return {
      eligible: false,
      reason: 'Enable the exact queued-scoring Canary before canonical reads.',
    };
  }

  if (
    !input.config.canaryLeagueIds.includes(input.leagueId) ||
    !input.config.internalTestLeagueIds.includes(input.leagueId)
  ) {
    return {
      eligible: false,
      reason: 'The league must be both Canary and Internal Test.',
    };
  }

  const otherConfiguredLeague = input.config.canonicalAuthorityLeagueIds.find(
    (leagueId) => leagueId !== input.leagueId,
  );

  if (otherConfiguredLeague) {
    return {
      eligible: false,
      reason: 'D1H permits only one canonical-read Canary at a time.',
    };
  }

  const parityData = input.parityData ?? {};
  const authorityData = input.authorityData ?? {};
  const healthData = input.healthData ?? {};
  const openedAtMilliseconds = toMilliseconds(authorityData['openedAt']);
  const minimumComparedAtMilliseconds = Math.max(
    input.configUpdatedAtMilliseconds,
    openedAtMilliseconds,
  );
  const comparedAtMilliseconds = toMilliseconds(parityData['comparedAt']);
  const comparedCount = getLeagueAutomationNumber(
    parityData['comparedCount'],
  ) ?? 0;
  const mismatchCount = getLeagueAutomationNumber(
    parityData['mismatchCount'],
  ) ?? 0;
  const consecutivePassingRunCount = getLeagueAutomationNumber(
    parityData['consecutivePassingRunCount'],
  ) ?? 0;
  const incompleteCount =
    (getLeagueAutomationNumber(parityData['incompleteCount']) ?? 0) +
    (getLeagueAutomationNumber(parityData['canonicalMissingCount']) ?? 0);
  const totalQueueSuccessCount = getLeagueAutomationNumber(
    healthData['queueTaskSuccessCount'],
  ) ?? 0;
  const successfulTasksSinceCanary = Math.max(
    0,
    totalQueueSuccessCount - input.config.canarySuccessBaseline,
  );
  const activePendingTaskCount = getLeagueAutomationNumber(
    healthData['queueActivePendingTaskCount'],
  ) ?? 0;
  const parityPasses =
    parityData['shadowOnly'] === true &&
    parityData['authoritativeReadsEnabled'] === false &&
    parityData['taskVersionAligned'] === true &&
    parityData['status'] === 'pass' &&
    comparedCount > 0 &&
    mismatchCount === 0 &&
    incompleteCount === 0 &&
    comparedAtMilliseconds >= minimumComparedAtMilliseconds;

  if (!parityPasses) {
    return {
      eligible: false,
      reason: openedAtMilliseconds > 0
        ? 'Fresh perfect shadow parity is required after the last circuit-breaker event.'
        : 'Current version-aligned shadow parity must pass before canonical reads.',
    };
  }

  if (
    consecutivePassingRunCount <
    LEAGUE_AUTOMATION_CANONICAL_AUTHORITY_MIN_PARITY_STREAK
  ) {
    return {
      eligible: false,
      reason: `${
        LEAGUE_AUTOMATION_CANONICAL_AUTHORITY_MIN_PARITY_STREAK -
        consecutivePassingRunCount
      } more consecutive perfect shadow-parity task(s) are required.`,
    };
  }

  if (successfulTasksSinceCanary < 3) {
    return {
      eligible: false,
      reason: `${3 - successfulTasksSinceCanary} more successful Canary task(s) are required.`,
    };
  }

  if (activePendingTaskCount > 0) {
    return {
      eligible: false,
      reason: 'Wait for the scoring queue to become idle before changing authority.',
    };
  }

  return {
    eligible: true,
    reason: 'Eligible for one verified canonical-read Canary with automatic direct fallback.',
  };
}

interface CanonicalScoringParitySnapshotLike {
  exists: boolean;
  data(): DocumentData | undefined;
}

function summarizeCanonicalScoringParityCohort(input: {
  leagueIds: readonly string[];
  minimumComparedAtMilliseconds: number;
  snapshots: readonly CanonicalScoringParitySnapshotLike[];
}): CanonicalScoringParityCohortSummary {
  const leagueIds = [...new Set(input.leagueIds)].sort();

  if (leagueIds.length === 0) {
    return {
      expectedLeagueCount: 0,
      passingLeagueCount: 0,
      mismatchLeagueCount: 0,
      incompleteLeagueCount: 0,
      missingLeagueCount: 0,
      staleLeagueCount: 0,
      totalComparedCount: 0,
      maximumAbsolutePointDelta: 0,
      passing: false,
    };
  }

  let passingLeagueCount = 0;
  let mismatchLeagueCount = 0;
  let incompleteLeagueCount = 0;
  let missingLeagueCount = 0;
  let staleLeagueCount = 0;
  let totalComparedCount = 0;
  let maximumAbsolutePointDelta = 0;

  for (const snapshot of input.snapshots) {
    if (!snapshot.exists) {
      missingLeagueCount += 1;
      continue;
    }

    const data = snapshot.data() ?? {};
    const comparedAtMilliseconds = toMilliseconds(data['comparedAt']);

    if (
      input.minimumComparedAtMilliseconds > 0 &&
      comparedAtMilliseconds < input.minimumComparedAtMilliseconds
    ) {
      staleLeagueCount += 1;
      continue;
    }

    const status = getLeagueAutomationString(data['status'], 'incomplete');
    const comparedCount = getLeagueAutomationNumber(data['comparedCount']) ?? 0;
    const mismatchCount = getLeagueAutomationNumber(data['mismatchCount']) ?? 0;
    const incompleteCount =
      (getLeagueAutomationNumber(data['incompleteCount']) ?? 0) +
      (getLeagueAutomationNumber(data['canonicalMissingCount']) ?? 0);
    const pointDelta = Math.abs(
      getLeagueAutomationNumber(data['maximumAbsolutePointDelta']) ?? 0,
    );
    const passed =
      data['shadowOnly'] === true &&
      data['authoritativeReadsEnabled'] === false &&
      data['taskVersionAligned'] === true &&
      status === 'pass' &&
      comparedCount > 0 &&
      mismatchCount === 0 &&
      incompleteCount === 0;

    totalComparedCount += comparedCount;
    maximumAbsolutePointDelta = Math.max(maximumAbsolutePointDelta, pointDelta);

    if (passed) {
      passingLeagueCount += 1;
    } else if (status === 'mismatch' || mismatchCount > 0) {
      mismatchLeagueCount += 1;
    } else {
      incompleteLeagueCount += 1;
    }
  }

  const unreturnedSnapshotCount = Math.max(
    0,
    leagueIds.length - input.snapshots.length,
  );
  missingLeagueCount += unreturnedSnapshotCount;

  return {
    expectedLeagueCount: leagueIds.length,
    passingLeagueCount,
    mismatchLeagueCount,
    incompleteLeagueCount,
    missingLeagueCount,
    staleLeagueCount,
    totalComparedCount,
    maximumAbsolutePointDelta: Number(maximumAbsolutePointDelta.toFixed(1)),
    passing:
      passingLeagueCount === leagueIds.length &&
      mismatchLeagueCount === 0 &&
      incompleteLeagueCount === 0 &&
      missingLeagueCount === 0 &&
      staleLeagueCount === 0,
  };
}

async function loadCanonicalScoringParityCohort(input: {
  canaryLeagueIds: readonly string[];
  minimumComparedAtMilliseconds: number;
}): Promise<CanonicalScoringParityCohortSummary> {
  const leagueIds = [...new Set(input.canaryLeagueIds)].sort();

  if (leagueIds.length === 0) {
    return summarizeCanonicalScoringParityCohort({
      leagueIds,
      minimumComparedAtMilliseconds: input.minimumComparedAtMilliseconds,
      snapshots: [],
    });
  }

  const snapshots = await db.getAll(
    ...leagueIds.map((leagueId) =>
      db.doc(`leagueAutomationCanonicalParity/${leagueId}`)
    ),
  );

  return summarizeCanonicalScoringParityCohort({
    leagueIds,
    minimumComparedAtMilliseconds: input.minimumComparedAtMilliseconds,
    snapshots,
  });
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
  watchdog: DocumentData | undefined;
  capacityEvidence: LeagueAutomationCapacityEvidence;
  canonicalParityCohort: CanonicalScoringParityCohortSummary;
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
  const watchdog = normalizeLeagueAutomationSeasonWatchdog(input.watchdog);
  const watchdogAge = getLeagueAutomationAgeMilliseconds(
    input.watchdog?.['lastSuccessfulAt'],
    now,
  );
  const watchdogHealthy =
    watchdogAge !== null &&
    watchdogAge <= LEAGUE_AUTOMATION_SEASON_WATCHDOG_STALE_MILLISECONDS &&
    watchdog.status === 'healthy' &&
    watchdog.queueBlockingStreak === 0 &&
    watchdog.canonicalBlockingStreak === 0;
  const capacityEvidenceAge = getLeagueAutomationAgeMilliseconds(
    input.capacityEvidence.lastRefreshedAt,
    now,
  );
  const capacityEvidenceFresh =
    capacityEvidenceAge !== null &&
    capacityEvidenceAge <=
      LEAGUE_AUTOMATION_CAPACITY_EVIDENCE_STALE_MILLISECONDS;
  const capacityEvidenceHealthy =
    input.capacityEvidence.status === 'healthy' &&
    input.capacityEvidence.consecutiveFailureCount === 0;

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
      id: 'season-safety-watchdog',
      label: 'Automatic season fallback watchdog is healthy',
      passed: watchdogHealthy,
      blocking: true,
      detail: watchdogAge === null
        ? 'No watchdog heartbeat is available yet.'
        : `${watchdog.status}; heartbeat ${Math.round(watchdogAge / 1000)} seconds old; queue streak ${watchdog.queueBlockingStreak}; canonical streak ${watchdog.canonicalBlockingStreak}.`,
    },
    {
      id: 'measured-queue-capacity',
      label: 'Measured queue capacity covers every active league',
      passed:
        capacityEvidenceFresh &&
        capacityEvidenceHealthy &&
        input.capacityEvidence.primaryCapacityReady,
      blocking: true,
      detail: !capacityEvidenceFresh
        ? capacityEvidenceAge === null
          ? 'No measured capacity refresh is available yet.'
          : `Measured capacity evidence is ${Math.round(capacityEvidenceAge / 60_000)} minutes old; refresh evidence before Primary promotion.`
        : !capacityEvidenceHealthy
          ? `The latest capacity refresh is ${input.capacityEvidence.status}; ${input.capacityEvidence.lastError || 'investigate the capacity refresher before Primary promotion'}.`
          : input.capacityEvidence.queueTaskSuccessCount <
            LEAGUE_AUTOMATION_CAPACITY_MIN_SAMPLE_COUNT
          ? `${input.capacityEvidence.queueTaskSuccessCount} successful live queue task(s) from ${input.capacityEvidence.queueTaskSampleCount} attempt(s) across ${input.capacityEvidence.sampledDayCount} day(s); at least ${LEAGUE_AUTOMATION_CAPACITY_MIN_SAMPLE_COUNT} successful samples across 3 days are required.`
          : `Queue p95 ${Math.round(input.capacityEvidence.p95DurationMilliseconds / 1000)} seconds; reliability ${(input.capacityEvidence.queueTaskReliabilityRate * 100).toFixed(1)}%; conservative affected-league capacity ${input.capacityEvidence.safeAffectedLeagueCapacity}; active target ${coverageTarget}; primary p95 ceiling ${Math.round(LEAGUE_AUTOMATION_CAPACITY_PRIMARY_MAX_P95_MILLISECONDS / 1000)} seconds.`,
    },
    {
      id: 'canonical-shadow-parity',
      label: 'Canonical NHL facts match direct scoring',
      passed: input.canonicalParityCohort.passing,
      blocking: true,
      detail: input.canonicalParityCohort.expectedLeagueCount === 0
        ? 'No exact Canary leagues are configured for direct-versus-canonical comparison.'
        : `${input.canonicalParityCohort.passingLeagueCount}/${input.canonicalParityCohort.expectedLeagueCount} current Canary league(s) pass; ${input.canonicalParityCohort.mismatchLeagueCount} mismatch, ${input.canonicalParityCohort.incompleteLeagueCount} incomplete, ${input.canonicalParityCohort.missingLeagueCount} missing, ${input.canonicalParityCohort.staleLeagueCount} stale; ${input.canonicalParityCohort.totalComparedCount} comparison(s).`,
    },
    {
      id: 'canonical-authority-canary-complete',
      label: 'Canonical-read Canary is not active during global promotion',
      passed: input.config.canonicalAuthorityLeagueIds.length === 0,
      blocking: true,
      detail: input.config.canonicalAuthorityLeagueIds.length === 0
        ? 'No single-league canonical authority experiment is active.'
        : `Disable the canonical-read Canary for ${input.config.canonicalAuthorityLeagueIds[0]} before considering global Primary.`,
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
  configUpdatedAtMilliseconds: number,
  healthData: DocumentData,
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
    ...config.canonicalAuthorityLeagueIds,
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
  const parityRefs = leagueIds.map((leagueId) =>
    db.doc(`leagueAutomationCanonicalParity/${leagueId}`),
  );
  const authorityRefs = leagueIds.map((leagueId) =>
    getCanonicalScoringAuthorityRef(leagueId),
  );
  const [
    draftSnapshots,
    replaySnapshots,
    scheduleSnapshots,
    paritySnapshots,
    authoritySnapshots,
  ] = await Promise.all([
    draftRefs.length > 0 ? db.getAll(...draftRefs) : Promise.resolve([]),
    replayRefs.length > 0 ? db.getAll(...replayRefs) : Promise.resolve([]),
    scheduleRefs.length > 0 ? db.getAll(...scheduleRefs) : Promise.resolve([]),
    parityRefs.length > 0 ? db.getAll(...parityRefs) : Promise.resolve([]),
    authorityRefs.length > 0 ? db.getAll(...authorityRefs) : Promise.resolve([]),
  ]);

  const leagues = uniqueDocuments.map((leagueDocument, index) => {
    const leagueData = leagueDocument.data() ?? {};
    const draftData = draftSnapshots[index]?.data() ?? {};
    const replayData = replaySnapshots[index]?.data() ?? {};
    const scheduleSnapshot = scheduleSnapshots[index];
    const scheduleData = scheduleSnapshot?.data() ?? {};
    const parityData = paritySnapshots[index]?.data() ?? {};
    const authorityData = authoritySnapshots[index]?.data() ?? {};
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
    const canonicalAuthorityEligibility =
      getCanonicalScoringAuthorityEligibility({
        config,
        leagueId: leagueDocument.id,
        configUpdatedAtMilliseconds,
        parityData,
        authorityData,
        healthData,
      });
    const canonicalAuthorityConfigured =
      config.canonicalAuthorityLeagueIds.includes(leagueDocument.id);

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
      lastRefreshCadence:
        scheduleData['lastRefreshCadence'] === 'near-live-canary'
          ? 'near-live-canary'
          : 'standard',
      lastRefreshDelayMilliseconds: getLeagueAutomationNumber(
        scheduleData['lastRefreshDelayMilliseconds'],
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
      canonicalAuthorityConfigured,
      canonicalAuthorityEligible: canonicalAuthorityEligibility.eligible,
      canonicalAuthorityEligibilityReason:
        canonicalAuthorityConfigured
          ? authorityData['circuitState'] === 'open'
            ? 'The circuit breaker opened; direct scoring remained active.'
            : 'Configured: canonical points publish only after an exact same-task direct match.'
          : canonicalAuthorityEligibility.reason,
      canonicalAuthorityCircuitState: authorityData['circuitState'] === 'open'
        ? 'open'
        : canonicalAuthorityConfigured
          ? 'closed'
          : 'not-configured',
      canonicalAuthorityLastDecision: getLeagueAutomationString(
        authorityData['lastDecision'],
        'not-recorded',
      ),
      canonicalAuthorityLastFallbackReason: getLeagueAutomationString(
        authorityData['openedReason'] || authorityData['lastFallbackReason'],
      ),
      canonicalAuthorityCanonicalUseCount:
        getLeagueAutomationNumber(authorityData['totalCanonicalUseCount']) ?? 0,
      canonicalAuthorityDirectFallbackCount:
        getLeagueAutomationNumber(authorityData['totalDirectFallbackCount']) ?? 0,
      canonicalParityConsecutivePassingRunCount:
        getLeagueAutomationNumber(
          parityData['consecutivePassingRunCount'],
        ) ?? 0,
      canonicalParityRequiredPassingRunCount:
        LEAGUE_AUTOMATION_CANONICAL_AUTHORITY_MIN_PARITY_STREAK,
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
    if (
      left.canonicalAuthorityConfigured !==
      right.canonicalAuthorityConfigured
    ) {
      return left.canonicalAuthorityConfigured ? -1 : 1;
    }
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
      canonicalAuthorityLeagueIdsBefore:
        normalizeLeagueAutomationCanonicalAuthorityIds(
          data['canonicalAuthorityLeagueIdsBefore'],
        ),
      canonicalAuthorityLeagueIdsAfter:
        normalizeLeagueAutomationCanonicalAuthorityIds(
          data['canonicalAuthorityLeagueIdsAfter'],
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

function buildLeagueAutomationSeasonSafetyAlerts(input: {
  config: LeagueAutomationQueueConfig;
  healthData: DocumentData;
  feedData: DocumentData;
  watchdogData: DocumentData;
  capacityEvidence: LeagueAutomationCapacityEvidence;
  canonicalParityCohort: CanonicalScoringParityCohortSummary;
  nowMilliseconds?: number;
}): {
  status: LeagueAutomationSeasonSafetyStatus;
  alerts: LeagueAutomationSeasonSafetyAlert[];
} {
  const now = input.nowMilliseconds ?? Date.now();
  const alerts: LeagueAutomationSeasonSafetyAlert[] = [];
  const modeActive = input.config.mode !== 'shadow';
  const dispatchAge = getLeagueAutomationAgeMilliseconds(
    input.healthData['queueLastDispatchAt'],
    now,
  );
  const feedAge = getLeagueAutomationAgeMilliseconds(
    input.feedData['lastSuccessfulAt'],
    now,
  );
  const oldestDueAge = getLeagueAutomationNumber(
    input.healthData['queueOldestDueAgeMilliseconds'],
  ) ?? 0;
  const activePending = getLeagueAutomationNumber(
    input.healthData['queueActivePendingTaskCount'],
  ) ?? 0;
  const maxPending = getLeagueAutomationNumber(
    input.healthData['queueTaskMaxPendingTasks'],
  ) ?? LEAGUE_AUTOMATION_QUEUE_MAX_PENDING_TASKS;
  const failedEnqueues = getLeagueAutomationNumber(
    input.healthData['queueFailedEnqueueCount'],
  ) ?? 0;
  const staleRecoveries = getLeagueAutomationNumber(
    input.healthData['queueLastRecoveryCount'],
  ) ?? 0;
  const scheduleCoverage = getLeagueAutomationNumber(
    input.healthData['queueScheduleCoverageCount'],
  ) ?? 0;
  const completedDraftCount = getLeagueAutomationNumber(
    input.healthData['queueScheduleCoverageCompletedDraftCount'],
  ) ?? 0;
  const feedFailures = getLeagueAutomationNumber(
    input.feedData['consecutiveFailureCount'],
  ) ?? 0;
  const feedFailedGameCount = getLeagueAutomationNumber(
    input.feedData['failedGameCount'],
  ) ?? 0;
  const circuitOpen =
    input.healthData['canonicalAuthorityCircuitState'] === 'open';
  const watchdog = normalizeLeagueAutomationSeasonWatchdog(
    input.watchdogData,
  );
  const watchdogAge = getLeagueAutomationAgeMilliseconds(
    input.watchdogData['lastSuccessfulAt'],
    now,
  );
  const watchdogActionAge = getLeagueAutomationAgeMilliseconds(
    input.watchdogData['lastActionAt'],
    now,
  );

  if (!modeActive) {
    alerts.push({
      id: 'queue-observing',
      severity: 'info',
      label: 'Shadow observation is active',
      detail: 'The legacy scorer remains authoritative while queue and feed health are observed.',
    });
  }

  if (
    modeActive &&
    (watchdogAge === null ||
      watchdogAge > LEAGUE_AUTOMATION_SEASON_WATCHDOG_STALE_MILLISECONDS)
  ) {
    alerts.push({
      id: 'season-watchdog-stale',
      severity: 'critical',
      label: 'Automatic season fallback watchdog is stale',
      detail: watchdogAge === null
        ? 'No successful season-safety watchdog heartbeat is recorded.'
        : `The last successful watchdog check is ${Math.round(watchdogAge / 1000)} seconds old.`,
    });
  }

  if (
    modeActive &&
    (watchdog.queueBlockingStreak > 0 ||
      watchdog.canonicalBlockingStreak > 0)
  ) {
    alerts.push({
      id: 'season-watchdog-warning-streak',
      severity: 'warning',
      label: 'The season watchdog is confirming an unsafe condition',
      detail: `Queue blocking streak ${watchdog.queueBlockingStreak}/${watchdog.requiredBlockingStreak}; canonical blocking streak ${watchdog.canonicalBlockingStreak}/${watchdog.requiredBlockingStreak}.`,
    });
  }

  if (
    watchdog.lastAction !== 'none' &&
    watchdogActionAge !== null &&
    watchdogActionAge <= 24 * 60 * 60 * 1000
  ) {
    alerts.push({
      id: 'season-watchdog-recent-fallback',
      severity: 'info',
      label: watchdog.lastAction === 'return-to-shadow'
        ? 'The watchdog recently returned scoring to Shadow'
        : 'The watchdog recently disabled canonical authority',
      detail: watchdog.lastActionReason ||
        'The safer direct or legacy scoring path was selected automatically.',
    });
  }

  if (
    modeActive &&
    (dispatchAge === null ||
      dispatchAge > LEAGUE_AUTOMATION_SEASON_SAFETY_DISPATCH_STALE_MILLISECONDS)
  ) {
    alerts.push({
      id: 'dispatcher-stale',
      severity: 'critical',
      label: 'Scoring dispatcher heartbeat is stale',
      detail: dispatchAge === null
        ? 'No successful dispatcher heartbeat is recorded.'
        : `The last dispatcher heartbeat is ${Math.round(dispatchAge / 1000)} seconds old.`,
    });
  }

  if (
    modeActive &&
    (feedAge === null ||
      feedAge > LEAGUE_AUTOMATION_SEASON_SAFETY_FEED_STALE_MILLISECONDS)
  ) {
    alerts.push({
      id: 'canonical-feed-stale',
      severity: 'critical',
      label: 'Canonical NHL feed is stale',
      detail: feedAge === null
        ? 'No successful canonical-feed observation is recorded.'
        : `The last successful canonical-feed observation is ${Math.round(feedAge / 1000)} seconds old.`,
    });
  }

  if (oldestDueAge > LEAGUE_AUTOMATION_SEASON_SAFETY_BACKLOG_BLOCKING_MILLISECONDS) {
    alerts.push({
      id: 'queue-backlog-blocking',
      severity: 'critical',
      label: 'Scoring backlog exceeds ten minutes',
      detail: `The oldest due league has waited ${Math.round(oldestDueAge / 1000)} seconds. Return to Shadow if this does not clear immediately.`,
    });
  } else if (oldestDueAge > LEAGUE_AUTOMATION_SEASON_SAFETY_BACKLOG_WARNING_MILLISECONDS) {
    alerts.push({
      id: 'queue-backlog-warning',
      severity: 'warning',
      label: 'Scoring backlog is growing',
      detail: `The oldest due league has waited ${Math.round(oldestDueAge / 1000)} seconds.`,
    });
  }

  if (failedEnqueues > 0) {
    alerts.push({
      id: 'enqueue-failures',
      severity: 'critical',
      label: 'The latest dispatcher pass had enqueue failures',
      detail: `${failedEnqueues} league task(s) failed to enqueue in the latest recorded pass.`,
    });
  }

  if (activePending >= maxPending && maxPending > 0) {
    alerts.push({
      id: 'queue-capacity-full',
      severity: 'warning',
      label: 'Queue admission ceiling is full',
      detail: `${activePending} of ${maxPending} allowed queued/processing tasks are active.`,
    });
  }

  if (staleRecoveries > 0) {
    alerts.push({
      id: 'stale-recoveries',
      severity: 'warning',
      label: 'Stale scoring tasks required recovery',
      detail: `${staleRecoveries} stale task(s) were recovered in the latest sweep.`,
    });
  }

  if (completedDraftCount > 0 && scheduleCoverage < completedDraftCount) {
    alerts.push({
      id: 'schedule-coverage',
      severity: 'critical',
      label: 'Completed leagues are missing scoring schedules',
      detail: `${scheduleCoverage} of ${completedDraftCount} completed-Draft leagues have schedule coverage.`,
    });
  }

  if (feedFailures > 0 || feedFailedGameCount > 0) {
    alerts.push({
      id: 'feed-failures',
      severity: feedFailures > 1 ? 'critical' : 'warning',
      label: 'Canonical NHL observations need attention',
      detail: `${feedFailures} consecutive feed failure(s); ${feedFailedGameCount} game request failure(s) in the latest successful evidence.`,
    });
  }

  if (
    modeActive &&
    input.config.canaryLeagueIds.length > 0 &&
    !input.canonicalParityCohort.passing
  ) {
    alerts.push({
      id: 'parity-incomplete',
      severity: 'warning',
      label: 'Canonical parity proof is incomplete',
      detail: `${input.canonicalParityCohort.passingLeagueCount}/${input.canonicalParityCohort.expectedLeagueCount} Canary league(s) currently pass.`,
    });
  }

  if (circuitOpen) {
    alerts.push({
      id: 'canonical-circuit-open',
      severity: 'critical',
      label: 'Canonical authority circuit breaker opened',
      detail: 'RinkRat used direct NHL scoring and automatically disabled canonical authority for the affected league.',
    });
  }

  if (
    input.config.canonicalAuthorityLeagueIds.length > 0 &&
    getLeagueAutomationString(
      input.healthData['canonicalAuthorityLastDecision'],
    ) !== 'canonical-verified'
  ) {
    alerts.push({
      id: 'canonical-authority-awaiting-proof',
      severity: 'info',
      label: 'Canonical-read Canary is awaiting a verified use',
      detail: 'The first version-aligned task must use canonical points with zero direct fallback.',
    });
  }

  const capacityEvidenceAge = getLeagueAutomationAgeMilliseconds(
    input.capacityEvidence.lastRefreshedAt,
    now,
  );

  if (
    modeActive &&
    (capacityEvidenceAge === null ||
      capacityEvidenceAge >
        LEAGUE_AUTOMATION_CAPACITY_EVIDENCE_STALE_MILLISECONDS)
  ) {
    alerts.push({
      id: 'capacity-evidence-stale',
      severity: input.config.mode === 'primary' ? 'critical' : 'warning',
      label: 'Measured scoring capacity evidence is stale',
      detail: capacityEvidenceAge === null
        ? 'No successful capacity-evidence refresh is recorded.'
        : `The latest capacity evidence is ${Math.round(capacityEvidenceAge / 60_000)} minutes old.`,
    });
  }

  if (
    input.capacityEvidence.status === 'error' ||
    input.capacityEvidence.consecutiveFailureCount > 0
  ) {
    alerts.push({
      id: 'capacity-refresh-failed',
      severity: input.config.mode === 'primary' ? 'critical' : 'warning',
      label: 'Measured capacity refresh failed',
      detail: input.capacityEvidence.lastError ||
        `${input.capacityEvidence.consecutiveFailureCount} consecutive capacity refresh failure(s) are recorded.`,
    });
  }

  if (
    modeActive &&
    input.capacityEvidence.queueTaskSuccessCount <
      LEAGUE_AUTOMATION_CAPACITY_MIN_SAMPLE_COUNT
  ) {
    alerts.push({
      id: 'capacity-evidence-insufficient',
      severity: 'info',
      label: 'Live queue capacity evidence is still limited',
      detail: `${input.capacityEvidence.queueTaskSuccessCount} successful queue task(s) from ${input.capacityEvidence.queueTaskSampleCount} attempt(s) across ${input.capacityEvidence.sampledDayCount} day(s) are available. Keep the cohort capped while evidence grows.`,
    });
  }

  if (
    input.capacityEvidence.queueTaskSampleCount > 0 &&
    !input.capacityEvidence.reliabilityWithinPrimaryTarget
  ) {
    alerts.push({
      id: 'capacity-success-rate-low',
      severity: input.config.mode === 'primary' ? 'critical' : 'warning',
      label: 'Measured queue-task reliability is below the Primary target',
      detail: `${(input.capacityEvidence.queueTaskReliabilityRate * 100).toFixed(1)}% of ${input.capacityEvidence.queueTaskSampleCount} queue attempt(s) completed without error; the Primary target is ${(LEAGUE_AUTOMATION_CAPACITY_PRIMARY_MIN_RELIABILITY_RATE * 100).toFixed(1)}%. Expected no-op skips count as reliable but never contribute to duration capacity samples.`,
    });
  }

  if (
    input.capacityEvidence.p95DurationMilliseconds >
      LEAGUE_AUTOMATION_CAPACITY_PRIMARY_MAX_P95_MILLISECONDS
  ) {
    alerts.push({
      id: 'capacity-p95-high',
      severity: input.config.mode === 'primary' ? 'critical' : 'warning',
      label: 'Measured scoring p95 is above the Primary target',
      detail: `Queue p95 is ${Math.round(input.capacityEvidence.p95DurationMilliseconds / 1000)} seconds; the current conservative Primary ceiling is ${Math.round(LEAGUE_AUTOMATION_CAPACITY_PRIMARY_MAX_P95_MILLISECONDS / 1000)} seconds.`,
    });
  }

  if (
    input.config.mode === 'primary' &&
    !input.capacityEvidence.primaryCapacityReady
  ) {
    alerts.push({
      id: 'capacity-primary-unsafe',
      severity: 'critical',
      label: 'Measured capacity does not cover the active league target',
      detail: `Conservative capacity ${input.capacityEvidence.safeAffectedLeagueCapacity}; active completed-Draft target ${completedDraftCount}. Return to Canary or Shadow.`,
    });
  }

  const hasCritical = alerts.some((alert) => alert.severity === 'critical');
  const hasWarning = alerts.some((alert) => alert.severity === 'warning');
  const status: LeagueAutomationSeasonSafetyStatus = hasCritical
    ? 'blocked'
    : hasWarning
      ? 'attention'
      : !modeActive || input.config.canonicalAuthorityLeagueIds.length > 0 &&
          getLeagueAutomationString(
            input.healthData['canonicalAuthorityLastDecision'],
          ) !== 'canonical-verified'
        ? 'observing'
        : 'ready';

  return { status, alerts };
}

async function buildLeagueAutomationQueueAdminSnapshot(
  focusLeagueId = '',
): Promise<LeagueAutomationQueueAdminSnapshot> {
  const projectId = getLeagueAutomationProjectId();
  const environment = getLeagueAutomationEnvironment(projectId);
  const [
    configSnapshot,
    healthSnapshot,
    canonicalFeedSnapshot,
    watchdogSnapshot,
    capacitySnapshot,
    approvalSnapshot,
    audit,
  ] = await Promise.all([
    db.doc('appData/leagueAutomationQueueConfig').get(),
    db.doc('appData/leagueAutomation').get(),
    db.doc('appData/nhlCanonicalImpactFeed').get(),
    db.doc('appData/leagueAutomationSeasonWatchdog').get(),
    db.doc('appData/leagueAutomationCapacityEvidence').get(),
    db.doc('appData/leagueAutomationPrimaryApproval').get(),
    loadLeagueAutomationConfigAudit(),
  ]);
  const configData = configSnapshot.data() ?? {};
  const healthData = healthSnapshot.data() ?? {};
  const canonicalFeedData = canonicalFeedSnapshot.data() ?? {};
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
    canonicalAuthorityLeagueIds:
      normalizeLeagueAutomationCanonicalAuthorityIds(
        configData['canonicalAuthorityLeagueIds'],
      ),
    maxEnqueuePerRun: normalizeLeagueAutomationMaxEnqueuePerRun(
      configData['maxEnqueuePerRun'],
    ),
    canarySuccessBaseline: normalizeLeagueAutomationRevision(
      configData['canarySuccessBaseline'],
    ),
    revision: normalizeLeagueAutomationRevision(configData['revision']),
  };
  const activeLeagueTarget = Math.max(
    config.canaryLeagueIds.length,
    getLeagueAutomationNumber(
      healthData['queueScheduleCoverageCompletedDraftCount'],
    ) ?? 0,
  );
  const canonicalParityCohort = await loadCanonicalScoringParityCohort({
    canaryLeagueIds: config.canaryLeagueIds,
    minimumComparedAtMilliseconds: toMilliseconds(configData['updatedAt']),
  });
  const capacityEvidence = normalizeStoredLeagueAutomationCapacityEvidence(
    capacitySnapshot.data(),
    activeLeagueTarget,
  );
  const promotionGates = buildLeagueAutomationPromotionGates({
    config,
    health: healthData,
    watchdog: watchdogSnapshot.data(),
    capacityEvidence,
    canonicalParityCohort,
    approval,
    projectId,
    environment,
  });
  const primaryPromotionAllowed = promotionGates
    .filter((gate) => gate.blocking)
    .every((gate) => gate.passed);
  const seasonSafety = buildLeagueAutomationSeasonSafetyAlerts({
    config,
    healthData,
    feedData: canonicalFeedData,
    watchdogData: watchdogSnapshot.data() ?? {},
    capacityEvidence,
    canonicalParityCohort,
  });
  const leagueResult = await loadLeagueAutomationAdminLeagues(
    config,
    focusLeagueId,
    toMilliseconds(configData['updatedAt']),
    healthData,
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
    canonicalAuthorityLeagueIds: config.canonicalAuthorityLeagueIds,
    canonicalAuthorityConfirmationPhrase:
      LEAGUE_AUTOMATION_CANONICAL_AUTHORITY_CONFIRMATION,
    canonicalAuthorityMaximumLeagueCount:
      LEAGUE_AUTOMATION_CANONICAL_AUTHORITY_MAX_LEAGUE_COUNT,
    canonicalAuthorityMinimumParityStreak:
      LEAGUE_AUTOMATION_CANONICAL_AUTHORITY_MIN_PARITY_STREAK,
    seasonSafetyStatus: seasonSafety.status,
    seasonSafetyAlerts: seasonSafety.alerts,
    seasonSafetyWatchdog: normalizeLeagueAutomationSeasonWatchdog(
      watchdogSnapshot.data(),
    ),
    capacityEvidence,
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
      queueNearLiveCanaryRefreshIntervalMilliseconds:
        NEAR_LIVE_CANARY_REFRESH_INTERVAL_MILLISECONDS,
      queueNearLiveCanaryMaxLeagueCount:
        NEAR_LIVE_CANARY_MAX_LEAGUE_COUNT,
      canonicalParityShadowOnly:
        healthData['canonicalParityShadowOnly'] !== false,
      canonicalParityAuthoritativeReadsEnabled:
        healthData['canonicalParityAuthoritativeReadsEnabled'] === true,
      canonicalParityLastLeagueId: getLeagueAutomationString(
        healthData['canonicalParityLastLeagueId'],
      ),
      canonicalParityLastStatus: getLeagueAutomationString(
        healthData['canonicalParityLastStatus'],
        'not-recorded',
      ),
      canonicalParityLastTaskVersionAligned:
        healthData['canonicalParityLastTaskVersionAligned'] === true,
      canonicalParityLastComparedCount: getLeagueAutomationNumber(
        healthData['canonicalParityLastComparedCount'],
      ) ?? 0,
      canonicalParityLastMatchedCount: getLeagueAutomationNumber(
        healthData['canonicalParityLastMatchedCount'],
      ) ?? 0,
      canonicalParityLastMismatchCount: getLeagueAutomationNumber(
        healthData['canonicalParityLastMismatchCount'],
      ) ?? 0,
      canonicalParityLastIncompleteCount: getLeagueAutomationNumber(
        healthData['canonicalParityLastIncompleteCount'],
      ) ?? 0,
      canonicalParityLastMaximumAbsolutePointDelta: getLeagueAutomationNumber(
        healthData['canonicalParityLastMaximumAbsolutePointDelta'],
      ) ?? 0,
      canonicalParityLastComparedAt: getLeagueAutomationIso(
        healthData['canonicalParityLastComparedAt'],
      ),
      canonicalParityExpectedLeagueCount:
        canonicalParityCohort.expectedLeagueCount,
      canonicalParityPassingLeagueCount:
        canonicalParityCohort.passingLeagueCount,
      canonicalParityMismatchLeagueCount:
        canonicalParityCohort.mismatchLeagueCount,
      canonicalParityIncompleteLeagueCount:
        canonicalParityCohort.incompleteLeagueCount,
      canonicalParityMissingLeagueCount:
        canonicalParityCohort.missingLeagueCount,
      canonicalParityStaleLeagueCount:
        canonicalParityCohort.staleLeagueCount,
      canonicalParityTotalComparedCount:
        canonicalParityCohort.totalComparedCount,
      canonicalParityCohortMaximumAbsolutePointDelta:
        canonicalParityCohort.maximumAbsolutePointDelta,
      canonicalParityCohortPassing: canonicalParityCohort.passing,
      canonicalAuthorityConfiguredLeagueId: getLeagueAutomationString(
        healthData['canonicalAuthorityConfiguredLeagueId'],
      ),
      canonicalAuthorityCircuitState: getLeagueAutomationString(
        healthData['canonicalAuthorityCircuitState'],
        config.canonicalAuthorityLeagueIds.length > 0
          ? 'closed'
          : 'not-configured',
      ),
      canonicalAuthorityLastDecision: getLeagueAutomationString(
        healthData['canonicalAuthorityLastDecision'],
        'not-recorded',
      ),
      canonicalAuthorityLastFallbackReason: getLeagueAutomationString(
        healthData['canonicalAuthorityLastFallbackReason'],
      ),
      canonicalAuthorityLastRuntimeEnabled:
        healthData['canonicalAuthorityLastRuntimeEnabled'] === true,
      canonicalAuthorityLastRuntimeReason: getLeagueAutomationString(
        healthData['canonicalAuthorityLastRuntimeReason'],
      ),
      canonicalAuthorityLastCanonicalUseCount: getLeagueAutomationNumber(
        healthData['canonicalAuthorityLastCanonicalUseCount'],
      ) ?? 0,
      canonicalAuthorityLastDirectFallbackCount: getLeagueAutomationNumber(
        healthData['canonicalAuthorityLastDirectFallbackCount'],
      ) ?? 0,
      canonicalAuthorityCircuitOpenCount: getLeagueAutomationNumber(
        healthData['canonicalAuthorityCircuitOpenCount'],
      ) ?? 0,
      canonicalAuthorityLastOpenedAt: getLeagueAutomationIso(
        healthData['canonicalAuthorityLastOpenedAt'],
      ),
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
  const [
    healthSnapshot,
    watchdogSnapshot,
    approvalSnapshot,
    configSnapshot,
    capacitySnapshot,
  ] = await Promise.all([
    db.doc('appData/leagueAutomation').get(),
    db.doc('appData/leagueAutomationSeasonWatchdog').get(),
    db.doc('appData/leagueAutomationPrimaryApproval').get(),
    db.doc('appData/leagueAutomationQueueConfig').get(),
    db.doc('appData/leagueAutomationCapacityEvidence').get(),
  ]);
  const canonicalParityCohort = await loadCanonicalScoringParityCohort({
    canaryLeagueIds: config.canaryLeagueIds,
    minimumComparedAtMilliseconds: toMilliseconds(
      configSnapshot.data()?.['updatedAt'],
    ),
  });
  const activeLeagueTarget = Math.max(
    config.canaryLeagueIds.length,
    getLeagueAutomationNumber(
      healthSnapshot.data()?.['queueScheduleCoverageCompletedDraftCount'],
    ) ?? 0,
  );
  const capacityEvidence = normalizeStoredLeagueAutomationCapacityEvidence(
    capacitySnapshot.data(),
    activeLeagueTarget,
  );
  const gates = buildLeagueAutomationPromotionGates({
    config,
    health: healthSnapshot.data(),
    watchdog: watchdogSnapshot.data(),
    capacityEvidence,
    canonicalParityCohort,
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

  return;
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
      `${payload.taskSchemaVersion}:${payload.leagueId}:${payload.expectedDueAtMilliseconds}:${payload.reason}:${payload.canonicalSourceVersion ?? ''}`,
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
  return typeof value === 'string' && value.trim()
    ? requireFirestoreDocumentId(value, 'historical replay request ID', {
        maxBytes: 96,
        pattern: /^[A-Za-z0-9_-]+$/,
      })
    : randomUUID().replaceAll('-', '');
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
  const safeLeagueId = requireServerFirestoreDocumentId(
    leagueId,
    'historical replay league identifier',
    FIRESTORE_LEAGUE_ID_OPTIONS,
  );
  const safeAssetKey = requireServerFirestoreDocumentId(
    assetKey,
    'historical replay asset identifier',
    FIRESTORE_ASSET_KEY_OPTIONS,
  );
  return db.doc(`leagues/${safeLeagueId}/historicalReplayAssets/${safeAssetKey}`);
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
  const base = scoringRulesForVersion(version);

  const normalized: ScoringRules = {
    ...base,
    ...stored,
    forward: {
      ...base.forward,
      ...(stored.forward ?? {}),
      goal: {
        ...base.forward.goal,
        ...(stored.forward?.goal ?? {}),
      },
      primaryAssist: {
        ...base.forward.primaryAssist,
        ...(stored.forward?.primaryAssist ?? {}),
      },
      secondaryAssist: {
        ...base.forward.secondaryAssist,
        ...(stored.forward?.secondaryAssist ?? {}),
      },
    },
    defense: {
      ...base.defense,
      ...(stored.defense ?? {}),
      goal: {
        ...base.defense.goal,
        ...(stored.defense?.goal ?? {}),
      },
      primaryAssist: {
        ...base.defense.primaryAssist,
        ...(stored.defense?.primaryAssist ?? {}),
      },
      secondaryAssist: {
        ...base.defense.secondaryAssist,
        ...(stored.defense?.secondaryAssist ?? {}),
      },
    },
    goalieSavePercentageTiers:
      Array.isArray(stored.goalieSavePercentageTiers) &&
      stored.goalieSavePercentageTiers.length > 0
        ? stored.goalieSavePercentageTiers
        : base.goalieSavePercentageTiers,
  };

  /*
   * Pre-V3 documents are upgraded only to the frozen V3 defense/goalie model.
   * V3 leagues remain V3 until the guarded preseason V4 migration runs; this
   * prevents a source deployment from silently changing an active league.
   */
  if (typeof version !== 'number' || version < SCORING_RULES_V3_VERSION) {
    const v3 = scoringRulesForVersion(SCORING_RULES_V3_VERSION);
    normalized.defense = v3.defense;
    normalized.defenseToiBaseMultiplier = v3.defenseToiBaseMultiplier;
    normalized.defenseToiPlusMinusModifier = v3.defenseToiPlusMinusModifier;
    normalized.defenseToiFloor = v3.defenseToiFloor;
    normalized.defenseToiCeiling = v3.defenseToiCeiling;
    normalized.goalieGameBase = v3.goalieGameBase;
    normalized.goalieSave = v3.goalieSave;
    normalized.goalieWin = v3.goalieWin;
    normalized.goalieShutout = v3.goalieShutout;
    normalized.goalieSavePercentageBaseline = v3.goalieSavePercentageBaseline;
    normalized.goalieSavePercentageBasePoints = v3.goalieSavePercentageBasePoints;
    normalized.goalieSavePercentagePointsPerPercentagePoint =
      v3.goalieSavePercentagePointsPerPercentagePoint;
    normalized.goalieSavePercentageMinimum = v3.goalieSavePercentageMinimum;
    normalized.goalieSavePercentageMaximum = v3.goalieSavePercentageMaximum;
    normalized.goalieSavePercentageTiers = v3.goalieSavePercentageTiers;
    normalized.goalieGameMaximum = v3.goalieGameMaximum;
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
      typeof data['scoringRulesVersion'] === 'number' &&
      data['scoringRulesVersion'] >= CURRENT_SCORING_RULES_VERSION
        ? data['scoringRulesVersion']
        : SCORING_RULES_V3_VERSION,
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
  refreshCadence: LeagueAutomationRefreshCadence,
  refreshDelayMilliseconds: number,
  phaseTiming?: ScoringPhaseTimingSnapshot,
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
    lastRefreshCadence: refreshCadence,
    lastRefreshDelayMilliseconds: Math.max(0, refreshDelayMilliseconds),
    lastPhaseTiming: scoringPhaseTimingForFirestore(phaseTiming),
    lastLongestPhase: phaseTiming?.longestPhase ?? '',
    lastLongestPhaseDurationMilliseconds:
      phaseTiming?.longestPhaseDurationMilliseconds ?? 0,
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

async function recordBetaServerScoringMetric(
  leagueId: string,
  trigger: LeagueAutomationTrigger,
  outcome: 'success' | 'skipped' | 'error',
  durationMilliseconds: number,
  phaseTiming?: ScoringPhaseTimingSnapshot,
): Promise<void> {
  const dateKey = betaOperationsDateKey();
  const shardId = betaOperationsShardId(leagueId);
  const reference = db.doc(`betaOperationsDaily/${dateKey}-${shardId}`);
  const triggerKey = trigger.replace(/[^a-z0-9-]/gi, '').slice(0, 40) || 'unknown';

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const data = snapshot.data() ?? {};
    const serverScoring = addBetaDurationSample(
      normalizeBetaDurationAccumulator(data['serverScoring']),
      durationMilliseconds,
      outcome,
    );
    const byTrigger = data['serverScoringByTrigger'] &&
      typeof data['serverScoringByTrigger'] === 'object' &&
      !Array.isArray(data['serverScoringByTrigger'])
        ? data['serverScoringByTrigger'] as Record<string, unknown>
        : {};
    const serverScoringByTrigger = {
      ...byTrigger,
      [triggerKey]: addBetaDurationSample(
        normalizeBetaDurationAccumulator(byTrigger[triggerKey]),
        durationMilliseconds,
        outcome,
      ),
    };
    const successfulByTrigger = data['serverScoringSuccessfulByTrigger'] &&
      typeof data['serverScoringSuccessfulByTrigger'] === 'object' &&
      !Array.isArray(data['serverScoringSuccessfulByTrigger'])
        ? data['serverScoringSuccessfulByTrigger'] as Record<string, unknown>
        : {};
    const serverScoringSuccessfulByTrigger = outcome === 'success'
      ? {
          ...successfulByTrigger,
          [triggerKey]: addBetaDurationSample(
            normalizeBetaDurationAccumulator(successfulByTrigger[triggerKey]),
            durationMilliseconds,
            'success',
          ),
        }
      : successfulByTrigger;
    const existingPhases = data['serverScoringPhases'] &&
      typeof data['serverScoringPhases'] === 'object' &&
      !Array.isArray(data['serverScoringPhases'])
        ? data['serverScoringPhases'] as Record<string, unknown>
        : {};
    const serverScoringPhases = { ...existingPhases };

    if (phaseTiming) {
      for (const phase of SCORING_PHASE_NAMES) {
        const phaseDuration = phaseTiming.phases[phase];

        if (phaseDuration <= 0) {
          continue;
        }

        serverScoringPhases[phase] = addBetaDurationSample(
          normalizeBetaDurationAccumulator(existingPhases[phase]),
          phaseDuration,
          outcome,
        );
      }
    }

    transaction.set(reference, {
      schemaVersion: 1,
      dateKey,
      shardId,
      serverScoring,
      serverScoringByTrigger,
      serverScoringSuccessfulByTrigger,
      serverScoringPhases,
      updatedAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(
        Date.now() + BETA_OPERATION_DAILY_RETENTION_MILLISECONDS,
      ),
    }, { merge: true });
  });
}

async function runLeagueAutomation(
  leagueId: string,
  force: boolean,
  trigger: LeagueAutomationTrigger,
  refreshCadence: LeagueAutomationRefreshCadence = 'standard',
  canonicalParityContext?: CanonicalScoringParityTaskContext,
  canonicalAuthorityContext?: CanonicalScoringAuthorityRuntimeContext,
): Promise<LeagueAutomationResult> {
  const safeLeagueId = requireServerFirestoreDocumentId(
    leagueId,
    'league automation identifier',
    FIRESTORE_LEAGUE_ID_OPTIONS,
  );
  leagueId = safeLeagueId;
  const startedAt = Date.now();
  const phaseTimer = new ScoringPhaseTimer();
  const historicalReplayControlForSkip =
    trigger === 'scheduled' || trigger === 'queue-task'
      ? await phaseTimer.measure(
          'lease-and-prerequisites',
          () => getHistoricalReplayControl(leagueId),
        )
      : null;

  // Historical replay leagues advance only when a platform administrator
  // releases the next simulated NHL date. The scheduled live scorer must not
  // compete for the same league lease or process that replay date on its own.
  if (historicalReplayControlForSkip) {
    await recordLeagueAutomationPaused(leagueId, 'historical-replay')
      .catch((error) => {
        console.warn('Unable to record the historical-replay queue pause.', {
          leagueId,
          error,
        });
      });

    const durationMilliseconds = Date.now() - startedAt;
    const phaseTiming = phaseTimer.snapshot(durationMilliseconds);
    await recordBetaServerScoringMetric(
      leagueId,
      trigger,
      'skipped',
      durationMilliseconds,
      phaseTiming,
    ).catch(() => undefined);

    return {
      leagueId,
      status: 'skipped',
      skipReason: 'historical-replay',
      activeCycleNumbers: [],
      publishedSnapshotCount: 0,
      skippedSnapshotCount: 0,
      cycleOneCreated: false,
      durationMilliseconds,
      phaseTiming,
    };
  }

  const workerId = `${SERVER_WORKER_PREFIX}${randomUUID()}`;
  const lease = await phaseTimer.measure(
    'lease-and-prerequisites',
    () => claimLeagueAutomationLease(
      leagueId,
      workerId,
      force,
      trigger,
    ),
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

    const durationMilliseconds = Date.now() - startedAt;
    const phaseTiming = phaseTimer.snapshot(durationMilliseconds);
    await recordBetaServerScoringMetric(
      leagueId,
      trigger,
      'skipped',
      durationMilliseconds,
      phaseTiming,
    ).catch(() => undefined);

    return {
      leagueId,
      status: 'skipped',
      skipReason: lease.reason,
      activeCycleNumbers: [],
      publishedSnapshotCount: 0,
      skippedSnapshotCount: 0,
      cycleOneCreated: false,
      durationMilliseconds,
      nextRefreshAtMilliseconds: lease.nextRefreshAtMilliseconds,
      phaseTiming,
    };
  }

  let publishedSnapshotCount = 0;
  let skippedSnapshotCount = 0;
  let cycleOneCreated = false;
  let activeCycleNumbers: number[] = [];
  let transitionOccurred = false;
  let replayControl: HistoricalReplayControl | null = null;
  const allResults: CycleScoringResult[] = [];
  const canonicalParityObservations: CanonicalScoringParityObservation[] = [];
  const canonicalAuthorityDecisions: CanonicalScoringAuthorityDecision[] = [];
  const canonicalParityLoad = canonicalParityContext
    ? await loadCanonicalScoringParityGames({
        leagueId,
        context: canonicalParityContext,
      }).catch((error: unknown) => {
        console.error('Unable to load canonical scoring parity facts.', {
          leagueId,
          taskSourceVersion: canonicalParityContext.sourceVersion,
          error,
        });

        return {
          gamesById: new Map<number, CanonicalScoringParityGame>(),
          requestedGameIds: canonicalParityContext.gameIds,
          loadedGameIds: [],
          missingGameIds: canonicalParityContext.gameIds,
          invalidGameIds: [],
          calculatedAggregateSourceVersion: '',
          taskSourceVersion: canonicalParityContext.sourceVersion,
          taskVersionAligned: false,
        } satisfies CanonicalScoringParityLoadResult;
      })
    : null;

  try {
    const league = await phaseTimer.measure(
      'league-and-team-load',
      () => getServerLeague(leagueId),
    );

    if (!league) {
      throw new Error('League not found for server automation.');
    }

    const teams = await phaseTimer.measure(
      'league-and-team-load',
      () => getLeagueTeams(leagueId),
    );
    cycleOneCreated = await phaseTimer.measure(
      'cycle-bootstrap',
      () => ensureCycleOneStarted(
        leagueId,
        teams,
      ),
    );
    replayControl = await phaseTimer.measure(
      'historical-replay-data',
      () => getHistoricalReplayControl(leagueId),
    );
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
      const activeCycles = await phaseTimer.measure(
        'cycle-discovery',
        () => getActiveLeagueCycles(leagueId),
      );
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
        const pendingMoveReconciliation = await phaseTimer.measure(
          'roster-move-reconciliation',
          () => reconcilePendingRosterMovesForRegularSeasonCycle(
            leagueId,
            teams,
            cycle,
          ),
        );

        if (pendingMoveReconciliation.activatedMoveCount > 0) {
          passTransitionOccurred = true;
        }

        const picks = await phaseTimer.measure(
          'roster-pick-load',
          () => getCycleRosterPicksOnce(
            leagueId,
            cycle.cycleNumber,
          ),
        );

        if (picks.length === 0) {
          continue;
        }

        const previous = await phaseTimer.measure(
          'previous-snapshot-load',
          () => getPreviousScoringSnapshot(
            leagueId,
            cycle.cycleNumber,
          ),
        );
        const replayContext = replayControl
          ? await phaseTimer.measure(
              'historical-replay-data',
              () => buildReplayRunContext(leagueId, picks, replayControl!),
            )
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
          nhlRefreshProfile: refreshCadence,
          onPhaseDuration: (phase, durationMilliseconds) => {
            phaseTimer.add(phase, durationMilliseconds);
          },
          canonicalParityGamesById: canonicalParityLoad?.gamesById,
          onCanonicalParityObservation: canonicalParityLoad
            ? (observation) => {
                if (canonicalParityObservations.length < 2_000) {
                  canonicalParityObservations.push(observation);
                }
              }
            : undefined,
          canonicalAuthorityConfigured:
            canonicalAuthorityContext?.enabled === true,
          canonicalAuthorityTaskVersionAligned:
            canonicalParityLoad?.taskVersionAligned === true,
          onCanonicalAuthorityDecision: canonicalAuthorityContext?.enabled
            ? (decision) => {
                if (canonicalAuthorityDecisions.length < 2_000) {
                  canonicalAuthorityDecisions.push(decision);
                }
              }
            : undefined,
        });
        const published = await phaseTimer.measure(
          'snapshot-publication',
          () => publishCycleSnapshot(
            leagueId,
            workerId,
            cycle,
            snapshotSeason,
            result,
            scoringRulesFingerprint,
            previous,
          ),
        );

        if (published) {
          publishedSnapshotCount += 1;
        } else {
          skippedSnapshotCount += 1;
        }

        allResults.push(result);

        const changedPeriod = await phaseTimer.measure(
          'window-and-competition-persistence',
          () => persistServerScoring(
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
          ),
        );

        passTransitionOccurred =
          passTransitionOccurred || changedPeriod;
      }

      const refreshedActiveCycles = await phaseTimer.measure(
        'post-transition-cycle-refresh',
        () => getActiveLeagueCycles(leagueId),
      );
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
      Date.now(),
      refreshCadence,
    );
    const nextRefreshAtMilliseconds = Date.now() + refreshDelay;

    await phaseTimer.measure(
      'control-publication',
      () => getControlRef(leagueId).set(
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
        lastRefreshCadence: refreshCadence,
        lastRefreshDelayMilliseconds: refreshDelay,
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
      ),
    );

    const durationBeforeObservability = Date.now() - startedAt;
    const phaseTimingBeforeObservability = phaseTimer.snapshot(
      durationBeforeObservability,
    );
    const canonicalAuthoritySummary = canonicalAuthorityContext?.enabled
      ? summarizeCanonicalScoringAuthorityTask({
          configured: true,
          taskVersionAligned:
            canonicalParityLoad?.taskVersionAligned === true,
          decisions: canonicalAuthorityDecisions,
        })
      : undefined;

    await phaseTimer.measure(
      'queue-and-observability',
      async () => {
        await Promise.all([
          recordLeagueAutomationSuccess(
            leagueId,
            trigger,
            nextRefreshAtMilliseconds,
            durationBeforeObservability,
            publishedSnapshotCount,
            skippedSnapshotCount,
            refreshCadence,
            refreshDelay,
            phaseTimingBeforeObservability,
          ).catch((error) => {
            console.error('League scoring completed, but its queue schedule was not recorded.', {
              leagueId,
              trigger,
              error,
            });
          }),
          recordBetaServerScoringMetric(
            leagueId,
            trigger,
            'success',
            durationBeforeObservability,
            phaseTimingBeforeObservability,
          ).catch(() => undefined),
          getControlRef(leagueId).set(
            {
              lastPhaseTiming: scoringPhaseTimingForFirestore(
                phaseTimingBeforeObservability,
              ),
              lastLongestPhase: phaseTimingBeforeObservability.longestPhase,
              lastLongestPhaseDurationMilliseconds:
                phaseTimingBeforeObservability
                  .longestPhaseDurationMilliseconds,
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true },
          ).catch(() => undefined),
          canonicalParityContext && canonicalParityLoad
            ? recordCanonicalScoringParityEvidence({
                leagueId,
                context: canonicalParityContext,
                load: canonicalParityLoad,
                observations: canonicalParityObservations,
                authorityEnabled: canonicalAuthorityContext?.enabled === true,
              }).catch((error: unknown) => {
                console.error('Unable to record canonical scoring parity.', {
                  leagueId,
                  error,
                });
              })
            : Promise.resolve(),
          canonicalAuthoritySummary && canonicalParityContext
            ? recordCanonicalScoringAuthorityOutcome({
                leagueId,
                sourceVersion: canonicalParityContext.sourceVersion,
                summary: canonicalAuthoritySummary,
              }).catch((error: unknown) => {
                console.error(
                  'Unable to record canonical scoring authority outcome.',
                  { leagueId, error },
                );
              })
            : Promise.resolve(),
        ]);
      },
    );

    const durationMilliseconds = Date.now() - startedAt;
    const phaseTiming = phaseTimer.snapshot(durationMilliseconds);

    console.info('League automation phase timing.', {
      leagueId,
      trigger,
      outcome: 'success',
      durationMilliseconds,
      longestPhase: phaseTiming.longestPhase,
      longestPhaseDurationMilliseconds:
        phaseTiming.longestPhaseDurationMilliseconds,
      phases: phaseTiming.phases,
    });

    return {
      leagueId,
      status: 'success',
      activeCycleNumbers,
      publishedSnapshotCount,
      skippedSnapshotCount,
      cycleOneCreated,
      durationMilliseconds,
      nextRefreshAtMilliseconds,
      refreshCadence,
      refreshDelayMilliseconds: refreshDelay,
      phaseTiming,
      canonicalAuthorityUsedCount:
        canonicalAuthoritySummary?.canonicalUsedCount ?? 0,
      canonicalAuthorityFallbackCount:
        canonicalAuthoritySummary?.directFallbackCount ?? 0,
      canonicalAuthorityCircuitOpened:
        canonicalAuthoritySummary?.tripCircuitBreaker ?? false,
    };
  } catch (error: unknown) {
    const message = error instanceof Error
      ? error.message
      : 'Server league automation failed.';

    const errorDurationMilliseconds = Date.now() - startedAt;
    const errorPhaseTiming = phaseTimer.snapshot(errorDurationMilliseconds);

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
        lastPhaseTiming: scoringPhaseTimingForFirestore(errorPhaseTiming),
        lastLongestPhase: errorPhaseTiming.longestPhase,
        lastLongestPhaseDurationMilliseconds:
          errorPhaseTiming.longestPhaseDurationMilliseconds,
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

    await recordBetaServerScoringMetric(
      leagueId,
      trigger,
      'error',
      errorDurationMilliseconds,
      errorPhaseTiming,
    ).catch(() => undefined);

    console.error('League automation phase timing.', {
      leagueId,
      trigger,
      outcome: 'error',
      durationMilliseconds: errorDurationMilliseconds,
      longestPhase: errorPhaseTiming.longestPhase,
      longestPhaseDurationMilliseconds:
        errorPhaseTiming.longestPhaseDurationMilliseconds,
      phases: errorPhaseTiming.phases,
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

  const safeLeagueId = resolveSafeFirestoreDocumentId(
    leagueId,
    FIRESTORE_LEAGUE_ID_OPTIONS,
  );

  if (!safeLeagueId || expectedDueAtMilliseconds <= 0 || value?.['scoringEnabled'] === false) {
    return null;
  }

  return {
    leagueId: safeLeagueId,
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
    canonicalSourceVersion: normalizeCanonicalSourceVersion(
      value?.['canonicalRequestedSourceVersion'],
    ),
    canonicalRequestedAtMilliseconds: toMilliseconds(
      value?.['canonicalRequestedAt'],
    ),
    canonicalGameIds: normalizeCanonicalParityGameIds(
      value?.['canonicalPendingGameIds'],
    ),
    canonicalGameVersions: normalizeCanonicalGameVersions(
      value?.['canonicalPendingGameVersions'],
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
    ...(schedule.canonicalSourceVersion
      ? {
          canonicalSourceVersion: schedule.canonicalSourceVersion,
          canonicalRequestedAtMilliseconds:
            schedule.canonicalRequestedAtMilliseconds || undefined,
          canonicalGameIds: schedule.canonicalGameIds,
          canonicalGameVersions: schedule.canonicalGameVersions,
        }
      : {}),
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
    const scheduleCanonicalSourceVersion = normalizeCanonicalSourceVersion(
      data['canonicalRequestedSourceVersion'],
    );
    const payloadCanonicalSourceVersion = normalizeCanonicalSourceVersion(
      payload.canonicalSourceVersion,
    );

    if (
      data['scoringEnabled'] === false ||
      nextScoringAt <= 0 ||
      nextScoringAt > now ||
      nextScoringAt !== payload.expectedDueAtMilliseconds ||
      (payloadCanonicalSourceVersion &&
        payloadCanonicalSourceVersion !== scheduleCanonicalSourceVersion)
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
        activeTaskCanonicalSourceVersion:
          payloadCanonicalSourceVersion || null,
        activeTaskCanonicalRequestedAt:
          payload.canonicalRequestedAtMilliseconds
            ? Timestamp.fromMillis(payload.canonicalRequestedAtMilliseconds)
            : FieldValue.delete(),
        activeTaskCanonicalGameIds: payload.canonicalGameIds ?? [],
        activeTaskCanonicalGameVersions: payload.canonicalGameVersions ?? [],
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
        canonicalSourceVersion: payloadCanonicalSourceVersion || null,
        canonicalRequestedAt:
          payload.canonicalRequestedAtMilliseconds
            ? Timestamp.fromMillis(payload.canonicalRequestedAtMilliseconds)
            : null,
        canonicalGameIds: payload.canonicalGameIds ?? [],
        canonicalGameVersions: payload.canonicalGameVersions ?? [],
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
    const taskCanonicalSourceVersion = normalizeCanonicalSourceVersion(
      payload.canonicalSourceVersion,
    );
    const latestCanonicalSourceVersion = normalizeCanonicalSourceVersion(
      scheduleData['canonicalRequestedSourceVersion'],
    );
    const canonicalCompletion = decideCanonicalRequestCompletion({
      resultStatus: result.status,
      taskSourceVersion: taskCanonicalSourceVersion,
      latestRequestedSourceVersion: latestCanonicalSourceVersion,
    });
    const canonicalNeedsFollowUp = canonicalCompletion.needsFollowUp;
    const canonicalSatisfied = canonicalCompletion.satisfied;

    if (activeTaskId === taskId) {
      const scheduleCompletionData: Record<string, unknown> = {
        queueStatus: canonicalNeedsFollowUp
          ? 'pending'
          : result.status === 'success'
            ? 'idle'
            : 'skipped',
        activeTaskId: null,
        activeTaskDueAt: FieldValue.delete(),
        activeTaskCanonicalSourceVersion: FieldValue.delete(),
        activeTaskCanonicalRequestedAt: FieldValue.delete(),
        activeTaskCanonicalGameIds: [],
        activeTaskCanonicalGameVersions: [],
        activeTaskLeaseExpiresAt: FieldValue.delete(),
        lastQueueCompletedAt: FieldValue.serverTimestamp(),
        lastQueueTaskId: taskId,
        lastQueueTaskDurationMilliseconds: Math.max(0, Date.now() - startedAt),
        lastQueueTaskOutcome: result.status,
        lastQueueTaskSkipReason: result.skipReason ?? '',
        lastQueueError: '',
        updatedAt: FieldValue.serverTimestamp(),
      };

      if (canonicalNeedsFollowUp) {
        scheduleCompletionData['nextScoringAt'] = Timestamp.fromMillis(Date.now());
        scheduleCompletionData['canonicalRequestStatus'] = 'pending-follow-up';
        scheduleCompletionData['canonicalFollowUpRequestedAt'] =
          FieldValue.serverTimestamp();
      } else if (canonicalSatisfied) {
        scheduleCompletionData['canonicalRequestStatus'] = 'complete';
        scheduleCompletionData['canonicalCompletedSourceVersion'] =
          taskCanonicalSourceVersion;
        scheduleCompletionData['canonicalCompletedAt'] =
          FieldValue.serverTimestamp();
        // Move the satisfied version out of the pending fields so later ordinary
        // scheduled tasks do not keep carrying an already-completed NHL version.
        scheduleCompletionData['canonicalRequestedSourceVersion'] =
          FieldValue.delete();
        scheduleCompletionData['canonicalRequestedAt'] = FieldValue.delete();
        scheduleCompletionData['canonicalFollowUpRequestedAt'] =
          FieldValue.delete();
        scheduleCompletionData['canonicalPendingGameIds'] = [];
        scheduleCompletionData['canonicalPendingGameVersions'] = [];
        scheduleCompletionData['canonicalPendingGameVersionsComplete'] = true;
        scheduleCompletionData['canonicalPendingChangeKinds'] = [];
      } else if (
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
        refreshCadence: result.refreshCadence ?? 'standard',
        refreshDelayMilliseconds: result.refreshDelayMilliseconds ?? null,
        phaseTiming: scoringPhaseTimingForFirestore(result.phaseTiming),
        longestPhase: result.phaseTiming?.longestPhase ?? '',
        longestPhaseDurationMilliseconds:
          result.phaseTiming?.longestPhaseDurationMilliseconds ?? 0,
        canonicalSourceVersion: taskCanonicalSourceVersion || null,
        canonicalCompletionState: canonicalCompletion.completionState,
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


function getLeagueAutomationWatchdogActionReason(input: {
  action: LeagueAutomationWatchdogAction;
  alerts: LeagueAutomationSeasonSafetyAlert[];
  queueBlockingAlertIds: readonly string[];
  canonicalBlockingAlertIds: readonly string[];
}): string {
  const selectedIds = input.action === 'return-to-shadow'
    ? input.queueBlockingAlertIds
    : input.canonicalBlockingAlertIds;
  const selected = input.alerts
    .filter((alert) => selectedIds.includes(alert.id))
    .map((alert) => alert.label);
  const actionLabel = input.action === 'return-to-shadow'
    ? 'Queued scoring automatically returned to Shadow'
    : 'Canonical scoring authority automatically disabled';

  return `${actionLabel}: ${selected.join('; ') || selectedIds.join(', ') || 'season safety threshold reached'}`
    .slice(0, 500);
}

async function recordLeagueAutomationWatchdogObservation(input: {
  decision: ReturnType<typeof decideLeagueAutomationWatchdogAction>;
  config: LeagueAutomationQueueConfig;
  safety: {
    status: LeagueAutomationSeasonSafetyStatus;
    alerts: LeagueAutomationSeasonSafetyAlert[];
  };
  durationMilliseconds: number;
}): Promise<void> {
  const watchdogRef = db.doc('appData/leagueAutomationSeasonWatchdog');
  const healthRef = db.doc('appData/leagueAutomation');
  const alertIds = input.safety.alerts.map((alert) => alert.id).slice(0, 30);

  await Promise.all([
    watchdogRef.set(
      {
        schemaVersion: 1,
        status: input.decision.status,
        queueBlockingStreak: input.decision.queueBlockingStreak,
        canonicalBlockingStreak: input.decision.canonicalBlockingStreak,
        requiredBlockingStreak:
          LEAGUE_AUTOMATION_WATCHDOG_REQUIRED_BLOCKING_STREAK,
        lastQueueBlockingAlertIds:
          input.decision.queueBlockingAlertIds,
        lastCanonicalBlockingAlertIds:
          input.decision.canonicalBlockingAlertIds,
        lastSafetyStatus: input.safety.status,
        lastSafetyAlertIds: alertIds,
        lastObservedMode: input.config.mode,
        lastObservedConfigRevision: input.config.revision,
        lastDurationMilliseconds: input.durationMilliseconds,
        consecutiveFailureCount: 0,
        lastError: null,
        lastAttemptAt: FieldValue.serverTimestamp(),
        lastSuccessfulAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    ),
    healthRef.set(
      {
        seasonWatchdogStatus: input.decision.status,
        seasonWatchdogQueueBlockingStreak:
          input.decision.queueBlockingStreak,
        seasonWatchdogCanonicalBlockingStreak:
          input.decision.canonicalBlockingStreak,
        seasonWatchdogRequiredBlockingStreak:
          LEAGUE_AUTOMATION_WATCHDOG_REQUIRED_BLOCKING_STREAK,
        seasonWatchdogLastError: null,
        seasonWatchdogLastAttemptAt: FieldValue.serverTimestamp(),
        seasonWatchdogLastSuccessfulAt: FieldValue.serverTimestamp(),
        seasonWatchdogLastAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    ),
  ]);
}

async function applyLeagueAutomationWatchdogFallback(input: {
  observedConfig: LeagueAutomationQueueConfig;
  decision: ReturnType<typeof decideLeagueAutomationWatchdogAction>;
  safety: {
    status: LeagueAutomationSeasonSafetyStatus;
    alerts: LeagueAutomationSeasonSafetyAlert[];
  };
  reason: string;
  durationMilliseconds: number;
}): Promise<boolean> {
  const configRef = db.doc('appData/leagueAutomationQueueConfig');
  const healthRef = db.doc('appData/leagueAutomation');
  const watchdogRef = db.doc('appData/leagueAutomationSeasonWatchdog');
  const primaryApprovalRef = db.doc('appData/leagueAutomationPrimaryApproval');
  const actionHash = createHash('sha256')
    .update([
      input.decision.action,
      input.observedConfig.revision,
      ...input.decision.queueBlockingAlertIds,
      ...input.decision.canonicalBlockingAlertIds,
    ].join(':'))
    .digest('hex')
    .slice(0, 24);
  const auditRef = getLeagueAutomationAuditRef(
    `season-watchdog-${input.observedConfig.revision}-${actionHash}`,
  );
  const projectId = getLeagueAutomationProjectId();
  const environment = getLeagueAutomationEnvironment(projectId);

  return db.runTransaction(async (transaction) => {
    const [configSnapshot, auditSnapshot] = await Promise.all([
      transaction.get(configRef),
      transaction.get(auditRef),
    ]);
    const data = configSnapshot.data() ?? {};
    const before: LeagueAutomationQueueConfig = {
      mode: normalizeLeagueAutomationQueueMode(data['mode']),
      canaryLeagueIds: normalizeLeagueAutomationCanaryIds(
        data['canaryLeagueIds'],
      ),
      internalTestLeagueIds: normalizeLeagueAutomationInternalTestIds(
        data['internalTestLeagueIds'],
      ),
      canonicalAuthorityLeagueIds:
        normalizeLeagueAutomationCanonicalAuthorityIds(
          data['canonicalAuthorityLeagueIds'],
        ),
      maxEnqueuePerRun: normalizeLeagueAutomationMaxEnqueuePerRun(
        data['maxEnqueuePerRun'],
      ),
      canarySuccessBaseline: normalizeLeagueAutomationRevision(
        data['canarySuccessBaseline'],
      ),
      revision: normalizeLeagueAutomationRevision(data['revision']),
    };
    const queueFallbackApplicable =
      input.decision.action === 'return-to-shadow' &&
      before.mode !== 'shadow';
    const canonicalFallbackApplicable =
      input.decision.action === 'disable-canonical-authority' &&
      before.canonicalAuthorityLeagueIds.length > 0;

    if (
      before.revision !== input.observedConfig.revision ||
      (!queueFallbackApplicable && !canonicalFallbackApplicable)
    ) {
      return false;
    }

    const modeAfter: LeagueAutomationQueueMode = queueFallbackApplicable
      ? 'shadow'
      : before.mode;
    const canonicalAuthorityLeagueIdsAfter: string[] = [];
    const nextRevision = before.revision + 1;
    const action = queueFallbackApplicable
      ? 'season-watchdog-returned-to-shadow'
      : 'season-watchdog-canonical-fallback';

    transaction.set(
      configRef,
      {
        schemaVersion: 2,
        mode: modeAfter,
        canonicalAuthorityLeagueIds: canonicalAuthorityLeagueIdsAfter,
        revision: nextRevision,
        updatedBy: LEAGUE_AUTOMATION_SEASON_WATCHDOG_ACTOR,
        updatedAt: FieldValue.serverTimestamp(),
        changeReason: input.reason,
        configuredProjectId: projectId,
        configuredEnvironment: environment,
        lastMutationId: auditRef.id,
      },
      { merge: true },
    );

    transaction.set(
      healthRef,
      {
        queueConfiguredMode: modeAfter,
        canonicalAuthorityConfiguredLeagueId: null,
        canonicalAuthorityConfiguredLeagueCount: 0,
        queueConfigRevision: nextRevision,
        queueConfigUpdatedAt: FieldValue.serverTimestamp(),
        seasonWatchdogStatus: input.decision.status,
        seasonWatchdogLastAction: input.decision.action,
        seasonWatchdogLastActionReason: input.reason,
        seasonWatchdogLastActionAt: FieldValue.serverTimestamp(),
        seasonWatchdogQueueBlockingStreak: 0,
        seasonWatchdogCanonicalBlockingStreak: 0,
        seasonWatchdogLastAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    if (queueFallbackApplicable) {
      transaction.set(
        primaryApprovalRef,
        {
          enabled: false,
          disabledReason: 'season-watchdog-returned-to-shadow',
          disabledAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }

    transaction.set(
      watchdogRef,
      {
        schemaVersion: 1,
        status: input.decision.status,
        queueBlockingStreak: 0,
        canonicalBlockingStreak: 0,
        requiredBlockingStreak:
          LEAGUE_AUTOMATION_WATCHDOG_REQUIRED_BLOCKING_STREAK,
        lastTriggeredQueueBlockingStreak:
          input.decision.queueBlockingStreak,
        lastTriggeredCanonicalBlockingStreak:
          input.decision.canonicalBlockingStreak,
        lastQueueBlockingAlertIds:
          input.decision.queueBlockingAlertIds,
        lastCanonicalBlockingAlertIds:
          input.decision.canonicalBlockingAlertIds,
        lastSafetyStatus: input.safety.status,
        lastSafetyAlertIds: input.safety.alerts
          .map((alert) => alert.id)
          .slice(0, 30),
        lastObservedMode: before.mode,
        lastObservedConfigRevision: before.revision,
        lastAction: input.decision.action,
        lastActionReason: input.reason,
        lastActionAt: FieldValue.serverTimestamp(),
        automaticShadowFallbackCount: queueFallbackApplicable
          ? FieldValue.increment(1)
          : FieldValue.increment(0),
        automaticCanonicalFallbackCount: canonicalFallbackApplicable
          ? FieldValue.increment(1)
          : FieldValue.increment(0),
        lastDurationMilliseconds: input.durationMilliseconds,
        consecutiveFailureCount: 0,
        lastError: null,
        lastAttemptAt: FieldValue.serverTimestamp(),
        lastSuccessfulAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    for (const authorityLeagueId of before.canonicalAuthorityLeagueIds) {
      transaction.set(
        getCanonicalScoringAuthorityRef(authorityLeagueId),
        {
          schemaVersion: 1,
          leagueId: authorityLeagueId,
          configured: false,
          circuitState: 'open',
          openedReason: input.reason,
          openedAt: FieldValue.serverTimestamp(),
          lastDecision: 'season-safety-direct-fallback',
          disabledAt: FieldValue.serverTimestamp(),
          disabledBy: LEAGUE_AUTOMATION_SEASON_WATCHDOG_ACTOR,
          consecutiveSuccessfulTaskCount: 0,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }

    if (!auditSnapshot.exists) {
      transaction.set(
        auditRef,
        {
          schemaVersion: 1,
          action,
          requestId: auditRef.id,
          adminId: LEAGUE_AUTOMATION_SEASON_WATCHDOG_ACTOR,
          projectId,
          environment,
          modeBefore: before.mode,
          modeAfter,
          canaryLeagueIdsBefore: before.canaryLeagueIds,
          canaryLeagueIdsAfter: before.canaryLeagueIds,
          internalTestLeagueIdsBefore: before.internalTestLeagueIds,
          internalTestLeagueIdsAfter: before.internalTestLeagueIds,
          canonicalAuthorityLeagueIdsBefore:
            before.canonicalAuthorityLeagueIds,
          canonicalAuthorityLeagueIdsAfter,
          maxEnqueuePerRunBefore: before.maxEnqueuePerRun,
          maxEnqueuePerRunAfter: before.maxEnqueuePerRun,
          canarySuccessBaselineBefore: before.canarySuccessBaseline,
          canarySuccessBaselineAfter: before.canarySuccessBaseline,
          revisionBefore: before.revision,
          revisionAfter: nextRevision,
          reason: input.reason,
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: false },
      );
    }

    return true;
  });
}

export const refreshLeagueAutomationCapacityEvidence = onSchedule(
  {
    schedule: 'every 60 minutes',
    region: FUNCTION_REGION,
    timeoutSeconds: 120,
    memory: '512MiB',
    retryCount: 0,
    maxInstances: 1,
  },
  async () => {
    const startedAt = Date.now();
    const evidenceRef = db.doc('appData/leagueAutomationCapacityEvidence');

    try {
      const healthSnapshot = await db.doc('appData/leagueAutomation').get();
      const activeLeagueTarget = getLeagueAutomationNumber(
        healthSnapshot.data()?.['queueScheduleCoverageCompletedDraftCount'],
      ) ?? 0;
      const evidence = await loadLeagueAutomationCapacityEvidence(
        activeLeagueTarget,
      );

      await evidenceRef.set(
        {
          schemaVersion: 1,
          ...evidence,
          status: 'healthy',
          consecutiveFailureCount: 0,
          lastError: null,
          activeLeagueTarget,
          lastDurationMilliseconds: Date.now() - startedAt,
          lastAttemptAt: FieldValue.serverTimestamp(),
          lastSuccessfulAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    } catch (error: unknown) {
      const message = error instanceof Error
        ? error.message
        : 'Unable to refresh league-automation capacity evidence.';

      await evidenceRef.set(
        {
          schemaVersion: 1,
          status: 'error',
          consecutiveFailureCount: FieldValue.increment(1),
          lastError: message.slice(0, 500),
          lastDurationMilliseconds: Date.now() - startedAt,
          lastAttemptAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      ).catch(() => undefined);

      console.error('Unable to refresh league-automation capacity evidence.', {
        error,
      });
      throw error;
    }
  },
);

async function runLeagueAutomationSeasonSafetyWatchdog(
  startedAt: number,
): Promise<void> {
  const [
    configSnapshot,
    healthSnapshot,
    feedSnapshot,
    watchdogSnapshot,
    capacitySnapshot,
  ] = await Promise.all([
    db.doc('appData/leagueAutomationQueueConfig').get(),
    db.doc('appData/leagueAutomation').get(),
    db.doc('appData/nhlCanonicalImpactFeed').get(),
    db.doc('appData/leagueAutomationSeasonWatchdog').get(),
    db.doc('appData/leagueAutomationCapacityEvidence').get(),
  ]);
  const configData = configSnapshot.data() ?? {};
  const healthData = healthSnapshot.data() ?? {};
  const config: LeagueAutomationQueueConfig = {
    mode: normalizeLeagueAutomationQueueMode(configData['mode']),
    canaryLeagueIds: normalizeLeagueAutomationCanaryIds(
      configData['canaryLeagueIds'],
    ),
    internalTestLeagueIds: normalizeLeagueAutomationInternalTestIds(
      configData['internalTestLeagueIds'],
    ),
    canonicalAuthorityLeagueIds:
      normalizeLeagueAutomationCanonicalAuthorityIds(
        configData['canonicalAuthorityLeagueIds'],
      ),
    maxEnqueuePerRun: normalizeLeagueAutomationMaxEnqueuePerRun(
      configData['maxEnqueuePerRun'],
    ),
    canarySuccessBaseline: normalizeLeagueAutomationRevision(
      configData['canarySuccessBaseline'],
    ),
    revision: normalizeLeagueAutomationRevision(configData['revision']),
  };
  const activeLeagueTarget = Math.max(
    config.canaryLeagueIds.length,
    getLeagueAutomationNumber(
      healthData['queueScheduleCoverageCompletedDraftCount'],
    ) ?? 0,
  );
  const capacityEvidence = normalizeStoredLeagueAutomationCapacityEvidence(
    capacitySnapshot.data(),
    activeLeagueTarget,
  );
  const canonicalParityCohort =
    config.canonicalAuthorityLeagueIds.length > 0
      ? await loadCanonicalScoringParityCohort({
          canaryLeagueIds: config.canaryLeagueIds,
          minimumComparedAtMilliseconds: toMilliseconds(
            configData['updatedAt'],
          ),
        })
      : {
          expectedLeagueCount: 0,
          passingLeagueCount: 0,
          mismatchLeagueCount: 0,
          incompleteLeagueCount: 0,
          missingLeagueCount: 0,
          staleLeagueCount: 0,
          totalComparedCount: 0,
          maximumAbsolutePointDelta: 0,
          passing: true,
        };
  const safety = buildLeagueAutomationSeasonSafetyAlerts({
    config,
    healthData,
    feedData: feedSnapshot.data() ?? {},
    watchdogData: watchdogSnapshot.data() ?? {},
    capacityEvidence,
    canonicalParityCohort,
  });
  const actionableAlertIds = safety.alerts
    .filter((alert) =>
      alert.severity === 'critical' ||
      (config.canonicalAuthorityLeagueIds.length > 0 &&
        alert.id === 'parity-incomplete')
    )
    .map((alert) => alert.id);
  const previousWatchdog = normalizeLeagueAutomationSeasonWatchdog(
    watchdogSnapshot.data(),
  );
  const decision = decideLeagueAutomationWatchdogAction({
    mode: config.mode,
    canonicalAuthorityConfigured:
      config.canonicalAuthorityLeagueIds.length > 0,
    alertIds: actionableAlertIds,
    previousQueueBlockingStreak:
      previousWatchdog.queueBlockingStreak,
    previousCanonicalBlockingStreak:
      previousWatchdog.canonicalBlockingStreak,
  });
  const durationMilliseconds = Date.now() - startedAt;

  if (decision.action === 'none') {
    await recordLeagueAutomationWatchdogObservation({
      decision,
      config,
      safety,
      durationMilliseconds,
    });
    return;
  }

  const reason = getLeagueAutomationWatchdogActionReason({
    action: decision.action,
    alerts: safety.alerts,
    queueBlockingAlertIds: decision.queueBlockingAlertIds,
    canonicalBlockingAlertIds: decision.canonicalBlockingAlertIds,
  });
  const applied = await applyLeagueAutomationWatchdogFallback({
    observedConfig: config,
    decision,
    safety,
    reason,
    durationMilliseconds,
  });

  if (!applied) {
    await recordLeagueAutomationWatchdogObservation({
      decision: {
        ...decision,
        action: 'none',
        status: 'warning',
      },
      config,
      safety,
      durationMilliseconds: Date.now() - startedAt,
    });
    return;
  }

  console.error('Season safety watchdog selected a safer scoring path.', {
    action: decision.action,
    modeBefore: config.mode,
    canonicalAuthorityLeagueIds:
      config.canonicalAuthorityLeagueIds,
    reason,
  });
}

export const monitorLeagueAutomationSeasonSafety = onSchedule(
  {
    schedule: '* * * * *',
    region: FUNCTION_REGION,
    timeoutSeconds: 60,
    memory: '512MiB',
    retryCount: 0,
    maxInstances: 1,
  },
  async () => {
    const startedAt = Date.now();
    const watchdogRef = db.doc('appData/leagueAutomationSeasonWatchdog');
    const healthRef = db.doc('appData/leagueAutomation');

    try {
      await runLeagueAutomationSeasonSafetyWatchdog(startedAt);
    } catch (error: unknown) {
      const message = error instanceof Error
        ? error.message
        : 'Unable to complete the league-automation season-safety check.';
      const failureEvidence = {
        seasonWatchdogStatus: 'error',
        seasonWatchdogLastError: message.slice(0, 500),
        seasonWatchdogLastAttemptAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };

      await Promise.all([
        watchdogRef.set(
          {
            schemaVersion: 1,
            status: 'error',
            consecutiveFailureCount: FieldValue.increment(1),
            lastError: message.slice(0, 500),
            lastDurationMilliseconds: Date.now() - startedAt,
            lastAttemptAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        ).catch(() => undefined),
        healthRef.set(failureEvidence, { merge: true }).catch(() => undefined),
      ]);

      console.error('League-automation season-safety watchdog failed.', {
        error,
      });
      throw error;
    }
  },
);


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
    const focusLeagueId = optionalFirestoreDocumentId(
      data['focusLeagueId'],
      'focus league ID',
      {
        minimumLength: 6,
        maxBytes: 128,
        pattern: /^[A-Za-z0-9_-]+$/,
      },
    ) ?? '';

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
    requireVerifiedRecentAuthentication(
      request.auth,
      'change the live scoring queue rollout',
    );
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
    const canaryLeagueIds = [...new Set(requireFirestoreDocumentIds(
      data['canaryLeagueIds'],
      'canary league ID',
      {
        maximumCount: 100,
        minimumLength: 6,
        maxBytes: 128,
        pattern: /^[A-Za-z0-9_-]+$/,
      },
    ))].sort();
    const internalTestLeagueIds = [...new Set(requireFirestoreDocumentIds(
      data['internalTestLeagueIds'],
      'internal test league ID',
      {
        maximumCount: 100,
        minimumLength: 6,
        maxBytes: 128,
        pattern: /^[A-Za-z0-9_-]+$/,
      },
    ))].sort();
    const canonicalAuthorityLeagueIds = [...new Set(
      requireFirestoreDocumentIds(
        data['canonicalAuthorityLeagueIds'] ?? [],
        'canonical authority league ID',
        {
          maximumCount:
            LEAGUE_AUTOMATION_CANONICAL_AUTHORITY_MAX_LEAGUE_COUNT,
          minimumLength: 6,
          maxBytes: 128,
          pattern: /^[A-Za-z0-9_-]+$/,
        },
      ),
    )].sort();
    const maxEnqueuePerRun = normalizeLeagueAutomationMaxEnqueuePerRun(
      data['maxEnqueuePerRun'],
    );
    const expectedRevision = normalizeLeagueAutomationRevision(
      data['expectedRevision'],
    );
    const confirmationText = getLeagueAutomationString(data['confirmationText']);
    const changeReason = normalizeLeagueAutomationChangeReason(data['changeReason']);
    const currentConfig = await getLeagueAutomationQueueConfig();
    const enablingCanonicalAuthority = canonicalAuthorityLeagueIds.some(
      (leagueId) =>
        !currentConfig.canonicalAuthorityLeagueIds.includes(leagueId),
    );

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

      if (canaryLeagueIds.length > NEAR_LIVE_CANARY_MAX_LEAGUE_COUNT) {
        throw new HttpsError(
          'failed-precondition',
          `Near-live Canary is limited to ${NEAR_LIVE_CANARY_MAX_LEAGUE_COUNT} Internal Test leagues until measured game-night evidence supports expansion.`,
        );
      }

      const canaryConfirmation = enablingCanonicalAuthority
        ? LEAGUE_AUTOMATION_CANONICAL_AUTHORITY_CONFIRMATION
        : LEAGUE_AUTOMATION_CANARY_CONFIRMATION;

      if (confirmationText !== canaryConfirmation) {
        throw new HttpsError(
          'failed-precondition',
          `Type “${canaryConfirmation}” exactly before saving this canary configuration.`,
        );
      }
    }

    const canaryLeagueIdsMissingInternalTest = canaryLeagueIds.filter(
      (leagueId) => !internalTestLeagueIds.includes(leagueId),
    );

    if (mode === 'canary' && canaryLeagueIdsMissingInternalTest.length > 0) {
      throw new HttpsError(
        'failed-precondition',
        'Every queued scoring canary must also be marked Internal Test before it can receive the guarded near-live cadence.',
      );
    }

    if (mode !== 'canary' && canonicalAuthorityLeagueIds.length > 0) {
      throw new HttpsError(
        'failed-precondition',
        'Canonical scoring authority is limited to one exact Internal Test league while queue mode is Canary.',
      );
    }

    const canonicalAuthorityLeagueIdsOutsideCohort =
      canonicalAuthorityLeagueIds.filter(
        (leagueId) =>
          !canaryLeagueIds.includes(leagueId) ||
          !internalTestLeagueIds.includes(leagueId),
      );

    if (canonicalAuthorityLeagueIdsOutsideCohort.length > 0) {
      throw new HttpsError(
        'failed-precondition',
        'The canonical-read league must already be included in both Canary and Internal Test.',
      );
    }

    if (mode !== 'shadow') {
      await Promise.all([
        validateLeagueAutomationAdminLeagueIds(canaryLeagueIds, true),
        validateLeagueAutomationAdminLeagueIds(internalTestLeagueIds, false),
      ]);
    }

    if (enablingCanonicalAuthority) {
      const authorityLeagueId = canonicalAuthorityLeagueIds[0];
      const canarySelectionUnchanged =
        JSON.stringify(currentConfig.canaryLeagueIds) ===
        JSON.stringify(canaryLeagueIds) &&
        JSON.stringify(currentConfig.internalTestLeagueIds) ===
        JSON.stringify(internalTestLeagueIds);

      if (
        currentConfig.mode !== 'canary' ||
        !canarySelectionUnchanged ||
        !currentConfig.canaryLeagueIds.includes(authorityLeagueId) ||
        !currentConfig.internalTestLeagueIds.includes(authorityLeagueId)
      ) {
        throw new HttpsError(
          'failed-precondition',
          'First save and prove the exact Canary cohort. Canonical reads cannot be enabled in the same change that creates or changes that cohort.',
        );
      }

      const [
        currentConfigSnapshot,
        paritySnapshot,
        authoritySnapshot,
        healthSnapshot,
      ] = await Promise.all([
        db.doc('appData/leagueAutomationQueueConfig').get(),
        db.doc(`leagueAutomationCanonicalParity/${authorityLeagueId}`).get(),
        getCanonicalScoringAuthorityRef(authorityLeagueId).get(),
        db.doc('appData/leagueAutomation').get(),
      ]);
      const eligibility = getCanonicalScoringAuthorityEligibility({
        config: currentConfig,
        leagueId: authorityLeagueId,
        configUpdatedAtMilliseconds: toMilliseconds(
          currentConfigSnapshot.data()?.['updatedAt'],
        ),
        parityData: paritySnapshot.data(),
        authorityData: authoritySnapshot.data(),
        healthData: healthSnapshot.data(),
      });

      if (!eligibility.eligible) {
        throw new HttpsError(
          'failed-precondition',
          `Canonical reads remain locked: ${eligibility.reason}`,
        );
      }
    }
    if (mode === 'primary') {
      await assertLeagueAutomationPrimaryPromotionAllowed(
        currentConfig,
        confirmationText,
      );
    }

    const configRef = db.doc('appData/leagueAutomationQueueConfig');
    const healthRef = db.doc('appData/leagueAutomation');
    const watchdogRef = db.doc('appData/leagueAutomationSeasonWatchdog');
    const capacityRef = db.doc('appData/leagueAutomationCapacityEvidence');
    const approvalRef = db.doc('appData/leagueAutomationPrimaryApproval');
    const auditRef = getLeagueAutomationAuditRef(requestId);
    const projectId = getLeagueAutomationProjectId();
    const environment = getLeagueAutomationEnvironment(projectId);
    const transactionResult = await db.runTransaction(async (transaction) => {
      const [
        configSnapshot,
        auditSnapshot,
        healthSnapshot,
        watchdogSnapshot,
        capacitySnapshot,
        approvalSnapshot,
      ] = await Promise.all([
        transaction.get(configRef),
        transaction.get(auditRef),
        transaction.get(healthRef),
        transaction.get(watchdogRef),
        transaction.get(capacityRef),
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
        canonicalAuthorityLeagueIds:
          normalizeLeagueAutomationCanonicalAuthorityIds(
            configData['canonicalAuthorityLeagueIds'],
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
        const transactionParitySnapshots = await Promise.all(
          before.canaryLeagueIds.map((leagueId) =>
            transaction.get(
              db.doc(`leagueAutomationCanonicalParity/${leagueId}`),
            )
          ),
        );
        const transactionCanonicalParityCohort =
          summarizeCanonicalScoringParityCohort({
            leagueIds: before.canaryLeagueIds,
            minimumComparedAtMilliseconds: toMilliseconds(
              configData['updatedAt'],
            ),
            snapshots: transactionParitySnapshots,
          });
        const transactionActiveLeagueTarget = Math.max(
          before.canaryLeagueIds.length,
          getLeagueAutomationNumber(
            healthSnapshot.data()?.['queueScheduleCoverageCompletedDraftCount'],
          ) ?? 0,
        );
        const transactionCapacityEvidence =
          normalizeStoredLeagueAutomationCapacityEvidence(
            capacitySnapshot.data(),
            transactionActiveLeagueTarget,
          );
        const transactionGates = buildLeagueAutomationPromotionGates({
          config: before,
          health: healthSnapshot.data(),
          watchdog: watchdogSnapshot.data(),
          capacityEvidence: transactionCapacityEvidence,
          canonicalParityCohort: transactionCanonicalParityCohort,
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
      const canonicalAuthoritySelectionChanged =
        JSON.stringify(before.canonicalAuthorityLeagueIds) !==
        JSON.stringify(canonicalAuthorityLeagueIds);
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
        !canonicalAuthoritySelectionChanged &&
        JSON.stringify(before.internalTestLeagueIds) ===
          JSON.stringify(internalTestLeagueIds);

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
            canonicalAuthorityLeagueIdsBefore:
              before.canonicalAuthorityLeagueIds,
            canonicalAuthorityLeagueIdsAfter:
              before.canonicalAuthorityLeagueIds,
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
        : canonicalAuthoritySelectionChanged
          ? canonicalAuthorityLeagueIds.length > 0
            ? 'canonical-authority-canary-enabled'
            : 'canonical-authority-canary-disabled'
          : 'queue-selection-updated';

      transaction.set(
        configRef,
        {
          schemaVersion: 2,
          mode,
          canaryLeagueIds,
          internalTestLeagueIds,
          canonicalAuthorityLeagueIds,
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
          canonicalAuthorityConfiguredLeagueId:
            canonicalAuthorityLeagueIds[0] ?? null,
          canonicalAuthorityConfiguredLeagueCount:
            canonicalAuthorityLeagueIds.length,
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
          canonicalAuthorityLeagueIdsBefore:
            before.canonicalAuthorityLeagueIds,
          canonicalAuthorityLeagueIdsAfter: canonicalAuthorityLeagueIds,
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

      if (canonicalAuthoritySelectionChanged) {
        const authorityLeagueIds = [...new Set([
          ...before.canonicalAuthorityLeagueIds,
          ...canonicalAuthorityLeagueIds,
        ])];

        for (const authorityLeagueId of authorityLeagueIds) {
          transaction.set(
            getCanonicalScoringAuthorityRef(authorityLeagueId),
            canonicalAuthorityLeagueIds.includes(authorityLeagueId)
              ? {
                  schemaVersion: 1,
                  leagueId: authorityLeagueId,
                  configured: true,
                  circuitState: 'closed',
                  openedReason: '',
                  activatedAt: FieldValue.serverTimestamp(),
                  activatedBy: adminId,
                  activationConfigRevision: nextRevision,
                  consecutiveSuccessfulTaskCount: 0,
                  lastDecision: 'awaiting-versioned-task',
                  updatedAt: FieldValue.serverTimestamp(),
                }
              : {
                  schemaVersion: 1,
                  leagueId: authorityLeagueId,
                  configured: false,
                  lastDecision: 'disabled-by-admin',
                  disabledAt: FieldValue.serverTimestamp(),
                  disabledBy: adminId,
                  updatedAt: FieldValue.serverTimestamp(),
                },
            { merge: true },
          );
        }
      }

      return {
        updated: true,
        revision: nextRevision,
        mode,
        message: mode === 'shadow'
          ? 'The queued scorer returned to observation mode. The legacy scorer remains primary.'
          : mode === 'canary'
            ? canonicalAuthorityLeagueIds.length > 0
              ? `${canaryLeagueIds.length} exact league(s) use queued scoring; ${canonicalAuthorityLeagueIds[0]} is the single verified canonical-read Canary with automatic direct fallback.`
              : `${canaryLeagueIds.length} exact league(s) are now routed through queued scoring.`
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
    requireVerifiedRecentAuthentication(
      request.auth,
      'run a live scoring canary check',
    );
    const data = request.data && typeof request.data === 'object'
      ? request.data as Record<string, unknown>
      : {};
    const requestId = normalizeLeagueAutomationAdminRequestId(data['requestId']);
    const leagueId = requireFirestoreDocumentId(data['leagueId'], 'canary league ID', {
      minimumLength: 6,
      maxBytes: 128,
      pattern: /^[A-Za-z0-9_-]+$/,
    });
    const confirmationText = getLeagueAutomationString(data['confirmationText']);

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

    if (!config.internalTestLeagueIds.includes(leagueId)) {
      throw new HttpsError(
        'failed-precondition',
        'This league must also be marked Internal Test before it can run the guarded near-live Canary.',
      );
    }

    if (config.canaryLeagueIds.length > NEAR_LIVE_CANARY_MAX_LEAGUE_COUNT) {
      throw new HttpsError(
        'failed-precondition',
        `Reduce the near-live Canary cohort to ${NEAR_LIVE_CANARY_MAX_LEAGUE_COUNT} Internal Test leagues before running a check.`,
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
          canonicalAuthorityLeagueIdsBefore:
            config.canonicalAuthorityLeagueIds,
          canonicalAuthorityLeagueIdsAfter:
            config.canonicalAuthorityLeagueIds,
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
      // Manual Canary refreshes are not tied to a canonical NHL source version.
      // Neutral values keep the normalized schedule contract complete. If a newer
      // canonical request is already pending, task completion will leave it pending
      // and immediately require a versioned follow-up task.
      canonicalSourceVersion: '',
      canonicalRequestedAtMilliseconds: 0,
      canonicalGameIds: [],
      canonicalGameVersions: [],
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
        queueNearLiveCanaryRefreshIntervalMilliseconds:
          NEAR_LIVE_CANARY_REFRESH_INTERVAL_MILLISECONDS,
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

    const leagueId = resolveSafeFirestoreDocumentId(
      payload?.leagueId,
      FIRESTORE_LEAGUE_ID_OPTIONS,
    );
    const payloadCanonicalSourceVersion = normalizeCanonicalSourceVersion(
      payload?.canonicalSourceVersion,
    );
    const payloadHasCanonicalSourceVersion =
      typeof payload?.canonicalSourceVersion !== 'undefined';
    const payloadCanonicalGameIds = normalizeCanonicalParityGameIds(
      payload?.canonicalGameIds,
    );
    const payloadCanonicalGameVersions = normalizeCanonicalGameVersions(
      payload?.canonicalGameVersions,
    );
    const payloadCanonicalGameVersionIds = payloadCanonicalGameVersions
      .map((entry) => entry.gameId);
    const payloadCanonicalAggregateVersion = leagueId
      ? buildCanonicalLeagueAggregateSourceVersion({
          leagueId,
          gameVersions: payloadCanonicalGameVersions,
        })
      : '';
    const canonicalPayloadComplete = !payloadHasCanonicalSourceVersion || (
      payloadCanonicalGameIds.length > 0 &&
      payloadCanonicalGameIds.length === payloadCanonicalGameVersionIds.length &&
      payloadCanonicalGameIds.every(
        (gameId, index) => gameId === payloadCanonicalGameVersionIds[index],
      ) &&
      payloadCanonicalAggregateVersion === payloadCanonicalSourceVersion
    );

    if (
      !payload ||
      payload.taskSchemaVersion !== LEAGUE_AUTOMATION_QUEUE_SCHEMA_VERSION ||
      !leagueId ||
      !Number.isFinite(payload.expectedDueAtMilliseconds) ||
      typeof payload.dueBucket !== 'string' ||
      !payload.dueBucket ||
      (payloadHasCanonicalSourceVersion && !payloadCanonicalSourceVersion) ||
      !canonicalPayloadComplete ||
      (typeof payload.canonicalRequestedAtMilliseconds !== 'undefined' &&
        !Number.isFinite(payload.canonicalRequestedAtMilliseconds)) ||
      (payload.reason !== 'scheduled' &&
        payload.reason !== 'recovery' &&
        payload.reason !== 'canary-manual')
    ) {
      console.warn('Ignored malformed league automation task.', { payload });
      return;
    }

    const taskId = buildLeagueAutomationTaskId(payload);
    const scheduleRef = getLeagueAutomationScheduleRef(leagueId);
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
    const activeTaskCanonicalSourceVersion = normalizeCanonicalSourceVersion(
      scheduleData['activeTaskCanonicalSourceVersion'],
    );

    if (
      scheduleData['scoringEnabled'] === false ||
      activeTaskId !== taskId ||
      expectedDueAt !== Math.trunc(payload.expectedDueAtMilliseconds) ||
      (payloadCanonicalSourceVersion &&
        activeTaskCanonicalSourceVersion !== payloadCanonicalSourceVersion)
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
      const queueConfig = await getLeagueAutomationQueueConfig();
      const refreshCadence = getConfiguredLeagueAutomationRefreshCadence(
        queueConfig,
        leagueId,
      );
      const canonicalParityContext = payloadCanonicalSourceVersion
        ? {
            sourceVersion: payloadCanonicalSourceVersion,
            requestedAtMilliseconds:
              payload.canonicalRequestedAtMilliseconds ?? 0,
            gameIds: payloadCanonicalGameIds,
          } satisfies CanonicalScoringParityTaskContext
        : undefined;
      const canonicalAuthorityContext =
        await loadCanonicalScoringAuthorityRuntimeContext({
          config: queueConfig,
          leagueId,
          canonicalContext: canonicalParityContext,
        });
      const result = await runLeagueAutomation(
        leagueId,
        payload.reason === 'canary-manual' ||
          Boolean(payloadCanonicalSourceVersion),
        'queue-task',
        refreshCadence,
        canonicalParityContext,
        canonicalAuthorityContext,
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
          queueLastTaskRefreshCadence: result.refreshCadence ?? 'standard',
          queueLastTaskRefreshDelayMilliseconds:
            result.refreshDelayMilliseconds ?? null,
          queueLastTaskCanonicalSourceVersion:
            payloadCanonicalSourceVersion || null,
          canonicalAuthorityLastRuntimeEnabled:
            canonicalAuthorityContext.enabled,
          canonicalAuthorityLastRuntimeReason:
            canonicalAuthorityContext.reason,
          canonicalAuthorityLastCanonicalUseCount:
            result.canonicalAuthorityUsedCount ?? 0,
          canonicalAuthorityLastDirectFallbackCount:
            result.canonicalAuthorityFallbackCount ?? 0,
          canonicalAuthorityLastCircuitOpened:
            result.canonicalAuthorityCircuitOpened === true,
          queueNearLiveCanaryRefreshIntervalMilliseconds:
            NEAR_LIVE_CANARY_REFRESH_INTERVAL_MILLISECONDS,
          queueNearLiveCanaryMaxLeagueCount:
            NEAR_LIVE_CANARY_MAX_LEAGUE_COUNT,
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

    const leagueId = resolveSafeFirestoreDocumentId(
      event.params.leagueId,
      FIRESTORE_LEAGUE_ID_OPTIONS,
    );

    if (!leagueId) {
      console.warn('Ignored malformed season initialization trigger.');
      return;
    }

    await runLeagueAutomation(
      leagueId,
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
  phaseTiming?: ScoringPhaseTimingSnapshot;
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
  const leagueId = data && typeof data === 'object'
    ? (data as Record<string, unknown>)['leagueId']
    : null;

  return requireFirestoreDocumentId(leagueId, 'league ID', {
    minimumLength: 6,
    maxBytes: 128,
    pattern: /^[A-Za-z0-9_-]+$/,
  });
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
      const config = await getLeagueAutomationQueueConfig();
      const result = await runLeagueAutomation(
        leagueId,
        true,
        'manual',
        getConfiguredLeagueAutomationRefreshCadence(config, leagueId),
      );

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
        phaseTiming: result.phaseTiming,
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

    if (releasedGameCount > 0) {
      try {
        await queueServerProjectionSnapshotRefresh({
          leagueId,
          requestedBy: userId,
          requestKey: requestId,
        });
      } catch (projectionError: unknown) {
        console.warn('Historical replay completed, but the non-blocking player-stat refresh was not queued.', {
          leagueId,
          requestId,
          simulatedDate: nextDate,
          message: projectionError instanceof Error
            ? projectionError.message
            : 'Unknown projection refresh error.',
        });
      }
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
        lastScoringDurationMilliseconds: result.durationMilliseconds,
        lastScoringPhaseTiming: scoringPhaseTimingForFirestore(
          result.phaseTiming,
        ),
        lastScoringLongestPhase: result.phaseTiming?.longestPhase ?? '',
        lastScoringLongestPhaseDurationMilliseconds:
          result.phaseTiming?.longestPhaseDurationMilliseconds ?? 0,
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
      scoringDurationMilliseconds: result.durationMilliseconds,
      scoringPhaseTiming: result.phaseTiming,
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
    requireVerifiedRecentAuthentication(
      request.auth,
      'advance a historical replay league',
    );
    const leagueId = requireFirestoreDocumentId(
      request.data && typeof request.data === 'object'
        ? (request.data as Record<string, unknown>)['leagueId']
        : null,
      'league ID',
      {
        minimumLength: 6,
        maxBytes: 128,
        pattern: /^[A-Za-z0-9_-]+$/,
      },
    );
    await enforceAppCheckCallableCanaryForLeague(
      request,
      'advanceHistoricalReplayDay',
      leagueId,
    );
    const requestId = normalizeHistoricalReplayRequestId(
      request.data && typeof request.data === 'object'
        ? (request.data as Record<string, unknown>)['requestId']
        : null,
    );

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
        const safeActiveRequestId = resolveSafeFirestoreDocumentId(
          activeRequestId,
          FIRESTORE_REQUEST_ID_OPTIONS,
        );

        if (!safeActiveRequestId) {
          throw new HttpsError(
            'failed-precondition',
            'The saved replay request identity is invalid. Retry from Release Readiness.',
          );
        }

        const activeRequestRef = getHistoricalReplayRequestRef(safeActiveRequestId);
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

    const requestId = resolveSafeFirestoreDocumentId(
      payload?.requestId,
      FIRESTORE_REQUEST_ID_OPTIONS,
    );
    const leagueId = resolveSafeFirestoreDocumentId(
      payload?.leagueId,
      FIRESTORE_LEAGUE_ID_OPTIONS,
    );
    const requestedBy = resolveSafeFirestoreDocumentId(
      payload?.requestedBy,
      FIRESTORE_AUTH_USER_ID_OPTIONS,
    );

    if (!payload || !requestId || !leagueId || !requestedBy) {
      console.warn('Ignored malformed historical replay task.', { payload });
      return;
    }

    const requestRef = getHistoricalReplayRequestRef(requestId);
    const controlRef = getHistoricalReplayControlRef(leagueId);
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
        requestData['leagueId'] !== leagueId ||
        requestData['requestedBy'] !== requestedBy
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

      if (activeRequestId && activeRequestId !== requestId) {
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
          activeRequestId: requestId,
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
        leagueId,
        requestedBy,
        requestId,
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
          scoringDurationMilliseconds:
            result.scoringDurationMilliseconds,
          scoringPhaseTiming: scoringPhaseTimingForFirestore(
            result.scoringPhaseTiming,
          ),
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
        requestId: requestId,
        leagueId: leagueId,
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
