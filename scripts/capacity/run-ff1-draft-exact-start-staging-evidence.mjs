import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { D1N_FIXTURE_LEAGUE_ID } from './seed-d1n-route-fixture.mjs';
import { D1N_STAGING_PROJECT_ID } from './prepare-d1n-staging-hosting.mjs';
import {
  prepareSyntheticFf1ReadinessRun,
  readCleanGitRevision,
  restoreSafeSyntheticFf1Draft,
  verifyFf1ReadinessStagingManifest,
  waitForFf1ReadinessSnapshot,
} from './run-ff1-draft-readiness-staging-evidence.mjs';

export const FF1_EXACT_START_STAGING_ACKNOWLEDGEMENT = `exercise-ff1-exact-start-in-${D1N_STAGING_PROJECT_ID}`;

const DEFAULT_START_OFFSET_MILLISECONDS = 25 * 60 * 1000;
const DEFAULT_TIMEOUT_MILLISECONDS = 35 * 60 * 1000;
const START_OBSERVATION_LEAD_MILLISECONDS = 15_000;
const START_OBSERVATION_INTERVAL_MILLISECONDS = 250;
const MAX_START_LATENCY_MILLISECONDS = 5_000;
const requireFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function assertFf1ExactStartStagingSafety(environment = process.env) {
  if (
    environment.FIRESTORE_EMULATOR_HOST ||
    environment.FIREBASE_AUTH_EMULATOR_HOST ||
    environment.FIREBASE_DATABASE_EMULATOR_HOST
  ) {
    throw new Error('FF1 exact-start evidence refuses every Emulator Suite environment.');
  }

  if (environment.FF1_EXACT_START_STAGING_PROJECT_ID !== D1N_STAGING_PROJECT_ID) {
    throw new Error(`FF1_EXACT_START_STAGING_PROJECT_ID must equal ${D1N_STAGING_PROJECT_ID}.`);
  }

  if (environment.FF1_EXACT_START_STAGING_ACK !== FF1_EXACT_START_STAGING_ACKNOWLEDGEMENT) {
    throw new Error(
      'FF1_EXACT_START_STAGING_ACK does not authorize the exact synthetic Draft start run.',
    );
  }

  const startOffsetMilliseconds = Number(
    environment.FF1_EXACT_START_OFFSET_MILLISECONDS ?? DEFAULT_START_OFFSET_MILLISECONDS,
  );
  const timeoutMilliseconds = Number(
    environment.FF1_EXACT_START_TIMEOUT_MILLISECONDS ?? DEFAULT_TIMEOUT_MILLISECONDS,
  );

  if (
    !Number.isInteger(startOffsetMilliseconds) ||
    startOffsetMilliseconds < 22 * 60 * 1000 ||
    startOffsetMilliseconds > 30 * 60 * 1000
  ) {
    throw new Error(
      'FF1_EXACT_START_OFFSET_MILLISECONDS must be an integer from 1320000 through 1800000.',
    );
  }

  if (
    !Number.isInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < startOffsetMilliseconds + 30_000 ||
    timeoutMilliseconds > 45 * 60 * 1000
  ) {
    throw new Error(
      'FF1_EXACT_START_TIMEOUT_MILLISECONDS must cover the scheduled start and be no more than 2700000.',
    );
  }

  return { startOffsetMilliseconds, timeoutMilliseconds };
}

async function waitUntil(targetMilliseconds) {
  while (Date.now() < targetMilliseconds) {
    await wait(Math.min(targetMilliseconds - Date.now(), 30_000));
  }
}

async function waitForAuthoritativeDraftStart(draftRef, deadlineMilliseconds) {
  while (Date.now() <= deadlineMilliseconds) {
    const snapshot = await draftRef.get();
    const draft = snapshot.data() ?? {};

    if (draft.status === 'live') {
      return snapshot;
    }

    await wait(START_OBSERVATION_INTERVAL_MILLISECONDS);
  }

  throw new Error('The synthetic Draft did not become live inside the observation window.');
}

export function buildPublicFf1ExactStartEvidence(evidence) {
  return {
    projectId: D1N_STAGING_PROJECT_ID,
    leagueLabel: 'd1n-capacity-fixture',
    releaseManifestMatched: evidence.releaseManifestMatched === true,
    readyBeforeStart: evidence.readyBeforeStart === true,
    readinessLeadMilliseconds: evidence.readinessLeadMilliseconds,
    authoritativeStartLatencyMilliseconds: evidence.authoritativeStartLatencyMilliseconds,
    firstClockLatencyMilliseconds: evidence.firstClockLatencyMilliseconds,
    clockStatus: evidence.clockStatus,
    nextOverallPick: evidence.nextOverallPick,
    pickCount: evidence.pickCount,
    withinFiveSecondGate: evidence.withinFiveSecondGate === true,
    safeResetDays: 7,
  };
}

