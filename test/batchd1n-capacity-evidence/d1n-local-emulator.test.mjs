import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  D1N_LOCAL_EMULATOR_PROJECT_ID,
  resolveD1nLocalEmulatorMode,
} from '../../src/environments/d1n-local-emulator.config.ts';
import {
  D1N_FIXTURE_PROJECT_ID,
  assertD1nFixtureSafety,
  buildD1nFixtureDocuments,
  resolveD1nFixtureDraftStatus,
} from '../../scripts/capacity/seed-d1n-route-fixture.mjs';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

test('D1N browser emulator mode is explicit, loopback-only, and session-bounded', () => {
  assert.equal(D1N_LOCAL_EMULATOR_PROJECT_ID, 'demo-rinkrat-d1n');
  assert.equal(
    resolveD1nLocalEmulatorMode({ hostname: '127.0.0.1', queryFlag: '1', storedFlag: null }),
    true,
  );
  assert.equal(
    resolveD1nLocalEmulatorMode({ hostname: 'localhost', queryFlag: null, storedFlag: '1' }),
    true,
  );
  assert.equal(
    resolveD1nLocalEmulatorMode({ hostname: '::1', queryFlag: '1', storedFlag: null }),
    true,
  );
  assert.equal(
    resolveD1nLocalEmulatorMode({ hostname: 'localhost', queryFlag: '0', storedFlag: '1' }),
    false,
  );

  for (const hostname of ['rinkratfantasy.com', 'www.rinkratfantasy.com', 'preview.example.test']) {
    assert.equal(
      resolveD1nLocalEmulatorMode({ hostname, queryFlag: '1', storedFlag: '1' }),
      false,
      `${hostname} must never activate the local fixture`,
    );
  }
});

test('D1N seed refuses missing, remote, and unexpected-port emulator targets', () => {
  assert.throws(() => assertD1nFixtureSafety({}), /FIREBASE_AUTH_EMULATOR_HOST must be set/);
  assert.throws(
    () =>
      assertD1nFixtureSafety({
        FIREBASE_AUTH_EMULATOR_HOST: 'firebase.example.test:9099',
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
      }),
    /loopback port 9099/,
  );
  assert.throws(
    () =>
      assertD1nFixtureSafety({
        FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9098',
        FIRESTORE_EMULATOR_HOST: 'localhost:8080',
      }),
    /loopback port 9099/,
  );
  assert.throws(
    () =>
      assertD1nFixtureSafety({
        FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099',
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:8081',
      }),
    /loopback port 8080/,
  );
  assert.deepEqual(
    assertD1nFixtureSafety({
      FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    }),
    {
      auth: { hostname: 'localhost', port: 9099 },
      firestore: { hostname: '127.0.0.1', port: 8080 },
    },
  );
});

test('D1N fixture phase is explicit and limited to route-evidence states', () => {
  assert.equal(resolveD1nFixtureDraftStatus({}), 'live');
  assert.equal(resolveD1nFixtureDraftStatus({ D1N_FIXTURE_DRAFT_STATUS: 'scheduled' }), 'scheduled');
  assert.throws(
    () => resolveD1nFixtureDraftStatus({ D1N_FIXTURE_DRAFT_STATUS: 'complete' }),
    /must be live or scheduled/,
  );

  const scheduled = buildD1nFixtureDocuments(
    'fixture-commissioner',
    new Date('2026-09-01T00:00:00Z'),
    { draftStatus: 'scheduled' },
  ).documents.get('leagues/d1n-capacity-league/draft/current');
  assert.equal(scheduled.status, 'scheduled');
  assert.equal(scheduled.scheduledStartAt.toISOString(), '2026-09-08T00:00:00.000Z');
});

test('D1N fixture contains only bounded synthetic route data', () => {
  assert.equal(D1N_FIXTURE_PROJECT_ID, D1N_LOCAL_EMULATOR_PROJECT_ID);
  const fixture = buildD1nFixtureDocuments('fixture-commissioner', new Date('2026-09-01T00:00:00Z'));

  assert.deepEqual(fixture.aggregate, {
    teams: 10,
    rosters: 10,
    activeCycleTeamWindows: 10,
    projectionAssets: 100,
    activityDocuments: 20,
  });
  assert.ok(fixture.documents.size < 100);

  for (const path of fixture.documents.keys()) {
    assert.match(
      path,
      /^(users\/fixture-commissioner|publicProfiles\/fixture-commissioner|appData\/playerAvailability|leagues\/d1n-capacity-league(?:\/|$))/,
    );
    assert.doesNotMatch(path, /nhl-fantasy-app-ab673/);
  }
});

test('D1N browser wiring preserves production config and routes every local SDK to loopback', async () => {
  const [config, auth, firestore, functions, appCheck, packageSource, seed] = await Promise.all([
    read('src/environments/firebase-config.ts'),
    read('src/app/core/firebase-auth.ts'),
    read('src/app/core/firebase-firestore.ts'),
    read('src/app/core/firebase-functions.ts'),
    read('src/app/core/firebase-app-check.ts'),
    read('package.json'),
    read('scripts/capacity/seed-d1n-route-fixture.mjs'),
  ]);

  assert.match(config, /projectId: "nhl-fantasy-app-ab673"/);
  assert.match(config, /D1N_LOCAL_EMULATOR_CONFIG\.enabled[\s\S]*d1nLocalFirebaseConfig[\s\S]*productionFirebaseConfig/);
  assert.match(auth, /D1N_LOCAL_EMULATOR_CONFIG\.enabled[\s\S]*connectAuthEmulator/);
  assert.match(firestore, /D1N_LOCAL_EMULATOR_CONFIG\.enabled[\s\S]*connectFirestoreEmulator/);
  assert.match(functions, /D1N_LOCAL_EMULATOR_CONFIG\.enabled[\s\S]*connectFunctionsEmulator/);
  assert.match(appCheck, /D1N_LOCAL_EMULATOR_CONFIG\.enabled[\s\S]*status: 'disabled'/);
  assert.match(packageSource, /--project demo-rinkrat-d1n --only auth,firestore/);
  assert.match(packageSource, /FIREBASE_AUTH_EMULATOR_HOST=127\.0\.0\.1:9099/);
  assert.match(packageSource, /FIRESTORE_EMULATOR_HOST=127\.0\.0\.1:8080/);
  assert.match(packageSource, /D1N_FIXTURE_DRAFT_STATUS=scheduled npm run fixture:d1n:seed/);
  assert.doesNotMatch(seed, /nhl-fantasy-app-ab673/);
});
