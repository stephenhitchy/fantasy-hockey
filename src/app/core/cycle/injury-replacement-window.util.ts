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

function normalizeGameIds(value: unknown): number[] | null {
  if (
    !Array.isArray(value) ||
    value.some(
      (gameId) =>
        typeof gameId !== 'number' ||
        !Number.isSafeInteger(gameId) ||
        gameId <= 0,
    ) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }

  return [...value] as number[];
}

function normalizeOptionalBoundaryMilliseconds(value: unknown): {
  present: boolean;
  value?: number;
} | null {
  if (value === undefined || value === null) {
    return { present: false };
  }

  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return null;
  }

  return { present: true, value };
}

function normalizeSegmentPlayerWindowContinuity(value: unknown): {
  valid: boolean;
  value?: PlayerWindowContinuity;
} {
  if (value === undefined || value === null) {
    return { valid: true };
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false };
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
  const priorAssignedGameIds = normalizeGameIds(
    candidate['priorAssignedGameIds'],
  );
  const assignmentBoundary = normalizeOptionalBoundaryMilliseconds(
    candidate['assignmentNotBeforeMilliseconds'],
  );
  const rawLastScheduleTeamAbbreviation =
    candidate['lastScheduleTeamAbbreviation'];
  const lastScheduleTeamAbbreviation =
    typeof rawLastScheduleTeamAbbreviation === 'string' &&
    /^[A-Z0-9]{2,4}$/.test(
      rawLastScheduleTeamAbbreviation.trim().toUpperCase(),
    )
      ? rawLastScheduleTeamAbbreviation.trim().toUpperCase()
      : undefined;

  if (
    candidate['schemaVersion'] !== 1 ||
    !continuityId ||
    !ownerId ||
    !rosterSlotId ||
    !assetKey ||
    !continuityId.startsWith(`${ownerId}::${rosterSlotId}::${assetKey}::`) ||
    !priorAssignedGameIds ||
    !assignmentBoundary ||
    (priorAssignedGameIds.length > 0 && !lastScheduleTeamAbbreviation)
  ) {
    return { valid: false };
  }

  return {
    valid: true,
    value: {
      schemaVersion: 1,
      continuityId,
      ownerId,
      rosterSlotId,
      assetKey,
      ...(assignmentBoundary.value !== undefined
        ? { assignmentNotBeforeMilliseconds: assignmentBoundary.value }
        : {}),
      priorAssignedGameIds,
      ...(lastScheduleTeamAbbreviation
        ? { lastScheduleTeamAbbreviation }
        : {}),
    },
  };
}

