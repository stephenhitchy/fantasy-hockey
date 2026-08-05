import type { RosterDropSource } from '../../../core/draft/draft.service';

export interface RosterRemovalExpectation {
  sourceRosterArea: RosterDropSource;
  slotId: string;
  previousAssetKey: string;
}

export interface RosterRemovalObservedSlot {
  slotId: string;
  assetKey: string | null;
}

export interface RosterRemovalObservation {
  activeSlots: RosterRemovalObservedSlot[];
  benchSlots: RosterRemovalObservedSlot[];
  irSlots: RosterRemovalObservedSlot[];
}

/**
 * Confirms that the authoritative roster listener has observed the requested
 * player or goalie unit leave its source slot. A replacement asset is accepted
 * as confirmation too because it proves the previous assignment no longer owns
 * the slot.
 */
export function isRosterRemovalObserved(
  expectation: RosterRemovalExpectation,
  observation: RosterRemovalObservation,
): boolean {
  const slots = expectation.sourceRosterArea === 'active'
    ? observation.activeSlots
    : expectation.sourceRosterArea === 'bench'
      ? observation.benchSlots
      : observation.irSlots;
  const slot = slots.find((candidate) => candidate.slotId === expectation.slotId);

  if (!slot) {
    return false;
  }

  return slot.assetKey !== expectation.previousAssetKey;
}

/**
 * Bounds a roster callable so a committed Firebase transaction cannot leave a
 * mobile browser behind a permanent spinner when its HTTP response is lost.
 */
export function withRosterOperationTimeout<T>(
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
