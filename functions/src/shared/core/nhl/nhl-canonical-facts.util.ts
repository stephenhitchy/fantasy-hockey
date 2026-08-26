import { createHash } from 'node:crypto';

import type {
  NhlGameBoxscoreResponse,
  NhlGamePlayByPlayResponse,
  NhlGoalieBoxscoreLine,
  NhlPlayByPlayEvent,
  NhlSkaterBoxscoreLine,
  NhlTeamBoxscore,
} from './nhl-api.service';

export const CANONICAL_NHL_FACTS_SCHEMA_VERSION = 1;
export const CANONICAL_NHL_TOI_SETTLEMENT_INTERVAL_MILLISECONDS = 5 * 60 * 1000;
export const CANONICAL_NHL_FINAL_RECONCILIATION_MILLISECONDS = 30 * 60 * 1000;

export type CanonicalNhlGameState = 'scheduled' | 'live' | 'final';

export type CanonicalNhlChangeKind =
  | 'baseline'
  | 'unchanged'
  | 'fantasy-event'
  | 'game-state'
  | 'toi-deferred'
  | 'toi-settlement'
  | 'final-settlement';

export interface CanonicalNhlScoreboardContext {
  gameId: number;
  gameState: string;
  gameScheduleState?: string;
  period?: number;
  periodType?: string;
  clockTimeRemaining?: string;
  clockRunning?: boolean;
  inIntermission?: boolean;
  startTimeUTC?: string;
  gameDate?: string;
}

export interface CanonicalNhlSkaterFacts {
  playerId: number;
  teamAbbreviation: string;
  position: string;
  goals: number;
  assists: number;
  primaryAssists: number;
  secondaryAssists: number;
  shotsOnGoal: number;
  hits: number;
  blockedShots: number;
  plusMinus: number;
  powerPlayGoals: number;
  timeOnIceSeconds: number;
}

export interface CanonicalNhlGoalieFacts {
  playerId: number;
  teamAbbreviation: string;
  goalsAgainst: number;
  saves: number;
  shotsAgainst: number;
  starter: boolean;
  decision: string;
  timeOnIceSeconds: number;
}

export interface CanonicalNhlGoalEvent {
  eventId: number | null;
  period: number | null;
  periodType: string;
  timeInPeriod: string;
  scoringPlayerId: number | null;
  assist1PlayerId: number | null;
  assist2PlayerId: number | null;
  situationCode: string;
  homeScore: number | null;
  awayScore: number | null;
}

export interface CanonicalNhlGameFacts {
  schemaVersion: 1;
  gameId: number;
  gameState: CanonicalNhlGameState;
  sourceGameState: string;
  sourceGameScheduleState: string;
  gameDate: string;
  startTimeUTC: string;
  period: number | null;
  periodType: string;
  clockTimeRemaining: string;
  clockRunning: boolean;
  inIntermission: boolean;
  homeTeamAbbreviation: string;
  awayTeamAbbreviation: string;
  homeScore: number;
  awayScore: number;
  skaters: CanonicalNhlSkaterFacts[];
  goalies: CanonicalNhlGoalieFacts[];
  goals: CanonicalNhlGoalEvent[];
  playerIds: number[];
  teamAbbreviations: string[];
}

export interface CanonicalNhlGameHashes {
  rawSourceHash: string;
  fantasyEventHash: string;
  timeOnIceHash: string;
  gameStateHash: string;
  finalSettlementHash: string;
  sourceVersion: string;
}

export interface PreviousCanonicalNhlSignalState {
  fantasyEventHash: string;
  timeOnIceHash: string;
  lastSignaledTimeOnIceHash: string;
  gameStateHash: string;
  finalSettlementHash: string;
  lastTimeOnIceSettledAtMilliseconds: number;
}

export interface CanonicalNhlChangeDecision {
  kind: CanonicalNhlChangeKind;
  shouldSignal: boolean;
  timeOnIceDirty: boolean;
  nextTimeOnIceSettlementAtMilliseconds: number | null;
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : fallback;
}

function normalizedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function parseNhlTimeOnIceSeconds(value: unknown): number {
  const text = normalizedString(value);

  if (!text) {
    return 0;
  }

  const [minutesRaw, secondsRaw] = text.split(':');
  const minutes = Number(minutesRaw);
  const seconds = Number(secondsRaw);

  if (
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds) ||
    minutes < 0 ||
    seconds < 0 ||
    seconds >= 60
  ) {
    return 0;
  }

  return Math.max(0, Math.trunc(minutes) * 60 + Math.trunc(seconds));
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableNormalize(entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableNormalize(entry)]),
    );
  }

  return value;
}

