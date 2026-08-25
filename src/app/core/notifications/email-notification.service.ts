import { httpsCallable } from 'firebase/functions';

import { functions } from '../firebase-functions';

interface PasswordResetResponse {
  accepted: boolean;
}

export type VerificationEmailOutcome =
  | 'ready'
  | 'sent'
  | 'cooldown'
  | 'already-verified'
  | 'blocked';

export interface VerificationEmailResponse {
  accepted: boolean;
  alreadyVerified: boolean;
  outcome: VerificationEmailOutcome;
  eligible: boolean;
  emailPreviouslySent: boolean;
  firstSend: boolean;
  cooldownSecondsRemaining: number;
  nextAllowedAtMillis: number;
}

interface TestInjuryEmailResponse {
  accepted: boolean;
  message: string;
}

export async function requestPasswordResetEmail(email: string): Promise<void> {
  const callable = httpsCallable<{ email: string }, PasswordResetResponse>(
    functions,
    'requestPasswordResetEmail',
    { timeout: 35_000 },
  );

  await callable({ email });
}

async function callVerificationEmail(
  action: 'status' | 'send',
): Promise<VerificationEmailResponse> {
  const callable = httpsCallable<
    { action: 'status' | 'send' },
    VerificationEmailResponse
  >(
    functions,
    'resendVerificationEmail',
    { timeout: 35_000 },
  );
  const result = await callable({ action });
  return result.data;
}

export async function getVerificationEmailState(): Promise<VerificationEmailResponse> {
  return callVerificationEmail('status');
}

export async function requestVerificationEmail(): Promise<VerificationEmailResponse> {
  return callVerificationEmail('send');
}


export async function requestTestInjuryEmail(
  leagueId: string,
): Promise<TestInjuryEmailResponse> {
  const callable = httpsCallable<{ leagueId: string }, TestInjuryEmailResponse>(
    functions,
    'sendTestInjuryEmail',
    { timeout: 35_000 },
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
