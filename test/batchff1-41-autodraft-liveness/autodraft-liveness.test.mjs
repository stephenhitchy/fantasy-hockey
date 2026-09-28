import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test, { before, beforeEach } from 'node:test';

import {
  getDraftAutomaticActionDecision,
  getDraftEffectiveMode,
  getDraftQueueStateAfterAutomaticPick,
} from '../../functions/src/draft-autodraft-state.util.ts';

const requireFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));
const projectId = 'demo-rinkrat-ff1-41';
process.env.GCLOUD_PROJECT = projectId;
process.env.GOOGLE_CLOUD_PROJECT = projectId;

const { makeOneServerAutomaticPick } = requireFunctions('./lib/draft-automation.js');
const { getDraftPickAtOverall } = requireFunctions('./lib/draft-pick-engine.js');
const { getApps } = requireFunctions('firebase-admin/app');
const { getFirestore, Timestamp } = requireFunctions('firebase-admin/firestore');

const PROJECTION_SNAPSHOT_ID = 'ff1-41-projection';
const PROJECTION_SNAPSHOT_HASH = 'a'.repeat(64);
const PROJECTION_AUTHORITY_VERSION = 2;
const PICK_SECONDS = 60;
const AUTO_STEP_MILLISECONDS = 1_500;
const SUPPORTED_TEAM_COUNTS = [4, 6, 8, 10, 12];

let db;