export function canonicalNhlSha256(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableNormalize(value)))
    .digest('hex');
}

export function normalizeCanonicalNhlGameState(value: unknown): CanonicalNhlGameState {
  const state = normalizedString(value).toUpperCase();

  if (state === 'LIVE' || state === 'CRIT') {
    return 'live';
  }

  if (state === 'OFF' || state === 'FINAL') {
    return 'final';
  }

  return 'scheduled';
}

function getTeamSkaters(team: NhlTeamBoxscore | undefined): NhlSkaterBoxscoreLine[] {
  return [
    ...(team?.forwards ?? []),
    ...(team?.defense ?? []),
  ];
}

function countOrderedAssists(
  events: readonly CanonicalNhlGoalEvent[],
  playerId: number,
): { primaryAssists: number; secondaryAssists: number } {
  let primaryAssists = 0;
  let secondaryAssists = 0;

  for (const event of events) {
    if (event.assist1PlayerId === playerId) {
      primaryAssists += 1;
    }

    if (event.assist2PlayerId === playerId) {
      secondaryAssists += 1;
    }
  }

  return { primaryAssists, secondaryAssists };
}

function getPlayDetailNumber(
  play: NhlPlayByPlayEvent,
  key: string,
): number | null {
  const value = play.details?.[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : null;
}

function getPlayDetailString(
  play: NhlPlayByPlayEvent,
  key: string,
): string {
  return normalizedString(play.details?.[key]);
}

function normalizeGoalEvent(
  play: NhlPlayByPlayEvent,
): CanonicalNhlGoalEvent | null {
  if (normalizedString(play.typeDescKey).toLowerCase() !== 'goal') {
    return null;
  }

  const periodDescriptor = play.periodDescriptor &&
    typeof play.periodDescriptor === 'object'
      ? play.periodDescriptor
      : {};

  return {
    eventId: typeof play.eventId === 'number' && Number.isFinite(play.eventId)
      ? play.eventId
      : null,
    period: typeof periodDescriptor.number === 'number' &&
      Number.isFinite(periodDescriptor.number)
        ? periodDescriptor.number
        : null,
    periodType: normalizedString(periodDescriptor.periodType),
    timeInPeriod: normalizedString(play.timeInPeriod),
    scoringPlayerId: getPlayDetailNumber(play, 'scoringPlayerId'),
    assist1PlayerId: getPlayDetailNumber(play, 'assist1PlayerId'),
    assist2PlayerId: getPlayDetailNumber(play, 'assist2PlayerId'),
    situationCode: getPlayDetailString(play, 'situationCode'),
    homeScore: getPlayDetailNumber(play, 'homeScore'),
    awayScore: getPlayDetailNumber(play, 'awayScore'),
  };
}

function normalizeSkater(
  line: NhlSkaterBoxscoreLine,
  teamAbbreviation: string,
  goals: readonly CanonicalNhlGoalEvent[],
): CanonicalNhlSkaterFacts {
  const orderedAssists = countOrderedAssists(goals, line.playerId);

  return {
    playerId: Math.trunc(finiteNumber(line.playerId)),
    teamAbbreviation,
    position: normalizedString(line.position).toUpperCase(),
    goals: finiteNumber(line.goals),
    assists: finiteNumber(line.assists),
    primaryAssists: orderedAssists.primaryAssists,
    secondaryAssists: orderedAssists.secondaryAssists,
    shotsOnGoal: finiteNumber(line.sog),
    hits: finiteNumber(line.hits),
    blockedShots: finiteNumber(line.blockedShots),
    plusMinus: finiteNumber(line.plusMinus),
    powerPlayGoals: finiteNumber(line.powerPlayGoals),
    timeOnIceSeconds: parseNhlTimeOnIceSeconds(line.toi),
  };
}

function normalizeGoalie(
  line: NhlGoalieBoxscoreLine,
  teamAbbreviation: string,
): CanonicalNhlGoalieFacts {
  return {
    playerId: Math.trunc(finiteNumber(line.playerId)),
    teamAbbreviation,
    goalsAgainst: finiteNumber(line.goalsAgainst),
    saves: finiteNumber(line.saves),
    shotsAgainst: finiteNumber(line.shotsAgainst),
    starter: line.starter === true,
    decision: normalizedString(line.decision).toUpperCase(),
    timeOnIceSeconds: parseNhlTimeOnIceSeconds(line.toi),
  };
}

export function buildCanonicalNhlGameFacts(input: {
  scoreboard: CanonicalNhlScoreboardContext;
  boxscore: NhlGameBoxscoreResponse;
  playByPlay: NhlGamePlayByPlayResponse;
}): CanonicalNhlGameFacts {
  const homeTeamAbbreviation = normalizedString(
    input.boxscore.homeTeam?.abbrev,
  ).toUpperCase();
  const awayTeamAbbreviation = normalizedString(
    input.boxscore.awayTeam?.abbrev,
  ).toUpperCase();
  const goals = (input.playByPlay.plays ?? [])
    .map((play) => normalizeGoalEvent(play))
    .filter((event): event is CanonicalNhlGoalEvent => event !== null)
    .sort((left, right) => {
      const leftEvent = left.eventId ?? Number.MAX_SAFE_INTEGER;
      const rightEvent = right.eventId ?? Number.MAX_SAFE_INTEGER;
      return leftEvent - rightEvent;
    });
  const homeStats = input.boxscore.playerByGameStats?.homeTeam;
  const awayStats = input.boxscore.playerByGameStats?.awayTeam;
  const skaters = [
    ...getTeamSkaters(homeStats).map((line) =>
      normalizeSkater(line, homeTeamAbbreviation, goals)
    ),
    ...getTeamSkaters(awayStats).map((line) =>
      normalizeSkater(line, awayTeamAbbreviation, goals)
    ),
  ].sort((left, right) => left.playerId - right.playerId);
  const goalies = [
    ...(homeStats?.goalies ?? []).map((line) =>
      normalizeGoalie(line, homeTeamAbbreviation)
    ),
    ...(awayStats?.goalies ?? []).map((line) =>
      normalizeGoalie(line, awayTeamAbbreviation)
    ),
  ].sort((left, right) => left.playerId - right.playerId);
  const playerIds = [...new Set([
    ...skaters.map((entry) => entry.playerId),
    ...goalies.map((entry) => entry.playerId),
  ].filter((playerId) => playerId > 0))].sort((left, right) => left - right);
  const teamAbbreviations = [...new Set([
    homeTeamAbbreviation,
    awayTeamAbbreviation,
  ].filter(Boolean))].sort();

  return {
    schemaVersion: CANONICAL_NHL_FACTS_SCHEMA_VERSION,
    gameId: Math.trunc(input.scoreboard.gameId),
    gameState: normalizeCanonicalNhlGameState(input.scoreboard.gameState),
    sourceGameState: normalizedString(input.scoreboard.gameState).toUpperCase(),
    sourceGameScheduleState: normalizedString(
      input.scoreboard.gameScheduleState,
    ).toUpperCase(),
    gameDate: normalizedString(input.scoreboard.gameDate),
    startTimeUTC: normalizedString(input.scoreboard.startTimeUTC),
    period: typeof input.scoreboard.period === 'number' &&
      Number.isFinite(input.scoreboard.period)
        ? Math.trunc(input.scoreboard.period)
        : null,
    periodType: normalizedString(input.scoreboard.periodType).toUpperCase(),
    clockTimeRemaining: normalizedString(input.scoreboard.clockTimeRemaining),
    clockRunning: input.scoreboard.clockRunning === true,
    inIntermission: input.scoreboard.inIntermission === true,
    homeTeamAbbreviation,
    awayTeamAbbreviation,
    homeScore: finiteNumber(input.boxscore.homeTeam?.score),
    awayScore: finiteNumber(input.boxscore.awayTeam?.score),
    skaters,
    goalies,
    goals,
    playerIds,
    teamAbbreviations,
  };
}

export function buildCanonicalNhlGameHashes(
  facts: CanonicalNhlGameFacts,
): CanonicalNhlGameHashes {
  const fantasySkaters = facts.skaters.map((entry) => ({
    playerId: entry.playerId,
    teamAbbreviation: entry.teamAbbreviation,
    position: entry.position,
    goals: entry.goals,
    assists: entry.assists,
    primaryAssists: entry.primaryAssists,
    secondaryAssists: entry.secondaryAssists,
    shotsOnGoal: entry.shotsOnGoal,
    hits: entry.hits,
    blockedShots: entry.blockedShots,
    plusMinus: entry.plusMinus,
    powerPlayGoals: entry.powerPlayGoals,
  }));
  const fantasyGoalies = facts.goalies.map((entry) => ({
    playerId: entry.playerId,
    teamAbbreviation: entry.teamAbbreviation,
    goalsAgainst: entry.goalsAgainst,
    saves: entry.saves,
    shotsAgainst: entry.shotsAgainst,
    starter: entry.starter,
    decision: entry.decision,
  }));
  const timeOnIce = {
    skaters: facts.skaters.map((entry) => ({
      playerId: entry.playerId,
      seconds: entry.timeOnIceSeconds,
    })),
    goalies: facts.goalies.map((entry) => ({
      playerId: entry.playerId,
      seconds: entry.timeOnIceSeconds,
    })),
  };
  // The running clock changes continuously and must not defeat TOI coalescing.
  // Only meaningful game-phase transitions belong in the immediate state hash.
  const gameState = {
    gameState: facts.gameState,
    sourceGameState: facts.sourceGameState,
    sourceGameScheduleState: facts.sourceGameScheduleState,
    period: facts.period,
    periodType: facts.periodType,
    inIntermission: facts.inIntermission,
  };
  const fantasyEvents = {
    homeTeamAbbreviation: facts.homeTeamAbbreviation,
    awayTeamAbbreviation: facts.awayTeamAbbreviation,
    homeScore: facts.homeScore,
    awayScore: facts.awayScore,
    skaters: fantasySkaters,
    goalies: fantasyGoalies,
    goals: facts.goals,
  };
  const rawSourceHash = canonicalNhlSha256(facts);
  const fantasyEventHash = canonicalNhlSha256(fantasyEvents);
  const timeOnIceHash = canonicalNhlSha256(timeOnIce);
  const gameStateHash = canonicalNhlSha256(gameState);
  const finalSettlementHash = canonicalNhlSha256({
    fantasyEvents,
    timeOnIce,
    gameState,
  });
  const sourceVersion = canonicalNhlSha256({
    schemaVersion: CANONICAL_NHL_FACTS_SCHEMA_VERSION,
    gameId: facts.gameId,
    fantasyEventHash,
    timeOnIceHash,
    gameStateHash,
    finalSettlementHash,
  });

  return {
    rawSourceHash,
    fantasyEventHash,
    timeOnIceHash,
    gameStateHash,
    finalSettlementHash,
    sourceVersion,
  };
}

export function decideCanonicalNhlGameChange(input: {
  previous: PreviousCanonicalNhlSignalState | null;
  current: CanonicalNhlGameHashes;
  currentGameState: CanonicalNhlGameState;
  nowMilliseconds?: number;
  timeOnIceSettlementIntervalMilliseconds?: number;
}): CanonicalNhlChangeDecision {
  const now = input.nowMilliseconds ?? Date.now();
  const settlementInterval = Math.max(
    60_000,
    input.timeOnIceSettlementIntervalMilliseconds ??
      CANONICAL_NHL_TOI_SETTLEMENT_INTERVAL_MILLISECONDS,
  );

  if (!input.previous) {
    return {
      kind: 'baseline',
      shouldSignal: false,
      timeOnIceDirty: false,
      nextTimeOnIceSettlementAtMilliseconds: null,
    };
  }

  if (
    input.currentGameState === 'final' &&
    input.previous.finalSettlementHash !== input.current.finalSettlementHash
  ) {
    return {
      kind: 'final-settlement',
      shouldSignal: true,
      timeOnIceDirty: false,
      nextTimeOnIceSettlementAtMilliseconds: null,
    };
  }

  if (input.previous.fantasyEventHash !== input.current.fantasyEventHash) {
    return {
      kind: 'fantasy-event',
      shouldSignal: true,
      timeOnIceDirty: false,
      nextTimeOnIceSettlementAtMilliseconds: null,
    };
  }

  if (input.previous.gameStateHash !== input.current.gameStateHash) {
    return {
      kind: 'game-state',
      shouldSignal: true,
      timeOnIceDirty: false,
      nextTimeOnIceSettlementAtMilliseconds: null,
    };
  }

  const timeOnIceDirty =
    input.previous.lastSignaledTimeOnIceHash !== input.current.timeOnIceHash;

  if (!timeOnIceDirty) {
    return {
      kind: 'unchanged',
      shouldSignal: false,
      timeOnIceDirty: false,
      nextTimeOnIceSettlementAtMilliseconds: null,
    };
  }

  const nextSettlementAt =
    input.previous.lastTimeOnIceSettledAtMilliseconds + settlementInterval;
  const settlementDue = input.currentGameState === 'final' || now >= nextSettlementAt;

  return settlementDue
    ? {
        kind: 'toi-settlement',
        shouldSignal: true,
        timeOnIceDirty: false,
        nextTimeOnIceSettlementAtMilliseconds: null,
      }
    : {
        kind: 'toi-deferred',
        shouldSignal: false,
        timeOnIceDirty: true,
        nextTimeOnIceSettlementAtMilliseconds: nextSettlementAt,
      };
}
