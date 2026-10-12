import type {
  DraftableAsset,
  PlayerWindowContinuity,
} from '../draft/draft.models';

export const PLAYER_WINDOW_CONTINUITY_SCHEMA_VERSION = 1;

export interface LegacyPlayerWindowAssignment {
  cycleNumber: number;
  asset: DraftableAsset;
  scheduledGameIds: readonly number[];
  scheduleTeamAbbreviation?: string;
  ownershipStarted: boolean;
  playerWindowContinuity?: unknown;
  snapshotSource?: string;
  assignmentNotBefore?: unknown;
}

function normalizeTeamAbbreviation(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9]{2,4}$/.test(normalized) ? normalized : undefined;
}

function normalizeGameIds(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (gameId) =>
        typeof gameId !== 'number' ||
        !Number.isSafeInteger(gameId) ||
        gameId <= 0,
    )
  ) {
    throw new Error('Player-window continuity game history is malformed.');
  }

  const gameIds = value as number[];

  if (new Set(gameIds).size !== gameIds.length) {
    throw new Error('Player-window continuity game history contains duplicates.');
  }

  return [...gameIds];
}

function normalizeAssignmentNotBeforeMilliseconds(
  value: unknown,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  let milliseconds: number | null = null;

  if (typeof value === 'number') {
    milliseconds = value;
  } else if (typeof value === 'string') {
    const parsed = Date.parse(value);
    milliseconds = Number.isFinite(parsed) ? parsed : null;
  } else if (typeof value === 'object' && !Array.isArray(value)) {
    const candidate = value as Record<string, unknown>;
    const toMillis = candidate['toMillis'];

    if (typeof toMillis === 'function') {
      const parsed = toMillis.call(value);
      milliseconds = typeof parsed === 'number' ? parsed : null;
    } else {
      const seconds = candidate['seconds'] ?? candidate['_seconds'];
      const nanoseconds = candidate['nanoseconds'] ?? candidate['_nanoseconds'];

      if (typeof seconds === 'number') {
        milliseconds = seconds * 1000 + (
          typeof nanoseconds === 'number' ? nanoseconds / 1_000_000 : 0
        );
      }
    }
  }

  if (
    milliseconds === null ||
    !Number.isFinite(milliseconds) ||
    milliseconds < 0
  ) {
    throw new Error(
      'Player-window continuity assignment boundary is malformed.',
    );
  }

  return Math.trunc(milliseconds);
}

function activationKeyStartsRosterMove(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.trim().toLowerCase().startsWith('move-')
  );
}

function continuityStartsWithRosterMove(continuityId: string): boolean {
  return activationKeyStartsRosterMove(
    continuityId.split('::').at(-1),
  );
}

function resolveUnambiguousAssignmentBoundary(input: {
  values: readonly unknown[];
  context: string;
}): number | undefined {
  let resolved: number | undefined;

  for (const value of input.values) {
    const candidate = normalizeAssignmentNotBeforeMilliseconds(value);

    if (candidate === undefined) {
      continue;
    }

    if (resolved !== undefined && candidate !== resolved) {
      throw new Error(
        `Player-window continuity assignment boundaries disagree for ${input.context}.`,
      );
    }

    resolved = candidate;
  }

  return resolved;
}

function resolveAssignmentBoundaryWithFallback(input: {
  explicitValues: readonly unknown[];
  fallbackValue?: unknown;
  context: string;
}): number | undefined {
  const explicitBoundary = resolveUnambiguousAssignmentBoundary({
    values: input.explicitValues,
    context: input.context,
  });

  // Persisted continuity is competitive lineage evidence. The roster-pick
  // snapshot time is only an audit/write timestamp retained for old records
  // that have no explicit boundary; a delayed writer must not move a proven
  // assignment boundary forward or make otherwise-consistent copies conflict.
  return explicitBoundary ?? normalizeAssignmentNotBeforeMilliseconds(
    input.fallbackValue,
  );
}

