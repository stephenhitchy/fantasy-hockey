import { httpsCallable } from 'firebase/functions';

import { DraftableAsset } from '../draft/draft.models';
import { functions } from '../firebase-functions';

export type ImmediateRosterMoveType =
  | 'add-drop-active'
  | 'add-open-active'
  | 'active-bench-swap'
  | 'activate-ir-active'
  | 'move-active-to-ir'
  | 'drop-active';

export interface ImmediateRosterMoveRequest {
  leagueId: string;
  moveType: ImmediateRosterMoveType;
  activeSlotId: string;
  benchSlotId?: string | null;
  irSlotId?: string | null;
  addAsset?: DraftableAsset | null;
}

export interface ImmediateRosterMoveResult {
  applied: true;
  cycleNumber: number;
  activeSlotId: string;
  message: string;
}

const applyImmediateRosterMoveCallable = httpsCallable<
  ImmediateRosterMoveRequest,
  ImmediateRosterMoveResult
>(functions, 'applyImmediateRosterMove');

export async function applyImmediateRosterMove(
  request: ImmediateRosterMoveRequest,
): Promise<ImmediateRosterMoveResult> {
  const response = await applyImmediateRosterMoveCallable(request);

  return response.data;
}
