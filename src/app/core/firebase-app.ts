import { getApp, getApps, initializeApp } from 'firebase/app';

import { firebaseConfig } from '../../environments/firebase-config';

export const firebaseApp = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

export default firebaseApp;
