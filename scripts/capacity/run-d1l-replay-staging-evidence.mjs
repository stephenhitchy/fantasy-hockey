import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { deleteApp, initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';

import {
  assertD1lReplayStagingConnectionSafety,
  D1L_REPLAY_STAGING_COMMISSIONER_ID,
  D1L_REPLAY_STAGING_EMAIL,
  D1L_REPLAY_STAGING_LEAGUE_ID,
  D1L_REPLAY_STAGING_PROJECT_ID,
  D1L_REPLAY_TRADED_ASSET,
} from './seed-d1l-replay-staging-fixture.mjs';

export const D1L_REPLAY_STAGING_RUN_ACKNOWLEDGEMENT =
  `exercise-${D1L_REPLAY_STAGING_LEAGUE_ID}-in-${D1L_REPLAY_STAGING_PROJECT_ID}`;

export const D1L_REPLAY_STAGING_FIREBASE_OPTIONS = Object.freeze({
  apiKey: 'AIzaSyDejIpv-Pi1iDcuKSgDyVK_5h2s9kZ05sY',
  authDomain: 'rinkrat-staging-d1nc-2026.firebaseapp.com',
  projectId: D1L_REPLAY_STAGING_PROJECT_ID,
  storageBucket: 'rinkrat-staging-d1nc-2026.firebasestorage.app',
  messagingSenderId: '817415114086',
  appId: '1:817415114086:web:d8be39fcb0b05074b28ca7',
});

const requireFunctions = createRequire(
  new URL('../../functions/package.json', import.meta.url),
);
const TERMINAL_REQUEST_STATUSES = new Set(['completed', 'error', 'cancelled']);

export function assertD1lReplayStagingRunSafety(environment = process.env) {
  const connectionSafety = assertD1lReplayStagingConnectionSafety(environment);

  if (
    environment.D1L_REPLAY_STAGING_RUN_ACK !==
    D1L_REPLAY_STAGING_RUN_ACKNOWLEDGEMENT
  ) {
    throw new Error(
      'D1L_REPLAY_STAGING_RUN_ACK does not authorize the exact replay evidence run.',
    );
  }

  const timeoutMilliseconds = Number(
    environment.D1L_REPLAY_STAGING_TIMEOUT_MILLISECONDS ?? 720_000,
  );

  if (
    !Number.isInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 60_000 ||
    timeoutMilliseconds > 900_000
  ) {
    throw new Error(
      'D1L_REPLAY_STAGING_TIMEOUT_MILLISECONDS must be an integer from 60000 through 900000.',
    );
  }

  return {
    password: connectionSafety.password,
    timeoutMilliseconds,
  };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForReplayRequest(requestRef, timeoutMilliseconds) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMilliseconds) {
    const snapshot = await requestRef.get();
    const data = snapshot.data() ?? {};
    const status = typeof data.status === 'string' ? data.status : '';

    if (snapshot.exists && TERMINAL_REQUEST_STATUSES.has(status)) {
      return { status, data };
    }

    await wait(2_000);
  }

  throw new Error('The staging replay request did not reach a terminal state before the timeout.');
}

