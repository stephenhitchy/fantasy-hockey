import { createHash } from 'node:crypto';

import {
  FieldPath,
  FieldValue,
} from 'firebase-admin/firestore';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import {
  AUTOMATIC_INJURY_AVAILABILITY_MAX_AGE_MILLISECONDS,
  applyAutomaticQueuedInjuryReplacement,
  getQueuedBenchSwapInjuryPromotionFingerprint,
  resolveTrustedCommissionerAvailabilityStatus,
} from './roster-moves';
import { db } from './shared/core/firebase';
import { IR_SLOT_COUNT } from './shared/core/team/roster-config';
import type { PendingRosterSlotMove } from './shared/core/team/roster.models';
import { resolveSafeFirestoreDocumentId } from './shared/security/firestore-document-id.util';
import {
  FIRESTORE_LEAGUE_ID_OPTIONS,
  FIRESTORE_PLAYER_ID_OPTIONS,
} from './shared/security/firestore-document-id-policies';

const FUNCTION_REGION = 'us-central1';
const AUTOMATION_HEALTH_ROOT_PATH =
  'appData/automaticInjuryReplacementAutomation';
const ELIGIBLE_INJURY_STATUSES = new Set([
  'out',
  'injured-reserve',
  'long-term-injured-reserve',
]);

// Each trigger is intentionally bounded. The scheduled cursor eventually
// covers any roster omitted by a very large global refresh.
const GLOBAL_MAX_ROSTER_READS = 500;
const GLOBAL_MAX_LEAGUE_READS = 100;
const GLOBAL_MAX_CANDIDATE_ATTEMPTS = 100;
const LEAGUE_MAX_TEAM_READS = 64;
const BACKSTOP_LEAGUE_PAGE_SIZE = 4;
const BACKSTOP_MAX_CANDIDATE_ATTEMPTS = 100;
const MAX_ACTIVE_SLOTS_PER_ROSTER = 20;
const CANDIDATE_CONCURRENCY = 4;
const GLOBAL_AVAILABILITY_MAX_FUTURE_SKEW_MILLISECONDS = 5 * 60 * 1000;

export type AutomaticInjuryReplacementSource =
  | 'global-availability-refresh'
  | 'league-availability-override'
  | 'scheduled-backstop';

export interface AutomaticInjuryReplacementCandidate {
  leagueId: string;
  ownerId: string;
  activeSlotId: string;
  benchSlotId: string;
  pendingMoveId: string;
  pendingMoveFingerprint: string;
  outgoingPlayerId: number;
}

interface CandidateRunSummary {
  attemptedCount: number;
  completedCount: number;
  failedCount: number;
  failureSamples: string[];
}

interface RosterScanResult {
  candidates: AutomaticInjuryReplacementCandidate[];
  rosterReadCount: number;
  reachedEnd: boolean;
  truncated: boolean;
}

export function getAutomaticInjuryReplacementCandidateKey(
  candidate: AutomaticInjuryReplacementCandidate,
): string {
  return createHash('sha256')
    .update(JSON.stringify({
      leagueId: candidate.leagueId,
      ownerId: candidate.ownerId,
      activeSlotId: candidate.activeSlotId,
      benchSlotId: candidate.benchSlotId,
      pendingMoveId: candidate.pendingMoveId,
      pendingMoveFingerprint: candidate.pendingMoveFingerprint,
      outgoingPlayerId: candidate.outgoingPlayerId,
    }))
    .digest('hex');
}

export function selectFairAutomaticInjuryReplacementCandidates(input: {
  candidates: readonly AutomaticInjuryReplacementCandidate[];
  maximumCount: number;
  afterCandidateKey?: string | null;
}): {
  selected: AutomaticInjuryReplacementCandidate[];
  nextCandidateKey: string | null;
  truncated: boolean;
} {
  const boundedMaximumCount = Math.max(0, Math.floor(input.maximumCount));
  const keyedCandidates = input.candidates
    .map((candidate) => ({
      candidate,
      key: getAutomaticInjuryReplacementCandidateKey(candidate),
    }))
    .sort((first, second) => first.key.localeCompare(second.key));
  const afterCandidateKey = asString(input.afterCandidateKey);
  const startIndex = afterCandidateKey
    ? Math.max(
        0,
        keyedCandidates.findIndex((entry) => entry.key > afterCandidateKey),
      )
    : 0;
  const rotatedCandidates = [
    ...keyedCandidates.slice(startIndex),
    ...keyedCandidates.slice(0, startIndex),
  ];
  const selectedEntries = rotatedCandidates.slice(0, boundedMaximumCount);

  return {
    selected: selectedEntries.map((entry) => entry.candidate),
    nextCandidateKey: selectedEntries.at(-1)?.key ?? null,
    truncated: keyedCandidates.length > boundedMaximumCount,
  };
}

