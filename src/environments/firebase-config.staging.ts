import type { FirebaseOptions } from 'firebase/app';

/**
 * Compile-time Firebase configuration for the isolated D1N staging build.
 *
 * This file is replaced only by Angular's `staging` configuration. Keeping
 * the project identity literal and separate prevents a staging artifact from
 * silently connecting to Production.
 */
export const firebaseConfig: FirebaseOptions = {
  apiKey: 'AIzaSyDejIpv-Pi1iDcuKSgDyVK_5h2s9kZ05sY',
  authDomain: 'rinkrat-staging-d1nc-2026.firebaseapp.com',
  projectId: 'rinkrat-staging-d1nc-2026',
  storageBucket: 'rinkrat-staging-d1nc-2026.firebasestorage.app',
  messagingSenderId: '817415114086',
  appId: '1:817415114086:web:d8be39fcb0b05074b28ca7',
};
