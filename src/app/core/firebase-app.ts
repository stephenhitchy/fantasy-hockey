import { getApp, getApps, initializeApp } from 'firebase/app';

import { firebaseConfig } from '../../environments/firebase-config';

// Reuse the initialized app during tests and hot reloads. Runtime modules must
// still be imported only after main.ts has initialized App Check.
export const firebaseApp = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

export default firebaseApp;
