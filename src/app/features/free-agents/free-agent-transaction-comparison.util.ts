import type { FantasyAssetCycleWindow } from '../../core/cycle/cycle.models';
import type {
  ProjectionCycleGameMarker,
  ProjectionStatBreakdownItem,
} from '../../core/draft/draft.models';
import type {
  RosterMoveAssetCycleEligibility,
  RosterMoveEligibilityGame,
} from '../../core/transactions/roster-move-eligibility.service';


export interface FreeAgentStatComparisonRow {
  key: string;
  label: string;
  outgoing: ProjectionStatBreakdownItem | null;
  incoming: ProjectionStatBreakdownItem | null;
}

export function buildFreeAgentStatComparisonRows(
  outgoingItems: readonly ProjectionStatBreakdownItem[] | null | undefined,
  incomingItems: readonly ProjectionStatBreakdownItem[] | null | undefined,
): FreeAgentStatComparisonRow[] {
  const outgoingByKey = new Map(
    (outgoingItems ?? []).map((item) => [item.key, item] as const),
  );
  const incomingByKey = new Map(
    (incomingItems ?? []).map((item) => [item.key, item] as const),
  );
  const orderedKeys: string[] = [];

  for (const item of incomingItems ?? []) {
    if (!orderedKeys.includes(item.key)) {
      orderedKeys.push(item.key);
    }
  }

  for (const item of outgoingItems ?? []) {
    if (!orderedKeys.includes(item.key)) {
      orderedKeys.push(item.key);
    }
  }

  return orderedKeys.map((key) => {
    const incoming = incomingByKey.get(key) ?? null;
    const outgoing = outgoingByKey.get(key) ?? null;

    return {
      key,
      label: incoming?.label ?? outgoing?.label ?? key,
      outgoing,
      incoming,
    };
  });
}

export type FreeAgentComparisonGameState =
  | 'appeared'
  | 'missed'
  | 'final'
  | 'live'
  | 'upcoming'
  | 'pending';

export interface FreeAgentComparisonGame {
  gameNumber: number;
  gameId: number | null;
  gameDate: string;
  opponentLabel: string;
  state: FreeAgentComparisonGameState;
  fantasyPoints: number | null;
  counted: boolean;
}

export type FreeAgentMatchupRelationship =
  | 'same-matchup'
  | 'incoming-behind'
  | 'incoming-ahead'
  | 'unknown';

export type FreeAgentTransactionDelaySource =
  | 'none'
  | 'outgoing-player'
  | 'incoming-player'
  | 'both-players'
  | 'roster-boundary'
  | 'bench'
  | 'waiver';

export interface FreeAgentTransactionTimingInput {
  incomingName: string;
  outgoingName: string | null;
  rosterArea: 'active' | 'bench';
  isWaiver: boolean;
  seasonHasStarted: boolean;
  canApplyImmediately: boolean;
  effectiveCycleNumber: number;
  slotNextCycleNumber: number;
  outgoingCycleNumber: number | null;
  outgoingWindowStatus: FantasyAssetCycleWindow['status'] | null;
  outgoingFinalGames: number;
  outgoingLiveGames: number;
  outgoingScheduledGames: number;
  incomingCurrentCycleNumber: number | null;
  incomingFinalGames: number;
  incomingLiveGames: number;
  incomingScheduledGames: number;
  incomingHasStarted: boolean;
  incomingEarliestCycleNumber: number | null;
}

export interface FreeAgentTransactionTimingDecision {
  delaySource: FreeAgentTransactionDelaySource;
  relationship: FreeAgentMatchupRelationship;
  tone: 'ready' | 'waiting' | 'conditional';
  headline: string;
  detail: string;
  relationshipLabel: string;
  startLabel: string;
}

function normalizeRequiredGames(requiredGames: number): number {
  return Math.max(1, Math.floor(requiredGames));
}

function roundedPoints(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Number(value.toFixed(1))
    : null;
}

function createPendingGame(gameNumber: number): FreeAgentComparisonGame {
  return {
    gameNumber,
    gameId: null,
    gameDate: '',
    opponentLabel: 'Schedule pending',
    state: 'pending',
    fantasyPoints: null,
    counted: false,
  };
}