export async function runFf1DraftExactStartStagingEvidence(environment = process.env) {
  const { startOffsetMilliseconds, timeoutMilliseconds } =
    assertFf1ExactStartStagingSafety(environment);
  const sourceRevision = readCleanGitRevision();
  await verifyFf1ReadinessStagingManifest(sourceRevision);

  const { applicationDefault, deleteApp, initializeApp } = requireFunctions('firebase-admin/app');
  const { FieldValue, getFirestore } = requireFunctions('firebase-admin/firestore');
  const app = initializeApp(
    {
      credential: applicationDefault(),
      projectId: D1N_STAGING_PROJECT_ID,
    },
    `ff1-exact-start-evidence-${Date.now()}`,
  );
  let draftRef = null;

  try {
    assert.equal(app.options.projectId, D1N_STAGING_PROJECT_ID);
    const firestore = getFirestore(app);
    const scheduledStartMilliseconds = Date.now() + startOffsetMilliseconds;
    const scheduledStartAt = new Date(scheduledStartMilliseconds);
    draftRef = await prepareSyntheticFf1ReadinessRun(firestore, FieldValue, scheduledStartAt);

    const readySnapshot = await waitForFf1ReadinessSnapshot(
      () => draftRef.get(),
      (snapshot) => {
        const status = snapshot.data()?.serverDraftReadinessStatus;
        return status === 'ready' || status === 'error';
      },
      timeoutMilliseconds,
      'The exact-start readiness state',
    );
    const readyDraft = readySnapshot.data() ?? {};
    const readyAtMilliseconds = readyDraft.serverDraftReadinessUpdatedAt?.toMillis?.() ?? 0;

    assert.equal(readyDraft.serverDraftReadinessStatus, 'ready');
    assert.equal(readyDraft.status, 'scheduled');
    assert.equal(readyDraft.clockStatus, 'stopped');
    assert.ok(readyAtMilliseconds > 0);
    assert.ok(readyAtMilliseconds < scheduledStartMilliseconds);

    await waitUntil(scheduledStartMilliseconds - START_OBSERVATION_LEAD_MILLISECONDS);

    const [preStartSnapshot, preStartPicks] = await Promise.all([
      draftRef.get(),
      draftRef.collection('picks').limit(1).get(),
    ]);
    const preStartDraft = preStartSnapshot.data() ?? {};

    assert.equal(preStartDraft.status, 'scheduled');
    assert.equal(preStartDraft.clockStatus, 'stopped');
    assert.equal(preStartDraft.nextOverallPick, 1);
    assert.equal(preStartPicks.empty, true);

    const liveSnapshot = await waitForAuthoritativeDraftStart(
      draftRef,
      scheduledStartMilliseconds + 10_000,
    );
    const liveDraft = liveSnapshot.data() ?? {};
    const startedAtMilliseconds = liveDraft.startedAt?.toMillis?.() ?? 0;
    const pickStartedAtMilliseconds = liveDraft.pickStartedAt?.toMillis?.() ?? 0;
    const [postStartPicks] = await Promise.all([draftRef.collection('picks').limit(2).get()]);
    const authoritativeStartLatencyMilliseconds =
      startedAtMilliseconds - scheduledStartMilliseconds;
    const firstClockLatencyMilliseconds = pickStartedAtMilliseconds - scheduledStartMilliseconds;
    const evidence = buildPublicFf1ExactStartEvidence({
      releaseManifestMatched: true,
      readyBeforeStart: true,
      readinessLeadMilliseconds: scheduledStartMilliseconds - readyAtMilliseconds,
      authoritativeStartLatencyMilliseconds,
      firstClockLatencyMilliseconds,
      clockStatus: liveDraft.clockStatus,
      nextOverallPick: liveDraft.nextOverallPick,
      pickCount: postStartPicks.size,
      withinFiveSecondGate:
        authoritativeStartLatencyMilliseconds >= 0 &&
        authoritativeStartLatencyMilliseconds <= MAX_START_LATENCY_MILLISECONDS &&
        firstClockLatencyMilliseconds >= 0 &&
        firstClockLatencyMilliseconds <= MAX_START_LATENCY_MILLISECONDS,
    });

    assert.equal(liveDraft.status, 'live');
    assert.equal(liveDraft.clockStatus, 'running');
    assert.equal(liveDraft.nextOverallPick, 1);
    assert.equal(postStartPicks.empty, true);
    assert.ok(startedAtMilliseconds >= scheduledStartMilliseconds);
    assert.ok(pickStartedAtMilliseconds >= scheduledStartMilliseconds);

    if (!evidence.withinFiveSecondGate) {
      throw new Error(`The five-second exact-start gate failed: ${JSON.stringify(evidence)}`);
    }

    return evidence;
  } finally {
    if (draftRef) {
      await restoreSafeSyntheticFf1Draft(draftRef, FieldValue);
    }
    await deleteApp(app);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFf1DraftExactStartStagingEvidence()
    .then((evidence) => {
      console.log('FF1 exact scheduled-start staging evidence passed.');
      console.log(JSON.stringify(evidence, null, 2));
      console.log(
        'The synthetic Draft was reset seven days ahead; task, projection, and Function logs were preserved for audit.',
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
