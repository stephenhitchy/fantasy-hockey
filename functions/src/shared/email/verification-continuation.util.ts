const LEAGUE_INVITE_CODE_PATTERN = /^[A-Z0-9]{6}$/;

function readVerificationActionUrl(value: string): URL {
  let actionUrl: URL;

  try {
    actionUrl = new URL(value);
  } catch {
    throw new Error('Firebase returned an invalid email-verification link.');
  }

  // Firebase may return either the action URL directly or a link-domain URL
  // that wraps the action URL in a `link` query parameter.
  for (let depth = 0; depth < 2; depth += 1) {
    const nestedLink = actionUrl.searchParams.get('link');

    if (!nestedLink) {
      break;
    }

    try {
      actionUrl = new URL(nestedLink);
    } catch {
      break;
    }
  }

  return actionUrl;
}

export function normalizeVerificationInviteCode(value: unknown): string {
  const inviteCode = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return LEAGUE_INVITE_CODE_PATTERN.test(inviteCode) ? inviteCode : '';
}

/**
 * Converts Firebase's hosted action URL into RinkRat's own action handler.
 * Only the one-time verification code is carried forward; the generated
 * Firebase URL is never nested in another query string or persisted.
 */
export function buildVerificationContinuationUrl(input: {
  appBaseUrl: string;
  firebaseVerificationLink: string;
  inviteCode?: unknown;
}): string {
  const appBaseUrl = input.appBaseUrl.trim().replace(/\/+$/, '');
  const actionUrl = readVerificationActionUrl(input.firebaseVerificationLink);
  const mode = actionUrl.searchParams.get('mode');
  const oobCode = actionUrl.searchParams.get('oobCode')?.trim() ?? '';

  if (mode !== 'verifyEmail' || !oobCode || oobCode.length > 2_048) {
    throw new Error('Firebase returned an incomplete email-verification link.');
  }

  const continuationUrl = new URL(`${appBaseUrl}/verify-email`);
  continuationUrl.searchParams.set('mode', 'verifyEmail');
  continuationUrl.searchParams.set('oobCode', oobCode);

  const inviteCode = normalizeVerificationInviteCode(input.inviteCode);

  if (inviteCode) {
    continuationUrl.searchParams.set('invite', inviteCode);
  }

  return continuationUrl.toString();
}
