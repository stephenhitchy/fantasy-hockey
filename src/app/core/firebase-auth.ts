import { connectAuthEmulator, getAuth } from 'firebase/auth';

import { D1N_LOCAL_EMULATOR_CONFIG } from '../../environments/d1n-local-emulator.config';
import { firebaseApp } from './firebase-app';

// This is the single browser Auth instance. Firebase's browser getAuth()
// default prefers durable IndexedDB, then durable localStorage, and falls back
// to sessionStorage only when neither durable store is available. Keep that
// tested SDK default instead of installing a session-only override. Emulator
// routing remains limited to the loopback-only D1N runtime configuration.
export const auth = getAuth(firebaseApp);

if (D1N_LOCAL_EMULATOR_CONFIG.enabled) {
  connectAuthEmulator(
    auth,
    `http://${D1N_LOCAL_EMULATOR_CONFIG.hostname}:${D1N_LOCAL_EMULATOR_CONFIG.authPort}`,
    { disableWarnings: true },
  );
}