export function normalizePlayerWindowContinuity(
  value: unknown,
): PlayerWindowContinuity | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Player-window continuity evidence is malformed.');
  }

  const candidate = value as Record<string, unknown>;
  const continuityId = typeof candidate['continuityId'] === 'string'
    ? candidate['continuityId'].trim()
    : '';

  const ownerId = typeof candidate['ownerId'] === 'string'
    ? candidate['ownerId'].trim()
    : '';
  const rosterSlotId = typeof candidate['rosterSlotId'] === 'string'
    ? candidate['rosterSlotId'].trim()
    : '';
  const assetKey = typeof candidate['assetKey'] === 'string'
    ? candidate['assetKey'].trim()
    : '';

  if (
    candidate['schemaVersion'] !== 1 ||
    !continuityId ||
    !ownerId ||
    !rosterSlotId ||
    !assetKey ||
    !continuityId.startsWith(
      `${ownerId}::${rosterSlotId}::${assetKey}::`,
    )
  ) {
    throw new Error(
      'Player-window continuity evidence is malformed or uses an unsupported schema.',
    );
  }

  const lastScheduleTeamAbbreviation = normalizeTeamAbbreviation(
    candidate['lastScheduleTeamAbbreviation'],
  );
  const assignmentNotBeforeMilliseconds =
    normalizeAssignmentNotBeforeMilliseconds(
      candidate['assignmentNotBeforeMilliseconds'],
    );
  const priorAssignedGameIds = normalizeGameIds(
    candidate['priorAssignedGameIds'],
  );

  if (priorAssignedGameIds.length > 0 && !lastScheduleTeamAbbreviation) {
    throw new Error(
      'Player-window continuity history is missing its last NHL schedule team.',
    );
  }

  return {
    schemaVersion: 1,
    continuityId,
    ownerId,
    rosterSlotId,
    assetKey,
    ...(assignmentNotBeforeMilliseconds !== undefined
      ? { assignmentNotBeforeMilliseconds }
      : {}),
    priorAssignedGameIds,
    ...(lastScheduleTeamAbbreviation
      ? { lastScheduleTeamAbbreviation }
      : {}),
  };
}

export function createPlayerWindowContinuity(input: {
  ownerId: string;
  rosterSlotId: string;
  asset: DraftableAsset;
  activationKey: string;
  assignmentNotBefore?: unknown;
}): PlayerWindowContinuity | undefined {
  if (input.asset.assetType !== 'skater') {
    return undefined;
  }

  const assignmentNotBeforeMilliseconds =
    normalizeAssignmentNotBeforeMilliseconds(input.assignmentNotBefore);

  if (
    activationKeyStartsRosterMove(input.activationKey) &&
    assignmentNotBeforeMilliseconds === undefined
  ) {
    throw new Error(
      'A roster-move player-window continuity record requires its original assignment boundary.',
    );
  }

  return {
    schemaVersion: 1,
    continuityId: [
      input.ownerId,
      input.rosterSlotId,
      input.asset.assetKey,
      input.activationKey,
    ].join('::'),
    ownerId: input.ownerId,
    rosterSlotId: input.rosterSlotId,
    assetKey: input.asset.assetKey,
    ...(assignmentNotBeforeMilliseconds !== undefined
      ? { assignmentNotBeforeMilliseconds }
      : {}),
    priorAssignedGameIds: [],
    lastScheduleTeamAbbreviation:
      normalizeTeamAbbreviation(input.asset.player.nhlTeamAbbreviation),
  };
}

/**
 * Validates lineage ownership. A different asset proves an old writer carried
 * the outgoing player's cursor across a roster replacement, so the incoming
 * asset safely starts a fresh stint. Owner/slot mismatches are corruption and
 * fail visibly rather than borrowing another competitive history.
 */
export function resolvePlayerWindowContinuity(input: {
  value: unknown;
  ownerId: string;
  rosterSlotId: string;
  asset: DraftableAsset;
}): PlayerWindowContinuity | undefined {
  const continuity = normalizePlayerWindowContinuity(input.value);

  if (!continuity || input.asset.assetType !== 'skater') {
    return undefined;
  }

  if (continuity.assetKey !== input.asset.assetKey) {
    return undefined;
  }

  if (
    continuity.ownerId !== input.ownerId ||
    continuity.rosterSlotId !== input.rosterSlotId
  ) {
    throw new Error(
      `Player-window continuity ${continuity.continuityId} does not belong to ` +
      `${input.ownerId}/${input.rosterSlotId}.`,
    );
  }

  return continuity;
}

