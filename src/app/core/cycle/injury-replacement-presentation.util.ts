import type {
  DraftableAsset,
  InjuryReplacementWindowPlan,
} from '../draft/draft.models';
import type {
  CycleAssetScoreSummary,
  CycleScoringResult,
} from './cycle-scoring.service';
import { normalizeInjuryReplacementWindowPlan } from './injury-replacement-window.util';

export interface InjuryReplacementScoreSource {
  currentScore?: number;
  fantasyPoints?: number;
  scheduledGameIds: readonly number[];
  completedGameIds: readonly number[];
  gameScores: Readonly<Record<string, number>>;
  gameStates: Readonly<Record<string, 'scheduled' | 'live' | 'final'>>;
  injuryReplacementWindow?: InjuryReplacementWindowPlan;
  scoringAssetKeyByGameId?: Readonly<Record<string, string>>;
}

export interface InjuryReplacementSegmentPresentation {
  segmentId: string;
  reason: 'original' | 'injury-replacement';
  assetKey: string;
  asset: DraftableAsset;
  assetName: string;
  points: number;
  firstGameNumber: number;
  lastGameNumber: number;
  gameCount: number;
  gameRangeLabel: string;
  current: boolean;
}

export interface InjuryReplacementGameOwnership {
  gameId: number;
  gameNumber: number;
  assetKey: string;
  assetName: string;
  segmentIndex: number;
  segmentStart: boolean;
  currentSegment: boolean;
  ariaLabel: string;
}

export interface InjuryReplacementPresentation {
  totalPoints: number;
  segments: InjuryReplacementSegmentPresentation[];
  gameOwnership: InjuryReplacementGameOwnership[];
  accessibleLabel: string;
}

export interface CycleSlotScoreIdentity {
  ownerId: string;
  assetKey: string;
  rosterSlotId?: string | null;
  cycleWindowId?: string | null;
}

function roundScore(value: number): number {
  return Number(value.toFixed(1));
}

function getAssetName(asset: DraftableAsset): string {
  return asset.assetType === 'skater'
    ? asset.player.fullName
    : `${asset.teamName} Goalie Unit`;
}

function getGameRangeLabel(
  firstGameNumber: number,
  lastGameNumber: number,
  gameCount: number,
): string {
  if (gameCount === 0) {
    return 'No games';
  }

  return firstGameNumber === lastGameNumber
    ? `Game ${firstGameNumber}`
    : `Games ${firstGameNumber}–${lastGameNumber}`;
}

/**
 * Builds read-only display evidence for a mixed-player injury-replacement
 * window. The server-owned plan and per-game scores remain authoritative; this
 * helper never changes ownership or infers a missing score for a game that has
 * begun.
 */
