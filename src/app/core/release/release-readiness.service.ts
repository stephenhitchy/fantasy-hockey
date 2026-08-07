import { FIREBASE_APP_CHECK_CONFIG } from '../../../environments/app-check.config';
import { doc, getDoc, Timestamp } from 'firebase/firestore';

import { getScoringRuntimeState } from '../cycle/cycle-runtime.config';
import { db } from '../firebase';
import { getActiveLeagueCycles, getLatestCycle } from '../cycle/cycle.service';
import { getFantasyDraft } from '../draft/draft.service';
import { getLeagueById } from '../league/league.service';
import {
  clearExpiredOrErroredLiveScoringLease,
  getSharedLiveScoringControlOnce,
  requestLeagueLiveScoringRefresh,
} from '../live-scoring/live-scoring.service';
import {
  getPlayerAvailabilitySyncState,
  syncPlayerAvailabilityFromEspn,
} from '../player/player-availability-sync.service';
import { getFantasyPlayoffs } from '../playoffs/playoff.service';
import {
  generateSharedProjectionSnapshot,
  loadSharedProjectionSnapshotMetadata,
  manageProjectionSnapshotIntegrity,
  PROJECTION_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
  PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION,
  SHARED_PROJECTION_VERSION,
} from '../projection/projection-snapshot.service';
import { CURRENT_SCORING_RULES_VERSION, defaultScoringRules } from '../scoring/scoring-rules';
import { getLeagueTeams } from '../team/team.service';
import {
  ReleaseReadinessCheck,
  ReleaseReadinessLevel,
  ReleaseReadinessSnapshot,
  ReleaseVersionSummary,
} from './release-readiness.models';

const CURRENT_LEAGUE_AUTHORITY_SCHEMA_VERSION = 2;
const CURRENT_LEAGUE_DOCUMENT_SCHEMA_VERSION = 1;

export const RELEASE_VERSION_SUMMARY: ReleaseVersionSummary = {
  releaseLabel: getScoringRuntimeState().releaseLabel,
  scoringRulesVersion: CURRENT_SCORING_RULES_VERSION,
  leagueAuthoritySchemaVersion: CURRENT_LEAGUE_AUTHORITY_SCHEMA_VERSION,
  projectionVersion: SHARED_PROJECTION_VERSION,
  liveScoringSchemaVersion: 1,
  playoffFormatVersion: 2,
  cycleWindowSchemaVersion: 2,
  matchupCompletionSchemaVersion: 1,
  appCheckClientEnabled:
    FIREBASE_APP_CHECK_CONFIG.enabled &&
    FIREBASE_APP_CHECK_CONFIG.recaptchaEnterpriseSiteKey.trim().length > 0,
};

function toIso(value: unknown): string | null {
  if (value instanceof Timestamp) {
    return value.toDate().toISOString();
  }

  if (
    value &&
    typeof value === 'object' &&
    'toDate' in value &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  ) {
    const date = (value as { toDate: () => Date }).toDate();
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }

  return null;
}

function createCheck(
  id: string,
  category: ReleaseReadinessCheck['category'],
  label: string,
  detail: string,
  level: ReleaseReadinessLevel,
  requiredForLiveLaunch: boolean,
): ReleaseReadinessCheck {
  return {
    id,
    category,
    label,
    detail,
    level,
    requiredForLiveLaunch,
  };
}


async function loadAutomationDocument(documentId: string): Promise<Record<string, unknown> | null> {
  try {
    const snapshot = await getDoc(doc(db, 'appData', documentId));
    return snapshot.exists() ? snapshot.data() : null;
  } catch {
    return null;
  }
}

function timestampAgeMinutes(value: unknown, now = Date.now()): number | null {
  const iso = toIso(value);

  if (!iso) {
    return null;
  }

  const milliseconds = Date.parse(iso);
  return Number.isFinite(milliseconds)
    ? Math.max(0, (now - milliseconds) / 60_000)
    : null;
}

