import { createHash } from 'node:crypto';

import type {
  NhlGameBoxscoreResponse,
  NhlGamePlayByPlayResponse,
  NhlGoalieBoxscoreLine,
  NhlPlayerGameLogEntry,
  NhlSkaterBoxscoreLine,
  NhlTeamBoxscore,
} from './nhl-api.service';

export type NhlFinalInputSource =
  | 'boxscore'
  | 'play-by-play'
  | 'player-log'
  | 'source-version';

export type NhlFinalInputAvailability =
  | 'available'
  | 'temporarily-unavailable'
  | 'malformed'
  | 'not-required';

export type NhlFinalInputCompletenessCode =
  | 'complete'
  | 'incomplete-boxscore'
  | 'incomplete-play-by-play'
  | 'incomplete-player-log'
  | 'incomplete-source-version'
  | 'temporarily-unavailable'
  | 'malformed';

export interface NhlFinalInputSourceState {
  availability: NhlFinalInputAvailability;
  detail?: string;
}

export interface NhlFinalInputFailure {
  code: Exclude<NhlFinalInputCompletenessCode, 'complete'>;
  source: NhlFinalInputSource;
  detail: string;
  retryable: boolean;
}

export interface NhlFinalInputCompleteness {
  status: NhlFinalInputCompletenessCode;
  complete: boolean;
  reusableFinal: boolean;
  requiredSources: NhlFinalInputSource[];
  sourceVersion: string;
  preservedPreviousScore: boolean;
  failures: NhlFinalInputFailure[];
}

export interface NhlFinalInputRequirements {
  assetType: 'skater' | 'team-goalie-unit';
  boxscore: NhlFinalInputSourceState;
  playByPlay: NhlFinalInputSourceState;
  playerLog: NhlFinalInputSourceState;
  sourceVersion: string;
}

const MAX_FAILURE_DETAIL_LENGTH = 180;
const COMPLETENESS_CODES = new Set<NhlFinalInputCompletenessCode>([
  'complete',
  'incomplete-boxscore',
  'incomplete-play-by-play',
  'incomplete-player-log',
  'incomplete-source-version',
  'temporarily-unavailable',
  'malformed',
]);
const FAILURE_CODES = new Set<Exclude<NhlFinalInputCompletenessCode, 'complete'>>([
  'incomplete-boxscore',
  'incomplete-play-by-play',
  'incomplete-player-log',
  'incomplete-source-version',
  'temporarily-unavailable',
  'malformed',
]);
const FINAL_INPUT_SOURCES = new Set<NhlFinalInputSource>([
  'boxscore',
  'play-by-play',
  'player-log',
  'source-version',
]);
const SOURCE_INCOMPLETE_CODE: Record<
  Exclude<NhlFinalInputSource, 'source-version'>,
  Exclude<NhlFinalInputCompletenessCode, 'complete'>
> = {
  boxscore: 'incomplete-boxscore',
  'play-by-play': 'incomplete-play-by-play',
  'player-log': 'incomplete-player-log',
};

function boundedDetail(value: unknown, fallback: string): string {
  const text = value instanceof Error
    ? value.message
    : typeof value === 'string'
      ? value
      : fallback;

  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_FAILURE_DETAIL_LENGTH) || fallback;
}

function availableSource(): NhlFinalInputSourceState {
  return { availability: 'available' };
}

