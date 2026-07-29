import { terminate } from 'firebase/firestore';
import { onAuthStateChanged, signOut, updateCurrentUser, User } from 'firebase/auth';

import { auth } from '../firebase-auth';
import { db } from '../firebase-firestore';

export class AuthSessionTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthSessionTimeoutError';
  }
}

export function withTimeout<T>(
  operation: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new AuthSessionTimeoutError(message));
    }, milliseconds);
  });

  return Promise.race([operation, timeout]).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  });
}

export function waitForAuthState(
  expectedUid?: string,
  timeoutMilliseconds = 10_000,
): Promise<User | null> {
  const current = auth.currentUser;

  if (current && (!expectedUid || current.uid === expectedUid)) {
    return Promise.resolve(current);
  }

  return withTimeout(
    new Promise<User | null>((resolve) => {
      const unsubscribe = onAuthStateChanged(auth, (user) => {
        if (expectedUid && user && user.uid !== expectedUid) {
          return;
        }

        unsubscribe();
        resolve(user);
      });
    }),
    timeoutMilliseconds,
    'The browser took too long to finish restoring the account session.',
  ).catch((error: unknown) => {
    if (error instanceof AuthSessionTimeoutError) {
      return null;
    }

    throw error;
  });
}

export async function stabilizeSignedInSession(user: User): Promise<User> {
  await withTimeout(
    user.getIdToken(true),
    12_000,
    'RinkRat signed you in, but the fresh account session took too long to finish.',
  );

  const observedUser = await waitForAuthState(user.uid, 8_000);

  if (!observedUser || observedUser.uid !== user.uid) {
    throw new AuthSessionTimeoutError(
      'RinkRat could not confirm the new account session in this browser tab.',
    );
  }

  return observedUser;
}

export async function safelySignOutCurrentSession(): Promise<void> {
  try {
    await withTimeout(
      signOut(auth),
      6_000,
      'The previous account session took too long to close.',
    );
  } catch (error: unknown) {
    console.warn('RinkRat could not fully close the current Auth session.', error);

    try {
      await withTimeout(
        updateCurrentUser(auth, null),
        3_000,
        'The previous local Auth user took too long to clear.',
      );
    } catch (fallbackError: unknown) {
      console.warn('RinkRat could not clear the fallback local Auth user.', fallbackError);
    }
  }
}

export async function resetBrowserAfterAccountDeletion(): Promise<never> {
  await safelySignOutCurrentSession();

  try {
    await withTimeout(
      terminate(db),
      4_000,
      'The previous Firestore connection took too long to close.',
    );
  } catch (error: unknown) {
    console.warn('RinkRat could not terminate the previous Firestore client cleanly.', error);
  }

  try {
    localStorage.removeItem('rinkrat:lastLeagueId');
    localStorage.removeItem('rinkrat:userProfile');
    sessionStorage.clear();
  } catch {
    // Privacy modes may block storage. The hard page replacement below still
    // creates a new Angular, Auth, and Firestore runtime for the next login.
  }

  window.location.replace('/?sessionReset=deleted-account');

  // location.replace() never returns in a normal browser, but TypeScript needs
  // a terminal promise for callers that await this helper.
  return new Promise<never>(() => undefined);
}
