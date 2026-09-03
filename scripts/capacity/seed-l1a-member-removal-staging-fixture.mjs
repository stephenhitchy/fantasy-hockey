import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const L1A_STAGING_PROJECT_ID = 'rinkrat-staging-d1nc-2026';
export const L1A_STAGING_LEAGUE_ID = 'l1a-member-removal-fixture';
export const L1A_STAGING_COMMISSIONER_ID = 'l1a-removal-commissioner';
export const L1A_STAGING_TARGET_ID = 'l1a-removal-member';
export const L1A_STAGING_COMMISSIONER_EMAIL =
  'commissioner@l1a.rinkrat.test';
export const L1A_STAGING_TARGET_EMAIL = 'member@l1a.rinkrat.test';
export const L1A_STAGING_TARGET_TEAM_NAME = 'L1A Removal Test Rats';
export const L1A_STAGING_FIXTURE_MARKER =
  'rinkrat-l1a-member-removal-fixture-v1';
export const L1A_STAGING_SEED_ACKNOWLEDGEMENT =
  `reset-and-seed-${L1A_STAGING_FIXTURE_MARKER}-in-${L1A_STAGING_PROJECT_ID}`;

const L1A_STAGING_INVITE_CODE = 'L1ASTG';
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
      'L1A_STAGING_FIXTURE_PASSWORD must be 20–128 characters with upper, lower, number, and symbol.',
    );
  }
}

export function assertL1aStagingConnectionSafety(environment = process.env) {
  if (
    environment.FIRESTORE_EMULATOR_HOST ||
    environment.FIREBASE_AUTH_EMULATOR_HOST ||
    environment.FIREBASE_DATABASE_EMULATOR_HOST
  ) {
    throw new Error('L1A staging tooling refuses every Emulator Suite environment.');
  }

  if (environment.L1A_STAGING_PROJECT_ID !== L1A_STAGING_PROJECT_ID) {
    throw new Error(
      `L1A_STAGING_PROJECT_ID must equal ${L1A_STAGING_PROJECT_ID}.`,
    );
  }

  const password = environment.L1A_STAGING_FIXTURE_PASSWORD ?? '';
  assertStrongFixturePassword(password);
  return { password };
}

export function assertL1aStagingSeedSafety(environment = process.env) {
  const connectionSafety = assertL1aStagingConnectionSafety(environment);

  if (environment.L1A_STAGING_ACK !== L1A_STAGING_SEED_ACKNOWLEDGEMENT) {
    throw new Error(
      'L1A_STAGING_ACK does not authorize the exact member-removal fixture reset.',
    );
  }

  return connectionSafety;
}

function emptyRoster() {
  return {
    schemaVersion: 2,
    activeSlots: [{
      slotId: 'C-1',
      position: 'C',
      slotNumber: 1,
      asset: null,
      pendingMove: null,
      openFromCycleNumber: null,
    }],
    benchSlots: [{
      slotId: 'B-1',
      slotNumber: 1,
      asset: null,
      pendingMove: null,
    }],
    irSlots: [{
      slotId: 'IR-1',
      slotNumber: 1,
      asset: null,
      pendingMove: null,
    }],
  };
}

function team(ownerId, teamName, managerName, draftPosition, now) {
  return {
    schemaVersion: 1,
    id: ownerId,
    ownerId,
    teamName,
    managerName,
    profileIconId: 'hockey-referee',
    logo: '',
    wins: 0,
    losses: 0,
    ties: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    waiverPriority: draftPosition,
    draftPosition,
    authority: 'cloud-function',
    accountDeleted: false,
    accountDeletedAt: null,
    fixtureMarker: L1A_STAGING_FIXTURE_MARKER,
    createdAt: now,
    updatedAt: now,
  };
}

function member(uid, username, role, now) {
  return {
    schemaVersion: 1,
    uid,
    leagueId: L1A_STAGING_LEAGUE_ID,
    username,
    profileIconId: 'hockey-referee',
    role,
    inviteCodeUsed: role === 'commissioner' ? null : L1A_STAGING_INVITE_CODE,
    authority: 'cloud-function',
    accountDeleted: false,
    accountDeletedAt: null,
    fixtureMarker: L1A_STAGING_FIXTURE_MARKER,
    joinedAt: now,
    updatedAt: now,
  };
}

