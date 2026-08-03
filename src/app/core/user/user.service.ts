import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';

import { auth, db } from '../firebase';
import { functions } from '../firebase-functions';
import type { TeamIdentityUnlockRequirement } from '../../shared/pixel-theme/pixel-theme.data';
import type { HockeyExperienceLevel } from '../../shared/hockey-terms/hockey-terms.data';

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
  hockeyExperience?: HockeyExperienceLevel;
  trainingCampVersion?: number;
  trainingCampCompletedAt?: unknown;
  welcomeEmailSentAt?: unknown;
  lastVerificationEmailSentAt?: unknown;
}

export interface PublicUserProfile {
  uid: string;
  username: string;
  favoriteTeamAbbreviation: string;
  favoriteTeamVariantId: string;
  updatedAt?: unknown;
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
  hockeyExperience: HockeyExperienceLevel;
}

interface PublicManagerProfilesRequest {
  leagueId: string;
  userIds: string[];
}

interface PublicManagerProfilesResponse {
  profiles: PublicUserProfile[];
}

const PUBLIC_PROFILE_TEAM_ABBREVIATIONS = new Set([
  'RR',
  'ANA', 'BOS', 'BUF', 'CGY', 'CAR', 'CHI', 'COL', 'CBJ',
  'DAL', 'DET', 'EDM', 'FLA', 'LAK', 'MIN', 'MTL', 'NSH',
  'NJD', 'NYI', 'NYR', 'OTT', 'PHI', 'PIT', 'SEA', 'SJS',
  'STL', 'TBL', 'TOR', 'UTA', 'VAN', 'VGK', 'WSH', 'WPG',
]);

function normalizePublicProfile(
  uid: string,
  profile: Partial<UserProfile | PublicUserProfile>,
): PublicUserProfile {
  return {
    uid,
    username: typeof profile.username === 'string' && profile.username.trim()
      ? profile.username.trim()
      : 'Unknown Manager',
    favoriteTeamAbbreviation: (() => {
      const abbreviation = typeof profile.favoriteTeamAbbreviation === 'string'
        ? profile.favoriteTeamAbbreviation.trim().toUpperCase()
        : '';

      return PUBLIC_PROFILE_TEAM_ABBREVIATIONS.has(abbreviation)
        ? abbreviation
        : 'RR';
    })(),
    favoriteTeamVariantId:
      typeof profile.favoriteTeamVariantId === 'string' &&
      profile.favoriteTeamVariantId.trim()
        ? profile.favoriteTeamVariantId.trim()
        : 'current-home',
    updatedAt: 'updatedAt' in profile ? profile.updatedAt : undefined,
  };
}

function getPublicProfileWrite(
  uid: string,
  profile: Partial<UserProfile | PublicUserProfile>,
): Omit<PublicUserProfile, 'updatedAt'> & { updatedAt: ReturnType<typeof serverTimestamp> } {
  const normalized = normalizePublicProfile(uid, profile);

  return {
    uid: normalized.uid,
    username: normalized.username,
    favoriteTeamAbbreviation: normalized.favoriteTeamAbbreviation,
    favoriteTeamVariantId: normalized.favoriteTeamVariantId,
    updatedAt: serverTimestamp(),
  };
}

async function ensureOwnPublicProfile(profile: UserProfile): Promise<void> {
  if (auth.currentUser?.uid !== profile.uid) {
    return;
  }

  const publicRef = doc(db, 'publicProfiles', profile.uid);
  const publicSnapshot = await getDoc(publicRef).catch(() => null);
  const existing = publicSnapshot?.exists()
    ? normalizePublicProfile(profile.uid, publicSnapshot.data() as PublicUserProfile)
    : null;
  const desired = normalizePublicProfile(profile.uid, profile);

  if (
    existing &&
    existing.username === desired.username &&
    existing.favoriteTeamAbbreviation === desired.favoriteTeamAbbreviation &&
    existing.favoriteTeamVariantId === desired.favoriteTeamVariantId
  ) {
    return;
  }

  await setDoc(publicRef, getPublicProfileWrite(profile.uid, profile));
}