export function buildOutgoingWindowComparisonGames(
  window: FantasyAssetCycleWindow | null,
  requiredGames: number,
): FreeAgentComparisonGame[] {
  const gameCount = normalizeRequiredGames(requiredGames);

  if (!window) {
    return Array.from({ length: gameCount }, (_, index) => createPendingGame(index + 1));
  }

  const completedGameIds = new Set(window.completedGameIds);
  const liveGameIds = new Set(window.liveGameIds);
  const appearanceGameIds = new Set(window.appearanceGameIds);

  return Array.from({ length: gameCount }, (_, index) => {
    const gameId = window.scheduledGameIds[index];

    if (typeof gameId !== 'number') {
      return createPendingGame(index + 1);
    }

    const key = String(gameId);
    const storedState = window.gameStates[key];
    const runtimeState = storedState === 'final' || completedGameIds.has(gameId)
      ? 'final'
      : storedState === 'live' || liveGameIds.has(gameId)
        ? 'live'
        : 'scheduled';
    const appeared = appearanceGameIds.has(gameId);
    const state: FreeAgentComparisonGameState = runtimeState === 'final'
      ? appeared
        ? 'appeared'
        : 'missed'
      : runtimeState === 'live'
        ? 'live'
        : 'upcoming';

    return {
      gameNumber: index + 1,
      gameId,
      gameDate: window.scheduledGameDates[index] ?? '',
      opponentLabel: window.scheduledGameLabels[index] ?? 'NHL team game',
      state,
      fantasyPoints: runtimeState === 'scheduled'
        ? null
        : roundedPoints(window.gameScores[key]),
      counted: runtimeState === 'final',
    };
  });
}


export function buildProjectionMarkerComparisonGames(
  projectionMarkers: readonly ProjectionCycleGameMarker[] | null | undefined,
  requiredGames: number,
): FreeAgentComparisonGame[] {
  const gameCount = normalizeRequiredGames(requiredGames);
  const markers = projectionMarkers ?? [];

  return Array.from({ length: gameCount }, (_, index) => {
    const marker = markers[index];

    if (!marker) {
      return createPendingGame(index + 1);
    }

    const state: FreeAgentComparisonGameState = marker.status === 'played'
      ? 'appeared'
      : marker.status === 'missed'
        ? 'missed'
        : 'upcoming';

    return {
      gameNumber: index + 1,
      gameId: marker.gameId,
      gameDate: marker.gameDate,
      opponentLabel: `${marker.venue === 'home' ? 'vs' : '@'} ${marker.opponentAbbreviation}`,
      state,
      fantasyPoints: null,
      counted: marker.status === 'played' || marker.status === 'missed',
    };
  });
}

function toOpponentLabel(game: RosterMoveEligibilityGame): string {
  return `${game.venue === 'home' ? 'vs' : '@'} ${game.opponentAbbreviation}`;
}

export function buildIncomingEligibilityComparisonGames(
  eligibility: RosterMoveAssetCycleEligibility | null,
  cycleNumber: number | null,
  projectionMarkers: readonly ProjectionCycleGameMarker[] | null | undefined,
  requiredGames: number,
): FreeAgentComparisonGame[] {
  const gameCount = normalizeRequiredGames(requiredGames);

  if (!eligibility || typeof cycleNumber !== 'number') {
    return Array.from({ length: gameCount }, (_, index) => createPendingGame(index + 1));
  }

  const games = eligibility.gamesByCycleNumber?.[cycleNumber] ??
    (cycleNumber === eligibility.currentCycleNumber ? eligibility.currentCycleGames : []);
  const projectionByGameId = new Map(
    (projectionMarkers ?? []).map((marker) => [marker.gameId, marker] as const),
  );

  return Array.from({ length: gameCount }, (_, index) => {
    const game = games[index];

    if (!game) {
      return createPendingGame(index + 1);
    }

    const marker = projectionByGameId.get(game.gameId);
    const state: FreeAgentComparisonGameState = game.state === 'final'
      ? marker?.status === 'missed'
        ? 'missed'
        : marker?.status === 'played'
          ? 'appeared'
          : 'final'
      : game.state === 'live'
        ? 'live'
        : 'upcoming';

    return {
      gameNumber: index + 1,
      gameId: game.gameId,
      gameDate: game.gameDate,
      opponentLabel: toOpponentLabel(game),
      state,
      fantasyPoints: null,
      counted: game.state === 'final',
    };
  });
}

