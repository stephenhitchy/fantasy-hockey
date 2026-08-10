import { httpsCallable } from 'firebase/functions';

import { functions } from '../firebase-functions';

export interface AccountDeletionLeagueSummary {
  leagueId: string;
  leagueName: string;
}

export interface AccountDeletionReadiness {
  canDelete: boolean;
  commissionerLeagues: AccountDeletionLeagueSummary[];
  memberLeagueCount: number;
  anonymizedLeagueCount: number;
}

interface DeleteMyAccountRequest {
  confirmationUsername: string;
}

export interface DeleteMyAccountResult {
  deleted: boolean;
  anonymizedLeagueCount: number;
  deletedDocumentCount: number;
}

export async function getAccountDeletionReadiness(): Promise<AccountDeletionReadiness> {
  const callable = httpsCallable<Record<string, never>, AccountDeletionReadiness>(
    functions,
    'getAccountDeletionReadiness',
    { timeout: 65_000 },
  );
  const response = await callable({});

  return response.data;
}

export { reauthenticateCurrentUserWithPassword } from './recent-auth.service';

export async function deleteCurrentUserAccount(
  confirmationUsername: string,
): Promise<DeleteMyAccountResult> {
  const callable = httpsCallable<DeleteMyAccountRequest, DeleteMyAccountResult>(
    functions,
    'deleteMyAccount',
    { timeout: 600_000 },
  );
  const response = await callable({ confirmationUsername });

  return response.data;
}
