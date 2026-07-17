import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';

export type DefaultLandingPage = 'dashboard' | 'lastLeague';

export interface UserProfile {
  uid: string;
  email: string;
  username: string;
  createdAt?: unknown;
  favoriteTeamAbbreviation?: string;
  reducedMotion?: boolean;
  defaultLandingPage?: DefaultLandingPage;
}

export interface UserAccountSettingsUpdate {
  username: string;
  favoriteTeamAbbreviation: string;
  reducedMotion: boolean;
  defaultLandingPage: DefaultLandingPage;
}

export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  const userRef = doc(db, 'users', uid);
  const userSnap = await getDoc(userRef);

  if (!userSnap.exists()) {
    return null;
  }

  return userSnap.data() as UserProfile;
}

export async function updateUsername(uid: string, username: string): Promise<void> {
  const userRef = doc(db, 'users', uid);

  await updateDoc(userRef, {
    username,
  });
}

export async function updateUserAccountSettings(
  uid: string,
  settings: UserAccountSettingsUpdate,
): Promise<void> {
  const userRef = doc(db, 'users', uid);

  await updateDoc(userRef, {
    username: settings.username,
    favoriteTeamAbbreviation: settings.favoriteTeamAbbreviation,
    reducedMotion: settings.reducedMotion,
    defaultLandingPage: settings.defaultLandingPage,
  });
}
