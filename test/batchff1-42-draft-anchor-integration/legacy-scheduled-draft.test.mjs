import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test, { after, before, beforeEach } from 'node:test';

import {
  DRAFT_MEMBERSHIP_LOCK_LEAD_MILLISECONDS,
  createDraftParticipantHash,
  draftFinalizationMatchesParticipants,
  isDraftMembershipFinalizedForSchedule,
} from '../../functions/src/draft-lifecycle.util.ts';

const NHL_DRAFT_CLUBS = [
  'ANA', 'BOS', 'BUF', 'CGY', 'CAR', 'CHI', 'COL', 'CBJ',
  'DAL', 'DET', 'EDM', 'FLA', 'LAK', 'MIN', 'MTL', 'NSH',
  'NJD', 'NYI', 'NYR', 'OTT', 'PHI', 'PIT', 'SJS', 'SEA',
  'STL', 'TBL', 'TOR', 'UTA', 'VAN', 'VGK', 'WSH', 'WPG',
];

const requireFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));
const projectId = 'demo-rinkrat-ff1-42';
process.env.GCLOUD_PROJECT = projectId;
process.env.GOOGLE_CLOUD_PROJECT = projectId;

const { finalizeScheduledDraftMembership } = requireFunctions('./lib/draft-automation.js');
const { deleteApp, initializeApp } = requireFunctions('firebase-admin/app');
const { getFirestore, Timestamp } = requireFunctions('firebase-admin/firestore');

let app;
let db;

