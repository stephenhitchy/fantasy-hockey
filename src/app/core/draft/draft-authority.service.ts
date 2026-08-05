import { httpsCallable } from 'firebase/functions';

import { functions } from '../firebase-functions';
import { DraftPick } from './draft.models';

export type DraftCommandAction =
  | 'save-settings'
  | 'activate-scheduled'
  | 'start-clock'
  | 'pause-clock'
  | 'resume-clock';

export interface DraftCommandRequest {
  leagueId: string;
  action: DraftCommandAction;
  roundOneOrder?: string[];
  scheduledStartAt?: string | null;
  pickSeconds?: number;
}

export interface DraftCommandResult {
  applied: true;
  action: DraftCommandAction;
  message: string;
}

const executeDraftCommandCallable = httpsCallable<
  DraftCommandRequest,
  DraftCommandResult
>(functions, 'executeDraftCommand');

export async function executeDraftCommand(
  request: DraftCommandRequest,
): Promise<DraftCommandResult> {
  const response = await executeDraftCommandCallable(request);
  return response.data;
}

interface SecureDraftPickRequest {
  leagueId: string;
  assetKey: string;
}

interface SecureDraftPickResult {
  pick: DraftPick;
}

const makeSecureDraftPickCallable = httpsCallable<
  SecureDraftPickRequest,
  SecureDraftPickResult
>(functions, 'makeSecureDraftPick', {
  // The Function itself has a 60-second ceiling. Keep the browser transport
  // alive slightly longer so a healthy cold start cannot be reported as a
  // client-side timeout immediately before the server response arrives.
  timeout: 65_000,
});

export async function makeSecureDraftPick(
  leagueId: string,
  assetKey: string,
): Promise<DraftPick> {
  const response = await makeSecureDraftPickCallable({ leagueId, assetKey });
  return response.data.pick;
}