/**
 * Resolves redundant persisted copies without letting an outgoing asset's
 * cursor mask a later, valid copy. Copies for the active asset are competitive
 * evidence: if they disagree, scoring stops instead of guessing which game
 * reservation history is authoritative.
 */
export function resolveConsistentPlayerWindowContinuity(input: {
  values: readonly unknown[];
  ownerId: string;
  rosterSlotId: string;
  asset: DraftableAsset;
}): PlayerWindowContinuity | undefined {
  const candidates = input.values
    .map((value) => resolvePlayerWindowContinuity({
      value,
      ownerId: input.ownerId,
      rosterSlotId: input.rosterSlotId,
      asset: input.asset,
    }))
    .filter((value): value is PlayerWindowContinuity => Boolean(value));

  const authoritative = candidates[0];

  if (!authoritative) {
    return undefined;
  }

  const authoritativeGameIds = [...authoritative.priorAssignedGameIds].sort(
    (first, second) => first - second,
  );

  for (const candidate of candidates.slice(1)) {
    const candidateGameIds = [...candidate.priorAssignedGameIds].sort(
      (first, second) => first - second,
    );
    const agrees =
      candidate.continuityId === authoritative.continuityId &&
      candidate.assignmentNotBeforeMilliseconds ===
        authoritative.assignmentNotBeforeMilliseconds &&
      candidate.lastScheduleTeamAbbreviation ===
        authoritative.lastScheduleTeamAbbreviation &&
      candidateGameIds.length === authoritativeGameIds.length &&
      candidateGameIds.every(
        (gameId, index) => gameId === authoritativeGameIds[index],
      );

    if (!agrees) {
      throw new Error(
        `Player-window continuity copies disagree for ` +
        `${input.ownerId}/${input.rosterSlotId}/${input.asset.assetKey}.`,
      );
    }
  }

  return authoritative;
}

/**
 * Legacy mixed-version writers could save the same continuity id with an
 * older game-id prefix in one redundant copy. The one-time migration may
 * keep the longer true prefix history, but it still rejects divergent
 * histories, different ids, or conflicting last-club evidence because those
 * indicate different fantasy stints.
 */
export function mergeLegacyPlayerWindowContinuityCopies(input: {
  values: readonly unknown[];
  ownerId: string;
  rosterSlotId: string;
  asset: DraftableAsset;
}): PlayerWindowContinuity | undefined {
  const candidates = input.values
    .map((value) => resolvePlayerWindowContinuity({
      value,
      ownerId: input.ownerId,
      rosterSlotId: input.rosterSlotId,
      asset: input.asset,
    }))
    .filter((value): value is PlayerWindowContinuity => Boolean(value));
  const authoritative = candidates[0];

  if (!authoritative) {
    return undefined;
  }

  let longestHistory = authoritative;
  let assignmentNotBeforeMilliseconds =
    authoritative.assignmentNotBeforeMilliseconds;

  for (const candidate of candidates.slice(1)) {
    const shorter = candidate.priorAssignedGameIds.length <
      longestHistory.priorAssignedGameIds.length
      ? candidate.priorAssignedGameIds
      : longestHistory.priorAssignedGameIds;
    const longer = candidate.priorAssignedGameIds.length <
      longestHistory.priorAssignedGameIds.length
      ? longestHistory.priorAssignedGameIds
      : candidate.priorAssignedGameIds;
    const historyIsOrderedPrefix = shorter.every(
      (gameId, index) => gameId === longer[index],
    );

    if (
      candidate.continuityId !== authoritative.continuityId ||
      !historyIsOrderedPrefix ||
      (
        candidate.assignmentNotBeforeMilliseconds !== undefined &&
        assignmentNotBeforeMilliseconds !== undefined &&
        candidate.assignmentNotBeforeMilliseconds !==
          assignmentNotBeforeMilliseconds
      ) ||
      (
        candidate.lastScheduleTeamAbbreviation &&
        authoritative.lastScheduleTeamAbbreviation &&
        candidate.lastScheduleTeamAbbreviation !==
          authoritative.lastScheduleTeamAbbreviation
      )
    ) {
      throw new Error(
        `Legacy player-window continuity copies disagree for ` +
        `${input.ownerId}/${input.rosterSlotId}/${input.asset.assetKey}.`,
      );
    }

    assignmentNotBeforeMilliseconds ??=
      candidate.assignmentNotBeforeMilliseconds;

    if (
      candidate.priorAssignedGameIds.length >
      longestHistory.priorAssignedGameIds.length
    ) {
      longestHistory = candidate;
    }
  }

  return {
    ...longestHistory,
    ...(assignmentNotBeforeMilliseconds !== undefined
      ? { assignmentNotBeforeMilliseconds }
      : {}),
    priorAssignedGameIds: [...longestHistory.priorAssignedGameIds],
    ...(
      longestHistory.lastScheduleTeamAbbreviation ||
      candidates.find((candidate) => candidate.lastScheduleTeamAbbreviation)
        ?.lastScheduleTeamAbbreviation
        ? {
            lastScheduleTeamAbbreviation:
              longestHistory.lastScheduleTeamAbbreviation ??
              candidates.find((candidate) => candidate.lastScheduleTeamAbbreviation)!
                .lastScheduleTeamAbbreviation,
          }
        : {}
    ),
  };
}