export function getAutomaticInjuryReplacementBackstopPageKey(
  selectedLeagueIds: readonly string[],
): string {
  return createHash('sha256')
    .update(JSON.stringify([...selectedLeagueIds]))
    .digest('hex')
    .slice(0, 32);
}

export function selectBoundedAutomaticInjuryReplacementCandidates(
  candidates: readonly AutomaticInjuryReplacementCandidate[],
  maximumCount: number,
): {
  selected: AutomaticInjuryReplacementCandidate[];
  truncated: boolean;
} {
  const selection = selectFairAutomaticInjuryReplacementCandidates({
    candidates,
    maximumCount,
  });

  return {
    selected: selection.selected,
    truncated: selection.truncated,
  };
}

export function resolveAutomaticInjuryReplacementBackstopCursor(input: {
  selectedLeagueIds: readonly string[];
  pageReachedEnd: boolean;
}): string | null {
  return input.pageReachedEnd
    ? null
    : input.selectedLeagueIds.at(-1) ?? null;
}

function getAutomationSourceHealthPath(
  source: AutomaticInjuryReplacementSource,
  scopeId?: string | null,
): string {
  const sourcePath = `${AUTOMATION_HEALTH_ROOT_PATH}/sources/${source}`;

  return scopeId ? `${sourcePath}/scopes/${scopeId}` : sourcePath;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asPositiveInteger(value: unknown): number {
  const result = typeof value === 'number' ? value : Number(value);

  return Number.isSafeInteger(result) && result > 0 ? result : 0;
}

function isEligibleInjuryStatus(value: unknown): boolean {
  return ELIGIBLE_INJURY_STATUSES.has(asString(value).toLowerCase());
}

function getRosterAssetKey(value: unknown): string {
  const asset = asRecord(value);
  const savedAssetKey = asString(asset['assetKey']);

  if (savedAssetKey) {
    return savedAssetKey;
  }

  if (asset['assetType'] === 'skater') {
    const playerId = asPositiveInteger(asRecord(asset['player'])['id']);

    return playerId > 0 ? `skater-${playerId}` : '';
  }

  if (asset['assetType'] === 'team-goalie-unit') {
    const teamAbbreviation = asString(asset['teamAbbreviation']).toUpperCase();

    return teamAbbreviation ? `goalie-unit-${teamAbbreviation}` : '';
  }

  return '';
}

function getSkaterPlayerId(value: unknown): number {
  const asset = asRecord(value);

  return asset['assetType'] === 'skater'
    ? asPositiveInteger(asRecord(asset['player'])['id'])
    : 0;
}

/**
 * Finds only a manager's already-authorized same-slot bench swaps. It never
 * chooses a replacement player and fails closed on any ambiguous reservation.
 */
export function findAutomaticQueuedInjuryReplacementCandidates(input: {
  leagueId: string;
  ownerId: string;
  rosterData: unknown;
  eligiblePlayerIds?: ReadonlySet<number> | null;
}): AutomaticInjuryReplacementCandidate[] {
  const leagueId = asString(input.leagueId);
  const ownerId = asString(input.ownerId);

  if (!leagueId || !ownerId) {
    return [];
  }

  const roster = asRecord(input.rosterData);
  const activeSlots = asArray(roster['activeSlots']).map(asRecord);
  const benchSlots = asArray(roster['benchSlots']).map(asRecord);
  const irSlots = asArray(roster['irSlots']).map(asRecord);

  if (
    activeSlots.length > MAX_ACTIVE_SLOTS_PER_ROSTER ||
    !(
      irSlots.length < IR_SLOT_COUNT ||
      irSlots.slice(0, IR_SLOT_COUNT).some((slot) => slot['asset'] === null)
    )
  ) {
    return [];
  }

  const candidates: AutomaticInjuryReplacementCandidate[] = [];

  for (const activeSlot of activeSlots) {
    const activeSlotId = asString(activeSlot['slotId']);
    const activePosition = asString(activeSlot['position']);
    const outgoingAsset = asRecord(activeSlot['asset']);
    const outgoingAssetKey = getRosterAssetKey(outgoingAsset);
    const outgoingPlayerId = getSkaterPlayerId(outgoingAsset);
    const pendingMove = asRecord(activeSlot['pendingMove']);
    const pendingMoveId = asString(pendingMove['id']);
    const sourceBenchSlotId = asString(pendingMove['sourceBenchSlotId']);
    const pendingIncomingAsset = asRecord(pendingMove['incomingAsset']);
    const incomingAssetKey = getRosterAssetKey(pendingIncomingAsset);

    if (
      !activeSlotId ||
      !activePosition ||
      outgoingAsset['assetType'] !== 'skater' ||
      !outgoingAssetKey ||
      outgoingPlayerId <= 0 ||
      (input.eligiblePlayerIds && !input.eligiblePlayerIds.has(outgoingPlayerId)) ||
      !pendingMoveId ||
      pendingMove['moveType'] !== 'add-drop' ||
      asString(pendingMove['queuedByOwnerId']) !== ownerId ||
      asString(pendingMove['outgoingAssetKey']) !== outgoingAssetKey ||
      pendingMove['sourceWaiverId'] !== null ||
      pendingMove['outgoingDestination'] !== 'bench' ||
      !sourceBenchSlotId ||
      pendingIncomingAsset['assetType'] !== 'skater' ||
      !incomingAssetKey ||
      asString(pendingIncomingAsset['position']) !== activePosition
    ) {
      continue;
    }

    const matchingBenchSlots = benchSlots.filter(
      (slot) => asString(slot['slotId']) === sourceBenchSlotId,
    );
    const selectedBenchAsset = asRecord(matchingBenchSlots[0]?.['asset']);

    if (
      matchingBenchSlots.length !== 1 ||
      selectedBenchAsset['assetType'] !== 'skater' ||
      getRosterAssetKey(selectedBenchAsset) !== incomingAssetKey ||
      asString(selectedBenchAsset['position']) !== activePosition
    ) {
      continue;
    }

    const matchingReservations = activeSlots.filter((slot) =>
      asString(asRecord(slot['pendingMove'])['sourceBenchSlotId']) ===
        sourceBenchSlotId,
    );
    const matchingPendingMoveIds = activeSlots.filter(
      (slot) => asString(asRecord(slot['pendingMove'])['id']) === pendingMoveId,
    );
    const pendingMoveFingerprint =
      getQueuedBenchSwapInjuryPromotionFingerprint({
        pendingMove: pendingMove as unknown as PendingRosterSlotMove,
        ownerId,
        activeSlotId,
        benchSlotId: sourceBenchSlotId,
        outgoingAssetKey,
        incomingAssetKey,
      });

    if (
      matchingReservations.length !== 1 ||
      asString(matchingReservations[0]['slotId']) !== activeSlotId ||
      matchingPendingMoveIds.length !== 1 ||
      !pendingMoveFingerprint
    ) {
      continue;
    }

    candidates.push({
      leagueId,
      ownerId,
      activeSlotId,
      benchSlotId: sourceBenchSlotId,
      pendingMoveId,
      pendingMoveFingerprint,
      outgoingPlayerId,
    });
  }

  return candidates;
}

function getAvailabilityStatusByPlayerId(data: unknown): Map<number, string> {
  const statuses = new Map<number, string>();

  for (const entry of asArray(asRecord(data)['records'])) {
    const record = asRecord(entry);
    const playerId = asPositiveInteger(record['playerId']);

    if (playerId > 0) {
      statuses.set(playerId, asString(record['status']).toLowerCase());
    }
  }

  return statuses;
}

function getTimestampMilliseconds(value: unknown): number | null {
  if (
    value &&
    typeof value === 'object' &&
    'toMillis' in value &&
    typeof (value as { toMillis?: unknown }).toMillis === 'function'
  ) {
    const result = (value as { toMillis: () => number }).toMillis();

    return Number.isFinite(result) ? result : null;
  }

  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.getTime() : null;
  }

  if (typeof value === 'string') {
    const result = Date.parse(value);

    return Number.isFinite(result) ? result : null;
  }

  return null;
}

