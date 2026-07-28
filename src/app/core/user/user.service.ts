import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import type { TeamIdentityUnlockRequirement } from '../../shared/pixel-theme/pixel-theme.data';

export type DefaultLandingPage = 'dashboard' | 'lastLeague';
export type BackgroundTheme = 'rink-dark' | 'oled-black' | 'ice-gray' | 'light-ice';

export interface UserProfile {
  uid: string;
  email: string;
  username: string;
  createdAt?: unknown;
  favoriteTeamAbbreviation?: string;
  favoriteTeamVariantId?: string;
  teamIdentityUnlocks?: TeamIdentityUnlockRequirement[];
  reducedMotion?: boolean;
  defaultLandingPage?: DefaultLandingPage;
  backgroundTheme?: BackgroundTheme;
  injuryEmailEnabled?: boolean;
  welcomeEmailSentAt?: unknown;
  lastVerificationEmailSentAt?: unknown;
}

export interface UserAccountSettingsUpdate {
  username: string;
  favoriteTeamAbbreviation: string;
  favoriteTeamVariantId: string;
  teamIdentityUnlocks: TeamIdentityUnlockRequirement[];
  reducedMotion: boolean;
  defaultLandingPage: DefaultLandingPage;
  backgroundTheme: BackgroundTheme;
  injuryEmailEnabled: boolean;
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

export async function updateFavoriteTeam(
  uid: string,
  favoriteTeamAbbreviation: string,
  favoriteTeamVariantId: string,
): Promise<void> {
  const userRef = doc(db, 'users', uid);

  await updateDoc(userRef, {
    favoriteTeamAbbreviation,
    favoriteTeamVariantId,
  });
}

export async function updateTeamIdentityUnlocks(
  uid: string,
  teamIdentityUnlocks: TeamIdentityUnlockRequirement[],
): Promise<void> {
  const userRef = doc(db, 'users', uid);

  await updateDoc(userRef, {
    teamIdentityUnlocks,
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
    favoriteTeamVariantId: settings.favoriteTeamVariantId,
    teamIdentityUnlocks: settings.teamIdentityUnlocks,
    reducedMotion: settings.reducedMotion,
    defaultLandingPage: settings.defaultLandingPage,
    backgroundTheme: settings.backgroundTheme,
    injuryEmailEnabled: settings.injuryEmailEnabled,
  });
}
