import type {
  DraftAutoPickReason,
  DraftQueue,
} from './shared/core/draft/draft.models';

export type DraftEffectiveMode =
  | 'manual-with-deadline'
  | 'manager-auto'
  | 'timeout-auto';

export type DraftAutomaticActionBlockReason =
  | 'missing-clock'
  | 'stale-session'
  | 'stale-pick'
  | 'stale-owner'
  | 'stale-pick-start'
  | 'before-deadline';

export interface DraftAutomaticActionExpectation {
  expectedOverallPick: number;
  expectedOwnerId?: string;
  expectedPickStartedAtMilliseconds: number;
  expectedDueAtMilliseconds: number;
  expectedDraftStartedAtMilliseconds?: number;
}

export interface DraftAutomaticActionInput {
  queue: Pick<
    DraftQueue,
    | 'autoDraftEnabled'
    | 'autoDraftActivatedByTimeout'
    | 'consecutiveClockExpirations'
  >;
  currentOverallPick: number;
  currentOwnerId: string;
  pickStartedAtMilliseconds: number | null;
  draftStartedAtMilliseconds: number | null;
  pickSeconds: number;
  autoDraftStepDelayMilliseconds: number;
  nowMilliseconds: number;
  expectation?: DraftAutomaticActionExpectation;
}

export interface DraftAutomaticActionDecision {
  eligible: boolean;
  effectiveMode: DraftEffectiveMode;
  autoPickReason: DraftAutoPickReason | null;
  dueAtMilliseconds: number | null;
  blockedReason: DraftAutomaticActionBlockReason | null;
}

export interface DraftQueueAutomaticState {
  autoDraftEnabled: boolean;
  consecutiveClockExpirations: number;
  autoDraftActivatedByTimeout: boolean;
}

/**
 * The stored preference and the server's missed-turn fallback are intentionally
 * separate concepts. The timeout marker wins for presentation and diagnostics
 * because it proves the manager did not explicitly choose the fast mode.
 */
export function getDraftEffectiveMode(
  queue: DraftAutomaticActionInput['queue'],
): DraftEffectiveMode {
  if (queue.autoDraftActivatedByTimeout) {
    return 'timeout-auto';
  }

  if (queue.autoDraftEnabled) {
    return 'manager-auto';
  }

  return 'manual-with-deadline';
}

export function getDraftAutomaticActionDecision(
  input: DraftAutomaticActionInput,
): DraftAutomaticActionDecision {
  const effectiveMode = getDraftEffectiveMode(input.queue);
  const expectation = input.expectation;

  if (input.pickStartedAtMilliseconds === null) {
    return {
      eligible: false,
      effectiveMode,
      autoPickReason: null,
      dueAtMilliseconds: null,
      blockedReason: 'missing-clock',
    };
  }

  if (
    expectation?.expectedDraftStartedAtMilliseconds !== undefined &&
    input.draftStartedAtMilliseconds !== expectation.expectedDraftStartedAtMilliseconds
  ) {
    return {
      eligible: false,
      effectiveMode,
      autoPickReason: null,
      dueAtMilliseconds: null,
      blockedReason: 'stale-session',
    };
  }

  if (
    expectation &&
    input.currentOverallPick !== expectation.expectedOverallPick
  ) {
    return {
      eligible: false,
      effectiveMode,
      autoPickReason: null,
      dueAtMilliseconds: null,
      blockedReason: 'stale-pick',
    };
  }

  if (
    expectation?.expectedOwnerId !== undefined &&
    input.currentOwnerId !== expectation.expectedOwnerId
  ) {
    return {
      eligible: false,
      effectiveMode,
      autoPickReason: null,
      dueAtMilliseconds: null,
      blockedReason: 'stale-owner',
    };
  }

  if (
    expectation &&
    input.pickStartedAtMilliseconds !== expectation.expectedPickStartedAtMilliseconds
  ) {
    return {
      eligible: false,
      effectiveMode,
      autoPickReason: null,
      dueAtMilliseconds: null,
      blockedReason: 'stale-pick-start',
    };
  }

  const dueAtMilliseconds = input.pickStartedAtMilliseconds + (
    effectiveMode === 'manual-with-deadline'
      ? Math.max(1, input.pickSeconds) * 1_000
      : Math.max(1, input.autoDraftStepDelayMilliseconds)
  );
  const authoritativeDueAtMilliseconds = Math.max(
    dueAtMilliseconds,
    expectation?.expectedDueAtMilliseconds ?? dueAtMilliseconds,
  );

  if (input.nowMilliseconds < authoritativeDueAtMilliseconds) {
    return {
      eligible: false,
      effectiveMode,
      autoPickReason: null,
      dueAtMilliseconds: authoritativeDueAtMilliseconds,
      blockedReason: 'before-deadline',
    };
  }

  return {
    eligible: true,
    effectiveMode,
    autoPickReason:
      effectiveMode === 'manager-auto'
        ? 'manager-auto-mode'
        : effectiveMode === 'timeout-auto'
          ? 'timeout-auto-mode'
          : 'timer-expired',
    dueAtMilliseconds: authoritativeDueAtMilliseconds,
    blockedReason: null,
  };
}

export function getDraftQueueStateAfterAutomaticPick(
  queue: DraftAutomaticActionInput['queue'],
  reason: DraftAutoPickReason,
): DraftQueueAutomaticState {
  if (reason !== 'timer-expired') {
    return {
      autoDraftEnabled: queue.autoDraftEnabled,
      consecutiveClockExpirations: queue.consecutiveClockExpirations,
      autoDraftActivatedByTimeout: queue.autoDraftActivatedByTimeout,
    };
  }

  const consecutiveClockExpirations = Math.min(
    2,
    Math.max(0, queue.consecutiveClockExpirations) + 1,
  );
  const autoDraftActivatedByTimeout = consecutiveClockExpirations >= 2;

  return {
    autoDraftEnabled: queue.autoDraftEnabled,
    consecutiveClockExpirations,
    autoDraftActivatedByTimeout:
      queue.autoDraftActivatedByTimeout || autoDraftActivatedByTimeout,
  };
}
