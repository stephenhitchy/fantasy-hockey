import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const D1M_STAGING_PROJECT_ID = 'rinkrat-staging-d1nc-2026';
export const D1M_STAGING_LEAGUE_ID = 'd1m-final-score-reconciliation';
export const D1M_STAGING_ADMIN_ID = 'd1m-reconciliation-admin';
export const D1M_STAGING_NON_ADMIN_ID = 'd1m-reconciliation-member';
export const D1M_STAGING_ADMIN_EMAIL = 'admin@d1m.rinkrat.test';
export const D1M_STAGING_NON_ADMIN_EMAIL = 'member@d1m.rinkrat.test';
export const D1M_STAGING_FIXTURE_MARKER =
  'rinkrat-d1m-final-score-reconciliation-fixture-v1';
export const D1M_STAGING_SEED_ACKNOWLEDGEMENT =
  `reset-and-seed-${D1M_STAGING_FIXTURE_MARKER}-in-${D1M_STAGING_PROJECT_ID}`;

export const D1M_STAGING_GAME_IDS = Object.freeze({
  verifiedZero: 2_099_020_001,
  mismatch: 2_099_020_002,
  missingCanonical: 2_099_020_003,
  missingStoredEvidence: 2_099_020_004,
});

const requireFunctions = createRequire(
  new URL('../../functions/package.json', import.meta.url),
);
const STORED_SOURCE_VERSION = 'a'.repeat(64);
const CANONICAL_SOURCE_VERSIONS = Object.freeze({
  verifiedZero: 'b'.repeat(64),
  mismatch: 'c'.repeat(64),
  missingStoredEvidence: 'd'.repeat(64),
});
const WINDOW_SPECS = Object.freeze([
  {
    label: 'verified-zero',
    slotId: 'C-1',
    position: 'C',
    playerId: 8_999_001,
    gameId: D1M_STAGING_GAME_IDS.verifiedZero,
    storedEvidence: true,
  },
  {
    label: 'mismatch',
    slotId: 'LW-1',
    position: 'LW',
    playerId: 8_999_002,
    gameId: D1M_STAGING_GAME_IDS.mismatch,
    storedEvidence: true,
  },
  {
    label: 'missing-canonical',
    slotId: 'RW-1',
    position: 'RW',
    playerId: 8_999_003,
    gameId: D1M_STAGING_GAME_IDS.missingCanonical,
    storedEvidence: true,
  },
  {
    label: 'missing-stored-evidence',
    slotId: 'D-1',
    position: 'D',
    playerId: 8_999_004,
    gameId: D1M_STAGING_GAME_IDS.missingStoredEvidence,
    storedEvidence: false,
  },
]);

function assertStrongFixturePassword(password) {
  if (
    password.length < 20 ||
    password.length > 128 ||
    !/[a-z]/.test(password) ||
    !/[A-Z]/.test(password) ||
    !/[0-9]/.test(password) ||
    !/[^A-Za-z0-9]/.test(password)
  ) {
    throw new Error(
      'D1M_STAGING_FIXTURE_PASSWORD must be 20–128 characters with upper, lower, number, and symbol.',
    );
  }
}

export function assertD1mStagingConnectionSafety(environment = process.env) {
  if (
    environment.FIRESTORE_EMULATOR_HOST ||
    environment.FIREBASE_AUTH_EMULATOR_HOST ||
    environment.FIREBASE_DATABASE_EMULATOR_HOST
  ) {
    throw new Error('D1M staging tooling refuses every Emulator Suite environment.');
  }

  if (environment.D1M_STAGING_PROJECT_ID !== D1M_STAGING_PROJECT_ID) {
    throw new Error(
      `D1M_STAGING_PROJECT_ID must equal ${D1M_STAGING_PROJECT_ID}.`,
    );
  }

  const password = environment.D1M_STAGING_FIXTURE_PASSWORD ?? '';
  assertStrongFixturePassword(password);
  return { password };
}

export function assertD1mStagingSeedSafety(environment = process.env) {
  const connectionSafety = assertD1mStagingConnectionSafety(environment);

  if (environment.D1M_STAGING_ACK !== D1M_STAGING_SEED_ACKNOWLEDGEMENT) {
    throw new Error(
      'D1M_STAGING_ACK does not authorize the exact reconciliation fixture reset.',
    );
  }

  return connectionSafety;
}