export function buildInjuryReplacementPresentation(
  source: InjuryReplacementScoreSource | null | undefined,
): InjuryReplacementPresentation | null {
  if (!source?.injuryReplacementWindow) {
    return null;
  }

  const plan = normalizeInjuryReplacementWindowPlan(source.injuryReplacementWindow);
  const authoritativeTotal =
    typeof source.currentScore === 'number'
      ? source.currentScore
      : source.fantasyPoints;

  if (!plan || typeof authoritativeTotal !== 'number' || !Number.isFinite(authoritativeTotal)) {
    return null;
  }

  const scheduledGameIds = [...source.scheduledGameIds];
  const plannedGameIds = plan.segments.flatMap((segment) => segment.scheduledGameIds);

  if (
    plan.requiredGames !== scheduledGameIds.length ||
    plannedGameIds.length !== scheduledGameIds.length ||
    plannedGameIds.some((gameId, index) => gameId !== scheduledGameIds[index])
  ) {
    return null;
  }

  const completedGameIds = new Set(source.completedGameIds);
  const segmentPoints = plan.segments.map(() => 0);
  const gameOwnership: InjuryReplacementGameOwnership[] = [];
  let gameNumber = 0;

  for (let segmentIndex = 0; segmentIndex < plan.segments.length; segmentIndex += 1) {
    const segment = plan.segments[segmentIndex];
    const assetName = getAssetName(segment.asset);

    for (let segmentGameIndex = 0; segmentGameIndex < segment.scheduledGameIds.length; segmentGameIndex += 1) {
      const gameId = segment.scheduledGameIds[segmentGameIndex];
      const gameIdKey = String(gameId);
      const mappedAssetKey = source.scoringAssetKeyByGameId?.[gameIdKey];
      const state = source.gameStates[gameIdKey] ?? 'scheduled';
      const score = source.gameScores[gameIdKey];
      const gameHasBegun = completedGameIds.has(gameId) || state === 'live' || state === 'final';

      if (mappedAssetKey !== undefined && mappedAssetKey !== segment.assetKey) {
        return null;
      }

      if (typeof score !== 'number' || !Number.isFinite(score)) {
        if (gameHasBegun) {
          return null;
        }
      } else {
        segmentPoints[segmentIndex] += score;
      }

      gameNumber += 1;
      gameOwnership.push({
        gameId,
        gameNumber,
        assetKey: segment.assetKey,
        assetName,
        segmentIndex,
        segmentStart: segmentIndex > 0 && segmentGameIndex === 0,
        currentSegment: segmentIndex === plan.segments.length - 1,
        ariaLabel: `Game ${gameNumber} belongs to ${assetName}${
          segmentIndex > 0 ? ' after an injury replacement' : ''
        }`,
      });
    }
  }

  const roundedTotal = roundScore(authoritativeTotal);
  const roundedSegmentPoints = segmentPoints.map(roundScore);
  const calculatedTotal = roundScore(
    roundedSegmentPoints.reduce((total, points) => total + points, 0),
  );

  if (Math.abs(calculatedTotal - roundedTotal) >= 0.05) {
    return null;
  }

  let firstGameNumber = 1;
  const segments = plan.segments.map((segment, segmentIndex) => {
    const gameCount = segment.scheduledGameIds.length;
    const lastGameNumber = firstGameNumber + gameCount - 1;
    const presentation: InjuryReplacementSegmentPresentation = {
      segmentId: segment.segmentId,
      reason: segment.reason,
      assetKey: segment.assetKey,
      asset: segment.asset,
      assetName: getAssetName(segment.asset),
      points: roundedSegmentPoints[segmentIndex],
      firstGameNumber,
      lastGameNumber,
      gameCount,
      gameRangeLabel: getGameRangeLabel(firstGameNumber, lastGameNumber, gameCount),
      current: segmentIndex === plan.segments.length - 1,
    };

    if (gameCount > 0) {
      firstGameNumber = lastGameNumber + 1;
    }
    return presentation;
  });
  const segmentLabels = segments
    .map(
      (segment) =>
        `${segment.gameRangeLabel} ${segment.assetName}, ${segment.points.toFixed(1)} points`,
    )
    .join('. ');

  return {
    totalPoints: roundedTotal,
    segments,
    gameOwnership,
    accessibleLabel: `Injury replacement slot total ${roundedTotal.toFixed(1)} points. ${segmentLabels}.`,
  };
}

function isExactIdentityMatch(
  summary: CycleAssetScoreSummary | undefined,
  identity: CycleSlotScoreIdentity,
): summary is CycleAssetScoreSummary {
  return Boolean(
    summary &&
      summary.ownerId === identity.ownerId &&
      (!identity.rosterSlotId || summary.rosterSlotId === identity.rosterSlotId),
  );
}

/**
 * Resolves a scorer summary by persistent slot identity before consulting the
 * backward-compatible asset index. That ordering keeps the UI stable during
 * the brief snapshot race after an injury replacement changes the displayed
 * player but not the slot or its earned points.
 */
export function resolveCycleSlotScoreSummary(
  result: CycleScoringResult | null | undefined,
  identity: CycleSlotScoreIdentity | null | undefined,
): CycleAssetScoreSummary | null {
  if (!result || !identity?.ownerId || !identity.assetKey) {
    return null;
  }

  if (identity.cycleWindowId) {
    const exactWindow = result.windowScores[identity.cycleWindowId];

    if (isExactIdentityMatch(exactWindow, identity)) {
      return exactWindow;
    }
  }

  if (identity.rosterSlotId) {
    const exactSlot = Object.values(result.windowScores).find(
      (summary) =>
        summary.ownerId === identity.ownerId &&
        summary.rosterSlotId === identity.rosterSlotId,
    );

    if (exactSlot) {
      return exactSlot;
    }
  }

  const assetSummary = result.assetScores[identity.assetKey];
  return isExactIdentityMatch(assetSummary, identity) ? assetSummary : null;
}