async function reset() {
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
  assert.ok(emulatorHost, 'This suite must run only in the Firestore emulator.');
  const response = await fetch(
    `http://${emulatorHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  assert.equal(response.ok, true, await response.text());
}

before(async () => {
  const [defaultApp] = getApps();
  assert.ok(defaultApp, 'Draft automation must initialize the emulator Admin app.');
  db = getFirestore(defaultApp);
  await reset();
});
beforeEach(reset);

function manualQueueState(overrides = {}) {
  return {
    autoDraftEnabled: false,
    consecutiveClockExpirations: 0,
    autoDraftActivatedByTimeout: false,
    ...overrides,
  };
}

function decisionFor({
  queue,
  overallPick = 1,
  ownerId = 'owner-1',
  pickStartedAtMilliseconds = 1_000_000,
  draftStartedAtMilliseconds = 900_000,
  nowMilliseconds = 1_061_000,
  expectation,
}) {
  return getDraftAutomaticActionDecision({
    queue,
    currentOverallPick: overallPick,
    currentOwnerId: ownerId,
    pickStartedAtMilliseconds,
    draftStartedAtMilliseconds,
    pickSeconds: PICK_SECONDS,
    autoDraftStepDelayMilliseconds: AUTO_STEP_MILLISECONDS,
    nowMilliseconds,
    expectation,
  });
}

function snakeOwnerPosition(teamCount, overallPick) {
  const round = Math.floor((overallPick - 1) / teamCount) + 1;
  const pickInRound = ((overallPick - 1) % teamCount) + 1;
  return round % 2 === 1 ? pickInRound : teamCount - pickInRound + 1;
}

function simulateAbsentPositions(teamCount, absentPositions) {
  const queues = new Map(
    Array.from({ length: teamCount }, (_, index) => [index + 1, manualQueueState()]),
  );
  const reasons = new Map(
    Array.from({ length: teamCount }, (_, index) => [index + 1, []]),
  );
  const totalPicks = teamCount * 17;

  for (let overallPick = 1; overallPick <= totalPicks; overallPick += 1) {
    const position = snakeOwnerPosition(teamCount, overallPick);

    if (!absentPositions.has(position)) {
      continue;
    }

    const queue = queues.get(position);
    const action = decisionFor({
      queue,
      overallPick,
      ownerId: `owner-${position}`,
    });
    assert.equal(action.eligible, true);
    assert.ok(action.autoPickReason);
    reasons.get(position).push(action.autoPickReason);
    queues.set(
      position,
      getDraftQueueStateAfterAutomaticPick(queue, action.autoPickReason),
    );
  }

  return { queues, reasons, totalPicks };
}

function skater(assetKey, position, draftScore, playerId) {
  return {
    assetType: 'skater',
    assetKey,
    position,
    draftScore,
    player: {
      id: playerId,
      fullName: `Fixture ${assetKey}`,
      firstName: 'Fixture',
      lastName: assetKey,
      position,
      currentTeamAbbreviation: 'MIN',
    },
  };
}

function goalie(assetKey, draftScore) {
  return {
    assetType: 'team-goalie-unit',
    assetKey,
    position: 'G',
    draftScore,
    teamName: `Fixture ${assetKey}`,
    teamAbbreviation: assetKey.slice(-3).toUpperCase(),
  };
}

function buildProjectionAssets(teamCount) {
  const assets = [];
  let score = 10_000;
  let playerId = 1;

  for (const position of ['LW', 'C', 'RW']) {
    for (let index = 0; index < teamCount * 4; index += 1) {
      assets.push(skater(`${position.toLowerCase()}-${index + 1}`, position, score, playerId));
      score -= 1;
      playerId += 1;
    }
  }

  for (let index = 0; index < teamCount * 5; index += 1) {
    assets.push(skater(`d-${index + 1}`, 'D', score, playerId));
    score -= 1;
    playerId += 1;
  }

  for (let index = 0; index < teamCount; index += 1) {
    assets.push(goalie(`goalie-unit-${index + 1}`, score));
    score -= 1;
  }

  return assets;
}

async function seedLiveDraft(teamCount, { legacyQueues = false } = {}) {
  const leagueId = `autodraft-${teamCount}-${randomUUID()}`;
  const owners = Array.from({ length: teamCount }, (_, index) => `owner-${index + 1}`);
  const now = Date.now();
  const draftRef = db.doc(`leagues/${leagueId}/draft/current`);
  const batch = db.batch();

  batch.set(db.doc(`leagues/${leagueId}`), {
    id: leagueId,
    commissionerId: owners[0],
    teamCount,
    maxTeams: teamCount,
  });
  batch.set(draftRef, {
    schemaVersion: 3,
    status: 'live',
    format: 'snake',
    totalRounds: 17,
    rosterRequirements: { LW: 3, C: 3, RW: 3, D: 4, G: 1 },
    benchSlots: 3,
    roundOneOrder: owners,
    nextOverallPick: 1,
    draftedAssetKeys: [],
    scheduledStartAt: null,
    pickSeconds: PICK_SECONDS,
    clockStatus: 'running',
    pickStartedAt: Timestamp.fromMillis(now - 61_000),
    currentPickSeconds: PICK_SECONDS,
    pausedRemainingSeconds: null,
    startedAt: Timestamp.fromMillis(now - 120_000),
    serverDraftProjectionSnapshotId: PROJECTION_SNAPSHOT_ID,
    serverDraftProjectionSnapshotHash: PROJECTION_SNAPSHOT_HASH,
    serverDraftProjectionAuthorityVersion: PROJECTION_AUTHORITY_VERSION,
  });

  owners.forEach((ownerId, index) => {
    batch.set(db.doc(`leagues/${leagueId}/teams/${ownerId}`), {
      id: ownerId,
      ownerId,
      draftPosition: index + 1,
    });
  });

  if (legacyQueues) {
    batch.set(db.doc(`leagues/${leagueId}/draft/current/queues/${owners[0]}`), {
      ownerId: owners[0],
      assetKeys: [],
    });
    batch.set(db.doc(`leagues/${leagueId}/draft/current/queues/${owners[1]}`), {
      ownerId: owners[1],
      assetKeys: [],
      autoDraftEnabled: null,
      consecutiveClockExpirations: null,
      autoDraftActivatedByTimeout: null,
    });
  }

  await batch.commit();
  return { leagueId, owners, draftRef };
}

async function expireAndReadTurn(draftRef, leagueId) {
  await draftRef.update({
    pickStartedAt: Timestamp.fromMillis(Date.now() - 61_000),
  });
  const draft = (await draftRef.get()).data();
  const currentPick = getDraftPickAtOverall(draft, draft.nextOverallPick);
  assert.ok(currentPick);
  const pickStartedAtMilliseconds = draft.pickStartedAt.toMillis();
  const queueSnapshot = await db.doc(
    `leagues/${leagueId}/draft/current/queues/${currentPick.ownerId}`,
  ).get();
  const queue = queueSnapshot.data() ?? {};
  const timeoutMode = queue.autoDraftActivatedByTimeout === true;
  const managerMode = queue.autoDraftEnabled === true && !timeoutMode;
  const expectedDueAtMilliseconds = pickStartedAtMilliseconds + (
    timeoutMode || managerMode ? AUTO_STEP_MILLISECONDS : PICK_SECONDS * 1_000
  );

  return {
    draft,
    currentPick,
    expectation: {
      expectedOverallPick: currentPick.overallPick,
      expectedOwnerId: currentPick.ownerId,
      expectedPickStartedAtMilliseconds: pickStartedAtMilliseconds,
      expectedDueAtMilliseconds,
      expectedDraftStartedAtMilliseconds: draft.startedAt.toMillis(),
    },
  };
}

test('snake order explains the recurring single holdout without an index-zero special case', () => {
  for (const teamCount of SUPPORTED_TEAM_COUNTS) {
    const secondTurnByPosition = new Map();
    const seen = new Map();

    for (let overallPick = 1; overallPick <= teamCount * 2; overallPick += 1) {
      const position = snakeOwnerPosition(teamCount, overallPick);
      const count = (seen.get(position) ?? 0) + 1;
      seen.set(position, count);

      if (count === 2) {
        secondTurnByPosition.set(position, overallPick);
      }
    }

    assert.equal(secondTurnByPosition.get(1), teamCount * 2);
    assert.equal(
      [...secondTurnByPosition.values()].filter((pick) => pick < teamCount * 2).length,
      teamCount - 1,
    );
  }
});

test('all supported sizes complete unattended mode transitions for every draft position', () => {
  for (const teamCount of SUPPORTED_TEAM_COUNTS) {
    const allPositions = new Set(
      Array.from({ length: teamCount }, (_, index) => index + 1),
    );
    const { queues, reasons, totalPicks } = simulateAbsentPositions(
      teamCount,
      allPositions,
    );

    assert.equal(
      [...reasons.values()].reduce((total, entries) => total + entries.length, 0),
      totalPicks,
    );

    for (const position of allPositions) {
      assert.deepEqual(reasons.get(position).slice(0, 2), [
        'timer-expired',
        'timer-expired',
      ]);
      assert.equal(reasons.get(position).slice(2).every(
        (reason) => reason === 'timeout-auto-mode',
      ), true);
      assert.deepEqual(queues.get(position), {
        autoDraftEnabled: false,
        consecutiveClockExpirations: 2,
        autoDraftActivatedByTimeout: true,
      });
    }
  }
});

test('one or several absent managers work with commissioner present or absent in every position', () => {
  for (const teamCount of SUPPORTED_TEAM_COUNTS) {
    for (let absentPosition = 1; absentPosition <= teamCount; absentPosition += 1) {
      const oneAbsent = simulateAbsentPositions(
        teamCount,
        new Set([absentPosition]),
      );
      assert.equal(oneAbsent.reasons.get(absentPosition).length, 17);
      assert.equal(oneAbsent.queues.get(absentPosition).autoDraftActivatedByTimeout, true);

      const severalAbsent = simulateAbsentPositions(
        teamCount,
        new Set([1, absentPosition, teamCount]),
      );
      for (const position of new Set([1, absentPosition, teamCount])) {
        assert.equal(severalAbsent.reasons.get(position).length, 17);
      }
    }
  }
});

test('explicit mode, missed-turn mode, reconnect, and legacy defaults remain distinct', () => {
  const explicit = manualQueueState({ autoDraftEnabled: true });
  const firstMiss = getDraftQueueStateAfterAutomaticPick(
    manualQueueState(),
    'timer-expired',
  );
  const secondMiss = getDraftQueueStateAfterAutomaticPick(
    firstMiss,
    'timer-expired',
  );

  assert.equal(getDraftEffectiveMode(manualQueueState()), 'manual-with-deadline');
  assert.equal(getDraftEffectiveMode(explicit), 'manager-auto');
  assert.equal(getDraftEffectiveMode(secondMiss), 'timeout-auto');
  assert.equal(decisionFor({ queue: explicit, nowMilliseconds: 1_002_000 }).autoPickReason, 'manager-auto-mode');
  assert.equal(decisionFor({ queue: secondMiss, nowMilliseconds: 1_002_000 }).autoPickReason, 'timeout-auto-mode');
  assert.deepEqual(firstMiss, {
    autoDraftEnabled: false,
    consecutiveClockExpirations: 1,
    autoDraftActivatedByTimeout: false,
  });
  assert.deepEqual(secondMiss, {
    autoDraftEnabled: false,
    consecutiveClockExpirations: 2,
    autoDraftActivatedByTimeout: true,
  });

  const reconnectedAndTurnedOff = manualQueueState();
  assert.equal(getDraftEffectiveMode(reconnectedAndTurnedOff), 'manual-with-deadline');
  assert.deepEqual(
    decisionFor({ queue: reconnectedAndTurnedOff }),
    decisionFor({ queue: reconnectedAndTurnedOff }),
    'Multiple tabs or reconnects cannot change a server decision without a stored preference write.',
  );
});

test('deadline expectations reject old session, pick, owner, and pick-start identities', () => {
  const base = {
    expectedOverallPick: 5,
    expectedOwnerId: 'owner-2',
    expectedPickStartedAtMilliseconds: 1_000_000,
    expectedDueAtMilliseconds: 1_060_000,
    expectedDraftStartedAtMilliseconds: 900_000,
  };
  const input = {
    queue: manualQueueState(),
    overallPick: 5,
    ownerId: 'owner-2',
    pickStartedAtMilliseconds: 1_000_000,
    draftStartedAtMilliseconds: 900_000,
    nowMilliseconds: 1_061_000,
  };

  assert.equal(decisionFor({ ...input, expectation: base }).eligible, true);
  assert.equal(decisionFor({ ...input, overallPick: 6, expectation: base }).blockedReason, 'stale-pick');
  assert.equal(decisionFor({ ...input, ownerId: 'owner-3', expectation: base }).blockedReason, 'stale-owner');
  assert.equal(decisionFor({ ...input, pickStartedAtMilliseconds: 1_000_001, expectation: base }).blockedReason, 'stale-pick-start');
  assert.equal(decisionFor({ ...input, draftStartedAtMilliseconds: 900_001, expectation: base }).blockedReason, 'stale-session');
  assert.equal(decisionFor({ ...input, nowMilliseconds: 1_059_999, expectation: base }).blockedReason, 'before-deadline');
});

test('the real transaction completes unattended legacy-shaped drafts at every supported size', async () => {
  for (const teamCount of SUPPORTED_TEAM_COUNTS) {
    const { leagueId, owners, draftRef } = await seedLiveDraft(teamCount, {
      legacyQueues: true,
    });
    const assets = buildProjectionAssets(teamCount);
    const totalPicks = teamCount * 17;

    for (let index = 0; index < totalPicks; index += 1) {
      const { expectation } = await expireAndReadTurn(draftRef, leagueId);
      const result = await makeOneServerAutomaticPick(
        leagueId,
        assets,
        PROJECTION_SNAPSHOT_ID,
        PROJECTION_SNAPSHOT_HASH,
        PROJECTION_AUTHORITY_VERSION,
        expectation,
      );
      assert.equal(result.picked, true, JSON.stringify({ teamCount, index, result }));
    }

    const [draftSnapshot, picksSnapshot] = await Promise.all([
      draftRef.get(),
      draftRef.collection('picks').get(),
    ]);
    const completedDraft = draftSnapshot.data();
    assert.equal(completedDraft.status, 'complete');
    assert.equal(completedDraft.clockStatus, 'complete');
    assert.equal(completedDraft.nextOverallPick, totalPicks + 1);
    assert.equal(completedDraft.draftedAssetKeys.length, totalPicks);
    assert.equal(picksSnapshot.size, totalPicks);

    for (const ownerId of owners) {
      const [queueSnapshot, rosterSnapshot] = await Promise.all([
        draftRef.collection('queues').doc(ownerId).get(),
        db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`).get(),
      ]);
      const queue = queueSnapshot.data();
      const roster = rosterSnapshot.data();
      const ownerPicks = picksSnapshot.docs
        .map((snapshot) => snapshot.data())
        .filter((pick) => pick.ownerId === ownerId);

      assert.equal(queue.autoDraftEnabled, false);
      assert.equal(queue.autoDraftActivatedByTimeout, true);
      assert.equal(queue.consecutiveClockExpirations, 2);
      assert.deepEqual(ownerPicks.slice(0, 2).map((pick) => pick.autoPickReason), [
        'timer-expired',
        'timer-expired',
      ]);
      assert.equal(ownerPicks.slice(2).every(
        (pick) => pick.autoPickReason === 'timeout-auto-mode',
      ), true);
      assert.equal(
        roster.activeSlots.filter((slot) => slot.asset).length +
          roster.benchSlots.filter((slot) => slot.asset).length,
        17,
      );
    }
  }
});

