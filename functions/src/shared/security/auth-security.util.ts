import { HttpsError } from 'firebase-functions/v2/https';

export const RECENT_AUTHENTICATION_WINDOW_SECONDS = 15 * 60;

export interface AuthDataLike {
  uid?: string;
  token?: Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function claimSeconds(value: unknown): number | null {
  const candidate = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(candidate) && candidate > 0 ? candidate : null;
}

export function requireAuthenticatedUserId(
  auth: AuthDataLike | null | undefined,
  actionLabel: string,
): string {
  const userId = asString(auth?.uid);

  if (!userId) {
    throw new HttpsError(
      'unauthenticated',
      `Sign in before you ${actionLabel}.`,
    );
  }

  return userId;
}

export function requireVerifiedEmail(
  auth: AuthDataLike | null | undefined,
  actionLabel: string,
): void {
  const token = auth?.token ?? {};
  const email = asString(token['email']);

  if (!email || token['email_verified'] !== true) {
    throw new HttpsError(
      'failed-precondition',
      `Verify your email address before you ${actionLabel}. Open Account Settings to resend the verification email.`,
      { reason: 'email-verification-required' },
    );
  }
}

export function authenticationAgeSeconds(
  auth: AuthDataLike | null | undefined,
  nowSeconds = Math.floor(Date.now() / 1_000),
): number | null {
  const authTimeSeconds = claimSeconds(auth?.token?.['auth_time']);
  return authTimeSeconds === null ? null : Math.max(0, nowSeconds - authTimeSeconds);
}

export function hasRecentAuthentication(
  auth: AuthDataLike | null | undefined,
  maximumAgeSeconds = RECENT_AUTHENTICATION_WINDOW_SECONDS,
): boolean {
  const ageSeconds = authenticationAgeSeconds(auth);
  return ageSeconds !== null && ageSeconds <= maximumAgeSeconds;
}

export function requireRecentAuthentication(
  auth: AuthDataLike | null | undefined,
  actionLabel: string,
  maximumAgeSeconds = RECENT_AUTHENTICATION_WINDOW_SECONDS,
): void {
  requireAuthenticatedUserId(auth, actionLabel);

  if (!hasRecentAuthentication(auth, maximumAgeSeconds)) {
    throw new HttpsError(
      'failed-precondition',
      `For your security, enter your current password again before you ${actionLabel}.`,
      {
        reason: 'recent-authentication-required',
        maximumAgeSeconds,
      },
    );
  }
}

export function requireVerifiedRecentAuthentication(
  auth: AuthDataLike | null | undefined,
  actionLabel: string,
  maximumAgeSeconds = RECENT_AUTHENTICATION_WINDOW_SECONDS,
): void {
  requireVerifiedEmail(auth, actionLabel);
  requireRecentAuthentication(auth, actionLabel, maximumAgeSeconds);
}
