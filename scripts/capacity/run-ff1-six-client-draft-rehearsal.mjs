import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { deleteApp as deleteClientApp, initializeApp as initializeClientApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import {
  disableNetwork,
  doc,
  enableNetwork,
  getDocFromServer,
  getFirestore as getClientFirestore,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';

import { D1N_STAGING_PROJECT_ID } from './prepare-d1n-staging-hosting.mjs';
import { buildD1nFixtureDocuments } from './seed-d1n-route-fixture.mjs';
import {
  readCleanGitRevision,
  verifyFf1ReadinessStagingManifest,
} from './run-ff1-draft-readiness-staging-evidence.mjs';

export const FF1_SIX_CLIENT_STAGING_ACKNOWLEDGEMENT =
  `exercise-ff1-six-client-draft-in-${D1N_STAGING_PROJECT_ID}`;
export const FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID = 'ff1-six-client-draft';
export const FF1_SIX_CLIENT_FIXTURE_TYPE = 'ff1-six-client-draft-v1';
export const FF1_SIX_CLIENT_MANAGER_COUNT = 6;
export const FF1_SIX_CLIENT_TOTAL_ROUNDS = 17;
export const FF1_SIX_CLIENT_TOTAL_PICKS =
  FF1_SIX_CLIENT_MANAGER_COUNT * FF1_SIX_CLIENT_TOTAL_ROUNDS;

const FIREBASE_OPTIONS = Object.freeze({
  apiKey: 'AIzaSyDejIpv-Pi1iDcuKSgDyVK_5h2s9kZ05sY',
  authDomain: 'rinkrat-staging-d1nc-2026.firebaseapp.com',
  projectId: D1N_STAGING_PROJECT_ID,
  storageBucket: 'rinkrat-staging-d1nc-2026.firebasestorage.app',
  messagingSenderId: '817415114086',
  appId: '1:817415114086:web:d8be39fcb0b05074b28ca7',
});
const ALLOWED_TOOLING_PATHS = Object.freeze([
  'docs/RINKRAT_CODEX_HANDOFF.md',
  'docs/RINKRAT_FF1_DRAFT_GATE_RUNBOOK.md',
  'package.json',
  'scripts/capacity/run-ff1-six-client-draft-rehearsal.mjs',
  'test/batchff1-13-six-client-rehearsal/six-client-rehearsal.test.mjs',
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_REVISION_PATTERN = /^[a-f0-9]{40}$/;
const DEFAULT_READINESS_TIMEOUT_MILLISECONDS = 20 * 60 * 1000;
const DEFAULT_ACTION_TIMEOUT_MILLISECONDS = 90 * 1000;
const DRAFT_START_OFFSET_MILLISECONDS = 30 * 60 * 1000;
const DRAFT_PICK_SECONDS = 30;
const POLL_INTERVAL_MILLISECONDS = 500;
const requireFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));

function runGit(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout: 60_000,
  });

  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed.`);
  }

  return result.stdout.trim();
}

export function assertFf1SixClientStagingSafety(environment = process.env) {
  if (
    environment.FIRESTORE_EMULATOR_HOST ||
    environment.FIREBASE_AUTH_EMULATOR_HOST ||
    environment.FIREBASE_DATABASE_EMULATOR_HOST
  ) {
    throw new Error('FF1 six-client staging evidence refuses every Emulator Suite environment.');
  }

  if (environment.FF1_SIX_CLIENT_STAGING_PROJECT_ID !== D1N_STAGING_PROJECT_ID) {
    throw new Error(`FF1_SIX_CLIENT_STAGING_PROJECT_ID must equal ${D1N_STAGING_PROJECT_ID}.`);
  }

  if (
    environment.FF1_SIX_CLIENT_STAGING_ACK !==
    FF1_SIX_CLIENT_STAGING_ACKNOWLEDGEMENT
  ) {
    throw new Error('FF1_SIX_CLIENT_STAGING_ACK does not authorize the exact rehearsal.');
  }

  const deployedReleaseRevision =
    environment.FF1_SIX_CLIENT_DEPLOYED_RELEASE_REVISION?.trim() ?? '';

  if (!GIT_REVISION_PATTERN.test(deployedReleaseRevision)) {
    throw new Error('FF1_SIX_CLIENT_DEPLOYED_RELEASE_REVISION must be one full Git revision.');
  }

  const readinessTimeoutMilliseconds = Number(
    environment.FF1_SIX_CLIENT_READINESS_TIMEOUT_MILLISECONDS ??
      DEFAULT_READINESS_TIMEOUT_MILLISECONDS,
  );

  if (
    !Number.isInteger(readinessTimeoutMilliseconds) ||
    readinessTimeoutMilliseconds < 5 * 60 * 1000 ||
    readinessTimeoutMilliseconds > 20 * 60 * 1000
  ) {
    throw new Error(
      'FF1_SIX_CLIENT_READINESS_TIMEOUT_MILLISECONDS must be 300000 through 1200000.',
    );
  }

  return { deployedReleaseRevision, readinessTimeoutMilliseconds };
}

export function assertFf1SixClientToolingDelta(
  deployedReleaseRevision,
  toolingRevision = readCleanGitRevision(),
) {
  const ancestor = runGit(['merge-base', '--is-ancestor', deployedReleaseRevision, toolingRevision]);
  assert.equal(ancestor, '');
  const changedPaths = runGit([
    'diff',
    '--name-only',
    `${deployedReleaseRevision}..${toolingRevision}`,
  ]).split('\n').filter(Boolean);
  const unexpectedPaths = changedPaths.filter((path) => !ALLOWED_TOOLING_PATHS.includes(path));

  assert.deepEqual(
    unexpectedPaths,
    [],
    'The reviewed tooling revision contains runtime or deployment-input changes after the deployed release.',
  );

  return { toolingRevision, changedPaths };
}

export function assertExistingFf1SixClientFixtureSafety({
  exists,
  data,
  pickCount,
}) {
  if (!exists) {
    assert.equal(pickCount, 0);
    return;
  }

  assert.equal(data?.fixtureType, FF1_SIX_CLIENT_FIXTURE_TYPE);
  assert.equal(data?.id, FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID);
  assert.equal(data?.name, 'FF1 Six-Client Draft Rehearsal');
  assert.equal(data?.maxTeams, FF1_SIX_CLIENT_MANAGER_COUNT);
  assert.equal(data?.teamCount, FF1_SIX_CLIENT_MANAGER_COUNT);
  assert.ok(Number.isInteger(pickCount) && pickCount >= 0);
  assert.ok(
    pickCount <= FF1_SIX_CLIENT_TOTAL_PICKS,
    'The guarded fixture contains more Draft picks than one six-manager Draft.',
  );
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForValue(readValue, predicate, timeoutMilliseconds, label) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMilliseconds) {
    const value = await readValue();

    if (predicate(value)) {
      return value;
    }

    await wait(POLL_INTERVAL_MILLISECONDS);
  }

  throw new Error(`${label} did not converge before the bounded timeout.`);
}

function managerIdentity(index) {
  const ordinal = index + 1;

  return {
    alias: `manager-${ordinal}`,
    uid: `ff1-six-client-manager-${ordinal}`,
    email: `manager-${ordinal}@ff1-draft.rinkrat.test`,
    teamName: `FF1 Rehearsal Team ${ordinal}`,
  };
}

function createPassword() {
  return `Ff1!${randomBytes(28).toString('base64url')}`;
}

async function prepareSharedAvailability(firestore, commissionerId) {
  const snapshot = await firestore.doc('appData/playerAvailability').get();
  const records = snapshot.data()?.records;

  assert.ok(snapshot.exists, 'The isolated staging availability fixture is missing.');
  assert.equal(snapshot.get('status'), 'success');
  assert.ok(Array.isArray(records) && records.length === 20);
  assert.equal(
    records.every((record, index) =>
      record?.playerId === 10_000 + index && record?.updatedBy === 'd1n-local-fixture'),
    true,
    'The shared availability document is not the bounded D1N staging fixture.',
  );

  const now = new Date();
  const fixture = buildD1nFixtureDocuments(commissionerId, now, {
    draftStatus: 'scheduled',
    draftStartOffsetMinutes: 30,
  });
  const availability = fixture.documents.get('appData/playerAvailability');

  assert.ok(availability);
  assert.equal(availability.lastDailySyncKey, now.toISOString().slice(0, 10));
  await firestore.doc('appData/playerAvailability').set(availability);
}

async function resetExistingFixture(firestore) {
  const leagueRef = firestore.doc(`leagues/${FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID}`);
  const [leagueSnapshot, picksSnapshot] = await Promise.all([
    leagueRef.get(),
    leagueRef
      .collection('draft')
      .doc('current')
      .collection('picks')
      .limit(FF1_SIX_CLIENT_TOTAL_PICKS + 1)
      .get(),
  ]);

  assertExistingFf1SixClientFixtureSafety({
    exists: leagueSnapshot.exists,
    data: leagueSnapshot.data(),
    pickCount: picksSnapshot.size,
  });

  if (leagueSnapshot.exists) {
    await firestore.recursiveDelete(leagueRef);
  }
}

async function createOrRefreshFixtureUsers(auth, identities, password) {
  for (const identity of identities) {
    try {
      await auth.getUser(identity.uid);
      await auth.updateUser(identity.uid, {
        email: identity.email,
        password,
        emailVerified: true,
        disabled: false,
        displayName: identity.alias,
      });
    } catch (error) {
      if (error?.code !== 'auth/user-not-found') {
        throw error;
      }

      await auth.createUser({
        uid: identity.uid,
        email: identity.email,
        password,
        emailVerified: true,
        disabled: false,
        displayName: identity.alias,
      });
    }
  }
}

async function disableFixtureUsers(auth, identities) {
  await Promise.all(
    identities.map((identity) => auth.updateUser(identity.uid, { disabled: true })),
  );
  const disabledUsers = await Promise.all(
    identities.map((identity) => auth.getUser(identity.uid)),
  );

  assert.equal(
    disabledUsers.every((user) => user.disabled === true),
    true,
    'Every synthetic rehearsal account must be verified disabled before evidence can pass.',
  );
}

async function seedFixtureDocuments(firestore, identities) {
  const now = new Date();
  const template = buildD1nFixtureDocuments(identities[0].uid, now, {
    draftStatus: 'scheduled',
    draftStartOffsetMinutes: 30,
  });
  const templateRoster = template.documents.get(
    `leagues/d1n-capacity-league/teams/${identities[0].uid}/roster/current`,
  );
  const templateLeague = template.documents.get('leagues/d1n-capacity-league');
  const templateTeam = template.documents.get(
    `leagues/d1n-capacity-league/teams/${identities[0].uid}`,
  );
  assert.ok(templateLeague && templateTeam && templateRoster);
  const writer = firestore.bulkWriter();
  const leaguePrefix = `leagues/${FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID}`;

  writer.create(firestore.doc(leaguePrefix), {
    ...templateLeague,
    id: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
    name: 'FF1 Six-Client Draft Rehearsal',
    commissionerId: identities[0].uid,
    inviteCode: null,
    maxTeams: FF1_SIX_CLIENT_MANAGER_COUNT,
    teamCount: FF1_SIX_CLIENT_MANAGER_COUNT,
    joinStatus: 'open',
    fixtureType: FF1_SIX_CLIENT_FIXTURE_TYPE,
    fixtureAuthority: 'guarded-admin-provisioning-only',
    createdAt: now,
    updatedAt: now,
  });

  writer.create(firestore.doc(`${leaguePrefix}/draft/current`), {
    schemaVersion: 3,
    status: 'setup',
    format: 'snake',
    totalRounds: FF1_SIX_CLIENT_TOTAL_ROUNDS,
    rosterRequirements: { LW: 3, C: 3, RW: 3, D: 4, G: 1 },
    benchSlots: 3,
    roundOneOrder: identities.map((identity) => identity.uid),
    nextOverallPick: 1,
    draftedAssetKeys: [],
    scheduledStartAt: null,
    pickSeconds: DRAFT_PICK_SECONDS,
    clockStatus: 'stopped',
    pickStartedAt: null,
    currentPickSeconds: DRAFT_PICK_SECONDS,
    pausedRemainingSeconds: null,
    clockUpdatedBy: null,
    clockUpdatedAt: now,
    lastPickId: null,
    createdAt: now,
    updatedAt: now,
  });

  identities.forEach((identity, index) => {
    writer.set(firestore.doc(`users/${identity.uid}`), {
      uid: identity.uid,
      email: identity.email,
      username: identity.alias,
      profileIconId: 'emerald-visor',
      createdAt: now,
      updatedAt: now,
    });
    writer.set(firestore.doc(`publicProfiles/${identity.uid}`), {
      uid: identity.uid,
      username: identity.alias,
      updatedAt: now,
    });
    writer.create(firestore.doc(`${leaguePrefix}/members/${identity.uid}`), {
      schemaVersion: 1,
      uid: identity.uid,
      leagueId: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      username: identity.alias,
      profileIconId: 'emerald-visor',
      role: index === 0 ? 'commissioner' : 'manager',
      inviteCodeUsed: null,
      joinedAt: now,
      authority: 'guarded-staging-fixture',
    });
    writer.create(firestore.doc(`${leaguePrefix}/teams/${identity.uid}`), {
      ...templateTeam,
      id: identity.uid,
      ownerId: identity.uid,
      teamName: identity.teamName,
      managerName: identity.alias,
      draftPosition: index + 1,
      createdAt: now,
      updatedAt: now,
    });
    writer.create(firestore.doc(`${leaguePrefix}/teams/${identity.uid}/roster/current`), {
      ...templateRoster,
      createdAt: now,
      updatedAt: now,
    });
    writer.create(firestore.doc(`${leaguePrefix}/draft/current/queues/${identity.uid}`), {
      ownerId: identity.uid,
      assetKeys: [],
      autoDraftEnabled: false,
      consecutiveClockExpirations: 0,
      autoDraftActivatedByTimeout: false,
      updatedAt: now,
    });
  });

  await writer.close();
}

async function createAuthenticatedClients(identities, password) {
  const clients = [];

  for (const identity of identities) {
    const app = initializeClientApp(
      FIREBASE_OPTIONS,
      `ff1-six-client-${identity.alias}-${Date.now()}-${randomUUID()}`,
    );
    const auth = getAuth(app);
    const credential = await signInWithEmailAndPassword(auth, identity.email, password);

    assert.equal(credential.user.uid, identity.uid);
    clients.push({
      ...identity,
      app,
      auth,
      firestore: getClientFirestore(app),
      functions: getFunctions(app, 'us-central1'),
    });
  }

  return clients;
}

function getCallable(client, name, timeout = DEFAULT_ACTION_TIMEOUT_MILLISECONDS) {
  return httpsCallable(client.functions, name, { timeout });
}

async function closeClients(clients) {
  for (const client of clients) {
    await signOut(client.auth).catch(() => undefined);
    await deleteClientApp(client.app).catch(() => undefined);
  }
}

async function loadProjectionAssets(firestore, snapshotId) {
  const snapshotRef = firestore.doc(
    `leagues/${FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID}/projectionSnapshots/${snapshotId}`,
  );
  const [metadataSnapshot, chunksSnapshot] = await Promise.all([
    snapshotRef.get(),
    snapshotRef.collection('assets').get(),
  ]);
  const metadata = metadataSnapshot.data() ?? {};
  const assets = chunksSnapshot.docs
    .sort((left, right) => left.id.localeCompare(right.id))
    .flatMap((chunk) => Array.isArray(chunk.data()?.assets) ? chunk.data().assets : []);

  assert.ok(metadataSnapshot.exists);
  assert.equal(metadata.status, 'ready');
  assert.equal(metadata.projectionVersion, 11);
  assert.equal(metadata.scoringRulesVersion, 4);
  assert.equal(metadata.generatedByAuthority, 'server');
  assert.equal(metadata.snapshotIntegrityStatus, 'verified');
  assert.match(metadata.snapshotContentHash ?? '', SHA256_PATTERN);
  assert.match(metadata.catalogHash ?? '', SHA256_PATTERN);
  assert.ok(assets.length >= FF1_SIX_CLIENT_TOTAL_PICKS);

  return { metadata, assets };
}

async function waitForReadiness(draftRef, timeoutMilliseconds) {
  return waitForValue(
    () => draftRef.get(),
    (snapshot) => snapshot.data()?.serverDraftReadinessStatus === 'ready',
    timeoutMilliseconds,
    'The six-client Projection V11 readiness state',
  );
}

async function activatePreparedFixtureDraft(draftRef, FieldValue, readyDraft, metadata) {
  assert.equal(readyDraft.status, 'scheduled');
  assert.equal(readyDraft.clockStatus, 'stopped');
  assert.equal(readyDraft.nextOverallPick, 1);
  assert.deepEqual(readyDraft.draftedAssetKeys ?? [], []);
  assert.equal(readyDraft.serverDraftReadinessProjectionSnapshotId, metadata.activeSnapshotId);
  assert.equal(readyDraft.serverDraftReadinessProjectionSnapshotHash, metadata.snapshotContentHash);

  await draftRef.set({
    status: 'live',
    clockStatus: 'paused',
    pickStartedAt: null,
    currentPickSeconds: DRAFT_PICK_SECONDS,
    pausedRemainingSeconds: DRAFT_PICK_SECONDS,
    clockUpdatedBy: 'guarded-staging-fixture',
    clockUpdatedAt: FieldValue.serverTimestamp(),
    serverDraftProjectionSnapshotId: metadata.activeSnapshotId,
    serverDraftProjectionSnapshotHash: metadata.snapshotContentHash,
    serverDraftProjectionAuthorityVersion: metadata.authoritySchemaVersion,
    serverDraftProjectionCatalogHash: metadata.catalogHash,
    serverProjectionFallbackUsed: false,
    serverAutomationStatus: 'paused',
    serverAutomationMessage:
      'Guarded six-client rehearsal reused the exact server-verified Projection V11 snapshot.',
    serverAutomationUpdatedAt: FieldValue.serverTimestamp(),
    startedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

function countRosterAssets(roster) {
  return [
    ...(Array.isArray(roster?.activeSlots) ? roster.activeSlots : []),
    ...(Array.isArray(roster?.benchSlots) ? roster.benchSlots : []),
    ...(Array.isArray(roster?.irSlots) ? roster.irSlots : []),
  ].filter((slot) => slot?.asset?.assetKey).length;
}

function nextNeededPosition(roster) {
  const activeSlots = Array.isArray(roster?.activeSlots) ? roster.activeSlots : [];
  const openStarter = activeSlots.find((slot) => !slot?.asset?.assetKey);

  return openStarter?.position ?? null;
}

function chooseCandidate(assets, draftedAssetKeys, roster, excludedAssetKeys = []) {
  const drafted = new Set(draftedAssetKeys);
  const excluded = new Set(excludedAssetKeys);
  const neededPosition = nextNeededPosition(roster);
  const candidates = assets
    .filter((asset) =>
      typeof asset?.assetKey === 'string' &&
      !drafted.has(asset.assetKey) &&
      !excluded.has(asset.assetKey) &&
      (neededPosition ? asset.position === neededPosition : asset.position !== 'G'))
    .sort((left, right) => (left.draftRank ?? Number.MAX_SAFE_INTEGER) -
      (right.draftRank ?? Number.MAX_SAFE_INTEGER));

  assert.ok(candidates.length > 0, `No legal ${neededPosition ?? 'bench'} candidate remained.`);
  return candidates[0];
}

async function getDraftState(draftRef) {
  const snapshot = await draftRef.get();
  assert.ok(snapshot.exists);
  return snapshot.data() ?? {};
}

async function getRoster(firestore, ownerId) {
  const snapshot = await firestore.doc(
    `leagues/${FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID}/teams/${ownerId}/roster/current`,
  ).get();
  assert.ok(snapshot.exists);
  return snapshot.data() ?? {};
}

async function submitManualPick(client, draft, asset, submissionId = null) {
  const makePick = getCallable(client, 'makeSecureDraftPick');
  return makePick({
    leagueId: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
    assetKey: asset.assetKey,
    submissionId: submissionId ?? `ff1_pick_${draft.nextOverallPick}_${randomUUID()}`,
    expectedOverallPick: draft.nextOverallPick,
  });
}

async function saveQueue(client, assetKeys, autoDraftEnabled) {
  await setDoc(
    doc(
      client.firestore,
      'leagues',
      FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      'draft',
      'current',
      'queues',
      client.uid,
    ),
    {
      ownerId: client.uid,
      assetKeys,
      autoDraftEnabled,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

async function waitForPickCount(draftRef, expectedCount, timeoutMilliseconds) {
  return waitForValue(
    async () => ({
      draft: await getDraftState(draftRef),
      picks: await draftRef.collection('picks').get(),
    }),
    ({ picks }) => picks.size >= expectedCount,
    timeoutMilliseconds,
    `Draft pick ${expectedCount}`,
  );
}

function pickData(snapshot, overallPick) {
  return snapshot.docs.find((entry) => entry.id === String(overallPick).padStart(3, '0'))?.data();
}

export function buildPublicFf1SixClientEvidence(evidence) {
  return {
    projectId: D1N_STAGING_PROJECT_ID,
    leagueLabel: 'ff1-six-client-draft',
    deployedReleaseRevision: evidence.deployedReleaseRevision,
    toolingRevision: evidence.toolingRevision,
    authenticatedClientCount: evidence.authenticatedClientCount,
    independentListenerCount: evidence.independentListenerCount,
    projectionVersion: evidence.projectionVersion,
    scoringRulesVersion: evidence.scoringRulesVersion,
    serverSnapshotVerified: evidence.serverSnapshotVerified === true,
    duplicateSubmissionStable: evidence.duplicateSubmissionStable === true,
    staleSubmissionRejected: evidence.staleSubmissionRejected === true,
    queueTimeoutPickCount: evidence.queueTimeoutPickCount,
    emptyQueueAutoPickCount: evidence.emptyQueueAutoPickCount,
    pausePreservedPickCount: evidence.pausePreservedPickCount === true,
    reconnectConverged: evidence.reconnectConverged === true,
    snakeBoundaryVerified: evidence.snakeBoundaryVerified === true,
    completedPickCount: evidence.completedPickCount,
    uniqueAssetCount: evidence.uniqueAssetCount,
    completedRosterCount: evidence.completedRosterCount,
    postDraftRemovalRejected: evidence.postDraftRemovalRejected === true,
    exactOnceOutcome: evidence.exactOnceOutcome === true,
    fixtureAccountsDisabled: evidence.fixtureAccountsDisabled === true,
    fixtureRetainedForAudit: true,
  };
}

export async function runFf1SixClientDraftRehearsal(environment = process.env) {
  const { deployedReleaseRevision, readinessTimeoutMilliseconds } =
    assertFf1SixClientStagingSafety(environment);
  const { toolingRevision } = assertFf1SixClientToolingDelta(deployedReleaseRevision);
  await verifyFf1ReadinessStagingManifest(deployedReleaseRevision);

  const {
    applicationDefault,
    deleteApp: deleteAdminApp,
    initializeApp: initializeAdminApp,
  } = requireFunctions('firebase-admin/app');
  const { getAuth: getAdminAuth } = requireFunctions('firebase-admin/auth');
  const { FieldValue, getFirestore } = requireFunctions('firebase-admin/firestore');
  const adminApp = initializeAdminApp({
    credential: applicationDefault(),
    projectId: D1N_STAGING_PROJECT_ID,
  }, `ff1-six-client-admin-${Date.now()}`);
  const identities = Array.from({ length: FF1_SIX_CLIENT_MANAGER_COUNT }, (_, index) =>
    managerIdentity(index));
  const password = createPassword();
  let clients = [];
  let duplicateTab = null;
  let unsubscribers = [];
  let completed = false;

  try {
    assert.equal(adminApp.options.projectId, D1N_STAGING_PROJECT_ID);
    const adminAuth = getAdminAuth(adminApp);
    const firestore = getFirestore(adminApp);
    const leagueRef = firestore.doc(`leagues/${FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID}`);
    const draftRef = firestore.doc(`${leagueRef.path}/draft/current`);

    await prepareSharedAvailability(firestore, identities[0].uid);
    await resetExistingFixture(firestore);
    await createOrRefreshFixtureUsers(adminAuth, identities, password);
    await seedFixtureDocuments(firestore, identities);
    clients = await createAuthenticatedClients(identities, password);

    const listenerStates = clients.map(() => ({ updates: 0, status: null, error: null }));
    unsubscribers = clients.map((client, index) => onSnapshot(
      doc(client.firestore, 'leagues', FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID, 'draft', 'current'),
      (snapshot) => {
        listenerStates[index].updates += 1;
        listenerStates[index].status = snapshot.data()?.status ?? null;
      },
      (error) => {
        listenerStates[index].error = error;
      },
    ));
    await waitForValue(
      () => Promise.resolve(listenerStates),
      (states) => states.every((state) => state.updates > 0 && !state.error),
      20_000,
      'The six authenticated Draft listeners',
    );

    const scheduleDraft = getCallable(clients[0], 'executeDraftCommand');
    const scheduledStartAt = new Date(Date.now() + DRAFT_START_OFFSET_MILLISECONDS);
    await scheduleDraft({
      leagueId: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      action: 'save-settings',
      submissionId: `ff1_settings_${randomUUID()}`,
      roundOneOrder: identities.map((identity) => identity.uid),
      scheduledStartAt: scheduledStartAt.toISOString(),
      pickSeconds: DRAFT_PICK_SECONDS,
    });

    const readySnapshot = await waitForReadiness(draftRef, readinessTimeoutMilliseconds);
    const readyDraft = readySnapshot.data() ?? {};
    const { metadata, assets } = await loadProjectionAssets(
      firestore,
      readyDraft.serverDraftReadinessProjectionSnapshotId,
    );
    await activatePreparedFixtureDraft(draftRef, FieldValue, readyDraft, metadata);

    const resumeDraft = getCallable(clients[0], 'executeDraftCommand');
    await resumeDraft({
      leagueId: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      action: 'resume-clock',
    });
    await wait(1_500);
    await resumeDraft({
      leagueId: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      action: 'pause-clock',
    });
    const pausedPickCount = (await draftRef.collection('picks').get()).size;
    await wait((DRAFT_PICK_SECONDS + 2) * 1_000);
    const afterOldDeadlinePickCount = (await draftRef.collection('picks').get()).size;
    assert.equal(pausedPickCount, 0);
    assert.equal(afterOldDeadlinePickCount, pausedPickCount);
    await resumeDraft({
      leagueId: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      action: 'resume-clock',
    });

    let draft = await getDraftState(draftRef);
    let roster = await getRoster(firestore, draft.roundOneOrder[0]);
    const firstAsset = chooseCandidate(assets, draft.draftedAssetKeys, roster);
    const duplicateSubmissionId = `ff1_duplicate_${randomUUID()}`;
    const duplicateResults = await Promise.all([
      submitManualPick(clients[0], draft, firstAsset, duplicateSubmissionId),
      submitManualPick(clients[0], draft, firstAsset, duplicateSubmissionId),
    ]);
    assert.equal(duplicateResults.length, 2);
    assert.equal((await draftRef.collection('picks').get()).size, 1);

    draft = await getDraftState(draftRef);
    const secondOwnerIndex = identities.findIndex((identity) => identity.uid === draft.roundOneOrder[1]);
    roster = await getRoster(firestore, draft.roundOneOrder[1]);
    const secondAsset = chooseCandidate(assets, draft.draftedAssetKeys, roster);
    const competingAsset = chooseCandidate(
      assets,
      draft.draftedAssetKeys,
      roster,
      [secondAsset.assetKey],
    );
    const duplicateTabApp = initializeClientApp(
      FIREBASE_OPTIONS,
      `ff1-six-client-duplicate-tab-${Date.now()}-${randomUUID()}`,
    );
    duplicateTab = {
      app: duplicateTabApp,
      auth: getAuth(duplicateTabApp),
      firestore: getClientFirestore(duplicateTabApp),
      functions: getFunctions(duplicateTabApp, 'us-central1'),
    };
    await signInWithEmailAndPassword(
      duplicateTab.auth,
      identities[secondOwnerIndex].email,
      password,
    );
    await disableNetwork(clients[5].firestore);
    const staleResults = await Promise.allSettled([
      submitManualPick(clients[secondOwnerIndex], draft, secondAsset),
      submitManualPick(duplicateTab, draft, competingAsset),
    ]);
    assert.equal(staleResults.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(staleResults.filter((result) => result.status === 'rejected').length, 1);
    await enableNetwork(clients[5].firestore);
    const reconnectSnapshot = await getDocFromServer(doc(
      clients[5].firestore,
      'leagues',
      FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      'draft',
      'current',
    ));
    assert.ok((reconnectSnapshot.data()?.nextOverallPick ?? 0) >= 3);
    assert.equal((await draftRef.collection('picks').get()).size, 2);

    draft = await getDraftState(draftRef);
    const thirdOwnerIndex = identities.findIndex((identity) => identity.uid ===
      draft.roundOneOrder[(draft.nextOverallPick - 1) % FF1_SIX_CLIENT_MANAGER_COUNT]);
    roster = await getRoster(firestore, identities[thirdOwnerIndex].uid);
    const queuedAsset = chooseCandidate(assets, draft.draftedAssetKeys, roster);
    await saveQueue(clients[thirdOwnerIndex], [queuedAsset.assetKey], false);
    const timeoutPickState = await waitForPickCount(
      draftRef,
      3,
      (DRAFT_PICK_SECONDS + 60) * 1_000,
    );
    const timeoutPick = pickData(timeoutPickState.picks, 3);
    assert.equal(timeoutPick?.autoPickReason, 'timer-expired');
    assert.equal(timeoutPick?.asset?.assetKey, queuedAsset.assetKey);

    draft = await getDraftState(draftRef);
    const fourthPick = draft.nextOverallPick;
    const fourthOwner = draft.roundOneOrder[(fourthPick - 1) % FF1_SIX_CLIENT_MANAGER_COUNT];
    const fourthOwnerIndex = identities.findIndex((identity) => identity.uid === fourthOwner);
    await saveQueue(clients[fourthOwnerIndex], [], true);
    const autoPickState = await waitForPickCount(draftRef, 4, 60_000);
    const autoPick = pickData(autoPickState.picks, 4);
    assert.equal(autoPick?.autoPickReason, 'manager-auto-mode');
    await saveQueue(clients[fourthOwnerIndex], [], false);

    while (true) {
      draft = await getDraftState(draftRef);

      if (draft.status === 'complete') {
        break;
      }

      assert.equal(draft.clockStatus, 'running');
      const overallPick = draft.nextOverallPick;
      const teamCount = draft.roundOneOrder.length;
      const round = Math.floor((overallPick - 1) / teamCount) + 1;
      const pickInRound = ((overallPick - 1) % teamCount) + 1;
      const roundOrder = round % 2 === 1
        ? draft.roundOneOrder
        : [...draft.roundOneOrder].reverse();
      const ownerId = roundOrder[pickInRound - 1];
      const ownerIndex = identities.findIndex((identity) => identity.uid === ownerId);

      assert.ok(ownerIndex >= 0);
      roster = await getRoster(firestore, ownerId);
      const asset = chooseCandidate(assets, draft.draftedAssetKeys, roster);
      await submitManualPick(clients[ownerIndex], draft, asset);
    }

    const [finalDraftSnapshot, finalPicksSnapshot, finalTeamsSnapshot] = await Promise.all([
      draftRef.get(),
      draftRef.collection('picks').orderBy('overallPick', 'asc').get(),
      leagueRef.collection('teams').get(),
    ]);
    const finalDraft = finalDraftSnapshot.data() ?? {};
    const picks = finalPicksSnapshot.docs.map((entry) => entry.data());
    const uniqueAssets = new Set(picks.map((pick) => pick.asset?.assetKey));
    const firstRound = picks.slice(0, FF1_SIX_CLIENT_MANAGER_COUNT).map((pick) => pick.ownerId);
    const secondRound = picks
      .slice(FF1_SIX_CLIENT_MANAGER_COUNT, FF1_SIX_CLIENT_MANAGER_COUNT * 2)
      .map((pick) => pick.ownerId);

    assert.equal(finalDraft.status, 'complete');
    assert.equal(finalDraft.clockStatus, 'complete');
    assert.equal(finalDraft.nextOverallPick, FF1_SIX_CLIENT_TOTAL_PICKS + 1);
    assert.equal(picks.length, FF1_SIX_CLIENT_TOTAL_PICKS);
    assert.equal(uniqueAssets.size, FF1_SIX_CLIENT_TOTAL_PICKS);
    assert.deepEqual(firstRound, identities.map((identity) => identity.uid));
    assert.deepEqual(secondRound, identities.map((identity) => identity.uid).reverse());
    assert.equal(finalTeamsSnapshot.size, FF1_SIX_CLIENT_MANAGER_COUNT);

    let completedRosterCount = 0;
    for (const identity of identities) {
      const completedRoster = await getRoster(firestore, identity.uid);
      assert.equal(countRosterAssets(completedRoster), FF1_SIX_CLIENT_TOTAL_ROUNDS);
      completedRosterCount += 1;
    }

    const removeMember = getCallable(clients[0], 'removeLeagueMemberSecure');
    const removalResult = await Promise.allSettled([removeMember({
      requestId: `ff1_removal_${randomUUID()}`,
      leagueId: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      targetOwnerId: identities[1].uid,
      confirmationTeamName: identities[1].teamName,
    })]);
    assert.equal(removalResult[0].status, 'rejected');
    assert.match(removalResult[0].reason?.code ?? '', /failed-precondition|aborted/);
    assert.ok((await leagueRef.collection('members').doc(identities[1].uid).get()).exists);

    await waitForValue(
      () => Promise.resolve(listenerStates),
      (states) => states.every((state) => state.status === 'complete' && !state.error),
      30_000,
      'All six authenticated Draft listeners at completion',
    );

    completed = true;
    return buildPublicFf1SixClientEvidence({
      deployedReleaseRevision,
      toolingRevision,
      authenticatedClientCount: clients.length,
      independentListenerCount: listenerStates.length,
      projectionVersion: metadata.projectionVersion,
      scoringRulesVersion: metadata.scoringRulesVersion,
      serverSnapshotVerified: metadata.snapshotIntegrityStatus === 'verified',
      duplicateSubmissionStable: true,
      staleSubmissionRejected: true,
      queueTimeoutPickCount: picks.filter((pick) => pick.autoPickReason === 'timer-expired').length,
      emptyQueueAutoPickCount: picks.filter((pick) => pick.autoPickReason === 'manager-auto-mode').length,
      pausePreservedPickCount: afterOldDeadlinePickCount === pausedPickCount,
      reconnectConverged: true,
      snakeBoundaryVerified: true,
      completedPickCount: picks.length,
      uniqueAssetCount: uniqueAssets.size,
      completedRosterCount,
      postDraftRemovalRejected: true,
      exactOnceOutcome: true,
      fixtureAccountsDisabled: true,
    });
  } finally {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
    if (duplicateTab) {
      await closeClients([duplicateTab]);
    }
    await closeClients(clients);
    try {
      await disableFixtureUsers(getAdminAuth(adminApp), identities);
    } finally {
      await deleteAdminApp(adminApp);
    }

    if (!completed) {
      console.error(
        'The six synthetic accounts were disabled and the exact fixture was retained for diagnosis.',
      );
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFf1SixClientDraftRehearsal()
    .then((evidence) => {
      console.log('FF1 six-client staging Draft rehearsal passed.');
      console.log(JSON.stringify(evidence, null, 2));
      console.log(
        'Six synthetic accounts were disabled; the disposable league was retained for bounded audit.',
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
