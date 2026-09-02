import type { FantasyAssetCycleWindow } from '../cycle/cycle.models';
import type { ScoringRules } from '../scoring/scoring-rules';
import { isReusableNhlFinalScore } from './nhl-final-input-completeness.util';
import {
  compareDirectAndCanonicalGameScore,
  type CanonicalScoringParityGame,
} from './nhl-canonical-scoring-parity.util';

export type FinalScoreReconciliationFindingStatus =
  | 'candidate'
  | 'unverifiable';

export type FinalScoreReconciliationFindingCode =
  | 'score-mismatch'
  | 'appearance-mismatch'
  | 'score-and-appearance-mismatch'
  | 'stored-final-score-missing'
  | 'stored-final-evidence-missing'
  | 'stored-final-evidence-incomplete'
  | 'canonical-game-missing'
  | 'canonical-game-read-limit-reached'
  | 'canonical-final-evidence-incomplete'
  | 'window-asset-invalid'
  | 'duplicate-scheduled-game-id'
  | 'duplicate-completed-game-id'
  | 'duplicate-incomplete-game-id'
  | 'duplicate-appearance-game-id'
  | 'completed-game-not-scheduled'
  | 'incomplete-game-not-scheduled'
  | 'appearance-game-not-scheduled'
  | 'completed-and-incomplete-game-overlap'
  | 'completed-game-state-not-final'
  | 'scheduled-game-count-mismatch'
  | 'games-played-count-mismatch'
  | 'actual-games-played-count-mismatch'
  | 'games-left-count-mismatch'
  | 'complete-window-has-pending-game'
  | 'fantasy-points-sum-mismatch'
  | 'team-window-structure-invalid'
  | 'team-window-inspection-limit-reached'
  | 'final-game-inspection-limit-reached';

export interface FinalScoreReconciliationFinding {
  status: FinalScoreReconciliationFindingStatus;
  code: FinalScoreReconciliationFindingCode;
  teamKey: string;
  rosterSlotId: string;
  assetKey: string;
  assetType: 'skater' | 'team-goalie-unit' | 'unknown';
  gameId: number | null;
  storedPoints: number | null;
  canonicalPoints: number | null;
  pointDelta: number | null;
  storedAppeared: boolean | null;
  canonicalAppeared: boolean | null;
  storedSourceVersion: string;
  canonicalSourceVersion: string;
  reason: string;
}

export interface FinalScoreReconciliationWindowResult {
  windowCount: number;
  finalizedGameCount: number;
  verifiedGameCount: number;
  candidateGameCount: number;
  unverifiableGameCount: number;
  integrityIssueCount: number;
  findingCount: number;
  findingsTruncated: boolean;
  findings: FinalScoreReconciliationFinding[];
}

export interface FinalScoreTeamWindowStructureInspection {
  allWindowCount: number;
  safeWindowValues: Array<Partial<FantasyAssetCycleWindow>>;
  inspectionIncomplete: boolean;
  finding: FinalScoreReconciliationFinding | null;
}

const DEFAULT_MAX_FINAL_GAMES = 12;
const DEFAULT_MAX_FINDINGS = 24;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasRequiredFinalScoreWindowStructure(
  value: Record<string, unknown>,
): boolean {
  const asset = value['asset'];
  const assetType = isObjectRecord(asset) ? asset['assetType'] : null;

  return (
    typeof value['id'] === 'string' &&
    typeof value['rosterSlotId'] === 'string' &&
    typeof value['assetKey'] === 'string' &&
    (assetType === 'skater' || assetType === 'team-goalie-unit') &&
    (value['status'] === 'scheduled' ||
      value['status'] === 'active' ||
      value['status'] === 'complete') &&
    Array.isArray(value['scheduledGameIds']) &&
    Array.isArray(value['completedGameIds']) &&
    Array.isArray(value['appearanceGameIds']) &&
    isObjectRecord(value['gameScores']) &&
    isObjectRecord(value['gameStates']) &&
    typeof value['scheduledGames'] === 'number' &&
    Number.isFinite(value['scheduledGames']) &&
    typeof value['gamesPlayed'] === 'number' &&
    Number.isFinite(value['gamesPlayed']) &&
    typeof value['actualGamesPlayed'] === 'number' &&
    Number.isFinite(value['actualGamesPlayed']) &&
    typeof value['gamesLeft'] === 'number' &&
    Number.isFinite(value['gamesLeft']) &&
    typeof value['fantasyPoints'] === 'number' &&
    Number.isFinite(value['fantasyPoints'])
  );
}

