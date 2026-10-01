import { createHash } from 'node:crypto';
import {
  DraftableAsset,
  DraftPick,
  PlayerWindowContinuity,
} from '../draft/draft.models';
import {
  calculateGoalieGameBreakdown,
  calculateSkaterGameBreakdown,
  GoalieGameStats,
  SkaterGameStats
} from '../scoring/scoring-engine';
import { ScoringRules } from '../scoring/scoring-rules';
import {
  resolveSourceNhlBlockNumber,
  selectCycleWindowGames,
  selectGamesByStableIds,
} from './cycle-window-selection.util';
import {
  compareDirectAndCanonicalGameScore,
  shouldCompareCanonicalScoringParityGame,
  type CanonicalScoringParityGame,
  type CanonicalScoringParityObservation,
} from '../nhl/nhl-canonical-scoring-parity.util';
import {
  decideCanonicalScoringAuthority,
  type CanonicalScoringAuthorityDecision,
} from '../nhl/nhl-canonical-scoring-authority.util';
import {
  findSkaterBoxscoreLine,
  getGameBoxscore,
  getGamePlayByPlay,
  getNhlTeamSeasonSchedule,
  getRegularSeasonGameLog,
  getSkaterAssistBreakdown,
  getTeamGoalieUnitResult,
  NhlApiRefreshProfile,
  NhlGameBoxscoreResponse,
  NhlGamePlayByPlayResponse,
  NhlPlayerGameLogEntry,
  NhlTeamSeasonGame
} from '../nhl/nhl-api.service';
import {
  assessNhlFinalInputCompleteness,
  buildNhlFinalInputSourceVersion,
  classifyNhlFinalInputFailure,
  isReusableNhlFinalScore,
  selectIncompleteFinalScoreFallback,
  validateNhlFinalGoalieUnitBoxscore,
  validateNhlFinalPlayerGameLog,
  validateNhlFinalPlayByPlay,
  validateNhlFinalSkaterBoxscore,
  type NhlFinalInputCompleteness,
  type NhlFinalInputSourceState,
} from '../nhl/nhl-final-input-completeness.util';
import {
  getNhlGameRuntimeState,
  resolveNhlGameRuntimeState,
} from '../nhl/nhl-game-runtime-state.util';
import {
  resolveLivePlayerTeamWindow,
  type ResolvedLivePlayerWindow,
} from './live-player-team-window.util';
import { resolvePlayerWindowContinuity } from './player-window-continuity.util';

export type CycleGameRuntimeState =
  | 'scheduled'
  | 'live'
  | 'final';

export type CycleScoringPhaseName =
  | 'nhl-schedule-load'
  | 'nhl-game-data-load'
  | 'nhl-player-log-load'
  | 'score-calculation';

export interface CycleAssetScoreSummary {
  assetKey: string;
  ownerId: string;
  rosterSlotId: string;
  windowId: string;
  /** NHL six-game schedule block used by this immutable fantasy window. */
  sourceNhlBlockNumber?: number;
  currentScore: number;

  /** Final NHL team games that control six-game window progress. */
  gamesPlayed: number;

  /** Final NHL games where a skater actually appeared. */
  actualGamesPlayed?: number;

  scheduledGames: number;
  gamesLeft: number;
  scheduledGameIds: number[];
  scheduledGameDates: string[];
  scheduledGameLabels: string[];
  /** Current NHL club whose unsettled schedule owns this player window. */
  scheduleTeamAbbreviation?: string;
  /** Per-game club identity preserves games already earned before a trade. */
  sourceTeamAbbreviationByGameId?: Record<string, string>;
  /** True when stable NHL player identity overrode stale roster metadata. */
  teamIdentityChanged?: boolean;
  /** Server-owned active-slot lineage used to prevent game reuse after trades. */
  playerWindowContinuity?: PlayerWindowContinuity;
  /** Compact stint identity; cumulative game history stays out of aggregates. */
  playerWindowContinuityId?: string;
  completedGameIds: number[];
  liveGameIds: number[];
  appearanceGameIds: number[];

  /**
   * Per-game scoring lets later refreshes reuse finalized games instead of
   * downloading every historical boxscore and player game log again.
   */
  gameScores: Record<string, number>;
  gameStates: Record<string, CycleGameRuntimeState>;
  gameInputCompleteness: Record<string, NhlFinalInputCompleteness>;
  incompleteFinalGameIds: number[];

  firstScheduledGameDate: string | null;
  lastScheduledGameDate: string | null;
  status: 'scheduled' | 'active' | 'complete';
}

export interface CycleScoringResult {
  scoringSchemaVersion: 2;

  /** Backward-compatible lookup used by existing asset cards. */
  assetScores: Record<string, CycleAssetScoreSummary>;

  /** Canonical lookup for independent roster-slot windows. */
  windowScores: Record<string, CycleAssetScoreSummary>;

  teamScores: Record<string, number>;
  teamGameCounts: Record<string, number>;
  teamCycleComplete: Record<string, boolean>;

  /**
   * True when at least one drafted roster asset has an NHL team game in this
   * cycle. This prevents empty off-season cycles from completing forever.
   */
  cycleHasScheduledGames: boolean;

  /** Live-game metadata used by the shared scoring scheduler. */
  hasLiveGames: boolean;
  hasIncompleteFinalGames: boolean;
  nextScheduledGameStart: string | null;
  refreshedAt: string;
  dataFingerprint: string;
  /** Exact shared NHL roster identity evidence used for this calculation. */
  nhlPlayerTeamIdentityHash?: string;
  nhlPlayerTeamIdentityGeneratedAt?: string;
}

export interface CalculateCycleScoringInput {
  picks: DraftPick[];
  cycleNumber: number;
  season: string;
  requiredGamesPerCycle: number;
  scoringRules: ScoringRules;

  /**
   * Expected persistent slot ids for each team. This prevents a partially
   * opened overlapping cycle from being marked complete before every slot has
   * entered that cycle.
   */
  expectedRosterSlotIdsByOwner?: Record<string, string[]>;

  /** Previous shared result used for incremental final-game reuse. */
  previousResult?: CycleScoringResult | null;

  /**
   * One server-owned current NHL roster catalog shared by the whole scoring
   * run. Stable player id, rather than mutable roster metadata, chooses the
   * live club schedule after a trade.
   */
  currentTeamAbbreviationByPlayerId?: ReadonlyMap<number, string>;

  /**
   * Exact initial-block game ids frozen for every NHL club. This lets a
   * pre-bootstrap trade choose the new club's already-frozen schedule.
   */
  sourceNhlTargetGameIdsByTeam?: Readonly<Record<string, number[]>>;

  /** Complete draft-frozen NHL schedule plan used for trade continuations. */
  seasonSourceGameIdsByTeam?: Readonly<Record<string, number[]>>;

  /** Provenance for the stable player-to-current-club catalog. */
  currentTeamIdentityHash?: string;
  currentTeamIdentityGeneratedAt?: string;
  currentTeamConfirmedAtByPlayerId?: ReadonlyMap<number, string>;

  /**
   * Optional commissioner historical-replay schedules. Each asset receives a
   * synthetic target-season schedule whose game ids point to source-season
   * boxscores. This keeps the normal immutable six-game selection logic while
   * allowing the simulated calendar to decide which team games are final.
   */
  replayGamesByAssetKey?: Record<string, NhlTeamSeasonGame[]>;

  /**
   * Replay-only source-team identity for each mapped source game. Historical
   * boxscores must be validated against the team the player belonged to in
   * the source season, never the target-season team used for replay dates.
   */
  replaySourceTeamAbbreviationByAssetGameId?: Record<string, Record<string, string>>;

  /** Source season used for historical player game logs during replay. */
  gameLogSeason?: string;

  /**
   * Ordinary leagues keep the proven cache windows. Only an exact internal
   * near-live Canary asks for fresher schedule and live game responses.
   */
  nhlRefreshProfile?: NhlApiRefreshProfile;

  /** Optional server-only phase timing sink. It never changes scoring output. */
  onPhaseDuration?: (
    phase: CycleScoringPhaseName,
    durationMilliseconds: number,
  ) => void;

  /**
   * Optional server-only canonical game facts used only for shadow parity.
   * Direct NHL data remains the scoring authority in D1G.
   */
  canonicalParityGamesById?: ReadonlyMap<number, CanonicalScoringParityGame>;

  /** Exact game ids carried by the current canonical queue task. */
  canonicalParityRequestedGameIds?: ReadonlySet<number>;

  /** Bounded observation sink for direct-vs-canonical shadow comparison. */
  onCanonicalParityObservation?: (
    observation: CanonicalScoringParityObservation,
  ) => void;

  /**
   * Enables the single-league canonical-read Canary. The direct result is
   * still calculated in the same task and remains the automatic fallback.
   */
  canonicalAuthorityConfigured?: boolean;

