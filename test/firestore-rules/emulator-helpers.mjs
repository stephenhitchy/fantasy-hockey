import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

import { deleteApp, initializeApp } from 'firebase/app';
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
} from 'firebase/auth';
import {
  connectFirestoreEmulator,
  getFirestore,
} from 'firebase/firestore';

export const TEST_PROJECT_ID = 'demo-rinkrat-rules';
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';

const [firestoreHostname, firestorePortText] = FIRESTORE_HOST.split(':');
const [authHostname, authPortText] = AUTH_HOST.split(':');
const firestorePort = Number(firestorePortText);
const authPort = Number(authPortText);

function emulatorUrl(hostname, port, pathname) {
  return `http://${hostname}:${port}${pathname}`;
}

async function expectOk(response, action) {
  if (response.ok) {
    return;
  }

  const body = await response.text();
  throw new Error(`${action} failed with ${response.status}: ${body}`);
}

export async function resetFirestoreEmulator() {
  const response = await fetch(
    emulatorUrl(
      firestoreHostname,
      firestorePort,
      `/emulator/v1/projects/${TEST_PROJECT_ID}/databases/(default)/documents`,
    ),
    { method: 'DELETE' },
  );

  await expectOk(response, 'Resetting the Firestore emulator');
}

export async function resetAuthEmulator() {
  const response = await fetch(
    emulatorUrl(
      authHostname,
      authPort,
      `/emulator/v1/projects/${TEST_PROJECT_ID}/accounts`,
    ),
    { method: 'DELETE' },
  );

  await expectOk(response, 'Resetting the Auth emulator');
}

export async function resetAllEmulators() {
  await Promise.all([resetFirestoreEmulator(), resetAuthEmulator()]);
}

function encodeFirestoreValue(value) {
  if (value === null || value === undefined) {
    return { nullValue: null };
  }

  if (value instanceof Date) {
    return { timestampValue: value.toISOString() };
  }

  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map(encodeFirestoreValue),
      },
    };
  }

  switch (typeof value) {
    case 'boolean':
      return { booleanValue: value };
    case 'number':
      return Number.isInteger(value)
        ? { integerValue: String(value) }
        : { doubleValue: value };
    case 'string':
      return { stringValue: value };
    case 'object':
      return {
        mapValue: {
          fields: encodeFirestoreFields(value),
        },
      };
    default:
      throw new TypeError(`Unsupported Firestore seed value: ${typeof value}`);
  }
}

function encodeFirestoreFields(data) {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, encodeFirestoreValue(value)]),
  );
}

export async function seedDocument(path, data) {
  const encodedPath = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const response = await fetch(
    emulatorUrl(
      firestoreHostname,
      firestorePort,
      `/v1/projects/${TEST_PROJECT_ID}/databases/(default)/documents/${encodedPath}`,
    ),
    {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer owner',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields: encodeFirestoreFields(data) }),
    },
  );

  await expectOk(response, `Seeding ${path}`);
}

export async function createAuthenticatedClient(label) {
  const app = initializeApp(
    {
      apiKey: 'demo-api-key',
      authDomain: `${TEST_PROJECT_ID}.firebaseapp.com`,
      projectId: TEST_PROJECT_ID,
    },
    `${label}-${randomUUID()}`,
  );
  const auth = getAuth(app);
  connectAuthEmulator(
    auth,
    emulatorUrl(authHostname, authPort, ''),
    { disableWarnings: true },
  );
  const firestore = getFirestore(app);
  connectFirestoreEmulator(firestore, firestoreHostname, firestorePort);

  const email = `${label}-${randomUUID()}@rinkrat.test`;
  const credential = await createUserWithEmailAndPassword(
    auth,
    email,
    'RinkRat-rules-test-2026!',
  );

  return {
    app,
    auth,
    db: firestore,
    email,
    uid: credential.user.uid,
    async cleanup() {
      await deleteApp(app);
    },
  };
}

export function createSignedOutClient(label = 'signed-out') {
  const app = initializeApp(
    {
      apiKey: 'demo-api-key',
      authDomain: `${TEST_PROJECT_ID}.firebaseapp.com`,
      projectId: TEST_PROJECT_ID,
    },
    `${label}-${randomUUID()}`,
  );
  const firestore = getFirestore(app);
  connectFirestoreEmulator(firestore, firestoreHostname, firestorePort);

  return {
    app,
    db: firestore,
    async cleanup() {
      await deleteApp(app);
    },
  };
}

export async function expectAllowed(operation, description) {
  try {
    await operation;
  } catch (error) {
    assert.fail(
      `${description} should be allowed, but failed with ${error?.code ?? error?.message ?? error}`,
    );
  }
}

export async function expectDenied(operation, description) {
  try {
    await operation;
  } catch (error) {
    const code = String(error?.code ?? '');
    const message = String(error?.message ?? '');

    assert.ok(
      code.includes('permission-denied') || message.includes('PERMISSION_DENIED'),
      `${description} failed, but not because of Firestore rules: ${code || message}`,
    );
    return;
  }

  assert.fail(`${description} should be denied by Firestore rules, but it succeeded.`);
}
