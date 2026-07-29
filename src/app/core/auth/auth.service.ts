import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  User,
} from 'firebase/auth';

import { auth } from '../firebase-auth';
import {
  AuthSessionTimeoutError,
  stabilizeSignedInSession,
  withTimeout,
} from './auth-session.service';

export async function registerUser(
  email: string,
  password: string,
  username: string,
  favoriteTeamAbbreviation: string,
): Promise<User> {
  const credential = await withTimeout(
    createUserWithEmailAndPassword(auth, email, password),
    20_000,
    'Account creation took too long. Check your connection and try again.',
  );
  const user = await stabilizeSignedInSession(credential.user);

  // Firestore is intentionally loaded only for registration. Normal sign-in
  // no longer downloads the full database SDK before the login screen renders.
  const [{ doc, setDoc }, { db }] = await Promise.all([
    import('firebase/firestore'),
    import('../firebase-firestore'),
  ]);

  await withTimeout(
    setDoc(doc(db, 'users', user.uid), {
      uid: user.uid,
      email: user.email,
      username,
      createdAt: new Date(),
      favoriteTeamAbbreviation,
      favoriteTeamVariantId: 'current-home',
      teamIdentityUnlocks: [],
      reducedMotion: false,
      defaultLandingPage: 'dashboard',
      backgroundTheme: 'rink-dark',
      injuryEmailEnabled: false,
      trainingCampVersion: 0,
    }),
    15_000,
    'Your login was created, but the manager profile took too long to save.',
  );

  return user;
}

export async function loginUser(email: string, password: string): Promise<User> {
  const signInPromise = signInWithEmailAndPassword(auth, email, password);
  try {
    const credential = await withTimeout(
      signInPromise,
      20_000,
      'Login took too long. RinkRat stopped waiting so this tab cannot stay frozen.',
    );

    return await stabilizeSignedInSession(credential.user);
  } catch (error: unknown) {
    if (error instanceof AuthSessionTimeoutError) {
      void signInPromise
        .then((credential) => {
          if (auth.currentUser?.uid === credential.user.uid) {
            return signOut(auth);
          }

          return undefined;
        })
        .catch(() => undefined);
    }

    throw error;
  }
}

export async function logoutUser(): Promise<void> {
  await signOut(auth);
}

export function listenToAuthState(callback: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth, callback);
}
