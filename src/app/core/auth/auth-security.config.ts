/**
 * Browser-facing authentication requirements.
 *
 * Firebase Authentication remains the final authority. These values keep the
 * client instructions aligned with the production password policy and with
 * the server-side recent-authentication gate used for destructive/admin work.
 */
export const MINIMUM_PASSWORD_LENGTH = 12;
export const MAXIMUM_PASSWORD_LENGTH = 128;
export const RECENT_AUTHENTICATION_WINDOW_SECONDS = 15 * 60;

export function passwordMeetsRegistrationPolicy(password: string): boolean {
  return (
    password.length >= MINIMUM_PASSWORD_LENGTH &&
    password.length <= MAXIMUM_PASSWORD_LENGTH
  );
}

export function passwordRequirementSummary(): string {
  return `Use ${MINIMUM_PASSWORD_LENGTH}–${MAXIMUM_PASSWORD_LENGTH} characters. A memorable passphrase is recommended.`;
}