function completeEvidence(sourceVersion) {
  return {
    status: 'complete',
    complete: true,
    reusableFinal: true,
    requiredSources: ['boxscore', 'play-by-play', 'player-log', 'source-version'],
    sourceVersion,
    preservedPreviousScore: false,
    failures: [],
  };
}

function buildAsset(spec) {
  return {
    assetType: 'skater',
    assetKey: `skater:${spec.playerId}`,
    position: spec.position,
    player: {
      id: spec.playerId,
      fullName: `D1M ${spec.label}`,
      position: spec.position,
      nhlTeamAbbreviation: 'SEA',
    },
  };
}

function buildWindow(spec, nowIso) {
  const asset = buildAsset(spec);
  const gameKey = String(spec.gameId);

  return {
    id: `${D1M_STAGING_ADMIN_ID}__${spec.slotId}__cycle-1`,
    ownerId: D1M_STAGING_ADMIN_ID,
    rosterSlotId: spec.slotId,
    cycleNumber: 1,
    position: spec.position,
    assetKey: asset.assetKey,
    asset,
    status: 'complete',
    scheduledGameIds: [spec.gameId],
    scheduledGameDates: ['2099-10-01'],
    scheduledGameLabels: ['vs VAN'],
    completedGameIds: [spec.gameId],
    liveGameIds: [],
    appearanceGameIds: [],
    gameScores: { [gameKey]: 0 },
    gameStates: { [gameKey]: 'final' },
    gameInputCompleteness: spec.storedEvidence
      ? { [gameKey]: completeEvidence(STORED_SOURCE_VERSION) }
      : {},
    incompleteFinalGameIds: [],
    scheduledGames: 1,
    gamesPlayed: 1,
    actualGamesPlayed: 0,
    gamesLeft: 0,
    fantasyPoints: 0,
    frozenProjectionPoints: null,
    frozenProjectionVersion: null,
    frozenProjectionSource: null,
    frozenProjectionSnapshotId: null,
    frozenProjectionGeneratedAt: null,
    frozenProjectionFrozenAt: null,
    frozenProjectionTargetGameIds: [spec.gameId],
    firstScheduledGameDate: '2099-10-01',
    lastScheduledGameDate: '2099-10-01',
    startedAt: nowIso,
    completedAt: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

function canonicalFacts(gameId, playerId = null) {
  const appeared = Number.isInteger(playerId);
  const skaters = appeared
    ? [{
        playerId,
        teamAbbreviation: 'SEA',
        position: 'LW',
        goals: 1,
        assists: 0,
        primaryAssists: 0,
        secondaryAssists: 0,
        shotsOnGoal: 1,
        hits: 0,
        blockedShots: 0,
        plusMinus: 0,
        powerPlayGoals: 0,
        timeOnIceSeconds: 600,
      }]
    : [];
  const finalSettlements = appeared
    ? [{
        playerId,
        goals: 1,
        assists: 0,
        shotsOnGoal: 1,
        plusMinus: 0,
        powerPlayPoints: 0,
        shortHandedPoints: 0,
        gameWinningGoal: false,
        overtimeGoal: false,
        timeOnIceSeconds: 600,
        source: 'player-game-log',
      }]
    : [];

  return {
    schemaVersion: 2,
    gameId,
    gameState: 'final',
    sourceGameState: 'OFF',
    sourceGameScheduleState: 'OK',
    gameDate: '2099-10-01',
    startTimeUTC: '2099-10-02T02:00:00Z',
    period: 3,
    periodType: 'REG',
    clockTimeRemaining: '00:00',
    clockRunning: false,
    inIntermission: false,
    homeTeamAbbreviation: 'SEA',
    awayTeamAbbreviation: 'VAN',
    homeScore: 2,
    awayScore: 1,
    skaters,
    goalies: [],
    goals: [],
    finalSettlements,
    finalSettlementPlayerIds: appeared ? [playerId] : [],
    playerIds: appeared ? [playerId] : [],
    teamAbbreviations: ['SEA', 'VAN'],
  };
}

function canonicalGame(gameId, sourceVersion, playerId, now) {
  return {
    schemaVersion: 2,
    gameId,
    sourceVersion,
    facts: canonicalFacts(gameId, playerId),
    finalInputCompletenessByAssetType: {
      skater: completeEvidence(sourceVersion),
    },
    fixtureMarker: D1M_STAGING_FIXTURE_MARKER,
    createdAt: now,
    updatedAt: now,
  };
}

function user(uid, email, username, now) {
  return {
    uid,
    email,
    username,
    favoriteTeamAbbreviation: 'SEA',
    favoriteTeamVariantId: 'current-home',
    teamIdentityUnlocks: [],
    reducedMotion: false,
    defaultLandingPage: 'dashboard',
    backgroundTheme: 'rink-dark',
    injuryEmailEnabled: false,
    hockeyExperience: 'advanced',
    trainingCampVersion: 0,
    fixtureMarker: D1M_STAGING_FIXTURE_MARKER,
    createdAt: now,
    updatedAt: now,
  };
}

export function buildD1mStagingDocuments(now = new Date()) {
  const nowIso = now.toISOString();
  const slotIds = WINDOW_SPECS.map((spec) => spec.slotId);
  const windows = WINDOW_SPECS.map((spec) => buildWindow(spec, nowIso));
  const documents = new Map();
  const prefix = `leagues/${D1M_STAGING_LEAGUE_ID}`;

  documents.set(`users/${D1M_STAGING_ADMIN_ID}`, user(
    D1M_STAGING_ADMIN_ID,
    D1M_STAGING_ADMIN_EMAIL,
    'D1M Reconciliation Admin',
    now,
  ));
  documents.set(`users/${D1M_STAGING_NON_ADMIN_ID}`, user(
    D1M_STAGING_NON_ADMIN_ID,
    D1M_STAGING_NON_ADMIN_EMAIL,
    'D1M Non Admin',
    now,
  ));
  documents.set(`platformAdmins/${D1M_STAGING_ADMIN_ID}`, {
    enabled: true,
    fixtureMarker: D1M_STAGING_FIXTURE_MARKER,
    updatedAt: now,
  });
  documents.set(prefix, {
    id: D1M_STAGING_LEAGUE_ID,
    name: 'D1M Final Score Reconciliation Fixture',
    commissionerId: D1M_STAGING_ADMIN_ID,
    inviteCode: 'D1MSTG',
    maxTeams: 1,
    teamCount: 1,
    joinStatus: 'full',
    matchupFormat: 'cycle_matchup',
    requiredGamesPerCycle: 6,
    scoringRules: {},
    scoringRulesVersion: 4,
    authoritySchemaVersion: 2,
    competitionSettingsLocked: true,
    fixtureMarker: D1M_STAGING_FIXTURE_MARKER,
    createdAt: now,
    updatedAt: now,
  });
  documents.set(`${prefix}/members/${D1M_STAGING_ADMIN_ID}`, {
    uid: D1M_STAGING_ADMIN_ID,
    leagueId: D1M_STAGING_LEAGUE_ID,
    username: 'D1M Reconciliation Admin',
    role: 'commissioner',
    fixtureMarker: D1M_STAGING_FIXTURE_MARKER,
    joinedAt: now,
    updatedAt: now,
  });
  documents.set(`${prefix}/teams/${D1M_STAGING_ADMIN_ID}`, {
    id: D1M_STAGING_ADMIN_ID,
    ownerId: D1M_STAGING_ADMIN_ID,
    teamName: 'D1M Synthetic Team',
    managerName: 'D1M Reconciliation Admin',
    wins: 0,
    losses: 0,
    ties: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    fixtureMarker: D1M_STAGING_FIXTURE_MARKER,
    createdAt: now,
    updatedAt: now,
  });
  documents.set(`${prefix}/teams/${D1M_STAGING_ADMIN_ID}/roster/current`, {
    schemaVersion: 2,
    activeSlots: WINDOW_SPECS.map((spec, index) => ({
      slotId: spec.slotId,
      position: spec.position,
      slotNumber: index + 1,
      asset: buildAsset(spec),
      pendingMove: null,
      openFromCycleNumber: null,
    })),
    benchSlots: [],
    irSlots: [],
    fixtureMarker: D1M_STAGING_FIXTURE_MARKER,
    createdAt: now,
    updatedAt: now,
  });
  documents.set(`${prefix}/cycles/cycle-1`, {
    id: 'cycle-1',
    cycleNumber: 1,
    status: 'complete',
    phase: 'regular_season',
    matchupIds: ['matchup-1'],
    windowSchemaVersion: 1,
    expectedRosterSlotIdsByOwner: {
      [D1M_STAGING_ADMIN_ID]: slotIds,
    },
    totalExpectedWindowCount: slotIds.length,
    activeWindowCount: 0,
    completedWindowCount: slotIds.length,
    fixtureMarker: D1M_STAGING_FIXTURE_MARKER,
    startedAt: now,
    completedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  documents.set(`${prefix}/cycles/cycle-1/matchups/matchup-1`, {
    id: 'matchup-1',
    cycleNumber: 1,
    phase: 'regular_season',
    teamAOwnerId: D1M_STAGING_ADMIN_ID,
    teamBOwnerId: null,
    teamAScore: 0,
    teamBScore: 0,
    winnerOwnerId: D1M_STAGING_ADMIN_ID,
    status: 'complete',
    fixtureMarker: D1M_STAGING_FIXTURE_MARKER,
    createdAt: now,
    completedAt: now,
    updatedAt: now,
  });
  documents.set(
    `${prefix}/cycles/cycle-1/teamWindows/${D1M_STAGING_ADMIN_ID}`,
    {
      id: D1M_STAGING_ADMIN_ID,
      ownerId: D1M_STAGING_ADMIN_ID,
      cycleNumber: 1,
      expectedRosterSlotIds: slotIds,
      windows,
      completedWindowCount: windows.length,
      totalWindowCount: windows.length,
      status: 'complete',
      fixtureMarker: D1M_STAGING_FIXTURE_MARKER,
      createdAt: now,
      completedAt: now,
      updatedAt: now,
    },
  );

  documents.set(
    `nhlCanonicalGameFacts/${D1M_STAGING_GAME_IDS.verifiedZero}`,
    canonicalGame(
      D1M_STAGING_GAME_IDS.verifiedZero,
      CANONICAL_SOURCE_VERSIONS.verifiedZero,
      null,
      now,
    ),
  );
  documents.set(
    `nhlCanonicalGameFacts/${D1M_STAGING_GAME_IDS.mismatch}`,
    canonicalGame(
      D1M_STAGING_GAME_IDS.mismatch,
      CANONICAL_SOURCE_VERSIONS.mismatch,
      WINDOW_SPECS[1].playerId,
      now,
    ),
  );
  documents.set(
    `nhlCanonicalGameFacts/${D1M_STAGING_GAME_IDS.missingStoredEvidence}`,
    canonicalGame(
      D1M_STAGING_GAME_IDS.missingStoredEvidence,
      CANONICAL_SOURCE_VERSIONS.missingStoredEvidence,
      null,
      now,
    ),
  );

  return {
    documents,
    leagueId: D1M_STAGING_LEAGUE_ID,
    adminId: D1M_STAGING_ADMIN_ID,
    nonAdminId: D1M_STAGING_NON_ADMIN_ID,
    windowCount: windows.length,
  };
}

async function resolveFixedAuthUser(auth, uid, email) {
  let byEmail = null;
  let byId = null;

  try {
    byEmail = await auth.getUserByEmail(email);
  } catch (error) {
    if (error?.code !== 'auth/user-not-found') {
      throw error;
    }
  }

  try {
    byId = await auth.getUser(uid);
  } catch (error) {
    if (error?.code !== 'auth/user-not-found') {
      throw error;
    }
  }

  if (byEmail && byEmail.uid !== uid) {
    throw new Error('A fixed D1M staging email belongs to a different Auth identity.');
  }

  if (byId && byId.email !== email) {
    throw new Error('A fixed D1M staging Auth identity belongs to a different email.');
  }

  return byEmail ?? byId;
}

async function upsertFixedAuthUser(auth, input) {
  const existing = await resolveFixedAuthUser(auth, input.uid, input.email);

  if (existing) {
    return auth.updateUser(input.uid, {
      email: input.email,
      password: input.password,
      displayName: input.displayName,
      emailVerified: true,
      disabled: false,
    });
  }

  return auth.createUser({
    uid: input.uid,
    email: input.email,
    password: input.password,
    displayName: input.displayName,
    emailVerified: true,
    disabled: false,
  });
}

export async function seedD1mStagingFixture(environment = process.env) {
  const { password } = assertD1mStagingSeedSafety(environment);
  const { applicationDefault, deleteApp, initializeApp } =
    requireFunctions('firebase-admin/app');
  const { getAuth } = requireFunctions('firebase-admin/auth');
  const { getFirestore } = requireFunctions('firebase-admin/firestore');
  const app = initializeApp({
    credential: applicationDefault(),
    projectId: D1M_STAGING_PROJECT_ID,
  }, `d1m-staging-seed-${Date.now()}`);

  try {
    if (app.options.projectId !== D1M_STAGING_PROJECT_ID) {
      throw new Error('Firebase Admin did not bind to the exact D1M staging project.');
    }

    const firestore = getFirestore(app);
    const fixture = buildD1mStagingDocuments();
    const leagueRef = firestore.doc(`leagues/${D1M_STAGING_LEAGUE_ID}`);
    const leagueSnapshot = await leagueRef.get();
    const nestedCollections = await leagueRef.listCollections();

    if (
      leagueSnapshot.exists &&
      leagueSnapshot.data()?.fixtureMarker !== D1M_STAGING_FIXTURE_MARKER
    ) {
      throw new Error('The fixed D1M staging league is not the synthetic fixture.');
    }

    if (!leagueSnapshot.exists && nestedCollections.length > 0) {
      throw new Error('The fixed D1M staging league has unowned nested data.');
    }

    const ownedGlobalPaths = [
      `users/${D1M_STAGING_ADMIN_ID}`,
      `users/${D1M_STAGING_NON_ADMIN_ID}`,
      `platformAdmins/${D1M_STAGING_ADMIN_ID}`,
      `platformAdmins/${D1M_STAGING_NON_ADMIN_ID}`,
      ...Object.values(D1M_STAGING_GAME_IDS).map(
        (gameId) => `nhlCanonicalGameFacts/${gameId}`,
      ),
    ];
    const globalSnapshots = await firestore.getAll(
      ...ownedGlobalPaths.map((path) => firestore.doc(path)),
    );

    for (const snapshot of globalSnapshots) {
      if (
        snapshot.exists &&
        snapshot.data()?.fixtureMarker !== D1M_STAGING_FIXTURE_MARKER
      ) {
        throw new Error(
          `The fixed D1M staging path ${snapshot.ref.path} is not the synthetic fixture.`,
        );
      }
    }

    const auth = getAuth(app);
    const [adminUser, nonAdminUser] = await Promise.all([
      upsertFixedAuthUser(auth, {
        uid: D1M_STAGING_ADMIN_ID,
        email: D1M_STAGING_ADMIN_EMAIL,
        displayName: 'D1M Reconciliation Admin',
        password,
      }),
      upsertFixedAuthUser(auth, {
        uid: D1M_STAGING_NON_ADMIN_ID,
        email: D1M_STAGING_NON_ADMIN_EMAIL,
        displayName: 'D1M Non Admin',
        password,
      }),
    ]);

    if (
      adminUser.uid !== fixture.adminId ||
      nonAdminUser.uid !== fixture.nonAdminId
    ) {
      throw new Error('The synthetic Auth and Firestore fixture identities do not match.');
    }

    if (leagueSnapshot.exists) {
      await firestore.recursiveDelete(leagueRef);
    }

    const writer = firestore.bulkWriter();

    for (const path of ownedGlobalPaths) {
      if (!fixture.documents.has(path)) {
        writer.delete(firestore.doc(path));
      }
    }

    for (const [path, data] of fixture.documents) {
      writer.set(firestore.doc(path), data);
    }

    await writer.close();

    return {
      projectId: D1M_STAGING_PROJECT_ID,
      leagueLabel: 'd1m-final-score-reconciliation-fixture',
      accountCount: 2,
      teamCount: 1,
      windowCount: fixture.windowCount,
      canonicalDocumentCount: 3,
      expectedOutcomes: {
        verified: 1,
        candidate: 1,
        unverifiable: 2,
      },
    };
  } finally {
    await deleteApp(app);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedD1mStagingFixture()
    .then((result) => {
      console.log('The isolated D1M reconciliation staging fixture is ready.');
      console.log(JSON.stringify(result, null, 2));
      console.log('No account ID, email, password, player ID, or game ID was printed.');
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
