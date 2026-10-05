import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const require = createRequire(import.meta.url);
const IDENTITY_MODULE_PATH =
  `${ROOT_PATH}functions/lib/shared/core/nhl/nhl-player-team-identity.service.js`;
const NHL_API_MODULE_PATH =
  `${ROOT_PATH}functions/lib/shared/core/nhl/nhl-api.service.js`;
const FIREBASE_MODULE_PATH =
  `${ROOT_PATH}functions/lib/shared/core/firebase.js`;
const nhlApi = require(NHL_API_MODULE_PATH);
const firebase = require(FIREBASE_MODULE_PATH);

const REQUIRED_PLAYER_ID = 8_482_720;

function rosterSnapshot({
  feedClub,
  seed,
  sharedPlayerId,
  sharedCurrentTeam,
  sharedName = 'Shared Player',
}) {
  const forwards = Array.from({ length: 9 }, (_, index) => ({
    id: seed + index,
    firstName: { default: `${feedClub} Forward` },
    lastName: { default: String(index + 1) },
    positionCode: index % 3 === 0 ? 'L' : index % 3 === 1 ? 'C' : 'R',
    currentTeamAbbrev: feedClub,
  }));
  const defensemen = Array.from({ length: 4 }, (_, index) => ({
    id: seed + 100 + index,
    firstName: { default: `${feedClub} Defense` },
    lastName: { default: String(index + 1) },
    positionCode: 'D',
    currentTeamAbbrev: feedClub,
  }));

  if (sharedPlayerId) {
    const [firstName, ...lastNameParts] = sharedName.split(' ');

    forwards[0] = {
      id: sharedPlayerId,
      firstName: { default: firstName },
      lastName: { default: lastNameParts.join(' ') },
      positionCode: 'L',
      currentTeamAbbrev: sharedCurrentTeam,
    };
  }

  return {
    club: {
      abbreviation: feedClub,
      name: `${feedClub} Test Club`,
    },
    roster: { forwards, defensemen },
  };
}

function completeCatalogSnapshots(overrides = {}) {
  return nhlApi.NHL_DRAFT_CLUBS.map((club, index) =>
    overrides[club.abbreviation] ?? rosterSnapshot({
      feedClub: club.abbreviation,
      seed: 100_000 + index * 1_000,
    })
  );
}

function storedPlayers({ includeRequiredPlayer }) {
  const players = Array.from({ length: 300 }, (_, index) => ({
    playerId: index + 1,
    teamAbbreviation: 'TOR',
  }));

  if (includeRequiredPlayer) {
    players[players.length - 1] = {
      playerId: REQUIRED_PLAYER_ID,
      teamAbbreviation: 'CBJ',
    };
  }

  return players;
}

function refreshedSkaters({ includeRequiredPlayer }) {
  return storedPlayers({ includeRequiredPlayer }).map((entry) => ({
    id: entry.playerId,
    fullName: `Player ${entry.playerId}`,
    position: 'LW',
    nhlTeamAbbreviation: entry.teamAbbreviation,
    teamLogoUrl: '',
  }));
}

function createFakeIdentityStore(identityModule, {
  includeRequiredPlayer,
  generatedAt = new Date().toISOString(),
  teamConfirmedAt,
}) {
  const players = storedPlayers({ includeRequiredPlayer }).map((player) => ({
    ...player,
    ...(teamConfirmedAt ? { teamConfirmedAt } : {}),
  }));
  let data = {
    schemaVersion: identityModule.NHL_PLAYER_TEAM_IDENTITY_SCHEMA_VERSION,
    status: 'ready',
    generatedAt,
    identityHash: 'a'.repeat(64),
    players,
  };
  const reference = {
    async get() {
      return snapshot();
    },
  };
  const snapshot = () => ({
    exists: true,
    data: () => data,
  });
  const set = (_reference, update, options) => {
    data = options?.merge
      ? { ...data, ...update }
      : update;
  };

  return {
    doc: () => reference,
    runTransaction: async (callback) => callback({
      get: async () => snapshot(),
      set,
    }),
    getData: () => data,
    updateData: (update) => {
      data = { ...data, ...update };
    },
  };
}

function loadFreshIdentityModule() {
  delete require.cache[require.resolve(IDENTITY_MODULE_PATH)];
  return require(IDENTITY_MODULE_PATH);
}

