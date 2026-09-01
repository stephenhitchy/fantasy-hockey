import { randomUUID } from 'node:crypto';

import {
  DocumentData,
  FieldValue,
  Timestamp,
} from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import {
  getLeagueAutomationCanonicalCanaryScope,
  requestLeagueAutomationForCanonicalChange,
} from './league-automation';
import { db } from './shared/core/firebase';
import {
  getActiveLeagueCycles,
  getCycleRosterPicksOnce,
} from './shared/core/cycle/cycle.service';
import { DraftPick } from './shared/core/draft/draft.models';
import {
  selectAffectedCanonicalLeagueIds,
} from './shared/core/nhl/nhl-canonical-impact-routing.util';
import {
  applyCanonicalNhlFinalSettlements,
  buildCanonicalNhlGameFacts,
  buildCanonicalNhlGameHashes,
  CANONICAL_NHL_FACTS_SCHEMA_VERSION,
  CANONICAL_NHL_FINAL_RECONCILIATION_MILLISECONDS,
  CANONICAL_NHL_TOI_SETTLEMENT_INTERVAL_MILLISECONDS,
  canonicalNhlSha256,
  CanonicalNhlChangeKind,
  decideCanonicalNhlGameChange,
  type CanonicalNhlGameFacts,
  PreviousCanonicalNhlSignalState,
} from './shared/core/nhl/nhl-canonical-facts.util';
import {
  loadPendingCanonicalPublicationOutbox,
  markCanonicalPublicationOutboxDelivered,
  persistCanonicalPublicationWithOutbox,
  recordCanonicalPublicationOutboxFailure,
} from './shared/core/nhl/nhl-canonical-publication-outbox.service';
import {
  assessNhlFinalInputCompleteness,
  classifyNhlFinalInputFailure,
  validateNhlFinalCanonicalBoxscore,
  validateNhlFinalPlayerGameLog,
  validateNhlFinalPlayByPlay,
  type NhlFinalInputSourceState,
} from './shared/core/nhl/nhl-final-input-completeness.util';
import {
  getGameBoxscore,
  getGamePlayByPlay,
  getNhlScoreNow,
  getRegularSeasonGameLog,
  type NhlPlayerGameLogEntry,
  NhlScoreGame,
} from './shared/core/nhl/nhl-api.service';

const FUNCTION_REGION = 'us-central1';
const FEED_SCHEMA_VERSION = 2;
const FEED_LEASE_MILLISECONDS = 100 * 1000;
const FEED_GAME_CONCURRENCY = 4;
const FEED_MAX_GAME_COUNT = 20;
const FEED_MAX_CANONICAL_DOCUMENT_BYTES = 650 * 1024;
const FINAL_SETTLEMENT_CONCURRENCY = 6;
const FINAL_SETTLEMENT_SECOND_CHECKPOINT_MILLISECONDS = 5 * 60 * 1000;
const FINAL_SETTLEMENT_FINAL_CHECKPOINT_MILLISECONDS = 28 * 60 * 1000;
const IMPACT_INDEX_SCHEMA_VERSION = 1;
const IMPACT_INDEX_MAX_PLAYER_IDS = 700;
const IMPACT_INDEX_MAX_TEAM_ABBREVIATIONS = 40;
const CANONICAL_OUTBOX_DRAIN_LIMIT = 40;

interface LeagueScoringImpact {
  leagueId: string;
  playerIds: number[];
  teamAbbreviations: string[];
  sourceCycleNumbers: number[];
  sourceHash: string;
}

interface CanonicalGameObservation {
  gameId: number;
  sourceVersion: string;
  changeKind: CanonicalNhlChangeKind;
  shouldSignal: boolean;
  affectedPlayerIds: number[];
  affectedTeamAbbreviations: string[];
}

interface FinalSettlementFailure {
  playerId: number;
  sourceState: NhlFinalInputSourceState;
}

