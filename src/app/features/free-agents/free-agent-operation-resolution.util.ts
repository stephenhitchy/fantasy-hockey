export type FreeAgentOperationExpectation =
  | {
      kind: 'roster-slot';
      rosterArea: 'active' | 'bench';
      slotId: string;
      incomingAssetKey: string;
    }
  | {
      kind: 'waiver-claim';
      waiverId: string;
    };

export interface FreeAgentOperationObservedSlot {
  slotId: string;
  assetKey: string | null;
  pendingIncomingAssetKey: string | null;
  assetEligibleFromCycleNumber?: number | null;
  pendingEffectiveCycleNumber?: number | null;
}

export interface FreeAgentOperationObservedWaiver {
  waiverId: string;
  hasOwnerClaim: boolean;
}

export interface FreeAgentOperationObservation {
  activeSlots: FreeAgentOperationObservedSlot[];
  benchSlots: FreeAgentOperationObservedSlot[];
  waivers: FreeAgentOperationObservedWaiver[];
}

export interface ObservedFreeAgentRosterMoveResult {
  mode: 'immediate' | 'queued' | 'ownership-only';
  effectiveCycleNumber: number | null;
}

export type FreeAgentRosterFinalReadStatus = 'confirmed-absent' | 'unavailable';

export function getUnconfirmedRosterActionMessage(
  finalReadStatus: FreeAgentRosterFinalReadStatus,
): string {
  return finalReadStatus === 'unavailable'
    ? 'RinkRat could not reach the authoritative roster for a final confirmation. Check My Team before retrying because the transaction may have completed.'
    : 'The secure add/drop request ended without a matching authoritative roster change. You can safely try again.';
}

/**
 * Bounds a client-side prerequisite so a stalled NHL/API request cannot keep a
 * competitive action sheet in a permanent busy state. The underlying request
 * may still settle later, but its result is ignored after this wrapper times out.
 */
export function withFreeAgentOperationTimeout<T>(
  request: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      reject(new Error(timeoutMessage));
    }, Math.max(0, timeoutMs));

    void request.then(
      (value) => {
        if (settled) {
          return;
        }

        settled = true;
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }

        settled = true;
        globalThis.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Confirms a competitive roster request from the live Firestore listeners.
 *
 * Callable Functions can occasionally commit their transaction before a mobile
 * browser receives the HTTP response. The UI may therefore use the authoritative
 * roster/waiver listener as a second success signal instead of leaving a manager
 * behind an endless pending overlay. A queued active move is confirmed by its
 * pending incoming asset; a boundary that activates immediately is also accepted.
 */
export function isFreeAgentOperationObserved(
  expectation: FreeAgentOperationExpectation,
  observation: FreeAgentOperationObservation,
): boolean {
  if (expectation.kind === 'waiver-claim') {
    const waiver = observation.waivers.find(
      (candidate) => candidate.waiverId === expectation.waiverId,
    );

    return Boolean(waiver?.hasOwnerClaim);
  }

  const slots = expectation.rosterArea === 'active'
    ? observation.activeSlots
    : observation.benchSlots;
  const slot = slots.find((candidate) => candidate.slotId === expectation.slotId);

  if (!slot) {
    return false;
  }

  return slot.assetKey === expectation.incomingAssetKey ||
    slot.pendingIncomingAssetKey === expectation.incomingAssetKey;
}

export function resolveObservedFreeAgentRosterMove(
  expectation: FreeAgentOperationExpectation,
  observation: FreeAgentOperationObservation,
): ObservedFreeAgentRosterMoveResult | null {
  if (expectation.kind !== 'roster-slot') {
    return null;
  }

  const slots = expectation.rosterArea === 'active'
    ? observation.activeSlots
    : observation.benchSlots;
  const slot = slots.find((candidate) => candidate.slotId === expectation.slotId);

  if (!slot) {
    return null;
  }

  if (slot.pendingIncomingAssetKey === expectation.incomingAssetKey) {
    return {
      mode: 'queued',
      effectiveCycleNumber: slot.pendingEffectiveCycleNumber ?? null,
    };
  }

  if (slot.assetKey !== expectation.incomingAssetKey) {
    return null;
  }

  return {
    mode: expectation.rosterArea === 'bench' ? 'ownership-only' : 'immediate',
    effectiveCycleNumber: slot.assetEligibleFromCycleNumber ?? null,
  };
}
