export interface ProjectionPublicationGuardInput {
  requestExists: boolean;
  requestStatus: unknown;
  requestLeagueId: unknown;
  requestRequestedBy: unknown;
  requestTargetCycleNumber: unknown;
  requestTargetSourceBlockNumber: number;
  requestSeasonWindowAnchorEvidenceHash: unknown;
  requestTargetGameIdsMatch: boolean;
  requestSourceGamePlanMatches: boolean;
  activeRequestId: unknown;
  expectedRequestId: string;
  expectedLeagueId: string;
  expectedRequestedBy: string;
  expectedTargetCycleNumber: number;
  expectedTargetSourceBlockNumber: number;
  expectedSeasonWindowAnchorEvidenceHash: string | null;
  requiresDraftScheduleBinding: boolean;
  draftExists: boolean;
  draftStatus: unknown;
  expectedDraftScheduleGeneration: number | null;
  expectedDraftScheduledStartMilliseconds: number | null;
  draftScheduleGeneration: unknown;
  draftScheduledStartMilliseconds: number;
  draftAnchorScheduleGeneration: unknown;
  draftAnchorStatus: unknown;
  draftInitialNhlBlockNumber: unknown;
  draftSeasonWindowAnchorEvidenceHash: unknown;
  draftTargetGameIdsMatch: boolean;
  draftSourceGamePlanMatches: boolean;
  generationReason: string;
}

/**
 * Final compare-and-set predicate used after a long Projection V11 build.
 * An immutable snapshot may exist even when this returns false, but shared
 * pointers and readiness must not move.
 */
export function shouldPublishProjectionResult(
  input: ProjectionPublicationGuardInput,
): boolean {
  const requestStillActive =
    input.requestExists &&
    input.requestStatus === 'processing' &&
    input.requestLeagueId === input.expectedLeagueId &&
    input.requestRequestedBy === input.expectedRequestedBy &&
    input.requestTargetCycleNumber === input.expectedTargetCycleNumber &&
    input.requestTargetSourceBlockNumber ===
      input.expectedTargetSourceBlockNumber &&
    (input.requestSeasonWindowAnchorEvidenceHash ?? null) ===
      input.expectedSeasonWindowAnchorEvidenceHash &&
    input.requestTargetGameIdsMatch &&
    input.requestSourceGamePlanMatches &&
    input.activeRequestId === input.expectedRequestId;

  const draftScheduleStillMatches =
    !input.requiresDraftScheduleBinding || (
      input.draftExists &&
      input.draftStatus === 'scheduled' &&
      typeof input.expectedDraftScheduleGeneration === 'number' &&
      typeof input.expectedDraftScheduledStartMilliseconds === 'number' &&
      input.draftScheduleGeneration === input.expectedDraftScheduleGeneration &&
      input.draftAnchorScheduleGeneration ===
        input.expectedDraftScheduleGeneration &&
      input.draftScheduledStartMilliseconds ===
        input.expectedDraftScheduledStartMilliseconds &&
      input.draftAnchorStatus === 'ready' &&
      input.draftInitialNhlBlockNumber ===
        input.expectedTargetSourceBlockNumber &&
      input.draftSeasonWindowAnchorEvidenceHash ===
        input.expectedSeasonWindowAnchorEvidenceHash &&
      input.draftTargetGameIdsMatch &&
      input.draftSourceGamePlanMatches
    );
  const legacyPreDraftStillCompatible =
    input.generationReason !== 'pre-draft' ||
    Boolean(input.expectedSeasonWindowAnchorEvidenceHash) ||
    input.draftAnchorStatus !== 'ready';

  return requestStillActive &&
    draftScheduleStillMatches &&
    legacyPreDraftStillCompatible;
}

export function shouldMutateProjectionControl(
  activeRequestId: unknown,
  requestId: string,
): boolean {
  return activeRequestId === requestId;
}

export function shouldReuseActiveProjectionRequest(input: {
  activeRequestId: string;
  nextRequestId: string;
  activeStatus: string;
  activeLeaseExpiresAt: number;
  now: number;
  activePayloadHash: unknown;
  nextPayloadHash: string;
}): boolean {
  return input.activeRequestId !== input.nextRequestId &&
    (input.activeStatus === 'queued' || input.activeStatus === 'processing') &&
    input.activeLeaseExpiresAt > input.now &&
    input.activePayloadHash === input.nextPayloadHash;
}
