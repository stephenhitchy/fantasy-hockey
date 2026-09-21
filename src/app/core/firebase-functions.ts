import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';

import { D1N_LOCAL_EMULATOR_CONFIG } from '../../environments/d1n-local-emulator.config';
import { firebaseApp } from './firebase-app';

// All callable adapters share one regional instance so emulator and Production
// traffic cannot diverge between feature services.
export const functions = getFunctions(firebaseApp, 'us-central1');

if (D1N_LOCAL_EMULATOR_CONFIG.enabled) {
  connectFunctionsEmulator(
    functions,
    D1N_LOCAL_EMULATOR_CONFIG.hostname,
    D1N_LOCAL_EMULATOR_CONFIG.functionsPort,
  );
}
