import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const D1L_REPLAY_STAGING_PROJECT_ID = 'rinkrat-staging-d1nc-2026';
export const D1L_REPLAY_STAGING_LEAGUE_ID = 'd1l-replay-source-team';
export const D1L_REPLAY_STAGING_COMMISSIONER_ID =
  'd1l-replay-source-team-commissioner';
export const D1L_REPLAY_STAGING_EMAIL = 'commissioner@d1l.rinkrat.test';
export const D1L_REPLAY_STAGING_FIXTURE_MARKER =
  'rinkrat-d1l-replay-source-team-fixture-v1';
export const D1L_REPLAY_STAGING_SEED_ACKNOWLEDGEMENT =
  `reset-and-seed-${D1L_REPLAY_STAGING_FIXTURE_MARKER}-in-${D1L_REPLAY_STAGING_PROJECT_ID}`;

export const D1L_REPLAY_TRADED_ASSET = Object.freeze({
  assetType: 'skater',
  assetKey: 'skater:8480801',
  position: 'LW',
  player: Object.freeze({
    id: 8_480_801,
    fullName: 'Brady Tkachuk',
    position: 'LW',
    nhlTeamAbbreviation: 'FLA',
  }),
  projectedCyclePoints: 71.5,
  projectedSeasonPoints: 850,
  projectionModelVersion: 11,
  availabilityStatus: 'active',
});

const requireFunctions = createRequire(
  new URL('../../functions/package.json', import.meta.url),
);

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
      'D1L_REPLAY_STAGING_FIXTURE_PASSWORD must be 20–128 characters with upper, lower, number, and symbol.',
    );
  }
}

export function assertD1lReplayStagingConnectionSafety(environment = process.env) {
  if (
    environment.FIRESTORE_EMULATOR_HOST ||
    environment.FIREBASE_AUTH_EMULATOR_HOST ||
    environment.FIREBASE_DATABASE_EMULATOR_HOST
  ) {
    throw new Error('D1L replay staging tooling refuses every Emulator Suite environment.');
  }

  if (environment.D1L_REPLAY_STAGING_PROJECT_ID !== D1L_REPLAY_STAGING_PROJECT_ID) {
    throw new Error(
      `D1L_REPLAY_STAGING_PROJECT_ID must equal ${D1L_REPLAY_STAGING_PROJECT_ID}.`,
    );
  }

  const password = environment.D1L_REPLAY_STAGING_FIXTURE_PASSWORD ?? '';
  assertStrongFixturePassword(password);

  return { password };
}

export function assertD1lReplayStagingSafety(environment = process.env) {
  const connectionSafety = assertD1lReplayStagingConnectionSafety(environment);

  if (
    environment.D1L_REPLAY_STAGING_ACK !==
    D1L_REPLAY_STAGING_SEED_ACKNOWLEDGEMENT
  ) {
    throw new Error('D1L_REPLAY_STAGING_ACK does not authorize the exact replay fixture reset.');
  }

  return connectionSafety;
}

function buildRosterAsset() {
  return {
    ...D1L_REPLAY_TRADED_ASSET,
    rosterStatus: 'active',
    eligibleFromCycleNumber: 1,
  };
}

