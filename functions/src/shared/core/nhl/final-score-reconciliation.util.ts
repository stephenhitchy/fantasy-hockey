import type { FantasyAssetCycleWindow } from '../cycle/cycle.models';
import type { ScoringRules } from '../scoring/scoring-rules';
import { isSafeFirestoreDocumentId } from '../../security/firestore-document-id-core.util';
import {
  FIRESTORE_AUTH_USER_ID_OPTIONS,
  FIRESTORE_ROSTER_SLOT_ID_OPTIONS,
} from '../../security/firestore-document-id-policies';
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
  inspectionLimitReached: boolean;
  findingsTruncated: boolean;
  findings: FinalScoreReconciliationFinding[];
}

export interface FinalScoreTeamWindowStructureInspection {
  allWindowCount: number;
  safeWindowValues: Array<Partial<FantasyAssetCycleWindow>>;
  inspectionIncomplete: boolean;
  finding: FinalScoreReconciliationFinding | null;
}

export interface FinalScoreCycleTeamWindowScopeInspection {
  expectedTeamDocumentIds: string[];
  expectedRosterSlotIdsByTeam: Record<string, string[]>;
  inspectionIncomplete: boolean;
  reason: string;
}

export interface FinalScoreTeamWindowRosterScopeInspection {
  safeWindowValues: Array<Partial<FantasyAssetCycleWindow>>;
  inspectionIncomplete: boolean;
  reason: string;
}

const DEFAULT_MAX_FINAL_GAMES = 12;
const DEFAULT_MAX_FINDINGS = 24;
const DEFAULT_MAX_TEAM_DOCUMENTS = 32;
const DEFAULT_MAX_WINDOWS_PER_TEAM = 32;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function inspectFinalScoreCycleTeamWindowScope(input: {
  expectedRosterSlotIdsByOwner: unknown;
  totalExpectedWindowCount: unknown;
  windowSchemaVersion: unknown;
  maxTeamDocuments?: number;
  maxWindowsPerTeam?: number;
}): FinalScoreCycleTeamWindowScopeInspection {
  const expectedByOwner = input.expectedRosterSlotIdsByOwner;
  const maxTeamDocuments = Math.max(
    1,
    Math.floor(input.maxTeamDocuments ?? DEFAULT_MAX_TEAM_DOCUMENTS),
  );
  const maxWindowsPerTeam = Math.max(
    1,
    Math.floor(input.maxWindowsPerTeam ?? DEFAULT_MAX_WINDOWS_PER_TEAM),
  );

  if (!isObjectRecord(expectedByOwner)) {
    return {
      expectedTeamDocumentIds: [],
      expectedRosterSlotIdsByTeam: {},
      inspectionIncomplete: true,
      reason:
        'The cycle omits its expected team-window scope, so missing team documents cannot be ruled out.',
    };
  }

  const entries = Object.entries(expectedByOwner);

  if (entries.length > maxTeamDocuments) {
    return {
      expectedTeamDocumentIds: [],
      expectedRosterSlotIdsByTeam: {},
      inspectionIncomplete: true,
      reason:
        `The cycle exceeds the bounded ${maxTeamDocuments}-team reconciliation scope.`,
    };
  }

  let expectedWindowCount = 0;
  const expectedRosterSlotIdsByTeam: Record<string, string[]> = {};

  for (const [ownerId, rawSlotIds] of entries) {
    if (
      !isSafeFirestoreDocumentId(ownerId, FIRESTORE_AUTH_USER_ID_OPTIONS) ||
      !Array.isArray(rawSlotIds) ||
      rawSlotIds.length > maxWindowsPerTeam
    ) {
      return {
        expectedTeamDocumentIds: [],
        expectedRosterSlotIdsByTeam: {},
        inspectionIncomplete: true,
        reason:
          'The cycle has malformed expected team-window metadata, so document coverage cannot be proven.',
      };
    }

    const slotIds = rawSlotIds.filter(
      (value): value is string =>
        isSafeFirestoreDocumentId(value, FIRESTORE_ROSTER_SLOT_ID_OPTIONS),
    );

    if (slotIds.length !== rawSlotIds.length || new Set(slotIds).size !== slotIds.length) {
      return {
        expectedTeamDocumentIds: [],
        expectedRosterSlotIdsByTeam: {},
        inspectionIncomplete: true,
        reason:
          'The cycle has malformed expected roster-slot metadata, so document coverage cannot be proven.',
      };
    }

    expectedWindowCount += slotIds.length;
    expectedRosterSlotIdsByTeam[ownerId] = [...slotIds];
  }

  if (
    typeof input.windowSchemaVersion !== 'number' ||
    !Number.isInteger(input.windowSchemaVersion) ||
    input.windowSchemaVersion < 1 ||
    typeof input.totalExpectedWindowCount !== 'number' ||
    !Number.isInteger(input.totalExpectedWindowCount) ||
    input.totalExpectedWindowCount !== expectedWindowCount
  ) {
    return {
      expectedTeamDocumentIds: [],
      expectedRosterSlotIdsByTeam: {},
      inspectionIncomplete: true,
      reason:
        'The cycle has inconsistent team-window counts, so document coverage cannot be proven.',
    };
  }

  return {
    expectedTeamDocumentIds: entries.map(([ownerId]) => ownerId).sort(),
    expectedRosterSlotIdsByTeam,
    inspectionIncomplete: false,
    reason: '',
  };
}

