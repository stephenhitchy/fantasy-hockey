import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../../', import.meta.url);

const {
  findAutomaticQueuedInjuryReplacementCandidates,
  getAutomaticInjuryReplacementCandidateKey,
  resolveAutomaticInjuryReplacementBackstopCursor,
  selectFairAutomaticInjuryReplacementCandidates,
  selectBoundedAutomaticInjuryReplacementCandidates,
} = await import(
  '../../functions/lib/automatic-injury-replacement.js'
);
const {
  createAutomaticInjuryReplacementReceiptIdentity,
  getReachedAutomaticInjuryReplacementOwnershipBoundaryGameIds,
  resolveAutomaticInjuryAvailabilityStatus,
} = await import('../../functions/lib/roster-moves.js');
const {
  buildRosterActionSubmissionEvidence,
  resolveRosterActionSubmission,
} = await import(
  '../../functions/lib/shared/core/team/roster-action-idempotency.util.js'
);
const {
  hasPreservedInjuryReplacementProtectedGameOwnership,
} = await import(
  '../../functions/lib/shared/core/cycle/injury-replacement-window.util.js'
);

function skater(id, position, availabilityStatus = 'active') {
  return {
    assetKey: `skater-${id}`,
    assetType: 'skater',
    position,
    availabilityStatus,
    player: {
      id,
      fullName: `Player ${id}`,
      position,
      nhlTeamAbbreviation: id === 1 ? 'FLA' : 'CAR',
    },
    rosterStatus: 'active',
    cycleScore: {
      cycleNumber: 1,
      gamesCounted: 0,
      fantasyPoints: 0,
    },
  };
}

function exactRoster() {
  const outgoing = skater(1, 'C', 'long-term-injured-reserve');
  const incoming = {
    ...skater(2, 'C'),
    rosterStatus: 'benched',
  };

  return {
    schemaVersion: 1,
    activeSlots: [{
      slotId: 'C-3',
      position: 'C',
      slotNumber: 3,
      asset: outgoing,
      pendingMove: {
        id: 'owner-a__C-3__queued',
        moveType: 'add-drop',
        incomingAsset: incoming,
        outgoingAssetKey: outgoing.assetKey,
        sourceWaiverId: null,
        queuedByOwnerId: 'owner-a',
        queuedAt: '2026-10-08T12:00:00.000Z',
        requestedEffectiveCycleNumber: 2,
        requestedEffectiveLabel: 'Cycle 2',
        sourceBenchSlotId: 'B-1',
        outgoingDestination: 'bench',
      },
    }],
    benchSlots: [{ slotId: 'B-1', slotNumber: 1, asset: incoming }],
    irSlots: [{ slotId: 'IR-1', slotNumber: 1, asset: null }],
  };
}

function candidates(rosterData, eligiblePlayerIds = new Set([1])) {
  return findAutomaticQueuedInjuryReplacementCandidates({
    leagueId: 'league-a',
    ownerId: 'owner-a',
    rosterData,
    eligiblePlayerIds,
  });
}

test('selects the exact already-authorized same-slot Barkov-to-Aho shape', () => {
  const [candidate] = candidates(exactRoster());

  assert.deepEqual({
    ...candidate,
    pendingMoveFingerprint: '<fingerprint>',
  }, {
    leagueId: 'league-a',
    ownerId: 'owner-a',
    activeSlotId: 'C-3',
    moveType: 'injury-active-bench-swap',
    benchSlotId: 'B-1',
    incomingAssetKey: 'skater-2',
    pendingMoveId: 'owner-a__C-3__queued',
    pendingMoveFingerprint: '<fingerprint>',
    outgoingPlayerId: 1,
  });
  assert.match(candidate.pendingMoveFingerprint, /^[a-f0-9]{64}$/);
});

test('requires the outgoing player to be in the caller-provided eligible set', () => {
  assert.deepEqual(candidates(exactRoster(), new Set()), []);
  assert.deepEqual(candidates(exactRoster(), new Set([2])), []);
});