test('duplicate deadline jobs accept one pick and stale work cannot act on the next turn', async () => {
  const { leagueId, draftRef } = await seedLiveDraft(4);
  const assets = buildProjectionAssets(4);
  const { expectation } = await expireAndReadTurn(draftRef, leagueId);
  const results = await Promise.all([
    makeOneServerAutomaticPick(
      leagueId,
      assets,
      PROJECTION_SNAPSHOT_ID,
      PROJECTION_SNAPSHOT_HASH,
      PROJECTION_AUTHORITY_VERSION,
      expectation,
    ),
    makeOneServerAutomaticPick(
      leagueId,
      assets,
      PROJECTION_SNAPSHOT_ID,
      PROJECTION_SNAPSHOT_HASH,
      PROJECTION_AUTHORITY_VERSION,
      expectation,
    ),
  ]);

  assert.equal(results.filter((result) => result.picked).length, 1);
  assert.equal((await draftRef.collection('picks').get()).size, 1);
  assert.equal((await draftRef.get()).data().nextOverallPick, 2);

  const staleResult = await makeOneServerAutomaticPick(
    leagueId,
    assets,
    PROJECTION_SNAPSHOT_ID,
    PROJECTION_SNAPSHOT_HASH,
    PROJECTION_AUTHORITY_VERSION,
    expectation,
  );
  assert.equal(staleResult.picked, false);
  assert.equal(staleResult.blockedReason, 'stale-pick');
  assert.equal((await draftRef.collection('picks').get()).size, 1);

  const recoveredTurn = await expireAndReadTurn(draftRef, leagueId);
  const recoveryResult = await makeOneServerAutomaticPick(
    leagueId,
    assets,
    PROJECTION_SNAPSHOT_ID,
    PROJECTION_SNAPSHOT_HASH,
    PROJECTION_AUTHORITY_VERSION,
    recoveredTurn.expectation,
  );
  assert.equal(recoveryResult.picked, true);
  assert.equal((await draftRef.collection('picks').get()).size, 2);
});