export function inspectFinalScoreTeamWindowRosterScope(input: {
  safeWindowValues: Array<Partial<FantasyAssetCycleWindow>>;
  expectedRosterSlotIds: readonly string[];
  teamDocumentId: string;
  cycleNumber: number;
}): FinalScoreTeamWindowRosterScopeInspection {
  const expectedSlotIds = new Set(input.expectedRosterSlotIds);
  const observedSlotIds = new Set<string>();
  const safeWindowValues: Array<Partial<FantasyAssetCycleWindow>> = [];
  let rejectedWindowCount = 0;

  for (const window of input.safeWindowValues) {
    const rosterSlotId = window.rosterSlotId ?? '';
    const inExpectedScope =
      window.ownerId === input.teamDocumentId &&
      window.cycleNumber === input.cycleNumber &&
      expectedSlotIds.has(rosterSlotId) &&
      !observedSlotIds.has(rosterSlotId);

    if (!inExpectedScope) {
      rejectedWindowCount += 1;
      continue;
    }

    observedSlotIds.add(rosterSlotId);
    safeWindowValues.push(window);
  }

  const missingWindowCount = [...expectedSlotIds].filter(
    (slotId) => !observedSlotIds.has(slotId),
  ).length;
  const inspectionIncomplete = rejectedWindowCount > 0 || missingWindowCount > 0;

  return {
    safeWindowValues,
    inspectionIncomplete,
    reason: inspectionIncomplete
      ? `${missingWindowCount} expected window(s) are missing and ` +
        `${rejectedWindowCount} duplicate or out-of-scope window(s) were excluded.`
      : '',
  };
}

function isPositiveGameIdArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(
    (gameId) => typeof gameId === 'number' && Number.isInteger(gameId) && gameId > 0,
  );
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isNullableInteger(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isInteger(value));
}

function isNullablePositiveInteger(value: unknown): boolean {
  return value === null ||
    (typeof value === 'number' && Number.isInteger(value) && value > 0);
}

function hasFiniteNumberFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return fields.every(
    (field) => typeof value[field] === 'number' && Number.isFinite(value[field]),
  );
}