test('conflicting cross-club assignments fail independently of response order', () => {
  const oldTeam = rosterSnapshot({
    feedClub: 'TOR',
    seed: 10_000,
    sharedPlayerId: REQUIRED_PLAYER_ID,
    sharedCurrentTeam: 'TOR',
  });
  const newTeam = rosterSnapshot({
    feedClub: 'CBJ',
    seed: 20_000,
    sharedPlayerId: REQUIRED_PLAYER_ID,
    sharedCurrentTeam: 'CBJ',
  });

  const snapshots = completeCatalogSnapshots({
    TOR: oldTeam,
    CBJ: newTeam,
  });

  for (const candidate of [snapshots, [...snapshots].reverse()]) {
    assert.throws(
      () => nhlApi.buildCurrentNhlDraftSkaterCatalog(candidate),
      /assigned player 8482720 to both CBJ and TOR/,
    );
  }
});

test('agreeing duplicate rows prefer the actual current-club feed deterministically', () => {
  const staleFeed = rosterSnapshot({
    feedClub: 'CBJ',
    seed: 30_000,
    sharedPlayerId: REQUIRED_PLAYER_ID,
    sharedCurrentTeam: 'TOR',
    sharedName: 'Stale Feed Name',
  });
  const currentFeed = rosterSnapshot({
    feedClub: 'TOR',
    seed: 40_000,
    sharedPlayerId: REQUIRED_PLAYER_ID,
    sharedCurrentTeam: 'TOR',
    sharedName: 'Current Feed Name',
  });
  const snapshots = completeCatalogSnapshots({
    CBJ: staleFeed,
    TOR: currentFeed,
  });
  const first = nhlApi.buildCurrentNhlDraftSkaterCatalog(snapshots);
  const second = nhlApi.buildCurrentNhlDraftSkaterCatalog(
    [...snapshots].reverse(),
  );
  const firstShared = first.find((player) => player.id === REQUIRED_PLAYER_ID);
  const secondShared = second.find((player) => player.id === REQUIRED_PLAYER_ID);

  assert.deepEqual(firstShared, secondShared);
  assert.ok(firstShared);
  assert.ok(secondShared);
  assert.equal(firstShared.nhlTeamAbbreviation, 'TOR');
  assert.equal(firstShared.fullName, 'Current Feed Name');
});

test('one malformed club fails even when the aggregate has more than 300 skaters', () => {
  const malformedStl = {
    club: { abbreviation: 'STL', name: 'St. Louis Blues' },
    roster: { forwards: [], defensemen: [] },
  };
  const complete = completeCatalogSnapshots({ STL: malformedStl });

  assert.equal((complete.length - 1) * 13 > 300, true);
  assert.throws(
    () => nhlApi.buildCurrentNhlDraftSkaterCatalog(complete),
    /roster response for STL was incomplete \(0 forwards, 0 defensemen, 0 unique skaters\)/,
  );

  const missingDefense = rosterSnapshot({
    feedClub: 'ANA',
    seed: 500_000,
  });
  delete missingDefense.roster.defensemen;
  assert.throws(
    () => nhlApi.buildCurrentNhlDraftSkaterCatalog(
      completeCatalogSnapshots({ ANA: missingDefense }),
    ),
    /roster response for ANA was incomplete/,
  );

  assert.throws(
    () => nhlApi.buildCurrentNhlDraftSkaterCatalog(
      completeCatalogSnapshots().slice(0, -1),
    ),
    /roster catalog was missing 1 club response: WPG/,
  );
});

test('required-player coverage is stable, deduplicated, and fails visibly', () => {
  const identityModule = loadFreshIdentityModule();
  const snapshot = {
    generatedAt: '2026-09-30T12:00:00.000Z',
    identityHash: 'b'.repeat(64),
    playerCount: 2,
    byPlayerId: new Map([
      [REQUIRED_PLAYER_ID, 'CBJ'],
      [8_478_402, 'VGK'],
    ]),
  };
  const coverage = identityModule.inspectNhlPlayerTeamIdentityCoverage(
    snapshot,
    [8_478_402, 9_999_999, 9_999_999, REQUIRED_PLAYER_ID],
  );

  assert.deepEqual(coverage, {
    complete: false,
    requiredPlayerCount: 3,
    missingPlayerIds: [9_999_999],
  });
  assert.throws(
    () => identityModule.requireNhlPlayerTeamIdentityCoverage(
      snapshot,
      [REQUIRED_PLAYER_ID, 9_999_999],
    ),
    (error) => {
      assert.equal(
        error.code,
        'nhl-player-team-identity-coverage-incomplete',
      );
      assert.deepEqual(error.missingPlayerIds, [9_999_999]);
      assert.equal(error.identityHash, snapshot.identityHash);
      assert.equal(error.generatedAt, snapshot.generatedAt);
      assert.match(error.message, /Scoring was left unchanged and will retry/);
      return true;
    },
  );
  assert.throws(
    () => identityModule.inspectNhlPlayerTeamIdentityCoverage(snapshot, [0]),
    /invalid required player id: 0/,
  );
});