function getTrustedGlobalAvailabilityStatuses(
  data: unknown,
  nowMilliseconds = Date.now(),
): Map<number, string> | null {
  const record = asRecord(data);
  const generatedAtMilliseconds = getTimestampMilliseconds(
    record['lastSuccessfulSyncAt'],
  );

  if (
    asString(record['status']) !== 'success' ||
    asString(record['source']).toUpperCase() !== 'ESPN' ||
    record['draftReadinessSourceComplete'] !== true ||
    generatedAtMilliseconds === null ||
    generatedAtMilliseconds >
      nowMilliseconds + GLOBAL_AVAILABILITY_MAX_FUTURE_SKEW_MILLISECONDS ||
    nowMilliseconds - generatedAtMilliseconds >
      AUTOMATIC_INJURY_AVAILABILITY_MAX_AGE_MILLISECONDS
  ) {
    return null;
  }

  return getAvailabilityStatusByPlayerId(record);
}

function getEligiblePlayerIds(statuses: ReadonlyMap<number, string>): Set<number> {
  return new Set(
    [...statuses.entries()]
      .filter(([, status]) => isEligibleInjuryStatus(status))
      .map(([playerId]) => playerId),
  );
}

function getErrorMessage(error: unknown): string {
  return (
    error instanceof Error ? error.message : String(error)
  ).slice(0, 500);
}