function hasCompleteCanonicalFactStructure(
  game: CanonicalScoringParityGame,
): boolean {
  const facts = game.facts as unknown as Record<string, unknown>;
  const skaters = facts['skaters'];
  const goalies = facts['goalies'];
  const goals = facts['goals'];
  const settlements = facts['finalSettlements'];
  const finalSettlementPlayerIds = facts['finalSettlementPlayerIds'];
  const playerIds = facts['playerIds'];
  const teamAbbreviations = facts['teamAbbreviations'];

  return (
    (facts['gameState'] === 'scheduled' ||
      facts['gameState'] === 'live' ||
      facts['gameState'] === 'final') &&
    typeof facts['sourceGameState'] === 'string' &&
    typeof facts['sourceGameScheduleState'] === 'string' &&
    typeof facts['gameDate'] === 'string' &&
    typeof facts['startTimeUTC'] === 'string' &&
    isNullableInteger(facts['period']) &&
    typeof facts['periodType'] === 'string' &&
    typeof facts['clockTimeRemaining'] === 'string' &&
    typeof facts['clockRunning'] === 'boolean' &&
    typeof facts['inIntermission'] === 'boolean' &&
    typeof facts['homeTeamAbbreviation'] === 'string' &&
    Boolean(facts['homeTeamAbbreviation']) &&
    typeof facts['awayTeamAbbreviation'] === 'string' &&
    Boolean(facts['awayTeamAbbreviation']) &&
    hasFiniteNumberFields(facts, ['homeScore', 'awayScore']) &&
    Array.isArray(skaters) &&
    skaters.every((value) => {
      if (!isObjectRecord(value)) {
        return false;
      }

      return isPositiveInteger(value['playerId']) &&
        typeof value['teamAbbreviation'] === 'string' &&
        Boolean(value['teamAbbreviation']) &&
        typeof value['position'] === 'string' &&
        hasFiniteNumberFields(value, [
          'goals',
          'assists',
          'primaryAssists',
          'secondaryAssists',
          'shotsOnGoal',
          'hits',
          'blockedShots',
          'plusMinus',
          'powerPlayGoals',
          'timeOnIceSeconds',
        ]);
    }) &&
    Array.isArray(goalies) &&
    goalies.every((value) => {
      if (!isObjectRecord(value)) {
        return false;
      }

      return isPositiveInteger(value['playerId']) &&
        typeof value['teamAbbreviation'] === 'string' &&
        Boolean(value['teamAbbreviation']) &&
        typeof value['starter'] === 'boolean' &&
        typeof value['decision'] === 'string' &&
        hasFiniteNumberFields(value, [
          'goalsAgainst',
          'saves',
          'shotsAgainst',
          'timeOnIceSeconds',
        ]);
    }) &&
    Array.isArray(goals) &&
    goals.every((value) =>
      isObjectRecord(value) &&
      isNullableInteger(value['eventId']) &&
      isNullableInteger(value['period']) &&
      typeof value['periodType'] === 'string' &&
      typeof value['timeInPeriod'] === 'string' &&
      isNullablePositiveInteger(value['scoringPlayerId']) &&
      isNullablePositiveInteger(value['assist1PlayerId']) &&
      isNullablePositiveInteger(value['assist2PlayerId']) &&
      typeof value['situationCode'] === 'string' &&
      (value['homeScore'] === null ||
        (typeof value['homeScore'] === 'number' && Number.isFinite(value['homeScore']))) &&
      (value['awayScore'] === null ||
        (typeof value['awayScore'] === 'number' && Number.isFinite(value['awayScore'])))
    ) &&
    Array.isArray(settlements) &&
    settlements.every((value) => {
      if (!isObjectRecord(value)) {
        return false;
      }

      return isPositiveInteger(value['playerId']) &&
        hasFiniteNumberFields(value, [
          'goals',
          'assists',
          'shotsOnGoal',
          'plusMinus',
          'powerPlayPoints',
          'shortHandedPoints',
          'timeOnIceSeconds',
        ]) &&
        typeof value['gameWinningGoal'] === 'boolean' &&
        typeof value['overtimeGoal'] === 'boolean' &&
        value['source'] === 'player-game-log';
    }) &&
    isPositiveGameIdArray(finalSettlementPlayerIds) &&
    isPositiveGameIdArray(playerIds) &&
    Array.isArray(teamAbbreviations) &&
    teamAbbreviations.every(
      (value) => typeof value === 'string' && Boolean(value),
    )
  );
}

function hasReconcilableAssetStructure(
  value: unknown,
): value is Record<string, unknown> {
  if (!isObjectRecord(value) || typeof value['assetKey'] !== 'string' || !value['assetKey']) {
    return false;
  }

  if (value['assetType'] === 'skater') {
    const player = value['player'];

    return (
      (value['position'] === 'LW' ||
        value['position'] === 'C' ||
        value['position'] === 'RW' ||
        value['position'] === 'D') &&
      isObjectRecord(player) &&
      typeof player['id'] === 'number' &&
      Number.isInteger(player['id']) &&
      player['id'] > 0
    );
  }

  return value['assetType'] === 'team-goalie-unit' &&
    value['position'] === 'G' &&
    typeof value['teamAbbreviation'] === 'string' &&
    Boolean(value['teamAbbreviation'].trim());
}