test('the first confirmation time survives refreshes only while the NHL club is unchanged', () => {
  const identityModule = loadFreshIdentityModule();
  const firstConfirmedAt = '2026-09-30T16:00:00.000Z';
  const priorRefreshAt = '2026-09-30T16:04:00.000Z';
  const nextRefreshAt = '2026-09-30T16:08:00.000Z';

  assert.equal(
    identityModule.resolveNhlPlayerTeamConfirmedAt({
      currentTeamAbbreviation: 'CBJ',
      generatedAt: nextRefreshAt,
      previousTeamAbbreviation: 'CBJ',
      previousTeamConfirmedAt: firstConfirmedAt,
      previousGeneratedAt: priorRefreshAt,
    }),
    firstConfirmedAt,
  );
  assert.equal(
    identityModule.resolveNhlPlayerTeamConfirmedAt({
      currentTeamAbbreviation: 'VGK',
      generatedAt: nextRefreshAt,
      previousTeamAbbreviation: 'CBJ',
      previousTeamConfirmedAt: firstConfirmedAt,
      previousGeneratedAt: priorRefreshAt,
    }),
    nextRefreshAt,
  );
  assert.equal(
    identityModule.resolveNhlPlayerTeamConfirmedAt({
      currentTeamAbbreviation: 'CBJ',
      generatedAt: nextRefreshAt,
      previousTeamAbbreviation: 'CBJ',
      previousGeneratedAt: priorRefreshAt,
    }),
    priorRefreshAt,
  );
});

test('a fresh aggregate recovers an active required player from exact NHL profile evidence', async (t) => {
  const identityModule = loadFreshIdentityModule();
  const priorGeneratedAt = new Date().toISOString();
  const store = createFakeIdentityStore(identityModule, {
    includeRequiredPlayer: false,
    generatedAt: priorGeneratedAt,
  });
  let catalogRefreshCount = 0;
  let profileRefreshCount = 0;

  t.mock.method(firebase.db, 'doc', store.doc);
  t.mock.method(firebase.db, 'runTransaction', store.runTransaction);
  t.mock.method(nhlApi, 'getCurrentNhlDraftSkaters', async () => {
    catalogRefreshCount += 1;
    return refreshedSkaters({ includeRequiredPlayer: false });
  });
  t.mock.method(nhlApi, 'getCurrentNhlPlayerTeamIdentity', async (
    playerId,
    forceRefresh,
  ) => {
    profileRefreshCount += 1;
    assert.equal(playerId, REQUIRED_PLAYER_ID);
    assert.equal(forceRefresh, true);
    return {
      playerId: REQUIRED_PLAYER_ID,
      teamAbbreviation: 'CBJ',
    };
  });

  const snapshot = await identityModule.loadCurrentNhlPlayerTeamIdentity([
    REQUIRED_PLAYER_ID,
  ]);

  assert.equal(catalogRefreshCount, 0);
  assert.equal(profileRefreshCount, 1);
  assert.equal(snapshot.byPlayerId.get(REQUIRED_PLAYER_ID), 'CBJ');
  assert.equal(snapshot.generatedAt, priorGeneratedAt);
});

test('a stale aggregate combines a complete club refresh with exact NHL profile evidence', async (t) => {
  const identityModule = loadFreshIdentityModule();
  const priorGeneratedAt = new Date(
    Date.now() - 10 * 60 * 1000,
  ).toISOString();
  const store = createFakeIdentityStore(identityModule, {
    includeRequiredPlayer: false,
    generatedAt: priorGeneratedAt,
  });
  let catalogRefreshCount = 0;
  let profileRefreshCount = 0;

  t.mock.method(firebase.db, 'doc', store.doc);
  t.mock.method(firebase.db, 'runTransaction', store.runTransaction);
  t.mock.method(nhlApi, 'getCurrentNhlDraftSkaters', async (forceRefresh) => {
    catalogRefreshCount += 1;
    assert.equal(forceRefresh, true);
    return refreshedSkaters({ includeRequiredPlayer: false });
  });
  t.mock.method(nhlApi, 'getCurrentNhlPlayerTeamIdentity', async (
    playerId,
    forceRefresh,
  ) => {
    profileRefreshCount += 1;
    assert.equal(playerId, REQUIRED_PLAYER_ID);
    assert.equal(forceRefresh, true);
    return {
      playerId: REQUIRED_PLAYER_ID,
      teamAbbreviation: 'CBJ',
    };
  });

  const snapshot = await identityModule.loadCurrentNhlPlayerTeamIdentity([
    REQUIRED_PLAYER_ID,
  ]);

  assert.equal(catalogRefreshCount, 1);
  assert.equal(profileRefreshCount, 1);
  assert.equal(snapshot.byPlayerId.get(REQUIRED_PLAYER_ID), 'CBJ');
  assert.equal(Date.parse(snapshot.generatedAt) > Date.parse(priorGeneratedAt), true);
});