async function processCandidates(
  candidates: readonly AutomaticInjuryReplacementCandidate[],
  source: AutomaticInjuryReplacementSource,
): Promise<CandidateRunSummary> {
  let completedCount = 0;
  let failedCount = 0;
  const failureSamples: string[] = [];

  for (let index = 0; index < candidates.length; index += CANDIDATE_CONCURRENCY) {
    const chunk = candidates.slice(index, index + CANDIDATE_CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map((candidate) => applyAutomaticQueuedInjuryReplacement({
        leagueId: candidate.leagueId,
        ownerId: candidate.ownerId,
        activeSlotId: candidate.activeSlotId,
        benchSlotId: candidate.benchSlotId,
        expectedPendingMoveId: candidate.pendingMoveId,
        expectedPendingMoveFingerprint: candidate.pendingMoveFingerprint,
        source,
      })),
    );

    results.forEach((result, resultIndex) => {
      const candidate = chunk[resultIndex];

      if (result.status === 'fulfilled') {
        completedCount += 1;
        return;
      }

      failedCount += 1;
      const message = getErrorMessage(result.reason);

      if (failureSamples.length < 10) {
        failureSamples.push(
          `${candidate.leagueId}/${candidate.ownerId}/${candidate.activeSlotId}: ${message}`,
        );
      }
      console.error('Automatic injury replacement candidate failed.', {
        source,
        leagueId: candidate.leagueId,
        ownerId: candidate.ownerId,
        activeSlotId: candidate.activeSlotId,
        pendingMoveId: candidate.pendingMoveId,
        error: result.reason,
      });
    });
  }

  return {
    attemptedCount: candidates.length,
    completedCount,
    failedCount,
    failureSamples,
  };
}

async function scanGlobalRosters(
  eligiblePlayerIds: ReadonlySet<number>,
): Promise<RosterScanResult> {
  const candidates: AutomaticInjuryReplacementCandidate[] = [];
  let rosterReadCount = 0;
  let truncated = false;
  const leaguesPage = await db.collection('leagues')
    .orderBy(FieldPath.documentId())
    .limit(GLOBAL_MAX_LEAGUE_READS + 1)
    .get();
  const selectedLeagues = leaguesPage.docs.slice(0, GLOBAL_MAX_LEAGUE_READS);

  for (const league of selectedLeagues) {
    if (
      rosterReadCount >= GLOBAL_MAX_ROSTER_READS ||
      candidates.length >= GLOBAL_MAX_CANDIDATE_ATTEMPTS
    ) {
      truncated = true;
      break;
    }

    const scan = await scanLeagueRosters({
      leagueId: league.id,
      eligiblePlayerIds,
      maxTeamReads: Math.min(
        LEAGUE_MAX_TEAM_READS,
        GLOBAL_MAX_ROSTER_READS - rosterReadCount,
      ),
      maxCandidateAttempts:
        GLOBAL_MAX_CANDIDATE_ATTEMPTS - candidates.length,
    });

    rosterReadCount += scan.rosterReadCount;
    candidates.push(...scan.candidates);
    truncated ||= scan.truncated;
  }

  truncated ||= leaguesPage.size > GLOBAL_MAX_LEAGUE_READS;

  return {
    candidates,
    rosterReadCount,
    reachedEnd: !truncated,
    truncated,
  };
}

