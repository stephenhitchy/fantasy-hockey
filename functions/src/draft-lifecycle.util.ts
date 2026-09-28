import { createHash } from 'node:crypto';

export const DRAFT_MEMBERSHIP_LOCK_LEAD_MILLISECONDS = 40 * 60 * 1000;

export type DraftOrderMode = 'randomized' | 'custom' | 'legacy-custom';
export type DraftMembershipLockStatus = 'open' | 'locked';

function normalizedOwnerIds(ownerIds: readonly string[]): string[] {
  return [...new Set(ownerIds.map((ownerId) => ownerId.trim()).filter(Boolean))]
    .sort((first, second) => first.localeCompare(second));
}

export function createDraftParticipantHash(ownerIds: readonly string[]): string {
  return createHash('sha256')
    .update(`rinkrat:draft-participants:v1:${normalizedOwnerIds(ownerIds).join(':')}`)
    .digest('hex');
}

function seededIndex(seed: string, counter: number, upperExclusive: number): number {
  if (upperExclusive <= 1) {
    return 0;
  }

  const digest = createHash('sha256')
    .update(`rinkrat:draft-order:v1:${seed}:${counter}`)
    .digest();

  return digest.readUInt32BE(0) % upperExclusive;
}

function seededShuffle(ownerIds: readonly string[], seed: string): string[] {
  const shuffled = [...ownerIds];
  let counter = 0;

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = seededIndex(seed, counter, index + 1);
    counter += 1;
    [shuffled[index], shuffled[randomIndex]] = [
      shuffled[randomIndex]!,
      shuffled[index]!,
    ];
  }

  return shuffled;
}

export function draftOrderContainsExactParticipants(
  order: readonly string[],
  participantIds: readonly string[],
): boolean {
  const participants = normalizedOwnerIds(participantIds);

  return order.length === participants.length &&
    new Set(order).size === order.length &&
    [...order].sort((first, second) => first.localeCompare(second))
      .every((ownerId, index) => ownerId === participants[index]);
}

/**
 * Produces the one authoritative round-one order at the membership cutoff.
 * Randomized leagues shuffle the complete final participant set. Custom
 * leagues retain every surviving relative position and insert any manager who
 * joined later into a deterministic random position derived from the persisted
 * finalization seed. Transaction retries therefore cannot reroll the order.
 */
export function finalizeDraftOrder(input: {
  orderMode: DraftOrderMode;
  currentOrder: readonly string[];
  participantIds: readonly string[];
  randomizationSeed: string;
  preservedParticipantHash?: string | null;
}): {
  order: string[];
  participantHash: string;
  reusedPreservedOrder: boolean;
} {
  const participants = normalizedOwnerIds(input.participantIds);
  const participantHash = createDraftParticipantHash(participants);

  if (
    input.preservedParticipantHash === participantHash &&
    draftOrderContainsExactParticipants(input.currentOrder, participants)
  ) {
    return {
      order: [...input.currentOrder],
      participantHash,
      reusedPreservedOrder: true,
    };
  }

  if (input.orderMode === 'randomized') {
    return {
      order: seededShuffle(participants, input.randomizationSeed),
      participantHash,
      reusedPreservedOrder: false,
    };
  }

  const participantSet = new Set(participants);
  const reconciled = input.currentOrder.filter((ownerId, index, order) =>
    participantSet.has(ownerId) && order.indexOf(ownerId) === index,
  );
  const present = new Set(reconciled);
  const missing = participants.filter((ownerId) => !present.has(ownerId));

  missing.forEach((ownerId, index) => {
    const insertionIndex = seededIndex(
      input.randomizationSeed,
      index,
      reconciled.length + 1,
    );
    reconciled.splice(insertionIndex, 0, ownerId);
  });

  return {
    order: reconciled,
    participantHash,
    reusedPreservedOrder: false,
  };
}

