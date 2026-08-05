import type { DraftPick, FantasyDraft } from '../../../core/draft/draft.models';

export interface PendingDraftPickIdentity {
  overallPick: number;
  assetKey: string;
  ownerId: string;
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
