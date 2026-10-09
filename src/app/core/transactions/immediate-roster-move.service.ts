import { httpsCallable } from 'firebase/functions';

import { functions } from '../firebase-functions';
import {
  executeIdempotentRosterActionWithQuickRetry,
} from './roster-action-transport.util';

export type ImmediateRosterMoveType =
  | 'add-drop-active'
  | 'injury-add-drop-active'
  | 'add-open-active'
  | 'active-bench-swap'
  | 'injury-active-bench-swap'
  | 'activate-ir-active'
  | 'move-active-to-ir'
  | 'injury-replacement'
  | 'drop-active';

export interface ImmediateRosterMoveRequest {
  leagueId: string;
  moveType: ImmediateRosterMoveType;
  activeSlotId: string;
  benchSlotId?: string | null;
  irSlotId?: string | null;
  addAssetKey?: string | null;
  expectedOutgoingAssetKey?: string | null;
  submissionId?: string | null;
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
>(functions, 'applyImmediateRosterMove', {
  // Keep this literal visible to the repository-wide callable safety audit.
  timeout: 65_000,
});

export async function applyImmediateRosterMove(
  request: ImmediateRosterMoveRequest,
): Promise<ImmediateRosterMoveResult> {
  const invoke = () => applyImmediateRosterMoveCallable(request);
  const response = request.submissionId &&
      (
        request.moveType === 'add-drop-active' ||
        request.moveType === 'injury-add-drop-active' ||
        request.moveType === 'add-open-active'
      )
    ? await executeIdempotentRosterActionWithQuickRetry(invoke)
    : await invoke();

  return response.data;
}
