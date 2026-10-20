import type { DraftableAsset } from '../draft/draft.models';
import {
  calculateGoalieGameBreakdown,
  calculateSkaterGameBreakdown,
  type GoalieGameStats,
  type SkaterGameStats,
} from '../scoring/scoring-engine';
import type { ScoringRules } from '../scoring/scoring-rules';
import type {
  CanonicalNhlGameFacts,
  CanonicalNhlSkaterFinalSettlement,
} from './nhl-canonical-facts.util';

export type CanonicalScoringParityStatus =
  | 'matched'
  | 'mismatch'
  | 'incomplete'
  | 'canonical-missing';

export interface CanonicalScoringParityGame {
  sourceVersion: string;
  facts: CanonicalNhlGameFacts;
  finalInputCompletenessByAssetType?: {
    skater?: unknown;
    teamGoalieUnit?: unknown;
    scoringV5?: {
      skater?: unknown;
      teamGoalieUnit?: unknown;
    };
  };
}

export interface CanonicalAssetGameScore {
  points: number;
  appeared: boolean;
  complete: boolean;
  reason: string;
}

export interface CanonicalScoringParityObservation {
  gameId: number;
  assetKey: string;
  assetType: DraftableAsset['assetType'];
  sourceVersion: string;
  status: CanonicalScoringParityStatus;
  directPoints: number;
  canonicalPoints: number | null;
  pointDelta: number | null;
  directAppeared: boolean;
  canonicalAppeared: boolean | null;
  reason: string;
}

export function shouldCompareCanonicalScoringParityGame(input: {
  requestedGameIds: ReadonlySet<number> | undefined;
  gameId: number;
}): boolean {
  return input.requestedGameIds?.has(Math.trunc(input.gameId)) === true;
}

function rounded(value: number): number {
  return Number(value.toFixed(1));
}

function hasCompleteCanonicalFinalInput(input: {
  game: CanonicalScoringParityGame;
  assetType: DraftableAsset['assetType'];
  scoringRules: ScoringRules;
}): boolean {
  const evidence = getCanonicalFinalInputEvidence(input);

  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return false;
  }

  const candidate = evidence as Record<string, unknown>;
  const requiredSources = candidate['requiredSources'];
  const expectedSources = input.assetType === 'skater'
    ? ['boxscore', 'play-by-play', 'player-log', 'source-version']
    : ['boxscore', 'play-by-play', 'source-version'];

  return candidate['status'] === 'complete' &&
    candidate['complete'] === true &&
    candidate['reusableFinal'] === true &&
    candidate['sourceVersion'] === input.game.sourceVersion &&
    Array.isArray(requiredSources) &&
    requiredSources.length === expectedSources.length &&
    expectedSources.every((source) => requiredSources.includes(source)) &&
    Array.isArray(candidate['failures']) &&
    candidate['failures'].length === 0;
}

function getCanonicalFinalInputReason(input: {
  game: CanonicalScoringParityGame;
  assetType: DraftableAsset['assetType'];
  scoringRules: ScoringRules;
}): string {
  const evidence = getCanonicalFinalInputEvidence(input);
  const status = evidence && typeof evidence === 'object' && !Array.isArray(evidence)
    ? String((evidence as Record<string, unknown>)['status'] ?? '')
    : '';

  return `canonical-${status || 'final-input-incomplete'}`.slice(0, 100);
}

function getCanonicalFinalInputEvidence(input: {
  game: CanonicalScoringParityGame;
  assetType: DraftableAsset['assetType'];
  scoringRules: ScoringRules;
}): unknown {
  const completeness = input.game.finalInputCompletenessByAssetType;
  const v5Completeness = (input.scoringRules.shootoutGoal ?? 0) !== 0
    ? completeness?.scoringV5
    : undefined;

  if (input.assetType === 'skater') {
    return v5Completeness?.skater ?? completeness?.skater;
  }

  return v5Completeness?.teamGoalieUnit ?? completeness?.teamGoalieUnit;
}

function minutesFromSeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 0;
  }

  return Number((seconds / 60).toFixed(2));
}

