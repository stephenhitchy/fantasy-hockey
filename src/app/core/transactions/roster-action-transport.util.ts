const DEFINITIVE_ROSTER_ACTION_ERROR_CODES = new Set([
  'aborted',
  'already-exists',
  'failed-precondition',
  'invalid-argument',
  'not-found',
  'out-of-range',
  'permission-denied',
  'unauthenticated',
  'unimplemented',
]);

export const ROSTER_ACTION_CALLABLE_TIMEOUT_MS = 65_000;
export const ROSTER_ACTION_QUICK_RETRY_WINDOW_MS = 10_000;
export const ROSTER_ACTION_CONFIRMATION_WINDOW_MS =
  ROSTER_ACTION_CALLABLE_TIMEOUT_MS +
  ROSTER_ACTION_QUICK_RETRY_WINDOW_MS +
  7_000;

export function getRosterActionErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return '';
  }

  return String((error as { code?: unknown }).code ?? '')
    .trim()
    .toLowerCase()
    .replace(/^(functions|firestore|auth)\//, '');
}

/**
 * A transport-shaped failure may arrive after Cloud Functions committed. The
 * conservative default is therefore "possibly committed"; only explicit
 * authority/validation rejections are safe to surface without a long retry.
 */
export function isPossiblyCommittedRosterActionError(error: unknown): boolean {
  const code = getRosterActionErrorCode(error);
  return !DEFINITIVE_ROSTER_ACTION_ERROR_CODES.has(code);
}

/** One quick retry is safe only because the server binds it to submissionId. */
export async function executeIdempotentRosterActionWithQuickRetry<T>(
  action: () => Promise<T>,
  maximumFirstAttemptMilliseconds = ROSTER_ACTION_QUICK_RETRY_WINDOW_MS,
): Promise<T> {
  const startedAt = Date.now();

  try {
    return await action();
  } catch (error: unknown) {
    if (
      !isPossiblyCommittedRosterActionError(error) ||
      Date.now() - startedAt > maximumFirstAttemptMilliseconds
    ) {
      throw error;
    }

    return action();
  }
}