test('an invalid candidate pool fails visibly instead of silently skipping a team', async () => {
  await assert.rejects(
    makeOneServerAutomaticPick(
      'league-without-candidates',
      [],
      PROJECTION_SNAPSHOT_ID,
      PROJECTION_SNAPSHOT_HASH,
      PROJECTION_AUTHORITY_VERSION,
    ),
    /No shared projection assets are available/,
  );
});

test('UI and worker diagnostics distinguish fallback, explicit, and timeout modes', async () => {
  const [room, explanation, automation] = await Promise.all([
    readFile('src/app/features/draft/draft-room/draft-room.ts', 'utf8'),
    readFile('src/app/features/draft/draft-room/draft-mobile-resilience.util.ts', 'utf8'),
    readFile('functions/src/draft-automation.ts', 'utf8'),
  ]);

  assert.match(room, /Auto-pick at 0:00/);
  assert.match(room, /queue\.autoDraftEnabled \|\| queue\.autoDraftActivatedByTimeout/);
  assert.match(room, /!this\.myAutoDraftActive\(\)/);
  assert.match(explanation, /Missed-turn Auto-Draft/);
  assert.match(explanation, /timeout-auto-mode/);
  assert.match(automation, /expectedDraftStartedAtMilliseconds/);
  assert.match(automation, /expectedOwnerId/);
  assert.match(automation, /teamCorrelationHash/);
  assert.match(automation, /effectiveDraftingMode/);
  assert.match(automation, /autoDraftReason/);
});
