import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import test, { after, before, beforeEach } from 'node:test';

import { evaluateProtectedRosterRuntimeContract } from '../../scripts/release/protected-roster-runtime-contract.util.mjs';

const ROOT = new URL('../../', import.meta.url);
const requireFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));
const projectId = 'demo-rinkrat-b2a';

process.env.GCLOUD_PROJECT = projectId;
process.env.GOOGLE_CLOUD_PROJECT = projectId;

const {
  buildRosterActionSubmissionEvidence,
  createRosterActionRequestFingerprint,
  createRosterActionTransactionId,
  resolveRosterActionSubmission,
} = requireFunctions('./lib/shared/core/team/roster-action-idempotency.util.js');
const {
  determineEarliestEligibleSourceBlock,
} = requireFunctions('./lib/roster-moves.js');
const { deleteApp, initializeApp } = requireFunctions('firebase-admin/app');
const { getFirestore } = requireFunctions('firebase-admin/firestore');

async function loadStandaloneBrowserUtility(relativePath) {
  const typescript = await readFile(new URL(relativePath, ROOT), 'utf8');
  const javascript = stripTypeScriptTypes(typescript, { mode: 'strip' });

  return import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
  );
}

const operationResolution = await loadStandaloneBrowserUtility(
  'src/app/features/free-agents/free-agent-operation-resolution.util.ts',
);
const transportResolution = await loadStandaloneBrowserUtility(
  'src/app/core/transactions/roster-action-transport.util.ts',
);

let app;
let db;

async function resetEmulator() {
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
  assert.ok(emulatorHost, 'B2A must run only in the Firestore emulator.');
  const response = await fetch(
    `http://${emulatorHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  assert.equal(response.ok, true, await response.text());
}

before(async () => {
  app = initializeApp({ projectId }, `b2a-${randomUUID()}`);
  db = getFirestore(app);
  await resetEmulator();
});

beforeEach(resetEmulator);

after(async () => {
  if (app) {
    await deleteApp(app);
  }
});

function commandIntent(overrides = {}) {
  return {
    action: 'add-drop',
    assetKey: 'skater-200',
    expectedOutgoingAssetKey: 'skater-100',
    requestedCycle: 4,
    requestedLabel: 'Cycle 4',
    slotId: 'B-1',
    ...overrides,
  };
}

async function executeEmulatedRosterCommand({
  leagueId = 'league-b2a',
  ownerId = 'owner-a',
  submissionId = 'roster_submission_12345678',
  intent = commandIntent(),
} = {}) {
  const requestFingerprint = createRosterActionRequestFingerprint(intent);
  const transactionId = createRosterActionTransactionId({
    namespace: 'roster-add',
    leagueId,
    ownerId,
    submissionId,
  });
  const transactionRef = db.doc(`leagues/${leagueId}/transactions/${transactionId}`);
  const rosterRef = db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`);
  const result = {
    applied: true,
    mode: 'ownership-only',
    effectiveCycleNumber: intent.requestedCycle,
    message: 'Bench roster move applied.',
  };

  return db.runTransaction(async (transaction) => {
    const [submissionSnapshot, rosterSnapshot] = await Promise.all([
      transaction.get(transactionRef),
      transaction.get(rosterRef),
    ]);
    const resolution = resolveRosterActionSubmission(
      submissionSnapshot.exists ? submissionSnapshot.data() : null,
      submissionId,
      requestFingerprint,
    );

    if (resolution.status === 'match') {
      return resolution.result;
    }
    if (resolution.status === 'conflict') {
      throw new Error('roster-submission-id-reused');
    }

    assert.equal(rosterSnapshot.exists, true);
    const roster = rosterSnapshot.data();
    assert.equal(roster.assetKey, intent.expectedOutgoingAssetKey);
    transaction.set(rosterRef, {
      assetKey: intent.assetKey,
      mutationCount: Number(roster.mutationCount ?? 0) + 1,
    });
    transaction.set(transactionRef, {
      type: intent.action,
      ownerId,
      ...buildRosterActionSubmissionEvidence({
        submissionId,
        requestFingerprint,
        result,
      }),
    });
    return result;
  });
}

test('deterministic receipt IDs are owner/league bound and fingerprints are order-stable', () => {
  const first = createRosterActionTransactionId({
    namespace: 'roster-add',
    leagueId: 'league-a',
    ownerId: 'owner-a',
    submissionId: 'submission_12345678',
  });
  const duplicate = createRosterActionTransactionId({
    namespace: 'roster-add',
    leagueId: 'league-a',
    ownerId: 'owner-a',
    submissionId: 'submission_12345678',
  });
  const otherOwner = createRosterActionTransactionId({
    namespace: 'roster-add',
    leagueId: 'league-a',
    ownerId: 'owner-b',
    submissionId: 'submission_12345678',
  });

  assert.equal(first, duplicate);
  assert.notEqual(first, otherOwner);
  assert.match(first, /^roster-command-[a-f0-9]{48}$/);
  assert.equal(
    createRosterActionRequestFingerprint({ b: 2, a: { d: 4, c: 3 } }),
    createRosterActionRequestFingerprint({ a: { c: 3, d: 4 }, b: 2 }),
  );
});