interface FinalSettlementLoadResult {
  entriesByPlayerId: Map<number, NhlPlayerGameLogEntry>;
  failures: FinalSettlementFailure[];
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

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function getFeedControlRef() {
  return db.doc('appData/nhlCanonicalImpactFeed');
}

function getCanonicalGameRef(gameId: number) {
  return db.doc(`nhlCanonicalGameFacts/${Math.trunc(gameId)}`);
}

function getLeagueImpactRef(leagueId: string) {
  return db.doc(`leagueAutomationImpactIndex/${leagueId}`);
}

function normalizedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getGameState(game: NhlScoreGame): string {
  return normalizedString(game.gameState).toUpperCase();
}

function isLiveScoreboardGame(game: NhlScoreGame): boolean {
  const state = getGameState(game);
  return state === 'LIVE' || state === 'CRIT';
}

function isFinalScoreboardGame(game: NhlScoreGame): boolean {
  const state = getGameState(game);
  return state === 'OFF' || state === 'FINAL';
}

function getNhlSeasonForGameDate(value: string): string {
  const parsed = new Date(value);
  const date = Number.isFinite(parsed.getTime()) ? parsed : new Date();
  const year = date.getUTCFullYear();
  const startYear = date.getUTCMonth() + 1 >= 7 ? year : year - 1;
  return `${startYear}${startYear + 1}`;
}

function getPreviousCanonicalFacts(
  data: DocumentData | undefined,
): CanonicalNhlGameFacts | null {
  const facts = data?.['facts'];

  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) {
    return null;
  }

  const candidate = facts as Partial<CanonicalNhlGameFacts>;

  if (typeof candidate.gameId !== 'number' || !Number.isFinite(candidate.gameId)) {
    return null;
  }

  return {
    ...candidate,
    schemaVersion: CANONICAL_NHL_FACTS_SCHEMA_VERSION,
    finalSettlements: Array.isArray(candidate.finalSettlements)
      ? candidate.finalSettlements
      : [],
    finalSettlementPlayerIds: Array.isArray(candidate.finalSettlementPlayerIds)
      ? candidate.finalSettlementPlayerIds
      : [],
  } as CanonicalNhlGameFacts;
}

function getFinalSettlementStage(data: DocumentData | undefined): number {
  const value = data?.['finalSettlementStage'];
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(3, Math.trunc(value)))
    : 0;
}

function selectNextFinalSettlementStage(input: {
  currentStage: number;
  elapsedFinalMilliseconds: number;
}): number {
  if (input.currentStage < 1) {
    return 1;
  }

  if (
    input.currentStage < 2 &&
    input.elapsedFinalMilliseconds >=
      FINAL_SETTLEMENT_SECOND_CHECKPOINT_MILLISECONDS
  ) {
    return 2;
  }

  if (
    input.currentStage < 3 &&
    input.elapsedFinalMilliseconds >=
      FINAL_SETTLEMENT_FINAL_CHECKPOINT_MILLISECONDS
  ) {
    return 3;
  }

  return input.currentStage;
}

async function loadFinalSettlementEntries(input: {
  playerIds: readonly number[];
  gameId: number;
  season: string;
}): Promise<FinalSettlementLoadResult> {
  const entriesByPlayerId = new Map<number, NhlPlayerGameLogEntry>();
  const failures: FinalSettlementFailure[] = [];
  const results = await mapWithConcurrency(
    input.playerIds,
    async (playerId) => {
      const response = await getRegularSeasonGameLog(
        playerId,
        input.season,
        true,
      );
      const validation = validateNhlFinalPlayerGameLog({
        gameLog: response.gameLog,
        gameId: input.gameId,
        appeared: true,
      });

      return {
        playerId,
        gameLog: validation.gameLogEntry,
        sourceState: validation.sourceState,
      };
    },
    FINAL_SETTLEMENT_CONCURRENCY,
  );

  results.forEach((result, resultIndex) => {
    if (result.status === 'fulfilled' && result.value.gameLog) {
      entriesByPlayerId.set(result.value.playerId, result.value.gameLog);
    } else if (result.status === 'fulfilled') {
      failures.push({
        playerId: result.value.playerId,
        sourceState: result.value.sourceState,
      });
    } else if (result.status === 'rejected') {
      const playerId = input.playerIds[resultIndex];
      failures.push({
        playerId,
        sourceState: classifyNhlFinalInputFailure(result.reason),
      });
      console.warn('Unable to load canonical final player settlement.', {
        gameId: input.gameId,
        playerId,
        error: result.reason,
      });
    }
  });

  return {
    entriesByPlayerId,
    failures: failures.slice(0, 40),
  };
}

