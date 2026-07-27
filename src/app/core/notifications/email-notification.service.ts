import { httpsCallable } from 'firebase/functions';

import { functions } from '../firebase-functions';

interface PasswordResetResponse {
  accepted: boolean;
}

interface VerificationEmailResponse {
  accepted: boolean;
  alreadyVerified: boolean;
}

interface TestInjuryEmailResponse {
  accepted: boolean;
  message: string;
}

export async function requestPasswordResetEmail(email: string): Promise<void> {
  const callable = httpsCallable<{ email: string }, PasswordResetResponse>(
    functions,
    'requestPasswordResetEmail',
  );

  await callable({ email });
}

export async function requestVerificationEmail(): Promise<VerificationEmailResponse> {
  const callable = httpsCallable<Record<string, never>, VerificationEmailResponse>(
    functions,
    'resendVerificationEmail',
  );
  const result = await callable({});
  return result.data;
}


export async function requestTestInjuryEmail(
  leagueId: string,
): Promise<TestInjuryEmailResponse> {
  const callable = httpsCallable<{ leagueId: string }, TestInjuryEmailResponse>(
    functions,
    'sendTestInjuryEmail',
  );

  try {
    const result = await callable({ leagueId });
    return result.data;
  } catch (error: unknown) {
    const record = error && typeof error === 'object'
      ? error as { code?: unknown; message?: unknown }
      : {};
    const code = typeof record.code === 'string' ? record.code : '';
    const rawMessage = typeof record.message === 'string' ? record.message.trim() : '';
    const message = rawMessage
      .replace(/^FirebaseError:\s*/i, '')
      .replace(/^\[functions\/[^\]]+\]\s*/i, '')
      .trim();

    if (message) {
      throw new Error(message);
    }

    if (code.includes('unauthenticated')) {
      throw new Error('Sign in again before sending the test injury email.');
    }

    if (code.includes('permission-denied')) {
      throw new Error('Only the league commissioner can use this test email button.');
    }

    throw new Error(
      'The test injury email could not be sent. Check the function log for sendTestInjuryEmail.',
    );
  }
}
