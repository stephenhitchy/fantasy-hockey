import { httpsCallable } from 'firebase/functions';

import { functions } from '../firebase-functions';
import {
  executeIdempotentRosterActionWithQuickRetry,
} from './roster-action-transport.util';

/**
 * Browser transport for server-authoritative roster, waiver, bench, and IR
 * mutations. Client eligibility previews improve UX but cannot authorize a
 * move; the callable revalidates current state and callers confirm the result
 * through committed Firestore data.
 */
export type SecureRosterAction =
  | 'add-drop'
  | 'add-open-slot'
  | 'cancel-queued-move'
  | 'move-active-to-ir'
  | 'activate-ir-active'
  | 'drop-to-waivers'
  | 'queue-active-bench-swap'
  | 'move-bench-to-ir'
  | 'activate-ir-to-bench'
  | 'place-waiver-claim'
  | 'process-waiver';

export interface SecureRosterActionRequest {
  leagueId: string;
  action: SecureRosterAction;
  assetKey?: string | null;
  activeSlotId?: string | null;
  benchSlotId?: string | null;
  irSlotId?: string | null;
  rosterSlotId?: string | null;
  sourceRosterArea?: 'active' | 'bench' | 'ir' | null;
  slotId?: string | null;
  waiverId?: string | null;
  waiverMoveType?: 'drop' | 'open-slot' | null;
  waiverRosterArea?: 'active' | 'bench' | null;
  dropSlotId?: string | null;
  targetSlotId?: string | null;
  effectiveCycleNumber?: number | null;
  effectiveLabel?: string | null;
  expectedOutgoingAssetKey?: string | null;
  submissionId?: string | null;
}

export interface SecureRosterActionResult {
  applied: true;
  mode: 'immediate' | 'queued' | 'ownership-only';
  effectiveCycleNumber: number | null;
  message: string;
}

const executeSecureRosterActionCallable = httpsCallable<
  SecureRosterActionRequest,
  SecureRosterActionResult
>(functions, 'executeSecureRosterAction', {
  // Keep this literal visible to the repository-wide callable safety audit.
  timeout: 65_000,
});

export async function executeSecureRosterAction(
  request: SecureRosterActionRequest,
): Promise<SecureRosterActionResult> {
  const invoke = () => executeSecureRosterActionCallable(request);
  const response = request.submissionId &&
      (request.action === 'add-drop' || request.action === 'add-open-slot')
    ? await executeIdempotentRosterActionWithQuickRetry(invoke)
    : await invoke();
  return response.data;
}

interface EnsureFantasyRosterRequest {
  leagueId: string;
}

interface EnsureFantasyRosterResult {
  ensured: true;
  created: boolean;
  migrated: boolean;
}

const ensureFantasyRosterCallable = httpsCallable<
  EnsureFantasyRosterRequest,
  EnsureFantasyRosterResult
>(functions, 'ensureFantasyRoster', { timeout: 35_000 });

export async function ensureFantasyRoster(
  leagueId: string,
): Promise<EnsureFantasyRosterResult> {
  const response = await ensureFantasyRosterCallable({ leagueId });
  return response.data;
}
