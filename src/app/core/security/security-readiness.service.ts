import { httpsCallable } from 'firebase/functions';

import {
  getRinkRatAppCheckState,
  type RinkRatAppCheckState,
  verifyRinkRatAppCheckToken,
} from '../firebase-app-check';
import { functions } from '../firebase-functions';

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

export interface SecurityReadinessSnapshot {
  available: boolean;
  clientAppCheck: RinkRatAppCheckState;
  server: SecurityControlReadinessResult | null;
  errorMessage: string;
}

function friendlySecurityReadinessError(error: unknown): string {
  const candidate = error as { code?: unknown; message?: unknown };
  const code = typeof candidate.code === 'string' ? candidate.code : '';

  if (code.includes('permission-denied')) {
    return 'Platform-administrator access is required to inspect Firebase security controls.';
  }

  if (code.includes('unauthenticated')) {
    return 'Sign in again before inspecting Firebase security controls.';
  }

  return typeof candidate.message === 'string' && candidate.message.trim()
    ? candidate.message.replace(/^Firebase:\s*/i, '').trim()
    : 'Firebase security controls could not be inspected.';
}

export async function loadSecurityReadinessSnapshot(): Promise<SecurityReadinessSnapshot> {
  await verifyRinkRatAppCheckToken(false);
  const clientAppCheck = getRinkRatAppCheckState();

  try {
    const callable = httpsCallable<Record<string, never>, SecurityControlReadinessResult>(
      functions,
      'getSecurityControlReadiness',
      { timeout: 35_000 },
    );
    const response = await callable({});

    return {
      available: true,
      clientAppCheck,
      server: response.data,
      errorMessage: response.data.configurationError ?? '',
    };
  } catch (error: unknown) {
    return {
      available: false,
      clientAppCheck,
      server: null,
      errorMessage: friendlySecurityReadinessError(error),
    };
  }
}