function hasRequiredFinalScoreWindowStructure(
  value: Record<string, unknown>,
): boolean {
  const asset = value['asset'];

  return (
    typeof value['id'] === 'string' && Boolean(value['id']) &&
    typeof value['ownerId'] === 'string' && Boolean(value['ownerId']) &&
    typeof value['rosterSlotId'] === 'string' && Boolean(value['rosterSlotId']) &&
    typeof value['cycleNumber'] === 'number' &&
    Number.isInteger(value['cycleNumber']) &&
    value['cycleNumber'] > 0 &&
    typeof value['assetKey'] === 'string' && Boolean(value['assetKey']) &&
    hasReconcilableAssetStructure(asset) &&
    asset['assetKey'] === value['assetKey'] &&
    asset['position'] === value['position'] &&
    (value['status'] === 'scheduled' ||
      value['status'] === 'active' ||
      value['status'] === 'complete') &&
    isPositiveGameIdArray(value['scheduledGameIds']) &&
    isPositiveGameIdArray(value['completedGameIds']) &&
    isPositiveGameIdArray(value['liveGameIds']) &&
    isPositiveGameIdArray(value['appearanceGameIds']) &&
    (value['incompleteFinalGameIds'] === undefined ||
      isPositiveGameIdArray(value['incompleteFinalGameIds'])) &&
    isObjectRecord(value['gameScores']) &&
    isObjectRecord(value['gameStates']) &&
    isNonnegativeInteger(value['scheduledGames']) &&
    isNonnegativeInteger(value['gamesPlayed']) &&
    isNonnegativeInteger(value['actualGamesPlayed']) &&
    isNonnegativeInteger(value['gamesLeft']) &&
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
    (value): value is Partial<FantasyAssetCycleWindow> =>
      isObjectRecord(value) && hasRequiredFinalScoreWindowStructure(value),
  );
  const malformedWindowCount = input.rawWindows.length - safeWindowValues.length;

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
    inspectionLimitReached: uniqueCompletedGameIds.length > maxFinalGames,
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
      result.unverifiableGameCount += 1;
      pushFinding(baseFinding({
        window: input.window,
        teamKey: input.teamKey,
        status: 'unverifiable',
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

    if (
      canonicalGame.facts.gameState !== 'final' ||
      !hasCompleteCanonicalFactStructure(canonicalGame)
    ) {
      result.unverifiableGameCount += 1;
      pushFinding({
        ...baseFinding({
          window: input.window,
          teamKey: input.teamKey,
          status: 'unverifiable',
          code: 'canonical-final-evidence-incomplete',
          gameId,
          reason: canonicalGame.facts.gameState !== 'final'
            ? 'The current canonical game facts are not in a final state.'
            : 'The current canonical game facts are structurally incomplete.',
        }),
        storedPoints: rounded(storedPoints),
        storedAppeared,
        storedSourceVersion: storedEvidence.sourceVersion,
        canonicalSourceVersion: canonicalGame.sourceVersion,
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

    const observationHasFiniteScore =
      typeof observation.canonicalPoints === 'number' &&
      Number.isFinite(observation.canonicalPoints) &&
      typeof observation.pointDelta === 'number' &&
      Number.isFinite(observation.pointDelta) &&
      typeof observation.canonicalAppeared === 'boolean';

    if (
      (observation.status !== 'matched' && observation.status !== 'mismatch') ||
      !observationHasFiniteScore
    ) {
      result.unverifiableGameCount += 1;
      pushFinding({
        ...baseFinding({
          window: input.window,
          teamKey: input.teamKey,
          status: 'unverifiable',
          code: 'canonical-final-evidence-incomplete',
          gameId,
          reason: observation.status === 'matched' || observation.status === 'mismatch'
            ? 'canonical-score-invalid'
            : observation.reason,
        }),
        storedPoints: observation.directPoints,
        canonicalPoints: observationHasFiniteScore ? observation.canonicalPoints : null,
        pointDelta: observationHasFiniteScore ? observation.pointDelta : null,
        storedAppeared: observation.directAppeared,
        canonicalAppeared:
          typeof observation.canonicalAppeared === 'boolean'
            ? observation.canonicalAppeared
            : null,
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
