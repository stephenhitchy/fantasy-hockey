import type { FirebaseOptions } from 'firebase/app';

import { D1N_LOCAL_EMULATOR_CONFIG } from './d1n-local-emulator.config';

// Firebase web configuration for RinkRat Fantasy.
// Use the same-origin custom auth helper on the production domain, while
// retaining the Firebase default during localhost and legacy-host testing.
function resolveAuthDomain(): string {
  if (typeof window !== 'undefined') {
    const host = window.location.hostname.toLowerCase();

    if (host === 'rinkratfantasy.com' || host === 'www.rinkratfantasy.com') {
      return 'rinkratfantasy.com';
    }
  }

  return 'nhl-fantasy-app-ab673.firebaseapp.com';
}

const productionFirebaseConfig: FirebaseOptions = {
  apiKey: "AIzaSyA_84Xy_ieTc-R0oBd_yALcoGLUKt_USsY",
  authDomain: resolveAuthDomain(),
  projectId: "nhl-fantasy-app-ab673",
  storageBucket: "nhl-fantasy-app-ab673.firebasestorage.app",
  messagingSenderId: "721213878690",
  appId: "1:721213878690:web:1c5ba29562b332f84e02fb",
  measurementId: "G-063BT3987X"
};

const d1nLocalFirebaseConfig: FirebaseOptions = {
  apiKey: 'demo-api-key',
  authDomain: `${D1N_LOCAL_EMULATOR_CONFIG.projectId}.firebaseapp.com`,
  projectId: D1N_LOCAL_EMULATOR_CONFIG.projectId,
  storageBucket: `${D1N_LOCAL_EMULATOR_CONFIG.projectId}.appspot.com`,
  messagingSenderId: '000000000000',
  appId: '1:000000000000:web:d1ncapacityevidence',
  measurementId: 'G-D1NLOCAL',
};

export const firebaseConfig = D1N_LOCAL_EMULATOR_CONFIG.enabled
  ? d1nLocalFirebaseConfig
  : productionFirebaseConfig;