function getPreviousSignalState(
  data: DocumentData | undefined,
): PreviousCanonicalNhlSignalState | null {
  const fantasyEventHash = normalizedString(data?.['fantasyEventHash']);
  const timeOnIceHash = normalizedString(data?.['timeOnIceHash']);
  const gameStateHash = normalizedString(data?.['gameStateHash']);
  const finalSettlementHash = normalizedString(data?.['finalSettlementHash']);

  if (
    !fantasyEventHash ||
    !timeOnIceHash ||
    !gameStateHash ||
    !finalSettlementHash
  ) {
    return null;
  }

  return {
    fantasyEventHash,
    timeOnIceHash,
    lastSignaledTimeOnIceHash:
      normalizedString(data?.['lastSignaledTimeOnIceHash']) || timeOnIceHash,
    gameStateHash,
    finalSettlementHash,
    lastTimeOnIceSettledAtMilliseconds:
      toMilliseconds(data?.['lastTimeOnIceSettledAt']),
  };
}

async function claimFeedLease(runId: string): Promise<{
  claimed: boolean;
  outboxCursorId: string;
}> {
  const reference = getFeedControlRef();
  const now = Date.now();

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const data = snapshot.data() ?? {};
    const status = normalizedString(data['status']);
    const leaseExpiresAt = toMilliseconds(data['leaseExpiresAt']);
    const outboxCursorId = /^\d+_[a-f0-9]{64}$/.test(
      normalizedString(data['outboxCursorId']).toLowerCase(),
    )
      ? normalizedString(data['outboxCursorId']).toLowerCase()
      : '';

    if (status === 'running' && leaseExpiresAt > now) {
      return { claimed: false, outboxCursorId };
    }

    transaction.set(
      reference,
      {
        schemaVersion: FEED_SCHEMA_VERSION,
        status: 'running',
        runId,
        leaseExpiresAt: Timestamp.fromMillis(now + FEED_LEASE_MILLISECONDS),
        lastAttemptAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return { claimed: true, outboxCursorId };
  });
}

function getPickTeamAbbreviation(pick: DraftPick): string {
  return pick.asset.assetType === 'skater'
    ? normalizedString(pick.asset.player.nhlTeamAbbreviation).toUpperCase()
    : normalizedString(pick.asset.teamAbbreviation).toUpperCase();
}

async function loadLeagueImpactPicks(leagueId: string): Promise<{
  picks: DraftPick[];
  cycleNumbers: number[];
}> {
  const activeCycles = await getActiveLeagueCycles(leagueId);

  if (activeCycles.length > 0) {
    const cyclePickGroups = await Promise.all(
      activeCycles.map((cycle) =>
        getCycleRosterPicksOnce(leagueId, cycle.cycleNumber)
      ),
    );

    return {
      picks: cyclePickGroups.flat(),
      cycleNumbers: activeCycles.map((cycle) => cycle.cycleNumber),
    };
  }

  const draftSnapshot = await db
    .collection(`leagues/${leagueId}/draft/current/picks`)
    .orderBy('overallPick', 'asc')
    .get();

  return {
    picks: draftSnapshot.docs.map((document) => document.data() as DraftPick),
    cycleNumbers: [],
  };
}