test('fails closed for non-exact, waiver-backed, and ambiguous bench reservations', () => {
  const mutations = [
    (roster) => { roster.activeSlots[0].pendingMove.moveType = 'waiver-award'; },
    (roster) => { roster.activeSlots[0].pendingMove.queuedByOwnerId = 'owner-b'; },
    (roster) => { roster.activeSlots[0].pendingMove.outgoingAssetKey = 'skater-99'; },
    (roster) => { roster.activeSlots[0].pendingMove.sourceWaiverId = 'waiver-1'; },
    (roster) => { roster.activeSlots[0].pendingMove.outgoingDestination = 'waivers'; },
    (roster) => { roster.activeSlots[0].pendingMove.sourceBenchSlotId = 'B-2'; },
    (roster) => { roster.activeSlots[0].pendingMove.incomingAsset = skater(3, 'C'); },
    (roster) => { roster.benchSlots[0].asset = skater(3, 'C'); },
    (roster) => { roster.benchSlots[0].asset = skater(2, 'RW'); },
    (roster) => {
      roster.activeSlots.push({
        slotId: 'C-4',
        position: 'C',
        slotNumber: 4,
        asset: skater(5, 'C'),
        pendingMove: {
          ...roster.activeSlots[0].pendingMove,
          id: 'duplicate-reservation',
          outgoingAssetKey: 'skater-5',
          queuedByOwnerId: 'owner-a',
        },
      });
    },
    (roster) => {
      roster.activeSlots.push({
        slotId: 'C-4',
        position: 'C',
        slotNumber: 4,
        asset: skater(5, 'C'),
        pendingMove: {
          ...roster.activeSlots[0].pendingMove,
          id: 'conflicting-bench-reservation',
          incomingAsset: skater(7, 'C'),
          outgoingAssetKey: 'skater-5',
          queuedByOwnerId: 'owner-a',
        },
      });
    },
  ];

  for (const mutate of mutations) {
    const roster = structuredClone(exactRoster());
    mutate(roster);
    assert.deepEqual(candidates(roster), []);
  }
});

test('a destination-preserving injury bench swap does not require an open IR slot', () => {
  const roster = exactRoster();
  roster.irSlots = [
    { slotId: 'IR-1', slotNumber: 1, asset: skater(4, 'C') },
    { slotId: 'IR-2', slotNumber: 2, asset: skater(5, 'C') },
    { slotId: 'IR-3', slotNumber: 3, asset: skater(6, 'C') },
  ];

  const [candidate] = candidates(roster);

  assert.equal(candidate.moveType, 'injury-active-bench-swap');
  assert.equal(candidate.benchSlotId, 'B-1');
});

test('requires explicit no-waiver evidence rather than accepting a missing field', () => {
  const roster = exactRoster();
  delete roster.activeSlots[0].pendingMove.sourceWaiverId;

  assert.deepEqual(candidates(roster), []);
});

test('uses the roster normalizer contract for legacy documents without saved IR slots', () => {
  const roster = exactRoster();
  delete roster.irSlots;

  assert.equal(candidates(roster).length, 1);
});

test('unattended execution requires fresh complete availability authority', () => {
  const now = Date.parse('2026-10-09T12:00:00.000Z');
  const injured = skater(1, 'C', 'long-term-injured-reserve');
  const trustedGlobal = {
    source: 'ESPN',
    status: 'success',
    draftReadinessSourceComplete: true,
    lastSuccessfulSyncAt: new Date(now - 60_000),
    records: [{ playerId: 1, status: 'out' }],
  };

  assert.equal(
    resolveAutomaticInjuryAvailabilityStatus(
      injured,
      undefined,
      trustedGlobal,
      now,
      'league-a',
    ),
    'out',
  );
  assert.equal(
    resolveAutomaticInjuryAvailabilityStatus(
      injured,
      {
        source: 'commissioner',
        leagueId: 'league-a',
        playerId: 1,
        status: 'injured-reserve',
      },
      undefined,
      now,
      'league-a',
    ),
    'injured-reserve',
  );

  const rejectedGlobalReports = [
    undefined,
    { ...trustedGlobal, status: 'error' },
    { ...trustedGlobal, draftReadinessSourceComplete: false },
    { ...trustedGlobal, lastSuccessfulSyncAt: new Date(now - 13 * 60 * 60 * 1000) },
    { ...trustedGlobal, records: [] },
  ];

  for (const report of rejectedGlobalReports) {
    assert.equal(
      resolveAutomaticInjuryAvailabilityStatus(
        injured,
        undefined,
        report,
        now,
        'league-a',
      ),
      '',
    );
  }

  const rejectedLeagueOverrides = [
    { source: 'espn', leagueId: 'league-a', playerId: 1, status: 'out' },
    { source: 'commissioner', leagueId: 'league-b', playerId: 1, status: 'out' },
    { source: 'commissioner', leagueId: 'league-a', playerId: 2, status: 'out' },
  ];

  for (const override of rejectedLeagueOverrides) {
    assert.equal(
      resolveAutomaticInjuryAvailabilityStatus(
        injured,
        override,
        undefined,
        now,
        'league-a',
      ),
      '',
    );
  }
});

