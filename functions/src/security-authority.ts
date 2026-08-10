import { getAuth, type ProjectConfig } from 'firebase-admin/auth';
import { logger } from 'firebase-functions';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import {
  authenticationAgeSeconds,
  hasRecentAuthentication,
  RECENT_AUTHENTICATION_WINDOW_SECONDS,
  requireAuthenticatedUserId,
} from './shared/security/auth-security.util';
import { db } from './shared/core/firebase';
import { TRUSTED_WEB_ORIGINS } from './web-security';

const FUNCTION_REGION = 'us-central1';
const PROJECT_CONFIG_CACHE_MILLISECONDS = 5 * 60 * 1_000;

let cachedProjectConfig: {
  value: ProjectConfig;
  expiresAt: number;
} | null = null;

async function requirePlatformAdministrator(
  auth: { uid?: string; token?: Record<string, unknown> } | null | undefined,
): Promise<string> {
  const userId = requireAuthenticatedUserId(auth, 'review Firebase security readiness');

  if (auth?.token?.['platformAdmin'] === true) {
    return userId;
  }

  const adminSnapshot = await db.doc(`platformAdmins/${userId}`).get();

  if (!adminSnapshot.exists || adminSnapshot.data()?.['enabled'] !== true) {
    throw new HttpsError(
      'permission-denied',
      'This account does not have RinkRat platform-administrator access.',
    );
  }

  return userId;
}

async function getCachedProjectConfig(): Promise<ProjectConfig> {
  const now = Date.now();

  if (cachedProjectConfig && cachedProjectConfig.expiresAt > now) {
    return cachedProjectConfig.value;
  }

  const value = await getAuth().projectConfigManager().getProjectConfig();
  cachedProjectConfig = {
    value,
    expiresAt: now + PROJECT_CONFIG_CACHE_MILLISECONDS,
  };
  return value;
}

export interface SecurityControlReadinessResult {
  generatedAt: string;
  appCheckRequestStatus: 'valid' | 'missing';
  appCheckAppId: string | null;
  emailVerified: boolean;
  authenticationAgeSeconds: number | null;
  recentAuthenticationReady: boolean;
  recentAuthenticationWindowSeconds: number;
  passwordPolicy: {
    available: boolean;
    enforcementState: string;
    forceUpgradeOnSignin: boolean;
    minimumLength: number | null;
    maximumLength: number | null;
    requireLowercase: boolean;
    requireUppercase: boolean;
    requireNumeric: boolean;
    requireNonAlphanumeric: boolean;
  };
  emailEnumerationProtection: {
    available: boolean;
    enabled: boolean;
  };
  multiFactor: {
    available: boolean;
    state: string;
    factorIds: string[];
    providerCount: number;
  };
  configurationError: string | null;
}

export const getSecurityControlReadiness = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 30,
    memory: '256MiB',
    maxInstances: 5,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<SecurityControlReadinessResult> => {
    const administratorId = await requirePlatformAdministrator(request.auth);

    let configurationError: string | null = null;
    let projectConfig: ProjectConfig | null = null;

    try {
      projectConfig = await getCachedProjectConfig();
    } catch (error: unknown) {
      configurationError = 'Firebase Authentication project configuration could not be inspected.';
      logger.error('Firebase Authentication security readiness could not load project configuration.', {
        administratorId,
        error,
      });
    }

    const passwordPolicy = projectConfig?.passwordPolicyConfig;
    const constraints = passwordPolicy?.constraints;
    const emailPrivacy = projectConfig?.emailPrivacyConfig;
    const multiFactor = projectConfig?.multiFactorConfig;
    const factorIds = (multiFactor?.factorIds ?? []).map((factorId) => String(factorId));
    const providerCount = multiFactor?.providerConfigs?.length ?? 0;

    return {
      generatedAt: new Date().toISOString(),
      appCheckRequestStatus: request.app ? 'valid' : 'missing',
      appCheckAppId: request.app?.appId ?? null,
      emailVerified: request.auth?.token?.['email_verified'] === true,
      authenticationAgeSeconds: authenticationAgeSeconds(request.auth),
      recentAuthenticationReady: hasRecentAuthentication(request.auth),
      recentAuthenticationWindowSeconds: RECENT_AUTHENTICATION_WINDOW_SECONDS,
      passwordPolicy: {
        available: Boolean(passwordPolicy),
        enforcementState: String(passwordPolicy?.enforcementState ?? 'OFF'),
        forceUpgradeOnSignin: passwordPolicy?.forceUpgradeOnSignin === true,
        minimumLength: constraints?.minLength ?? null,
        maximumLength: constraints?.maxLength ?? null,
        requireLowercase: constraints?.requireLowercase === true,
        requireUppercase: constraints?.requireUppercase === true,
        requireNumeric: constraints?.requireNumeric === true,
        requireNonAlphanumeric: constraints?.requireNonAlphanumeric === true,
      },
      emailEnumerationProtection: {
        available: Boolean(emailPrivacy),
        enabled: emailPrivacy?.enableImprovedEmailPrivacy === true,
      },
      multiFactor: {
        available: Boolean(multiFactor),
        state: String(multiFactor?.state ?? 'DISABLED'),
        factorIds,
        providerCount,
      },
      configurationError,
    };
  },
);
