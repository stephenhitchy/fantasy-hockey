import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { deleteApp, initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';

import {
  assertD1mStagingConnectionSafety,
  D1M_STAGING_ADMIN_EMAIL,
  D1M_STAGING_ADMIN_ID,
  D1M_STAGING_FIXTURE_MARKER,
  D1M_STAGING_GAME_IDS,
  D1M_STAGING_LEAGUE_ID,
  D1M_STAGING_NON_ADMIN_EMAIL,
  D1M_STAGING_NON_ADMIN_ID,
  D1M_STAGING_PROJECT_ID,
} from './seed-d1m-final-score-reconciliation-staging-fixture.mjs';

export const D1M_STAGING_RUN_ACKNOWLEDGEMENT =
  `exercise-${D1M_STAGING_LEAGUE_ID}-in-${D1M_STAGING_PROJECT_ID}`;
export const D1M_STAGING_FIREBASE_OPTIONS = Object.freeze({
  apiKey: 'AIzaSyDejIpv-Pi1iDcuKSgDyVK_5h2s9kZ05sY',
  authDomain: 'rinkrat-staging-d1nc-2026.firebaseapp.com',
  projectId: D1M_STAGING_PROJECT_ID,
  storageBucket: 'rinkrat-staging-d1nc-2026.firebasestorage.app',
  messagingSenderId: '817415114086',
  appId: '1:817415114086:web:d8be39fcb0b05074b28ca7',
});

const requireFunctions = createRequire(
  new URL('../../functions/package.json', import.meta.url),
);

export function assertD1mStagingRunSafety(environment = process.env) {
  const connectionSafety = assertD1mStagingConnectionSafety(environment);

  if (environment.D1M_STAGING_RUN_ACK !== D1M_STAGING_RUN_ACKNOWLEDGEMENT) {
    throw new Error(
      'D1M_STAGING_RUN_ACK does not authorize the exact reconciliation evidence run.',
    );
  }

  const timeoutMilliseconds = Number(
    environment.D1M_STAGING_TIMEOUT_MILLISECONDS ?? 120_000,
  );

  if (
    !Number.isInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 30_000 ||
    timeoutMilliseconds > 300_000
  ) {
    throw new Error(
      'D1M_STAGING_TIMEOUT_MILLISECONDS must be an integer from 30000 through 300000.',
    );
  }

  return { password: connectionSafety.password, timeoutMilliseconds };
}

function stableValue(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value.toDate === 'function') {
    return value.toDate().toISOString();
  }

  if (typeof value.path === 'string' && value.firestore) {
    return { documentReference: value.path };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => stableValue(entry));
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function snapshotDigest(snapshot) {
  const payload = snapshot.exists
    ? {
        exists: true,
        updateTime: snapshot.updateTime?.toDate().toISOString() ?? '',
        data: stableValue(snapshot.data()),
      }
    : { exists: false };

  return createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

async function readBoundedAuthorityFingerprint(firestore) {
  const prefix = `leagues/${D1M_STAGING_LEAGUE_ID}`;
  const paths = [
    `users/${D1M_STAGING_ADMIN_ID}`,
    `platformAdmins/${D1M_STAGING_ADMIN_ID}`,
    `platformAdmins/${D1M_STAGING_NON_ADMIN_ID}`,
    prefix,
    `${prefix}/members/${D1M_STAGING_ADMIN_ID}`,
    `${prefix}/teams/${D1M_STAGING_ADMIN_ID}`,
    `${prefix}/teams/${D1M_STAGING_ADMIN_ID}/roster/current`,
    `${prefix}/cycles/cycle-1`,
    `${prefix}/cycles/cycle-1/matchups/matchup-1`,
    `${prefix}/cycles/cycle-1/teamWindows/${D1M_STAGING_ADMIN_ID}`,
    ...Object.values(D1M_STAGING_GAME_IDS).map(
      (gameId) => `nhlCanonicalGameFacts/${gameId}`,
    ),
  ];
  const [snapshots, transactions, playoff] = await Promise.all([
    firestore.getAll(...paths.map((path) => firestore.doc(path))),
    firestore.collection(`${prefix}/transactions`).limit(2).get(),
    firestore.doc(`${prefix}/playoffs/current`).get(),
  ]);
  const fixtureSnapshots = snapshots.filter((snapshot) => snapshot.exists);

  for (const snapshot of fixtureSnapshots) {
    assert.equal(
      snapshot.data()?.fixtureMarker,
      D1M_STAGING_FIXTURE_MARKER,
      `The bounded staging document ${snapshot.ref.path} is not owned by D1M.`,
    );
  }

  const missingCanonicalSnapshot = snapshots.find(
    (snapshot) =>
      snapshot.ref.path ===
      `nhlCanonicalGameFacts/${D1M_STAGING_GAME_IDS.missingCanonical}`,
  );

  assert.equal(
    missingCanonicalSnapshot?.exists,
    false,
    'The canonical-missing fixture game unexpectedly exists.',
  );
  assert.equal(transactions.size, 0, 'The D1M fixture unexpectedly contains transactions.');
  assert.equal(playoff.exists, false, 'The D1M fixture unexpectedly contains playoff state.');

  return createHash('sha256')
    .update(JSON.stringify({
      documents: snapshots.map((snapshot) => ({
        path: snapshot.ref.path,
        digest: snapshotDigest(snapshot),
      })),
      transactionCount: transactions.size,
      playoffExists: playoff.exists,
    }))
    .digest('hex');
}

async function expectCallableCode(operation, expectedCode) {
  try {
    await operation();
  } catch (error) {
    assert.equal(error?.code, `functions/${expectedCode}`);
    return;
  }

  assert.fail(`The callable did not reject with ${expectedCode}.`);
}

function comparablePage(page) {
  const { generatedAt: _generatedAt, ...stablePage } = page;
  return stablePage;
}

function assertExpectedPage(page) {
  assert.equal(page.schemaVersion, 1);
  assert.equal(page.leagueId, D1M_STAGING_LEAGUE_ID);
  assert.equal(page.cycleNumber, 1);
  assert.equal(page.authority, 'detect-only');
  assert.equal(page.writesPerformed, 0);
  assert.equal(page.pageSize, 4);
  assert.equal(page.nextCursor, '');
  assert.equal(page.scanComplete, true);
  assert.equal(page.canonicalGameReadLimitReached, false);
  assert.equal(page.teamWindowLimitReached, false);
  assert.equal(page.windowGameLimitReached, false);
  assert.equal(page.teamWindowStructureIncomplete, false);
  assert.equal(page.teamDocumentCoverageChecked, true);
  assert.equal(page.findingsTruncated, false);
  assert.deepEqual(page.summary, {
    teamDocumentCount: 1,
    windowCount: 4,
    finalizedGameCount: 4,
    verifiedGameCount: 1,
    candidateGameCount: 1,
    unverifiableGameCount: 2,
    integrityIssueCount: 0,
    findingCount: 3,
  });

  const byCode = new Map(page.findings.map((finding) => [finding.code, finding]));
  assert.deepEqual([...byCode.keys()].sort(), [
    'canonical-game-missing',
    'score-and-appearance-mismatch',
    'stored-final-evidence-missing',
  ]);

  const mismatch = byCode.get('score-and-appearance-mismatch');
  assert.equal(mismatch?.status, 'candidate');
  assert.equal(mismatch?.storedPoints, 0);
  assert.equal(mismatch?.storedAppeared, false);
  assert.equal(mismatch?.canonicalAppeared, true);
  assert.ok(
    typeof mismatch?.canonicalPoints === 'number' && mismatch.canonicalPoints > 0,
  );
  assert.ok(typeof mismatch?.pointDelta === 'number' && mismatch.pointDelta > 0);

  for (const code of ['canonical-game-missing', 'stored-final-evidence-missing']) {
    assert.equal(byCode.get(code)?.status, 'unverifiable');
    assert.equal(byCode.get(code)?.canonicalPoints, null);
  }

  const serialized = JSON.stringify(page);
  assert.doesNotMatch(serialized, new RegExp(D1M_STAGING_ADMIN_ID, 'i'));
  assert.doesNotMatch(serialized, /@d1m\.rinkrat\.test/i);
  assert.equal(
    page.findings.every((finding) => /^[a-f0-9]{12}$/.test(finding.teamKey)),
    true,
  );
}

export function buildPublicD1mEvidence(page, input = {}) {
  return {
    projectId: D1M_STAGING_PROJECT_ID,
    leagueLabel: 'd1m-final-score-reconciliation-fixture',
    functionState: 'active',
    nonAdminRejected: input.nonAdminRejected === true,
    repeatedDeliveryStable: input.repeatedDeliveryStable === true,
    latestCycleStable: input.latestCycleStable === true,
    competitiveStateUnchanged: input.competitiveStateUnchanged === true,
    authority: page.authority,
    writesPerformed: page.writesPerformed,
    scanComplete: page.scanComplete,
    teamDocumentCoverageChecked: page.teamDocumentCoverageChecked,
    summary: page.summary,
    findingCodes: page.findings.map((finding) => finding.code).sort(),
  };
}

export async function runD1mStagingEvidence(environment = process.env) {
  const { password, timeoutMilliseconds } =
    assertD1mStagingRunSafety(environment);
  const {
    applicationDefault,
    deleteApp: deleteAdminApp,
    initializeApp: initializeAdminApp,
  } = requireFunctions('firebase-admin/app');
  const { getFirestore } = requireFunctions('firebase-admin/firestore');
  const adminApp = initializeAdminApp({
    credential: applicationDefault(),
    projectId: D1M_STAGING_PROJECT_ID,
  }, `d1m-staging-evidence-admin-${Date.now()}`);
  const adminClientApp = initializeApp(
    D1M_STAGING_FIREBASE_OPTIONS,
    `d1m-staging-evidence-client-admin-${Date.now()}`,
  );
  const nonAdminClientApp = initializeApp(
    D1M_STAGING_FIREBASE_OPTIONS,
    `d1m-staging-evidence-client-non-admin-${Date.now()}`,
  );

  try {
    assert.equal(adminApp.options.projectId, D1M_STAGING_PROJECT_ID);
    assert.equal(adminClientApp.options.projectId, D1M_STAGING_PROJECT_ID);
    assert.equal(nonAdminClientApp.options.projectId, D1M_STAGING_PROJECT_ID);

    const [adminCredential, nonAdminCredential] = await Promise.all([
      signInWithEmailAndPassword(
        getAuth(adminClientApp),
        D1M_STAGING_ADMIN_EMAIL,
        password,
      ),
      signInWithEmailAndPassword(
        getAuth(nonAdminClientApp),
        D1M_STAGING_NON_ADMIN_EMAIL,
        password,
      ),
    ]);
    assert.equal(adminCredential.user.uid, D1M_STAGING_ADMIN_ID);
    assert.equal(adminCredential.user.emailVerified, true);
    assert.equal(nonAdminCredential.user.uid, D1M_STAGING_NON_ADMIN_ID);
    assert.equal(nonAdminCredential.user.emailVerified, true);

    const firestore = getFirestore(adminApp);
    const initialFingerprint = await readBoundedAuthorityFingerprint(firestore);
    const nonAdminCallable = httpsCallable(
      getFunctions(nonAdminClientApp, 'us-central1'),
      'getFinalScoreReconciliationPage',
      { timeout: timeoutMilliseconds },
    );
    const request = {
      leagueId: D1M_STAGING_LEAGUE_ID,
      cycleNumber: 1,
      afterTeamId: '',
    };

    await expectCallableCode(
      () => nonAdminCallable(request),
      'permission-denied',
    );
    assert.equal(
      await readBoundedAuthorityFingerprint(firestore),
      initialFingerprint,
      'The rejected non-admin request changed bounded competitive state.',
    );

    const adminCallable = httpsCallable(
      getFunctions(adminClientApp, 'us-central1'),
      'getFinalScoreReconciliationPage',
      { timeout: timeoutMilliseconds },
    );
    const firstResponse = await adminCallable(request);
    const firstPage = firstResponse.data ?? {};
    assertExpectedPage(firstPage);
    assert.equal(
      await readBoundedAuthorityFingerprint(firestore),
      initialFingerprint,
      'The first detect-only request changed bounded competitive state.',
    );

    const repeatedResponse = await adminCallable(request);
    const repeatedPage = repeatedResponse.data ?? {};
    assertExpectedPage(repeatedPage);
    assert.deepEqual(comparablePage(repeatedPage), comparablePage(firstPage));
    assert.equal(
      await readBoundedAuthorityFingerprint(firestore),
      initialFingerprint,
      'Repeated delivery changed bounded competitive state.',
    );

    const latestResponse = await adminCallable({
      ...request,
      cycleNumber: null,
    });
    const latestPage = latestResponse.data ?? {};
    assertExpectedPage(latestPage);
    assert.deepEqual(comparablePage(latestPage), comparablePage(firstPage));
    assert.equal(
      await readBoundedAuthorityFingerprint(firestore),
      initialFingerprint,
      'Latest-cycle resolution changed bounded competitive state.',
    );

    return buildPublicD1mEvidence(firstPage, {
      nonAdminRejected: true,
      repeatedDeliveryStable: true,
      latestCycleStable: true,
      competitiveStateUnchanged: true,
    });
  } finally {
    await Promise.all([
      signOut(getAuth(adminClientApp)).catch(() => undefined),
      signOut(getAuth(nonAdminClientApp)).catch(() => undefined),
    ]);
    await Promise.all([
      deleteApp(adminClientApp),
      deleteApp(nonAdminClientApp),
      deleteAdminApp(adminApp),
    ]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runD1mStagingEvidence()
    .then((result) => {
      console.log('D1M final-score reconciliation staging evidence passed.');
      console.log(JSON.stringify(result, null, 2));
      console.log(
        'No account ID, email, password, player ID, game ID, source version, or raw roster identifier was printed.',
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