test('one exact lookup that still lacks a required player records a cooldown and fails closed', async (t) => {
  const identityModule = loadFreshIdentityModule();
  const store = createFakeIdentityStore(identityModule, {
    includeRequiredPlayer: false,
  });
  let catalogRefreshCount = 0;
  let profileRefreshCount = 0;

  t.mock.method(firebase.db, 'doc', store.doc);
  t.mock.method(firebase.db, 'runTransaction', store.runTransaction);
  t.mock.method(nhlApi, 'getCurrentNhlDraftSkaters', async () => {
    catalogRefreshCount += 1;
    return refreshedSkaters({ includeRequiredPlayer: false });
  });
  t.mock.method(nhlApi, 'getCurrentNhlPlayerTeamIdentity', async () => {
    profileRefreshCount += 1;
    return null;
  });

  await assert.rejects(
    identityModule.loadCurrentNhlPlayerTeamIdentity({
      requiredPlayerIds: [REQUIRED_PLAYER_ID],
    }),
    (error) => {
      assert.equal(
        error.code,
        'nhl-player-team-identity-coverage-incomplete',
      );
      assert.deepEqual(error.missingPlayerIds, [REQUIRED_PLAYER_ID]);
      return true;
    },
  );
  const firstRetryAfter = store.getData().missingCoverage.retryAfter;
  await assert.rejects(
    identityModule.loadCurrentNhlPlayerTeamIdentity({
      requiredPlayerIds: [REQUIRED_PLAYER_ID],
    }),
    (error) => {
      assert.equal(
        error.code,
        'nhl-player-team-identity-coverage-incomplete',
      );
      assert.deepEqual(error.missingPlayerIds, [REQUIRED_PLAYER_ID]);
      return true;
    },
  );
  assert.equal(catalogRefreshCount, 0);
  assert.equal(profileRefreshCount, 1);
  assert.deepEqual(
    store.getData().missingCoverage.missingPlayerIds,
    [REQUIRED_PLAYER_ID],
  );
  assert.equal(store.getData().missingCoverage.requestMissingPlayerCount, 1);
  assert.equal(store.getData().missingCoverage.retryAfter, firstRetryAfter);
  assert.equal(
    Date.parse(store.getData().missingCoverage.retryAfter) > Date.now(),
    true,
  );
});

test('negative coverage stays bounded while an exact large request is suppressed', async (t) => {
  const identityModule = loadFreshIdentityModule();
  const store = createFakeIdentityStore(identityModule, {
    includeRequiredPlayer: false,
  });
  const requiredPlayerIds = Array.from(
    { length: 200 },
    (_, index) => 9_000_000 + index,
  );
  let catalogRefreshCount = 0;
  let profileRefreshCount = 0;

  t.mock.method(firebase.db, 'doc', store.doc);
  t.mock.method(firebase.db, 'runTransaction', store.runTransaction);
  t.mock.method(nhlApi, 'getCurrentNhlDraftSkaters', async () => {
    catalogRefreshCount += 1;
    return refreshedSkaters({ includeRequiredPlayer: false });
  });
  t.mock.method(nhlApi, 'getCurrentNhlPlayerTeamIdentity', async () => {
    profileRefreshCount += 1;
    return null;
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      identityModule.loadCurrentNhlPlayerTeamIdentity({
        requiredPlayerIds,
      }),
      (error) => {
        assert.equal(
          error.code,
          'nhl-player-team-identity-coverage-incomplete',
        );
        assert.equal(error.missingPlayerIds.length, requiredPlayerIds.length);
        return true;
      },
    );
  }

  assert.equal(catalogRefreshCount, 0);
  assert.equal(profileRefreshCount, 32);
  assert.equal(store.getData().missingCoverage.missingPlayerIds.length, 128);
  assert.equal(
    store.getData().missingCoverage.requestMissingPlayerCount,
    requiredPlayerIds.length,
  );
});

