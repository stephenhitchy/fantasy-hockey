import {
  doc,
  getDoc,
  increment,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
} from 'firebase/firestore';
import { onAuthStateChanged, User } from 'firebase/auth';

import { auth, db } from '../firebase';
import { calculateCycleScoring, CycleScoringResult } from '../cycle/cycle-scoring.service';
import {
  advanceCompletedRegularSeasonAssetWindows,
  completeCycle,
  getActiveLeagueCycles,
  getCycleMatchupsOnce,
  getCycleRosterPicksOnce,
  reconcileRegularSeasonCycleMatchupCompletion,
  startNextCycle,
  updateCycleMatchupScores,
} from '../cycle/cycle.service';
import { syncCycleTeamWindows } from '../cycle/asset-cycle-window.service';
import { FantasyCycle } from '../cycle/cycle.models';
import { getScoringReferenceDate } from '../cycle/cycle-runtime.config';
import { DraftPick } from '../draft/draft.models';
import { getLeagueById, League } from '../league/league.service';
import { getFantasyPlayoffs } from '../playoffs/playoff.service';
import {
  ensureNextPlayoffBankWindows,
  syncPlayoffWindowBankScores,
} from '../playoffs/playoff-window-bank.service';
import { defaultScoringRules } from '../scoring/scoring-rules';
import { FantasyTeam, getLeagueTeams } from '../team/team.service';
import {
  LocalLiveScoringSessionInfo,
  SharedCycleScoringSnapshot,
  SharedLiveScoringControl,
  SharedLiveScoringRefreshReason,
} from './live-scoring.models';

const LIVE_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const NEAR_GAME_REFRESH_MAX_MS = 60 * 60 * 1000;
const IDLE_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RAPID_TRANSITION_REFRESH_MS = 7_500;
const ERROR_RETRY_INTERVAL_MS = 5 * 60 * 1000;
const LEASE_DURATION_MS = 15 * 60 * 1000;
const CLAIM_JITTER_MS = 1_500;
const HANDOFF_PAUSE_MS = 20 * 60 * 1000;

interface CachedCycleContext {
  key: string;
  picks: DraftPick[];
}

interface LiveScoringSession {
  leagueId: string;
  clientId: string;
  stopped: boolean;
  refreshInProgress: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  stopControlListener: (() => void) | null;
  control: SharedLiveScoringControl | null;
  league: League | null;
  teams: FantasyTeam[];
  cycleContexts: Map<number, CachedCycleContext>;
  previousSnapshots: Map<number, SharedCycleScoringSnapshot | null>;
  pausedUntil: number;
  nextRefreshReason: SharedLiveScoringRefreshReason;
}

const sessions = new Map<string, LiveScoringSession>();

