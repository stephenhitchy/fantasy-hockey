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