test('an expired missing-coverage boundary permits one new provider retry', async (t) => {
  const identityModule = loadFreshIdentityModule();
  const store = createFakeIdentityStore(identityModule, {
    includeRequiredPlayer: false,
  });
  let catalogRefreshCount = 0;
  let profileRefreshCount = 0;

  t.mock.method(firebase.db, 'doc', store.doc);
  t.mock.method(firebase.db, 'runTransaction', store.runTransaction);
  t.mock.method(nhlApi, 'getCurrentNhlDraftSkaters', async () => {
    catalogRefreshCount += 1;
    return refreshedSkaters({ includeRequiredPlayer: false });
  });
  t.mock.method(nhlApi, 'getCurrentNhlPlayerTeamIdentity', async () => {
    profileRefreshCount += 1;
    return null;
  });

  await assert.rejects(
    identityModule.loadCurrentNhlPlayerTeamIdentity([REQUIRED_PLAYER_ID]),
    { code: 'nhl-player-team-identity-coverage-incomplete' },
  );
  store.updateData({
    missingCoverage: {
      ...store.getData().missingCoverage,
      retryAfter: new Date(Date.now() - 1).toISOString(),
    },
  });
  await assert.rejects(
    identityModule.loadCurrentNhlPlayerTeamIdentity([REQUIRED_PLAYER_ID]),
    { code: 'nhl-player-team-identity-coverage-incomplete' },
  );

  assert.equal(catalogRefreshCount, 0);
  assert.equal(profileRefreshCount, 2);
});

test('a newer evidence boundary bypasses negative coverage and can recover the player', async (t) => {
  const identityModule = loadFreshIdentityModule();
  const store = createFakeIdentityStore(identityModule, {
    includeRequiredPlayer: false,
  });
  let catalogRefreshCount = 0;
  let profileRefreshCount = 0;

  t.mock.method(firebase.db, 'doc', store.doc);
  t.mock.method(firebase.db, 'runTransaction', store.runTransaction);
  t.mock.method(nhlApi, 'getCurrentNhlDraftSkaters', async () => {
    catalogRefreshCount += 1;
    return refreshedSkaters({ includeRequiredPlayer: true });
  });
  t.mock.method(nhlApi, 'getCurrentNhlPlayerTeamIdentity', async () => {
    profileRefreshCount += 1;
    return null;
  });

  await assert.rejects(
    identityModule.loadCurrentNhlPlayerTeamIdentity([REQUIRED_PLAYER_ID]),
    { code: 'nhl-player-team-identity-coverage-incomplete' },
  );
  const minimumGeneratedAtMilliseconds =
    Date.parse(store.getData().generatedAt) + 1;

  while (Date.now() < minimumGeneratedAtMilliseconds) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  const recovered = await identityModule.loadCurrentNhlPlayerTeamIdentity({
    requiredPlayerIds: [REQUIRED_PLAYER_ID],
    minimumGeneratedAtMilliseconds,
  });

  assert.equal(catalogRefreshCount, 1);
  assert.equal(profileRefreshCount, 1);
  assert.equal(recovered.byPlayerId.get(REQUIRED_PLAYER_ID), 'CBJ');
  assert.equal(store.getData().missingCoverage, null);
});

test('a claimed refresh retains the first confirmation time for an unchanged club', async (t) => {
  const identityModule = loadFreshIdentityModule();
  const firstConfirmedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const store = createFakeIdentityStore(identityModule, {
    includeRequiredPlayer: true,
    generatedAt: firstConfirmedAt,
    teamConfirmedAt: firstConfirmedAt,
  });

  t.mock.method(firebase.db, 'doc', store.doc);
  t.mock.method(firebase.db, 'runTransaction', store.runTransaction);
  t.mock.method(nhlApi, 'getCurrentNhlDraftSkaters', async () =>
    refreshedSkaters({ includeRequiredPlayer: true })
  );

  const snapshot = await identityModule.loadCurrentNhlPlayerTeamIdentity({
    requiredPlayerIds: [REQUIRED_PLAYER_ID],
    minimumGeneratedAtMilliseconds: Date.parse(firstConfirmedAt) + 1,
  });

  assert.equal(snapshot.byPlayerId.get(REQUIRED_PLAYER_ID), 'CBJ');
  assert.equal(
    snapshot.teamConfirmedAtByPlayerId.get(REQUIRED_PLAYER_ID),
    firstConfirmedAt,
  );
});