function teamWindowStructureFinding(input: {
  teamKey: string;
  reason: string;
}): FinalScoreReconciliationFinding {
  return {
    status: 'candidate',
    code: 'team-window-structure-invalid',
    teamKey: input.teamKey,
    rosterSlotId: '',
    assetKey: '',
    assetType: 'unknown',
    gameId: null,
    storedPoints: null,
    canonicalPoints: null,
    pointDelta: null,
    storedAppeared: null,
    canonicalAppeared: null,
    storedSourceVersion: '',
    canonicalSourceVersion: '',
    reason: input.reason,
  };
}

export function inspectFinalScoreTeamWindowStructure(input: {
  rawWindows: unknown;
  teamKey: string;
}): FinalScoreTeamWindowStructureInspection {
  if (!Array.isArray(input.rawWindows)) {
    return {
      allWindowCount: 0,
      safeWindowValues: [],
      inspectionIncomplete: true,
      finding: teamWindowStructureFinding({
        teamKey: input.teamKey,
        reason:
          'The saved team-window document has no window array, so finalized games may be hidden.',
      }),
    };
  }

  const safeWindowValues = input.rawWindows.filter(
    (value): value is Partial<FantasyAssetCycleWindow> => isObjectRecord(value),
  );
  const malformedWindowCount = input.rawWindows.reduce(
    (count, value) => count + (
      isObjectRecord(value) && hasRequiredFinalScoreWindowStructure(value) ? 0 : 1
    ),
    0,
  );

  return {
    allWindowCount: input.rawWindows.length,
    safeWindowValues,
    inspectionIncomplete: malformedWindowCount > 0,
    finding: malformedWindowCount > 0
      ? teamWindowStructureFinding({
          teamKey: input.teamKey,
          reason:
            `${malformedWindowCount} saved team-window record(s) omit required audit ` +
            'structure, so this document cannot be classified as clean.',
        })
      : null,
  };
}

