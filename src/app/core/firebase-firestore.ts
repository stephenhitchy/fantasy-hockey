import { initializeFirestore } from 'firebase/firestore';

import { firebaseApp } from './firebase-app';

/**
 * Firestore normally uses a long-lived WebChannel stream for realtime data.
 * Some mobile networks, privacy relays, content filters, and Safari network
 * transitions can interrupt that stream with an "access control checks"
 * message. This project deliberately uses long polling so those connections
 * do not depend on one continuously open response.
 */
export const db = initializeFirestore(firebaseApp, {
  // Safari and some mobile/privacy networks can interrupt Firestore's normal
  // streaming WebChannel with an "access control checks" error. Force the
  // fallback transport so each response closes cleanly instead of depending
  // on a long-lived stream that the network may buffer or terminate.
  experimentalForceLongPolling: true,
  experimentalLongPollingOptions: {
    timeoutSeconds: 15,
  },
});