async function reset() {
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
  assert.ok(emulatorHost, 'This suite must run only in the Firestore emulator.');
  const result = await fetch(
    `http://${emulatorHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  assert.equal(result.ok, true, await result.text());
}

function buildSeasonGames(teamAbbreviation, teamIndex) {
  return Array.from({ length: 82 }, (_, gameIndex) => {
    const start = new Date(Date.UTC(2026, 9, 1 + gameIndex, 2));

    return {
      id: 2026020000 + teamIndex * 100 + gameIndex + 1,
      gameDate: start.toISOString().slice(0, 10),
      startTimeUTC: start.toISOString(),
      gameType: 2,
      gameState: 'FUT',
      homeTeam: { abbrev: teamAbbreviation },
      awayTeam: { abbrev: 'OPP' },
    };
  });
}

async function withMockedNhlSchedules(callback) {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const abbreviations = new Map(
    NHL_DRAFT_CLUBS.map((abbreviation, index) => [abbreviation.toLowerCase(), {
      abbreviation,
      index,
    }]),
  );

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const match = url.match(/\/club-schedule-season\/([a-z0-9]+)\/\d{8}$/);

    if (!match) {
      return originalFetch(input, init);
    }

    const team = abbreviations.get(match[1]);
    assert.ok(team, `Unexpected NHL schedule team in ${url}.`);

    return new Response(JSON.stringify({
      games: buildSeasonGames(team.abbreviation, team.index),
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  globalThis.setTimeout = (handler, delay, ...args) =>
    originalSetTimeout(handler, delay === 3_000 ? 0 : delay, ...args);

  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
}

before(async () => {
  app = initializeApp({ projectId }, `ff1-42-legacy-${randomUUID()}`);
  db = getFirestore(app);
  await reset();
});
beforeEach(reset);
after(async () => { if (app) await deleteApp(app); });

test('scheduled task and minute-worker gates require current explicit finalization', async () => {
  const source = await readFile(new URL(
    '../../functions/src/draft-automation.ts',
    import.meta.url,
  ), 'utf8');
  const schedulerStart = source.indexOf(
    'async function scheduleDraftMembershipFinalizationTask(',
  );
  const schedulerEnd = source.indexOf(
    'async function scheduleScheduledDraftStartTask(',
    schedulerStart,
  );
  const workerStart = source.indexOf(
    'async function processLeagueDraftAutomation(',
  );
  const workerEnd = source.indexOf(
    'async function getAutomatedDraftLeagueIds(',
    workerStart,
  );
  const scheduler = source.slice(schedulerStart, schedulerEnd);
  const worker = source.slice(workerStart, workerEnd);

  assert.ok(schedulerStart >= 0 && schedulerEnd > schedulerStart);
  assert.ok(workerStart >= 0 && workerEnd > workerStart);
  assert.match(
    scheduler,
    /isDraftMembershipFinalizedForSchedule\(draft, scheduleGeneration\)/,
  );
  assert.match(
    worker,
    /!isDraftMembershipFinalizedForSchedule\([\s\S]*?draft\.scheduleGeneration \?\? 0/,
  );
  assert.equal(isDraftMembershipFinalizedForSchedule({
    status: 'scheduled',
    roundOneOrder: ['owner-a', 'owner-b'],
  }, 0), false);
  assert.equal(isDraftMembershipFinalizedForSchedule({
    status: 'scheduled',
    membershipLockStatus: 'locked',
    finalizedScheduleGeneration: 0,
    roundOneOrder: ['owner-a', 'owner-b'],
  }, 0), true);
  assert.equal(isDraftMembershipFinalizedForSchedule({
    status: 'scheduled',
    scheduleGeneration: 1,
    membershipLockStatus: 'locked',
    finalizedScheduleGeneration: 0,
    roundOneOrder: ['owner-a', 'owner-b'],
  }, 1), false);
});

test('a pre-FF1.40 scheduled Draft upgrades at T-40 without rerolling and becomes start-eligible', async () => {
  const leagueId = `legacy-${randomUUID()}`;
  const inviteCode = `L${randomUUID().replaceAll('-', '').slice(0, 5).toUpperCase()}`;
  const owners = ['owner-a', 'owner-b', 'owner-c'];
  const legacyOrder = ['owner-c', 'owner-a', 'owner-b'];
  const scheduledStartMilliseconds = Date.UTC(2026, 8, 30, 18, 0);
  const cutoffMilliseconds =
    scheduledStartMilliseconds - DRAFT_MEMBERSHIP_LOCK_LEAD_MILLISECONDS;
  const draftRef = db.doc(`leagues/${leagueId}/draft/current`);
  const batch = db.batch();

  batch.set(db.doc(`leagues/${leagueId}`), {
    id: leagueId,
    commissionerId: owners[0],
    inviteCode,
    maxTeams: 6,
    teamCount: owners.length,
    joinStatus: 'locked',
  });
  batch.set(db.doc(`leagueInvites/${inviteCode}`), {
    leagueId,
    inviteCode,
    active: false,
    joinCount: owners.length,
    expiresAt: Timestamp.fromMillis(scheduledStartMilliseconds + 24 * 60 * 60 * 1000),
  });
  owners.forEach((ownerId, index) => {
    batch.set(db.doc(`leagues/${leagueId}/members/${ownerId}`), {
      uid: ownerId,
      leagueId,
      role: index === 0 ? 'commissioner' : 'member',
    });
    batch.set(db.doc(`leagues/${leagueId}/teams/${ownerId}`), {
      id: ownerId,
      ownerId,
    });
  });
  batch.set(draftRef, {
    schemaVersion: 3,
    status: 'scheduled',
    format: 'snake',
    totalRounds: 17,
    rosterRequirements: { LW: 3, C: 3, RW: 3, D: 4, G: 1 },
    benchSlots: 3,
    roundOneOrder: legacyOrder,
    orderMode: 'randomized',
    orderParticipantHash: 'f'.repeat(64),
    nextOverallPick: 1,
    draftedAssetKeys: [],
    scheduledStartAt: Timestamp.fromMillis(scheduledStartMilliseconds),
    pickSeconds: 60,
    clockStatus: 'stopped',
    currentPickSeconds: 60,
    pausedRemainingSeconds: null,
  });
  await batch.commit();

  const legacyDraft = (await draftRef.get()).data();
  assert.equal(isDraftMembershipFinalizedForSchedule(legacyDraft, 0), false);

  assert.equal(await finalizeScheduledDraftMembership(
    leagueId,
    scheduledStartMilliseconds,
    0,
    cutoffMilliseconds - 1,
    'must-not-finalize-before-t40',
  ), 'early');
  assert.equal((await draftRef.get()).data().membershipLockStatus, undefined);

  assert.equal(await finalizeScheduledDraftMembership(
    leagueId,
    scheduledStartMilliseconds,
    1,
    cutoffMilliseconds,
    'stale-generation-must-not-write',
  ), 'stale');
  assert.equal((await draftRef.get()).data().finalizedScheduleGeneration, undefined);

  const finalized = await withMockedNhlSchedules(() =>
    finalizeScheduledDraftMembership(
      leagueId,
      scheduledStartMilliseconds,
      0,
      cutoffMilliseconds,
      'legacy-order-preservation-seed',
    ));
  assert.equal(finalized, 'finalized');

  const readyDraft = (await draftRef.get()).data();
  assert.equal(readyDraft.membershipLockStatus, 'locked');
  assert.equal(readyDraft.scheduleGeneration, 0);
  assert.equal(readyDraft.finalizedScheduleGeneration, 0);
  assert.equal(readyDraft.seasonWindowAnchorStatus, 'ready');
  assert.equal(readyDraft.seasonWindowAnchorScheduleGeneration, 0);
  assert.deepEqual(readyDraft.roundOneOrder, legacyOrder);
  assert.equal(readyDraft.orderParticipantHash, createDraftParticipantHash(owners));
  assert.equal(isDraftMembershipFinalizedForSchedule(readyDraft, 0), true);
  assert.equal(draftFinalizationMatchesParticipants(readyDraft, owners), true);

  assert.equal(await finalizeScheduledDraftMembership(
    leagueId,
    scheduledStartMilliseconds,
    0,
    scheduledStartMilliseconds,
    'duplicate-must-not-reroll',
  ), 'already-finalized');
  assert.deepEqual((await draftRef.get()).data().roundOneOrder, legacyOrder);

  await draftRef.set({
    status: 'setup',
    scheduledStartAt: null,
    scheduleGeneration: 1,
    membershipLockStatus: 'open',
    finalizedScheduleGeneration: null,
  }, { merge: true });

  assert.equal(await finalizeScheduledDraftMembership(
    leagueId,
    scheduledStartMilliseconds,
    0,
    scheduledStartMilliseconds,
    'canceled-task-must-not-write',
  ), 'stale');
  const canceledDraft = (await draftRef.get()).data();
  assert.equal(canceledDraft.status, 'setup');
  assert.equal(canceledDraft.scheduleGeneration, 1);
  assert.equal(canceledDraft.membershipLockStatus, 'open');
  assert.deepEqual(canceledDraft.roundOneOrder, legacyOrder);
});

test('a mismatched legacy locked order fails closed instead of adding or rerolling teams', async () => {
  const leagueId = `legacy-mismatch-${randomUUID()}`;
  const inviteCode = `M${randomUUID().replaceAll('-', '').slice(0, 5).toUpperCase()}`;
  const owners = ['owner-a', 'owner-b', 'owner-c'];
  const incompleteOrder = ['owner-a', 'owner-b'];
  const scheduledStartMilliseconds = Date.UTC(2026, 8, 30, 18, 0);
  const cutoffMilliseconds =
    scheduledStartMilliseconds - DRAFT_MEMBERSHIP_LOCK_LEAD_MILLISECONDS;
  const draftRef = db.doc(`leagues/${leagueId}/draft/current`);
  const batch = db.batch();

  batch.set(db.doc(`leagues/${leagueId}`), {
    id: leagueId,
    commissionerId: owners[0],
    inviteCode,
    maxTeams: 6,
    teamCount: owners.length,
    joinStatus: 'locked',
  });
  batch.set(db.doc(`leagueInvites/${inviteCode}`), {
    leagueId,
    inviteCode,
    active: false,
    joinCount: owners.length,
  });
  owners.forEach((ownerId, index) => {
    batch.set(db.doc(`leagues/${leagueId}/members/${ownerId}`), {
      uid: ownerId,
      leagueId,
      role: index === 0 ? 'commissioner' : 'member',
    });
    batch.set(db.doc(`leagues/${leagueId}/teams/${ownerId}`), {
      id: ownerId,
      ownerId,
    });
  });
  batch.set(draftRef, {
    schemaVersion: 3,
    status: 'scheduled',
    format: 'snake',
    totalRounds: 17,
    rosterRequirements: { LW: 3, C: 3, RW: 3, D: 4, G: 1 },
    benchSlots: 3,
    roundOneOrder: incompleteOrder,
    orderMode: 'randomized',
    nextOverallPick: 1,
    draftedAssetKeys: [],
    scheduledStartAt: Timestamp.fromMillis(scheduledStartMilliseconds),
    pickSeconds: 60,
    clockStatus: 'stopped',
    currentPickSeconds: 60,
    pausedRemainingSeconds: null,
  });
  await batch.commit();

  await assert.rejects(
    finalizeScheduledDraftMembership(
      leagueId,
      scheduledStartMilliseconds,
      0,
      cutoffMilliseconds,
      'must-not-reconcile-a-locked-order',
    ),
    /locked Draft order does not match the current teams/,
  );

  const unchangedDraft = (await draftRef.get()).data();
  assert.deepEqual(unchangedDraft.roundOneOrder, incompleteOrder);
  assert.equal(unchangedDraft.membershipLockStatus, undefined);
  assert.equal(unchangedDraft.finalizedScheduleGeneration, undefined);
  assert.equal((await db.doc(
    `leagues/${leagueId}/audit/draft-membership-finalized-g0`,
  ).get()).exists, false);
});
