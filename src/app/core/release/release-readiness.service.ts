import { Timestamp } from 'firebase/firestore';

import { getScoringRuntimeState } from '../cycle/cycle-runtime.config';
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

export const RELEASE_VERSION_SUMMARY: ReleaseVersionSummary = {
  releaseLabel: getScoringRuntimeState().releaseLabel,
  scoringRulesVersion: CURRENT_SCORING_RULES_VERSION,
  projectionVersion: SHARED_PROJECTION_VERSION,
  liveScoringSchemaVersion: 1,
  playoffFormatVersion: 2,
  cycleWindowSchemaVersion: 2,
  matchupCompletionSchemaVersion: 1,
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

  checks.push(
    createCheck(
      'projection-status',
      'projection',
      'Shared projection snapshot is healthy',
      !projection
        ? 'No shared projection metadata is available.'
        : `Status ${projection.status}; version ${projection.projectionVersion}; target Cycle ${projection.targetCycleNumber}.`,
      projection?.status === 'ready' &&
        projection.projectionVersion === SHARED_PROJECTION_VERSION &&
        projection.assetCount > 0
        ? 'pass'
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