function user(uid, email, username, now) {
  return {
    uid,
    email,
    username,
    favoriteTeamAbbreviation: 'MIN',
    favoriteTeamVariantId: 'current-home',
    teamIdentityUnlocks: [],
    reducedMotion: false,
    defaultLandingPage: 'dashboard',
    backgroundTheme: 'rink-dark',
    injuryEmailEnabled: false,
    hockeyExperience: 'advanced',
    trainingCampVersion: 0,
    profileIconId: 'hockey-referee',
    fixtureMarker: L1A_STAGING_FIXTURE_MARKER,
    createdAt: now,
    updatedAt: now,
  };
}

export function buildL1aStagingDocuments(now = new Date()) {
  const leagueId = L1A_STAGING_LEAGUE_ID;
  const commissionerId = L1A_STAGING_COMMISSIONER_ID;
  const targetId = L1A_STAGING_TARGET_ID;
  const documents = new Map();

  documents.set(`users/${commissionerId}`, user(
    commissionerId,
    L1A_STAGING_COMMISSIONER_EMAIL,
    'L1A Commissioner',
    now,
  ));
  documents.set(`publicProfiles/${commissionerId}`, {
    uid: commissionerId,
    username: 'L1A Commissioner',
    profileIconId: 'hockey-referee',
    fixtureMarker: L1A_STAGING_FIXTURE_MARKER,
    updatedAt: now,
  });
  documents.set(`users/${targetId}`, user(
    targetId,
    L1A_STAGING_TARGET_EMAIL,
    'L1A Removed Manager',
    now,
  ));
  documents.set(`publicProfiles/${targetId}`, {
    uid: targetId,
    username: 'L1A Removed Manager',
    profileIconId: 'hockey-referee',
    fixtureMarker: L1A_STAGING_FIXTURE_MARKER,
    updatedAt: now,
  });
  documents.set(`leagues/${leagueId}`, {
    id: leagueId,
    name: 'L1A Member Removal Fixture',
    leagueLogoId: 'rink-rat',
    leagueLogoPaletteId: 'rink-gold',
    commissionerId,
    inviteCode: L1A_STAGING_INVITE_CODE,
    maxTeams: 4,
    teamCount: 2,
    joinStatus: 'open',
    joinLockedAt: null,
    joinLockedReason: null,
    matchupFormat: 'cycle_matchup',
    requiredGamesPerCycle: 6,
    scoringRules: {},
    scoringRulesVersion: 4,
    authoritySchemaVersion: 2,
    documentSchemaVersion: 1,
    createdByAuthority: 'cloud-function',
    competitionSettingsLocked: false,
    fixtureMarker: L1A_STAGING_FIXTURE_MARKER,
    createdAt: now,
    updatedAt: now,
  });
  documents.set(`leagueInvites/${L1A_STAGING_INVITE_CODE}`, {
    schemaVersion: 1,
    inviteCode: L1A_STAGING_INVITE_CODE,
    leagueId,
    createdBy: commissionerId,
    active: true,
    joinCount: 2,
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
    lockedAt: null,
    lockedReason: null,
    lastJoinedAt: now,
    authority: 'cloud-function',
    fixtureMarker: L1A_STAGING_FIXTURE_MARKER,
    createdAt: now,
    updatedAt: now,
  });
  documents.set(
    `leagues/${leagueId}/members/${commissionerId}`,
    member(commissionerId, 'L1A Commissioner', 'commissioner', now),
  );
  documents.set(
    `leagues/${leagueId}/members/${targetId}`,
    member(targetId, 'L1A Removed Manager', 'member', now),
  );
  documents.set(
    `leagues/${leagueId}/teams/${commissionerId}`,
    team(commissionerId, 'L1A Commissioner Rats', 'L1A Commissioner', 1, now),
  );
  documents.set(
    `leagues/${leagueId}/teams/${targetId}`,
    team(targetId, L1A_STAGING_TARGET_TEAM_NAME, 'L1A Removed Manager', 2, now),
  );
  documents.set(`leagues/${leagueId}/teams/${commissionerId}/roster/current`, {
    ...emptyRoster(),
    fixtureMarker: L1A_STAGING_FIXTURE_MARKER,
    createdAt: now,
    updatedAt: now,
  });
  documents.set(`leagues/${leagueId}/teams/${targetId}/roster/current`, {
    ...emptyRoster(),
    fixtureMarker: L1A_STAGING_FIXTURE_MARKER,
    createdAt: now,
    updatedAt: now,
  });
  documents.set(`leagues/${leagueId}/draft/current/queues/${targetId}`, {
    ownerId: targetId,
    assetKeys: [],
    fixtureMarker: L1A_STAGING_FIXTURE_MARKER,
    createdAt: now,
    updatedAt: now,
  });
  documents.set(`leagueLifecycleState/${targetId}`, {
    schemaVersion: 1,
    activeLeagueCount: 1,
    fixtureMarker: L1A_STAGING_FIXTURE_MARKER,
    createdAt: now,
    updatedAt: now,
  });

  return { documents, leagueId, commissionerId, targetId };
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
    throw new Error('A fixed L1A staging email belongs to a different Auth identity.');
  }

  if (byId && byId.email !== email) {
    throw new Error('A fixed L1A staging Auth identity belongs to a different email.');
  }

  return byEmail ?? byId;
}

