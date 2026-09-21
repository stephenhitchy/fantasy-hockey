import { connectAuthEmulator, getAuth } from 'firebase/auth';

import { D1N_LOCAL_EMULATOR_CONFIG } from '../../environments/d1n-local-emulator.config';
import { firebaseApp } from './firebase-app';

// This is the single browser Auth instance. Emulator routing is enabled only
// through the loopback-only, session-bounded D1N runtime configuration.
export const auth = getAuth(firebaseApp);

if (D1N_LOCAL_EMULATOR_CONFIG.enabled) {
  connectAuthEmulator(
    auth,
    `http://${D1N_LOCAL_EMULATOR_CONFIG.hostname}:${D1N_LOCAL_EMULATOR_CONFIG.authPort}`,
    { disableWarnings: true },
  );
}