  /** The queued task must carry the exact canonical game/version set. */
  canonicalAuthorityTaskVersionAligned?: boolean;

  /** Bounded server-only evidence sink for canonical-use/fallback decisions. */
  onCanonicalAuthorityDecision?: (
    decision: CanonicalScoringAuthorityDecision,
  ) => void;

  /** Kept optional for older callers. Scoring is based on NHL game numbers. */
  startDate?: Date;
  endDate?: Date;
}

export class NhlPlayerTeamIdentityBoundaryRefreshRequiredError extends Error {
  readonly code = 'nhl-player-team-identity-boundary-refresh-required';

  constructor(readonly minimumGeneratedAtMilliseconds: number) {
    super(
      'NHL player-team identity predates a game that has now started. ' +
      'Scoring requires a post-puck-drop roster refresh before ownership can be frozen.',
    );
    this.name = 'NhlPlayerTeamIdentityBoundaryRefreshRequiredError';
  }
}

interface ScoringGameData {
  boxscore?: NhlGameBoxscoreResponse;
  playByPlay?: NhlGamePlayByPlayResponse;
  boxscoreState: NhlFinalInputSourceState;
  playByPlayState: NhlFinalInputSourceState;
}

interface SkaterGameLogLoad {
  gameLog: NhlPlayerGameLogEntry[];
  gameLogByGameId: Map<number, NhlPlayerGameLogEntry>;
  sourceState: NhlFinalInputSourceState;
}

interface GameScoreResult {
  points: number;
  appeared: boolean;
}

function selectCanonicalAuthorityGameResult(input: {
  scoringInput: CalculateCycleScoringInput;
  observation: CanonicalScoringParityObservation;
}): GameScoreResult {
  input.scoringInput.onCanonicalParityObservation?.(input.observation);

  const decision = decideCanonicalScoringAuthority({
    configured: input.scoringInput.canonicalAuthorityConfigured === true,
    taskVersionAligned:
      input.scoringInput.canonicalAuthorityTaskVersionAligned === true,
    observation: input.observation,
  });

  input.scoringInput.onCanonicalAuthorityDecision?.(decision);

  return {
    points: decision.selectedPoints,
    appeared: decision.selectedAppeared,
  };
}

const NHL_SCORING_BATCH_SIZE = 6;
const NHL_SCORING_BATCH_DELAY_MS = 125;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function rounded(value: number): number {
  return Number(value.toFixed(1));
}

function isRegularSeasonGame(game: NhlTeamSeasonGame): boolean {
  return typeof game.gameType !== 'number' || game.gameType === 2;
}

function getGameRuntimeState(
  game: NhlTeamSeasonGame
): CycleGameRuntimeState {
  return getNhlGameRuntimeState(game);
}

function getEffectiveGameRuntimeState(
  game: NhlTeamSeasonGame,
  gameData: ScoringGameData | undefined,
): CycleGameRuntimeState {
  return resolveNhlGameRuntimeState({
    schedule: game,
    boxscore: gameData?.boxscore,
  });
}

function timestampMilliseconds(value: unknown): number | null {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const toMillis = candidate['toMillis'];

  if (typeof toMillis === 'function') {
    const milliseconds = toMillis.call(value);
    return typeof milliseconds === 'number' && Number.isFinite(milliseconds)
      ? milliseconds
      : null;
  }

  const seconds = candidate['seconds'] ?? candidate['_seconds'];
  const nanoseconds = candidate['nanoseconds'] ?? candidate['_nanoseconds'];

  return typeof seconds === 'number' && Number.isFinite(seconds)
    ? seconds * 1000 + (
        typeof nanoseconds === 'number' && Number.isFinite(nanoseconds)
          ? nanoseconds / 1_000_000
          : 0
      )
    : null;
}

