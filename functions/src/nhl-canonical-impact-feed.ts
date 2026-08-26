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
  buildCanonicalNhlGameFacts,
  buildCanonicalNhlGameHashes,
  CANONICAL_NHL_FACTS_SCHEMA_VERSION,
  CANONICAL_NHL_FINAL_RECONCILIATION_MILLISECONDS,
  CANONICAL_NHL_TOI_SETTLEMENT_INTERVAL_MILLISECONDS,
  canonicalNhlSha256,
  CanonicalNhlChangeKind,
  decideCanonicalNhlGameChange,
  PreviousCanonicalNhlSignalState,
} from './shared/core/nhl/nhl-canonical-facts.util';
import {
  getGameBoxscore,
  getGamePlayByPlay,
  getNhlScoreNow,
  NhlScoreGame,
} from './shared/core/nhl/nhl-api.service';

const FUNCTION_REGION = 'us-central1';
const FEED_SCHEMA_VERSION = 1;
const FEED_LEASE_MILLISECONDS = 100 * 1000;
const FEED_GAME_CONCURRENCY = 4;
const FEED_MAX_GAME_COUNT = 20;
const FEED_MAX_CANONICAL_DOCUMENT_BYTES = 650 * 1024;
const IMPACT_INDEX_SCHEMA_VERSION = 1;
const IMPACT_INDEX_MAX_PLAYER_IDS = 700;
const IMPACT_INDEX_MAX_TEAM_ABBREVIATIONS = 40;

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

interface LeagueChangeRequest {
  leagueId: string;
  gameIds: number[];
  changeKinds: string[];
  sourceVersions: string[];
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

async function claimFeedLease(runId: string): Promise<boolean> {
  const reference = getFeedControlRef();
  const now = Date.now();

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const data = snapshot.data() ?? {};
    const status = normalizedString(data['status']);
    const leaseExpiresAt = toMilliseconds(data['leaseExpiresAt']);

    if (status === 'running' && leaseExpiresAt > now) {
      return false;
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

    return true;
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

function getAffectedLeagueIds(input: {
  observation: CanonicalGameObservation;
  exactCanaryLeagueIds: readonly string[];
  impacts: readonly LeagueScoringImpact[];
  impactIndexComplete: boolean;
}): string[] {
  if (!input.impactIndexComplete) {
    return [...input.exactCanaryLeagueIds];
  }

  const playerIds = new Set(input.observation.affectedPlayerIds);
  const teams = new Set(input.observation.affectedTeamAbbreviations);

  return input.impacts
    .filter((impact) =>
      impact.teamAbbreviations.some((team) => teams.has(team)) ||
      impact.playerIds.some((playerId) => playerIds.has(playerId))
    )
    .map((impact) => impact.leagueId)
    .sort();
}

async function observeCanonicalGame(input: {
  game: NhlScoreGame;
  previousData: DocumentData | undefined;
  nowMilliseconds: number;
}): Promise<CanonicalGameObservation> {
  const [boxscore, playByPlay] = await Promise.all([
    getGameBoxscore(input.game.id, 'near-live-canary'),
    getGamePlayByPlay(input.game.id, 'near-live-canary'),
  ]);
  const facts = buildCanonicalNhlGameFacts({
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
  const firstObservedFinalAtMilliseconds = facts.gameState === 'final'
    ? toMilliseconds(input.previousData?.['firstObservedFinalAt']) ||
      input.nowMilliseconds
    : 0;
  const payload = {
    schemaVersion: CANONICAL_NHL_FACTS_SCHEMA_VERSION,
    gameId: facts.gameId,
    facts,
    ...hashes,
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

  await getCanonicalGameRef(facts.gameId).set(payload, { merge: true });

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

function buildLeagueChangeRequests(input: {
  observations: readonly CanonicalGameObservation[];
  exactCanaryLeagueIds: readonly string[];
  impacts: readonly LeagueScoringImpact[];
  impactIndexComplete: boolean;
}): LeagueChangeRequest[] {
  const byLeague = new Map<string, LeagueChangeRequest>();

  for (const observation of input.observations) {
    if (!observation.shouldSignal) {
      continue;
    }

    const leagueIds = getAffectedLeagueIds({
      observation,
      exactCanaryLeagueIds: input.exactCanaryLeagueIds,
      impacts: input.impacts,
      impactIndexComplete: input.impactIndexComplete,
    });

    for (const leagueId of leagueIds) {
      const existing = byLeague.get(leagueId) ?? {
        leagueId,
        gameIds: [],
        changeKinds: [],
        sourceVersions: [],
      };

      existing.gameIds.push(observation.gameId);
      existing.changeKinds.push(observation.changeKind);
      existing.sourceVersions.push(observation.sourceVersion);
      byLeague.set(leagueId, existing);
    }
  }

  return [...byLeague.values()]
    .map((request) => ({
      leagueId: request.leagueId,
      gameIds: [...new Set(request.gameIds)].sort((left, right) => left - right),
      changeKinds: [...new Set(request.changeKinds)].sort(),
      sourceVersions: [...new Set(request.sourceVersions)].sort(),
    }))
    .sort((left, right) => left.leagueId.localeCompare(right.leagueId));
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
    const claimed = await claimFeedLease(runId);

    if (!claimed) {
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

        return firstObservedFinalAt <= 0 ||
          startedAt - firstObservedFinalAt <=
            CANONICAL_NHL_FINAL_RECONCILIATION_MILLISECONDS;
      });
      const observationResults = await mapWithConcurrency(
        eligibleGames,
        (game) => observeCanonicalGame({
          game,
          previousData: previousByGameId.get(game.id),
          nowMilliseconds: startedAt,
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

      const requests = buildLeagueChangeRequests({
        observations,
        exactCanaryLeagueIds,
        impacts: impactIndex.impacts,
        impactIndexComplete: impactIndex.complete,
      });
      let requestedLeagueCount = 0;
      let coalescedLeagueCount = 0;

      for (const request of requests) {
        const sourceVersion = canonicalNhlSha256({
          schemaVersion: CANONICAL_NHL_FACTS_SCHEMA_VERSION,
          leagueId: request.leagueId,
          gameVersions: request.sourceVersions,
        });
        const outcome = await requestLeagueAutomationForCanonicalChange({
          leagueId: request.leagueId,
          sourceVersion,
          observedAtMilliseconds: startedAt,
          gameIds: request.gameIds,
          changeKinds: request.changeKinds,
        });

        if (outcome === 'requested') {
          requestedLeagueCount += 1;
        } else if (outcome === 'coalesced') {
          coalescedLeagueCount += 1;
        }
      }

      await recordFeedSuccess({
        runId,
        startedAt,
        queueMode: scope.mode,
        exactCanaryLeagueIds,
        gameCount: observations.length,
        signalCount: observations.filter((entry) => entry.shouldSignal).length,
        requestedLeagueCount,
        coalescedLeagueCount,
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