/**
 * Rolls a completed skater window into the same active-slot stint. A different
 * asset always receives a fresh lineage so fantasy drops, swaps, and later
 * reacquisitions cannot inherit another stint's NHL game reservations.
 */
export function advancePlayerWindowContinuity(input: {
  previousAsset: DraftableAsset;
  nextAsset: DraftableAsset;
  previousContinuity?: unknown;
  completedScheduledGameIds: readonly number[];
  completedScheduleTeamAbbreviation?: string;
  ownerId: string;
  rosterSlotId: string;
  activationKey: string;
  assignmentNotBefore?: unknown;
}): PlayerWindowContinuity | undefined {
  if (input.nextAsset.assetType !== 'skater') {
    return undefined;
  }

  if (
    input.previousAsset.assetType !== 'skater' ||
    input.previousAsset.assetKey !== input.nextAsset.assetKey
  ) {
    const startsRosterMove = activationKeyStartsRosterMove(
      input.activationKey,
    );

    return createPlayerWindowContinuity({
      ownerId: input.ownerId,
      rosterSlotId: input.rosterSlotId,
      asset: input.nextAsset,
      activationKey: input.activationKey,
      ...(startsRosterMove
        ? { assignmentNotBefore: input.assignmentNotBefore }
        : {}),
    });
  }

  const previous = resolvePlayerWindowContinuity({
    value: input.previousContinuity,
    ownerId: input.ownerId,
    rosterSlotId: input.rosterSlotId,
    asset: input.previousAsset,
  }) ?? createPlayerWindowContinuity({
    ownerId: input.ownerId,
    rosterSlotId: input.rosterSlotId,
    asset: input.previousAsset,
    activationKey: `legacy-${input.activationKey}`,
  });

  if (!previous) {
    return undefined;
  }

  const previousStartsRosterMove = continuityStartsWithRosterMove(
    previous.continuityId,
  );
  const assignmentNotBeforeMilliseconds =
    previous.assignmentNotBeforeMilliseconds ??
    (previousStartsRosterMove
      ? normalizeAssignmentNotBeforeMilliseconds(input.assignmentNotBefore)
      : undefined);

  if (
    previousStartsRosterMove &&
    assignmentNotBeforeMilliseconds === undefined
  ) {
    throw new Error(
      `Player-window continuity ${previous.continuityId} is missing its ` +
      'original roster-move assignment boundary.',
    );
  }

  const lastScheduleTeamAbbreviation = normalizeTeamAbbreviation(
    input.completedScheduleTeamAbbreviation,
  ) ?? previous.lastScheduleTeamAbbreviation;

  return {
    schemaVersion: 1,
    continuityId: previous.continuityId,
    ownerId: previous.ownerId,
    rosterSlotId: previous.rosterSlotId,
    assetKey: previous.assetKey,
    ...(assignmentNotBeforeMilliseconds !== undefined
      ? { assignmentNotBeforeMilliseconds }
      : {}),
    priorAssignedGameIds: [
      ...new Set([
        ...previous.priorAssignedGameIds,
        ...normalizeGameIds(input.completedScheduledGameIds),
      ]),
    ],
    ...(lastScheduleTeamAbbreviation
      ? { lastScheduleTeamAbbreviation }
      : {}),
  };
}