function gameStartMilliseconds(game: NhlTeamSeasonGame): number | null {
  if (typeof game.startTimeUTC !== 'string' || !game.startTimeUTC.trim()) {
    return null;
  }

  const parsed = Date.parse(game.startTimeUTC);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Limits finalized appearance proof to the player's latest uninterrupted NHL
 * affiliation. This prevents A -> B -> A from reusing an appearance from the
 * earlier A stint merely because the stable player id is the same.
 */
export function getCurrentAffiliationAppearanceGameIds(
  gameLog: readonly NhlPlayerGameLogEntry[],
  currentTeamAbbreviation: string,
): number[] {
  const currentTeam = currentTeamAbbreviation.trim().toUpperCase();
  const ordered = [...gameLog]
    .filter((entry) => Number.isSafeInteger(entry.gameId) && entry.gameId > 0)
    .sort((first, second) =>
      first.gameDate.localeCompare(second.gameDate) ||
      first.gameId - second.gameId
    );
  let latestDifferentTeamIndex = -1;

  ordered.forEach((entry, index) => {
    if (entry.teamAbbrev?.trim().toUpperCase() !== currentTeam) {
      latestDifferentTeamIndex = index;
    }
  });

  return ordered
    .slice(latestDifferentTeamIndex + 1)
    .filter((entry) => entry.teamAbbrev?.trim().toUpperCase() === currentTeam)
    .map((entry) => entry.gameId);
}

function getAssetTeamAbbreviation(asset: DraftableAsset): string {
  return asset.assetType === 'skater'
    ? asset.player.nhlTeamAbbreviation
    : asset.teamAbbreviation;
}

/**
 * Resolves exact provider IDs for one pick without allowing a later fantasy
 * cycle's all-team map to overwrite an older banked playoff window. If the
 * player's NHL club changed, the pick-level all-team map supplies the new
 * club's IDs for the pick's own immutable source block.
 */
export function resolveFrozenTargetGameIdsForPick(
  pick: DraftPick,
  scheduleTeamAbbreviation: string,
  fallbackTargetGameIdsByTeam?: Readonly<Record<string, number[]>>,
): number[] | undefined {
  const storedTeamAbbreviation = getAssetTeamAbbreviation(pick.asset)
    .trim()
    .toUpperCase();
  const targetTeamAbbreviation = scheduleTeamAbbreviation.trim().toUpperCase();

  if (targetTeamAbbreviation === storedTeamAbbreviation) {
    return pick.sourceNhlTargetGameIds ??
      pick.sourceNhlTargetGameIdsByTeam?.[targetTeamAbbreviation] ??
      fallbackTargetGameIdsByTeam?.[targetTeamAbbreviation];
  }

  return pick.sourceNhlTargetGameIdsByTeam?.[targetTeamAbbreviation] ??
    fallbackTargetGameIdsByTeam?.[targetTeamAbbreviation];
}

function getRosterSlotId(pick: DraftPick): string {
  return pick.rosterSlotId ?? `legacy-pick-${pick.overallPick}`;
}

function getWindowId(pick: DraftPick, cycleNumber: number): string {
  return pick.cycleWindowId ??
    `${pick.ownerId}__${getRosterSlotId(pick)}__cycle-${cycleNumber}`;
}

function getPickWindowCycleNumber(
  pick: DraftPick,
  fallbackCycleNumber: number
): number {
  return pick.snapshotCycleNumber ?? fallbackCycleNumber;
}

function getPickSourceNhlBlockNumber(
  pick: DraftPick,
  fallbackCycleNumber: number,
): number {
  return resolveSourceNhlBlockNumber(
    pick.sourceNhlBlockNumber,
    getPickWindowCycleNumber(pick, fallbackCycleNumber),
  );
}

function getMinutesFromToi(toi: string | undefined): number {
  if (!toi) {
    return 0;
  }

  const [minutesRaw, secondsRaw] = toi.split(':');
  const minutes = Number(minutesRaw);
  const seconds = Number(secondsRaw);

  if (Number.isNaN(minutes) || Number.isNaN(seconds)) {
    return 0;
  }

  return Number((minutes + seconds / 60).toFixed(2));
}

function getUniqueDraftedTeams(
  input: CalculateCycleScoringInput,
): string[] {
  const teams = new Set<string>();

  for (const pick of input.picks) {
    teams.add(getAssetTeamAbbreviation(pick.asset));

    if (pick.asset.assetType === 'skater') {
      const currentTeam = input.currentTeamAbbreviationByPlayerId
        ?.get(pick.asset.player.id)
        ?.trim()
        .toUpperCase();

      if (currentTeam) {
        teams.add(currentTeam);
      }
    }
  }

  for (const summary of Object.values(
    input.previousResult?.windowScores ?? {},
  )) {
    if (summary.scheduleTeamAbbreviation) {
      teams.add(summary.scheduleTeamAbbreviation.trim().toUpperCase());
    }

    for (const sourceTeam of Object.values(
      summary.sourceTeamAbbreviationByGameId ?? {},
    )) {
      if (sourceTeam) {
        teams.add(sourceTeam.trim().toUpperCase());
      }
    }
  }

  return [...teams].filter(Boolean).sort();
}

function getUniqueSkaterAssets(picks: DraftPick[]): DraftableAsset[] {
  const skatersByKey = new Map<string, DraftableAsset>();

  for (const pick of picks) {
    if (pick.asset.assetType === 'skater') {
      skatersByKey.set(pick.asset.assetKey, pick.asset);
    }
  }

  return [...skatersByKey.values()];
}

function isStructurallyValidBoxscore(
  value: NhlGameBoxscoreResponse,
): boolean {
  return typeof value?.homeTeam?.abbrev === 'string' &&
    value.homeTeam.abbrev.trim().length > 0 &&
    typeof value.homeTeam.score === 'number' &&
    Number.isFinite(value.homeTeam.score) &&
    typeof value?.awayTeam?.abbrev === 'string' &&
    value.awayTeam.abbrev.trim().length > 0 &&
    typeof value.awayTeam.score === 'number' &&
    Number.isFinite(value.awayTeam.score) &&
    Boolean(value.playerByGameStats?.homeTeam) &&
    Boolean(value.playerByGameStats?.awayTeam);
}

function isStructurallyValidPlayByPlay(
  value: NhlGamePlayByPlayResponse,
): boolean {
  return Array.isArray(value?.plays);
}

async function loadSchedulesByTeam(
  teamAbbreviations: string[],
  season: string,
  refreshProfile: NhlApiRefreshProfile,
): Promise<Record<string, NhlTeamSeasonGame[]>> {
  const schedulesByTeam: Record<string, NhlTeamSeasonGame[]> = {};

  for (
    let index = 0;
    index < teamAbbreviations.length;
    index += NHL_SCORING_BATCH_SIZE
  ) {
    const batch = teamAbbreviations.slice(
      index,
      index + NHL_SCORING_BATCH_SIZE
    );

    const results = await Promise.allSettled(
      batch.map(async (teamAbbreviation) => {
        const schedule = await getNhlTeamSeasonSchedule(
          teamAbbreviation,
          season,
          refreshProfile,
        );

        return {
          teamAbbreviation,
          schedule: schedule
            .filter(isRegularSeasonGame)
            .sort((first, second) => {
              const dateCompare = first.gameDate.localeCompare(second.gameDate);

              if (dateCompare !== 0) {
                return dateCompare;
              }

              return first.id - second.id;
            })
        };
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        schedulesByTeam[result.value.teamAbbreviation] = result.value.schedule;
      } else {
        console.warn('Unable to load scoring schedule.', result.reason);
      }
    }

    if (index + NHL_SCORING_BATCH_SIZE < teamAbbreviations.length) {
      await wait(NHL_SCORING_BATCH_DELAY_MS);
    }
  }

  return schedulesByTeam;
}

async function loadScoringGameData(
  gameIds: number[],
  refreshProfile: NhlApiRefreshProfile,
): Promise<Map<number, ScoringGameData>> {
  const gameDataById = new Map<number, ScoringGameData>();

  for (
    let index = 0;
    index < gameIds.length;
    index += NHL_SCORING_BATCH_SIZE
  ) {
    const batch = gameIds.slice(index, index + NHL_SCORING_BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(async (gameId) => {
        const [boxscoreResult, playByPlayResult] = await Promise.allSettled([
          getGameBoxscore(gameId, refreshProfile),
          getGamePlayByPlay(gameId, refreshProfile)
        ]);
        const boxscore = boxscoreResult.status === 'fulfilled' &&
          isStructurallyValidBoxscore(boxscoreResult.value)
            ? boxscoreResult.value
            : undefined;
        const playByPlay = playByPlayResult.status === 'fulfilled' &&
          isStructurallyValidPlayByPlay(playByPlayResult.value)
            ? playByPlayResult.value
            : undefined;

        return {
          gameId,
          data: {
            boxscore,
            playByPlay,
            boxscoreState: boxscore
              ? { availability: 'available' as const }
              : boxscoreResult.status === 'rejected'
                ? classifyNhlFinalInputFailure(boxscoreResult.reason)
                : {
                    availability: 'malformed' as const,
                    detail: 'NHL boxscore payload was missing required final-game fields.',
                  },
            playByPlayState: playByPlay
              ? { availability: 'available' as const }
              : playByPlayResult.status === 'rejected'
                ? classifyNhlFinalInputFailure(playByPlayResult.reason)
                : {
                    availability: 'malformed' as const,
                    detail: 'NHL play-by-play payload did not contain a plays array.',
                  },
          }
        };
      })
    );

    results.forEach((result, resultIndex) => {
      if (result.status === 'fulfilled') {
        gameDataById.set(result.value.gameId, result.value.data);
      } else {
        console.warn('Unable to load NHL game scoring data.', result.reason);
        const sourceState = classifyNhlFinalInputFailure(result.reason);
        gameDataById.set(batch[resultIndex], {
          boxscoreState: sourceState,
          playByPlayState: sourceState,
        });
      }
    });

    if (index + NHL_SCORING_BATCH_SIZE < gameIds.length) {
      await wait(NHL_SCORING_BATCH_DELAY_MS);
    }
  }

  return gameDataById;
}

async function loadSkaterGameLogs(
  skaters: DraftableAsset[],
  season: string
): Promise<Map<number, SkaterGameLogLoad>> {
  const gameLogsByPlayerId = new Map<number, SkaterGameLogLoad>();

  for (
    let index = 0;
    index < skaters.length;
    index += NHL_SCORING_BATCH_SIZE
  ) {
    const batch = skaters.slice(index, index + NHL_SCORING_BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(async (asset) => {
        if (asset.assetType !== 'skater') {
          throw new Error(
            'Non-skater asset passed to skater game log loader.'
          );
        }

        /*
         * These players have a newly final game. Force one fresh log so
         * power-play, short-handed, game-winning, and overtime bonuses settle
         * accurately. Old finalized games are reused from the shared snapshot.
         */
        const gameLogResponse = await getRegularSeasonGameLog(
          asset.player.id,
          season,
          true
        );

        if (!Array.isArray(gameLogResponse.gameLog)) {
          return {
            playerId: asset.player.id,
            gameLog: [],
            gameLogByGameId: new Map<number, NhlPlayerGameLogEntry>(),
            sourceState: {
              availability: 'malformed' as const,
              detail: 'NHL player game-log payload did not contain a gameLog array.',
            },
          };
        }

        const gameLogByGameId = new Map<number, NhlPlayerGameLogEntry>();

        for (const gameLog of gameLogResponse.gameLog) {
          gameLogByGameId.set(gameLog.gameId, gameLog);
        }

        return {
          playerId: asset.player.id,
          gameLog: gameLogResponse.gameLog,
          gameLogByGameId,
          sourceState: { availability: 'available' as const },
        };
      })
    );

    results.forEach((result, resultIndex) => {
      if (result.status === 'fulfilled') {
        gameLogsByPlayerId.set(
          result.value.playerId,
          {
            gameLog: result.value.gameLog,
            gameLogByGameId: result.value.gameLogByGameId,
            sourceState: result.value.sourceState,
          },
        );
      } else {
        console.warn('Unable to load newly final skater game log.', result.reason);
        const asset = batch[resultIndex];

        if (asset.assetType === 'skater') {
          gameLogsByPlayerId.set(asset.player.id, {
            gameLog: [],
            gameLogByGameId: new Map<number, NhlPlayerGameLogEntry>(),
            sourceState: classifyNhlFinalInputFailure(result.reason),
          });
        }
      }
    });

    if (index + NHL_SCORING_BATCH_SIZE < skaters.length) {
      await wait(NHL_SCORING_BATCH_DELAY_MS);
    }
  }

  return gameLogsByPlayerId;
}

function getFinalGameInputCompleteness(input: {
  asset: DraftableAsset;
  gameId: number;
  gameData: ScoringGameData | undefined;
  playerLogLoad: SkaterGameLogLoad | undefined;
  sourceTeamAbbreviation?: string;
  requireSourceTeamAbbreviation?: boolean;
}): NhlFinalInputCompleteness {
  let boxscoreState = input.gameData?.boxscoreState ?? {
    availability: 'temporarily-unavailable' as const,
    detail: 'NHL boxscore result was omitted from the scoring batch.',
  };
  const replaySourceTeamAbbreviation = input.sourceTeamAbbreviation
    ?.trim()
    .toUpperCase();
  const validReplaySourceTeamAbbreviation =
    replaySourceTeamAbbreviation && /^[A-Z0-9]{2,4}$/.test(replaySourceTeamAbbreviation)
      ? replaySourceTeamAbbreviation
      : null;
  const assetTeamAbbreviation = validReplaySourceTeamAbbreviation ??
    getAssetTeamAbbreviation(input.asset).trim().toUpperCase();
  const boxscore = input.gameData?.boxscore;

  if (input.requireSourceTeamAbbreviation && !validReplaySourceTeamAbbreviation) {
    boxscoreState = {
      availability: 'temporarily-unavailable',
      detail: 'Historical replay source-team identity is unavailable for this final game.',
    };
  } else if (boxscoreState.availability === 'available' && boxscore) {
    boxscoreState = input.asset.assetType === 'skater'
      ? validateNhlFinalSkaterBoxscore({
          boxscore,
          teamAbbreviation: assetTeamAbbreviation,
          playerId: input.asset.player.id,
        })
      : validateNhlFinalGoalieUnitBoxscore({
          boxscore,
          teamAbbreviation: assetTeamAbbreviation,
        });
  }
  let playByPlayState: NhlFinalInputSourceState = input.asset.assetType === 'skater'
    ? input.gameData?.playByPlayState ?? {
        availability: 'temporarily-unavailable' as const,
        detail: 'NHL play-by-play result was omitted from the scoring batch.',
      }
    : { availability: 'not-required' as const };

  if (
    input.asset.assetType === 'skater' &&
    playByPlayState.availability === 'available' &&
    input.gameData?.playByPlay
  ) {
    playByPlayState = validateNhlFinalPlayByPlay(input.gameData.playByPlay);
  }

  let playerLogState: NhlFinalInputSourceState =
    input.asset.assetType === 'skater'
      ? input.playerLogLoad?.sourceState ?? {
          availability: 'temporarily-unavailable' as const,
          detail: 'NHL player game-log result was omitted from the scoring batch.',
        }
      : { availability: 'not-required' as const };

  if (
    input.asset.assetType === 'skater' &&
    playerLogState.availability === 'available' &&
    input.playerLogLoad
  ) {
    playerLogState = validateNhlFinalPlayerGameLog({
      gameLog: input.playerLogLoad.gameLog,
      gameId: input.gameId,
      appeared: Boolean(
        input.gameData?.boxscore &&
        findSkaterBoxscoreLine(input.gameData.boxscore, input.asset.player.id)
      ),
    }).sourceState;
  }
  let sourceVersion = '';
  const requiredSourcesAvailable = boxscoreState.availability === 'available' &&
    (
      input.asset.assetType === 'team-goalie-unit' ||
      (
        playByPlayState.availability === 'available' &&
        playerLogState.availability === 'available'
      )
    );

  if (requiredSourcesAvailable) {
    try {
      sourceVersion = buildNhlFinalInputSourceVersion({
        schemaVersion: 1,
        gameId: input.gameId,
        assetType: input.asset.assetType,
        assetKey: input.asset.assetKey,
        boxscore: input.gameData?.boxscore,
        ...(input.asset.assetType === 'skater'
          ? {
              playByPlay: input.gameData?.playByPlay,
              playerGameLog:
                input.playerLogLoad?.gameLogByGameId.get(input.gameId) ?? null,
              playerGameLogRetrieved: true,
            }
          : {}),
      });
    } catch (error: unknown) {
      console.warn('Unable to create a deterministic final-input source version.', {
        gameId: input.gameId,
        assetKey: input.asset.assetKey,
        error,
      });
    }
  }

  return assessNhlFinalInputCompleteness({
    assetType: input.asset.assetType,
    boxscore: boxscoreState,
    playByPlay: playByPlayState,
    playerLog: playerLogState,
    sourceVersion,
  });
}

function getRelevantAssetGames(
  pick: DraftPick,
  schedulesByTeam: Record<string, NhlTeamSeasonGame[]>,
  sourceNhlBlockNumber: number,
  requiredGamesPerCycle: number,
  previous: CycleAssetScoreSummary | undefined,
  replayGamesByAssetKey?: Record<string, NhlTeamSeasonGame[]>,
  currentTeamAbbreviationByPlayerId?: ReadonlyMap<number, string>,
  currentTeamConfirmedAtByPlayerId?: ReadonlyMap<number, string>,
  sourceNhlTargetGameIdsByTeam?: Readonly<Record<string, number[]>>,
  seasonSourceGameIdsByTeam?: Readonly<Record<string, number[]>>,
  confirmedCurrentTeamAppearanceGameIdsByPlayerId?: ReadonlyMap<
    number,
    ReadonlySet<number>
  >,
): ResolvedLivePlayerWindow {
  const replaySchedule = replayGamesByAssetKey?.[pick.asset.assetKey];

  if (replaySchedule) {
    const teamAbbreviation = getAssetTeamAbbreviation(pick.asset);
    // Replay schedules are explicit historical evidence assembled for that
    // replay. Initial live-season anchor ids belong to the provider schedule
    // frozen at draft cutoff and must never be resolved against synthetic or
    // historical replay fixtures whose ids can come from a different season.
    const games = selectCycleWindowGames(
      replaySchedule,
      sourceNhlBlockNumber,
      requiredGamesPerCycle,
    );

    return {
      games,
      scheduleTeamAbbreviation: teamAbbreviation,
      sourceTeamAbbreviationByGameId: Object.fromEntries(
        games.map((game) => [String(game.id), teamAbbreviation]),
      ),
      teamIdentityChanged: false,
    };
  }

  const storedTeamAbbreviation = getAssetTeamAbbreviation(pick.asset).trim().toUpperCase();
  const currentTeamFromIdentity = pick.asset.assetType === 'skater'
    ? currentTeamAbbreviationByPlayerId?.get(pick.asset.player.id)?.trim().toUpperCase()
    : undefined;

  if (
    pick.asset.assetType === 'skater' &&
    currentTeamAbbreviationByPlayerId &&
    !currentTeamFromIdentity
  ) {
    throw new Error(
      `Current NHL team identity is unavailable for rostered player ${pick.asset.player.id}. Scoring was left unchanged and will retry.`,
    );
  }

  const currentTeamAbbreviation = currentTeamFromIdentity || storedTeamAbbreviation;
  const rosterSlotId = getRosterSlotId(pick);
  const playerWindowContinuity = resolvePlayerWindowContinuity({
    value: pick.playerWindowContinuity,
    ownerId: pick.ownerId,
    rosterSlotId,
    asset: pick.asset,
  });
  const frozenTargetGameIds = replayGamesByAssetKey
    ? undefined
    : resolveFrozenTargetGameIdsForPick(
        pick,
        currentTeamAbbreviation,
        sourceNhlTargetGameIdsByTeam,
      );
  const currentTeamSeasonSourceGameIds = seasonSourceGameIdsByTeam
    ? seasonSourceGameIdsByTeam[currentTeamAbbreviation]
    : undefined;

  if (
    seasonSourceGameIdsByTeam &&
    !Object.prototype.hasOwnProperty.call(
      seasonSourceGameIdsByTeam,
      currentTeamAbbreviation,
    )
  ) {
    throw new Error(
      `The frozen NHL season plan is missing ${currentTeamAbbreviation}. Scoring was left unchanged and will retry.`,
    );
  }

  const rawConfirmedAppearanceGameIds = pick.asset.assetType === 'skater'
    ? confirmedCurrentTeamAppearanceGameIdsByPlayerId?.get(
        pick.asset.player.id,
      )
    : undefined;
  const activationMilliseconds = timestampMilliseconds(pick.snapshottedAt);
  const teamConfirmedAtMilliseconds = timestampMilliseconds(
    pick.asset.assetType === 'skater'
      ? currentTeamConfirmedAtByPlayerId?.get(pick.asset.player.id)
      : undefined,
  );
  const priorScheduleTeamAbbreviation = (
    previous?.scheduleTeamAbbreviation ??
    playerWindowContinuity?.lastScheduleTeamAbbreviation ??
    storedTeamAbbreviation
  ).trim().toUpperCase();
  const teamCutoverDetected =
    pick.asset.assetType === 'skater' &&
    priorScheduleTeamAbbreviation !== currentTeamAbbreviation;
  const frozenTargetGameIdSet = new Set(frozenTargetGameIds ?? []);
  const continuityCameFromRosterMove = Boolean(
    playerWindowContinuity?.continuityId.includes('::move-') ||
    pick.snapshotSource?.includes('move'),
  );
  const assignmentNotBeforeMilliseconds = continuityCameFromRosterMove
    ? activationMilliseconds ?? undefined
    : undefined;
  const teamIdentityNotBeforeMilliseconds = teamCutoverDetected
    ? teamConfirmedAtMilliseconds ?? undefined
    : undefined;

  if (teamCutoverDetected && teamConfirmedAtMilliseconds === null) {
    throw new Error(
      `Current NHL team-change timestamp is unavailable for ${pick.asset.assetKey}. ` +
      'Scoring was left unchanged and will retry.',
    );
  }

  if (continuityCameFromRosterMove && activationMilliseconds === null) {
    throw new Error(
      `Roster-move activation time is unavailable for ${pick.asset.assetKey}. Scoring was left unchanged and will retry.`,
    );
  }
  const currentScheduleByGameId = new Map(
    (schedulesByTeam[currentTeamAbbreviation] ?? []).map((game) => [game.id, game] as const),
  );
  const confirmedCurrentTeamAppearanceGameIds = new Set(
    [...(rawConfirmedAppearanceGameIds ?? [])].filter((gameId) => {
      const game = currentScheduleByGameId.get(gameId);
      const startMilliseconds = game ? gameStartMilliseconds(game) : null;

      if (
        activationMilliseconds !== null &&
        startMilliseconds !== null &&
        startMilliseconds >= activationMilliseconds
      ) {
        return true;
      }

      return !continuityCameFromRosterMove && frozenTargetGameIdSet.has(gameId);
    }),
  );

  return resolveLivePlayerTeamWindow({
    asset: pick.asset,
    schedulesByTeam,
    cycleNumber: sourceNhlBlockNumber,
    requiredGamesPerCycle,
    previous,
    currentTeamAbbreviation,
    sourceNhlTargetGameIds: frozenTargetGameIds,
    priorAssignedGameIds:
      playerWindowContinuity?.priorAssignedGameIds,
    continuityScheduleTeamAbbreviation:
      playerWindowContinuity?.lastScheduleTeamAbbreviation,
    seasonSourceGameIds:
      currentTeamSeasonSourceGameIds,
    confirmedCurrentTeamAppearanceGameIds:
      confirmedCurrentTeamAppearanceGameIds,
    assignmentNotBeforeMilliseconds,
    teamIdentityNotBeforeMilliseconds,
  });
}

function calculateSkaterGameScore(
  asset: DraftableAsset,
  gameData: ScoringGameData | undefined,
  gameLog: NhlPlayerGameLogEntry | undefined,
  gameIsFinal: boolean,
  scoringRules: ScoringRules
): GameScoreResult {
  if (asset.assetType !== 'skater') {
    return {
      points: 0,
      appeared: false
    };
  }

  const skaterLine = gameData?.boxscore
    ? findSkaterBoxscoreLine(gameData.boxscore, asset.player.id)
    : null;

  if (!skaterLine && !gameLog) {
    return {
      points: 0,
      appeared: false
    };
  }

  const assistBreakdown = gameData?.playByPlay
    ? getSkaterAssistBreakdown(gameData.playByPlay, asset.player.id)
    : {
        primaryAssists: 0,
        secondaryAssists: 0
      };

  const totalAssists = skaterLine?.assists ?? gameLog?.assists ?? 0;
  let primaryAssists = assistBreakdown.primaryAssists;
  let secondaryAssists = assistBreakdown.secondaryAssists;

  if (primaryAssists + secondaryAssists < totalAssists) {
    secondaryAssists += totalAssists - primaryAssists - secondaryAssists;
  }

  const stats: SkaterGameStats = {
    position: asset.position === 'D' ? 'D' : 'F',
    goals: skaterLine?.goals ?? gameLog?.goals ?? 0,
    primaryAssists,
    secondaryAssists,
    shotsOnGoal: skaterLine?.sog ?? gameLog?.shots ?? 0,
    hits: skaterLine?.hits ?? 0,
    blockedShots: skaterLine?.blockedShots ?? 0,
    plusMinus: skaterLine?.plusMinus ?? gameLog?.plusMinus ?? 0,

    /*
     * Live boxscores expose power-play goals but not every PP/SH assist bonus.
     * The newly final player log settles those bonuses after the game ends.
     */
    powerPlayPoints: gameIsFinal
      ? gameLog?.powerPlayPoints ?? skaterLine?.powerPlayGoals ?? 0
      : skaterLine?.powerPlayGoals ?? 0,
    shortHandedPoints: gameIsFinal
      ? gameLog?.shorthandedPoints ?? 0
      : 0,
    gameWinningGoal: gameIsFinal && Boolean(gameLog?.gameWinningGoals),
    overtimeGoal: gameIsFinal && Boolean(gameLog?.otGoals),
    timeOnIceMinutes: getMinutesFromToi(skaterLine?.toi ?? gameLog?.toi)
  };

  return {
    points: rounded(
      calculateSkaterGameBreakdown(stats, scoringRules).total
    ),
    appeared: true
  };
}

function calculateGoalieUnitGameScore(
  asset: DraftableAsset,
  gameData: ScoringGameData | undefined,
  gameIsFinal: boolean,
  scoringRules: ScoringRules
): GameScoreResult {
  if (asset.assetType === 'skater' || !gameData?.boxscore) {
    return {
      points: 0,
      appeared: false
    };
  }

  const goalieResult = getTeamGoalieUnitResult(
    gameData.boxscore,
    asset.teamAbbreviation
  );

  if (!goalieResult) {
    return {
      points: 0,
      appeared: false
    };
  }

  const stats: GoalieGameStats = {
    saves: goalieResult.saves,
    shotsAgainst: goalieResult.shotsAgainst,
    won: gameIsFinal && goalieResult.won,
    shutout: gameIsFinal && goalieResult.shutout
  };

  return {
    points: rounded(
      calculateGoalieGameBreakdown(stats, scoringRules).total
    ),
    appeared: true
  };
}

function canReuseFinalGame(
  previous: CycleAssetScoreSummary | undefined,
  gameId: number,
  assetType: DraftableAsset['assetType'],
): boolean {
  const key = String(gameId);

  return isReusableNhlFinalScore({
    assetType,
    gameState: previous?.gameStates?.[key],
    score: previous?.gameScores?.[key],
    completeness: previous?.gameInputCompleteness?.[key],
  });
}

function getPreviousWindowSummary(
  previousResult: CycleScoringResult | null | undefined,
  windowId: string,
  assetKey: string,
  expectedContinuityId?: string,
): CycleAssetScoreSummary | undefined {
  const previousWindow = previousResult?.windowScores?.[windowId];
  const continuityMatches = (summary: CycleAssetScoreSummary | undefined) =>
    !expectedContinuityId ||
    summary?.playerWindowContinuityId === expectedContinuityId ||
    (
      !summary?.playerWindowContinuityId &&
      !expectedContinuityId.includes('::move-')
    );

  // A recovery pass may replace an incorrectly snapshotted outgoing player
  // with the queued incoming player while retaining the same roster-slot
  // window id. Never reuse finalized game scores from a different asset.
  if (
    previousWindow?.assetKey === assetKey &&
    continuityMatches(previousWindow)
  ) {
    return previousWindow;
  }

  const previousAsset = previousResult?.assetScores?.[assetKey];
  return continuityMatches(previousAsset) ? previousAsset : undefined;
}

function getNextScheduledStart(
  games: NhlTeamSeasonGame[]
): string | null {
  const candidates = games
    .filter((game) => getGameRuntimeState(game) === 'scheduled')
    .map((game) => game.startTimeUTC ?? `${game.gameDate}T12:00:00Z`)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((first, second) => Date.parse(first) - Date.parse(second));

  return candidates[0] ?? null;
}

function buildResultFingerprint(
  cycleNumber: number,
  windowScores: Record<string, CycleAssetScoreSummary>,
  currentPickIdentityDigest?: string,
): string {
  return [
    `cycle:${cycleNumber}`,
    `nhl-player-team-identity-subset-v1:${currentPickIdentityDigest ?? 'not-supplied'}`,
    ...Object.values(windowScores)
      .sort((first, second) => first.windowId.localeCompare(second.windowId))
      .map((summary) => [
        summary.windowId,
        `nhl-block-${resolveSourceNhlBlockNumber(summary.sourceNhlBlockNumber, cycleNumber)}`,
        summary.currentScore.toFixed(1),
        summary.gamesPlayed,
        summary.actualGamesPlayed ?? 0,
        summary.status,
        summary.completedGameIds.join(','),
        summary.incompleteFinalGameIds.join(','),
        summary.liveGameIds.join(','),
        summary.scheduleTeamAbbreviation ?? '',
        summary.teamIdentityChanged ? 'team-updated' : 'team-stored',
        summary.playerWindowContinuityId ?? 'legacy-continuity',
        Object.entries(summary.sourceTeamAbbreviationByGameId ?? {})
          .sort(([first], [second]) => first.localeCompare(second))
          .map(([gameId, team]) => `${gameId}:${team}`)
          .join(','),
        Object.entries(summary.gameScores)
          .sort(([first], [second]) => first.localeCompare(second))
          .map(([gameId, score]) => `${gameId}:${score.toFixed(1)}`)
          .join(','),
        Object.entries(summary.gameInputCompleteness)
          .sort(([first], [second]) => first.localeCompare(second))
          .map(([gameId, evidence]) => [
            gameId,
            evidence.status,
            evidence.sourceVersion,
            evidence.preservedPreviousScore ? 'preserved' : 'fresh',
            evidence.failures.map((failure) => `${failure.code}:${failure.source}`).join('+'),
          ].join(':'))
          .join(','),
      ].join(':'))
  ].join('|');
}

function buildCurrentPickIdentityDigest(
  picks: DraftPick[],
  currentTeamAbbreviationByPlayerId?: ReadonlyMap<number, string>,
  currentTeamConfirmedAtByPlayerId?: ReadonlyMap<number, string>,
): string | undefined {
  if (!currentTeamAbbreviationByPlayerId) {
    return undefined;
  }

  const playerIds = new Set<number>();

  for (const pick of picks) {
    if (pick.asset.assetType === 'skater') {
      playerIds.add(pick.asset.player.id);
    }
  }

  const evidence = [...playerIds]
    .sort((first, second) => first - second)
    .map((playerId) => ({
      playerId,
      teamAbbreviation:
        currentTeamAbbreviationByPlayerId.get(playerId)?.trim().toUpperCase() ??
        null,
      teamConfirmedAt: (
        currentTeamConfirmedAtByPlayerId?.get(playerId)?.trim() || null
      ),
    }));

  return createHash('sha256')
    .update(JSON.stringify(evidence))
    .digest('hex');
}

export async function calculateCycleScoring(
  input: CalculateCycleScoringInput
): Promise<CycleScoringResult> {
  const nhlRefreshProfile = input.nhlRefreshProfile ?? 'standard';
  const draftedTeams = getUniqueDraftedTeams(input);
  let schedulesByTeam: Record<string, NhlTeamSeasonGame[]> = {};

  if (!input.replayGamesByAssetKey) {
    const scheduleStartedAt = Date.now();

    try {
      schedulesByTeam = await loadSchedulesByTeam(
        draftedTeams,
        input.season,
        nhlRefreshProfile,
      );
    } finally {
      input.onPhaseDuration?.(
        'nhl-schedule-load',
        Date.now() - scheduleStartedAt,
      );
    }
  }
  if (
    !input.replayGamesByAssetKey &&
    input.currentTeamIdentityHash &&
    input.currentTeamAbbreviationByPlayerId
  ) {
    const identityGeneratedAtMilliseconds = Date.parse(
      input.currentTeamIdentityGeneratedAt ?? '',
    );
    const startedGames = Object.values(schedulesByTeam)
      .flat()
      .filter((game) => getGameRuntimeState(game) !== 'scheduled');
    const startedGameWithoutExactStart = startedGames.find(
      (game) => gameStartMilliseconds(game) === null,
    );

    if (startedGameWithoutExactStart) {
      throw new Error(
        `NHL game ${startedGameWithoutExactStart.id} is live or final, but ` +
        'its exact startTimeUTC is unavailable. Scoring cannot prove the ' +
        'player-team identity boundary and was left unchanged.',
      );
    }

    const latestStartedGameBoundary = startedGames
      .map(gameStartMilliseconds)
      .filter((value): value is number => value !== null)
      .reduce(
        (latest, value) => Math.max(latest, value),
        Number.NEGATIVE_INFINITY,
      );

    if (
      Number.isFinite(latestStartedGameBoundary) &&
      (
        !Number.isFinite(identityGeneratedAtMilliseconds) ||
        identityGeneratedAtMilliseconds < latestStartedGameBoundary
      )
    ) {
      throw new NhlPlayerTeamIdentityBoundaryRefreshRequiredError(
        latestStartedGameBoundary,
      );
    }
  }
  const tradedSkatersNeedingAppearanceEvidence = input.replayGamesByAssetKey
    ? []
    : getUniqueSkaterAssets(input.picks).filter((asset) => {
        if (asset.assetType !== 'skater') {
          return false;
        }

        const currentTeam = input.currentTeamAbbreviationByPlayerId
          ?.get(asset.player.id)
          ?.trim()
          .toUpperCase();

        if (!currentTeam) {
          return false;
        }

        return input.picks
          .filter((pick) => pick.asset.assetKey === asset.assetKey)
          .some((pick) => {
            const pickWindowCycleNumber = getPickWindowCycleNumber(
              pick,
              input.cycleNumber,
            );
            const previous = getPreviousWindowSummary(
              input.previousResult,
              getWindowId(pick, pickWindowCycleNumber),
              pick.asset.assetKey,
              resolvePlayerWindowContinuity({
                value: pick.playerWindowContinuity,
                ownerId: pick.ownerId,
                rosterSlotId: getRosterSlotId(pick),
                asset: pick.asset,
              })?.continuityId,
            );
            const rosterSlotId = getRosterSlotId(pick);
            const playerWindowContinuity = resolvePlayerWindowContinuity({
              value: pick.playerWindowContinuity,
              ownerId: pick.ownerId,
              rosterSlotId,
              asset: pick.asset,
            });
            const previousTeam = (
              previous?.scheduleTeamAbbreviation ??
              playerWindowContinuity?.lastScheduleTeamAbbreviation ??
              getAssetTeamAbbreviation(pick.asset)
            ).trim().toUpperCase();

            return previousTeam !== currentTeam;
          });
      });
  let tradeAppearanceGameLogsByPlayerId = new Map<number, SkaterGameLogLoad>();

  if (tradedSkatersNeedingAppearanceEvidence.length > 0) {
    const phaseStartedAt = Date.now();

    try {
      tradeAppearanceGameLogsByPlayerId = await loadSkaterGameLogs(
        tradedSkatersNeedingAppearanceEvidence,
        input.gameLogSeason ?? input.season,
      );
    } finally {
      input.onPhaseDuration?.(
        'nhl-player-log-load',
        Date.now() - phaseStartedAt,
      );
    }
  }
  const confirmedCurrentTeamAppearanceGameIdsByPlayerId = new Map<
    number,
    ReadonlySet<number>
  >();

  for (const asset of tradedSkatersNeedingAppearanceEvidence) {
    if (asset.assetType !== 'skater') {
      continue;
    }

    const currentTeam = input.currentTeamAbbreviationByPlayerId
      ?.get(asset.player.id)
      ?.trim()
      .toUpperCase();
    const load = tradeAppearanceGameLogsByPlayerId.get(asset.player.id);

    if (!currentTeam) {
      continue;
    }

    const hasFinalDestinationGame = (
      schedulesByTeam[currentTeam] ?? []
    ).some((game) => getGameRuntimeState(game) === 'final');

    if (
      hasFinalDestinationGame &&
      load?.sourceState.availability !== 'available'
    ) {
      throw new Error(
        `Final appearance evidence is unavailable for traded skater ` +
        `${asset.player.id} on ${currentTeam}. Scoring was left unchanged and will retry.`,
      );
    }

    if (load?.sourceState.availability !== 'available') {
      continue;
    }

    confirmedCurrentTeamAppearanceGameIdsByPlayerId.set(
      asset.player.id,
      new Set(
        getCurrentAffiliationAppearanceGameIds(
          load.gameLog,
          currentTeam,
        ),
      ),
    );
  }
  const gamesByWindowId = new Map<string, NhlTeamSeasonGame[]>();
  const scheduleTeamByWindowId = new Map<string, string>();
  const sourceTeamByWindowGameId = new Map<string, Record<string, string>>();
  const teamIdentityChangedByWindowId = new Map<string, boolean>();
  const previousByWindowId = new Map<string, CycleAssetScoreSummary | undefined>();
  const gameIdsToLoad = new Set<number>();
  const skaterAssetKeysNeedingFinalLogs = new Set<string>();

  const teamGameCounts: Record<string, number> = {};

  for (const teamAbbreviation of draftedTeams) {
    const representativePick = input.picks.find(
      (pick) => {
        if (getAssetTeamAbbreviation(pick.asset) === teamAbbreviation) {
          return true;
        }

        return pick.asset.assetType === 'skater' &&
          input.currentTeamAbbreviationByPlayerId
            ?.get(pick.asset.player.id)
            ?.trim()
            .toUpperCase() === teamAbbreviation;
      },
    );
    const schedule = representativePick
      ? input.replayGamesByAssetKey?.[representativePick.asset.assetKey] ??
        schedulesByTeam[teamAbbreviation] ?? []
      : schedulesByTeam[teamAbbreviation] ?? [];

    const targetGameIds = input.replayGamesByAssetKey
      ? undefined
      : representativePick
        ? resolveFrozenTargetGameIdsForPick(
            representativePick,
            teamAbbreviation,
            input.sourceNhlTargetGameIdsByTeam,
          )
        : input.sourceNhlTargetGameIdsByTeam?.[teamAbbreviation];
    teamGameCounts[teamAbbreviation] = (
      targetGameIds?.length
        ? selectGamesByStableIds(schedule, targetGameIds)
        : selectCycleWindowGames(
            schedule,
            representativePick
              ? getPickSourceNhlBlockNumber(representativePick, input.cycleNumber)
              : input.cycleNumber,
            input.requiredGamesPerCycle,
          )
    ).length;
  }

  for (const pick of input.picks) {
    const pickWindowCycleNumber = getPickWindowCycleNumber(
      pick,
      input.cycleNumber
    );
    const sourceNhlBlockNumber = getPickSourceNhlBlockNumber(
      pick,
      input.cycleNumber,
    );
    const windowId = getWindowId(pick, pickWindowCycleNumber);
    const pickContinuity = resolvePlayerWindowContinuity({
      value: pick.playerWindowContinuity,
      ownerId: pick.ownerId,
      rosterSlotId: getRosterSlotId(pick),
      asset: pick.asset,
    });
    const previous = getPreviousWindowSummary(
      input.previousResult,
      windowId,
      pick.asset.assetKey,
      pickContinuity?.continuityId,
    );
    const resolvedWindow = getRelevantAssetGames(
      pick,
      schedulesByTeam,
      sourceNhlBlockNumber,
      input.requiredGamesPerCycle,
      previous,
      input.replayGamesByAssetKey,
      input.currentTeamAbbreviationByPlayerId,
      input.currentTeamConfirmedAtByPlayerId,
      input.sourceNhlTargetGameIdsByTeam,
      input.seasonSourceGameIdsByTeam,
      confirmedCurrentTeamAppearanceGameIdsByPlayerId,
    );
    const games = resolvedWindow.games;

    gamesByWindowId.set(windowId, games);
    scheduleTeamByWindowId.set(
      windowId,
      resolvedWindow.scheduleTeamAbbreviation,
    );
    sourceTeamByWindowGameId.set(
      windowId,
      resolvedWindow.sourceTeamAbbreviationByGameId,
    );
    teamIdentityChangedByWindowId.set(
      windowId,
      resolvedWindow.teamIdentityChanged,
    );
    previousByWindowId.set(windowId, previous);

    for (const game of games) {
      const state = getGameRuntimeState(game);

      if (state === 'live') {
        gameIdsToLoad.add(game.id);
        continue;
      }

      if (
        state === 'final' &&
        !canReuseFinalGame(previous, game.id, pick.asset.assetType)
      ) {
        gameIdsToLoad.add(game.id);

        if (pick.asset.assetType === 'skater') {
          skaterAssetKeysNeedingFinalLogs.add(pick.asset.assetKey);
        }
      }
    }
  }

  const skatersNeedingLogs = getUniqueSkaterAssets(input.picks).filter(
    (asset) =>
      skaterAssetKeysNeedingFinalLogs.has(asset.assetKey) &&
      (
        asset.assetType !== 'skater' ||
        !tradeAppearanceGameLogsByPlayerId.has(asset.player.id)
      )
  );

  const gameDataPromise = (async () => {
    const phaseStartedAt = Date.now();

    try {
      return await loadScoringGameData(
        [...gameIdsToLoad],
        nhlRefreshProfile,
      );
    } finally {
      input.onPhaseDuration?.(
        'nhl-game-data-load',
        Date.now() - phaseStartedAt,
      );
    }
  })();
  const gameLogPromise = (async () => {
    const phaseStartedAt = Date.now();

    try {
      return await loadSkaterGameLogs(
        skatersNeedingLogs,
        input.gameLogSeason ?? input.season,
      );
    } finally {
      input.onPhaseDuration?.(
        'nhl-player-log-load',
        Date.now() - phaseStartedAt,
      );
    }
  })();
  const [gameDataById, newlyLoadedGameLogsByPlayerId] = await Promise.all([
    gameDataPromise,
    gameLogPromise,
  ]);
  const gameLogsByPlayerId = new Map<number, SkaterGameLogLoad>([
    ...tradeAppearanceGameLogsByPlayerId,
    ...newlyLoadedGameLogsByPlayerId,
  ]);

  const skatersNeedingPromotedFinalLogs = getUniqueSkaterAssets(input.picks).filter(
    (asset) => {
      if (
        asset.assetType !== 'skater' ||
        gameLogsByPlayerId.has(asset.player.id)
      ) {
        return false;
      }

      return input.picks
        .filter((pick) => pick.asset.assetKey === asset.assetKey)
        .some((pick) => {
          const pickWindowCycleNumber = getPickWindowCycleNumber(
            pick,
            input.cycleNumber,
          );
          const games = gamesByWindowId.get(
            getWindowId(pick, pickWindowCycleNumber),
          ) ?? [];

          return games.some((game) =>
            getGameRuntimeState(game) === 'live' &&
            getEffectiveGameRuntimeState(game, gameDataById.get(game.id)) === 'final'
          );
        });
    },
  );

  if (skatersNeedingPromotedFinalLogs.length > 0) {
    const phaseStartedAt = Date.now();

    try {
      const promotedFinalLogs = await loadSkaterGameLogs(
        skatersNeedingPromotedFinalLogs,
        input.gameLogSeason ?? input.season,
      );

      for (const [playerId, load] of promotedFinalLogs) {
        gameLogsByPlayerId.set(playerId, load);
      }
    } finally {
      input.onPhaseDuration?.(
        'nhl-player-log-load',
        Date.now() - phaseStartedAt,
      );
    }
  }

  const scoreCalculationStartedAt = Date.now();

  try {
    const assetScores: Record<string, CycleAssetScoreSummary> = {};
    const windowScores: Record<string, CycleAssetScoreSummary> = {};
    const teamScores: Record<string, number> = {};
    let hasLiveGames = false;
    let hasIncompleteFinalGames = false;
    const allRelevantGames: NhlTeamSeasonGame[] = [];

  for (const pick of input.picks) {
    const rosterSlotId = getRosterSlotId(pick);
    const pickWindowCycleNumber = getPickWindowCycleNumber(
      pick,
      input.cycleNumber
    );
    const sourceNhlBlockNumber = getPickSourceNhlBlockNumber(
      pick,
      input.cycleNumber,
    );
    const windowId = getWindowId(pick, pickWindowCycleNumber);
    const games = gamesByWindowId.get(windowId) ?? [];
    const scheduleTeamAbbreviation =
      scheduleTeamByWindowId.get(windowId) ??
      getAssetTeamAbbreviation(pick.asset);
    const sourceTeamAbbreviationByGameId =
      sourceTeamByWindowGameId.get(windowId) ?? {};
    const previous = previousByWindowId.get(windowId);
    const gameScores: Record<string, number> = {};
    const gameStates: Record<string, CycleGameRuntimeState> = {};
    const gameInputCompleteness: Record<string, NhlFinalInputCompleteness> = {};
    const completedGameIds: number[] = [];
    const incompleteFinalGameIds: number[] = [];
    const liveGameIds: number[] = [];
    const appearanceGameIds: number[] = [];
    let gamesPlayed = 0;
    let actualGamesPlayed = 0;
    let currentScore = 0;

    allRelevantGames.push(...games);

    for (const game of games) {
      const gameIdKey = String(game.id);
      const gameData = gameDataById.get(game.id);
      const state = getEffectiveGameRuntimeState(game, gameData);
      gameStates[gameIdKey] = state;

      if (state === 'scheduled') {
        continue;
      }

      if (state === 'live') {
        hasLiveGames = true;
        liveGameIds.push(game.id);
      }

      if (
        state === 'final' &&
        canReuseFinalGame(previous, game.id, pick.asset.assetType)
      ) {
        const previousScore = previous?.gameScores?.[gameIdKey] ?? 0;
        const appeared = previous?.appearanceGameIds?.includes(game.id) ?? false;
        const previousCompleteness = previous?.gameInputCompleteness?.[gameIdKey];
        let effectiveResult: GameScoreResult = {
          points: rounded(previousScore),
          appeared,
        };

        gamesPlayed += 1;
        completedGameIds.push(game.id);

        if (previousCompleteness) {
          gameInputCompleteness[gameIdKey] = previousCompleteness;
        }

        if (
          input.canonicalParityGamesById &&
          shouldCompareCanonicalScoringParityGame({
            requestedGameIds: input.canonicalParityRequestedGameIds,
            gameId: game.id,
          })
        ) {
          effectiveResult = selectCanonicalAuthorityGameResult({
            scoringInput: input,
            observation: compareDirectAndCanonicalGameScore({
              gameId: game.id,
              asset: pick.asset,
              canonicalGame: input.canonicalParityGamesById.get(game.id),
              gameIsFinal: true,
              scoringRules: input.scoringRules,
              directPoints: previousScore,
              directAppeared: appeared,
            }),
          });
        }

        gameScores[gameIdKey] = rounded(effectiveResult.points);
        currentScore += effectiveResult.points;

        if (effectiveResult.appeared) {
          actualGamesPlayed += 1;
          appearanceGameIds.push(game.id);
        }

        continue;
      }

      const playerLogLoad = pick.asset.assetType === 'skater'
        ? gameLogsByPlayerId.get(pick.asset.player.id)
        : undefined;
      const gameLog = pick.asset.assetType === 'skater'
        ? playerLogLoad?.gameLogByGameId.get(game.id)
        : undefined;

      if (state === 'final') {
        const completeness = getFinalGameInputCompleteness({
          asset: pick.asset,
          gameId: game.id,
          gameData,
          playerLogLoad,
          sourceTeamAbbreviation:
            input.replayGamesByAssetKey
              ? input.replaySourceTeamAbbreviationByAssetGameId
                  ?.[pick.asset.assetKey]
                  ?.[gameIdKey]
              : sourceTeamAbbreviationByGameId[gameIdKey],
          requireSourceTeamAbbreviation: Boolean(input.replayGamesByAssetKey),
        });

        if (!completeness.complete) {
          hasIncompleteFinalGames = true;
          incompleteFinalGameIds.push(game.id);
          const previousCompleteness = previous?.gameInputCompleteness?.[gameIdKey];
          const previousScoreTrustworthy =
            previous?.gameStates?.[gameIdKey] === 'live' ||
            Boolean(previousCompleteness);
          const fallback = selectIncompleteFinalScoreFallback({
            previousScore: previousScoreTrustworthy
              ? previous?.gameScores?.[gameIdKey]
              : undefined,
            previousAppeared:
              previous?.appearanceGameIds?.includes(game.id) ?? false,
          });

          gameInputCompleteness[gameIdKey] = {
            ...completeness,
            preservedPreviousScore: fallback.preservedPrevious,
          };

          if (
            input.canonicalParityGamesById &&
            shouldCompareCanonicalScoringParityGame({
              requestedGameIds: input.canonicalParityRequestedGameIds,
              gameId: game.id,
            })
          ) {
            selectCanonicalAuthorityGameResult({
              scoringInput: input,
              observation: compareDirectAndCanonicalGameScore({
                gameId: game.id,
                asset: pick.asset,
                canonicalGame: input.canonicalParityGamesById.get(game.id),
                gameIsFinal: true,
                scoringRules: input.scoringRules,
                directPoints: fallback.score ?? 0,
                directAppeared: fallback.appeared,
                directInputComplete: false,
                directIncompleteReason: completeness.status,
              }),
            });
          }

          if (fallback.score !== null) {
            gameScores[gameIdKey] = fallback.score;
            currentScore += fallback.score;
          }

          if (fallback.appeared) {
            actualGamesPlayed += 1;
            appearanceGameIds.push(game.id);
          }

          continue;
        }

        gameInputCompleteness[gameIdKey] = completeness;
        gamesPlayed += 1;
        completedGameIds.push(game.id);
      }

      const directScoreResult = pick.asset.assetType === 'skater'
        ? calculateSkaterGameScore(
            pick.asset,
            gameData,
            gameLog,
            state === 'final',
            input.scoringRules
          )
        : calculateGoalieUnitGameScore(
            pick.asset,
            gameData,
            state === 'final',
            input.scoringRules
          );
      let effectiveScoreResult = directScoreResult;

      if (
        input.canonicalParityGamesById &&
        shouldCompareCanonicalScoringParityGame({
          requestedGameIds: input.canonicalParityRequestedGameIds,
          gameId: game.id,
        })
      ) {
        effectiveScoreResult = selectCanonicalAuthorityGameResult({
          scoringInput: input,
          observation: compareDirectAndCanonicalGameScore({
            gameId: game.id,
            asset: pick.asset,
            canonicalGame: input.canonicalParityGamesById.get(game.id),
            gameIsFinal: state === 'final',
            scoringRules: input.scoringRules,
            directPoints: directScoreResult.points,
            directAppeared: directScoreResult.appeared,
          }),
        });
      }

      gameScores[gameIdKey] = effectiveScoreResult.points;
      currentScore += effectiveScoreResult.points;

      if (effectiveScoreResult.appeared) {
        if (state === 'final') {
          actualGamesPlayed += 1;
        }

        appearanceGameIds.push(game.id);
      }
    }

    const gamesLeft = Math.max(0, games.length - gamesPlayed);
    const status = games.length > 0 && gamesLeft === 0
      ? 'complete'
      : gamesPlayed > 0 || liveGameIds.length > 0 || incompleteFinalGameIds.length > 0
        ? 'active'
        : 'scheduled';
    const summaryContinuity = resolvePlayerWindowContinuity({
      value: pick.playerWindowContinuity,
      ownerId: pick.ownerId,
      rosterSlotId,
      asset: pick.asset,
    });
    const summary: CycleAssetScoreSummary = {
      assetKey: pick.asset.assetKey,
      ownerId: pick.ownerId,
      rosterSlotId,
      windowId,
      sourceNhlBlockNumber,
      currentScore: rounded(currentScore),
      gamesPlayed,
      actualGamesPlayed,
      scheduledGames: games.length,
      gamesLeft,
      scheduledGameIds: games.map((game) => game.id),
      scheduledGameDates: games.map((game) => game.gameDate),
      scheduledGameLabels: games.map((game) => {
        const teamAbbreviation =
          sourceTeamAbbreviationByGameId[String(game.id)] ??
          scheduleTeamAbbreviation;
        return game.homeTeam.abbrev === teamAbbreviation
          ? `vs ${game.awayTeam.abbrev}`
          : `@ ${game.homeTeam.abbrev}`;
      }),
      scheduleTeamAbbreviation,
      sourceTeamAbbreviationByGameId,
      teamIdentityChanged:
        teamIdentityChangedByWindowId.get(windowId) === true,
      ...(summaryContinuity
        ? { playerWindowContinuityId: summaryContinuity.continuityId }
        : {}),
      completedGameIds,
      incompleteFinalGameIds,
      liveGameIds,
      appearanceGameIds,
      gameScores,
      gameStates,
      gameInputCompleteness,
      firstScheduledGameDate: games[0]?.gameDate ?? null,
      lastScheduledGameDate: games.at(-1)?.gameDate ?? null,
      status
    };

    assetScores[pick.asset.assetKey] = summary;
    windowScores[windowId] = summary;
    teamScores[pick.ownerId] = rounded(
      (teamScores[pick.ownerId] ?? 0) + summary.currentScore
    );
  }

  const teamCycleComplete: Record<string, boolean> = {};
  const expectedOwnerIds = Object.keys(
    input.expectedRosterSlotIdsByOwner ?? {}
  );
  const ownerIds = [
    ...new Set([
      ...input.picks.map((pick) => pick.ownerId),
      ...expectedOwnerIds
    ])
  ];

  for (const ownerId of ownerIds) {
    const ownerPicks = input.picks.filter((pick) => pick.ownerId === ownerId);
    const expectedSlotIds =
      input.expectedRosterSlotIdsByOwner?.[ownerId] ??
      ownerPicks.map(getRosterSlotId);
    const pickBySlotId = new Map(
      ownerPicks.map((pick) => [getRosterSlotId(pick), pick] as const)
    );

    teamCycleComplete[ownerId] =
      expectedSlotIds.length > 0 &&
      expectedSlotIds.every((slotId) => {
        const pick = pickBySlotId.get(slotId);

        if (!pick) {
          return false;
        }

        const summary = windowScores[
          getWindowId(
            pick,
            getPickWindowCycleNumber(pick, input.cycleNumber)
          )
        ];

        return Boolean(summary) && summary.gamesLeft === 0;
      });
  }

  const cycleHasScheduledGames = Object.values(assetScores).some(
    (summary) => summary.scheduledGames > 0
  );
  const currentPickIdentityDigest = input.replayGamesByAssetKey
    ? undefined
    : buildCurrentPickIdentityDigest(
        input.picks,
        input.currentTeamAbbreviationByPlayerId,
        input.currentTeamConfirmedAtByPlayerId,
      );
  const dataFingerprint = buildResultFingerprint(
    input.cycleNumber,
    windowScores,
    currentPickIdentityDigest,
  );

    return {
      scoringSchemaVersion: 2,
      assetScores,
      windowScores,
      teamScores,
      teamGameCounts,
      teamCycleComplete,
      cycleHasScheduledGames,
      hasLiveGames,
      hasIncompleteFinalGames,
      nextScheduledGameStart: getNextScheduledStart(allRelevantGames),
      refreshedAt: new Date().toISOString(),
      dataFingerprint,
      ...(input.currentTeamIdentityHash
        ? { nhlPlayerTeamIdentityHash: input.currentTeamIdentityHash }
        : {}),
      ...(input.currentTeamIdentityGeneratedAt
        ? {
            nhlPlayerTeamIdentityGeneratedAt:
              input.currentTeamIdentityGeneratedAt,
          }
        : {}),
    };
  } finally {
    input.onPhaseDuration?.(
      'score-calculation',
      Date.now() - scoreCalculationStartedAt,
    );
  }
}