function waitForAuthUser(): Promise<User | null> {
  if (auth.currentUser) {
    return Promise.resolve(auth.currentUser);
  }

  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

let pageClientId = '';

function getClientId(): string {
  if (pageClientId) {
    return pageClientId;
  }

  pageClientId =
    typeof crypto?.randomUUID === 'function'
      ? crypto.randomUUID()
      : `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return pageClientId;
}

function getControlRef(leagueId: string) {
  return doc(db, 'leagues', leagueId, 'liveScoring', 'control');
}

function getCycleSnapshotRef(leagueId: string, cycleNumber: number) {
  return doc(db, 'leagues', leagueId, 'liveScoring', `cycle-${cycleNumber}`);
}

function toMillis(value: unknown): number | null {
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

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function canClaimLiveScoringLease(
  control: SharedLiveScoringControl | null,
  requesterClientId: string,
  nowMilliseconds: number,
): boolean {
  const nextRefreshAt = toMillis(control?.nextRefreshAt) ?? 0;
  const leaseExpiresAt = toMillis(control?.leaseExpiresAt) ?? 0;
  const otherLeaseIsActive =
    leaseExpiresAt > nowMilliseconds && control?.holderClientId !== requesterClientId;

  return nextRefreshAt <= nowMilliseconds && !otherLeaseIsActive;
}

export function shouldPublishSharedScoringSnapshot(
  previousFingerprint: string | null | undefined,
  nextFingerprint: string,
): boolean {
  return previousFingerprint !== nextFingerprint;
}

function normalizeControl(
  value: Partial<SharedLiveScoringControl> | null,
): SharedLiveScoringControl | null {
  if (!value) {
    return null;
  }

  return {
    id: 'control',
    schemaVersion: 1,
    automationMode:
      typeof value.automationMode === 'string' ? value.automationMode : 'server',
    historicalReplayEnabled: value.historicalReplayEnabled === true,
    historicalReplayDate:
      typeof value.historicalReplayDate === 'string' ? value.historicalReplayDate : null,
    status:
      value.status === 'refreshing' ? 'refreshing' : value.status === 'error' ? 'error' : 'idle',
    holderUserId: typeof value.holderUserId === 'string' ? value.holderUserId : null,
    holderClientId: typeof value.holderClientId === 'string' ? value.holderClientId : null,
    leaseExpiresAt: value.leaseExpiresAt ?? null,
    nextRefreshAt: value.nextRefreshAt ?? null,
    lastRefreshStartedAt: value.lastRefreshStartedAt ?? null,
    lastRefreshCompletedAt: value.lastRefreshCompletedAt ?? null,
    refreshRequestedAt: value.refreshRequestedAt ?? null,
    activeCycleNumbers: Array.isArray(value.activeCycleNumbers)
      ? value.activeCycleNumbers.filter(
          (entry): entry is number => typeof entry === 'number' && Number.isFinite(entry),
        )
      : [],
    lastError: typeof value.lastError === 'string' ? value.lastError : '',
    lastRefreshReason:
      value.lastRefreshReason === 'startup' ||
      value.lastRefreshReason === 'scheduled' ||
      value.lastRefreshReason === 'manual' ||
      value.lastRefreshReason === 'handoff'
        ? value.lastRefreshReason
        : 'unknown',
    lastRefreshDurationMs:
      typeof value.lastRefreshDurationMs === 'number' ? value.lastRefreshDurationMs : 0,
    lastPublishedSnapshotCount:
      typeof value.lastPublishedSnapshotCount === 'number' ? value.lastPublishedSnapshotCount : 0,
    lastSkippedSnapshotWriteCount:
      typeof value.lastSkippedSnapshotWriteCount === 'number'
        ? value.lastSkippedSnapshotWriteCount
        : 0,
    totalSuccessfulRefreshCount:
      typeof value.totalSuccessfulRefreshCount === 'number' ? value.totalSuccessfulRefreshCount : 0,
    totalFailedRefreshCount:
      typeof value.totalFailedRefreshCount === 'number' ? value.totalFailedRefreshCount : 0,
    totalPublishedSnapshotCount:
      typeof value.totalPublishedSnapshotCount === 'number' ? value.totalPublishedSnapshotCount : 0,
    totalSkippedSnapshotWriteCount:
      typeof value.totalSkippedSnapshotWriteCount === 'number'
        ? value.totalSkippedSnapshotWriteCount
        : 0,
    updatedAt: value.updatedAt,
  };
}

function normalizeSnapshot(
  value: Partial<SharedCycleScoringSnapshot>,
  leagueId: string,
  cycleNumber: number,
): SharedCycleScoringSnapshot | null {
  if (!value.result || typeof value.scoringFingerprint !== 'string') {
    return null;
  }

  return {
    id: value.id ?? `cycle-${cycleNumber}`,
    schemaVersion: 1,
    leagueId: value.leagueId ?? leagueId,
    cycleNumber: value.cycleNumber ?? cycleNumber,
    season: value.season ?? '',
    scoringFingerprint: value.scoringFingerprint,
    scoringRulesFingerprint:
      typeof value.scoringRulesFingerprint === 'string' ? value.scoringRulesFingerprint : '',
    result: value.result,
    workerUserId: value.workerUserId ?? '',
    workerClientId: value.workerClientId ?? '',
    refreshedAt: value.refreshedAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function getNhlSeasonForDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const seasonStartYear = month >= 7 ? year : year - 1;

  return `${seasonStartYear}${seasonStartYear + 1}`;
}

function getScoringSeason(): string {
  return getNhlSeasonForDate(getScoringReferenceDate());
}

function getCycleContextKey(cycle: FantasyCycle): string {
  return [
    cycle.id,
    cycle.cycleNumber,
    cycle.phase,
    cycle.activeWindowCount ?? 0,
    cycle.totalExpectedWindowCount ?? 0,
    Object.entries(cycle.expectedRosterSlotIdsByOwner ?? {})
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([ownerId, slots]) => `${ownerId}:${slots.join(',')}`)
      .join('|'),
  ].join('::');
}

function scheduleSessionAttempt(session: LiveScoringSession, delayMilliseconds: number): void {
  if (session.stopped) {
    return;
  }

  if (session.timer) {
    clearTimeout(session.timer);
  }

  session.timer = setTimeout(
    () => {
      session.timer = null;
      void attemptSharedRefresh(session);
    },
    Math.max(250, delayMilliseconds),
  );
}

function getNextAttemptDelay(
  session: LiveScoringSession,
  control: SharedLiveScoringControl | null,
): number {
  if (!control) {
    return Math.floor(Math.random() * CLAIM_JITTER_MS) + 250;
  }

  const now = Date.now();
  const nextRefreshAt = toMillis(control.nextRefreshAt) ?? 0;
  const leaseExpiresAt = toMillis(control.leaseExpiresAt) ?? 0;

  if (nextRefreshAt > now) {
    return nextRefreshAt - now + Math.floor(Math.random() * CLAIM_JITTER_MS);
  }

  if (leaseExpiresAt > now && control.holderClientId !== session.clientId) {
    return leaseExpiresAt - now + Math.floor(Math.random() * CLAIM_JITTER_MS);
  }

  return Math.floor(Math.random() * CLAIM_JITTER_MS) + 250;
}

async function claimRefreshLease(session: LiveScoringSession, user: User): Promise<boolean> {
  const controlRef = getControlRef(session.leagueId);
  const now = Date.now();

  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(controlRef);
    const current = snapshot.exists()
      ? normalizeControl(snapshot.data() as Partial<SharedLiveScoringControl>)
      : null;
    if (!canClaimLiveScoringLease(current, session.clientId, now)) {
      return false;
    }

    transaction.set(
      controlRef,
      {
        id: 'control',
        schemaVersion: 1,
        status: 'refreshing',
        holderUserId: user.uid,
        holderClientId: session.clientId,
        leaseExpiresAt: Timestamp.fromMillis(now + LEASE_DURATION_MS),
        lastRefreshStartedAt: serverTimestamp(),
        lastRefreshReason: session.nextRefreshReason,
        activeCycleNumbers: current?.activeCycleNumbers ?? [],
        lastError: '',
        updatedAt: serverTimestamp(),
        ...(snapshot.exists()
          ? {}
          : {
              nextRefreshAt: Timestamp.fromMillis(now),
              lastRefreshCompletedAt: null,
            }),
      },
      { merge: true },
    );

    return true;
  });
}

async function getCyclePicks(
  session: LiveScoringSession,
  cycle: FantasyCycle,
): Promise<DraftPick[]> {
  const key = getCycleContextKey(cycle);
  const cached = session.cycleContexts.get(cycle.cycleNumber);

  if (cached?.key === key) {
    return cached.picks;
  }

  const picks = await getCycleRosterPicksOnce(session.leagueId, cycle.cycleNumber);

  session.cycleContexts.set(cycle.cycleNumber, {
    key,
    picks,
  });

  return picks;
}

async function getPreviousSnapshot(
  session: LiveScoringSession,
  cycleNumber: number,
): Promise<SharedCycleScoringSnapshot | null> {
  if (session.previousSnapshots.has(cycleNumber)) {
    return session.previousSnapshots.get(cycleNumber) ?? null;
  }

  const snapshot = await getDoc(getCycleSnapshotRef(session.leagueId, cycleNumber));
  const normalized = snapshot.exists()
    ? normalizeSnapshot(
        snapshot.data() as Partial<SharedCycleScoringSnapshot>,
        session.leagueId,
        cycleNumber,
      )
    : null;

  session.previousSnapshots.set(cycleNumber, normalized);
  return normalized;
}

interface PublishCycleSnapshotResult {
  snapshot: SharedCycleScoringSnapshot;
  wrote: boolean;
}

async function publishCycleSnapshot(
  session: LiveScoringSession,
  user: User,
  cycle: FantasyCycle,
  season: string,
  result: CycleScoringResult,
  scoringRulesFingerprint: string,
  previous: SharedCycleScoringSnapshot | null,
): Promise<PublishCycleSnapshotResult> {
  const scoringFingerprint = `${scoringRulesFingerprint}::${result.dataFingerprint}`;

  if (!shouldPublishSharedScoringSnapshot(previous?.scoringFingerprint, scoringFingerprint)) {
    return {
      snapshot: {
        ...previous!,
        result,
      },
      wrote: false,
    };
  }

  const snapshot: SharedCycleScoringSnapshot = {
    id: `cycle-${cycle.cycleNumber}`,
    schemaVersion: 1,
    leagueId: session.leagueId,
    cycleNumber: cycle.cycleNumber,
    season,
    scoringFingerprint,
    scoringRulesFingerprint,
    result,
    workerUserId: user.uid,
    workerClientId: session.clientId,
  };

  await setDoc(getCycleSnapshotRef(session.leagueId, cycle.cycleNumber), {
    ...snapshot,
    refreshedAt: serverTimestamp(),
    createdAt: previous?.createdAt ?? serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  return {
    snapshot,
    wrote: true,
  };
}

function allCycleTeamsComplete(result: CycleScoringResult): boolean {
  const values = Object.values(result.teamCycleComplete);
  return values.length > 0 && values.every(Boolean);
}

async function persistCommissionerScoring(
  session: LiveScoringSession,
  cycle: FantasyCycle,
  picks: DraftPick[],
  result: CycleScoringResult,
  season: string,
  scoringRules: NonNullable<League['scoringRules']>,
): Promise<boolean> {
  const matchups = await getCycleMatchupsOnce(session.leagueId, cycle.cycleNumber);

  await syncCycleTeamWindows(session.leagueId, cycle, picks, result);

  if (matchups.length > 0) {
    await updateCycleMatchupScores(
      session.leagueId,
      cycle.cycleNumber,
      matchups,
      result.teamScores,
    );
  }

  if (cycle.phase === 'regular_season') {
    const completion = await reconcileRegularSeasonCycleMatchupCompletion(
      session.leagueId,
      cycle.cycleNumber,
    );

    await advanceCompletedRegularSeasonAssetWindows(
      session.leagueId,
      session.teams,
      cycle,
      picks,
      result,
    );

    if (completion.cycleCompleted) {
      await startNextCycle(session.leagueId, session.teams, cycle.cycleNumber).catch(
        (error: unknown) => {
          const message = error instanceof Error ? error.message : '';

          if (
            !message.includes('already') &&
            !message.includes('does not have any playable matchups')
          ) {
            console.warn('Unable to open the next scoring period.', error);
          }
        },
      );
    }

    return completion.cycleCompleted;
  }

  const playoffs = await getFantasyPlayoffs(session.leagueId);

  if (playoffs) {
    const banks = await syncPlayoffWindowBankScores({
      leagueId: session.leagueId,
      playoffs,
      season,
      requiredGamesPerCycle:
        scoringRules.requiredGamesPerCycle ?? defaultScoringRules.requiredGamesPerCycle,
      scoringRules,
      assignedPicks: picks,
      assignedScoring: result,
    });

    await ensureNextPlayoffBankWindows({
      leagueId: session.leagueId,
      playoffs,
      banks,
    });
  }

  if (!allCycleTeamsComplete(result) || matchups.length === 0) {
    return false;
  }

  try {
    await completeCycle(session.leagueId, cycle.cycleNumber, matchups, result.teamScores);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '';

    if (!message.includes('already been completed')) {
      throw error;
    }
  }

  await startNextCycle(session.leagueId, session.teams, cycle.cycleNumber).catch(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : '';

      if (
        !message.includes('already') &&
        !message.includes('playoffs have already been completed')
      ) {
        console.warn('Unable to open the next playoff round.', error);
      }
    },
  );

  return true;
}

export function getLiveScoringRefreshDelay(
  results: Array<Pick<CycleScoringResult, 'hasLiveGames' | 'nextScheduledGameStart'>>,
  rapidTransitionNeeded: boolean,
  nowMilliseconds = Date.now(),
): number {
  if (rapidTransitionNeeded) {
    return RAPID_TRANSITION_REFRESH_MS;
  }

  if (results.some((result) => result.hasLiveGames)) {
    return LIVE_REFRESH_INTERVAL_MS;
  }

  const nextStarts = results
    .map((result) => result.nextScheduledGameStart)
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter(Number.isFinite)
    .sort((first, second) => first - second);
  const nextStart = nextStarts[0];

  if (typeof nextStart === 'number') {
    const untilStart = nextStart - nowMilliseconds;

    if (untilStart <= 0) {
      return LIVE_REFRESH_INTERVAL_MS;
    }

    return Math.max(
      LIVE_REFRESH_INTERVAL_MS,
      Math.min(untilStart + 2 * 60 * 1000, NEAR_GAME_REFRESH_MAX_MS),
    );
  }

  return IDLE_REFRESH_INTERVAL_MS;
}

async function runSharedRefresh(session: LiveScoringSession, user: User): Promise<void> {
  const refreshStartedAt = Date.now();
  const refreshReason = session.nextRefreshReason;
  let publishedSnapshotCount = 0;
  let skippedSnapshotWriteCount = 0;
  const league = session.league ?? (await getLeagueById(session.leagueId));

  if (!league) {
    throw new Error('League not found for shared live scoring.');
  }

  session.league = league;

  if (league.commissionerId !== user.uid) {
    throw new Error('Only the league commissioner browser may run shared NHL scoring.');
  }

  if (session.teams.length === 0) {
    session.teams = await getLeagueTeams(session.leagueId);
  }

  const activeCycles = await getActiveLeagueCycles(session.leagueId);
  const activeCycleNumbers = activeCycles.map((cycle) => cycle.cycleNumber);
  const season = getScoringSeason();
  const scoringRules = league.scoringRules ?? defaultScoringRules;
  const requiredGamesPerCycle =
    scoringRules.requiredGamesPerCycle ?? defaultScoringRules.requiredGamesPerCycle;
  const scoringRulesFingerprint = JSON.stringify(scoringRules);
  const results: CycleScoringResult[] = [];
  let rapidTransitionNeeded = false;

  for (const cycle of activeCycles) {
    const picks = await getCyclePicks(session, cycle);

    if (picks.length === 0) {
      continue;
    }

    const previous = await getPreviousSnapshot(session, cycle.cycleNumber);
    const result = await calculateCycleScoring({
      picks,
      cycleNumber: cycle.cycleNumber,
      season,
      requiredGamesPerCycle,
      scoringRules,
      expectedRosterSlotIdsByOwner: cycle.expectedRosterSlotIdsByOwner ?? {},
      previousResult:
        previous?.season === season && previous.scoringRulesFingerprint === scoringRulesFingerprint
          ? previous.result
          : null,
    });
    const published = await publishCycleSnapshot(
      session,
      user,
      cycle,
      season,
      result,
      scoringRulesFingerprint,
      previous,
    );

    session.previousSnapshots.set(cycle.cycleNumber, published.snapshot);

    if (published.wrote) {
      publishedSnapshotCount += 1;
    } else {
      skippedSnapshotWriteCount += 1;
    }

    results.push(result);

    const completedOrAdvanced = await persistCommissionerScoring(
      session,
      cycle,
      picks,
      result,
      season,
      scoringRules,
    );

    rapidTransitionNeeded = rapidTransitionNeeded || completedOrAdvanced;
  }

  const refreshDelay =
    activeCycles.length === 0
      ? IDLE_REFRESH_INTERVAL_MS
      : getLiveScoringRefreshDelay(results, rapidTransitionNeeded);

  await setDoc(
    getControlRef(session.leagueId),
    {
      id: 'control',
      schemaVersion: 1,
      status: 'idle',
      holderUserId: user.uid,
      holderClientId: session.clientId,
      leaseExpiresAt: Timestamp.fromMillis(Date.now() + Math.min(LEASE_DURATION_MS, refreshDelay)),
      nextRefreshAt: Timestamp.fromMillis(Date.now() + refreshDelay),
      lastRefreshCompletedAt: serverTimestamp(),
      lastRefreshReason: refreshReason,
      lastRefreshDurationMs: Math.max(0, Date.now() - refreshStartedAt),
      lastPublishedSnapshotCount: publishedSnapshotCount,
      lastSkippedSnapshotWriteCount: skippedSnapshotWriteCount,
      totalSuccessfulRefreshCount: increment(1),
      totalPublishedSnapshotCount: increment(publishedSnapshotCount),
      totalSkippedSnapshotWriteCount: increment(skippedSnapshotWriteCount),
      activeCycleNumbers,
      lastError: '',
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  session.nextRefreshReason = 'scheduled';
}

async function attemptSharedRefresh(session: LiveScoringSession): Promise<void> {
  if (session.stopped || session.refreshInProgress) {
    return;
  }

  if (session.pausedUntil > Date.now()) {
    scheduleSessionAttempt(session, session.pausedUntil - Date.now());
    return;
  }

  // Historical replay is server-authoritative. A commissioner browser must
  // never publish live NHL results over the simulated ledger.
  if (session.control?.historicalReplayEnabled) {
    scheduleSessionAttempt(session, IDLE_REFRESH_INTERVAL_MS);
    return;
  }

  session.refreshInProgress = true;

  try {
    const user = await waitForAuthUser();

    if (!user || session.stopped) {
      return;
    }

    const league = session.league ?? (await getLeagueById(session.leagueId));

    if (!league || league.commissionerId !== user.uid) {
      return;
    }

    session.league = league;

    const claimed = await claimRefreshLease(session, user);

    if (!claimed) {
      scheduleSessionAttempt(session, getNextAttemptDelay(session, session.control));
      return;
    }

    await runSharedRefresh(session, user);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Shared live scoring failed.';
    const user = auth.currentUser;

    if (user && session.league?.commissionerId === user.uid) {
      await setDoc(
        getControlRef(session.leagueId),
        {
          id: 'control',
          schemaVersion: 1,
          status: 'error',
          holderUserId: user.uid,
          holderClientId: session.clientId,
          leaseExpiresAt: Timestamp.fromMillis(Date.now() + 60_000),
          nextRefreshAt: Timestamp.fromMillis(Date.now() + ERROR_RETRY_INTERVAL_MS),
          lastError: message.slice(0, 500),
          lastRefreshReason: session.nextRefreshReason,
          totalFailedRefreshCount: increment(1),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      ).catch(() => undefined);
    }

    console.warn('Shared live scoring refresh failed.', error);
  } finally {
    session.refreshInProgress = false;
  }
}

export function startLeagueLiveScoringSession(leagueId: string): () => void {
  const existing = sessions.get(leagueId);

  if (existing) {
    return () => undefined;
  }

  const session: LiveScoringSession = {
    leagueId,
    clientId: getClientId(),
    stopped: false,
    refreshInProgress: false,
    timer: null,
    stopControlListener: null,
    control: null,
    league: null,
    teams: [],
    cycleContexts: new Map(),
    previousSnapshots: new Map(),
    pausedUntil: 0,
    nextRefreshReason: 'startup',
  };

  sessions.set(leagueId, session);

  void (async () => {
    const user = await waitForAuthUser();

    if (!user || session.stopped) {
      return;
    }

    const league = await getLeagueById(leagueId);

    if (session.stopped) {
      return;
    }

    session.league = league;

    // Managers consume the shared snapshot but do not open a second worker
    // control listener. This keeps lease/control reads commissioner-only.
    if (!league || league.commissionerId !== user.uid) {
      return;
    }

    session.stopControlListener = onSnapshot(
      getControlRef(leagueId),
      (snapshot) => {
        session.control = snapshot.exists()
          ? normalizeControl(snapshot.data() as Partial<SharedLiveScoringControl>)
          : null;

        scheduleSessionAttempt(session, getNextAttemptDelay(session, session.control));
      },
      (error) => {
        console.warn('Unable to listen to shared scoring control.', error);
        scheduleSessionAttempt(session, ERROR_RETRY_INTERVAL_MS);
      },
    );

    scheduleSessionAttempt(session, 500);
  })().catch((error: unknown) => {
    console.warn('Unable to initialize shared live scoring.', error);
  });

  return () => {
    const current = sessions.get(leagueId);

    if (current !== session) {
      return;
    }

    session.stopped = true;
    session.stopControlListener?.();

    if (session.timer) {
      clearTimeout(session.timer);
    }

    sessions.delete(leagueId);
  };
}

export function listenToSharedCycleScoring(
  leagueId: string,
  cycleNumber: number,
  callback: (snapshot: SharedCycleScoringSnapshot | null) => void,
  onError?: (error: Error) => void,
): () => void {
  return onSnapshot(
    getCycleSnapshotRef(leagueId, cycleNumber),
    (snapshot) => {
      callback(
        snapshot.exists()
          ? normalizeSnapshot(
              snapshot.data() as Partial<SharedCycleScoringSnapshot>,
              leagueId,
              cycleNumber,
            )
          : null,
      );
    },
    (error) => {
      const normalized =
        error instanceof Error ? error : new Error('Unable to load shared cycle scoring.');

      if (onError) {
        onError(normalized);
      } else {
        console.warn('Unable to load shared cycle scoring.', error);
      }
    },
  );
}

export function listenToSharedLiveScoringControl(
  leagueId: string,
  callback: (control: SharedLiveScoringControl | null) => void,
  onError?: (error: Error) => void,
): () => void {
  return onSnapshot(
    getControlRef(leagueId),
    (snapshot) => {
      callback(
        snapshot.exists()
          ? normalizeControl(snapshot.data() as Partial<SharedLiveScoringControl>)
          : null,
      );
    },
    (error) => {
      const normalized =
        error instanceof Error ? error : new Error('Unable to load shared live-scoring status.');

      onError?.(normalized);
    },
  );
}

export function getLeagueLiveScoringSessionInfo(leagueId: string): LocalLiveScoringSessionInfo {
  const session = sessions.get(leagueId);

  return {
    leagueId,
    clientId: session?.clientId ?? getClientId(),
    active: Boolean(session && !session.stopped),
    refreshInProgress: session?.refreshInProgress ?? false,
    pausedUntilMs: session && session.pausedUntil > Date.now() ? session.pausedUntil : null,
  };
}

export async function releaseLeagueLiveScoringLeaseForHandoff(leagueId: string): Promise<void> {
  const user = await waitForAuthUser();

  if (!user) {
    throw new Error('You must be signed in to release the scoring lease.');
  }

  const league = await getLeagueById(leagueId);

  if (!league || league.commissionerId !== user.uid) {
    throw new Error('Only the league commissioner can release the scoring lease.');
  }

  const session = sessions.get(leagueId);
  const clientId = session?.clientId ?? getClientId();
  const now = Date.now();

  if (session) {
    session.pausedUntil = now + HANDOFF_PAUSE_MS;
    session.nextRefreshReason = 'handoff';

    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
  }

  await runTransaction(db, async (transaction) => {
    const controlRef = getControlRef(leagueId);
    const snapshot = await transaction.get(controlRef);
    const current = snapshot.exists()
      ? normalizeControl(snapshot.data() as Partial<SharedLiveScoringControl>)
      : null;
    const leaseExpiresAt = toMillis(current?.leaseExpiresAt) ?? 0;

    if (current?.holderClientId && current.holderClientId !== clientId && leaseExpiresAt > now) {
      throw new Error('This browser does not currently hold the active scoring lease.');
    }

    transaction.set(
      controlRef,
      {
        id: 'control',
        schemaVersion: 1,
        status: 'idle',
        holderUserId: null,
        holderClientId: null,
        leaseExpiresAt: Timestamp.fromMillis(now),
        nextRefreshAt: Timestamp.fromMillis(now),
        lastRefreshReason: 'handoff',
        lastError: '',
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
  });
}

export function resumeLeagueLiveScoringSession(leagueId: string): void {
  const session = sessions.get(leagueId);

  if (!session) {
    return;
  }

  session.pausedUntil = 0;
  session.nextRefreshReason = 'manual';
  scheduleSessionAttempt(session, 250);
}

export async function requestLeagueLiveScoringRefresh(leagueId: string): Promise<void> {
  const user = await waitForAuthUser();

  if (!user) {
    throw new Error('You must be signed in to refresh shared scoring.');
  }

  const league = await getLeagueById(leagueId);

  if (!league || league.commissionerId !== user.uid) {
    throw new Error('Only the league commissioner can force a shared scoring refresh.');
  }

  const existingControlSnapshot = await getDoc(getControlRef(leagueId));
  const existingControl = existingControlSnapshot.exists()
    ? normalizeControl(existingControlSnapshot.data() as Partial<SharedLiveScoringControl>)
    : null;

  if (existingControl?.historicalReplayEnabled) {
    throw new Error(
      'Live score refresh is disabled while historical replay is active. Use Advance One Day instead.',
    );
  }

  await setDoc(
    getControlRef(leagueId),
    {
      id: 'control',
      schemaVersion: 1,
      status: 'idle',
      nextRefreshAt: Timestamp.fromMillis(Date.now()),
      refreshRequestedAt: serverTimestamp(),
      lastRefreshReason: 'manual',
      lastError: '',
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  const session = sessions.get(leagueId);

  if (session) {
    session.pausedUntil = 0;
    session.nextRefreshReason = 'manual';
    scheduleSessionAttempt(session, 250);
  }
}

/** One-time commissioner/readiness read of the shared scoring control document. */
export async function getSharedLiveScoringControlOnce(
  leagueId: string,
): Promise<SharedLiveScoringControl | null> {
  const snapshot = await getDoc(getControlRef(leagueId));

  return snapshot.exists()
    ? normalizeControl(snapshot.data() as Partial<SharedLiveScoringControl>)
    : null;
}

/**
 * Safe recovery for an expired or errored lease. A healthy active worker is
 * never interrupted; commissioners should use the normal handoff button for
 * that case.
 */
export async function clearExpiredOrErroredLiveScoringLease(leagueId: string): Promise<void> {
  const user = await waitForAuthUser();

  if (!user) {
    throw new Error('You must be signed in to clear a scoring lease.');
  }

  const league = await getLeagueById(leagueId);

  if (!league || league.commissionerId !== user.uid) {
    throw new Error('Only the league commissioner can clear a scoring lease.');
  }

  const now = Date.now();

  await runTransaction(db, async (transaction) => {
    const controlRef = getControlRef(leagueId);
    const snapshot = await transaction.get(controlRef);

    if (!snapshot.exists()) {
      return;
    }

    const current = normalizeControl(snapshot.data() as Partial<SharedLiveScoringControl>);
    const leaseExpiresAt = toMillis(current?.leaseExpiresAt) ?? 0;
    const healthyActiveLease =
      current?.status !== 'error' && Boolean(current?.holderClientId) && leaseExpiresAt > now;

    if (healthyActiveLease) {
      throw new Error(
        'The scoring worker still has a healthy active lease. Use the normal handoff control from the lease-holding tab instead.',
      );
    }

    transaction.set(
      controlRef,
      {
        id: 'control',
        schemaVersion: 1,
        status: 'idle',
        holderUserId: null,
        holderClientId: null,
        leaseExpiresAt: Timestamp.fromMillis(now),
        nextRefreshAt: Timestamp.fromMillis(now),
        lastRefreshReason: 'handoff',
        lastError: '',
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
  });

  const session = sessions.get(leagueId);

  if (session) {
    session.pausedUntil = 0;
    session.nextRefreshReason = 'handoff';
    scheduleSessionAttempt(session, 250);
  }
}