async function scanLeagueRosters(input: {
  leagueId: string;
  eligiblePlayerIds?: ReadonlySet<number> | null;
  maxTeamReads?: number;
  maxCandidateAttempts?: number;
}): Promise<RosterScanResult> {
  const maxTeamReads = Math.max(
    1,
    Math.min(LEAGUE_MAX_TEAM_READS, input.maxTeamReads ?? LEAGUE_MAX_TEAM_READS),
  );
  const maxCandidateAttempts = Math.max(
    1,
    input.maxCandidateAttempts ?? GLOBAL_MAX_CANDIDATE_ATTEMPTS,
  );
  const teamsPage = await db.collection(`leagues/${input.leagueId}/teams`)
    .orderBy(FieldPath.documentId())
    .limit(maxTeamReads + 1)
    .get();
  const selectedTeams = teamsPage.docs.slice(0, maxTeamReads);
  const rosterSnapshots = selectedTeams.length > 0
    ? await db.getAll(...selectedTeams.map((team) =>
        db.doc(`leagues/${input.leagueId}/teams/${team.id}/roster/current`),
      ))
    : [];
  const candidates = rosterSnapshots.flatMap((snapshot) =>
    snapshot.exists
      ? findAutomaticQueuedInjuryReplacementCandidates({
          leagueId: input.leagueId,
          ownerId: snapshot.ref.parent.parent?.id ?? '',
          rosterData: snapshot.data(),
          eligiblePlayerIds: input.eligiblePlayerIds,
        })
      : [],
  );

  return {
    candidates: candidates.slice(0, maxCandidateAttempts),
    rosterReadCount: rosterSnapshots.length,
    reachedEnd: teamsPage.size <= maxTeamReads,
    truncated:
      teamsPage.size > maxTeamReads ||
      candidates.length > maxCandidateAttempts,
  };
}

async function filterCandidatesByEffectiveAvailability(
  candidates: readonly AutomaticInjuryReplacementCandidate[],
  globalStatuses: ReadonlyMap<number, string>,
): Promise<AutomaticInjuryReplacementCandidate[]> {
  if (candidates.length === 0) {
    return [];
  }

  const referenceByKey = new Map<string, ReturnType<typeof db.doc>>();

  for (const candidate of candidates) {
    const key = `${candidate.leagueId}:${candidate.outgoingPlayerId}`;
    referenceByKey.set(
      key,
      db.doc(
        `leagues/${candidate.leagueId}/playerAvailability/${candidate.outgoingPlayerId}`,
      ),
    );
  }

  const references = [...referenceByKey.values()];
  const overrideSnapshots = await db.getAll(...references);
  const overrideStatusByKey = new Map<string, string>();

  overrideSnapshots.forEach((snapshot) => {
    if (!snapshot.exists) {
      return;
    }

    const pathParts = snapshot.ref.path.split('/');
    const leagueId = pathParts[1] ?? '';
    const playerId = asPositiveInteger(pathParts[3]);
    const status = resolveTrustedCommissionerAvailabilityStatus(
      snapshot.data(),
      leagueId,
      playerId,
    ).toLowerCase();

    if (leagueId && playerId > 0 && status) {
      overrideStatusByKey.set(`${leagueId}:${playerId}`, status);
    }
  });

  return candidates.filter((candidate) => {
    const key = `${candidate.leagueId}:${candidate.outgoingPlayerId}`;
    const effectiveStatus =
      overrideStatusByKey.get(key) ||
      globalStatuses.get(candidate.outgoingPlayerId) ||
      '';

    return isEligibleInjuryStatus(effectiveStatus);
  });
}

