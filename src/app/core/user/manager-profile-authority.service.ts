import { httpsCallable } from 'firebase/functions';

import { functions } from '../firebase-functions';
import type { TeamIdentityUnlockRequirement } from '../../shared/pixel-theme/pixel-theme.data';
import type { HockeyExperienceLevel } from '../../shared/hockey-terms/hockey-terms.data';

export interface InitializeManagerProfileInput {
  username: string;
  favoriteTeamAbbreviation: string;
  favoriteTeamVariantId: string;
  hockeyExperience: HockeyExperienceLevel;
}

export interface SaveManagerIdentityInput {
  favoriteTeamAbbreviation: string;
  favoriteTeamVariantId: string;
}

export interface SaveManagerAccountSettingsInput extends SaveManagerIdentityInput {
  username: string;
  teamIdentityUnlocks: TeamIdentityUnlockRequirement[];
  reducedMotion: boolean;
  defaultLandingPage: 'dashboard' | 'lastLeague';
  backgroundTheme: 'rink-dark' | 'oled-black' | 'ice-gray' | 'light-ice';
  injuryEmailEnabled: boolean;
  hockeyExperience: HockeyExperienceLevel;
}

type SaveManagerProfileAction = 'initialize' | 'identity' | 'settings';

interface SaveManagerProfileRequest {
  action: SaveManagerProfileAction;
  username?: string;
  favoriteTeamAbbreviation: string;
  favoriteTeamVariantId: string;
  teamIdentityUnlocks?: TeamIdentityUnlockRequirement[];
  reducedMotion?: boolean;
  defaultLandingPage?: 'dashboard' | 'lastLeague';
  backgroundTheme?: 'rink-dark' | 'oled-black' | 'ice-gray' | 'light-ice';
  injuryEmailEnabled?: boolean;
  hockeyExperience?: HockeyExperienceLevel;
}

interface SaveManagerProfileResponse {
  saved: true;
  action: SaveManagerProfileAction;
  favoriteTeamAbbreviation: string;
  favoriteTeamVariantId: string;
}

const saveManagerProfileCallable = httpsCallable<
  SaveManagerProfileRequest,
  SaveManagerProfileResponse
>(functions, 'saveManagerProfile', { timeout: 35_000 });

async function saveManagerProfile(
  request: SaveManagerProfileRequest,
): Promise<SaveManagerProfileResponse> {
  const response = await saveManagerProfileCallable(request);
  return response.data;
}

export async function initializeManagerProfile(
  input: InitializeManagerProfileInput,
): Promise<void> {
  await saveManagerProfile({
    action: 'initialize',
    ...input,
  });
}

export async function saveManagerIdentity(
  input: SaveManagerIdentityInput,
): Promise<void> {
  await saveManagerProfile({
    action: 'identity',
    ...input,
  });
}

export async function saveManagerAccountSettings(
  input: SaveManagerAccountSettingsInput,
): Promise<void> {
  await saveManagerProfile({
    action: 'settings',
    ...input,
  });
}
