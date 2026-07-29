import {
  EmailAuthProvider,
  reauthenticateWithCredential,
} from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';

import { auth } from '../firebase-auth';
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
  );
  const response = await callable({});

  return response.data;
}

export async function reauthenticateCurrentUserWithPassword(password: string): Promise<void> {
  const user = auth.currentUser;

  if (!user || !user.email) {
    throw new Error('Your account is not signed in with an email address.');
  }

  const credential = EmailAuthProvider.credential(user.email, password);
  await reauthenticateWithCredential(user, credential);
  await user.getIdToken(true);
}

export async function deleteCurrentUserAccount(
  confirmationUsername: string,
): Promise<DeleteMyAccountResult> {
  const callable = httpsCallable<DeleteMyAccountRequest, DeleteMyAccountResult>(
    functions,
    'deleteMyAccount',
  );
  const response = await callable({ confirmationUsername });

  return response.data;
}
