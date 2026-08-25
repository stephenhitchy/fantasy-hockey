import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { db } from './shared/core/firebase';
import { TRUSTED_WEB_ORIGINS } from './web-security';
import { requireFirestoreDocumentId } from './shared/security/firestore-document-id.util';

const FUNCTION_REGION = 'us-central1';

const SUPPORTED_TEAM_ABBREVIATIONS = new Set([
  'RR',
  'ANA', 'BOS', 'BUF', 'CGY', 'CAR', 'CHI', 'COL', 'CBJ',
  'DAL', 'DET', 'EDM', 'FLA', 'LAK', 'MIN', 'MTL', 'NSH',
  'NJD', 'NYI', 'NYR', 'OTT', 'PHI', 'PIT', 'SEA', 'SJS',
  'STL', 'TBL', 'TOR', 'UTA', 'VAN', 'VGK', 'WSH', 'WPG',
]);

const SUPPORTED_HOCKEY_EXPERIENCE_LEVELS = new Set([
  'new',
  'basic',
  'experienced',
]);

const SUPPORTED_TEAM_IDENTITY_UNLOCKS = new Set([
  'first-line-change',
  'commissioner-mode',
  'league-explorer',
  'crowded-schedule',
  'identity-architect',
]);

const SUPPORTED_DEFAULT_LANDING_PAGES = new Set([
  'dashboard',
  'lastLeague',
]);

const SUPPORTED_BACKGROUND_THEMES = new Set([
  'rink-dark',
  'oled-black',
  'ice-gray',
  'light-ice',
]);

export type ManagerProfileAction = 'initialize' | 'identity' | 'settings';

interface SaveManagerProfileRequest {
  action?: unknown;
  username?: unknown;
  favoriteTeamAbbreviation?: unknown;
  favoriteTeamVariantId?: unknown;
  teamIdentityUnlocks?: unknown;
  reducedMotion?: unknown;
  defaultLandingPage?: unknown;
  backgroundTheme?: unknown;
  injuryEmailEnabled?: unknown;
  hockeyExperience?: unknown;
}

interface SaveManagerProfileResult {
  saved: true;
  action: ManagerProfileAction;
  favoriteTeamAbbreviation: string;
  favoriteTeamVariantId: string;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function requireAuthenticatedUser(
  auth: { uid?: string; token?: { email?: unknown } } | undefined,
): { userId: string; email: string } {
  const userId = asString(auth?.uid);
  const email = asString(auth?.token?.email).toLowerCase();

  if (!userId) {
    throw new HttpsError('unauthenticated', 'You must be signed in to save your manager profile.');
  }

  if (!email) {
    throw new HttpsError(
      'failed-precondition',
      'Your signed-in account does not have an email address.',
    );
  }

  return {
    userId: requireFirestoreDocumentId(userId, 'manager ID', { maxBytes: 128 }),
    email,
  };
}

function requireAction(value: unknown): ManagerProfileAction {
  const action = asString(value) as ManagerProfileAction;

  if (action === 'initialize' || action === 'identity' || action === 'settings') {
    return action;
  }

  throw new HttpsError('invalid-argument', 'That manager-profile action is not supported.');
}

function requireUsername(value: unknown): string {
  const username = asString(value);

  if (username.length < 1 || username.length > 40) {
    throw new HttpsError(
      'invalid-argument',
      'Your manager display name must be between 1 and 40 characters.',
    );
  }

  return username;
}

function requireFavoriteTeamAbbreviation(value: unknown): string {
  const abbreviation = asString(value).toUpperCase();

  if (!SUPPORTED_TEAM_ABBREVIATIONS.has(abbreviation)) {
    throw new HttpsError(
      'invalid-argument',
      'Choose a supported NHL team or the neutral RinkRat color scheme.',
    );
  }

  return abbreviation;
}

function requireFavoriteTeamVariantId(value: unknown): string {
  const variantId = asString(value);

  if (variantId.length < 1 || variantId.length > 80) {
    throw new HttpsError('invalid-argument', 'Choose a valid team color and logo version.');
  }

  if (variantId.startsWith('custom-identity') &&
      !/^custom-identity~[a-z0-9-]{1,40}~[0-9A-F]{6}~[0-9A-F]{6}~[0-9A-F]{6}$/.test(variantId)) {
    throw new HttpsError('invalid-argument', 'Choose a valid custom logo and three-color palette.');
  }

  return variantId;
}

function requiresIdentityArchitectUnlock(variantId: string): boolean {
  return variantId.startsWith('custom-identity~');
}

function requireHockeyExperience(value: unknown): string {
  const hockeyExperience = asString(value);

  if (!SUPPORTED_HOCKEY_EXPERIENCE_LEVELS.has(hockeyExperience)) {
    throw new HttpsError('invalid-argument', 'Choose a supported hockey familiarity level.');
  }

  return hockeyExperience;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new HttpsError('invalid-argument', `${label} must be turned on or off.`);
  }

  return value;
}

function requireSupportedString(
  value: unknown,
  supportedValues: ReadonlySet<string>,
  message: string,
): string {
  const normalized = asString(value);

  if (!supportedValues.has(normalized)) {
    throw new HttpsError('invalid-argument', message);
  }

  return normalized;
}

function requireTeamIdentityUnlocks(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 5) {
    throw new HttpsError('invalid-argument', 'Your team identity unlock list is invalid.');
  }

  const unlocks = value.map(asString).filter(Boolean);

  if (
    unlocks.length !== value.length ||
    new Set(unlocks).size !== unlocks.length ||
    unlocks.some((unlock) => !SUPPORTED_TEAM_IDENTITY_UNLOCKS.has(unlock))
  ) {
    throw new HttpsError('invalid-argument', 'Your team identity unlock list is invalid.');
  }

  return unlocks;
}