test('receipt replay is source-independent and conflicts if the saved move fingerprint changes', () => {
  const input = {
    leagueId: 'league-a',
    ownerId: 'owner-a',
    activeSlotId: 'C-3',
    benchSlotId: 'B-1',
    pendingMoveId: 'owner-a__C-3__queued',
    pendingMoveFingerprint: 'a'.repeat(64),
  };
  const first = createAutomaticInjuryReplacementReceiptIdentity(input);
  const same = createAutomaticInjuryReplacementReceiptIdentity(input);
  const changed = createAutomaticInjuryReplacementReceiptIdentity({
    ...input,
    pendingMoveFingerprint: 'b'.repeat(64),
  });

  assert.deepEqual(first, same);
  assert.equal(first.submissionId, changed.submissionId);
  assert.equal(first.transactionId, changed.transactionId);
  assert.notEqual(first.requestFingerprint, changed.requestFingerprint);

  const saved = buildRosterActionSubmissionEvidence({
    submissionId: first.submissionId,
    requestFingerprint: first.requestFingerprint,
    result: {
      applied: true,
      cycleNumber: 1,
      activeSlotId: 'C-3',
      message: 'Applied once.',
    },
  });
  assert.equal(
    resolveRosterActionSubmission(
      saved,
      same.submissionId,
      same.requestFingerprint,
    ).status,
    'match',
  );
  assert.equal(
    resolveRosterActionSubmission(
      saved,
      changed.submissionId,
      changed.requestFingerprint,
    ).status,
    'conflict',
  );
});

test('a game that becomes live after preflight aborts instead of changing ownership', () => {
  const outgoing = skater(1, 'C', 'out');
  const incoming = skater(2, 'C');
  const preflightPlan = {
    schemaVersion: 1,
    latestTransactionId: 'injury-transaction',
    replacementCount: 1,
    requiredGames: 6,
    segments: [
      {
        segmentId: 'injury-transaction__original',
        reason: 'original',
        assetKey: outgoing.assetKey,
        asset: outgoing,
        scheduledGameIds: [101],
        sourceTeamAbbreviation: 'FLA',
        sourceTeamAbbreviationByGameId: { 101: 'FLA' },
      },
      {
        segmentId: 'injury-transaction__replacement-1',
        reason: 'injury-replacement',
        assetKey: incoming.assetKey,
        asset: incoming,
        scheduledGameIds: [201, 202, 203, 204, 205],
        sourceTeamAbbreviation: 'CAR',
        sourceTeamAbbreviationByGameId: {
          201: 'CAR',
          202: 'CAR',
          203: 'CAR',
          204: 'CAR',
          205: 'CAR',
        },
      },
    ],
  };
  const previousOwnership = {
    previousPlan: null,
    nextPlan: preflightPlan,
    previousAssetKey: outgoing.assetKey,
    previousScheduleTeamAbbreviation: 'FLA',
    previousSourceTeamAbbreviationByGameId: {
      101: 'FLA',
      102: 'FLA',
    },
  };

  assert.equal(
    hasPreservedInjuryReplacementProtectedGameOwnership({
      ...previousOwnership,
      protectedGameIds: [101],
    }),
    true,
  );
  assert.equal(
    hasPreservedInjuryReplacementProtectedGameOwnership({
      ...previousOwnership,
      protectedGameIds: [101, 102],
    }),
    false,
  );
});