test('lost-response and concurrent same-ID retries commit one roster mutation', async () => {
  const rosterRef = db.doc('leagues/league-b2a/teams/owner-a/roster/current');
  await rosterRef.set({ assetKey: 'skater-100', mutationCount: 0 });

  const [first, duplicate] = await Promise.all([
    executeEmulatedRosterCommand(),
    executeEmulatedRosterCommand(),
  ]);
  const replayAfterLostResponse = await executeEmulatedRosterCommand();
  const roster = (await rosterRef.get()).data();
  const transactions = await db.collection('leagues/league-b2a/transactions').get();

  assert.deepEqual(first, duplicate);
  assert.deepEqual(first, replayAfterLostResponse);
  assert.equal(roster.assetKey, 'skater-200');
  assert.equal(roster.mutationCount, 1);
  assert.equal(transactions.size, 1);
});

test('same submission ID with changed intent fails without another write', async () => {
  const rosterRef = db.doc('leagues/league-b2a/teams/owner-a/roster/current');
  await rosterRef.set({ assetKey: 'skater-100', mutationCount: 0 });
  await executeEmulatedRosterCommand();

  await assert.rejects(
    executeEmulatedRosterCommand({
      intent: commandIntent({ assetKey: 'skater-999' }),
    }),
    /roster-submission-id-reused/,
  );

  assert.deepEqual((await rosterRef.get()).data(), {
    assetKey: 'skater-200',
    mutationCount: 1,
  });
});

test('structured roster observation reports exact committed mode and cycle', () => {
  const benchExpectation = {
    kind: 'roster-slot',
    rosterArea: 'bench',
    slotId: 'B-1',
    incomingAssetKey: 'skater-200',
  };
  const observation = {
    activeSlots: [{
      slotId: 'C-1',
      assetKey: 'skater-100',
      pendingIncomingAssetKey: 'skater-200',
      pendingEffectiveCycleNumber: 5,
    }],
    benchSlots: [{
      slotId: 'B-1',
      assetKey: 'skater-200',
      pendingIncomingAssetKey: null,
      assetEligibleFromCycleNumber: 4,
    }],
    waivers: [],
  };

  assert.deepEqual(
    operationResolution.resolveObservedFreeAgentRosterMove(
      benchExpectation,
      observation,
    ),
    { mode: 'ownership-only', effectiveCycleNumber: 4 },
  );
  assert.deepEqual(
    operationResolution.resolveObservedFreeAgentRosterMove({
      ...benchExpectation,
      rosterArea: 'active',
      slotId: 'C-1',
    }, observation),
    { mode: 'queued', effectiveCycleNumber: 5 },
  );
  assert.equal(
    operationResolution.resolveObservedFreeAgentRosterMove({
      ...benchExpectation,
      incomingAssetKey: 'skater-other',
    }, observation),
    null,
  );
});

test('a failed final source read stays uncertain while a confirmed absence is retry-safe', () => {
  assert.match(
    operationResolution.getUnconfirmedRosterActionMessage('unavailable'),
    /Check My Team before retrying because the transaction may have completed/,
  );
  assert.match(
    operationResolution.getUnconfirmedRosterActionMessage('confirmed-absent'),
    /You can safely try again/,
  );
});

test('only definitive callable codes bypass possibly-committed recovery', () => {
  for (const code of [
    'functions/unavailable',
    'deadline-exceeded',
    'internal',
    'unknown',
    'cancelled',
    'network-request-failed',
    '',
  ]) {
    assert.equal(
      transportResolution.isPossiblyCommittedRosterActionError({ code }),
      true,
      code,
    );
  }

  for (const code of [
    'functions/invalid-argument',
    'permission-denied',
    'failed-precondition',
    'already-exists',
    'aborted',
  ]) {
    assert.equal(
      transportResolution.isPossiblyCommittedRosterActionError({ code }),
      false,
      code,
    );
  }
});