function normalizeSegment(
  value: unknown,
): InjuryReplacementWindowSegment | null {
  const source = asRecord(value);
  const assetSource = asRecord(source['asset']);
  const playerSource = asRecord(assetSource['player']);
  const asset = assetSource as unknown as DraftableAsset;
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
  const scheduledGameIds = normalizeGameIds(source['scheduledGameIds']);
  const playerId = playerSource['id'];
  const assetPosition = assetSource['position'];
  const playerPosition = playerSource['position'];
  const playerName = playerSource['fullName'];
  const playerTeamAbbreviation =
    typeof playerSource['nhlTeamAbbreviation'] === 'string'
      ? playerSource['nhlTeamAbbreviation'].trim().toUpperCase()
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
    !/^[A-Z0-9]{2,4}$/.test(sourceTeamAbbreviation) ||
    !scheduledGameIds ||
    asset.assetType !== 'skater' ||
    asset.assetKey !== assetKey ||
    typeof playerId !== 'number' ||
    !Number.isSafeInteger(playerId) ||
    playerId <= 0 ||
    assetKey !== `skater-${playerId}` ||
    !['LW', 'C', 'RW', 'D'].includes(String(assetPosition)) ||
    playerPosition !== assetPosition ||
    typeof playerName !== 'string' ||
    !playerName.trim() ||
    !/^[A-Z0-9]{2,4}$/.test(playerTeamAbbreviation)
  ) {
    return null;
  }

  const rawSourceTeamByGameIdValue = source['sourceTeamAbbreviationByGameId'];
  const hasExplicitSourceTeamMap =
    rawSourceTeamByGameIdValue !== undefined &&
    rawSourceTeamByGameIdValue !== null;

  if (
    hasExplicitSourceTeamMap &&
    (
      typeof rawSourceTeamByGameIdValue !== 'object' ||
      Array.isArray(rawSourceTeamByGameIdValue)
    )
  ) {
    return null;
  }

  const rawSourceTeamByGameId = asRecord(rawSourceTeamByGameIdValue);
  const scheduledGameIdKeys = new Set(
    scheduledGameIds.map((gameId) => String(gameId)),
  );

  if (
    hasExplicitSourceTeamMap &&
    (
      Object.keys(rawSourceTeamByGameId).length !== scheduledGameIdKeys.size ||
      Object.keys(rawSourceTeamByGameId).some(
        (gameId) => !scheduledGameIdKeys.has(gameId),
      )
    )
  ) {
    return null;
  }

  const sourceTeamAbbreviationByGameId: Record<string, string> = {};

  for (const gameId of scheduledGameIds) {
    const explicitTeam = rawSourceTeamByGameId[String(gameId)];
    const team = !hasExplicitSourceTeamMap
      ? sourceTeamAbbreviation
      : typeof explicitTeam === 'string'
        ? explicitTeam.trim().toUpperCase()
        : '';

    if (!/^[A-Z0-9]{2,4}$/.test(team)) {
      return null;
    }

    sourceTeamAbbreviationByGameId[String(gameId)] = team;
  }

  const assignmentBoundary = normalizeOptionalBoundaryMilliseconds(
    source['assignmentNotBeforeMilliseconds'],
  );
  const activationBoundary = normalizeOptionalBoundaryMilliseconds(
    source['activatedAtMilliseconds'],
  );
  const continuityResult = normalizeSegmentPlayerWindowContinuity(
    source['playerWindowContinuity'],
  );

  if (!assignmentBoundary || !activationBoundary || !continuityResult.valid) {
    return null;
  }

  const assignmentNotBeforeMilliseconds = assignmentBoundary.value;
  const activatedAtMilliseconds = activationBoundary.value;
  const playerWindowContinuity = continuityResult.value;
  const replacementBoundaryIsValid =
    reason !== 'injury-replacement' ||
    (
      assignmentBoundary.present &&
      activationBoundary.present &&
      assignmentNotBeforeMilliseconds === activatedAtMilliseconds
    );
  const continuityBoundaryIsValid =
    !playerWindowContinuity ||
    (
      playerWindowContinuity.assetKey === assetKey &&
      (
        !assignmentBoundary.present ||
        playerWindowContinuity.assignmentNotBeforeMilliseconds ===
          assignmentNotBeforeMilliseconds
      )
    );

  if (!replacementBoundaryIsValid || !continuityBoundaryIsValid) {
    return null;
  }

  return {
    segmentId,
    reason,
    assetKey,
    asset,
    scheduledGameIds,
    sourceTeamAbbreviation,
    ...(hasExplicitSourceTeamMap
      ? { sourceTeamAbbreviationByGameId }
      : {}),
    ...(assignmentNotBeforeMilliseconds !== undefined
      ? { assignmentNotBeforeMilliseconds }
      : {}),
    ...(activatedAtMilliseconds !== undefined
      ? { activatedAtMilliseconds }
      : {}),
    ...(playerWindowContinuity
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
  const hasAuditedOriginalSegment =
    segments[0]?.reason === 'original' &&
    segments[0].segmentId.endsWith('__original') &&
    segments.slice(1).every(
      (segment, index) =>
        segment.reason === 'injury-replacement' &&
        segment.segmentId.endsWith(`__replacement-${index + 1}`),
    ) &&
    replacementCount === segments.length - 1 &&
    segments.at(-1)?.segmentId ===
      `${latestTransactionId}__replacement-${replacementCount}`;
  const hasLegacyOmittedOriginalSegment =
    segments.length > 0 &&
    segments.every(
      (segment, index) =>
        segment.reason === 'injury-replacement' &&
        segment.segmentId.endsWith(`__replacement-${index + 1}`) &&
        segment.assignmentNotBeforeMilliseconds !== undefined &&
        segment.activatedAtMilliseconds !== undefined,
    ) &&
    replacementCount === segments.length &&
    segments.at(-1)?.segmentId ===
      `${latestTransactionId}__replacement-${replacementCount}`;
  const continuityScopes = new Set(
    segments.flatMap((segment) => segment.playerWindowContinuity
      ? [
          `${segment.playerWindowContinuity.ownerId}::` +
            segment.playerWindowContinuity.rosterSlotId,
        ]
      : []),
  );
  const segmentPositions = new Set(
    segments.map((segment) => segment.asset.position),
  );
  const replacementBoundaries = segments
    .filter((segment) => segment.reason === 'injury-replacement')
    .map((segment) => segment.assignmentNotBeforeMilliseconds!);
  const replacementBoundariesAreMonotonic = replacementBoundaries.every(
    (boundary, index) => index === 0 || boundary >= replacementBoundaries[index - 1],
  );

  if (
    !latestTransactionId ||
    requiredGames <= 0 ||
    replacementCount <= 0 ||
    segments.length !== source['segments'].length ||
    (!hasAuditedOriginalSegment && !hasLegacyOmittedOriginalSegment) ||
    continuityScopes.size > 1 ||
    segmentPositions.size !== 1 ||
    !replacementBoundariesAreMonotonic ||
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

export function requireValidInjuryReplacementWindowPlan(
  value: unknown,
  context: string,
): InjuryReplacementWindowPlan | null {
  if (value === null || value === undefined) {
    return null;
  }

  const plan = normalizeInjuryReplacementWindowPlan(value);

  if (!plan) {
    throw new Error(
      `${context} contains invalid injury-replacement ownership evidence.`,
    );
  }

  return plan;
}

function getEffectiveSegmentSourceTeamByGameId(
  segment: InjuryReplacementWindowSegment,
): Record<string, string> {
  return Object.fromEntries(
    segment.scheduledGameIds.map((gameId) => [
      String(gameId),
      segment.sourceTeamAbbreviationByGameId?.[String(gameId)] ??
        segment.sourceTeamAbbreviation,
    ]),
  );
}

export function getInjuryReplacementPlanAuthorityFingerprint(
  plan: InjuryReplacementWindowPlan,
): string {
  return JSON.stringify({
    schemaVersion: plan.schemaVersion,
    latestTransactionId: plan.latestTransactionId,
    replacementCount: plan.replacementCount,
    requiredGames: plan.requiredGames,
    segments: plan.segments.map((segment) => ({
      segmentId: segment.segmentId,
      reason: segment.reason,
      assetKey: segment.assetKey,
      assetType: segment.asset.assetType,
      playerId:
        segment.asset.assetType === 'skater'
          ? segment.asset.player.id
          : null,
      position: segment.asset.position,
      scheduledGameIds: segment.scheduledGameIds,
      sourceTeamAbbreviation: segment.sourceTeamAbbreviation,
      sourceTeamAbbreviationByGameId:
        getEffectiveSegmentSourceTeamByGameId(segment),
      assignmentNotBeforeMilliseconds:
        segment.assignmentNotBeforeMilliseconds ?? null,
      activatedAtMilliseconds: segment.activatedAtMilliseconds ?? null,
      continuityId: segment.playerWindowContinuity?.continuityId ?? null,
    })),
  });
}

function getSegmentLineageFingerprint(
  segment: InjuryReplacementWindowSegment,
): string {
  const continuity = segment.playerWindowContinuity;

  return JSON.stringify({
    segmentId: segment.segmentId,
    reason: segment.reason,
    assetKey: segment.assetKey,
    assetType: segment.asset.assetType,
    playerId:
      segment.asset.assetType === 'skater'
        ? segment.asset.player.id
        : null,
    position: segment.asset.position,
    assignmentNotBeforeMilliseconds:
      segment.assignmentNotBeforeMilliseconds ?? null,
    activatedAtMilliseconds: segment.activatedAtMilliseconds ?? null,
    continuity: continuity
      ? {
          schemaVersion: continuity.schemaVersion,
          continuityId: continuity.continuityId,
          ownerId: continuity.ownerId,
          rosterSlotId: continuity.rosterSlotId,
          assetKey: continuity.assetKey,
          assignmentNotBeforeMilliseconds:
            continuity.assignmentNotBeforeMilliseconds ?? null,
          priorAssignedGameIds: continuity.priorAssignedGameIds,
          lastScheduleTeamAbbreviation:
            continuity.lastScheduleTeamAbbreviation ?? null,
        }
      : null,
  });
}

function getSegmentOwnershipFingerprint(
  segment: InjuryReplacementWindowSegment,
): string {
  return JSON.stringify({
    lineage: getSegmentLineageFingerprint(segment),
    scheduledGameIds: segment.scheduledGameIds,
    sourceTeamAbbreviation: segment.sourceTeamAbbreviation,
    sourceTeamAbbreviationByGameId:
      getEffectiveSegmentSourceTeamByGameId(segment),
  });
}

function hasCompatiblePlanLineage(
  candidate: InjuryReplacementWindowPlan,
  selected: InjuryReplacementWindowPlan,
): boolean {
  if (
    candidate.requiredGames !== selected.requiredGames ||
    candidate.replacementCount > selected.replacementCount ||
    candidate.segments.length > selected.segments.length
  ) {
    return false;
  }

  if (
    candidate.replacementCount === selected.replacementCount &&
    (candidate.latestTransactionId !== selected.latestTransactionId ||
      candidate.segments.length !== selected.segments.length)
  ) {
    return false;
  }

  for (let index = 0; index < candidate.segments.length; index += 1) {
    const candidateSegment = candidate.segments[index];
    const selectedSegment = selected.segments[index];

    if (
      !selectedSegment ||
      getSegmentLineageFingerprint(candidateSegment) !==
        getSegmentLineageFingerprint(selectedSegment)
    ) {
      return false;
    }

    const candidateIsLatest = index === candidate.segments.length - 1;

    if (!candidateIsLatest) {
      if (
        getSegmentOwnershipFingerprint(candidateSegment) !==
          getSegmentOwnershipFingerprint(selectedSegment)
      ) {
        return false;
      }
      continue;
    }

    if (candidate.replacementCount < selected.replacementCount) {
      const retainedGameIds = new Set(selectedSegment.scheduledGameIds);
      const expectedRetainedOrder = candidateSegment.scheduledGameIds.filter(
        (gameId) => retainedGameIds.has(gameId),
      );

      if (
        JSON.stringify(expectedRetainedOrder) !==
          JSON.stringify(selectedSegment.scheduledGameIds) ||
        selectedSegment.scheduledGameIds.some((gameId) => {
          const gameIdKey = String(gameId);
          const candidateTeam =
            candidateSegment.sourceTeamAbbreviationByGameId?.[gameIdKey] ??
            candidateSegment.sourceTeamAbbreviation;
          const selectedTeam =
            selectedSegment.sourceTeamAbbreviationByGameId?.[gameIdKey] ??
            selectedSegment.sourceTeamAbbreviation;
          return candidateTeam !== selectedTeam;
        })
      ) {
        return false;
      }
    }
  }

  return true;
}

export function resolveConsistentInjuryReplacementWindowPlan(input: {
  values: readonly unknown[];
  context: string;
}): InjuryReplacementWindowPlan | null {
  const plans = input.values
    .map((value) => requireValidInjuryReplacementWindowPlan(value, input.context))
    .filter((plan): plan is InjuryReplacementWindowPlan => plan !== null);

  if (plans.length === 0) {
    return null;
  }

  const selected = plans.reduce((mostAdvanced, candidate) =>
    candidate.replacementCount > mostAdvanced.replacementCount
      ? candidate
      : mostAdvanced,
  );

  if (
    plans.some(
      (plan) => !hasCompatiblePlanLineage(plan, selected),
    )
  ) {
    throw new Error(
      `${input.context} contains conflicting injury-replacement ownership evidence.`,
    );
  }

  return selected;
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

export function hasExactInjuryReplacementScoringAssetKeyMap(
  plan: InjuryReplacementWindowPlan,
  value: unknown,
): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const observed = value as Record<string, unknown>;
  const expected = getInjuryReplacementAssetKeyByGameId(plan);
  const observedKeys = Object.keys(observed);
  const expectedKeys = Object.keys(expected);

  return observedKeys.length === expectedKeys.length &&
    observedKeys.every(
      (gameId) => expected[gameId] !== undefined && observed[gameId] === expected[gameId],
    );
}

export function hasPreservedInjuryReplacementProtectedGameOwnership(input: {
  previousPlan?: InjuryReplacementWindowPlan | null;
  nextPlan: InjuryReplacementWindowPlan;
  protectedGameIds: readonly number[];
  previousAssetKey: string;
  previousScheduleTeamAbbreviation?: string | null;
  previousSourceTeamAbbreviationByGameId?: Readonly<Record<string, string>>;
}): boolean {
  const previousSegmentByGameId = new Map(
    (input.previousPlan?.segments ?? []).flatMap((segment) =>
      segment.scheduledGameIds.map((gameId) => [gameId, segment] as const),
    ),
  );
  const nextSegmentByGameId = new Map(
    input.nextPlan.segments.flatMap((segment) =>
      segment.scheduledGameIds.map((gameId) => [gameId, segment] as const),
    ),
  );

  return input.protectedGameIds.every((gameId) => {
    if (!Number.isSafeInteger(gameId) || gameId <= 0) {
      return false;
    }

    const key = String(gameId);
    const previousSegment = previousSegmentByGameId.get(gameId);
    const nextSegment = nextSegmentByGameId.get(gameId);
    const previousAssetKey = previousSegment?.assetKey ?? input.previousAssetKey;
    const previousSourceTeam =
      previousSegment?.sourceTeamAbbreviationByGameId?.[key] ??
      input.previousSourceTeamAbbreviationByGameId?.[key] ??
      previousSegment?.sourceTeamAbbreviation ??
      input.previousScheduleTeamAbbreviation?.trim().toUpperCase() ??
      '';
    const nextSourceTeam =
      nextSegment?.sourceTeamAbbreviationByGameId?.[key] ??
      nextSegment?.sourceTeamAbbreviation ??
      '';

    return Boolean(
      previousAssetKey &&
      previousSourceTeam &&
      nextSegment &&
      nextSegment.assetKey === previousAssetKey &&
      nextSourceTeam === previousSourceTeam,
    );
  });
}

export function getInjuryReplacementProtectedGameIds(input: {
  completedGameIds?: readonly number[];
  liveGameIds?: readonly number[];
  incompleteFinalGameIds?: readonly number[];
  appearanceGameIds?: readonly number[];
  gameStates?: Readonly<Record<string, unknown>>;
}): number[] {
  const protectedGameIds = new Set<number>();

  for (const gameId of [
    ...(input.completedGameIds ?? []),
    ...(input.liveGameIds ?? []),
    ...(input.incompleteFinalGameIds ?? []),
    ...(input.appearanceGameIds ?? []),
  ]) {
    if (Number.isSafeInteger(gameId) && gameId > 0) {
      protectedGameIds.add(gameId);
    }
  }

  for (const [gameIdKey, gameState] of Object.entries(input.gameStates ?? {})) {
    const gameId = Number(gameIdKey);
    if (
      (gameState === 'live' || gameState === 'final') &&
      Number.isSafeInteger(gameId) &&
      gameId > 0
    ) {
      protectedGameIds.add(gameId);
    }
  }

  return [...protectedGameIds].sort((left, right) => left - right);
}

export function hasConsistentInjuryReplacementWindowEvidence(input: {
  plan: InjuryReplacementWindowPlan;
  scheduledGameIds: unknown;
  scoringAssetKeyByGameId: unknown;
  assetKey: string;
  ownerId?: string | null;
  rosterSlotId?: string | null;
  position?: string | null;
  scheduleTeamAbbreviation?: string | null;
  sourceTeamAbbreviationByGameId?: Readonly<Record<string, string>>;
  completedGameIds?: readonly number[];
  liveGameIds?: readonly number[];
  incompleteFinalGameIds?: readonly number[];
  appearanceGameIds?: readonly number[];
  gameStates?: Readonly<Record<string, unknown>>;
}): boolean {
  const scheduledGameIds = normalizeGameIds(input.scheduledGameIds);
  const planGameIds = getInjuryReplacementGameIds(input.plan);

  if (
    !scheduledGameIds ||
    JSON.stringify(scheduledGameIds) !== JSON.stringify(planGameIds) ||
    input.plan.segments.at(-1)?.assetKey !== input.assetKey ||
    (
      input.ownerId &&
      input.plan.segments.some(
        (segment) =>
          segment.playerWindowContinuity &&
          segment.playerWindowContinuity.ownerId !== input.ownerId,
      )
    ) ||
    (
      input.rosterSlotId &&
      input.plan.segments.some(
        (segment) =>
          segment.playerWindowContinuity &&
          segment.playerWindowContinuity.rosterSlotId !== input.rosterSlotId,
      )
    ) ||
    (
      input.position &&
      input.plan.segments.some(
        (segment) => segment.asset.position !== input.position,
      )
    ) ||
    !hasExactInjuryReplacementScoringAssetKeyMap(
      input.plan,
      input.scoringAssetKeyByGameId,
    )
  ) {
    return false;
  }

  return hasPreservedInjuryReplacementProtectedGameOwnership({
    previousPlan: input.plan,
    nextPlan: input.plan,
    protectedGameIds: getInjuryReplacementProtectedGameIds(input),
    previousAssetKey: input.assetKey,
    previousScheduleTeamAbbreviation: input.scheduleTeamAbbreviation,
    previousSourceTeamAbbreviationByGameId:
      input.sourceTeamAbbreviationByGameId,
  });
}