test('unattended execution closes the wall-clock puck-drop race before scoring writes live evidence', () => {
  const startMillisecondsByGameId = {
    102: Date.parse('2026-10-09T19:00:00.000Z'),
    201: Date.parse('2026-10-09T19:05:00.000Z'),
  };

  assert.deepEqual(
    getReachedAutomaticInjuryReplacementOwnershipBoundaryGameIds({
      startMillisecondsByGameId,
      observedAtMilliseconds: Date.parse('2026-10-09T18:59:59.999Z'),
    }),
    [],
  );
  assert.deepEqual(
    getReachedAutomaticInjuryReplacementOwnershipBoundaryGameIds({
      startMillisecondsByGameId,
      observedAtMilliseconds: Date.parse('2026-10-09T19:05:00.000Z'),
    }),
    [102, 201],
  );
});

test('healthy structural swaps cannot starve eligible work or later league pages', () => {
  const [eligibleCandidate] = candidates(exactRoster());
  const structuralCandidates = Array.from(
    { length: 150 },
    (_, index) => ({
      ...eligibleCandidate,
      ownerId: `healthy-owner-${index}`,
      outgoingPlayerId: index + 100,
    }),
  );
  structuralCandidates.push(eligibleCandidate);

  // Availability filtering happens before this bounded selector. Only the
  // final exact Out/IR/LTIR candidate reaches the per-run cap.
  const eligibleCandidates = structuralCandidates.filter(
    (candidate) => candidate.outgoingPlayerId === 1,
  );
  const selection = selectBoundedAutomaticInjuryReplacementCandidates(
    eligibleCandidates,
    100,
  );

  assert.deepEqual(selection.selected, [eligibleCandidate]);
  assert.equal(selection.truncated, false);
  assert.equal(
    resolveAutomaticInjuryReplacementBackstopCursor({
      selectedLeagueIds: ['league-a', 'league-b', 'league-c', 'league-d'],
      pageReachedEnd: false,
    }),
    'league-d',
  );
  assert.equal(
    resolveAutomaticInjuryReplacementBackstopCursor({
      selectedLeagueIds: ['league-e'],
      pageReachedEnd: true,
    }),
    null,
  );

  const firstFairPass = selectFairAutomaticInjuryReplacementCandidates({
    candidates: structuralCandidates,
    maximumCount: 100,
  });
  const secondFairPass = selectFairAutomaticInjuryReplacementCandidates({
    candidates: structuralCandidates,
    maximumCount: 100,
    afterCandidateKey: firstFairPass.nextCandidateKey,
  });
  const firstKeys = new Set(
    firstFairPass.selected.map(getAutomaticInjuryReplacementCandidateKey),
  );

  assert.equal(firstFairPass.truncated, true);
  assert.equal(secondFairPass.truncated, true);
  assert.ok(
    secondFairPass.selected.some(
      (candidate) =>
        !firstKeys.has(getAutomaticInjuryReplacementCandidateKey(candidate)),
    ),
  );
});