function getFinalSettlement(
  facts: CanonicalNhlGameFacts,
  playerId: number,
): CanonicalNhlSkaterFinalSettlement | null {
  return facts.finalSettlements.find((entry) => entry.playerId === playerId) ?? null;
}

function getCanonicalAssistBreakdown(
  facts: CanonicalNhlGameFacts,
  playerId: number,
  excludeShootoutGoals: boolean,
): { primaryAssists: number; secondaryAssists: number } {
  let primaryAssists = 0;
  let secondaryAssists = 0;

  for (const goal of facts.goals) {
    if (
      excludeShootoutGoals &&
      goal.periodType.trim().toUpperCase() === 'SO'
    ) {
      continue;
    }

    if (goal.assist1PlayerId === playerId) {
      primaryAssists += 1;
    }

    if (goal.assist2PlayerId === playerId) {
      secondaryAssists += 1;
    }
  }

  return { primaryAssists, secondaryAssists };
}

function countCanonicalShootoutGoals(
  facts: CanonicalNhlGameFacts,
  matches: (goal: CanonicalNhlGameFacts['goals'][number]) => boolean,
): number {
  const seenEventIds = new Set<number>();
  let count = 0;

  for (const goal of facts.goals) {
    if (
      goal.periodType.trim().toUpperCase() !== 'SO' ||
      !matches(goal)
    ) {
      continue;
    }

    const eventId = goal.eventId;
    if (Number.isInteger(eventId) && Number(eventId) > 0) {
      if (seenEventIds.has(Number(eventId))) {
        continue;
      }
      seenEventIds.add(Number(eventId));
    }

    // Live payloads can temporarily omit eventId. Those events remain
    // countable because treating every missing ID as the same event would
    // erase legitimate repeat-shooter successes.
    count += 1;
  }

  return count;
}

function getCanonicalSkaterShootoutGoals(
  facts: CanonicalNhlGameFacts,
  playerId: number,
): number {
  return countCanonicalShootoutGoals(
    facts,
    (goal) => goal.scoringPlayerId === playerId,
  );
}

function getCanonicalTeamShootoutGoals(
  facts: CanonicalNhlGameFacts,
  teamId: number,
): number {
  return countCanonicalShootoutGoals(
    facts,
    (goal) => goal.eventOwnerTeamId === teamId,
  );
}

function calculateCanonicalSkaterGameScore(input: {
  asset: Extract<DraftableAsset, { assetType: 'skater' }>;
  facts: CanonicalNhlGameFacts;
  gameIsFinal: boolean;
  scoringRules: ScoringRules;
}): CanonicalAssetGameScore {
  const line = input.facts.skaters.find(
    (entry) => entry.playerId === input.asset.player.id,
  );
  const shootoutGoals = (input.scoringRules.shootoutGoal ?? 0) !== 0
    ? getCanonicalSkaterShootoutGoals(
        input.facts,
        input.asset.player.id,
      )
    : 0;
  const finalSettlement = input.gameIsFinal
    ? getFinalSettlement(input.facts, input.asset.player.id)
    : null;

  if (!line && !finalSettlement && shootoutGoals === 0) {
    return {
      points: 0,
      appeared: false,
      complete: true,
      reason: 'skater-not-present',
    };
  }

  if (input.gameIsFinal && !finalSettlement) {
    return {
      points: 0,
      appeared: true,
      complete: false,
      reason: 'final-settlement-missing',
    };
  }

  const playByPlayAssists = getCanonicalAssistBreakdown(
    input.facts,
    input.asset.player.id,
    (input.scoringRules.shootoutGoal ?? 0) !== 0,
  );
  const excludeShootoutAssists = (input.scoringRules.shootoutGoal ?? 0) !== 0;
  let primaryAssists = excludeShootoutAssists
    ? playByPlayAssists.primaryAssists
    : line?.primaryAssists ?? playByPlayAssists.primaryAssists;
  let secondaryAssists = excludeShootoutAssists
    ? playByPlayAssists.secondaryAssists
    : line?.secondaryAssists ?? playByPlayAssists.secondaryAssists;
  const totalAssists = line?.assists ?? finalSettlement?.assists ?? 0;

  if (primaryAssists + secondaryAssists < totalAssists) {
    secondaryAssists += totalAssists - primaryAssists - secondaryAssists;
  }

  const stats: SkaterGameStats = {
    position: input.asset.position === 'D' ? 'D' : 'F',
    goals: line?.goals ?? finalSettlement?.goals ?? 0,
    primaryAssists,
    secondaryAssists,
    shotsOnGoal: line?.shotsOnGoal ?? finalSettlement?.shotsOnGoal ?? 0,
    hits: line?.hits ?? 0,
    blockedShots: line?.blockedShots ?? 0,
    plusMinus: line?.plusMinus ?? finalSettlement?.plusMinus ?? 0,
    powerPlayPoints: input.gameIsFinal
      ? finalSettlement?.powerPlayPoints ?? 0
      : line?.powerPlayGoals ?? 0,
    shortHandedPoints: input.gameIsFinal
      ? finalSettlement?.shortHandedPoints ?? 0
      : 0,
    gameWinningGoal:
      input.gameIsFinal && Boolean(finalSettlement?.gameWinningGoal),
    overtimeGoal:
      input.gameIsFinal && Boolean(finalSettlement?.overtimeGoal),
    shootoutGoals,
    timeOnIceMinutes: minutesFromSeconds(
      input.gameIsFinal
        ? finalSettlement?.timeOnIceSeconds ?? line?.timeOnIceSeconds ?? 0
        : line?.timeOnIceSeconds ?? 0,
    ),
  };

  return {
    points: rounded(
      calculateSkaterGameBreakdown(stats, input.scoringRules).total,
    ),
    appeared: true,
    complete: true,
    reason: input.gameIsFinal
      ? 'canonical-final-settlement'
      : 'canonical-live-boxscore',
  };
}