function pluralize(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function getRelationship(
  outgoingCycleNumber: number | null,
  incomingCycleNumber: number | null,
): FreeAgentMatchupRelationship {
  if (typeof outgoingCycleNumber !== 'number' || typeof incomingCycleNumber !== 'number') {
    return 'unknown';
  }

  if (outgoingCycleNumber === incomingCycleNumber) {
    return 'same-matchup';
  }

  return incomingCycleNumber < outgoingCycleNumber
    ? 'incoming-behind'
    : 'incoming-ahead';
}

function buildRelationshipLabel(
  relationship: FreeAgentMatchupRelationship,
  input: FreeAgentTransactionTimingInput,
): string {
  const outgoingCycle = input.outgoingCycleNumber ?? input.slotNextCycleNumber;
  const incomingCycle = input.incomingCurrentCycleNumber;

  if (relationship === 'same-matchup' && typeof incomingCycle === 'number') {
    return `Both sides are currently aligned to Matchup ${incomingCycle}.`;
  }

  if (relationship === 'incoming-behind' && typeof incomingCycle === 'number') {
    const difference = Math.max(1, outgoingCycle - incomingCycle);
    return `${input.incomingName} is ${pluralize(difference, 'matchup')} behind the selected roster slot (Matchup ${incomingCycle} vs Matchup ${outgoingCycle}). Being behind never backfills the incoming player into games already assigned to the roster slot.`;
  }

  if (relationship === 'incoming-ahead' && typeof incomingCycle === 'number') {
    const difference = Math.max(1, incomingCycle - outgoingCycle);
    return `${input.incomingName} is ${pluralize(difference, 'matchup')} ahead of the selected roster slot (Matchup ${incomingCycle} vs Matchup ${outgoingCycle}). Earlier games from that later block cannot be acquired after they have started.`;
  }

  return 'RinkRat compares the exact incoming NHL block with the selected roster slot before choosing the first legal matchup.';
}

function withWaiverCondition(
  input: FreeAgentTransactionTimingInput,
  decision: Omit<FreeAgentTransactionTimingDecision, 'relationship' | 'relationshipLabel' | 'startLabel'>,
  relationship: FreeAgentMatchupRelationship,
  relationshipLabel: string,
): FreeAgentTransactionTimingDecision {
  if (!input.isWaiver) {
    return {
      ...decision,
      relationship,
      relationshipLabel,
      startLabel: `Starts Matchup ${input.effectiveCycleNumber}`,
    };
  }

  return {
    ...decision,
    delaySource: decision.delaySource === 'none' ? 'waiver' : decision.delaySource,
    tone: 'conditional',
    headline: `If the claim is awarded: ${decision.headline.charAt(0).toLowerCase()}${decision.headline.slice(1)}`,
    detail: `Waiver processing happens first. ${decision.detail}`,
    relationship,
    relationshipLabel,
    startLabel: `If awarded · Matchup ${input.effectiveCycleNumber}`,
  };
}

export function resolveFreeAgentTransactionTiming(
  input: FreeAgentTransactionTimingInput,
): FreeAgentTransactionTimingDecision {
  const relationship = getRelationship(
    input.outgoingCycleNumber ?? input.slotNextCycleNumber,
    input.incomingCurrentCycleNumber,
  );
  const relationshipLabel = buildRelationshipLabel(relationship, input);
  const outgoingName = input.outgoingName ?? 'The open roster spot';
  const outgoingStarted = input.outgoingFinalGames > 0 || input.outgoingLiveGames > 0;
  const outgoingComplete =
    input.outgoingWindowStatus === 'complete' ||
    (input.outgoingScheduledGames > 0 && input.outgoingFinalGames >= input.outgoingScheduledGames);
  const incomingEarliest = input.incomingEarliestCycleNumber ?? input.effectiveCycleNumber;

  if (!input.seasonHasStarted) {
    return withWaiverCondition(
      input,
      {
        delaySource: 'none',
        tone: 'ready',
        headline: `No delay — starts before Matchup ${input.effectiveCycleNumber}`,
        detail: 'The season has not started, so no completed NHL team games or roster-slot results need to be protected.',
      },
      relationship,
      relationshipLabel,
    );
  }

  if (input.rosterArea === 'bench') {
    const benchDetail = input.outgoingName
      ? `${outgoingName} leaves the bench immediately. ${input.incomingName} is owned immediately, but bench players do not score until they enter a legal starting slot.`
      : `${input.incomingName} is owned immediately in the open bench spot, but bench players do not score until they enter a legal starting slot.`;

    return withWaiverCondition(
      input,
      {
        delaySource: input.incomingHasStarted ? 'incoming-player' : 'bench',
        tone: input.incomingHasStarted ? 'waiting' : 'ready',
        headline: `Bench changes now · first scoring start Matchup ${input.effectiveCycleNumber}`,
        detail: `${benchDetail} The earliest active six-game window is Matchup ${input.effectiveCycleNumber}; no prior games are backfilled.`,
      },
      relationship,
      relationshipLabel,
    );
  }

  if (input.canApplyImmediately) {
    const alignmentDetail = relationship === 'same-matchup'
      ? `Both sides are aligned to Matchup ${input.effectiveCycleNumber}, and neither assignment has started.`
      : relationship === 'incoming-behind'
        ? `${input.incomingName} is behind the slot's matchup, but this exact roster assignment is still untouched.`
        : relationship === 'incoming-ahead'
          ? `${input.incomingName} is ahead of the slot, but the applicable Matchup ${input.effectiveCycleNumber} block has not started.`
          : 'Neither side has a counted game that would need to be rewritten.';

    return withWaiverCondition(
      input,
      {
        delaySource: 'none',
        tone: 'ready',
        headline: `No delay — starts in Matchup ${input.effectiveCycleNumber}`,
        detail: `${alignmentDetail} RinkRat can replace only this untouched assignment without changing any completed game.`,
      },
      relationship,
      relationshipLabel,
    );
  }

  let delaySource: FreeAgentTransactionDelaySource;

  if (incomingEarliest > input.slotNextCycleNumber) {
    delaySource = 'incoming-player';
  } else if (input.slotNextCycleNumber > incomingEarliest) {
    delaySource = outgoingComplete ? 'roster-boundary' : 'outgoing-player';
  } else if (outgoingStarted && input.incomingHasStarted) {
    delaySource = 'both-players';
  } else if (input.incomingHasStarted) {
    delaySource = 'incoming-player';
  } else if (outgoingComplete) {
    delaySource = 'roster-boundary';
  } else if (outgoingStarted) {
    delaySource = 'outgoing-player';
  } else {
    delaySource = 'roster-boundary';
  }

  if (delaySource === 'incoming-player') {
    const liveCopy = input.incomingLiveGames > 0
      ? ` and ${pluralize(input.incomingLiveGames, 'game')} live`
      : '';

    return withWaiverCondition(
      input,
      {
        delaySource,
        tone: 'waiting',
        headline: `${input.incomingName} is delaying the transaction`,
        detail: `${input.incomingName}'s NHL team has already completed ${input.incomingFinalGames}/${input.incomingScheduledGames} games in Matchup ${input.incomingCurrentCycleNumber ?? '—'}${liveCopy}. Those games cannot be added to your roster after the fact. Even if the selected slot is ready sooner, the change takes place in the next clean matchup window: Matchup ${input.effectiveCycleNumber}.`,
      },
      relationship,
      relationshipLabel,
    );
  }

  if (delaySource === 'both-players') {
    return withWaiverCondition(
      input,
      {
        delaySource,
        tone: 'waiting',
        headline: 'Both players are holding the move until the next clean window',
        detail: `${outgoingName} has already started the selected Matchup ${input.outgoingCycleNumber ?? '—'} roster window (${input.outgoingFinalGames}/${input.outgoingScheduledGames} games final), and ${input.incomingName}'s Matchup ${input.incomingCurrentCycleNumber ?? '—'} NHL block has also started (${input.incomingFinalGames}/${input.incomingScheduledGames} games final). RinkRat protects both histories and starts the change in Matchup ${input.effectiveCycleNumber}.`,
      },
      relationship,
      relationshipLabel,
    );
  }

  if (delaySource === 'outgoing-player') {
    const gamesRemaining = Math.max(
      0,
      input.outgoingScheduledGames - input.outgoingFinalGames,
    );
    const liveCopy = input.outgoingLiveGames > 0
      ? ` ${pluralize(input.outgoingLiveGames, 'game')} is currently live.`
      : '';

    return withWaiverCondition(
      input,
      {
        delaySource,
        tone: 'waiting',
        headline: `${outgoingName} is delaying the transaction`,
        detail: `${outgoingName} still owns the selected roster slot in Matchup ${input.outgoingCycleNumber ?? '—'} with ${input.outgoingFinalGames}/${input.outgoingScheduledGames} NHL team games final and ${pluralize(gamesRemaining, 'game')} remaining.${liveCopy} ${input.incomingName} may already be eligible, but a started six-game window cannot be replaced. The new player starts in Matchup ${input.effectiveCycleNumber}.`,
      },
      relationship,
      relationshipLabel,
    );
  }

  return withWaiverCondition(
    input,
    {
      delaySource: 'roster-boundary',
      tone: 'waiting',
      headline: `Waiting for the selected roster slot to open Matchup ${input.effectiveCycleNumber}`,
      detail: outgoingComplete
        ? `${outgoingName} has completed all ${input.outgoingScheduledGames || 6} games. The player is no longer delaying the move; RinkRat is waiting only for the next immutable roster-slot window to open.`
        : `No player-specific conflict remains, but the selected roster assignment cannot change until its next legal Matchup ${input.effectiveCycleNumber} window is created.`,
    },
    relationship,
    relationshipLabel,
  );
}
