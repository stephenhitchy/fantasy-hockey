export const D1N_LOCAL_EMULATOR_PROJECT_ID = 'demo-rinkrat-d1n';
export const D1N_LOCAL_EMULATOR_QUERY_PARAMETER = 'd1nEmulator';

const D1N_LOCAL_EMULATOR_SESSION_KEY = 'rinkrat:d1n-local-emulator:v1';

export interface D1nLocalEmulatorModeInput {
  hostname: string;
  queryFlag: string | null;
  storedFlag: string | null;
}

export interface D1nLocalEmulatorConfig {
  enabled: boolean;
  projectId: typeof D1N_LOCAL_EMULATOR_PROJECT_ID;
  hostname: '127.0.0.1';
  authPort: 9099;
  firestorePort: 8080;
  functionsPort: 5001;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export function resolveD1nLocalEmulatorMode(input: D1nLocalEmulatorModeInput): boolean {
  if (!isLoopbackHostname(input.hostname)) {
    return false;
  }

  if (input.queryFlag === '0') {
    return false;
  }

  return input.queryFlag === '1' || input.storedFlag === '1';
}

function readBrowserMode(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  let queryFlag: string | null = null;
  let storedFlag: string | null = null;

  try {
    queryFlag = new URLSearchParams(window.location.search).get(
      D1N_LOCAL_EMULATOR_QUERY_PARAMETER,
    );
    storedFlag = window.sessionStorage.getItem(D1N_LOCAL_EMULATOR_SESSION_KEY);
  } catch {
    return false;
  }

  const enabled = resolveD1nLocalEmulatorMode({
    hostname: window.location.hostname,
    queryFlag,
    storedFlag,
  });

  try {
    if (queryFlag === '1' && enabled) {
      window.sessionStorage.setItem(D1N_LOCAL_EMULATOR_SESSION_KEY, '1');
    } else if (queryFlag === '0' || !isLoopbackHostname(window.location.hostname)) {
      window.sessionStorage.removeItem(D1N_LOCAL_EMULATOR_SESSION_KEY);
    }
  } catch {
    return false;
  }

  return enabled;
}

export const D1N_LOCAL_EMULATOR_CONFIG: Readonly<D1nLocalEmulatorConfig> = Object.freeze({
  enabled: readBrowserMode(),
  projectId: D1N_LOCAL_EMULATOR_PROJECT_ID,
  hostname: '127.0.0.1',
  authPort: 9099,
  firestorePort: 8080,
  functionsPort: 5001,
});