function calculateCanonicalGoalieUnitGameScore(input: {
  asset: Extract<DraftableAsset, { assetType: 'team-goalie-unit' }>;
  facts: CanonicalNhlGameFacts;
  gameIsFinal: boolean;
  scoringRules: ScoringRules;
}): CanonicalAssetGameScore {
  const team = input.asset.teamAbbreviation.trim().toUpperCase();
  const isHome = input.facts.homeTeamAbbreviation === team;
  const isAway = input.facts.awayTeamAbbreviation === team;

  if (!isHome && !isAway) {
    return {
      points: 0,
      appeared: false,
      complete: false,
      reason: 'goalie-team-not-in-game',
    };
  }

  const activeGoalies = input.facts.goalies.filter((goalie) =>
    goalie.teamAbbreviation === team &&
    (
      goalie.timeOnIceSeconds > 0 ||
      goalie.saves > 0 ||
      goalie.shotsAgainst > 0
    )
  );

  if (activeGoalies.length === 0) {
    return {
      points: 0,
      appeared: false,
      complete: true,
      reason: 'goalie-unit-did-not-appear',
    };
  }

  const saves = activeGoalies.reduce((sum, goalie) => sum + goalie.saves, 0);
  const shotsAgainst = activeGoalies.reduce(
    (sum, goalie) => sum + goalie.shotsAgainst,
    0,
  );
  const teamScore = isHome ? input.facts.homeScore : input.facts.awayScore;
  const opponentScore = isHome ? input.facts.awayScore : input.facts.homeScore;
  const opponentTeamId = isHome
    ? input.facts.awayTeamId
    : input.facts.homeTeamId;
  const stats: GoalieGameStats = {
    saves,
    shotsAgainst,
    won: input.gameIsFinal && teamScore > opponentScore,
    shutout: input.gameIsFinal && teamScore > opponentScore && opponentScore === 0,
    shootoutGoalsAgainst: getCanonicalTeamShootoutGoals(
      input.facts,
      opponentTeamId,
    ),
  };

  return {
    points: rounded(
      calculateGoalieGameBreakdown(stats, input.scoringRules).total,
    ),
    appeared: true,
    complete: true,
    reason: input.gameIsFinal
      ? 'canonical-final-goalie-unit'
      : 'canonical-live-goalie-unit',
  };
}

