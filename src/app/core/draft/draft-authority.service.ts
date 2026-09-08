import { httpsCallable } from 'firebase/functions';

import { functions } from '../firebase-functions';
import { DraftPick, FantasyDraft } from './draft.models';

export type DraftCommandAction =
  | 'save-settings'
  | 'activate-scheduled'
  | 'start-clock'
  | 'pause-clock'
  | 'resume-clock';

export interface DraftCommandRequest {
  leagueId: string;
  action: DraftCommandAction;
  submissionId?: string;
  roundOneOrder?: string[];
  scheduledStartAt?: string | null;
  pickSeconds?: number;
}

export interface DraftCommandResult {
  applied: true;
  action: DraftCommandAction;
  message: string;
  submissionId?: string | null;
}

const executeDraftCommandCallable = httpsCallable<
  DraftCommandRequest,
  DraftCommandResult
>(functions, 'executeDraftCommand', {
  // Draft commands run on a 60-second Function ceiling. A slightly longer
  // transport timeout prevents the browser from reporting failure just before
  // the committed draft document reaches the live listener.
  timeout: 65_000,
});

export async function executeDraftCommand(
  request: DraftCommandRequest,
): Promise<DraftCommandResult> {
  const response = await executeDraftCommandCallable(request);
  return response.data;
}

interface SecureDraftPickRequest {
  leagueId: string;
  assetKey: string;
  submissionId: string;
  expectedOverallPick: number;
}

interface SecureDraftPickResult {
  pick: DraftPick;
}

const makeSecureDraftPickCallable = httpsCallable<
  SecureDraftPickRequest,
  SecureDraftPickResult
>(functions, 'makeSecureDraftPick', {
  // The server can continue through its 60-second ceiling after a browser
  // transport closes. End the direct wait sooner and let the Draft Room
  // reconcile the exact draft and pick documents, preventing a tab from
  // remaining stuck on ‘sending selection’ while a committed pick is already
  // visible in Firestore.
  timeout: 25_000,
});

export async function makeSecureDraftPick(
  leagueId: string,
  assetKey: string,
  submissionId: string,
  expectedOverallPick: number,
): Promise<DraftPick> {
  const response = await makeSecureDraftPickCallable({
    leagueId,
    assetKey,
    submissionId,
    expectedOverallPick,
  });
  return response.data.pick;
}

export interface RepairDraftTurnHandoffResult {
  repaired: boolean;
  status: FantasyDraft['status'];
  nextOverallPick: number;
  currentOwnerId: string | null;
  clockTaskScheduled: boolean;
  message: string;
}

const repairDraftTurnHandoffCallable = httpsCallable<
  { leagueId: string },
  RepairDraftTurnHandoffResult
>(functions, 'repairDraftTurnHandoff', {
  timeout: 30_000,
});

/**
 * Reconciles the exact live turn from committed pick documents. This is a
 * bounded recovery path for the rare case where a pick is visible before the
 * next draft turn or clock becomes usable in the browser.
 */
export async function repairDraftTurnHandoff(
  leagueId: string,
): Promise<RepairDraftTurnHandoffResult> {
  const response = await repairDraftTurnHandoffCallable({ leagueId });
  return response.data;
}