function malformedSource(detail: string): NhlFinalInputSourceState {
  return { availability: 'malformed', detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isValidTimeOnIce(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  const match = /^(\d{1,3}):(\d{2})$/.exec(value.trim());
  return Boolean(match) && Number(match?.[2]) < 60;
}

function hasValidSkaterScoringFields(
  value: unknown,
): value is NhlSkaterBoxscoreLine {
  if (!isRecord(value)) {
    return false;
  }

  return isPositiveInteger(value['playerId']) &&
    typeof value['position'] === 'string' &&
    value['position'].trim().length > 0 &&
    isNonNegativeNumber(value['goals']) &&
    isNonNegativeNumber(value['assists']) &&
    isFiniteNumber(value['plusMinus']) &&
    isNonNegativeNumber(value['hits']) &&
    isNonNegativeNumber(value['powerPlayGoals']) &&
    isNonNegativeNumber(value['sog']) &&
    isNonNegativeNumber(value['blockedShots']) &&
    isValidTimeOnIce(value['toi']);
}

function hasValidGoalieScoringFields(
  value: unknown,
): value is NhlGoalieBoxscoreLine {
  if (!isRecord(value)) {
    return false;
  }

  return isPositiveInteger(value['playerId']) &&
    isNonNegativeNumber(value['goalsAgainst']) &&
    isNonNegativeNumber(value['shotsAgainst']) &&
    isNonNegativeNumber(value['saves']) &&
    typeof value['starter'] === 'boolean' &&
    isValidTimeOnIce(value['toi']);
}

function isActiveGoalie(line: NhlGoalieBoxscoreLine): boolean {
  return line.toi.trim() !== '00:00' || line.saves > 0 || line.shotsAgainst > 0;
}

function getValidatedBoxscoreTeam(input: {
  boxscore: NhlGameBoxscoreResponse;
  teamAbbreviation: string;
}): NhlTeamBoxscore | null {
  const team = input.teamAbbreviation.trim().toUpperCase();
  const homeAbbreviation = input.boxscore.homeTeam?.abbrev?.trim().toUpperCase();
  const awayAbbreviation = input.boxscore.awayTeam?.abbrev?.trim().toUpperCase();

  if (
    !homeAbbreviation ||
    !awayAbbreviation ||
    !isNonNegativeNumber(input.boxscore.homeTeam?.score) ||
    !isNonNegativeNumber(input.boxscore.awayTeam?.score)
  ) {
    return null;
  }

  if (homeAbbreviation === team) {
    return input.boxscore.playerByGameStats?.homeTeam ?? null;
  }

  if (awayAbbreviation === team) {
    return input.boxscore.playerByGameStats?.awayTeam ?? null;
  }

  return null;
}

function hasUniqueValidPlayerIds(values: readonly unknown[]): boolean {
  const ids = values.map((entry) => isRecord(entry) ? entry['playerId'] : null);

  return ids.every(isPositiveInteger) && new Set(ids).size === ids.length;
}

export function validateNhlFinalSkaterBoxscore(input: {
  boxscore: NhlGameBoxscoreResponse;
  teamAbbreviation: string;
  playerId: number;
}): NhlFinalInputSourceState {
  const team = getValidatedBoxscoreTeam(input);

  if (!team || !Array.isArray(team.forwards) || !Array.isArray(team.defense)) {
    return malformedSource(
      'NHL boxscore was missing the asset team skater arrays required to prove appearance.',
    );
  }

  const skaters = [...team.forwards, ...team.defense];

  if (!hasUniqueValidPlayerIds(skaters)) {
    return malformedSource(
      'NHL boxscore contained an invalid or duplicate asset-team skater identifier.',
    );
  }

  const playerLine = skaters.find((line) => line.playerId === input.playerId);

  if (playerLine && !hasValidSkaterScoringFields(playerLine)) {
    return malformedSource(
      'NHL boxscore contained incomplete scoring fields for the appeared skater.',
    );
  }

  return availableSource();
}

export function validateNhlFinalGoalieUnitBoxscore(input: {
  boxscore: NhlGameBoxscoreResponse;
  teamAbbreviation: string;
}): NhlFinalInputSourceState {
  const team = getValidatedBoxscoreTeam(input);

  if (!team || !Array.isArray(team.goalies) || team.goalies.length === 0) {
    return malformedSource(
      'NHL boxscore was missing the active goalie evidence required for final scoring.',
    );
  }

  if (
    !hasUniqueValidPlayerIds(team.goalies) ||
    !team.goalies.every(hasValidGoalieScoringFields) ||
    !team.goalies.some(isActiveGoalie)
  ) {
    return malformedSource(
      'NHL boxscore contained invalid or incomplete active goalie scoring evidence.',
    );
  }

  return availableSource();
}

export function validateNhlFinalCanonicalBoxscore(
  boxscore: NhlGameBoxscoreResponse,
): NhlFinalInputSourceState {
  const home = boxscore.homeTeam?.abbrev?.trim().toUpperCase() ?? '';
  const away = boxscore.awayTeam?.abbrev?.trim().toUpperCase() ?? '';

  if (!home || !away || home === away) {
    return malformedSource('NHL boxscore did not identify two distinct teams.');
  }

  for (const teamAbbreviation of [home, away]) {
    const team = getValidatedBoxscoreTeam({ boxscore, teamAbbreviation });

    if (
      !team ||
      !Array.isArray(team.forwards) ||
      !Array.isArray(team.defense) ||
      !Array.isArray(team.goalies)
    ) {
      return malformedSource(
        'NHL boxscore was missing required final skater or goalie arrays.',
      );
    }

    const skaters = [...team.forwards, ...team.defense];

    if (
      !hasUniqueValidPlayerIds(skaters) ||
      !skaters.every(hasValidSkaterScoringFields) ||
      team.goalies.length === 0 ||
      !hasUniqueValidPlayerIds(team.goalies) ||
      !team.goalies.every(hasValidGoalieScoringFields) ||
      !team.goalies.some(isActiveGoalie)
    ) {
      return malformedSource(
        'NHL boxscore contained invalid final skater or goalie scoring evidence.',
      );
    }
  }

  return availableSource();
}

export function validateNhlFinalPlayByPlay(
  playByPlay: NhlGamePlayByPlayResponse,
): NhlFinalInputSourceState {
  if (!Array.isArray(playByPlay.plays) || playByPlay.plays.length === 0) {
    return malformedSource(
      'NHL play-by-play payload did not contain final-game play evidence.',
    );
  }

  for (const play of playByPlay.plays) {
    if (!isRecord(play)) {
      return malformedSource('NHL play-by-play contained a malformed play entry.');
    }

    if (String(play['typeDescKey'] ?? '').trim().toLowerCase() !== 'goal') {
      continue;
    }

    const details = play['details'];

    if (!isRecord(details) || !isPositiveInteger(details['scoringPlayerId'])) {
      return malformedSource(
        'NHL play-by-play contained a goal without valid scorer evidence.',
      );
    }

    for (const assistKey of ['assist1PlayerId', 'assist2PlayerId']) {
      const assistPlayerId = details[assistKey];

      if (typeof assistPlayerId !== 'undefined' && !isPositiveInteger(assistPlayerId)) {
        return malformedSource(
          'NHL play-by-play contained malformed ordered-assist evidence.',
        );
      }
    }
  }

  return availableSource();
}

function hasValidPlayerGameLogScoringFields(
  value: unknown,
): value is NhlPlayerGameLogEntry {
  if (!isRecord(value) || !isPositiveInteger(value['gameId'])) {
    return false;
  }

  return isNonNegativeNumber(value['goals']) &&
    isNonNegativeNumber(value['assists']) &&
    isFiniteNumber(value['plusMinus']) &&
    isNonNegativeNumber(value['powerPlayPoints']) &&
    isNonNegativeNumber(value['gameWinningGoals']) &&
    isNonNegativeNumber(value['otGoals']) &&
    isNonNegativeNumber(value['shots']) &&
    isNonNegativeNumber(value['shorthandedPoints']) &&
    isValidTimeOnIce(value['toi']);
}

export function validateNhlFinalPlayerGameLog(input: {
  gameLog: unknown;
  gameId: number;
  appeared: boolean;
}): {
  sourceState: NhlFinalInputSourceState;
  gameLogEntry: NhlPlayerGameLogEntry | undefined;
} {
  if (!Array.isArray(input.gameLog)) {
    return {
      sourceState: malformedSource(
        'NHL player game-log payload did not contain a gameLog array.',
      ),
      gameLogEntry: undefined,
    };
  }

  if (!input.gameLog.every((entry) =>
    isRecord(entry) && isPositiveInteger(entry['gameId'])
  )) {
    return {
      sourceState: malformedSource(
        'NHL player game-log payload contained a malformed game identifier.',
      ),
      gameLogEntry: undefined,
    };
  }

  const matchingEntries = input.gameLog.filter((entry) =>
    (entry as Record<string, unknown>)['gameId'] === input.gameId
  );

  if (matchingEntries.length > 1) {
    return {
      sourceState: malformedSource(
        'NHL player game-log payload contained duplicate entries for the final game.',
      ),
      gameLogEntry: undefined,
    };
  }

  const gameLogEntry = matchingEntries[0];

  if (!gameLogEntry) {
    return {
      sourceState: input.appeared
        ? {
            availability: 'temporarily-unavailable',
            detail: 'The final player game-log response did not yet include this appeared game.',
          }
        : availableSource(),
      gameLogEntry: undefined,
    };
  }

  if (!hasValidPlayerGameLogScoringFields(gameLogEntry)) {
    return {
      sourceState: malformedSource(
        'NHL player game-log entry was missing required final scoring fields.',
      ),
      gameLogEntry: undefined,
    };
  }

  return {
    sourceState: availableSource(),
    gameLogEntry,
  };
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

export function buildNhlFinalInputSourceVersion(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableNormalize(value)))
    .digest('hex');
}

export function classifyNhlFinalInputFailure(
  error: unknown,
): NhlFinalInputSourceState {
  const detail = boundedDetail(error, 'NHL source request failed.');
  const normalized = detail.toLowerCase();
  const malformed = error instanceof SyntaxError ||
    normalized.includes('json') ||
    normalized.includes('malformed') ||
    normalized.includes('invalid payload');

  return {
    availability: malformed ? 'malformed' : 'temporarily-unavailable',
    detail,
  };
}

function addUnavailableSourceFailures(input: {
  source: Exclude<NhlFinalInputSource, 'source-version'>;
  state: NhlFinalInputSourceState;
  failures: NhlFinalInputFailure[];
}): void {
  if (
    input.state.availability === 'available' ||
    input.state.availability === 'not-required'
  ) {
    return;
  }

  const detail = boundedDetail(
    input.state.detail,
    `${input.source} is unavailable for final scoring.`,
  );

  input.failures.push({
    code: SOURCE_INCOMPLETE_CODE[input.source],
    source: input.source,
    detail,
    retryable: true,
  });
  input.failures.push({
    code: input.state.availability,
    source: input.source,
    detail,
    retryable: true,
  });
}

export function assessNhlFinalInputCompleteness(
  input: NhlFinalInputRequirements,
): NhlFinalInputCompleteness {
  const requiredSources: NhlFinalInputSource[] = input.assetType === 'skater'
    ? ['boxscore', 'play-by-play', 'player-log', 'source-version']
    : ['boxscore', 'source-version'];
  const failures: NhlFinalInputFailure[] = [];

  addUnavailableSourceFailures({
    source: 'boxscore',
    state: input.boxscore,
    failures,
  });

  if (input.assetType === 'skater') {
    addUnavailableSourceFailures({
      source: 'play-by-play',
      state: input.playByPlay,
      failures,
    });
    addUnavailableSourceFailures({
      source: 'player-log',
      state: input.playerLog,
      failures,
    });
  }

  const sourceVersion = /^[a-f0-9]{64}$/i.test(input.sourceVersion.trim())
    ? input.sourceVersion.trim().toLowerCase()
    : '';

  if (failures.length === 0 && !sourceVersion) {
    failures.push({
      code: 'incomplete-source-version',
      source: 'source-version',
      detail: 'A deterministic final-input source version was not available.',
      retryable: true,
    });
  }

  const boundedFailures = failures.slice(0, 8);
  const malformedFailure = boundedFailures.find((entry) => entry.code === 'malformed');
  const sourceFailure = boundedFailures.find((entry) =>
    entry.code === 'incomplete-boxscore' ||
    entry.code === 'incomplete-play-by-play' ||
    entry.code === 'incomplete-player-log' ||
    entry.code === 'incomplete-source-version'
  );
  const complete = boundedFailures.length === 0;

  return {
    status: complete
      ? 'complete'
      : malformedFailure?.code ?? sourceFailure?.code ?? 'temporarily-unavailable',
    complete,
    reusableFinal: complete,
    requiredSources,
    sourceVersion,
    preservedPreviousScore: false,
    failures: boundedFailures,
  };
}

export function isReusableNhlFinalScore(input: {
  assetType: NhlFinalInputRequirements['assetType'];
  gameState: unknown;
  score: unknown;
  completeness: unknown;
}): boolean {
  if (
    input.gameState !== 'final' ||
    typeof input.score !== 'number' ||
    !Number.isFinite(input.score) ||
    !input.completeness ||
    typeof input.completeness !== 'object' ||
    Array.isArray(input.completeness)
  ) {
    return false;
  }

  const evidence = input.completeness as Partial<NhlFinalInputCompleteness>;
  const expectedRequiredSources: NhlFinalInputSource[] =
    input.assetType === 'skater'
      ? ['boxscore', 'play-by-play', 'player-log', 'source-version']
      : ['boxscore', 'source-version'];

  return evidence.status === 'complete' &&
    evidence.complete === true &&
    evidence.reusableFinal === true &&
    Array.isArray(evidence.requiredSources) &&
    evidence.requiredSources.length === expectedRequiredSources.length &&
    expectedRequiredSources.every((source) =>
      evidence.requiredSources?.includes(source)
    ) &&
    Array.isArray(evidence.failures) &&
    evidence.failures.length === 0 &&
    typeof evidence.sourceVersion === 'string' &&
    /^[a-f0-9]{64}$/i.test(evidence.sourceVersion);
}

function hasExactRequiredSourceContract(
  requiredSources: readonly NhlFinalInputSource[],
): boolean {
  const uniqueSources = new Set(requiredSources);
  const skaterSources: NhlFinalInputSource[] = [
    'boxscore',
    'play-by-play',
    'player-log',
    'source-version',
  ];
  const goalieSources: NhlFinalInputSource[] = [
    'boxscore',
    'source-version',
  ];

  return (
    uniqueSources.size === skaterSources.length &&
    skaterSources.every((source) => uniqueSources.has(source))
  ) || (
    uniqueSources.size === goalieSources.length &&
    goalieSources.every((source) => uniqueSources.has(source))
  );
}

export function normalizeNhlFinalInputCompletenessRecord(
  value: unknown,
): Record<string, NhlFinalInputCompleteness> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: Record<string, NhlFinalInputCompleteness> = {};

  for (const [gameId, rawEvidence] of Object.entries(value)) {
    if (
      !/^\d+$/.test(gameId) ||
      !rawEvidence ||
      typeof rawEvidence !== 'object' ||
      Array.isArray(rawEvidence)
    ) {
      continue;
    }

    const evidence = rawEvidence as Partial<NhlFinalInputCompleteness>;
    const status = COMPLETENESS_CODES.has(evidence.status as NhlFinalInputCompletenessCode)
      ? evidence.status as NhlFinalInputCompletenessCode
      : null;

    if (!status) {
      continue;
    }

    const requiredSources = Array.isArray(evidence.requiredSources)
      ? evidence.requiredSources
          .filter((source): source is NhlFinalInputSource =>
            FINAL_INPUT_SOURCES.has(source as NhlFinalInputSource)
          )
          .slice(0, 4)
      : [];
    const failures = Array.isArray(evidence.failures)
      ? evidence.failures
          .filter((failure): failure is NhlFinalInputFailure => {
            if (!failure || typeof failure !== 'object' || Array.isArray(failure)) {
              return false;
            }

            const candidate = failure as Partial<NhlFinalInputFailure>;
            return FAILURE_CODES.has(
              candidate.code as Exclude<NhlFinalInputCompletenessCode, 'complete'>,
            ) &&
              FINAL_INPUT_SOURCES.has(candidate.source as NhlFinalInputSource);
          })
          .slice(0, 8)
          .map((failure) => ({
            code: failure.code,
            source: failure.source,
            detail: boundedDetail(failure.detail, 'Final NHL input is incomplete.'),
            retryable: failure.retryable === true,
          }))
      : [];
    const sourceVersion = typeof evidence.sourceVersion === 'string' &&
      /^[a-f0-9]{64}$/i.test(evidence.sourceVersion)
        ? evidence.sourceVersion.toLowerCase()
        : '';
    const complete = status === 'complete' &&
      evidence.complete === true &&
      evidence.reusableFinal === true &&
      Boolean(sourceVersion) &&
      hasExactRequiredSourceContract(requiredSources) &&
      failures.length === 0;
    const normalizedStatus = complete
      ? 'complete'
      : status === 'complete' && !sourceVersion
        ? 'incomplete-source-version'
        : status === 'complete'
          ? 'malformed'
          : status;
    const normalizedFailures = complete || status !== 'complete' || failures.length > 0
      ? failures
      : [{
          code: normalizedStatus === 'incomplete-source-version'
            ? 'incomplete-source-version' as const
            : 'malformed' as const,
          source: 'source-version' as const,
          detail: normalizedStatus === 'incomplete-source-version'
            ? 'A deterministic final-input source version was not available.'
            : 'The saved final-input source contract was malformed.',
          retryable: true,
        }];

    normalized[gameId] = {
      status: normalizedStatus,
      complete,
      reusableFinal: complete,
      requiredSources,
      sourceVersion,
      preservedPreviousScore: evidence.preservedPreviousScore === true,
      failures: normalizedFailures,
    };
  }

  return normalized;
}

export function selectIncompleteFinalScoreFallback(input: {
  previousScore: unknown;
  previousAppeared: boolean;
}): {
  score: number | null;
  appeared: boolean;
  preservedPrevious: boolean;
} {
  const hasTrustworthyPrevious = typeof input.previousScore === 'number' &&
    Number.isFinite(input.previousScore);

  return {
    score: hasTrustworthyPrevious
      ? Number((input.previousScore as number).toFixed(1))
      : null,
    appeared: hasTrustworthyPrevious && input.previousAppeared,
    preservedPrevious: hasTrustworthyPrevious,
  };
}