export const saveManagerProfile = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 30,
    memory: '256MiB',
    maxInstances: 40,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<SaveManagerProfileResult> => {
    const { userId, email } = requireAuthenticatedUser(request.auth);
    const input = request.data && typeof request.data === 'object'
      ? request.data as SaveManagerProfileRequest
      : {};
    const action = requireAction(input.action);
    const favoriteTeamAbbreviation = requireFavoriteTeamAbbreviation(
      input.favoriteTeamAbbreviation,
    );
    const favoriteTeamVariantId = requireFavoriteTeamVariantId(
      input.favoriteTeamVariantId,
    );

    if (
      requiresIdentityArchitectUnlock(favoriteTeamVariantId) &&
      favoriteTeamAbbreviation === 'RR'
    ) {
      throw new HttpsError(
        'invalid-argument',
        'Choose an NHL favorite before saving a custom team identity.',
      );
    }

    if (action === 'initialize' && requiresIdentityArchitectUnlock(favoriteTeamVariantId)) {
      throw new HttpsError(
        'permission-denied',
        'Complete the Identity Architect challenge before saving a custom team identity.',
      );
    }

    const userRef = db.doc(`users/${userId}`);
    const publicProfileRef = db.doc(`publicProfiles/${userId}`);

    await db.runTransaction(async (transaction) => {
      const userSnapshot = await transaction.get(userRef);
      const existingData = userSnapshot.exists ? userSnapshot.data() ?? {} : {};

      if (!userSnapshot.exists && action !== 'initialize') {
        throw new HttpsError(
          'failed-precondition',
          'Your manager profile is missing. Sign out and create the profile again.',
        );
      }

      if (action === 'initialize') {
        const username = requireUsername(input.username);
        const hockeyExperience = requireHockeyExperience(input.hockeyExperience);
        const timestamp = FieldValue.serverTimestamp();

        transaction.set(
          userRef,
          {
            uid: userId,
            email,
            username,
            favoriteTeamAbbreviation,
            favoriteTeamVariantId,
            hockeyExperience,
            ...(userSnapshot.exists
              ? {}
              : {
                  createdAt: timestamp,
                  teamIdentityUnlocks: [],
                  reducedMotion: false,
                  defaultLandingPage: 'dashboard',
                  backgroundTheme: 'rink-dark',
                  injuryEmailEnabled: false,
                  trainingCampVersion: 0,
                  trainingCampDeferredVersion: 0,
                }),
          },
          { merge: true },
        );

        transaction.set(
          publicProfileRef,
          {
            uid: userId,
            username,
            favoriteTeamAbbreviation,
            favoriteTeamVariantId,
            updatedAt: timestamp,
          },
          { merge: true },
        );

        return;
      }

      const timestamp = FieldValue.serverTimestamp();

      if (action === 'identity') {
        const existingUsername = requireUsername(existingData['username']);
        const existingUnlocks = requireTeamIdentityUnlocks(
          existingData['teamIdentityUnlocks'] ?? [],
        );

        if (
          requiresIdentityArchitectUnlock(favoriteTeamVariantId) &&
          !existingUnlocks.includes('identity-architect')
        ) {
          throw new HttpsError(
            'permission-denied',
            'Complete the Identity Architect challenge before saving a custom team identity.',
          );
        }

        transaction.set(
          userRef,
          {
            favoriteTeamAbbreviation,
            favoriteTeamVariantId,
          },
          { merge: true },
        );

        transaction.set(
          publicProfileRef,
          {
            uid: userId,
            username: existingUsername,
            favoriteTeamAbbreviation,
            favoriteTeamVariantId,
            updatedAt: timestamp,
          },
          { merge: true },
        );

        return;
      }

      const username = requireUsername(input.username);
      const teamIdentityUnlocks = requireTeamIdentityUnlocks(
        existingData['teamIdentityUnlocks'] ?? [],
      );

      if (
        requiresIdentityArchitectUnlock(favoriteTeamVariantId) &&
        !teamIdentityUnlocks.includes('identity-architect')
      ) {
        throw new HttpsError(
          'permission-denied',
          'Complete the Identity Architect challenge before saving a custom team identity.',
        );
      }

      const reducedMotion = requireBoolean(input.reducedMotion, 'Reduced motion');
      const defaultLandingPage = requireSupportedString(
        input.defaultLandingPage,
        SUPPORTED_DEFAULT_LANDING_PAGES,
        'Choose a supported page to open after login.',
      );
      const backgroundTheme = requireSupportedString(
        input.backgroundTheme,
        SUPPORTED_BACKGROUND_THEMES,
        'Choose a supported arena background.',
      );
      const injuryEmailEnabled = requireBoolean(
        input.injuryEmailEnabled,
        'Injury email alerts',
      );
      const hockeyExperience = requireHockeyExperience(input.hockeyExperience);

      transaction.set(
        userRef,
        {
          username,
          favoriteTeamAbbreviation,
          favoriteTeamVariantId,
          teamIdentityUnlocks,
          reducedMotion,
          defaultLandingPage,
          backgroundTheme,
          injuryEmailEnabled,
          hockeyExperience,
        },
        { merge: true },
      );

      transaction.set(
        publicProfileRef,
        {
          uid: userId,
          username,
          favoriteTeamAbbreviation,
          favoriteTeamVariantId,
          updatedAt: timestamp,
        },
        { merge: true },
      );
    });

    return {
      saved: true,
      action,
      favoriteTeamAbbreviation,
      favoriteTeamVariantId,
    };
  },
);