async function upsertFixedAuthUser(auth, { uid, email, displayName, password }) {
  const existingUser = await resolveFixedAuthUser(auth, uid, email);

  if (existingUser) {
    return auth.updateUser(uid, {
      email,
      password,
      displayName,
      emailVerified: true,
      disabled: false,
    });
  }

  return auth.createUser({
    uid,
    email,
    password,
    displayName,
    emailVerified: true,
    disabled: false,
  });
}

export async function seedL1aStagingFixture(environment = process.env) {
  const { password } = assertL1aStagingSeedSafety(environment);
  const { applicationDefault, deleteApp, initializeApp } =
    requireFunctions('firebase-admin/app');
  const { getAuth } = requireFunctions('firebase-admin/auth');
  const { getFirestore } = requireFunctions('firebase-admin/firestore');
  const app = initializeApp({
    credential: applicationDefault(),
    projectId: L1A_STAGING_PROJECT_ID,
  }, `l1a-staging-seed-${Date.now()}`);

  try {
    if (app.options.projectId !== L1A_STAGING_PROJECT_ID) {
      throw new Error('Firebase Admin did not bind to the exact L1A staging project.');
    }

    const firestore = getFirestore(app);
    const fixture = buildL1aStagingDocuments();
    const leagueRef = firestore.doc(`leagues/${L1A_STAGING_LEAGUE_ID}`);
    const leagueSnapshot = await leagueRef.get();
    const nestedCollections = await leagueRef.listCollections();

    if (
      leagueSnapshot.exists &&
      leagueSnapshot.data()?.fixtureMarker !== L1A_STAGING_FIXTURE_MARKER
    ) {
      throw new Error('The fixed L1A staging league is not the synthetic fixture.');
    }

    if (!leagueSnapshot.exists && nestedCollections.length > 0) {
      throw new Error('The fixed L1A staging league has unowned nested data.');
    }

    const globalPaths = [...fixture.documents.keys()].filter(
      (path) => !path.startsWith(`${leagueRef.path}/`) && path !== leagueRef.path,
    );
    const globalSnapshots = await firestore.getAll(
      ...globalPaths.map((path) => firestore.doc(path)),
    );

    for (const snapshot of globalSnapshots) {
      if (
        snapshot.exists &&
        snapshot.data()?.fixtureMarker !== L1A_STAGING_FIXTURE_MARKER
      ) {
        throw new Error(
          `The fixed L1A staging path ${snapshot.ref.path} is not the synthetic fixture.`,
        );
      }
    }

    const auth = getAuth(app);
    const [commissionerUser, targetUser] = await Promise.all([
      upsertFixedAuthUser(auth, {
        uid: L1A_STAGING_COMMISSIONER_ID,
        email: L1A_STAGING_COMMISSIONER_EMAIL,
        displayName: 'L1A Commissioner',
        password,
      }),
      upsertFixedAuthUser(auth, {
        uid: L1A_STAGING_TARGET_ID,
        email: L1A_STAGING_TARGET_EMAIL,
        displayName: 'L1A Removed Manager',
        password,
      }),
    ]);

    if (
      commissionerUser.uid !== fixture.commissionerId ||
      targetUser.uid !== fixture.targetId
    ) {
      throw new Error('The synthetic Auth and Firestore fixture identities do not match.');
    }

    if (leagueSnapshot.exists) {
      await firestore.recursiveDelete(leagueRef);
    }

    const writer = firestore.bulkWriter();

    for (const [path, data] of fixture.documents) {
      writer.set(firestore.doc(path), data);
    }

    await writer.close();

    return {
      projectId: L1A_STAGING_PROJECT_ID,
      leagueLabel: 'l1a-member-removal-fixture',
      accountCount: 2,
      teamCount: 2,
      documentCount: fixture.documents.size,
      draftState: 'not-created',
    };
  } finally {
    await deleteApp(app);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedL1aStagingFixture()
    .then((result) => {
      console.log('The isolated L1A member-removal staging fixture is ready.');
      console.log(JSON.stringify(result, null, 2));
      console.log('No account ID, email, invite code, or password was printed.');
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