test('quick retry and confirmation timing cover the complete second callable window', async () => {
  assert.ok(
    transportResolution.ROSTER_ACTION_CONFIRMATION_WINDOW_MS >=
      transportResolution.ROSTER_ACTION_QUICK_RETRY_WINDOW_MS +
      transportResolution.ROSTER_ACTION_CALLABLE_TIMEOUT_MS +
      5_000,
  );

  const originalNow = Date.now;
  let fakeNow = 1_000;
  let attemptCount = 0;

  try {
    Date.now = () => fakeNow;
    const result = await transportResolution.executeIdempotentRosterActionWithQuickRetry(
      async () => {
        attemptCount += 1;
        if (attemptCount === 1) {
          fakeNow += transportResolution.ROSTER_ACTION_QUICK_RETRY_WINDOW_MS;
          throw { code: 'functions/unavailable' };
        }
        return 'replayed';
      },
    );

    assert.equal(result, 'replayed');
    assert.equal(attemptCount, 2);

    attemptCount = 0;
    fakeNow = 1_000;
    await assert.rejects(
      transportResolution.executeIdempotentRosterActionWithQuickRetry(
        async () => {
          attemptCount += 1;
          fakeNow += transportResolution.ROSTER_ACTION_QUICK_RETRY_WINDOW_MS + 1;
          throw { code: 'functions/unavailable' };
        },
      ),
    );
    assert.equal(attemptCount, 1);
  } finally {
    Date.now = originalNow;
  }
});

test('the exact puck-drop timestamp closes a stale scheduled provider state', () => {
  const schedule = [
    { id: 1, gameDate: '2026-10-01', startTimeUTC: '2026-10-01T23:00:00Z', gameState: 'OFF' },
    { id: 2, gameDate: '2026-10-02', startTimeUTC: '2026-10-02T23:00:00Z', gameState: 'OFF' },
    { id: 3, gameDate: '2026-10-03', startTimeUTC: '2026-10-03T23:00:00Z', gameState: 'OFF' },
    { id: 4, gameDate: '2026-10-04', startTimeUTC: '2026-10-04T23:00:00Z', gameState: 'OFF' },
    { id: 5, gameDate: '2026-10-05', startTimeUTC: '2026-10-05T23:00:00Z', gameState: 'OFF' },
    { id: 6, gameDate: '2026-10-06', startTimeUTC: '2026-10-06T23:00:00Z', gameState: 'FUT' },
    { id: 7, gameDate: '2026-10-07', startTimeUTC: '2026-10-07T23:00:00Z', gameState: 'FUT' },
  ];

  assert.equal(determineEarliestEligibleSourceBlock({
    schedule,
    gamesPerCycle: 6,
    actionBoundaryMilliseconds: Date.parse('2026-10-06T23:00:00Z'),
  }), 2);
});

test('postponed or cancelled games do not use an obsolete puck-drop boundary', () => {
  for (const gameScheduleState of ['PPD', 'CNCL']) {
    const schedule = Array.from({ length: 6 }, (_, index) => ({
      id: index + 1,
      gameDate: `2026-10-${String(index + 1).padStart(2, '0')}`,
      ...(index === 0
        ? {}
        : {
            startTimeUTC:
              `2026-10-${String(index + 1).padStart(2, '0')}T23:00:00Z`,
          }),
      gameState: 'FUT',
      ...(index === 0 ? { gameScheduleState } : {}),
    }));

    assert.equal(determineEarliestEligibleSourceBlock({
      schedule,
      gamesPerCycle: 6,
      actionBoundaryMilliseconds: Date.parse('2026-10-02T12:00:00Z'),
    }), 1, gameScheduleState);
  }
});