function rounded(value: number): number {
  return Number(value.toFixed(1));
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function positiveGameIds(values: readonly number[]): number[] {
  return values.filter(isPositiveInteger);
}

function duplicateGameIds(values: readonly number[]): number[] {
  const seen = new Set<number>();
  const duplicates = new Set<number>();

  for (const gameId of positiveGameIds(values)) {
    if (seen.has(gameId)) {
      duplicates.add(gameId);
    }

    seen.add(gameId);
  }

  return [...duplicates].sort((left, right) => left - right);
}

function assetTypeForWindow(
  window: FantasyAssetCycleWindow,
): FinalScoreReconciliationFinding['assetType'] {
  return window.asset?.assetType === 'skater' ||
    window.asset?.assetType === 'team-goalie-unit'
      ? window.asset.assetType
      : 'unknown';
}

function baseFinding(input: {
  window: FantasyAssetCycleWindow;
  teamKey: string;
  status: FinalScoreReconciliationFindingStatus;
  code: FinalScoreReconciliationFindingCode;
  gameId?: number | null;
  reason: string;
}): FinalScoreReconciliationFinding {
  return {
    status: input.status,
    code: input.code,
    teamKey: input.teamKey,
    rosterSlotId: input.window.rosterSlotId,
    assetKey: input.window.assetKey,
    assetType: assetTypeForWindow(input.window),
    gameId: input.gameId ?? null,
    storedPoints: null,
    canonicalPoints: null,
    pointDelta: null,
    storedAppeared: null,
    canonicalAppeared: null,
    storedSourceVersion: '',
    canonicalSourceVersion: '',
    reason: input.reason.slice(0, 180),
  };
}

function storageIssue(
  window: FantasyAssetCycleWindow,
  teamKey: string,
  code: FinalScoreReconciliationFindingCode,
  reason: string,
  gameId: number | null = null,
): FinalScoreReconciliationFinding {
  return baseFinding({
    window,
    teamKey,
    status: 'candidate',
    code,
    gameId,
    reason,
  });
}

function hasReusableStoredFinal(input: {
  window: FantasyAssetCycleWindow;
  gameId: number;
  score: unknown;
}): boolean {
  const assetType = assetTypeForWindow(input.window);

  return assetType !== 'unknown' && isReusableNhlFinalScore({
    assetType,
    gameState: input.window.gameStates[String(input.gameId)],
    score: input.score,
    completeness: input.window.gameInputCompleteness?.[String(input.gameId)],
  });
}

function getWindowStorageIssues(input: {
  window: FantasyAssetCycleWindow;
  teamKey: string;
  maxFinalGames: number;
}): FinalScoreReconciliationFinding[] {
  const { window, teamKey } = input;
  const issues: FinalScoreReconciliationFinding[] = [];
  const scheduledIds = positiveGameIds(window.scheduledGameIds);
  const completedIds = positiveGameIds(window.completedGameIds);
  const incompleteIds = positiveGameIds(window.incompleteFinalGameIds ?? []);
  const appearanceIds = positiveGameIds(window.appearanceGameIds);
  const scheduledSet = new Set(scheduledIds);
  const completedSet = new Set(completedIds);

  for (const gameId of duplicateGameIds(window.scheduledGameIds)) {
    issues.push(storageIssue(
      window,
      teamKey,
      'duplicate-scheduled-game-id',
      'The saved window contains the same scheduled NHL game more than once.',
      gameId,
    ));
  }

  for (const gameId of duplicateGameIds(window.completedGameIds)) {
    issues.push(storageIssue(
      window,
      teamKey,
      'duplicate-completed-game-id',
      'The saved window contains the same completed NHL game more than once.',
      gameId,
    ));
  }

  for (const gameId of duplicateGameIds(window.incompleteFinalGameIds ?? [])) {
    issues.push(storageIssue(
      window,
      teamKey,
      'duplicate-incomplete-game-id',
      'The saved window contains the same incomplete final NHL game more than once.',
      gameId,
    ));
  }

  for (const gameId of duplicateGameIds(window.appearanceGameIds)) {
    issues.push(storageIssue(
      window,
      teamKey,
      'duplicate-appearance-game-id',
      'The saved window contains the same NHL appearance more than once.',
      gameId,
    ));
  }

  for (const gameId of new Set(completedIds)) {
    if (!scheduledSet.has(gameId)) {
      issues.push(storageIssue(
        window,
        teamKey,
        'completed-game-not-scheduled',
        'A completed NHL game is outside this immutable window assignment.',
        gameId,
      ));
    }

    if (window.gameStates[String(gameId)] !== 'final') {
      issues.push(storageIssue(
        window,
        teamKey,
        'completed-game-state-not-final',
        'A completed NHL game is not saved with final game state.',
        gameId,
      ));
    }
  }

  for (const gameId of new Set(incompleteIds)) {
    if (!scheduledSet.has(gameId)) {
      issues.push(storageIssue(
        window,
        teamKey,
        'incomplete-game-not-scheduled',
        'An incomplete final NHL game is outside this immutable window assignment.',
        gameId,
      ));
    }

    if (completedSet.has(gameId)) {
      issues.push(storageIssue(
        window,
        teamKey,
        'completed-and-incomplete-game-overlap',
        'The same NHL game is marked both complete and incomplete.',
        gameId,
      ));
    }
  }

  for (const gameId of new Set(appearanceIds)) {
    if (!scheduledSet.has(gameId)) {
      issues.push(storageIssue(
        window,
        teamKey,
        'appearance-game-not-scheduled',
        'A saved NHL appearance is outside this immutable window assignment.',
        gameId,
      ));
    }
  }

  if (window.scheduledGames !== scheduledIds.length) {
    issues.push(storageIssue(
      window,
      teamKey,
      'scheduled-game-count-mismatch',
      'The saved scheduled-game count does not equal the immutable game-id count.',
    ));
  }

  if (window.gamesPlayed !== new Set(completedIds).size) {
    issues.push(storageIssue(
      window,
      teamKey,
      'games-played-count-mismatch',
      'The saved games-played count does not equal the unique completed-game count.',
    ));
  }

  if (window.actualGamesPlayed !== new Set(appearanceIds).size) {
    issues.push(storageIssue(
      window,
      teamKey,
      'actual-games-played-count-mismatch',
      'The saved appearance count does not equal the unique appearance-game count.',
    ));
  }

  const expectedGamesLeft = Math.max(0, window.scheduledGames - window.gamesPlayed);

  if (window.gamesLeft !== expectedGamesLeft) {
    issues.push(storageIssue(
      window,
      teamKey,
      'games-left-count-mismatch',
      'The saved games-left count does not match scheduled games minus completed games.',
    ));
  }

  if (
    window.status === 'complete' &&
    (
      window.gamesLeft !== 0 ||
      incompleteIds.length > 0 ||
      window.liveGameIds.length > 0
    )
  ) {
    issues.push(storageIssue(
      window,
      teamKey,
      'complete-window-has-pending-game',
      'A complete immutable window still contains a live, incomplete, or unplayed game.',
    ));
  }

  const gameScoreTotal = rounded(
    Object.values(window.gameScores)
      .filter((score) => Number.isFinite(score))
      .reduce((sum, score) => sum + score, 0),
  );

  if (!Number.isFinite(window.fantasyPoints) || rounded(window.fantasyPoints) !== gameScoreTotal) {
    issues.push(storageIssue(
      window,
      teamKey,
      'fantasy-points-sum-mismatch',
      'The saved window total does not equal the sum of its per-game scores.',
    ));
  }

  if (new Set(completedIds).size > input.maxFinalGames) {
    issues.push(storageIssue(
      window,
      teamKey,
      'final-game-inspection-limit-reached',
      `The window exceeds the bounded ${input.maxFinalGames}-game inspection limit.`,
    ));
  }

  return issues;
}

export function reconcileFinalizedWindow(input: {
  window: FantasyAssetCycleWindow;
  teamKey: string;
  canonicalGamesById: ReadonlyMap<number, CanonicalScoringParityGame>;
  canonicalGameReadLimitIds?: ReadonlySet<number>;
  scoringRules: ScoringRules;
  maxFinalGames?: number;
  maxFindings?: number;
}): FinalScoreReconciliationWindowResult {
  const maxFinalGames = Math.max(
    1,
    Math.min(DEFAULT_MAX_FINAL_GAMES, Math.trunc(input.maxFinalGames ?? DEFAULT_MAX_FINAL_GAMES)),
  );
  const maxFindings = Math.max(
    0,
    Math.min(DEFAULT_MAX_FINDINGS, Math.trunc(input.maxFindings ?? DEFAULT_MAX_FINDINGS)),
  );
  const uniqueCompletedGameIds = [...new Set(
    positiveGameIds(input.window.completedGameIds),
  )].sort((left, right) => left - right);
  const gameIdsToInspect = uniqueCompletedGameIds.slice(0, maxFinalGames);
  const storageIssues = getWindowStorageIssues({
    window: input.window,
    teamKey: input.teamKey,
    maxFinalGames,
  });
  const result: FinalScoreReconciliationWindowResult = {
    windowCount: 1,
    finalizedGameCount: gameIdsToInspect.length,
    verifiedGameCount: 0,
    candidateGameCount: 0,
    unverifiableGameCount: 0,
    integrityIssueCount: storageIssues.length,
    findingCount: storageIssues.length,
    findingsTruncated: false,
    findings: storageIssues.slice(0, maxFindings),
  };
  const pushFinding = (finding: FinalScoreReconciliationFinding): void => {
    result.findingCount += 1;

    if (result.findings.length < maxFindings) {
      result.findings.push(finding);
    } else {
      result.findingsTruncated = true;
    }
  };

  if (storageIssues.length > maxFindings) {
    result.findingsTruncated = true;
  }

  for (const gameId of gameIdsToInspect) {
    const gameIdKey = String(gameId);
    const storedPoints = input.window.gameScores[gameIdKey];
    const storedAppeared = input.window.appearanceGameIds.includes(gameId);
    const storedEvidence = input.window.gameInputCompleteness?.[gameIdKey];
    const assetType = assetTypeForWindow(input.window);

    if (assetType === 'unknown') {
      result.unverifiableGameCount += 1;
      pushFinding(baseFinding({
        window: input.window,
        teamKey: input.teamKey,
        status: 'unverifiable',
        code: 'window-asset-invalid',
        gameId,
        reason: 'The saved window does not contain a supported scoring asset.',
      }));
      continue;
    }

    if (typeof storedPoints !== 'number' || !Number.isFinite(storedPoints)) {
      result.candidateGameCount += 1;
      pushFinding(baseFinding({
        window: input.window,
        teamKey: input.teamKey,
        status: 'candidate',
        code: 'stored-final-score-missing',
        gameId,
        reason: 'A completed NHL game does not have a finite saved score.',
      }));
      continue;
    }

    if (!storedEvidence) {
      result.unverifiableGameCount += 1;
      pushFinding({
        ...baseFinding({
          window: input.window,
          teamKey: input.teamKey,
          status: 'unverifiable',
          code: 'stored-final-evidence-missing',
          gameId,
          reason: 'The saved final predates or is missing the D1L source-completeness contract.',
        }),
        storedPoints: rounded(storedPoints),
        storedAppeared,
      });
      continue;
    }

    if (!hasReusableStoredFinal({
      window: input.window,
      gameId,
      score: storedPoints,
    })) {
      result.unverifiableGameCount += 1;
      pushFinding({
        ...baseFinding({
          window: input.window,
          teamKey: input.teamKey,
          status: 'unverifiable',
          code: 'stored-final-evidence-incomplete',
          gameId,
          reason: 'The saved final does not satisfy the reusable source-completeness contract.',
        }),
        storedPoints: rounded(storedPoints),
        storedAppeared,
        storedSourceVersion: storedEvidence.sourceVersion,
      });
      continue;
    }

    const canonicalGame = input.canonicalGamesById.get(gameId);

    if (!canonicalGame) {
      result.unverifiableGameCount += 1;
      const readLimitReached = input.canonicalGameReadLimitIds?.has(gameId) === true;
      pushFinding({
        ...baseFinding({
          window: input.window,
          teamKey: input.teamKey,
          status: 'unverifiable',
          code: readLimitReached
            ? 'canonical-game-read-limit-reached'
            : 'canonical-game-missing',
          gameId,
          reason: readLimitReached
            ? 'This game is beyond the bounded canonical-read limit for the current page.'
            : 'No valid current canonical game document is available for comparison.',
        }),
        storedPoints: rounded(storedPoints),
        storedAppeared,
        storedSourceVersion: storedEvidence.sourceVersion,
      });
      continue;
    }

    const observation = compareDirectAndCanonicalGameScore({
      gameId,
      asset: input.window.asset,
      canonicalGame,
      gameIsFinal: true,
      scoringRules: input.scoringRules,
      directPoints: storedPoints,
      directAppeared: storedAppeared,
    });

    if (observation.status !== 'matched' && observation.status !== 'mismatch') {
      result.unverifiableGameCount += 1;
      pushFinding({
        ...baseFinding({
          window: input.window,
          teamKey: input.teamKey,
          status: 'unverifiable',
          code: 'canonical-final-evidence-incomplete',
          gameId,
          reason: observation.reason,
        }),
        storedPoints: observation.directPoints,
        canonicalPoints: observation.canonicalPoints,
        pointDelta: observation.pointDelta,
        storedAppeared: observation.directAppeared,
        canonicalAppeared: observation.canonicalAppeared,
        storedSourceVersion: storedEvidence.sourceVersion,
        canonicalSourceVersion: observation.sourceVersion,
      });
      continue;
    }

    if (observation.status === 'matched') {
      result.verifiedGameCount += 1;
      continue;
    }

    result.candidateGameCount += 1;
    const pointsDiffer = observation.pointDelta !== 0;
    const appearanceDiffers =
      observation.canonicalAppeared !== observation.directAppeared;
    const code: FinalScoreReconciliationFindingCode =
      pointsDiffer && appearanceDiffers
        ? 'score-and-appearance-mismatch'
        : pointsDiffer
          ? 'score-mismatch'
          : 'appearance-mismatch';
    pushFinding({
      ...baseFinding({
        window: input.window,
        teamKey: input.teamKey,
        status: 'candidate',
        code,
        gameId,
        reason: 'The saved final differs from complete current canonical evidence.',
      }),
      storedPoints: observation.directPoints,
      canonicalPoints: observation.canonicalPoints,
      pointDelta: observation.pointDelta,
      storedAppeared: observation.directAppeared,
      canonicalAppeared: observation.canonicalAppeared,
      storedSourceVersion: storedEvidence.sourceVersion,
      canonicalSourceVersion: observation.sourceVersion,
    });
  }

  return result;
}
