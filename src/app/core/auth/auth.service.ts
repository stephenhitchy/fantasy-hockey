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
import type { HockeyExperienceLevel } from '../../shared/hockey-terms/hockey-terms.data';
import { RINKRAT_NEUTRAL_ABBREVIATION } from '../../shared/pixel-theme/pixel-theme.data';
import { initializeManagerProfile } from '../user/manager-profile-authority.service';

export async function registerUser(
  email: string,
  password: string,
  username: string,
  favoriteTeamAbbreviation: string,
  hockeyExperience: HockeyExperienceLevel,
): Promise<User> {
  const credential = await withTimeout(
    createUserWithEmailAndPassword(auth, email, password),
    20_000,
    'Account creation took too long. Check your connection and try again.',
  );
  const user = await stabilizeSignedInSession(credential.user);
  const normalizedFavoriteTeam =
    favoriteTeamAbbreviation || RINKRAT_NEUTRAL_ABBREVIATION;

  try {
    await withTimeout(
      initializeManagerProfile({
        username,
        favoriteTeamAbbreviation: normalizedFavoriteTeam,
        favoriteTeamVariantId: 'current-home',
        hockeyExperience,
      }),
      20_000,
      'Your login was created, but the manager profile took too long to save.',
    );
  } catch (error: unknown) {
    if (!shouldUseLegacyRegistrationWrite(error)) {
      throw error;
    }

    // A direct Firestore fallback keeps local emulators and staged deployments
    // usable when the profile-authority callable has not been deployed yet.
    const [{ doc, serverTimestamp, setDoc }, { db }] = await Promise.all([
      import('firebase/firestore'),
      import('../firebase-firestore'),
    ]);

    await withTimeout(
      setDoc(doc(db, 'users', user.uid), {
        uid: user.uid,
        email: user.email,
        username,
        createdAt: serverTimestamp(),
        favoriteTeamAbbreviation: normalizedFavoriteTeam,
        favoriteTeamVariantId: 'current-home',
        teamIdentityUnlocks: [],
        reducedMotion: false,
        defaultLandingPage: 'dashboard',
        backgroundTheme: 'rink-dark',
        injuryEmailEnabled: false,
        hockeyExperience,
        trainingCampVersion: 0,
      }),
      15_000,
      'Your login was created, but the manager profile took too long to save.',
    );

    try {
      await withTimeout(
        setDoc(doc(db, 'publicProfiles', user.uid), {
          uid: user.uid,
          username,
          favoriteTeamAbbreviation: normalizedFavoriteTeam,
          favoriteTeamVariantId: 'current-home',
          updatedAt: serverTimestamp(),
        }),
        8_000,
        'The public manager profile took too long to save.',
      );
    } catch (publicProfileError: unknown) {
      console.warn(
        'The account was created, but the public manager profile will be repaired after login.',
        publicProfileError,
      );
    }
  }

  return user;
}

function shouldUseLegacyRegistrationWrite(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';

  return code === 'functions/not-found' ||
    code === 'functions/unavailable' ||
    code === 'functions/unimplemented';
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