test('source contract keeps exact-player speed, expected outgoing lock, and final server recovery', async () => {
  const [
    authority,
    moves,
    freeAgents,
    rosterService,
    immediateRosterTransport,
    secureRosterTransport,
  ] = await Promise.all([
    readFile(new URL('functions/src/roster-authority.ts', ROOT), 'utf8'),
    readFile(new URL('functions/src/roster-moves.ts', ROOT), 'utf8'),
    readFile(new URL('src/app/features/free-agents/free-agents.ts', ROOT), 'utf8'),
    readFile(new URL('src/app/core/team/roster.service.ts', ROOT), 'utf8'),
    readFile(new URL('src/app/core/transactions/immediate-roster-move.service.ts', ROOT), 'utf8'),
    readFile(new URL('src/app/core/transactions/roster-authority.service.ts', ROOT), 'utf8'),
  ]);

  assert.match(authority, /loadExactRosterActionPlayerTeamIdentity/);
  assert.match(authority, /expectedOutgoingAssetKey/);
  assert.match(authority, /transaction\.get\(transactionRef\)/);
  assert.match(moves, /getCurrentNhlPlayerTeamIdentity\(playerId, true\)/);
  assert.match(moves, /isImmediateAdd[\s\S]+loadExactRosterActionPlayerTeamIdentity/);
  assert.match(moves, /actionBoundaryMilliseconds/);
  assert.match(moves, /rosterContainsAsset\(roster, incomingKey\)/);
  assert.match(
    moves,
    /moveType === 'active-bench-swap'[\s\S]+getEarliestEligibleCycleNumber\([\s\S]+actionBoundaryMilliseconds/,
  );
  assert.match(freeAgents, /createRosterActionSubmissionId/);
  assert.match(freeAgents, /getFantasyRosterFromServer/);
  assert.match(freeAgents, /ROSTER_ACTION_CONFIRMATION_WINDOW_MS/);
  assert.match(
    freeAgents,
    /Date\.now\(\) - this\.selectedAssetEligibilityLoadedAt > 30_000/,
  );
  assert.match(rosterService, /getDocFromServer/);
  assert.match(immediateRosterTransport, /timeout:\s*65_000/);
  assert.match(secureRosterTransport, /timeout:\s*65_000/);
});

test('the protected roster guard fails closed if B2A recovery evidence disappears', async () => {
  const guardedSources = {
    browserRosterConfig: await readFile(new URL('src/app/core/team/roster-config.ts', ROOT), 'utf8'),
    serverRosterConfig: await readFile(new URL('functions/src/shared/core/team/roster-config.ts', ROOT), 'utf8'),
    rosterAuthority: await readFile(new URL('functions/src/roster-authority.ts', ROOT), 'utf8'),
    draftAuthority: await readFile(new URL('functions/src/draft-authority.ts', ROOT), 'utf8'),
    draftAutomation: await readFile(new URL('functions/src/draft-automation.ts', ROOT), 'utf8'),
    draftPickEngine: await readFile(new URL('functions/src/draft-pick-engine.ts', ROOT), 'utf8'),
    projectionRanking: await readFile(new URL('functions/src/shared/core/projection/projection-ranking.util.ts', ROOT), 'utf8'),
    rosterMoves: await readFile(new URL('functions/src/roster-moves.ts', ROOT), 'utf8'),
    cycleScoring: await readFile(new URL('functions/src/shared/core/cycle/cycle-scoring.service.ts', ROOT), 'utf8'),
    browserCycleScoring: await readFile(new URL('src/app/core/cycle/cycle-scoring.service.ts', ROOT), 'utf8'),
    assetCycleWindow: await readFile(new URL('functions/src/shared/core/cycle/asset-cycle-window.service.ts', ROOT), 'utf8'),
    browserAssetCycleWindow: await readFile(new URL('src/app/core/cycle/asset-cycle-window.service.ts', ROOT), 'utf8'),
    cycleService: await readFile(new URL('functions/src/shared/core/cycle/cycle.service.ts', ROOT), 'utf8'),
    injuryReplacementWindow: await readFile(new URL('functions/src/shared/core/cycle/injury-replacement-window.util.ts', ROOT), 'utf8'),
    playoffWindowBank: await readFile(new URL('functions/src/shared/core/playoffs/playoff-window-bank.service.ts', ROOT), 'utf8'),
    leagueAutomation: await readFile(new URL('functions/src/league-automation.ts', ROOT), 'utf8'),
    canonicalImpactFeed: await readFile(new URL('functions/src/nhl-canonical-impact-feed.ts', ROOT), 'utf8'),
    finalScoreReconciliation: await readFile(new URL('functions/src/shared/core/nhl/final-score-reconciliation.util.ts', ROOT), 'utf8'),
    rosterActionIdempotency: await readFile(new URL('functions/src/shared/core/team/roster-action-idempotency.util.ts', ROOT), 'utf8'),
    freeAgents: await readFile(new URL('src/app/features/free-agents/free-agents.ts', ROOT), 'utf8'),
    browserRosterService: await readFile(new URL('src/app/core/team/roster.service.ts', ROOT), 'utf8'),
    rosterActionTransport: await readFile(new URL('src/app/core/transactions/roster-action-transport.util.ts', ROOT), 'utf8'),
  };
  const current = evaluateProtectedRosterRuntimeContract(guardedSources);
  const missingReceipt = evaluateProtectedRosterRuntimeContract({
    ...guardedSources,
    rosterActionIdempotency: '',
  });
  const missingRecovery = evaluateProtectedRosterRuntimeContract({
    ...guardedSources,
    freeAgents: '',
    browserRosterService: '',
  });

  assert.equal(current.ready, true, current.blockers.join('\n'));
  assert.equal(missingReceipt.ready, false);
  assert.ok(missingReceipt.blockers.some((blocker) => blocker.includes('receipt')));
  assert.equal(missingRecovery.ready, false);
  assert.ok(missingRecovery.blockers.some((blocker) => blocker.includes('browser')));
});