export function getDraftMembershipLockStatus(
  draftData: unknown,
): DraftMembershipLockStatus {
  if (!draftData || typeof draftData !== 'object' || Array.isArray(draftData)) {
    return 'open';
  }

  const draft = draftData as Record<string, unknown>;

  if (draft['membershipLockStatus'] === 'open' || draft['membershipLockStatus'] === 'locked') {
    return draft['membershipLockStatus'];
  }

  const status = typeof draft['status'] === 'string' ? draft['status'] : '';
  const order = Array.isArray(draft['roundOneOrder']) ? draft['roundOneOrder'] : [];

  // Existing Production drafts predate the explicit field and were locked as
  // soon as an order was saved. Preserve that contract until a commissioner
  // deliberately reopens one through the guarded recovery action.
  return status === 'scheduled' || status === 'live' || status === 'complete' || order.length > 0
    ? 'locked'
    : 'open';
}

export function isDraftMembershipLocked(draftData: unknown): boolean {
  return getDraftMembershipLockStatus(draftData) === 'locked';
}

/**
 * Proves that the order finalized for the current schedule still represents
 * the exact server-owned team set. Legacy Drafts have no generation/hash
 * evidence, so they retain their historical exact-order compatibility path.
 */
export function draftFinalizationMatchesParticipants(
  draftData: unknown,
  participantIds: readonly string[],
): boolean {
  if (!draftData || typeof draftData !== 'object' || Array.isArray(draftData)) {
    return false;
  }

  const draft = draftData as Record<string, unknown>;
  const order = Array.isArray(draft['roundOneOrder'])
    ? draft['roundOneOrder'].filter((ownerId): ownerId is string => typeof ownerId === 'string')
    : [];

  if (!isDraftMembershipLocked(draft) ||
      !draftOrderContainsExactParticipants(order, participantIds)) {
    return false;
  }

  if (draft['membershipLockStatus'] === undefined) {
    return true;
  }

  const scheduleGeneration = draft['scheduleGeneration'];
  const finalizedScheduleGeneration = draft['finalizedScheduleGeneration'];

  return draft['membershipLockStatus'] === 'locked' &&
    Number.isSafeInteger(scheduleGeneration) &&
    Number.isSafeInteger(finalizedScheduleGeneration) &&
    scheduleGeneration === finalizedScheduleGeneration &&
    draft['orderParticipantHash'] === createDraftParticipantHash(participantIds);
}

export function getDraftMembershipCutoffMilliseconds(
  scheduledStartMilliseconds: number | null,
): number | null {
  return scheduledStartMilliseconds === null || !Number.isFinite(scheduledStartMilliseconds)
    ? null
    : scheduledStartMilliseconds - DRAFT_MEMBERSHIP_LOCK_LEAD_MILLISECONDS;
}

/**
 * Enforces the cutoff from server-observed time even when the task that
 * persists the lock is delayed. A malformed scheduled Draft fails closed;
 * setup without a scheduled time remains open.
 */
export function isDraftMembershipCutoffReached(input: {
  draftStatus: unknown;
  scheduledStartMilliseconds: number | null;
  nowMilliseconds: number;
}): boolean {
  if (input.draftStatus !== 'scheduled') {
    return false;
  }

  const cutoffMilliseconds = getDraftMembershipCutoffMilliseconds(
    input.scheduledStartMilliseconds,
  );

  return cutoffMilliseconds === null ||
    !Number.isFinite(input.nowMilliseconds) ||
    input.nowMilliseconds >= cutoffMilliseconds;
}

export function buildDraftFinalizationTaskId(input: {
  leagueId: string;
  scheduledStartMilliseconds: number;
  scheduleGeneration: number;
}): string {
  return createHash('sha256')
    .update([
      'draft-membership-finalization',
      input.leagueId,
      String(input.scheduledStartMilliseconds),
      String(input.scheduleGeneration),
    ].join(':'))
    .digest('hex')
    .slice(0, 40);
}
