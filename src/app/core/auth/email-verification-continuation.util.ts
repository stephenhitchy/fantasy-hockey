import { isValidLeagueInviteCode, normalizeLeagueInviteCode } from '../league/invite-link-intent.service';

export function normalizeEmailVerificationCode(value: unknown): string {
  const code = typeof value === 'string' ? value.trim() : '';
  return code.length > 0 && code.length <= 2_048 ? code : '';
}

export function normalizeEmailVerificationInvite(value: unknown): string {
  const inviteCode = normalizeLeagueInviteCode(value);
  return isValidLeagueInviteCode(inviteCode) ? inviteCode : '';
}

export function verificationEmailMatchesSession(
  actionEmail: unknown,
  sessionEmail: unknown,
): boolean {
  const normalizedActionEmail = typeof actionEmail === 'string'
    ? actionEmail.trim().toLowerCase()
    : '';
  const normalizedSessionEmail = typeof sessionEmail === 'string'
    ? sessionEmail.trim().toLowerCase()
    : '';

  return Boolean(
    normalizedActionEmail &&
    normalizedSessionEmail &&
    normalizedActionEmail === normalizedSessionEmail,
  );
}