export function buildD1lReplayStagingDocuments(
  commissionerId,
  now = new Date(),
  fixtureRequestId = 'd1lreplay_fixture',
) {
  if (typeof commissionerId !== 'string' || commissionerId.trim().length === 0) {
    throw new Error('A synthetic commissioner ID is required.');
  }

  const ownerId = commissionerId.trim();
  const leagueId = D1L_REPLAY_STAGING_LEAGUE_ID;
  const asset = { ...D1L_REPLAY_TRADED_ASSET };
  const pick = {
    overallPick: 1,
    round: 1,
    pickInRound: 1,
    ownerId,
    rosterArea: 'active',
    rosterSlotId: 'LW-1',
    cycleWindowId: `${ownerId}__LW-1__cycle-1`,
    snapshotCycleNumber: 1,
    snapshotOrder: 1,
    selectionType: 'manual',
    asset,
    madeAt: now,
    snapshottedAt: now,
  };
  const documents = new Map();

  documents.set(`users/${ownerId}`, {
    uid: ownerId,
    email: D1L_REPLAY_STAGING_EMAIL,
    username: 'D1L Replay Commissioner',
    favoriteTeamAbbreviation: 'FLA',
    favoriteTeamVariantId: 'current-home',
    teamIdentityUnlocks: [],
    reducedMotion: false,
    defaultLandingPage: 'dashboard',
    backgroundTheme: 'rink-dark',
    injuryEmailEnabled: false,
    hockeyExperience: 'advanced',
    trainingCampVersion: 0,
    fixtureMarker: D1L_REPLAY_STAGING_FIXTURE_MARKER,
    createdAt: now,
    updatedAt: now,
  });
  documents.set(`publicProfiles/${ownerId}`, {
    uid: ownerId,
    username: 'D1L Replay Commissioner',
    favoriteTeamAbbreviation: 'FLA',
    favoriteTeamVariantId: 'current-home',
    fixtureMarker: D1L_REPLAY_STAGING_FIXTURE_MARKER,
    updatedAt: now,
  });
  documents.set(`platformAdmins/${ownerId}`, {
    enabled: true,
    fixtureMarker: D1L_REPLAY_STAGING_FIXTURE_MARKER,
    updatedAt: now,
  });
  documents.set(`leagues/${leagueId}`, {
    id: leagueId,
    name: 'D1L Replay Source-Team Fixture',
    commissionerId: ownerId,
    inviteCode: 'D1LSTG',
    maxTeams: 1,
    teamCount: 1,
    joinStatus: 'full',
    matchupFormat: 'cycle_matchup',
    scoringRules: {},
    scoringRulesVersion: 4,
    authoritySchemaVersion: 1,
    competitionSettingsLocked: true,
    fixtureMarker: D1L_REPLAY_STAGING_FIXTURE_MARKER,
    createdAt: now,
    updatedAt: now,
  });
  documents.set(`leagues/${leagueId}/members/${ownerId}`, {
    uid: ownerId,
    leagueId,
    username: 'D1L Replay Commissioner',
    role: 'commissioner',
    inviteCodeUsed: null,
    fixtureMarker: D1L_REPLAY_STAGING_FIXTURE_MARKER,
    joinedAt: now,
  });
  documents.set(`leagues/${leagueId}/teams/${ownerId}`, {
    id: ownerId,
    ownerId,
    teamName: 'D1L Source-Team Testers',
    managerName: 'D1L Replay Commissioner',
    logo: '',
    wins: 0,
    losses: 0,
    ties: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    waiverPriority: 1,
    draftPosition: 1,
    fixtureMarker: D1L_REPLAY_STAGING_FIXTURE_MARKER,
    createdAt: now,
    updatedAt: now,
  });
  documents.set(`leagues/${leagueId}/teams/${ownerId}/roster/current`, {
    schemaVersion: 2,
    activeSlots: [{
      slotId: 'LW-1',
      position: 'LW',
      slotNumber: 1,
      asset: buildRosterAsset(),
      pendingMove: null,
      openFromCycleNumber: null,
    }],
    benchSlots: [],
    irSlots: [],
    fixtureMarker: D1L_REPLAY_STAGING_FIXTURE_MARKER,
    createdAt: now,
    updatedAt: now,
  });
  documents.set(`leagues/${leagueId}/draft/current`, {
    schemaVersion: 2,
    status: 'complete',
    format: 'snake',
    totalRounds: 1,
    rosterRequirements: { LW: 1, C: 0, RW: 0, D: 0, G: 0 },
    benchSlots: 0,
    roundOneOrder: [ownerId],
    nextOverallPick: 2,
    draftedAssetKeys: [asset.assetKey],
    scheduledStartAt: null,
    pickSeconds: 120,
    clockStatus: 'complete',
    pickStartedAt: null,
    currentPickSeconds: 120,
    pausedRemainingSeconds: 0,
    clockUpdatedBy: ownerId,
    clockUpdatedAt: now,
    lastPickId: '001',
    fixtureMarker: D1L_REPLAY_STAGING_FIXTURE_MARKER,
    createdAt: now,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  });
  documents.set(`leagues/${leagueId}/draft/current/picks/001`, {
    ...pick,
    fixtureMarker: D1L_REPLAY_STAGING_FIXTURE_MARKER,
  });
  documents.set(`leagues/${leagueId}/cycles/cycle-1`, {
    id: 'cycle-1',
    cycleNumber: 1,
    status: 'active',
    phase: 'regular_season',
    matchupIds: ['matchup-1'],
    windowSchemaVersion: 1,
    expectedRosterSlotIdsByOwner: { [ownerId]: ['LW-1'] },
    totalExpectedWindowCount: 1,
    activeWindowCount: 1,
    completedWindowCount: 0,
    matchupCompletionSchemaVersion: 1,
    totalMatchupCount: 1,
    completedMatchupCount: 0,
    pendingMatchupCount: 1,
    fixtureMarker: D1L_REPLAY_STAGING_FIXTURE_MARKER,
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  documents.set(
    `leagues/${leagueId}/cycles/cycle-1/matchups/matchup-1`,
    {
      id: 'matchup-1',
      cycleNumber: 1,
      phase: 'regular_season',
      teamAOwnerId: ownerId,
      teamBOwnerId: null,
      teamAScore: 0,
      teamBScore: 0,
      winnerOwnerId: null,
      status: 'active',
      completedAt: null,
      fixtureMarker: D1L_REPLAY_STAGING_FIXTURE_MARKER,
      createdAt: now,
      updatedAt: now,
    },
  );
  documents.set(
    `leagues/${leagueId}/cycles/cycle-1/rosterPicks/${ownerId}__LW-1`,
    {
      ...pick,
      fixtureMarker: D1L_REPLAY_STAGING_FIXTURE_MARKER,
    },
  );
  documents.set(`leagues/${leagueId}/historicalReplay/control`, {
    schemaVersion: 2,
    enabled: false,
    status: 'inactive',
    targetSeason: '20262027',
    sourceSeason: '20252026',
    simulatedDate: null,
    seasonStartDate: null,
    daysAdvanced: 0,
    lastReleasedGameCount: 0,
    totalReleasedGameCount: 0,
    message: 'Synthetic D1L replay fixture is ready.',
    lastError: '',
    lastActiveCycleNumbers: [1],
    fixtureRequestId,
    fixtureMarker: D1L_REPLAY_STAGING_FIXTURE_MARKER,
    createdAt: now,
    updatedAt: now,
  });
  documents.set(`leagues/${leagueId}/liveScoring/control`, {
    id: 'control',
    schemaVersion: 2,
    automationMode: 'historical-replay',
    serverAutomationEnabled: true,
    historicalReplayEnabled: false,
    historicalReplayDate: null,
    status: 'idle',
    holderUserId: null,
    holderClientId: '',
    lastError: '',
    nextRefreshAt: now,
    fixtureMarker: D1L_REPLAY_STAGING_FIXTURE_MARKER,
    updatedAt: now,
  });

  return { documents, ownerId, leagueId, assetKey: asset.assetKey };
}

export async function seedD1lReplayStagingFixture(environment = process.env) {
  const { password } = assertD1lReplayStagingSafety(environment);
  const { applicationDefault, deleteApp, initializeApp } =
    requireFunctions('firebase-admin/app');
  const { getAuth } = requireFunctions('firebase-admin/auth');
  const { getFirestore } = requireFunctions('firebase-admin/firestore');
  const app = initializeApp({
    credential: applicationDefault(),
    projectId: D1L_REPLAY_STAGING_PROJECT_ID,
  }, `d1l-replay-staging-seed-${Date.now()}`);

  try {
    if (app.options.projectId !== D1L_REPLAY_STAGING_PROJECT_ID) {
      throw new Error('Firebase Admin did not bind to the exact D1L staging project.');
    }

    const firestore = getFirestore(app);
    const leagueRef = firestore.doc(`leagues/${D1L_REPLAY_STAGING_LEAGUE_ID}`);
    const fixtureRequestId = `d1lreplay_${randomUUID().replaceAll('-', '')}`;
    const fixture = buildD1lReplayStagingDocuments(
      D1L_REPLAY_STAGING_COMMISSIONER_ID,
      new Date(),
      fixtureRequestId,
    );
    const fixtureSnapshots = await firestore.getAll(
      ...[...fixture.documents.keys()].map((path) => firestore.doc(path)),
    );

    for (const snapshot of fixtureSnapshots) {
      if (
        snapshot.exists &&
        snapshot.data()?.fixtureMarker !== D1L_REPLAY_STAGING_FIXTURE_MARKER
      ) {
        throw new Error(
          `The fixed D1L staging path ${snapshot.ref.path} exists without the exact synthetic fixture marker. Refusing to replace it.`,
        );
      }
    }

    const auth = getAuth(app);
    let existingAuthUser = null;

    try {
      existingAuthUser = await auth.getUserByEmail(D1L_REPLAY_STAGING_EMAIL);

      if (existingAuthUser.uid !== D1L_REPLAY_STAGING_COMMISSIONER_ID) {
        throw new Error(
          'The fixed D1L staging email belongs to a different Auth identity. Refusing to take it over.',
        );
      }
    } catch (error) {
      if (error?.code !== 'auth/user-not-found') {
        throw error;
      }
    }

    try {
      const userAtFixtureId = await auth.getUser(D1L_REPLAY_STAGING_COMMISSIONER_ID);

      if (userAtFixtureId.email !== D1L_REPLAY_STAGING_EMAIL) {
        throw new Error(
          'The fixed D1L staging Auth identity belongs to a different email. Refusing to take it over.',
        );
      }

      existingAuthUser = userAtFixtureId;
    } catch (error) {
      if (error?.code !== 'auth/user-not-found') {
        throw error;
      }
    }

    const existingControlData = fixtureSnapshots.find(
      (snapshot) =>
        snapshot.ref.path === `${leagueRef.path}/historicalReplay/control`,
    )?.data();
    const previousRequestId =
      typeof existingControlData?.fixtureRequestId === 'string'
        ? existingControlData.fixtureRequestId
        : null;
    const hasExistingLeagueData = fixtureSnapshots.some((snapshot) =>
      snapshot.exists && (
        snapshot.ref.path === leagueRef.path ||
        snapshot.ref.path.startsWith(`${leagueRef.path}/`)
      ),
    );

    if (previousRequestId && /^[A-Za-z0-9_-]{8,96}$/.test(previousRequestId)) {
      const previousRequestRef = firestore.doc(
        `historicalReplayRequests/${previousRequestId}`,
      );
      const previousRequestSnapshot = await previousRequestRef.get();
      const previousRequestData = previousRequestSnapshot.data();

      if (
        previousRequestSnapshot.exists &&
        (
          previousRequestData?.leagueId !== D1L_REPLAY_STAGING_LEAGUE_ID ||
          previousRequestData?.requestedBy !== D1L_REPLAY_STAGING_COMMISSIONER_ID
        )
      ) {
        throw new Error(
          'The preceding replay request does not belong to the exact synthetic fixture. Refusing to delete it.',
        );
      }

      await previousRequestRef.delete();
    }

    if (hasExistingLeagueData) {
      await firestore.recursiveDelete(leagueRef);
    }

    let user;

    if (existingAuthUser) {
      user = await auth.updateUser(existingAuthUser.uid, {
        password,
        emailVerified: true,
        disabled: false,
      });
    } else {
      user = await auth.createUser({
        uid: D1L_REPLAY_STAGING_COMMISSIONER_ID,
        email: D1L_REPLAY_STAGING_EMAIL,
        password,
        emailVerified: true,
        disabled: false,
        displayName: 'D1L Replay Commissioner',
      });
    }

    if (user.uid !== fixture.ownerId) {
      throw new Error('The synthetic Auth and Firestore fixture identities do not match.');
    }

    const writer = firestore.bulkWriter();

    for (const [path, data] of fixture.documents) {
      writer.set(firestore.doc(path), data);
    }

    await writer.close();

    return {
      projectId: D1L_REPLAY_STAGING_PROJECT_ID,
      leagueId: fixture.leagueId,
      email: D1L_REPLAY_STAGING_EMAIL,
      assetLabel: 'traded-skater',
      sourceSeason: '20252026',
      targetSeason: '20262027',
      documentCount: fixture.documents.size,
    };
  } finally {
    await deleteApp(app);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedD1lReplayStagingFixture()
    .then((result) => {
      console.log('The isolated D1L replay staging fixture is ready.');
      console.log(JSON.stringify(result, null, 2));
      console.log('The fixture password was not printed or persisted.');
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
