import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  D1N_LOCAL_EMULATOR_PROJECT_ID,
  resolveD1nLocalEmulatorMode,
} from '../../src/environments/d1n-local-emulator.config.ts';
import {
  D1N_FIXTURE_PROJECT_ID,
  assertD1nFixtureSafety,
  buildD1nFixtureDocuments,
  resolveD1nFixtureDraftStartOffsetMinutes,
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

  assert.equal(resolveD1nFixtureDraftStartOffsetMinutes({}), 10_080);
  assert.equal(
    resolveD1nFixtureDraftStartOffsetMinutes({
      D1N_FIXTURE_DRAFT_START_OFFSET_MINUTES: '45',
    }),
    45,
  );

  for (const invalidOffset of ['0', '10081', '1.5', '-1', 'soon']) {
    assert.throws(
      () => resolveD1nFixtureDraftStartOffsetMinutes({
        D1N_FIXTURE_DRAFT_START_OFFSET_MINUTES: invalidOffset,
      }),
      /must be an integer from 1 to 10080/,
    );
  }

  const lobby = buildD1nFixtureDocuments(
    'fixture-commissioner',
    new Date('2026-09-01T00:00:00Z'),
    { draftStatus: 'scheduled', draftStartOffsetMinutes: 45 },
  ).documents.get('leagues/d1n-capacity-league/draft/current');
  assert.equal(lobby.scheduledStartAt.toISOString(), '2026-09-01T00:45:00.000Z');
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

test('D1N Draft fixture covers portraits, injury timing, team changes, queue state, and fallbacks', async () => {
  const fixture = buildD1nFixtureDocuments(
    'fixture-commissioner',
    new Date('2026-09-01T00:00:00Z'),
  );
  const projectionChunk = fixture.documents.get(
    'leagues/d1n-capacity-league/projectionSnapshots/fixture-v11/assets/chunk-000',
  );
  const availability = fixture.documents.get('appData/playerAvailability');
  const commissionerQueue = fixture.documents.get(
    'leagues/d1n-capacity-league/draft/current/queues/fixture-commissioner',
  );
  const assetsByKey = new Map(
    projectionChunk.assets.map((asset) => [asset.assetKey, asset]),
  );

  assert.equal(availability.status, 'success');
  assert.deepEqual(
    availability.lastSuccessfulSyncAt,
    new Date('2026-09-01T00:00:00Z'),
  );
  assert.equal(availability.lastDailySyncKey, '2026-09-01');
  assert.deepEqual(commissionerQueue.assetKeys, ['skater:10000']);
  assert.deepEqual(assetsByKey.get('skater:10000').player, {
    id: 10_000,
    fullName: 'Fixture Healthy Headshot',
    position: 'LW',
    nhlTeamAbbreviation: 'MIN',
    headshotUrl: '/assets/profile-icons/masked-veteran.webp',
    teamLogoUrl: '/assets/team-identity-logos/MIN_light.svg',
  });
  assert.equal(
    assetsByKey.get('skater:10001').player.fullName,
    'Fixture Injured Headshot',
  );
  assert.equal(assetsByKey.get('skater:10001').availabilityStatus, 'injured-reserve');
  assert.equal(assetsByKey.get('skater:10001').availabilityReturnDate, '2026-09-15');
  assert.equal(
    assetsByKey.get('skater:10002').player.headshotUrl,
    '/assets/d1n-fixture/missing-headshot.webp',
  );
  assert.equal(
    assetsByKey.get('skater:10002').player.teamLogoUrl,
    '/assets/team-identity-logos/TBL_light.svg',
  );
  assert.equal(assetsByKey.get('skater:10003').player.fullName, 'Brady Tkachuk');
  assert.equal(assetsByKey.get('skater:10003').player.nhlTeamAbbreviation, 'FLA');
  assert.equal(
    assetsByKey.get('skater:10004').player.fullName,
    'Fixture Extraordinarily Long Player Name',
  );
  assert.deepEqual(assetsByKey.get('team-goalie-unit:fixture-91'), {
    assetType: 'team-goalie-unit',
    assetKey: 'team-goalie-unit:fixture-91',
    position: 'G',
    teamName: 'Fixture Minnesota Goalie Unit',
    teamAbbreviation: 'MIN',
    teamLogoUrl: '/assets/team-identity-logos/MIN_light.svg',
    projectedCyclePoints: 15,
    projectedSeasonPoints: 210,
    draftRank: 91,
    balancedRank: 91,
    draftPositionRank: 1,
    positionRank: 1,
    projectionModelVersion: 11,
    availabilityStatus: 'active',
  });

  const injuredRecord = availability.records.find((record) => record.playerId === 10_001);
  assert.deepEqual(injuredRecord, {
    playerId: 10_001,
    playerName: 'Fixture Injured Headshot',
    status: 'injured-reserve',
    note: 'Synthetic Draft visual evidence only.',
    updatedAt: '2026-09-01T00:00:00.000Z',
    updatedBy: 'd1n-local-fixture',
    externalStatus: 'Injured Reserve',
    externalReturnDate: '2026-09-15',
    syncedAt: '2026-09-01T00:00:00.000Z',
  });

  for (const asset of projectionChunk.assets) {
    if (asset.assetType === 'skater') {
      assert.doesNotMatch(asset.player.headshotUrl ?? '', /^https?:/);
      assert.doesNotMatch(asset.player.teamLogoUrl ?? '', /^https?:/);
    } else {
      assert.doesNotMatch(asset.teamLogoUrl ?? '', /^https?:/);
    }
  }

  await Promise.all([
    'public/assets/profile-icons/masked-veteran.webp',
    'public/assets/profile-icons/teal-captain.webp',
    'public/assets/team-identity-logos/FLA_light.svg',
    'public/assets/team-identity-logos/MIN_light.svg',
    'public/assets/team-identity-logos/OTT_light.svg',
    'public/assets/team-identity-logos/TBL_light.svg',
  ].map((relativePath) => access(new URL(relativePath, ROOT))));
  await assert.rejects(
    access(new URL('public/assets/d1n-fixture/missing-headshot.webp', ROOT)),
  );
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
