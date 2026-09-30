import type { FantasyDraft } from '../../../core/draft/draft.models';

// Keep this utility dependency-free so its Draft binding decisions can be
// exercised directly by the Node regression suite as well as Angular.
const LEGACY_PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION = 2;
const ANCHORED_PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION = 3;

export interface DraftProjectionPoolBinding {
  snapshotId: string;
  snapshotHash: string;
}

export interface DraftProjectionSnapshotSchemaEvidence {
  snapshotHashSchemaVersion?: number;
  seasonWindowAnchorEvidenceHash?: string | null;
}

export type DraftProjectionPoolSource =
  | { kind: 'shared' }
  | { kind: 'exact'; binding: DraftProjectionPoolBinding }
  | { kind: 'waiting-for-readiness' }
  | { kind: 'invalid-frozen-binding' };

export interface DraftProjectionPoolReloadInput {
  hadObservedDraftSnapshot: boolean;
  previousStatus: FantasyDraft['status'] | null;
  nextStatus: FantasyDraft['status'] | null;
  previousBindingKey: string | null;
  nextBindingKey: string | null;
}

function getTimestampMilliseconds(value: unknown): number | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.getTime() : null;
  }

  if (
    typeof value === 'object' &&
    value !== null &&
    'toDate' in value &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  ) {
    const date = (value as { toDate: () => Date }).toDate();
    return date instanceof Date && Number.isFinite(date.getTime())
      ? date.getTime()
      : null;
  }

  return null;
}

function getNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized ? normalized : null;
}

function getSha256(value: unknown): string | null {
  const normalized = getNonEmptyString(value);
  return normalized && /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

/**
 * Existing unanchored Drafts may keep using their verified schema-2 board
 * during a mixed-version release. Once a season-window anchor is ready, only
 * schema 3 with the exact frozen anchor hash is valid.
 */
export function isDraftProjectionSnapshotSchemaCompatible(
  draft: FantasyDraft | null,
  evidence: DraftProjectionSnapshotSchemaEvidence,
): boolean {
  const draftAnchorHash = getSha256(draft?.seasonWindowAnchorEvidenceHash);
  const anchorIsRequired = draft?.seasonWindowAnchorStatus === 'ready' ||
    draftAnchorHash !== null;

  if (anchorIsRequired) {
    return draftAnchorHash !== null &&
      evidence.snapshotHashSchemaVersion ===
        ANCHORED_PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION &&
      getSha256(evidence.seasonWindowAnchorEvidenceHash) === draftAnchorHash;
  }

  return evidence.snapshotHashSchemaVersion ===
      LEGACY_PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION ||
    evidence.snapshotHashSchemaVersion ===
      ANCHORED_PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION;
}

/**
 * Resolves only a server-verified snapshot that is exact for the current Draft.
 * Scheduled Drafts use readiness evidence; live/complete Drafts use the frozen
 * authority fields. Setup can still use the ordinary shared Projection view.
 */
export function getDraftProjectionPoolBinding(
  draft: FantasyDraft | null,
): DraftProjectionPoolBinding | null {
  if (!draft) {
    return null;
  }

  if (draft.status === 'live' || draft.status === 'complete') {
    const snapshotId = getNonEmptyString(draft.serverDraftProjectionSnapshotId);
    const snapshotHash = getSha256(draft.serverDraftProjectionSnapshotHash);

    return snapshotId && snapshotHash ? { snapshotId, snapshotHash } : null;
  }

  if (draft.status !== 'scheduled') {
    return null;
  }

  const scheduledStartMilliseconds = getTimestampMilliseconds(draft.scheduledStartAt);
  const readinessStartMilliseconds = getTimestampMilliseconds(
    draft.serverDraftReadinessScheduledStartAt,
  );
  const availabilityRevision = getSha256(
    draft.serverDraftReadinessAvailabilityRevision,
  );
  const requestId = getNonEmptyString(
    draft.serverDraftReadinessProjectionRequestId,
  );
  const snapshotId = getNonEmptyString(
    draft.serverDraftReadinessProjectionSnapshotId,
  );
  const snapshotHash = getSha256(
    draft.serverDraftReadinessProjectionSnapshotHash,
  );

  if (
    scheduledStartMilliseconds === null ||
    readinessStartMilliseconds !== scheduledStartMilliseconds ||
    draft.serverDraftReadinessStatus !== 'ready' ||
    !availabilityRevision ||
    !requestId ||
    !snapshotId ||
    !snapshotHash
  ) {
    return null;
  }

  return {
    snapshotId,
    snapshotHash,
  };
}

export function getDraftProjectionPoolBindingKey(
  draft: FantasyDraft | null,
): string | null {
  const binding = getDraftProjectionPoolBinding(draft);
  return binding ? `${binding.snapshotId}:${binding.snapshotHash}` : null;
}

export function getDraftProjectionPoolSource(
  draft: FantasyDraft | null,
): DraftProjectionPoolSource {
  const binding = getDraftProjectionPoolBinding(draft);

  if (binding) {
    return { kind: 'exact', binding };
  }

  if (draft?.status === 'scheduled') {
    return { kind: 'waiting-for-readiness' };
  }

  if (draft?.status === 'live' || draft?.status === 'complete') {
    return { kind: 'invalid-frozen-binding' };
  }

  return { kind: 'shared' };
}

export function shouldReloadDraftProjectionPool(
  input: DraftProjectionPoolReloadInput,
): boolean {
  if (!input.hadObservedDraftSnapshot) {
    return true;
  }

  if (input.previousBindingKey !== input.nextBindingKey) {
    return true;
  }

  return input.previousStatus !== input.nextStatus;
}