function formatAgeMinutes(ageMinutes: number | null): string {
  if (ageMinutes === null) {
    return 'not recorded';
  }

  if (ageMinutes < 2) {
    return 'less than 2 minutes ago';
  }

  if (ageMinutes < 120) {
    return `${Math.round(ageMinutes)} minutes ago`;
  }

  return `${Math.round(ageMinutes / 60)} hours ago`;
}

function formatDurationMilliseconds(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 'not recorded';
  }

  if (value < 1_000) {
    return `${Math.round(value)} ms`;
  }

  if (value < 60_000) {
    return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} seconds`;
  }

  return `${(value / 60_000).toFixed(1)} minutes`;
}

export async function loadReleaseReadinessSnapshot(
  leagueId: string,
): Promise<ReleaseReadinessSnapshot> {
  const runtime = getScoringRuntimeState();
  const [
    league,
    teams,
    draft,
    latestCycle,
    activeCycles,
    projection,
    injurySync,
    liveScoring,
    playoffs,
    draftAutomation,
    leagueAutomation,
    injuryAutomation,
    injuryEmailAutomation,
    seasonAutomation,
  ] = await Promise.all([
    getLeagueById(leagueId),
    getLeagueTeams(leagueId),
    getFantasyDraft(leagueId),
    getLatestCycle(leagueId),
    getActiveLeagueCycles(leagueId),
    loadSharedProjectionSnapshotMetadata(leagueId),
    getPlayerAvailabilitySyncState(leagueId),
    getSharedLiveScoringControlOnce(leagueId),
    getFantasyPlayoffs(leagueId),
    loadAutomationDocument('draftAutomation'),
    loadAutomationDocument('leagueAutomation'),
    loadAutomationDocument('injuryAutomation'),
    loadAutomationDocument('injuryEmailAutomation'),
    loadAutomationDocument('seasonAutomation'),
  ]);

  if (!league) {
    throw new Error('League not found for release-readiness checks.');
  }

  const checks: ReleaseReadinessCheck[] = [];
  const requiredGamesPerCycle =
    league.scoringRules?.requiredGamesPerCycle ?? defaultScoringRules.requiredGamesPerCycle;

  checks.push(
    createCheck(
      'scoring-mode',
      'configuration',
      runtime.effectiveMode === 'live'
        ? 'Live NHL scoring mode is active'
        : 'Historical scoring test mode is active',
      runtime.effectiveMode === 'live'
        ? 'This build uses the current NHL season.'
        : `Testing remains pinned to ${runtime.historicalDateIso ?? 'an invalid historical date'}. Production builds automatically replace this with live mode.`,
      runtime.effectiveMode === 'live' ? 'pass' : 'warning',
      true,
    ),
  );

  checks.push(
    createCheck(
      'production-history-guard',
      'configuration',
      'Production historical-mode guard',
      runtime.historicalModeBlocked
        ? 'A production-like host rejected a historical configuration and forced live scoring.'
        : runtime.productionHost
          ? 'Production-like host is using the safe effective scoring mode.'
          : 'Local development host detected; historical testing is permitted.',
      'pass',
      true,
    ),
  );

  checks.push(
    createCheck(
      'developer-tools',
      'configuration',
      runtime.developerToolsEnabled
        ? 'Developer simulators are visible locally'
        : 'Developer simulators are hidden',
      runtime.developerToolsEnabled
        ? 'Temporary test routes remain available in this local development build. Production builds hide them.'
        : 'Production-facing pages do not display temporary simulator controls.',
      runtime.developerToolsEnabled ? 'warning' : 'pass',
      false,
    ),
  );

  const appCheckClientReady =
    FIREBASE_APP_CHECK_CONFIG.enabled &&
    FIREBASE_APP_CHECK_CONFIG.recaptchaEnterpriseSiteKey.trim().length > 0;
  checks.push(
    createCheck(
      'app-check-client',
      'configuration',
      appCheckClientReady
        ? 'Firebase App Check client tokens are enabled'
        : 'Firebase App Check monitor client is not configured',
      appCheckClientReady
        ? 'The production browser can send reCAPTCHA Enterprise App Check tokens. Review verified request metrics before enabling enforcement in Firebase Console.'
        : 'Register the production web app in Firebase App Check, add the public reCAPTCHA Enterprise site key, deploy the client, and monitor legitimate traffic before enforcement.',
      appCheckClientReady ? 'pass' : 'warning',
      true,
    ),
  );

  checks.push(
    createCheck(
      'six-game-format',
      'league',
      'Six-game scoring format',
      `League setting: ${requiredGamesPerCycle} scheduled NHL games per roster-slot window.`,
      requiredGamesPerCycle === 6 ? 'pass' : 'fail',
      true,
    ),
  );

  checks.push(
    createCheck(
      'scoring-rules-version',
      'league',
      'Current scoring-rules version',
      `League version ${league.scoringRulesVersion ?? 'legacy'}; application version ${CURRENT_SCORING_RULES_VERSION}.`,
      league.scoringRulesVersion === CURRENT_SCORING_RULES_VERSION ? 'pass' : 'warning',
      true,
    ),
  );

  const leagueAuthorityReady =
    league.authoritySchemaVersion === CURRENT_LEAGUE_AUTHORITY_SCHEMA_VERSION &&
    league.documentSchemaVersion === CURRENT_LEAGUE_DOCUMENT_SCHEMA_VERSION &&
    league.competitionSettingsLocked === true;
  checks.push(
    createCheck(
      'league-authority-schema',
      'league',
      leagueAuthorityReady
        ? 'League authority schema is current'
        : 'League authority migration is required',
      leagueAuthorityReady
        ? `Authority v${league.authoritySchemaVersion}; document schema v${league.documentSchemaVersion}; competitive settings are server locked.`
        : `Authority v${league.authoritySchemaVersion ?? 'legacy'}; document schema v${league.documentSchemaVersion ?? 'legacy'}. Use the guarded migration control before broader beta use.`,
      leagueAuthorityReady ? 'pass' : 'warning',
      true,
    ),
  );

  checks.push(
    createCheck(
      'team-count',
      'league',
      'League membership is filled',
      `${teams.length} of ${league.maxTeams} team slots currently exist.`,
      teams.length === league.maxTeams ? 'pass' : 'warning',
      true,
    ),
  );

  checks.push(
    createCheck(
      'draft-complete',
      'league',
      'Draft completed',
      `Draft status: ${draft?.status ?? 'not created'}.`,
      draft?.status === 'complete' ? 'pass' : 'warning',
      true,
    ),
  );


  const draftAutomationAge = timestampAgeMinutes(draftAutomation?.['lastRunAt']);
  const draftAutomationFailedCount =
    typeof draftAutomation?.['failedDraftCount'] === 'number'
      ? draftAutomation['failedDraftCount']
      : 0;
  checks.push(
    createCheck(
      'server-draft-automation',
      'league',
      'Server-controlled draft automation',
      !draftAutomation
        ? 'The scheduled draft worker has not recorded a run yet.'
        : `${String(draftAutomation['status'] ?? 'unknown')}; last run ${formatAgeMinutes(draftAutomationAge)}; ${draftAutomationFailedCount} failed draft(s).`,
      !draftAutomation
        ? 'warning'
        : draftAutomationFailedCount > 0 || draftAutomation['status'] === 'partial-error'
          ? 'fail'
          : draftAutomationAge !== null && draftAutomationAge <= 5
            ? 'pass'
            : 'warning',
      true,
    ),
  );

  const cycleOneExists = (latestCycle?.cycleNumber ?? 0) >= 1;
  const cycleStartMode = typeof seasonAutomation?.['mode'] === 'string'
    ? seasonAutomation['mode']
    : '';
  const cycleStartAge = timestampAgeMinutes(seasonAutomation?.['lastRunAt']);
  const cycleStartFailures =
    typeof seasonAutomation?.['failedLeagueCount'] === 'number'
      ? seasonAutomation['failedLeagueCount']
      : 0;
  checks.push(
    createCheck(
      'automatic-cycle-one',
      'league',
      'Automatic Cycle 1 after the draft',
      cycleOneExists
        ? 'Cycle 1 exists and no commissioner start action is required.'
        : draft?.status === 'complete'
          ? `The draft is complete and Cycle 1 is still being prepared. Recovery worker last ran ${formatAgeMinutes(cycleStartAge)}.`
          : cycleStartMode === 'immediate-after-draft'
            ? 'The server is ready to create Cycle 1 immediately when the draft completes.'
            : 'The automatic Cycle 1 recovery worker has not reported its updated mode yet.',
      cycleOneExists
        ? 'pass'
        : draft?.status === 'complete'
          ? cycleStartFailures > 0 || (cycleStartAge !== null && cycleStartAge > 3)
            ? 'fail'
            : 'warning'
          : cycleStartMode === 'immediate-after-draft'
            ? 'pass'
            : 'warning',
      true,
    ),
  );

  const cycleSchemaHealthy = activeCycles.every(
    (cycle) =>
      (cycle.windowSchemaVersion ?? 0) >= 1 && (cycle.matchupCompletionSchemaVersion ?? 0) >= 1,
  );
  checks.push(
    createCheck(
      'cycle-schema',
      'scoring',
      'Active cycles use independent-window metadata',
      activeCycles.length === 0
        ? 'No active cycles currently require validation.'
        : `${activeCycles.length} active cycle document(s) checked.`,
      activeCycles.length === 0 || cycleSchemaHealthy ? 'pass' : 'fail',
      true,
    ),
  );

  const liveScoringHasError = liveScoring?.status === 'error' || Boolean(liveScoring?.lastError);
  checks.push(
    createCheck(
      'live-scoring-status',
      'scoring',
      'Shared live-scoring worker',
      !liveScoring
        ? 'No shared scoring control document has been created yet.'
        : liveScoringHasError
          ? liveScoring.lastError || 'The scorer reported an error.'
          : `${liveScoring.totalSuccessfulRefreshCount} successful refresh(es); ${liveScoring.totalSkippedSnapshotWriteCount} unchanged write(s) skipped.`,
      liveScoringHasError
        ? 'fail'
        : liveScoring && liveScoring.totalSuccessfulRefreshCount > 0
          ? 'pass'
          : 'warning',
      true,
    ),
  );

  const leagueAutomationAge = timestampAgeMinutes(leagueAutomation?.['lastRunAt']);
  const leagueAutomationFailures =
    typeof leagueAutomation?.['failedLeagueCount'] === 'number'
      ? leagueAutomation['failedLeagueCount']
      : 0;
  checks.push(
    createCheck(
      'server-league-automation',
      'scoring',
      'Scheduled season and scoring automation',
      !leagueAutomation
        ? 'The ten-minute league automation worker has not recorded a run yet.'
        : `${String(leagueAutomation['status'] ?? 'unknown')}; last run ${formatAgeMinutes(leagueAutomationAge)}; ${leagueAutomationFailures} failed league(s).`,
      !leagueAutomation
        ? 'warning'
        : leagueAutomationFailures > 0 || leagueAutomation['status'] === 'partial-error'
          ? 'fail'
          : leagueAutomationAge !== null && leagueAutomationAge <= 25
            ? 'pass'
            : 'warning',
      true,
    ),
  );

  const leagueQueueMode =
    leagueAutomation?.['queueMode'] === 'canary' ||
    leagueAutomation?.['queueMode'] === 'primary'
      ? leagueAutomation['queueMode']
      : 'shadow';
  const queueDispatchAge = timestampAgeMinutes(
    leagueAutomation?.['queueLastDispatchAt'],
  );
  const queueBootstrapAge = timestampAgeMinutes(
    leagueAutomation?.['queueLastBootstrapAt'],
  );
  const queueDueCount =
    typeof leagueAutomation?.['queueDueScheduleSampleCount'] === 'number'
      ? leagueAutomation['queueDueScheduleSampleCount']
      : 0;
  const queueEligibleCount =
    typeof leagueAutomation?.['queueEligibleDueCount'] === 'number'
      ? leagueAutomation['queueEligibleDueCount']
      : 0;
  const queueSelectedCount =
    typeof leagueAutomation?.['queueSelectedForEnqueueCount'] === 'number'
      ? leagueAutomation['queueSelectedForEnqueueCount']
      : 0;
  const queueActivePendingCount =
    typeof leagueAutomation?.['queueActivePendingTaskCount'] === 'number'
      ? leagueAutomation['queueActivePendingTaskCount']
      : 0;
  const queueMaxPendingCount =
    typeof leagueAutomation?.['queueTaskMaxPendingTasks'] === 'number'
      ? leagueAutomation['queueTaskMaxPendingTasks']
      : 0;
  const queueFailedEnqueueCount =
    typeof leagueAutomation?.['queueFailedEnqueueCount'] === 'number'
      ? leagueAutomation['queueFailedEnqueueCount']
      : 0;
  const queueRecoveredStaleCount =
    typeof leagueAutomation?.['queueLastRecoveryCount'] === 'number'
      ? leagueAutomation['queueLastRecoveryCount']
      : 0;
  const queueCoverageCount =
    typeof leagueAutomation?.['queueScheduleCoverageCount'] === 'number'
      ? leagueAutomation['queueScheduleCoverageCount']
      : 0;
  const queueCoverageTarget =
    typeof leagueAutomation?.['queueScheduleCoverageCompletedDraftCount'] === 'number'
      ? leagueAutomation['queueScheduleCoverageCompletedDraftCount']
      : 0;
  const queueOldestDueAge = leagueAutomation?.['queueOldestDueAgeMilliseconds'];
  const queueHealthy =
    queueFailedEnqueueCount === 0 &&
    queueRecoveredStaleCount === 0 &&
    queueDispatchAge !== null &&
    queueDispatchAge <= 5;
  const queueCoverageComplete =
    queueCoverageTarget > 0 && queueCoverageCount >= queueCoverageTarget;

  checks.push(
    createCheck(
      'league-scoring-queue-foundation',
      'scoring',
      leagueQueueMode === 'shadow'
        ? 'Queued league scoring foundation is observing only'
        : leagueQueueMode === 'canary'
          ? 'Queued league scoring is serving selected canary leagues'
          : 'Queued league scoring is the primary dispatcher',
      `Mode ${leagueQueueMode}; dispatcher last ran ${formatAgeMinutes(queueDispatchAge)}; ` +
        `${queueDueCount} due schedule(s) sampled, ${queueEligibleCount} eligible for enqueue; ` +
        `${queueSelectedCount} selected this pass, ${queueActivePendingCount}/${queueMaxPendingCount || 'unknown'} pending; ` +
        `oldest due age ${formatDurationMilliseconds(queueOldestDueAge)}; ` +
        `schedule coverage ${queueCoverageCount}/${queueCoverageTarget || 'not measured'} ` +
        `(bootstrap ${formatAgeMinutes(queueBootstrapAge)}); ` +
        `${queueFailedEnqueueCount} enqueue failure(s), ${queueRecoveredStaleCount} stale task(s) recovered in the latest sweep.`,
      leagueQueueMode === 'shadow'
        ? 'warning'
        : queueHealthy && queueCoverageComplete
          ? 'pass'
          : queueFailedEnqueueCount > 0 || queueRecoveredStaleCount > 0
            ? 'fail'
            : 'warning',
      false,
    ),
  );

  const projectionServerValidated = Boolean(
    projection?.generatedByAuthority === 'server' &&
    projection?.authoritySchemaVersion === PROJECTION_SNAPSHOT_AUTHORITY_SCHEMA_VERSION &&
    projection?.catalogValidationStatus === 'validated' &&
    projection?.catalogSnapshotId &&
    /^[a-f0-9]{64}$/.test(projection?.catalogHash ?? '') &&
    projection?.canonicalAssetCount === projection?.assetCount &&
    projection?.snapshotHashSchemaVersion === PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION &&
    projection?.snapshotHashAlgorithm === 'sha256' &&
    projection?.snapshotIntegrityStatus === 'verified' &&
    /^[a-f0-9]{64}$/.test(projection?.snapshotContentHash ?? '') &&
    projection?.snapshotChunkHashes?.length === projection?.assetDocumentCount,
  );

  checks.push(
    createCheck(
      'projection-status',
      'projection',
      'Shared projection snapshot is server hashed and Draft ready',
      !projection
        ? 'No shared projection metadata is available.'
        : `Status ${projection.status}; version ${projection.projectionVersion}; target Cycle ${projection.targetCycleNumber}; source ${projection.generationReason}; ` +
          (projectionServerValidated
            ? `server catalog ${projection.catalogSnapshotId} validated ${projection.canonicalAssetCount} assets; root hash ${(projection.snapshotContentHash ?? '').slice(0, 12)}… is verified.`
            : 'this snapshot is missing the current server authority marker, canonical catalog validation, or deterministic root hash and must be verified or regenerated before Draft use.'),
      projection?.status === 'ready' &&
        projection.projectionVersion === SHARED_PROJECTION_VERSION &&
        projection.assetCount > 0
        ? projectionServerValidated
          ? projection.generationReason === 'server-emergency'
            ? 'warning'
            : 'pass'
          : 'warning'
        : projection?.status === 'error'
          ? 'fail'
          : 'warning',
      true,
    ),
  );

  checks.push(
    createCheck(
      'injury-sync',
      'injury',
      'Shared injury report',
      !injurySync
        ? 'No global injury synchronization state is available yet.'
        : `${injurySync.status}: ${injurySync.message || 'No message recorded.'}`,
      injurySync?.status === 'success'
        ? 'pass'
        : injurySync?.status === 'error'
          ? 'fail'
          : 'warning',
      true,
    ),
  );


  const injuryAutomationAge = timestampAgeMinutes(
    injuryAutomation?.['lastSuccessfulRunAt'] ?? injuryAutomation?.['lastRunAt'],
  );
  const activeInjurySeason = injuryAutomation?.['activeSeason'] !== false;
  const injuryFreshnessLimitMinutes = activeInjurySeason ? 8 * 60 : 26 * 60;
  checks.push(
    createCheck(
      'scheduled-injury-refresh',
      'injury',
      'Scheduled global injury refresh',
      !injuryAutomation
        ? 'The server injury scheduler has not recorded a run yet.'
        : `${String(injuryAutomation['status'] ?? 'unknown')}; last successful run ${formatAgeMinutes(injuryAutomationAge)}.`,
      !injuryAutomation
        ? 'warning'
        : injuryAutomation['status'] === 'error'
          ? 'fail'
          : injuryAutomationAge !== null && injuryAutomationAge <= injuryFreshnessLimitMinutes
            ? 'pass'
            : 'warning',
      true,
    ),
  );

  const injuryEmailAge = timestampAgeMinutes(
    injuryEmailAutomation?.['lastSuccessfulRunAt'] ?? injuryEmailAutomation?.['lastRunAt'],
  );
  const failedOwnerBatches =
    typeof injuryEmailAutomation?.['failedOwnerBatchCount'] === 'number'
      ? injuryEmailAutomation['failedOwnerBatchCount']
      : 0;
  const pendingEmailCount =
    typeof injuryEmailAutomation?.['pendingQueueCount'] === 'number'
      ? injuryEmailAutomation['pendingQueueCount']
      : 0;
  checks.push(
    createCheck(
      'injury-email-worker',
      'injury',
      'Injury email queue worker',
      !injuryEmailAutomation
        ? 'The five-minute injury email worker has not recorded a run yet.'
        : `${String(injuryEmailAutomation['status'] ?? 'unknown')}; last run ${formatAgeMinutes(injuryEmailAge)}; ${pendingEmailCount} pending alert(s).`,
      !injuryEmailAutomation
        ? 'warning'
        : failedOwnerBatches > 0 || injuryEmailAutomation['status'] === 'error'
          ? 'fail'
          : injuryEmailAge !== null && injuryEmailAge <= 15
            ? 'pass'
            : 'warning',
      true,
    ),
  );

  const playoffFormatHealthy = !playoffs || playoffs.formatVersion === 2;
  checks.push(
    createCheck(
      'playoff-format',
      'playoffs',
      'Banked playoff format',
      !playoffs
        ? 'Playoffs have not been created yet; the release simulator validates the format separately.'
        : `Format version ${playoffs.formatVersion}; status ${playoffs.status}; ${playoffs.placements.length} placement(s) saved.`,
      playoffFormatHealthy ? 'pass' : 'fail',
      true,
    ),
  );

  const requiredChecks = checks.filter((check) => check.requiredForLiveLaunch);
  const failedRequired = requiredChecks.filter((check) => check.level === 'fail');
  const warningRequired = requiredChecks.filter((check) => check.level === 'warning');
  const overallStatus: ReleaseReadinessSnapshot['overallStatus'] =
    failedRequired.length > 0 ? 'attention' : warningRequired.length > 0 ? 'testing' : 'ready';

  return {
    leagueId,
    generatedAt: new Date().toISOString(),
    overallStatus,
    passedRequiredCount: requiredChecks.filter((check) => check.level === 'pass').length,
    totalRequiredCount: requiredChecks.length,
    warningCount: checks.filter((check) => check.level === 'warning').length,
    checks,
    versions: RELEASE_VERSION_SUMMARY,
    scoringMode: runtime.effectiveMode,
    historicalDateIso: runtime.historicalDateIso,
    developerToolsEnabled: runtime.developerToolsEnabled,
    latestCycleNumber: latestCycle?.cycleNumber ?? null,
    activeCycleNumbers: activeCycles.map((cycle) => cycle.cycleNumber),
    teamCount: teams.length,
    maxTeams: league.maxTeams,
    draftStatus: draft?.status ?? 'not-created',
    projectionStatus: projection?.status ?? 'missing',
    projectionTargetCycleNumber: projection?.targetCycleNumber ?? null,
    lastInjurySyncAt:
      injurySync?.lastSuccessfulSyncAt || injurySync?.lastDailySuccessfulSyncAt || null,
    liveScoringStatus: liveScoring?.status ?? 'not-initialized',
    lastLiveScoringSyncAt: toIso(liveScoring?.lastRefreshCompletedAt),
    playoffStatus: playoffs?.status ?? 'not-started',
  };
}

export async function retryReleaseReadinessScoring(leagueId: string): Promise<void> {
  await requestLeagueLiveScoringRefresh(leagueId);
}

export async function clearReleaseReadinessScoringLease(leagueId: string): Promise<void> {
  await clearExpiredOrErroredLiveScoringLease(leagueId);
}

export async function retryReleaseReadinessInjurySync(leagueId: string): Promise<string> {
  const result = await syncPlayerAvailabilityFromEspn({
    leagueId,
    force: true,
    minimumIntervalMinutes: 0,
    trigger: 'commissioner-browser',
  });

  return result.message;
}

export async function regenerateReleaseReadinessProjection(
  leagueId: string,
  targetCycleNumber: number,
): Promise<string> {
  const [league, teams] = await Promise.all([getLeagueById(leagueId), getLeagueTeams(leagueId)]);

  if (!league) {
    throw new Error('League not found for projection recovery.');
  }

  const snapshot = await generateSharedProjectionSnapshot({
    leagueId,
    teamCount: Math.max(2, teams.length || league.maxTeams),
    requiredGamesPerCycle:
      league.scoringRules?.requiredGamesPerCycle ?? defaultScoringRules.requiredGamesPerCycle,
    generationReason: 'manual',
    targetCycleNumber: Math.max(1, Math.floor(targetCycleNumber)),
  });

  return `Projection ${snapshot.metadata.snapshotId} is ready for Cycle ${snapshot.metadata.targetCycleNumber}.`;
}

export async function verifyReleaseReadinessProjectionIntegrity(
  leagueId: string,
): Promise<string> {
  const { result } = await manageProjectionSnapshotIntegrity({
    leagueId,
    action: 'verify-current',
    reason: 'Release Readiness verified the current Projection V11 snapshot before Draft use.',
  });

  return `${result.message} Root hash ${result.snapshotContentHash.slice(0, 12)}….`;
}

export async function restorePreviousReleaseReadinessProjection(
  leagueId: string,
): Promise<string> {
  const { result } = await manageProjectionSnapshotIntegrity({
    leagueId,
    action: 'restore-previous',
    reason: 'Release Readiness restored the newest prior verified Projection V11 snapshot.',
  });

  return `${result.message} Save Draft settings again before starting the Draft.`;
}

