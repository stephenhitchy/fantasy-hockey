import {
  DraftableAsset,
  InjuryReplacementWindowPlan,
  InjuryReplacementWindowSegment,
  PlayerWindowContinuity,
} from '../draft/draft.models';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeGameIds(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [
    ...new Set(
      value.filter(
        (gameId): gameId is number =>
          typeof gameId === 'number' &&
          Number.isSafeInteger(gameId) &&
          gameId > 0,
      ),
    ),
  ];
}

function normalizeSegment(
  value: unknown,
): InjuryReplacementWindowSegment | null {
  const source = asRecord(value);
  const asset = asRecord(source['asset']) as unknown as DraftableAsset;
  const segmentId = typeof source['segmentId'] === 'string'
    ? source['segmentId'].trim()
    : '';
  const assetKey = typeof source['assetKey'] === 'string'
    ? source['assetKey'].trim()
    : '';
  const sourceTeamAbbreviation =
    typeof source['sourceTeamAbbreviation'] === 'string'
      ? source['sourceTeamAbbreviation'].trim().toUpperCase()
      : '';
  const reason = source['reason'] === 'injury-replacement'
    ? 'injury-replacement'
    : source['reason'] === 'original'
      ? 'original'
      : null;

  if (
    !segmentId ||
    !assetKey ||
    !reason ||
    !sourceTeamAbbreviation ||
    asset.assetKey !== assetKey
  ) {
    return null;
  }

  const assignmentNotBeforeMilliseconds =
    typeof source['assignmentNotBeforeMilliseconds'] === 'number' &&
    Number.isFinite(source['assignmentNotBeforeMilliseconds'])
      ? source['assignmentNotBeforeMilliseconds']
      : undefined;
  const activatedAtMilliseconds =
    typeof source['activatedAtMilliseconds'] === 'number' &&
    Number.isFinite(source['activatedAtMilliseconds'])
      ? source['activatedAtMilliseconds']
      : undefined;
  const playerWindowContinuity = asRecord(
    source['playerWindowContinuity'],
  ) as unknown as PlayerWindowContinuity;

  return {
    segmentId,
    reason,
    assetKey,
    asset,
    scheduledGameIds: normalizeGameIds(source['scheduledGameIds']),
    sourceTeamAbbreviation,
    ...(assignmentNotBeforeMilliseconds !== undefined
      ? { assignmentNotBeforeMilliseconds }
      : {}),
    ...(activatedAtMilliseconds !== undefined
      ? { activatedAtMilliseconds }
      : {}),
    ...(playerWindowContinuity.continuityId
      ? { playerWindowContinuity }
      : {}),
  };
}

export function normalizeInjuryReplacementWindowPlan(
  value: unknown,
): InjuryReplacementWindowPlan | null {
  const source = asRecord(value);

  if (source['schemaVersion'] !== 1 || !Array.isArray(source['segments'])) {
    return null;
  }

  const segments = source['segments']
    .map(normalizeSegment)
    .filter((segment): segment is InjuryReplacementWindowSegment => segment !== null);
  const requiredGames =
    typeof source['requiredGames'] === 'number' &&
    Number.isSafeInteger(source['requiredGames']) &&
    source['requiredGames'] > 0
      ? source['requiredGames']
      : 0;
  const latestTransactionId =
    typeof source['latestTransactionId'] === 'string'
      ? source['latestTransactionId'].trim()
      : '';
  const replacementCount =
    typeof source['replacementCount'] === 'number' &&
    Number.isSafeInteger(source['replacementCount']) &&
    source['replacementCount'] > 0
      ? source['replacementCount']
      : 0;
  const segmentIds = new Set(segments.map((segment) => segment.segmentId));
  const assignedGameIds = segments.flatMap((segment) => segment.scheduledGameIds);

  if (
    !latestTransactionId ||
    requiredGames <= 0 ||
    replacementCount <= 0 ||
    segments.length !== source['segments'].length ||
    segments.length < 2 ||
    segmentIds.size !== segments.length ||
    new Set(assignedGameIds).size !== assignedGameIds.length ||
    assignedGameIds.length !== requiredGames
  ) {
    return null;
  }

  return {
    schemaVersion: 1,
    latestTransactionId,
    replacementCount,
    requiredGames,
    segments,
  };
}

export function getInjuryReplacementGameIds(
  plan: InjuryReplacementWindowPlan,
): number[] {
  return plan.segments.flatMap((segment) => segment.scheduledGameIds);
}

export function getInjuryReplacementAssetKeyByGameId(
  plan: InjuryReplacementWindowPlan,
): Record<string, string> {
  return Object.fromEntries(
    plan.segments.flatMap((segment) =>
      segment.scheduledGameIds.map((gameId) => [String(gameId), segment.assetKey]),
    ),
  );
}