export function calculateCanonicalAssetGameScore(input: {
  asset: DraftableAsset;
  facts: CanonicalNhlGameFacts;
  gameIsFinal: boolean;
  scoringRules: ScoringRules;
}): CanonicalAssetGameScore {
  return input.asset.assetType === 'skater'
    ? calculateCanonicalSkaterGameScore({
        asset: input.asset,
        facts: input.facts,
        gameIsFinal: input.gameIsFinal,
        scoringRules: input.scoringRules,
      })
    : calculateCanonicalGoalieUnitGameScore({
        asset: input.asset,
        facts: input.facts,
        gameIsFinal: input.gameIsFinal,
        scoringRules: input.scoringRules,
      });
}

export function compareDirectAndCanonicalGameScore(input: {
  gameId: number;
  asset: DraftableAsset;
  canonicalGame: CanonicalScoringParityGame | undefined;
  gameIsFinal: boolean;
  scoringRules: ScoringRules;
  directPoints: number;
  directAppeared: boolean;
  directInputComplete?: boolean;
  directIncompleteReason?: string;
}): CanonicalScoringParityObservation {
  if (!input.canonicalGame) {
    return {
      gameId: input.gameId,
      assetKey: input.asset.assetKey,
      assetType: input.asset.assetType,
      sourceVersion: '',
      status: 'canonical-missing',
      directPoints: rounded(input.directPoints),
      canonicalPoints: null,
      pointDelta: null,
      directAppeared: input.directAppeared,
      canonicalAppeared: null,
      reason: 'canonical-game-missing',
    };
  }

  if (input.directInputComplete === false) {
    return {
      gameId: input.gameId,
      assetKey: input.asset.assetKey,
      assetType: input.asset.assetType,
      sourceVersion: input.canonicalGame.sourceVersion,
      status: 'incomplete',
      directPoints: rounded(input.directPoints),
      canonicalPoints: null,
      pointDelta: null,
      directAppeared: input.directAppeared,
      canonicalAppeared: null,
      reason: `direct-${input.directIncompleteReason || 'final-input-incomplete'}`
        .slice(0, 100),
    };
  }

  if (
    input.gameIsFinal &&
    !hasCompleteCanonicalFinalInput({
      game: input.canonicalGame,
      assetType: input.asset.assetType,
      scoringRules: input.scoringRules,
    })
  ) {
    return {
      gameId: input.gameId,
      assetKey: input.asset.assetKey,
      assetType: input.asset.assetType,
      sourceVersion: input.canonicalGame.sourceVersion,
      status: 'incomplete',
      directPoints: rounded(input.directPoints),
      canonicalPoints: null,
      pointDelta: null,
      directAppeared: input.directAppeared,
      canonicalAppeared: null,
      reason: getCanonicalFinalInputReason({
        game: input.canonicalGame,
        assetType: input.asset.assetType,
        scoringRules: input.scoringRules,
      }),
    };
  }

  const canonical = calculateCanonicalAssetGameScore({
    asset: input.asset,
    facts: input.canonicalGame.facts,
    gameIsFinal: input.gameIsFinal,
    scoringRules: input.scoringRules,
  });

  if (!canonical.complete) {
    return {
      gameId: input.gameId,
      assetKey: input.asset.assetKey,
      assetType: input.asset.assetType,
      sourceVersion: input.canonicalGame.sourceVersion,
      status: 'incomplete',
      directPoints: rounded(input.directPoints),
      canonicalPoints: null,
      pointDelta: null,
      directAppeared: input.directAppeared,
      canonicalAppeared: canonical.appeared,
      reason: canonical.reason,
    };
  }

  const directPoints = rounded(input.directPoints);
  const canonicalPoints = rounded(canonical.points);
  const pointDelta = rounded(canonicalPoints - directPoints);
  const matched = pointDelta === 0 && canonical.appeared === input.directAppeared;

  return {
    gameId: input.gameId,
    assetKey: input.asset.assetKey,
    assetType: input.asset.assetType,
    sourceVersion: input.canonicalGame.sourceVersion,
    status: matched ? 'matched' : 'mismatch',
    directPoints,
    canonicalPoints,
    pointDelta,
    directAppeared: input.directAppeared,
    canonicalAppeared: canonical.appeared,
    reason: matched ? canonical.reason : 'score-or-appearance-mismatch',
  };
}