async function buildLeagueScoringImpact(
  leagueId: string,
): Promise<LeagueScoringImpact> {
  const { picks, cycleNumbers } = await loadLeagueImpactPicks(leagueId);
  const playerIds = [...new Set(
    picks
      .filter((pick) => pick.asset.assetType === 'skater')
      .map((pick) => pick.asset.assetType === 'skater'
        ? pick.asset.player.id
        : 0
      )
      .filter((playerId) =>
        typeof playerId === 'number' && Number.isFinite(playerId) && playerId > 0
      )
      .map((playerId) => Math.trunc(playerId)),
  )].sort((left, right) => left - right)
    .slice(0, IMPACT_INDEX_MAX_PLAYER_IDS);
  const teamAbbreviations = [...new Set(
    picks
      .map((pick) => getPickTeamAbbreviation(pick))
      .filter(Boolean),
  )].sort().slice(0, IMPACT_INDEX_MAX_TEAM_ABBREVIATIONS);
  const sourceCycleNumbers = [...new Set(cycleNumbers)]
    .filter((cycleNumber) => Number.isInteger(cycleNumber) && cycleNumber > 0)
    .sort((left, right) => left - right);
  const sourceHash = canonicalNhlSha256({
    leagueId,
    playerIds,
    teamAbbreviations,
    sourceCycleNumbers,
  });

  await getLeagueImpactRef(leagueId).set(
    {
      schemaVersion: IMPACT_INDEX_SCHEMA_VERSION,
      status: 'ready',
      leagueId,
      playerIds,
      teamAbbreviations,
      sourceCycleNumbers,
      sourceHash,
      pickCount: picks.length,
      builtAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return {
    leagueId,
    playerIds,
    teamAbbreviations,
    sourceCycleNumbers,
    sourceHash,
  };
}

async function buildCanaryImpactIndex(
  leagueIds: readonly string[],
): Promise<{
  impacts: LeagueScoringImpact[];
  complete: boolean;
  failedLeagueIds: string[];
}> {
  const results = await Promise.allSettled(
    leagueIds.map((leagueId) => buildLeagueScoringImpact(leagueId)),
  );
  const impacts: LeagueScoringImpact[] = [];
  const failedLeagueIds: string[] = [];

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      impacts.push(result.value);
      return;
    }

    failedLeagueIds.push(leagueIds[index]);
    console.error('Unable to build a Canary scoring impact index.', {
      leagueId: leagueIds[index],
      error: result.reason,
    });
  });

  await db.doc('appData/leagueAutomationImpactIndex').set(
    {
      schemaVersion: IMPACT_INDEX_SCHEMA_VERSION,
      status: failedLeagueIds.length === 0 ? 'ready' : 'fallback',
      exactCanaryLeagueIds: [...leagueIds],
      indexedLeagueIds: impacts.map((impact) => impact.leagueId).sort(),
      failedLeagueIds: [...failedLeagueIds].sort(),
      complete: failedLeagueIds.length === 0,
      builtAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return {
    impacts,
    complete: failedLeagueIds.length === 0,
    failedLeagueIds,
  };
}

async function observeCanonicalGame(input: {
  game: NhlScoreGame;
  previousData: DocumentData | undefined;
  nowMilliseconds: number;
  finalSettlementPlayerIds: readonly number[];
}): Promise<CanonicalGameObservation> {
  const [boxscore, playByPlay] = await Promise.all([
    getGameBoxscore(input.game.id, 'near-live-canary'),
    getGamePlayByPlay(input.game.id, 'near-live-canary'),
  ]);
  const finalBoxscoreState = validateNhlFinalCanonicalBoxscore(boxscore);
  const finalPlayByPlayState = validateNhlFinalPlayByPlay(playByPlay);
  const finalBaseSourcesComplete =
    finalBoxscoreState.availability === 'available' &&
    finalPlayByPlayState.availability === 'available';
  let facts = buildCanonicalNhlGameFacts({
    scoreboard: {
      gameId: input.game.id,
      gameState: input.game.gameState,
      gameScheduleState: input.game.gameScheduleState,
      period: input.game.periodDescriptor?.number ?? input.game.period,
      periodType: input.game.periodDescriptor?.periodType,
      clockTimeRemaining: input.game.clock?.timeRemaining,
      clockRunning: input.game.clock?.running,
      inIntermission: input.game.clock?.inIntermission,
      startTimeUTC: input.game.startTimeUTC,
      gameDate: input.game.gameDate,
    },
    boxscore,
    playByPlay,
  });
  const previousFacts = getPreviousCanonicalFacts(input.previousData);
  const firstObservedFinalAtMilliseconds = facts.gameState === 'final'
    ? toMilliseconds(input.previousData?.['firstObservedFinalAt']) ||
      input.nowMilliseconds
    : 0;
  let finalSettlementStage = getFinalSettlementStage(input.previousData);
  let finalSettlementFailures: FinalSettlementFailure[] = [];
  const relevantFinalPlayerIds = [...new Set(
    input.finalSettlementPlayerIds
      .filter((playerId) => facts.skaters.some((entry) => entry.playerId === playerId))
      .map((playerId) => Math.trunc(playerId)),
  )].sort((left, right) => left - right);

  if (facts.gameState === 'final') {
    facts = {
      ...facts,
      finalSettlements: previousFacts?.finalSettlements ?? [],
      finalSettlementPlayerIds:
        previousFacts?.finalSettlementPlayerIds ?? [],
    };
    const nextStage = selectNextFinalSettlementStage({
      currentStage: finalSettlementStage,
      elapsedFinalMilliseconds: Math.max(
        0,
        input.nowMilliseconds - firstObservedFinalAtMilliseconds,
      ),
    });

    const unsettledFinalPlayerIds = relevantFinalPlayerIds.filter(
      (playerId) => !facts.finalSettlementPlayerIds.includes(playerId),
    );
    const previousRelevantPlayerIds = Array.isArray(
      input.previousData?.['finalSettlementRelevantPlayerIds'],
    )
      ? input.previousData['finalSettlementRelevantPlayerIds'] as unknown[]
      : [];
    const relevantPlayerSetExpanded = unsettledFinalPlayerIds.some(
      (playerId) => !previousRelevantPlayerIds.includes(playerId),
    );
    const shouldRetryIncompleteSettlement =
      input.previousData?.['finalSettlementComplete'] === false ||
      relevantPlayerSetExpanded;
    const checkpointDue = nextStage > finalSettlementStage;

    if (
      finalBaseSourcesComplete &&
      relevantFinalPlayerIds.length > 0 &&
      (checkpointDue || shouldRetryIncompleteSettlement)
    ) {
      const settlementLoad = await loadFinalSettlementEntries({
        playerIds: relevantFinalPlayerIds,
        gameId: facts.gameId,
        season: getNhlSeasonForGameDate(
          facts.startTimeUTC || facts.gameDate,
        ),
      });

      finalSettlementFailures = settlementLoad.failures;
      facts = applyCanonicalNhlFinalSettlements({
        facts,
        entriesByPlayerId: settlementLoad.entriesByPlayerId,
      });
    }

    const finalSettlementComplete = finalBaseSourcesComplete &&
      finalSettlementFailures.length === 0 &&
      relevantFinalPlayerIds.every((playerId) =>
        facts.finalSettlementPlayerIds.includes(playerId)
      );

    if (nextStage > finalSettlementStage && finalSettlementComplete) {
      finalSettlementStage = nextStage;
    }
  } else {
    finalSettlementStage = 0;
  }

  const hashes = buildCanonicalNhlGameHashes(facts);
  const previous = getPreviousSignalState(input.previousData);
  const decision = decideCanonicalNhlGameChange({
    previous,
    current: hashes,
    currentGameState: facts.gameState,
    nowMilliseconds: input.nowMilliseconds,
  });
  const lastSignaledTimeOnIceHash = decision.shouldSignal || !previous
    ? hashes.timeOnIceHash
    : previous.lastSignaledTimeOnIceHash;
  const lastTimeOnIceSettledAtMilliseconds = decision.shouldSignal || !previous
    ? input.nowMilliseconds
    : previous.lastTimeOnIceSettledAtMilliseconds;
  const finalSettlementComplete = facts.gameState === 'final' &&
    finalBaseSourcesComplete &&
    finalSettlementFailures.length === 0 &&
    relevantFinalPlayerIds.every((playerId) =>
      facts.finalSettlementPlayerIds.includes(playerId)
    );
  const finalPlayerLogState: NhlFinalInputSourceState = finalSettlementComplete
    ? { availability: 'available' }
    : finalSettlementFailures.some(
        (failure) => failure.sourceState.availability === 'malformed',
      )
      ? {
          availability: 'malformed',
          detail: 'One or more required canonical final player logs were malformed.',
        }
      : {
          availability: 'temporarily-unavailable',
          detail: 'One or more required canonical final player logs are unavailable.',
        };
  const finalInputCompletenessByAssetType = facts.gameState === 'final'
    ? {
        skater: assessNhlFinalInputCompleteness({
          assetType: 'skater',
          boxscore: finalBoxscoreState,
          playByPlay: finalPlayByPlayState,
          playerLog: finalPlayerLogState,
          sourceVersion: hashes.sourceVersion,
        }),
        teamGoalieUnit: assessNhlFinalInputCompleteness({
          assetType: 'team-goalie-unit',
          boxscore: finalBoxscoreState,
          playByPlay: { availability: 'not-required' },
          playerLog: { availability: 'not-required' },
          sourceVersion: hashes.sourceVersion,
        }),
      }
    : {};
  const payload = {
    schemaVersion: CANONICAL_NHL_FACTS_SCHEMA_VERSION,
    gameId: facts.gameId,
    facts,
    ...hashes,
    finalSettlementStage,
    finalSettlementRelevantPlayerIds: relevantFinalPlayerIds,
    finalSettlementComplete,
    finalSettlementMissingPlayerIds: relevantFinalPlayerIds
      .filter((playerId) => !facts.finalSettlementPlayerIds.includes(playerId))
      .slice(0, 40),
    finalSettlementFailureReasons: finalSettlementFailures.map((failure) => ({
      playerId: failure.playerId,
      availability: failure.sourceState.availability,
      detail: (failure.sourceState.detail ?? 'Final player log unavailable.')
        .slice(0, 180),
    })),
    finalInputCompletenessByAssetType,
    lastSignaledTimeOnIceHash,
    timeOnIceDirty: decision.timeOnIceDirty,
    nextTimeOnIceSettlementAt:
      decision.nextTimeOnIceSettlementAtMilliseconds
        ? Timestamp.fromMillis(decision.nextTimeOnIceSettlementAtMilliseconds)
        : null,
    lastTimeOnIceSettledAt: Timestamp.fromMillis(
      Math.max(0, lastTimeOnIceSettledAtMilliseconds),
    ),
    firstObservedFinalAt: firstObservedFinalAtMilliseconds > 0
      ? Timestamp.fromMillis(firstObservedFinalAtMilliseconds)
      : null,
    lastChangeKind: decision.kind,
    lastShouldSignal: decision.shouldSignal,
    sourceObservedAt: Timestamp.fromMillis(input.nowMilliseconds),
    updatedAt: FieldValue.serverTimestamp(),
    ...(!input.previousData
      ? { createdAt: FieldValue.serverTimestamp() }
      : {}),
  };
  const payloadBytes = Buffer.byteLength(JSON.stringify({
    ...payload,
    updatedAt: null,
    createdAt: null,
  }));

  if (payloadBytes > FEED_MAX_CANONICAL_DOCUMENT_BYTES) {
    throw new Error(`canonical-game-document-too-large:${facts.gameId}:${payloadBytes}`);
  }

  await persistCanonicalPublicationWithOutbox({
    firestore: db,
    gameId: facts.gameId,
    sourceVersion: hashes.sourceVersion,
    changeKind: decision.kind,
    shouldSignal: decision.shouldSignal,
    affectedPlayerIds: facts.playerIds,
    affectedTeamAbbreviations: facts.teamAbbreviations,
    observedAtMilliseconds: input.nowMilliseconds,
    expectedSourceVersion: normalizedString(
      input.previousData?.['sourceVersion'],
    ).toLowerCase(),
    canonicalPayload: payload,
  });

  return {
    gameId: facts.gameId,
    sourceVersion: hashes.sourceVersion,
    changeKind: decision.kind,
    shouldSignal: decision.shouldSignal,
    affectedPlayerIds: facts.playerIds,
    affectedTeamAbbreviations: facts.teamAbbreviations,
  };
}

async function mapWithConcurrency<TValue, TResult>(
  values: readonly TValue[],
  worker: (value: TValue) => Promise<TResult>,
  concurrency: number,
): Promise<Array<PromiseSettledResult<TResult>>> {
  const results: Array<PromiseSettledResult<TResult>> = [];
  let nextIndex = 0;

  async function consume(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;

      try {
        results[index] = {
          status: 'fulfilled',
          value: await worker(values[index]),
        };
      } catch (reason: unknown) {
        results[index] = { status: 'rejected', reason };
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

async function deliverPendingCanonicalPublications(input: {
  exactCanaryLeagueIds: readonly string[];
  impacts: readonly LeagueScoringImpact[];
  impactIndexComplete: boolean;
  afterOutboxId: string;
}): Promise<{
  loadedOutboxCount: number;
  deliveredOutboxCount: number;
  failedOutboxCount: number;
  requestedLeagueCount: number;
  coalescedLeagueCount: number;
  nextOutboxCursorId: string;
}> {
  const outboxBatch = await loadPendingCanonicalPublicationOutbox({
    firestore: db,
    limit: CANONICAL_OUTBOX_DRAIN_LIMIT,
    afterId: input.afterOutboxId,
  });
  const entries = outboxBatch.entries;
  let deliveredOutboxCount = 0;
  let failedOutboxCount = 0;
  let requestedLeagueCount = 0;
  let coalescedLeagueCount = 0;

  for (const entry of entries) {
    try {
      const currentCanonicalSnapshot = await getCanonicalGameRef(entry.gameId).get();
      const currentSourceVersion = normalizedString(
        currentCanonicalSnapshot.data()?.['sourceVersion'],
      ).toLowerCase();

      if (!currentSourceVersion) {
        throw new Error('canonical-outbox-source-document-missing');
      }

      if (currentSourceVersion !== entry.sourceVersion) {
        await markCanonicalPublicationOutboxDelivered({
          firestore: db,
          entry,
          leagueIds: [],
          outcome: 'superseded',
        });
        deliveredOutboxCount += 1;
        continue;
      }

      const leagueIds = selectAffectedCanonicalLeagueIds({
        affectedPlayerIds: entry.affectedPlayerIds,
        affectedTeamAbbreviations: entry.affectedTeamAbbreviations,
        exactCanaryLeagueIds: input.exactCanaryLeagueIds,
        impacts: input.impacts,
        impactIndexComplete: input.impactIndexComplete,
      });

      for (const leagueId of leagueIds) {
        const gameVersions = [{
          gameId: entry.gameId,
          sourceVersion: entry.sourceVersion,
        }];
        const sourceVersion = canonicalNhlSha256({
          schemaVersion: CANONICAL_NHL_FACTS_SCHEMA_VERSION,
          leagueId,
          gameVersions: gameVersions.map((game) => game.sourceVersion).sort(),
        });
        const outcome = await requestLeagueAutomationForCanonicalChange({
          leagueId,
          sourceVersion,
          observedAtMilliseconds: entry.observedAtMilliseconds,
          gameIds: [entry.gameId],
          gameVersions,
          changeKinds: [entry.changeKind],
        });

        if (outcome === 'ineligible') {
          throw new Error(`canonical-outbox-league-became-ineligible:${leagueId}`);
        }

        if (outcome === 'requested') {
          requestedLeagueCount += 1;
        } else {
          coalescedLeagueCount += 1;
        }
      }

      await markCanonicalPublicationOutboxDelivered({
        firestore: db,
        entry,
        leagueIds,
        outcome: leagueIds.length > 0 ? 'delivered' : 'no-targets',
      });
      deliveredOutboxCount += 1;
    } catch (error: unknown) {
      failedOutboxCount += 1;
      await recordCanonicalPublicationOutboxFailure({
        firestore: db,
        entry,
        error,
      }).catch((recordError: unknown) => {
        console.error('Unable to record canonical publication outbox failure.', {
          outboxId: entry.id,
          recordError,
        });
      });
      console.error('Unable to deliver a pending canonical publication.', {
        outboxId: entry.id,
        gameId: entry.gameId,
        sourceVersion: entry.sourceVersion,
        error,
      });
    }
  }

  return {
    loadedOutboxCount: entries.length,
    deliveredOutboxCount,
    failedOutboxCount,
    requestedLeagueCount,
    coalescedLeagueCount,
    nextOutboxCursorId: outboxBatch.nextCursorId,
  };
}

async function recordFeedSuccess(input: {
  runId: string;
  startedAt: number;
  queueMode: string;
  exactCanaryLeagueIds: readonly string[];
  gameCount: number;
  signalCount: number;
  requestedLeagueCount: number;
  coalescedLeagueCount: number;
  outboxLoadedCount: number;
  outboxDeliveredCount: number;
  outboxFailedCount: number;
  outboxCursorId: string;
  failedGameCount: number;
  impactIndexComplete: boolean;
  impactIndexFallbackCount: number;
}): Promise<void> {
  await getFeedControlRef().set(
    {
      schemaVersion: FEED_SCHEMA_VERSION,
      status: 'success',
      runId: input.runId,
      leaseExpiresAt: FieldValue.delete(),
      queueMode: input.queueMode,
      exactCanaryLeagueIds: [...input.exactCanaryLeagueIds],
      observedGameCount: input.gameCount,
      signaledGameCount: input.signalCount,
      requestedLeagueCount: input.requestedLeagueCount,
      coalescedLeagueCount: input.coalescedLeagueCount,
      outboxLoadedCount: input.outboxLoadedCount,
      outboxDeliveredCount: input.outboxDeliveredCount,
      outboxFailedCount: input.outboxFailedCount,
      outboxCursorId: input.outboxCursorId || null,
      outboxStatus: input.outboxFailedCount > 0 ? 'pending-retry' : 'drained',
      failedGameCount: input.failedGameCount,
      impactIndexComplete: input.impactIndexComplete,
      impactIndexFallbackCount: input.impactIndexFallbackCount,
      timeOnIceSettlementIntervalMilliseconds:
        CANONICAL_NHL_TOI_SETTLEMENT_INTERVAL_MILLISECONDS,
      finalReconciliationMilliseconds:
        CANONICAL_NHL_FINAL_RECONCILIATION_MILLISECONDS,
      lastDurationMilliseconds: Date.now() - input.startedAt,
      lastSuccessfulAt: FieldValue.serverTimestamp(),
      consecutiveFailureCount: 0,
      lastErrorCode: '',
      lastError: '',
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

async function recordFeedFailure(
  runId: string,
  startedAt: number,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error
    ? error.message
    : 'Canonical NHL impact feed failed.';

  await getFeedControlRef().set(
    {
      schemaVersion: FEED_SCHEMA_VERSION,
      status: 'error',
      runId,
      leaseExpiresAt: FieldValue.delete(),
      lastDurationMilliseconds: Date.now() - startedAt,
      lastFailedAt: FieldValue.serverTimestamp(),
      consecutiveFailureCount: FieldValue.increment(1),
      lastErrorCode: message
        .replace(/[^A-Za-z0-9:_-]/g, '-')
        .slice(0, 80),
      lastError: message.slice(0, 500),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

export const pollCanonicalNhlImpactFeed = onSchedule(
  {
    schedule: 'every 2 minutes',
    region: FUNCTION_REGION,
    timeoutSeconds: 120,
    memory: '1GiB',
    retryCount: 0,
    maxInstances: 1,
  },
  async () => {
    const runId = randomUUID().replaceAll('-', '');
    const startedAt = Date.now();
    const lease = await claimFeedLease(runId);

    if (!lease.claimed) {
      return;
    }

    try {
      const [scope, scoreboard] = await Promise.all([
        getLeagueAutomationCanonicalCanaryScope(),
        getNhlScoreNow(true),
      ]);
      const exactCanaryLeagueIds = scope.valid
        ? scope.eligibleLeagueIds
        : [];
      const impactIndex = await buildCanaryImpactIndex(exactCanaryLeagueIds);
      const games = (scoreboard.games ?? [])
        .filter((game) =>
          Number.isFinite(game.id) &&
          game.id > 0 &&
          (isLiveScoreboardGame(game) || isFinalScoreboardGame(game))
        )
        .slice(0, FEED_MAX_GAME_COUNT);
      const canonicalRefs = games.map((game) => getCanonicalGameRef(game.id));
      const previousSnapshots = canonicalRefs.length > 0
        ? await db.getAll(...canonicalRefs)
        : [];
      const previousByGameId = new Map(
        previousSnapshots.map((snapshot) => [
          Number(snapshot.id),
          snapshot.data(),
        ]),
      );
      const eligibleGames = games.filter((game) => {
        if (isLiveScoreboardGame(game)) {
          return true;
        }

        const previous = previousByGameId.get(game.id);
        const firstObservedFinalAt = toMilliseconds(
          previous?.['firstObservedFinalAt'],
        );
        const finalInputIncomplete = previous?.['finalSettlementComplete'] === false;

        return firstObservedFinalAt <= 0 ||
          finalInputIncomplete ||
          startedAt - firstObservedFinalAt <=
            CANONICAL_NHL_FINAL_RECONCILIATION_MILLISECONDS;
      });
      const finalSettlementPlayerIds = [...new Set(
        impactIndex.impacts.flatMap((impact) => impact.playerIds),
      )].sort((left, right) => left - right);
      const observationResults = await mapWithConcurrency(
        eligibleGames,
        (game) => observeCanonicalGame({
          game,
          previousData: previousByGameId.get(game.id),
          nowMilliseconds: startedAt,
          finalSettlementPlayerIds,
        }),
        FEED_GAME_CONCURRENCY,
      );
      const observations = observationResults
        .filter((result): result is PromiseFulfilledResult<CanonicalGameObservation> =>
          result.status === 'fulfilled'
        )
        .map((result) => result.value);
      const failedGameCount = observationResults.filter(
        (result) => result.status === 'rejected',
      ).length;

      for (const result of observationResults) {
        if (result.status === 'rejected') {
          console.error('Unable to observe canonical NHL game facts.', result.reason);
        }
      }

      const outboxDelivery = await deliverPendingCanonicalPublications({
        exactCanaryLeagueIds,
        impacts: impactIndex.impacts,
        impactIndexComplete: impactIndex.complete,
        afterOutboxId: lease.outboxCursorId,
      });

      await recordFeedSuccess({
        runId,
        startedAt,
        queueMode: scope.mode,
        exactCanaryLeagueIds,
        gameCount: observations.length,
        signalCount: observations.filter((entry) => entry.shouldSignal).length,
        requestedLeagueCount: outboxDelivery.requestedLeagueCount,
        coalescedLeagueCount: outboxDelivery.coalescedLeagueCount,
        outboxLoadedCount: outboxDelivery.loadedOutboxCount,
        outboxDeliveredCount: outboxDelivery.deliveredOutboxCount,
        outboxFailedCount: outboxDelivery.failedOutboxCount,
        outboxCursorId: outboxDelivery.nextOutboxCursorId,
        failedGameCount,
        impactIndexComplete: impactIndex.complete,
        impactIndexFallbackCount: impactIndex.failedLeagueIds.length,
      });
    } catch (error: unknown) {
      await recordFeedFailure(runId, startedAt, error);
      console.error('Canonical NHL impact feed failed.', error);
    }
  },
);