async function loadPrivateProfileForPublicUpdate(uid: string): Promise<UserProfile> {
  const snapshot = await getDoc(doc(db, 'users', uid));

  if (!snapshot.exists()) {
    throw new Error('Your manager profile could not be found.');
  }

  return snapshot.data() as UserProfile;
}

export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  const userRef = doc(db, 'users', uid);
  const userSnap = await getDoc(userRef);

  if (!userSnap.exists()) {
    return null;
  }

  const profile = userSnap.data() as UserProfile;

  // Existing accounts are backfilled lazily after their first login. Failure
  // to write the public copy must never prevent the private account from loading.
  void ensureOwnPublicProfile(profile).catch((error: unknown) => {
    console.warn('Unable to synchronize the public manager profile.', error);
  });

  return profile;
}

export async function getPublicUserProfile(uid: string): Promise<PublicUserProfile | null> {
  const snapshot = await getDoc(doc(db, 'publicProfiles', uid));

  if (!snapshot.exists()) {
    return null;
  }

  return normalizePublicProfile(uid, snapshot.data() as PublicUserProfile);
}

export async function getPublicManagerProfilesForLeague(
  leagueId: string,
  userIds: string[],
): Promise<ReadonlyMap<string, PublicUserProfile>> {
  const uniqueUserIds = [...new Set(userIds.map((value) => value.trim()).filter(Boolean))];

  if (!leagueId.trim() || uniqueUserIds.length === 0) {
    return new Map();
  }

  const callable = httpsCallable<PublicManagerProfilesRequest, PublicManagerProfilesResponse>(
    functions,
    'getPublicManagerProfiles',
  );
  const response = await callable({ leagueId: leagueId.trim(), userIds: uniqueUserIds });
  const profiles = Array.isArray(response.data.profiles) ? response.data.profiles : [];
  const result = new Map<string, PublicUserProfile>();

  for (const profile of profiles) {
    if (!profile || typeof profile.uid !== 'string' || !profile.uid) {
      continue;
    }

    result.set(profile.uid, normalizePublicProfile(profile.uid, profile));
  }

  return result;
}

export async function updateUsername(uid: string, username: string): Promise<void> {
  const currentProfile = await loadPrivateProfileForPublicUpdate(uid);
  const userRef = doc(db, 'users', uid);
  const publicRef = doc(db, 'publicProfiles', uid);
  const batch = writeBatch(db);

  batch.update(userRef, { username });
  batch.set(publicRef, getPublicProfileWrite(uid, {
    ...currentProfile,
    username,
  }));

  await batch.commit();
}

export async function updateFavoriteTeam(
  uid: string,
  favoriteTeamAbbreviation: string,
  favoriteTeamVariantId: string,
): Promise<void> {
  const currentProfile = await loadPrivateProfileForPublicUpdate(uid);
  const userRef = doc(db, 'users', uid);
  const publicRef = doc(db, 'publicProfiles', uid);
  const batch = writeBatch(db);

  batch.update(userRef, {
    favoriteTeamAbbreviation,
    favoriteTeamVariantId,
  });
  batch.set(publicRef, getPublicProfileWrite(uid, {
    ...currentProfile,
    favoriteTeamAbbreviation,
    favoriteTeamVariantId,
  }));

  await batch.commit();
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
  const publicRef = doc(db, 'publicProfiles', uid);
  const batch = writeBatch(db);

  batch.update(userRef, {
    username: settings.username,
    favoriteTeamAbbreviation: settings.favoriteTeamAbbreviation,
    favoriteTeamVariantId: settings.favoriteTeamVariantId,
    teamIdentityUnlocks: settings.teamIdentityUnlocks,
    reducedMotion: settings.reducedMotion,
    defaultLandingPage: settings.defaultLandingPage,
    backgroundTheme: settings.backgroundTheme,
    injuryEmailEnabled: settings.injuryEmailEnabled,
    hockeyExperience: settings.hockeyExperience,
  });
  batch.set(publicRef, getPublicProfileWrite(uid, settings), { merge: true });

  await batch.commit();
}
