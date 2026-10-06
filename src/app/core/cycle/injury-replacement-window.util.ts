import type {
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
  const assignedGameIds = segments.flatMap((segment) => segment.scheduledGameIds);

  if (
    !latestTransactionId ||
    requiredGames <= 0 ||
    replacementCount <= 0 ||
    segments.length !== source['segments'].length ||
    segments.length < 2 ||
    new Set(segments.map((segment) => segment.segmentId)).size !== segments.length ||
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

export function getInjuryReplacementAssetKeyByGameId(
  plan: InjuryReplacementWindowPlan,
): Record<string, string> {
  return Object.fromEntries(
    plan.segments.flatMap((segment) =>
      segment.scheduledGameIds.map((gameId) => [String(gameId), segment.assetKey]),
    ),
  );
}
