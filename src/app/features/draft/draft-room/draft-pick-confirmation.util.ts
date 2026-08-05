import type { DraftPick, FantasyDraft } from '../../../core/draft/draft.models';

export interface PendingDraftPickIdentity {
  overallPick: number;
  assetKey: string;
  ownerId: string;
  submissionId?: string | null;
}

function cleanKey(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Confirms an exact manual pick from the live pick collection.
 *
 * The owning manager is normally stored in ownerId. selectedByUserId is also
 * accepted because older/test drafts may retain the team owner in ownerId while
 * recording the authenticated manager separately.
 */
export function draftPickMatchesPending(
  pick: DraftPick | null | undefined,
  pending: PendingDraftPickIdentity,
): boolean {
  if (!pick || pick.overallPick !== pending.overallPick) {
    return false;
  }

  if (cleanKey(pick.asset?.assetKey) !== cleanKey(pending.assetKey)) {
    return false;
  }

  const expectedSubmissionId = cleanKey(pending.submissionId);
  const observedSubmissionId = cleanKey(pick.submissionId);

  if (expectedSubmissionId && observedSubmissionId !== expectedSubmissionId) {
    return false;
  }

  return pick.ownerId === pending.ownerId || pick.selectedByUserId === pending.ownerId;
}

/**
 * The draft document is an independent authoritative confirmation path. This
 * allows the UI to settle when the draft-state listener advances before the
 * ordered picks query delivers its next snapshot.
 */
export function draftStateShowsPendingPickCommitted(
  draft: FantasyDraft | null | undefined,
  pending: PendingDraftPickIdentity,
): boolean {
  if (!draft) {
    return false;
  }

  // New manual submissions carry an exact idempotency key on the pick
  // document. The aggregate draft document does not contain that key, so it
  // must not settle a new submission by itself. The callable response, live
  // pick listener, or bounded direct pick-document read provides the exact
  // confirmation. This legacy fallback remains only for old records/tests
  // that predate submission identifiers.
  if (cleanKey(pending.submissionId)) {
    return false;
  }

  const assetWasDrafted = (draft.draftedAssetKeys ?? []).some(
    (assetKey) => cleanKey(assetKey) === cleanKey(pending.assetKey),
  );
  const boardAdvanced =
    draft.nextOverallPick > pending.overallPick || draft.status === 'complete';
  const expectedPickId = String(pending.overallPick).padStart(3, '0');

  // draftedAssetKeys is cumulative. Requiring the exact lastPickId prevents a
  // false positive when the same asset was drafted by a later manager while a
  // stale tab was still trying to reconcile an older request.
  return assetWasDrafted && boardAdvanced && draft.lastPickId === expectedPickId;
}

export function mergeConfirmedDraftPick(
  picks: DraftPick[],
  confirmedPick: DraftPick,
): DraftPick[] {
  const withoutDuplicate = picks.filter(
    (pick) => pick.overallPick !== confirmedPick.overallPick,
  );

  return [...withoutDuplicate, confirmedPick].sort(
    (first, second) => first.overallPick - second.overallPick,
  );
}