async function writeRunHealth(input: {
  source: AutomaticInjuryReplacementSource;
  eventId?: string | null;
  rosterReadCount: number;
  candidateCount: number;
  summary: CandidateRunSummary;
  truncated: boolean;
  reachedEnd: boolean;
  healthScopeId?: string | null;
  leagueId?: string | null;
  playerId?: number | null;
  backstopLeagueCursorId?: string | null;
  backstopCandidateCursorByPage?: Record<string, string | null>;
  globalRefreshAttemptId?: string | null;
  globalAvailabilityTrusted?: boolean;
}): Promise<void> {
  const healthy = input.summary.failedCount === 0 &&
    !input.truncated &&
    input.globalAvailabilityTrusted !== false;
  const payload: Record<string, unknown> = {
    schemaVersion: 1,
    status: healthy ? 'healthy' : 'degraded',
    lastRunSource: input.source,
    lastRunAt: FieldValue.serverTimestamp(),
    lastEventId: input.eventId ?? null,
    lastRosterReadCount: input.rosterReadCount,
    lastCandidateCount: input.candidateCount,
    lastAttemptedCount: input.summary.attemptedCount,
    lastCompletedCount: input.summary.completedCount,
    lastFailedCount: input.summary.failedCount,
    lastFailureSamples: input.summary.failureSamples,
    lastRunTruncated: input.truncated,
    lastRunReachedEnd: input.reachedEnd,
    lastError: input.summary.failedCount > 0
      ? input.summary.failureSamples[0] ?? 'Candidate processing failed.'
      : null,
    lastErrorAt: input.summary.failedCount > 0
      ? FieldValue.serverTimestamp()
      : null,
    ...(input.leagueId ? { leagueId: input.leagueId } : {}),
    ...(input.playerId ? { playerId: input.playerId } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (healthy) {
    payload['lastSuccessfulRunAt'] = FieldValue.serverTimestamp();
  }
  if (input.backstopLeagueCursorId !== undefined) {
    payload['backstopLeagueCursorId'] = input.backstopLeagueCursorId;
    payload['backstopLastRunAt'] = FieldValue.serverTimestamp();
    if (input.reachedEnd) {
      payload['backstopLastCompletedPassAt'] = FieldValue.serverTimestamp();
    }
  }
  if (input.backstopCandidateCursorByPage !== undefined) {
    payload['backstopCandidateCursorByPage'] =
      input.backstopCandidateCursorByPage;
  }
  if (input.globalRefreshAttemptId !== undefined) {
    payload['lastGlobalRefreshAttemptId'] = input.globalRefreshAttemptId;
  }
  if (input.globalAvailabilityTrusted !== undefined) {
    payload['lastGlobalAvailabilityTrusted'] =
      input.globalAvailabilityTrusted;
  }

  await db.doc(getAutomationSourceHealthPath(
    input.source,
    input.healthScopeId,
  )).set(
    payload,
    { merge: true },
  );
}

async function writeRunError(input: {
  source: AutomaticInjuryReplacementSource;
  eventId?: string | null;
  healthScopeId?: string | null;
  leagueId?: string | null;
  playerId?: number | null;
  error: unknown;
}): Promise<void> {
  await db.doc(getAutomationSourceHealthPath(
    input.source,
    input.healthScopeId,
  )).set({
    schemaVersion: 1,
    status: 'error',
    lastRunSource: input.source,
    lastRunAt: FieldValue.serverTimestamp(),
    lastEventId: input.eventId ?? null,
    ...(input.leagueId ? { leagueId: input.leagueId } : {}),
    ...(input.playerId ? { playerId: input.playerId } : {}),
    lastError: getErrorMessage(input.error),
    lastErrorAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

export const processGlobalAutomaticInjuryReplacements = onDocumentWritten(
  {
    document: 'appData/playerAvailability',
    region: FUNCTION_REGION,
    timeoutSeconds: 540,
    memory: '1GiB',
    maxInstances: 1,
    retry: true,
  },
  async (event) => {
    const source = 'global-availability-refresh' as const;
    const afterSnapshot = event.data?.after;

    if (!afterSnapshot?.exists) {
      return;
    }

    const afterData = afterSnapshot.data();
    const beforeData = event.data?.before.exists
      ? event.data.before.data()
      : undefined;
    const refreshAttemptId = asString(afterData?.['refreshAttemptId']);

    if (
      asString(afterData?.['status']) !== 'success' ||
      !refreshAttemptId ||
      (
        asString(beforeData?.['status']) === 'success' &&
        asString(beforeData?.['refreshAttemptId']) === refreshAttemptId
      )
    ) {
      return;
    }

    try {
      // Process every currently eligible record, not only status transitions.
      // That makes the next successful refresh recover moves saved before this
      // trigger was deployed.
      const globalStatuses = getTrustedGlobalAvailabilityStatuses(afterData);

      if (!globalStatuses) {
        await writeRunHealth({
          source,
          eventId: event.id,
          rosterReadCount: 0,
          candidateCount: 0,
          summary: {
            attemptedCount: 0,
            completedCount: 0,
            failedCount: 0,
            failureSamples: [],
          },
          truncated: false,
          reachedEnd: false,
          globalRefreshAttemptId: refreshAttemptId,
          globalAvailabilityTrusted: false,
        });
        return;
      }

      const eligiblePlayerIds = getEligiblePlayerIds(globalStatuses);
      const scan = await scanGlobalRosters(eligiblePlayerIds);
      const effectiveCandidates = await filterCandidatesByEffectiveAvailability(
        scan.candidates,
        globalStatuses,
      );
      const summary = await processCandidates(effectiveCandidates, source);

      await writeRunHealth({
        source,
        eventId: event.id,
        rosterReadCount: scan.rosterReadCount,
        candidateCount: effectiveCandidates.length,
        summary,
        truncated: scan.truncated,
        reachedEnd: scan.reachedEnd,
        globalRefreshAttemptId: refreshAttemptId,
        globalAvailabilityTrusted: true,
      });
    } catch (error: unknown) {
      await writeRunError({ source, eventId: event.id, error });
      throw error;
    }
  },
);

export const processLeagueAutomaticInjuryReplacement = onDocumentWritten(
  {
    document: 'leagues/{leagueId}/playerAvailability/{playerId}',
    region: FUNCTION_REGION,
    timeoutSeconds: 180,
    memory: '512MiB',
    maxInstances: 5,
    retry: true,
  },
  async (event) => {
    const source = 'league-availability-override' as const;
    const leagueId = resolveSafeFirestoreDocumentId(
      event.params.leagueId,
      FIRESTORE_LEAGUE_ID_OPTIONS,
    );
    const playerIdValue = resolveSafeFirestoreDocumentId(
      event.params.playerId,
      FIRESTORE_PLAYER_ID_OPTIONS,
    );
    const playerId = asPositiveInteger(playerIdValue);

    if (!leagueId || playerId <= 0) {
      return;
    }
    const healthScopeId = `${leagueId}__${playerId}`;

    try {
      let effectiveStatus = event.data?.after.exists
        ? resolveTrustedCommissionerAvailabilityStatus(
            event.data.after.data(),
            leagueId,
            playerId,
          ).toLowerCase()
        : '';

      if (!effectiveStatus) {
        const globalSnapshot = await db.doc('appData/playerAvailability').get();
        const globalStatuses = getTrustedGlobalAvailabilityStatuses(
          globalSnapshot.data(),
        );

        if (!globalStatuses) {
          await writeRunHealth({
            source,
            eventId: event.id,
            healthScopeId,
            leagueId,
            playerId,
            rosterReadCount: 0,
            candidateCount: 0,
            summary: {
              attemptedCount: 0,
              completedCount: 0,
              failedCount: 0,
              failureSamples: [],
            },
            truncated: false,
            reachedEnd: false,
            globalAvailabilityTrusted: false,
          });
          return;
        }

        effectiveStatus = globalStatuses.get(playerId) ?? '';
      }

      if (!isEligibleInjuryStatus(effectiveStatus)) {
        return;
      }

      const scan = await scanLeagueRosters({
        leagueId,
        eligiblePlayerIds: new Set([playerId]),
      });
      const summary = await processCandidates(scan.candidates, source);

      await writeRunHealth({
        source,
        eventId: event.id,
        healthScopeId,
        leagueId,
        playerId,
        rosterReadCount: scan.rosterReadCount,
        candidateCount: scan.candidates.length,
        summary,
        truncated: scan.truncated,
        reachedEnd: scan.reachedEnd,
      });
    } catch (error: unknown) {
      await writeRunError({
        source,
        eventId: event.id,
        healthScopeId,
        leagueId,
        playerId,
        error,
      });
      throw error;
    }
  },
);

export const reconcileAutomaticInjuryReplacements = onSchedule(
  {
    schedule: 'every 10 minutes',
    timeZone: 'America/Los_Angeles',
    region: FUNCTION_REGION,
    timeoutSeconds: 540,
    memory: '1GiB',
    maxInstances: 1,
  },
  async () => {
    const source = 'scheduled-backstop' as const;

    try {
      const [healthSnapshot, globalAvailabilitySnapshot] = await Promise.all([
        db.doc(getAutomationSourceHealthPath(source)).get(),
        db.doc('appData/playerAvailability').get(),
      ]);
      const savedLeagueCursorId = asString(
        healthSnapshot.data()?.['backstopLeagueCursorId'],
      );
      const savedCandidateCursorByPage = Object.fromEntries(
        Object.entries(asRecord(
          healthSnapshot.data()?.['backstopCandidateCursorByPage'],
        ))
          .filter(([pageKey, candidateKey]) =>
            /^[a-f0-9]{32}$/.test(pageKey) &&
            (candidateKey === null || /^[a-f0-9]{64}$/.test(asString(candidateKey))),
          )
          .slice(0, 128),
      ) as Record<string, string | null>;
      let query = db.collection('leagues')
        .orderBy(FieldPath.documentId())
        .limit(BACKSTOP_LEAGUE_PAGE_SIZE + 1);

      if (savedLeagueCursorId) {
        query = query.startAfter(savedLeagueCursorId);
      }

      let leaguePage = await query.get();
      if (leaguePage.empty && savedLeagueCursorId) {
        leaguePage = await db.collection('leagues')
          .orderBy(FieldPath.documentId())
          .limit(BACKSTOP_LEAGUE_PAGE_SIZE + 1)
          .get();
      }

      const selectedLeagues = leaguePage.docs.slice(0, BACKSTOP_LEAGUE_PAGE_SIZE);
      const selectedLeagueIds = selectedLeagues.map((league) => league.id);
      const candidatePageKey =
        getAutomaticInjuryReplacementBackstopPageKey(selectedLeagueIds);
      const structuralCandidates: AutomaticInjuryReplacementCandidate[] = [];
      let rosterReadCount = 0;
      let scanTruncated = false;

      for (const league of selectedLeagues) {
        const scan = await scanLeagueRosters({
          leagueId: league.id,
          maxCandidateAttempts:
            LEAGUE_MAX_TEAM_READS * MAX_ACTIVE_SLOTS_PER_ROSTER,
        });

        rosterReadCount += scan.rosterReadCount;
        structuralCandidates.push(...scan.candidates);
        scanTruncated ||= scan.truncated;
      }

      const globalStatuses = getTrustedGlobalAvailabilityStatuses(
        globalAvailabilitySnapshot.data(),
      );
      const effectiveCandidates = await filterCandidatesByEffectiveAvailability(
        structuralCandidates,
        globalStatuses ?? new Map<number, string>(),
      );
      const boundedCandidates =
        selectFairAutomaticInjuryReplacementCandidates({
          candidates: effectiveCandidates,
          maximumCount: BACKSTOP_MAX_CANDIDATE_ATTEMPTS,
          afterCandidateKey:
            savedCandidateCursorByPage[candidatePageKey] ?? null,
        });
      const candidateOverflow = scanTruncated || boundedCandidates.truncated;
      const summary = await processCandidates(
        boundedCandidates.selected,
        source,
      );
      const pageReachedEnd = leaguePage.size <= BACKSTOP_LEAGUE_PAGE_SIZE;
      // Always advance league pages, even when eligible work exceeds the
      // per-run bound. The next completed pass revisits the tail; a permanent
      // failure or an ineligible structural move can never starve later
      // leagues.
      const nextLeagueCursorId =
        resolveAutomaticInjuryReplacementBackstopCursor({
          selectedLeagueIds,
          pageReachedEnd,
        });
      const nextCandidateCursorByPage = {
        ...savedCandidateCursorByPage,
        [candidatePageKey]: boundedCandidates.nextCandidateKey,
      };

      await writeRunHealth({
        source,
        rosterReadCount,
        candidateCount: effectiveCandidates.length,
        summary,
        truncated: candidateOverflow,
        reachedEnd: pageReachedEnd,
        backstopLeagueCursorId: nextLeagueCursorId,
        backstopCandidateCursorByPage: nextCandidateCursorByPage,
        globalAvailabilityTrusted: globalStatuses !== null,
      });
    } catch (error: unknown) {
      await writeRunError({ source, error });
      throw error;
    }
  },
);