export function buildInjuryReplacementWindowPlan(input: {
  previousPlan?: InjuryReplacementWindowPlan | null;
  currentAsset: DraftableAsset;
  currentPlayerWindowContinuity?: PlayerWindowContinuity;
  currentScheduledGameIds: readonly number[];
  startedCurrentGameIds: ReadonlySet<number>;
  currentSourceTeamAbbreviation: string;
  incomingAsset: DraftableAsset;
  incomingScheduledGameIds: readonly number[];
  incomingSourceTeamAbbreviation: string;
  incomingPlayerWindowContinuity?: PlayerWindowContinuity;
  transactionId: string;
  boundaryMilliseconds: number;
  requiredGames: number;
}): InjuryReplacementWindowPlan {
  const previousPlan = input.previousPlan ?? null;
  const priorSegments = previousPlan
    ? previousPlan.segments.slice(0, -1).map((segment) => ({
        ...segment,
        scheduledGameIds: [...segment.scheduledGameIds],
      }))
    : [];
  const currentSegmentSource = previousPlan?.segments.at(-1);

  if (
    currentSegmentSource &&
    currentSegmentSource.assetKey !== input.currentAsset.assetKey
  ) {
    throw new Error(
      'The current injury-replacement segment no longer matches the active roster asset.',
    );
  }

  const currentCandidateGameIds = currentSegmentSource?.scheduledGameIds ??
    normalizeGameIds(input.currentScheduledGameIds);
  const retainedCurrentGameIds = currentCandidateGameIds.filter((gameId) =>
    input.startedCurrentGameIds.has(gameId),
  );
  const currentPlayerWindowContinuity =
    currentSegmentSource?.playerWindowContinuity ??
    input.currentPlayerWindowContinuity;
  const currentSegment: InjuryReplacementWindowSegment = {
    segmentId:
      currentSegmentSource?.segmentId ??
      `${input.transactionId}__original`,
    reason: currentSegmentSource?.reason ?? 'original',
    assetKey: input.currentAsset.assetKey,
    asset: input.currentAsset,
    scheduledGameIds: retainedCurrentGameIds,
    sourceTeamAbbreviation:
      currentSegmentSource?.sourceTeamAbbreviation ??
      input.currentSourceTeamAbbreviation.trim().toUpperCase(),
    ...(currentSegmentSource?.assignmentNotBeforeMilliseconds !== undefined
      ? {
          assignmentNotBeforeMilliseconds:
            currentSegmentSource.assignmentNotBeforeMilliseconds,
        }
      : {}),
    ...(currentSegmentSource?.activatedAtMilliseconds !== undefined
      ? { activatedAtMilliseconds: currentSegmentSource.activatedAtMilliseconds }
      : {}),
    ...(currentPlayerWindowContinuity
      ? {
          playerWindowContinuity: currentPlayerWindowContinuity,
        }
      : {}),
  };
  const retainedSegments = [...priorSegments, currentSegment]
    .filter((segment) => segment.scheduledGameIds.length > 0);
  const retainedGameCount = retainedSegments.reduce(
    (total, segment) => total + segment.scheduledGameIds.length,
    0,
  );
  const remainingGames = input.requiredGames - retainedGameCount;
  const incomingScheduledGameIds = normalizeGameIds(
    input.incomingScheduledGameIds,
  );

  if (
    remainingGames <= 0 ||
    incomingScheduledGameIds.length !== remainingGames
  ) {
    throw new Error(
      'The injury replacement does not have the exact remaining game allocation.',
    );
  }

  const nextSegment: InjuryReplacementWindowSegment = {
    segmentId: `${input.transactionId}__replacement-${
      (previousPlan?.replacementCount ?? 0) + 1
    }`,
    reason: 'injury-replacement',
    assetKey: input.incomingAsset.assetKey,
    asset: input.incomingAsset,
    scheduledGameIds: incomingScheduledGameIds,
    sourceTeamAbbreviation:
      input.incomingSourceTeamAbbreviation.trim().toUpperCase(),
    assignmentNotBeforeMilliseconds: input.boundaryMilliseconds,
    activatedAtMilliseconds: input.boundaryMilliseconds,
    ...(input.incomingPlayerWindowContinuity
      ? { playerWindowContinuity: input.incomingPlayerWindowContinuity }
      : {}),
  };
  const plan: InjuryReplacementWindowPlan = {
    schemaVersion: 1,
    latestTransactionId: input.transactionId,
    replacementCount: (previousPlan?.replacementCount ?? 0) + 1,
    requiredGames: input.requiredGames,
    segments: [...retainedSegments, nextSegment],
  };

  if (getInjuryReplacementGameIds(plan).length !== input.requiredGames) {
    throw new Error('The injury replacement did not preserve an exact six-game window.');
  }

  return plan;
}
