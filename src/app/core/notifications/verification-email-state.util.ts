export function getVerificationCooldownSeconds(
  nextAllowedAtMillis: number,
  nowMillis: number = Date.now(),
): number {
  if (!Number.isFinite(nextAllowedAtMillis) || nextAllowedAtMillis <= nowMillis) {
    return 0;
  }

  return Math.max(0, Math.ceil((nextAllowedAtMillis - nowMillis) / 1_000));
}

export function formatVerificationCooldown(seconds: number): string {
  const safeSeconds = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;

  return minutes > 0
    ? `${minutes}:${remainder.toString().padStart(2, '0')}`
    : `${remainder}s`;
}

export function getVerificationSendButtonLabel(options: {
  sending: boolean;
  emailPreviouslySent: boolean;
  cooldownSeconds: number;
}): string {
  if (options.sending) {
    return 'Sending...';
  }

  if (options.cooldownSeconds > 0) {
    return `Send another in ${formatVerificationCooldown(options.cooldownSeconds)}`;
  }

  return options.emailPreviouslySent
    ? 'Send another verification email'
    : 'Send verification email';
}