test('source contracts keep automation bounded, retryable, and independent of scoring/email', async () => {
  const [automation, index, rosterMoves, teamSource, teamTemplate] = await Promise.all([
    readFile(new URL(
      'functions/src/automatic-injury-replacement.ts',
      ROOT,
    ), 'utf8'),
    readFile(new URL('functions/src/index.ts', ROOT), 'utf8'),
    readFile(new URL('functions/src/roster-moves.ts', ROOT), 'utf8'),
    readFile(new URL(
      'src/app/features/team/team-settings/team-settings.ts',
      ROOT,
    ), 'utf8'),
    readFile(new URL(
      'src/app/features/team/team-settings/team-settings.html',
      ROOT,
    ), 'utf8'),
  ]);

  assert.match(
    automation,
    /const ELIGIBLE_INJURY_STATUSES = new Set\(\[\s*'day-to-day',\s*'out',\s*'injured-reserve',\s*'long-term-injured-reserve',\s*\]\)/,
  );
  assert.doesNotMatch(
    automation.slice(
      automation.indexOf('const ELIGIBLE_INJURY_STATUSES'),
      automation.indexOf('// Each trigger'),
    ),
    /suspended|personal-leave/,
  );
  assert.match(automation, /document: 'appData\/playerAvailability'/);
  assert.match(
    automation,
    /asString\(afterData\?\.\['status'\]\) !== 'success'/,
  );
  assert.match(automation, /getTrustedGlobalAvailabilityStatuses\(afterData\)/);
  assert.match(automation, /record\['draftReadinessSourceComplete'\] !== true/);
  assert.match(
    automation,
    /AUTOMATIC_INJURY_AVAILABILITY_MAX_AGE_MILLISECONDS/,
  );
  assert.doesNotMatch(automation, /candidate\.outgoingAvailabilityStatus/);
  assert.match(
    automation,
    /document: 'leagues\/\{leagueId\}\/playerAvailability\/\{playerId\}'/,
  );
  assert.match(automation, /schedule: 'every 10 minutes'/);
  assert.match(
    automation,
    /export const reconcileAutomaticInjuryReplacements = onSchedule\([\s\S]*?maxInstances: 1/,
  );
  assert.match(automation, /BACKSTOP_LEAGUE_PAGE_SIZE/);
  assert.match(automation, /backstopLeagueCursorId/);
  assert.match(
    automation,
    /const pageReachedEnd = leaguePage\.size <= BACKSTOP_LEAGUE_PAGE_SIZE/,
  );
  assert.doesNotMatch(automation, /pageReachedEnd = wrapped/);
  assert.doesNotMatch(automation, /collectionGroup\(/);
  assert.match(automation, /automaticInjuryReplacementAutomation/);
  assert.match(automation, /sources\/\$\{source\}/);
  assert.match(automation, /scopes\/\$\{scopeId\}/);
  assert.match(automation, /Promise\.allSettled/);
  assert.match(automation, /expectedPendingMoveId: candidate\.pendingMoveId/);
  assert.match(
    automation,
    /expectedPendingMoveFingerprint: candidate\.pendingMoveFingerprint/,
  );
  assert.match(automation, /applyAutomaticQueuedInjuryReplacement/);
  const availabilityFilterIndex = automation.indexOf(
    'filterCandidatesByEffectiveAvailability(\n        structuralCandidates',
  );
  const candidateBoundIndex = automation.indexOf(
    'selectFairAutomaticInjuryReplacementCandidates({\n          candidates: effectiveCandidates',
  );
  assert.ok(availabilityFilterIndex >= 0);
  assert.ok(candidateBoundIndex > availabilityFilterIndex);
  assert.doesNotMatch(automation, /email-notifications|league-automation|scoring/i);
  assert.match(index, /processGlobalAutomaticInjuryReplacements/);
  assert.match(index, /processLeagueAutomaticInjuryReplacement/);
  assert.match(index, /reconcileAutomaticInjuryReplacements/);
  assert.match(
    rosterMoves,
    /expectedPendingMoveFingerprint:[\s\S]*requestFingerprint/,
  );
  assert.match(
    rosterMoves,
    /observedPendingMoveFingerprint !==[\s\S]*expectedAutomaticPendingMoveFingerprint/,
  );
  assert.match(
    rosterMoves,
    /transactionCycleData\['status'\]\) !== 'active'/,
  );
  assert.match(
    rosterMoves,
    /assertInjuryReplacementPlanPreservesTransactionProtectedGames\(\{[\s\S]*?window: savedWindow,[\s\S]*?nextPlan: preflightInjuryPlan/,
  );
  assert.match(
    rosterMoves,
    /assertInjuryReplacementPlanPreservesTransactionProtectedGames\(\{[\s\S]*?window: savedBankWindow,[\s\S]*?nextPlan: preflightInjuryPlan/,
  );
  assert.match(
    rosterMoves,
    /automaticInjuryReplacement \|\|[\s\S]*?requiresFreshInjuryAvailabilityAuthority\(moveType\)[\s\S]*?getReachedAutomaticInjuryReplacementOwnershipBoundaryGameIds\(\{[\s\S]*?observedAtMilliseconds: Date\.now\(\)/,
  );
  assert.match(
    rosterMoves,
    /resolveAutomaticInjuryAvailabilityStatus\(/,
  );
  assert.match(
    teamSource,
    /protected immediate-injury route while every started game and point stays preserved/i,
  );
  assert.match(
    teamSource,
    /Day-to-Day,[\s\S]*?Out,[\s\S]*?Injured Reserve,[\s\S]*?Long-Term Injured Reserve can be[\s\S]*?replaced immediately/i,
  );
  assert.match(teamTemplate, /<p>\{\{ getBenchSwapDialogDescription\(\) \}\}<\/p>/);
});