/**
 * Returns whether an immutable pick begins a fresh roster-ownership stint.
 *
 * Historical move sources intentionally retain their established `move`
 * naming contract. Future-lineup materialization is an equally fresh
 * assignment but uses an explicit, stable source value, so recognize that
 * value exactly rather than broadening the substring convention.
 */
export function snapshotSourceStartsFreshRosterAssignment(
  snapshotSource: unknown,
): boolean {
  return (
    typeof snapshotSource === 'string' &&
    (
      snapshotSource === 'future-lineup-plan' ||
      snapshotSource.toLowerCase().includes('move')
    )
  );
}

/**
 * Rebuilds the cursor for a cycle created before continuity schema 1 existed.
 * History is supplied newest-first and is consumed only while the same asset
 * occupies the same owner/slot without a gap. Every started historical window
 * contributes its entire immutable assignment, including games where the
 * skater did not appear. A move snapshot is a hard fantasy-stint boundary even
 * when a manager later reacquired the same NHL player in the same slot.
 */
export function reconstructLegacyPlayerWindowContinuity(input: {
  ownerId: string;
  rosterSlotId: string;
  currentCycleNumber: number;
  currentAsset: DraftableAsset;
  currentContinuity?: unknown;
  currentSnapshotSource?: string;
  currentAssignmentNotBefore?: unknown;
  assignmentsNewestFirst: readonly (LegacyPlayerWindowAssignment | null)[];
}): PlayerWindowContinuity | undefined {
  if (input.currentAsset.assetType !== 'skater') {
    return undefined;
  }

  const savedCurrent = resolvePlayerWindowContinuity({
    value: input.currentContinuity,
    ownerId: input.ownerId,
    rosterSlotId: input.rosterSlotId,
    asset: input.currentAsset,
  });

  if (snapshotSourceStartsFreshRosterAssignment(input.currentSnapshotSource)) {
    const savedCurrentMove = savedCurrent &&
      continuityStartsWithRosterMove(savedCurrent.continuityId)
      ? savedCurrent
      : undefined;
    const assignmentNotBeforeMilliseconds =
      resolveAssignmentBoundaryWithFallback({
        explicitValues: [
          savedCurrentMove?.assignmentNotBeforeMilliseconds,
        ],
        fallbackValue: input.currentAssignmentNotBefore,
        context:
          `${input.ownerId}/${input.rosterSlotId}/${input.currentAsset.assetKey}`,
      });

    if (assignmentNotBeforeMilliseconds === undefined) {
      throw new Error(
        `Legacy roster-move continuity for ${input.ownerId}/${input.rosterSlotId} ` +
        'is missing its original assignment boundary.',
      );
    }

    return savedCurrentMove
      ? {
          ...savedCurrentMove,
          assignmentNotBeforeMilliseconds,
        }
      : createPlayerWindowContinuity({
          ownerId: input.ownerId,
          rosterSlotId: input.rosterSlotId,
          asset: input.currentAsset,
          activationKey: `move-legacy-cycle-${input.currentCycleNumber}`,
          assignmentNotBefore: assignmentNotBeforeMilliseconds,
        });
  }

  const contiguousAssignments: LegacyPlayerWindowAssignment[] = [];

  for (const assignment of input.assignmentsNewestFirst) {
    if (!assignment || assignment.asset.assetKey !== input.currentAsset.assetKey) {
      break;
    }

    if (!assignment.ownershipStarted) {
      throw new Error(
        `Legacy player-window history for ${input.ownerId}/${input.rosterSlotId} ` +
        `contains an unstarted Cycle ${assignment.cycleNumber} assignment before the ` +
        `current cycle. Continuity was not guessed.`,
      );
    }

    const scheduledGameIds = normalizeGameIds(assignment.scheduledGameIds);

    if (scheduledGameIds.length === 0) {
      throw new Error(
        `Legacy player-window history for ${input.ownerId}/${input.rosterSlotId} ` +
        `is missing Cycle ${assignment.cycleNumber} game ownership.`,
      );
    }

    contiguousAssignments.push({
      ...assignment,
      scheduledGameIds,
    });

    if (snapshotSourceStartsFreshRosterAssignment(assignment.snapshotSource)) {
      break;
    }
  }

  const savedHistoricalContinuities = contiguousAssignments
    .map((assignment) => resolvePlayerWindowContinuity({
      value: assignment.playerWindowContinuity,
      ownerId: input.ownerId,
      rosterSlotId: input.rosterSlotId,
      asset: input.currentAsset,
    }))
    .filter((continuity): continuity is PlayerWindowContinuity => Boolean(continuity));
  const savedContinuities = [
    ...(savedCurrent ? [savedCurrent] : []),
    ...savedHistoricalContinuities,
  ];
  const savedHistorical = savedHistoricalContinuities[0];
  const moveBoundaryAssignment = contiguousAssignments.find((assignment) =>
    snapshotSourceStartsFreshRosterAssignment(assignment.snapshotSource)
  );
  const distinctContinuityIds = new Set(
    savedContinuities.map((continuity) => continuity.continuityId),
  );

  if (distinctContinuityIds.size > 1) {
    throw new Error(
      `Legacy player-window continuity identifiers disagree for ` +
      `${input.ownerId}/${input.rosterSlotId}/${input.currentAsset.assetKey}.`,
    );
  }

  const assignmentNotBeforeMilliseconds =
    resolveAssignmentBoundaryWithFallback({
      explicitValues: savedContinuities.map(
        (continuity) => continuity.assignmentNotBeforeMilliseconds,
      ),
      fallbackValue: moveBoundaryAssignment?.assignmentNotBefore,
      context:
        `${input.ownerId}/${input.rosterSlotId}/${input.currentAsset.assetKey}`,
    });

  if (
    moveBoundaryAssignment &&
    assignmentNotBeforeMilliseconds === undefined
  ) {
    throw new Error(
      `Legacy roster-move continuity for ${input.ownerId}/${input.rosterSlotId} ` +
      'is missing its original assignment boundary.',
    );
  }
  const base = savedCurrent ?? savedHistorical ?? createPlayerWindowContinuity({
    ownerId: input.ownerId,
    rosterSlotId: input.rosterSlotId,
    asset: input.currentAsset,
    activationKey: moveBoundaryAssignment
      ? `move-legacy-cycle-${input.currentCycleNumber}`
      : `legacy-cycle-${input.currentCycleNumber}`,
    assignmentNotBefore: assignmentNotBeforeMilliseconds,
  });

  if (!base) {
    return undefined;
  }

  const chronologicalAssignments = [...contiguousAssignments].reverse();
  const priorAssignedGameIds = normalizeGameIds([
    ...new Set([
      ...base.priorAssignedGameIds,
      ...chronologicalAssignments.flatMap((assignment) => [
        ...assignment.scheduledGameIds,
      ]),
    ]),
  ]);
  const lastScheduleTeamAbbreviation = normalizeTeamAbbreviation(
    contiguousAssignments[0]?.scheduleTeamAbbreviation,
  ) ?? base.lastScheduleTeamAbbreviation;

  return {
    schemaVersion: 1,
    continuityId: base.continuityId,
    ownerId: base.ownerId,
    rosterSlotId: base.rosterSlotId,
    assetKey: base.assetKey,
    ...(assignmentNotBeforeMilliseconds !== undefined
      ? { assignmentNotBeforeMilliseconds }
      : {}),
    priorAssignedGameIds,
    ...(lastScheduleTeamAbbreviation
      ? { lastScheduleTeamAbbreviation }
      : {}),
  };
}