function requireObject(value, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} is missing.`);
  return value;
}

function requireArray(value, label) {
  assert.ok(Array.isArray(value), `${label} is missing.`);
  return value;
}

function fingerprintDigest(value, label) {
  assert.equal(typeof value, 'string', `${label} is missing.`);
  assert.ok(value.length > 0, `${label} is empty.`);
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function buildPublicReplayEvidence(evidence) {
  const {
    scoringFingerprint,
    dataFingerprint,
    ...boundedEvidence
  } = evidence;

  return {
    ...boundedEvidence,
    scoringFingerprintDigest: fingerprintDigest(
      scoringFingerprint,
      'Scoring fingerprint',
    ),
    dataFingerprintDigest: fingerprintDigest(
      dataFingerprint,
      'Data fingerprint',
    ),
  };
}

function buildReplayEvidence({ requestId, requestData, control, assetMap, snapshot }) {
  assert.equal(requestData.status, 'completed');
  assert.equal(requestData.leagueId, D1L_REPLAY_STAGING_LEAGUE_ID);
  assert.equal(control.status, 'ready');
  assert.equal(control.lastCompletedRequestId, requestId);
  assert.equal(control.daysAdvanced, 1);
  assert.equal(assetMap.schemaVersion, 2);
  assert.equal(assetMap.assetKey, D1L_REPLAY_TRADED_ASSET.assetKey);
  assert.equal(assetMap.assetType, 'skater');
  assert.equal(assetMap.playerId, D1L_REPLAY_TRADED_ASSET.player.id);
  assert.equal(assetMap.currentTeamAbbreviation, 'FLA');
  assert.equal(assetMap.sourceSeason, '20252026');

  const sourceGameIds = requireArray(assetMap.sourceGameIds, 'Replay source game IDs');
  const sourceGameDates = requireArray(assetMap.sourceGameDates, 'Replay source game dates');
  const sourceTeams = requireArray(
    assetMap.sourceTeamAbbreviations,
    'Replay source teams',
  );
  assert.ok(sourceGameIds.length > 0 && sourceGameIds.length <= 82);
  assert.equal(sourceGameIds.length, sourceGameDates.length);
  assert.equal(sourceGameIds.length, sourceTeams.length);
  assert.equal(sourceGameIds[0], 2_025_020_011);
  assert.equal(sourceTeams[0], 'OTT');

  const result = requireObject(snapshot.result, 'Published scoring result');
  const windowScores = requireObject(result.windowScores, 'Published window scores');
  const windowEntries = Object.values(windowScores);
  assert.equal(windowEntries.length, 1);
  const window = requireObject(windowEntries[0], 'Traded-player window');
  const firstGameId = String(sourceGameIds[0]);
  const completedGameIds = requireArray(window.completedGameIds, 'Completed game IDs');
  const incompleteFinalGameIds = requireArray(
    window.incompleteFinalGameIds,
    'Incomplete final game IDs',
  );
  const gameInputCompleteness = requireObject(
    window.gameInputCompleteness,
    'Final-input completeness map',
  );
  const firstGameCompleteness = requireObject(
    gameInputCompleteness[firstGameId],
    'First mapped final-input completeness',
  );

  assert.equal(window.assetKey, D1L_REPLAY_TRADED_ASSET.assetKey);
  assert.equal(window.gamesPlayed, 1);
  assert.equal(window.actualGamesPlayed, 1);
  assert.ok(Number.isFinite(window.currentScore) && window.currentScore > 0);
  assert.ok(completedGameIds.includes(sourceGameIds[0]));
  assert.deepEqual(incompleteFinalGameIds, []);
  assert.equal(firstGameCompleteness.complete, true);
  assert.equal(firstGameCompleteness.reusableFinal, true);
  assert.equal(result.hasIncompleteFinalGames, false);

  return {
    requestStatus: requestData.status,
    requestAttemptCount: requestData.attemptCount,
    controlStatus: control.status,
    daysAdvanced: control.daysAdvanced,
    simulatedDate: control.simulatedDate,
    replayMapSchemaVersion: assetMap.schemaVersion,
    mappedSourceGameCount: sourceGameIds.length,
    firstMappedSourceTeam: sourceTeams[0],
    firstMappedGameComplete: firstGameCompleteness.complete,
    incompleteFinalGameCount: incompleteFinalGameIds.length,
    gamesPlayed: window.gamesPlayed,
    actualGamesPlayed: window.actualGamesPlayed,
    score: window.currentScore,
    completedGameCount: completedGameIds.length,
    scoringFingerprint: snapshot.scoringFingerprint,
    dataFingerprint: result.dataFingerprint,
  };
}

async function readReplayState(firestore, requestId) {
  const leaguePrefix = `leagues/${D1L_REPLAY_STAGING_LEAGUE_ID}`;
  const [
    requestSnapshot,
    controlSnapshot,
    mapSnapshot,
    scoreSnapshot,
    teamSnapshot,
    cycleSnapshot,
    matchupSnapshot,
    playoffSnapshot,
    transactionSnapshot,
  ] =
    await Promise.all([
      firestore.doc(`historicalReplayRequests/${requestId}`).get(),
      firestore.doc(`${leaguePrefix}/historicalReplay/control`).get(),
      firestore
        .doc(`${leaguePrefix}/historicalReplayAssets/${D1L_REPLAY_TRADED_ASSET.assetKey}`)
        .get(),
      firestore.doc(`${leaguePrefix}/liveScoring/cycle-1`).get(),
      firestore
        .doc(`${leaguePrefix}/teams/${D1L_REPLAY_STAGING_COMMISSIONER_ID}`)
        .get(),
      firestore.doc(`${leaguePrefix}/cycles/cycle-1`).get(),
      firestore
        .doc(`${leaguePrefix}/cycles/cycle-1/matchups/matchup-1`)
        .get(),
      firestore.doc(`${leaguePrefix}/playoffs/current`).get(),
      firestore.collection(`${leaguePrefix}/transactions`).limit(2).get(),
    ]);

  assert.ok(requestSnapshot.exists, 'The replay request document is missing.');
  assert.ok(controlSnapshot.exists, 'The replay control document is missing.');
  assert.ok(mapSnapshot.exists, 'The schema-2 replay asset map is missing.');
  assert.ok(scoreSnapshot.exists, 'The published replay scoring snapshot is missing.');
  assert.ok(teamSnapshot.exists, 'The synthetic team document is missing.');
  assert.ok(cycleSnapshot.exists, 'The synthetic cycle document is missing.');
  assert.ok(matchupSnapshot.exists, 'The synthetic matchup document is missing.');

  return {
    requestData: requestSnapshot.data() ?? {},
    control: controlSnapshot.data() ?? {},
    assetMap: mapSnapshot.data() ?? {},
    snapshot: scoreSnapshot.data() ?? {},
    authorityEvidence: {
      team: teamSnapshot.data() ?? {},
      cycle: cycleSnapshot.data() ?? {},
      matchup: matchupSnapshot.data() ?? {},
      playoffExists: playoffSnapshot.exists,
      transactionCount: transactionSnapshot.size,
    },
  };
}

export async function runD1lReplayStagingEvidence(environment = process.env) {
  const { password, timeoutMilliseconds } =
    assertD1lReplayStagingRunSafety(environment);
  const {
    applicationDefault,
    deleteApp: deleteAdminApp,
    initializeApp: initializeAdminApp,
  } = requireFunctions('firebase-admin/app');
  const { getFirestore } = requireFunctions('firebase-admin/firestore');
  const adminApp = initializeAdminApp({
    credential: applicationDefault(),
    projectId: D1L_REPLAY_STAGING_PROJECT_ID,
  }, `d1l-replay-staging-evidence-admin-${Date.now()}`);
  const clientApp = initializeApp(
    D1L_REPLAY_STAGING_FIREBASE_OPTIONS,
    `d1l-replay-staging-evidence-client-${Date.now()}`,
  );

  try {
    assert.equal(adminApp.options.projectId, D1L_REPLAY_STAGING_PROJECT_ID);
    assert.equal(clientApp.options.projectId, D1L_REPLAY_STAGING_PROJECT_ID);
    const auth = getAuth(clientApp);
    await signInWithEmailAndPassword(auth, D1L_REPLAY_STAGING_EMAIL, password);
    const functions = getFunctions(clientApp, 'us-central1');
    const advanceReplay = httpsCallable(functions, 'advanceHistoricalReplayDay', {
      timeout: 60_000,
    });
    const firestore = getFirestore(adminApp);
    const preparedControlSnapshot = await firestore
      .doc(`leagues/${D1L_REPLAY_STAGING_LEAGUE_ID}/historicalReplay/control`)
      .get();
    const requestId = preparedControlSnapshot.data()?.fixtureRequestId;
    assert.match(
      requestId ?? '',
      /^d1lreplay_[A-Za-z0-9_-]{16,86}$/,
      'The seeded replay request identity is missing or malformed.',
    );
    const firstResponse = await advanceReplay({
      leagueId: D1L_REPLAY_STAGING_LEAGUE_ID,
      requestId,
    });

    assert.equal(firstResponse.data?.status, 'queued');
    assert.equal(firstResponse.data?.requestId, requestId);

    const requestRef = firestore.doc(`historicalReplayRequests/${requestId}`);
    const terminal = await waitForReplayRequest(requestRef, timeoutMilliseconds);
    assert.equal(
      terminal.status,
      'completed',
      `Replay request stopped in ${terminal.status}: ${terminal.data.lastError ?? 'no error detail'}`,
    );

    const beforeDuplicate = await readReplayState(firestore, requestId);
    assert.equal(beforeDuplicate.authorityEvidence.playoffExists, false);
    assert.equal(beforeDuplicate.authorityEvidence.transactionCount, 0);
    const evidence = buildReplayEvidence({
      requestId,
      ...beforeDuplicate,
    });
    const duplicateResponse = await advanceReplay({
      leagueId: D1L_REPLAY_STAGING_LEAGUE_ID,
      requestId,
    });
    assert.equal(duplicateResponse.data?.status, 'queued');
    assert.match(duplicateResponse.data?.message ?? '', /already queued/i);
    await wait(4_000);
    const afterDuplicate = await readReplayState(firestore, requestId);
    const duplicateEvidence = buildReplayEvidence({
      requestId,
      ...afterDuplicate,
    });

    assert.equal(duplicateEvidence.daysAdvanced, evidence.daysAdvanced);
    assert.equal(duplicateEvidence.simulatedDate, evidence.simulatedDate);
    assert.equal(duplicateEvidence.score, evidence.score);
    assert.equal(duplicateEvidence.completedGameCount, evidence.completedGameCount);
    assert.equal(duplicateEvidence.dataFingerprint, evidence.dataFingerprint);
    assert.equal(duplicateEvidence.requestAttemptCount, evidence.requestAttemptCount);
    assert.equal(evidence.requestAttemptCount, 1);
    assert.deepEqual(
      afterDuplicate.authorityEvidence,
      beforeDuplicate.authorityEvidence,
      'Duplicate delivery changed standings, cycle, matchup, transaction, or playoff evidence.',
    );

    return {
      projectId: D1L_REPLAY_STAGING_PROJECT_ID,
      leagueLabel: 'd1l-replay-source-team-fixture',
      duplicateDeliveryStable: true,
      ...buildPublicReplayEvidence(evidence),
    };
  } finally {
    await signOut(getAuth(clientApp)).catch(() => undefined);
    await Promise.all([
      deleteApp(clientApp),
      deleteAdminApp(adminApp),
    ]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runD1lReplayStagingEvidence()
    .then((result) => {
      console.log('D1L replay staging evidence passed.');
      console.log(JSON.stringify(result, null, 2));
      console.log('No account ID, password, or raw roster identifier was printed.');
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
