import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  User,
} from 'firebase/auth';

import { auth } from '../firebase-auth';

export async function registerUser(
  email: string,
  password: string,
  username: string,
  favoriteTeamAbbreviation: string,
): Promise<User> {
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  const user = credential.user;

  // Firestore is intentionally loaded only for registration. Normal sign-in
  // no longer downloads the full database SDK before the login screen renders.
  const [{ doc, setDoc }, { db }] = await Promise.all([
    import('firebase/firestore'),
    import('../firebase-firestore'),
  ]);

  await setDoc(doc(db, 'users', user.uid), {
    uid: user.uid,
    email: user.email,
    username,
    createdAt: new Date(),
    favoriteTeamAbbreviation,
    reducedMotion: false,
    defaultLandingPage: 'dashboard',
  });

  return user;
}

export async function loginUser(email: string, password: string): Promise<User> {
  const credential = await signInWithEmailAndPassword(auth, email, password);
  return credential.user;
}

export async function logoutUser(): Promise<void> {
  await signOut(auth);
}

export function listenToAuthState(callback: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth, callback);
}
