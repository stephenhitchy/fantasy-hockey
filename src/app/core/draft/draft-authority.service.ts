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
>(functions, 'makeSecureDraftPick');

export async function makeSecureDraftPick(
  leagueId: string,
  assetKey: string,
): Promise<DraftPick> {
  const response = await makeSecureDraftPickCallable({ leagueId, assetKey });
  return response.data.pick;
}
