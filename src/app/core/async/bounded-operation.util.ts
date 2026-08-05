export interface FulfilledOperationSettlement<T> {
  status: 'fulfilled';
  value: T;
}

export interface RejectedOperationSettlement {
  status: 'rejected';
  error: unknown;
}

export interface TimedOutOperationSettlement {
  status: 'timed-out';
}

export type OperationSettlement<T> =
  | FulfilledOperationSettlement<T>
  | RejectedOperationSettlement
  | TimedOutOperationSettlement;

export class OperationDeadlineError extends Error {
  readonly code = 'operation-deadline';
  readonly operationMayStillComplete = true;

  constructor(message: string) {
    super(message);
    this.name = 'OperationDeadlineError';
  }
}

/**
 * Observes a promise for a bounded amount of time without producing an
 * unhandled rejection if the underlying Firebase request settles later.
 */
export function settleOperationWithin<T>(
  operation: Promise<T>,
  timeoutMilliseconds: number,
): Promise<OperationSettlement<T>> {
  return new Promise<OperationSettlement<T>>((resolve) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      resolve({ status: 'timed-out' });
    }, Math.max(0, timeoutMilliseconds));

    void operation.then(
      (value) => {
        if (settled) {
          return;
        }

        settled = true;
        globalThis.clearTimeout(timer);
        resolve({ status: 'fulfilled', value });
      },
      (error: unknown) => {
        if (settled) {
          return;
        }

        settled = true;
        globalThis.clearTimeout(timer);
        resolve({ status: 'rejected', error });
      },
    );
  });
}

/**
 * Releases a component's local pending state after a fixed deadline. This does
 * not pretend to cancel the underlying server work; callers must reconcile an
 * uncertain result against their authoritative Firestore document before
 * repeating the same competitive action.
 */
export async function withOperationDeadline<T>(
  operation: Promise<T>,
  timeoutMilliseconds: number,
  timeoutMessage: string,
): Promise<T> {
  const settlement = await settleOperationWithin(operation, timeoutMilliseconds);

  if (settlement.status === 'fulfilled') {
    return settlement.value;
  }

  if (settlement.status === 'rejected') {
    throw settlement.error;
  }

  throw new OperationDeadlineError(timeoutMessage);
}

export function waitForOperationDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, Math.max(0, milliseconds));
  });
}

export async function waitForOperationCondition(
  predicate: () => boolean,
  timeoutMilliseconds: number,
  pollMilliseconds = 120,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMilliseconds);

  while (Date.now() <= deadline) {
    if (predicate()) {
      return true;
    }

    await waitForOperationDelay(Math.max(16, pollMilliseconds));
  }

  return predicate();
}

export function isOperationDeadlineError(error: unknown): error is OperationDeadlineError {
  return (
    error instanceof OperationDeadlineError ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      String((error as { code?: unknown }).code) === 'operation-deadline')
  );
}
