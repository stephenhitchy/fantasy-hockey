import { getFunctions } from 'firebase/functions';

import { firebaseApp } from './firebase-app';

export const functions = getFunctions(firebaseApp, 'us-central1');
