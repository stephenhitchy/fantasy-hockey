import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../../', import.meta.url);

const {
  findAutomaticQueuedInjuryReplacementCandidates,
} = await import('../../functions/lib/automatic-injury-replacement.js');
const {
  createAutomaticInjuryReplacementReceiptIdentity,
  getQueuedFreeAgentInjuryPromotionFingerprint,
  resolveAutomaticInjuryAvailabilityStatus,
} = await import('../../functions/lib/roster-moves.js');
const {
  buildPrivateTransactionProjection,
  buildPublicTransactionResultProjection,
  buildTransactionLeagueActivity,
  isPublicLeagueActivityTransactionType,
} = await import(
  '../../functions/lib/shared/core/league/league-activity.util.js'
);

function skater(id, position = 'C', availabilityStatus = 'active') {
  return {
    assetKey: `skater-${id}`,
    assetType: 'skater',
    position,
    availabilityStatus,
    player: {
      id,
      fullName: `Player ${id}`,
      position,
      nhlTeamAbbreviation: id === 1 ? 'SJS' : 'ANA',
    },
    rosterStatus: 'active',
    cycleScore: {
      cycleNumber: 4,
      gamesCounted: id === 1 ? 4 : 0,
      fantasyPoints: id === 1 ? 52.9 : 0,
    },
  };
}

function queuedBenchSwapRoster() {
  const outgoing = skater(1, 'C', 'day-to-day');
  const incoming = { ...skater(2), rosterStatus: 'benched' };

  return {
    schemaVersion: 1,
    activeSlots: [{
      slotId: 'C-1',
      position: 'C',
      slotNumber: 1,
      asset: outgoing,
      pendingMove: {
        id: 'owner-a__C-1__queued',
        moveType: 'add-drop',
        incomingAsset: incoming,
        outgoingAssetKey: outgoing.assetKey,
        sourceWaiverId: null,
        queuedByOwnerId: 'owner-a',
        queuedAt: '2026-10-09T12:00:00.000Z',
        requestedEffectiveCycleNumber: 5,
        requestedEffectiveLabel: 'Matchup 5',
        sourceBenchSlotId: 'B-1',
        outgoingDestination: 'bench',
      },
    }],
    benchSlots: [{ slotId: 'B-1', slotNumber: 1, asset: incoming }],
    irSlots: [
      { slotId: 'IR-1', slotNumber: 1, asset: skater(10) },
      { slotId: 'IR-2', slotNumber: 2, asset: skater(11) },
      { slotId: 'IR-3', slotNumber: 3, asset: skater(12) },
    ],
  };
}

function queuedFreeAgentRoster() {
  const roster = queuedBenchSwapRoster();
  const pendingMove = roster.activeSlots[0].pendingMove;
  const incoming = skater(3);

  roster.activeSlots[0].pendingMove = {
    ...pendingMove,
    id: 'owner-a__C-1__free-agent',
    incomingAsset: incoming,
    sourceBenchSlotId: null,
    outgoingDestination: 'waivers',
  };

  return roster;
}

function candidates(rosterData) {
  return findAutomaticQueuedInjuryReplacementCandidates({
    leagueId: 'league-a',
    ownerId: 'owner-a',
    rosterData,
    eligiblePlayerIds: new Set([1]),
  });
}

test('the held DTD active-to-bench swap is promotable without an open IR slot', () => {
  const [candidate] = candidates(queuedBenchSwapRoster());

  assert.deepEqual({
    ...candidate,
    pendingMoveFingerprint: '<fingerprint>',
  }, {
    leagueId: 'league-a',
    ownerId: 'owner-a',
    activeSlotId: 'C-1',
    moveType: 'injury-active-bench-swap',
    benchSlotId: 'B-1',
    incomingAssetKey: 'skater-2',
    pendingMoveId: 'owner-a__C-1__queued',
    pendingMoveFingerprint: '<fingerprint>',
    outgoingPlayerId: 1,
  });
  assert.match(candidate.pendingMoveFingerprint, /^[a-f0-9]{64}$/);
});

test('an exact queued free-agent add/drop is promoted with its waiver destination intact', () => {
  const roster = queuedFreeAgentRoster();
  const [candidate] = candidates(roster);
  const fingerprint = getQueuedFreeAgentInjuryPromotionFingerprint({
    pendingMove: roster.activeSlots[0].pendingMove,
    ownerId: 'owner-a',
    activeSlotId: 'C-1',
    outgoingAssetKey: 'skater-1',
    incomingAssetKey: 'skater-3',
  });

  assert.equal(candidate.moveType, 'injury-add-drop-active');
  assert.equal(candidate.benchSlotId, null);
  assert.equal(candidate.incomingAssetKey, 'skater-3');
  assert.equal(candidate.pendingMoveFingerprint, fingerprint);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
});

test('free-agent promotion fails closed when its source, destination, or reservation is ambiguous', () => {
  const mutations = [
    (roster) => { delete roster.activeSlots[0].pendingMove.sourceBenchSlotId; },
    (roster) => { roster.activeSlots[0].pendingMove.sourceWaiverId = 'waiver-1'; },
    (roster) => { roster.activeSlots[0].pendingMove.outgoingDestination = 'bench'; },
    (roster) => { roster.benchSlots[0].asset = skater(3); },
    (roster) => {
      roster.activeSlots.push({
        slotId: 'C-2',
        position: 'C',
        slotNumber: 2,
        asset: skater(4),
        pendingMove: {
          ...roster.activeSlots[0].pendingMove,
          id: 'duplicate-incoming-reservation',
          outgoingAssetKey: 'skater-4',
        },
      });
    },
  ];

  for (const mutate of mutations) {
    const roster = queuedFreeAgentRoster();
    mutate(roster);
    assert.deepEqual(candidates(roster), []);
  }
});

test('automatic status evidence accepts DTD but still rejects unsupported statuses', () => {
  const now = Date.parse('2026-10-09T12:00:00.000Z');
  const outgoing = skater(1, 'C', 'day-to-day');
  const globalEvidence = (status) => ({
    source: 'ESPN',
    status: 'success',
    draftReadinessSourceComplete: true,
    lastSuccessfulSyncAt: new Date(now - 60_000),
    records: [{ playerId: 1, status }],
  });

  assert.equal(
    resolveAutomaticInjuryAvailabilityStatus(
      outgoing,
      undefined,
      globalEvidence('day-to-day'),
      now,
      'league-a',
    ),
    'day-to-day',
  );
  assert.equal(
    resolveAutomaticInjuryAvailabilityStatus(
      outgoing,
      undefined,
      globalEvidence('suspended'),
      now,
      'league-a',
    ),
    'suspended',
  );
  assert.equal(
    resolveAutomaticInjuryAvailabilityStatus(
      outgoing,
      undefined,
      undefined,
      now,
      'league-a',
    ),
    '',
    'a cached roster DTD value is not fresh authority',
  );
  assert.equal(
    resolveAutomaticInjuryAvailabilityStatus(
      outgoing,
      undefined,
      {
        ...globalEvidence('day-to-day'),
        lastSuccessfulSyncAt: new Date(now - 13 * 60 * 60 * 1000),
      },
      now,
      'league-a',
    ),
    '',
    'stale global evidence fails closed',
  );
  assert.equal(
    resolveAutomaticInjuryAvailabilityStatus(
      outgoing,
      {
        source: 'commissioner',
        leagueId: 'league-a',
        playerId: 1,
        status: 'day-to-day',
      },
      undefined,
      now,
      'league-a',
    ),
    'day-to-day',
    'an exact commissioner override remains trusted',
  );
  assert.equal(
    resolveAutomaticInjuryAvailabilityStatus(
      outgoing,
      {
        source: 'commissioner',
        leagueId: 'league-b',
        playerId: 1,
        status: 'day-to-day',
      },
      undefined,
      now,
      'league-a',
    ),
    '',
    'a commissioner override for another league fails closed',
  );
});

test('automatic receipts bind both the exact move type and incoming player', () => {
  const base = {
    leagueId: 'league-a',
    ownerId: 'owner-a',
    activeSlotId: 'C-1',
    benchSlotId: null,
    moveType: 'injury-add-drop-active',
    incomingAssetKey: 'skater-3',
    pendingMoveId: 'owner-a__C-1__free-agent',
    pendingMoveFingerprint: 'a'.repeat(64),
  };
  const first = createAutomaticInjuryReplacementReceiptIdentity(base);
  const changedIncoming = createAutomaticInjuryReplacementReceiptIdentity({
    ...base,
    incomingAssetKey: 'skater-4',
  });
  const changedMoveType = createAutomaticInjuryReplacementReceiptIdentity({
    ...base,
    moveType: 'injury-active-bench-swap',
    benchSlotId: 'B-1',
  });

  assert.equal(first.submissionId, changedIncoming.submissionId);
  assert.equal(first.transactionId, changedIncoming.transactionId);
  assert.notEqual(first.requestFingerprint, changedIncoming.requestFingerprint);
  assert.notEqual(first.requestFingerprint, changedMoveType.requestFingerprint);
});

test('injury outcomes reach private history and public League Wire without leaking injury evidence', () => {
  const outgoing = skater(1, 'C', 'day-to-day');
  const incoming = skater(2);
  const fixtures = [
    {
      type: 'injury-replacement',
      expectedPublicType: 'move-to-ir',
      expectedPublicPrimaryName: 'Player 1',
      expectedPublicSecondaryName: null,
      expectedPublicPrimaryAssetKey: outgoing.assetKey,
      expectedPublicSecondaryAssetKey: null,
      movedAsset: outgoing,
      activatedAsset: incoming,
    },
    {
      type: 'injury-active-bench-swap',
      expectedPublicType: 'active-bench-swap-activated',
      expectedPublicPrimaryName: 'Player 2',
      expectedPublicSecondaryName: 'Player 1',
      expectedPublicPrimaryAssetKey: incoming.assetKey,
      expectedPublicSecondaryAssetKey: outgoing.assetKey,
      movedAsset: outgoing,
      activatedAsset: incoming,
    },
    {
      type: 'injury-add-drop-active',
      expectedPublicType: 'add-drop',
      expectedPublicPrimaryName: 'Player 2',
      expectedPublicSecondaryName: 'Player 1',
      expectedPublicPrimaryAssetKey: incoming.assetKey,
      expectedPublicSecondaryAssetKey: outgoing.assetKey,
      droppedAsset: outgoing,
      addedAsset: incoming,
    },
  ];

  for (const fixture of fixtures) {
    const source = {
      ...fixture,
      ownerId: 'owner-a',
      effectiveCycleNumber: 4,
      effectiveLabel: 'Cycle 4',
      availabilityStatus: 'day-to-day',
      supersededQueuedMoveId: 'private-queued-move',
      automation: {
        pendingMoveFingerprint: 'private-fingerprint',
      },
      injuryReplacementWindow: {
        segments: [{ scheduledGameIds: [1, 2, 3] }],
      },
    };
    const privateProjection = buildPrivateTransactionProjection(source);
    const publicActivity = buildTransactionLeagueActivity(source);
    const publicResult = buildPublicTransactionResultProjection(source);

    assert.equal(privateProjection?.type, fixture.type);
    assert.equal(publicActivity?.eventType, fixture.expectedPublicType);
    assert.equal(
      publicActivity?.primaryAsset?.name,
      fixture.expectedPublicPrimaryName,
    );
    assert.equal(
      publicActivity?.secondaryAsset?.name ?? null,
      fixture.expectedPublicSecondaryName,
    );
    assert.equal(publicResult?.eventType, fixture.expectedPublicType);
    assert.equal(
      publicResult?.primaryAsset.assetKey,
      fixture.expectedPublicPrimaryAssetKey,
    );
    assert.equal(
      publicResult?.secondaryAsset?.assetKey ?? null,
      fixture.expectedPublicSecondaryAssetKey,
    );
    assert.equal(isPublicLeagueActivityTransactionType(fixture.type), true);

    for (const projection of [privateProjection, publicActivity, publicResult]) {
      const serialized = JSON.stringify(projection);
      assert.equal(serialized.includes('private-queued-move'), false);
      assert.equal(serialized.includes('private-fingerprint'), false);
      assert.equal(serialized.includes('injuryReplacementWindow'), false);
      assert.equal(serialized.includes('availabilityStatus'), false);
    }
  }
});

test('the existing transaction trigger owns injury activity and privacy projections', async () => {
  const [publisher, index, health, research] = await Promise.all([
    readFile(new URL('functions/src/league-activity.ts', ROOT), 'utf8'),
    readFile(new URL('functions/src/index.ts', ROOT), 'utf8'),
    readFile(new URL('functions/src/private-season-health.ts', ROOT), 'utf8'),
    readFile(new URL('functions/src/private-season-research.ts', ROOT), 'utf8'),
  ]);

  assert.match(
    publisher,
    /export const publishLeagueTransactionActivity = onDocumentCreated\([\s\S]*?leagues\/\{leagueId\}\/transactions\/\{transactionId\}/,
  );
  assert.match(publisher, /buildTransactionLeagueActivity\(source\)/);
  assert.match(publisher, /buildPrivateTransactionProjection\(source\)/);
  assert.match(publisher, /buildPublicTransactionResultProjection\(source\)/);
  assert.match(index, /publishLeagueTransactionActivity/);

  for (const operationsSource of [health, research]) {
    assert.match(operationsSource, /'injury-replacement'/);
    assert.match(operationsSource, /'injury-active-bench-swap'/);
    assert.match(operationsSource, /'injury-add-drop-active'/);
  }
});

test('server authority keeps legacy IR semantics separate from the new destination-preserving moves', async () => {
  const [rosterMoves, automation] = await Promise.all([
    readFile(new URL('functions/src/roster-moves.ts', ROOT), 'utf8'),
    readFile(
      new URL('functions/src/automatic-injury-replacement.ts', ROOT),
      'utf8',
    ),
  ]);

  assert.match(
    rosterMoves,
    /const IR_ELIGIBLE_STATUSES = new Set\(\[\s*'out',\s*'injured-reserve',\s*'long-term-injured-reserve',\s*\]\)/,
  );
  assert.match(
    rosterMoves,
    /const INJURY_LINEUP_ELIGIBLE_STATUSES = new Set\(\[\s*'day-to-day',\s*\.\.\.IR_ELIGIBLE_STATUSES,\s*\]\)/,
  );
  assert.match(
    rosterMoves,
    /moveType === 'injury-replacement'[\s\S]*?roster\.irSlots\[openIrSlotIndex\]/,
  );
  assert.match(
    rosterMoves,
    /moveType === 'injury-replacement'[\s\S]*?null\s*:\s*\{ \.\.\.outgoingAsset, rosterStatus: 'benched' \}/,
  );
  assert.match(
    rosterMoves,
    /moveType === 'injury-add-drop-active'[\s\S]*?getQueuedFreeAgentInjuryPromotionFingerprint/,
  );
  const occupiedLegacyImmediateGuards = rosterMoves.match(
    /preflightActiveSlot\.asset[\s\S]*?moveType === 'add-drop-active'[\s\S]*?moveType === 'active-bench-swap'[\s\S]*?must be scheduled for the next eligible matchup|activeSlot\.asset[\s\S]*?moveType === 'add-drop-active'[\s\S]*?moveType === 'active-bench-swap'[\s\S]*?must be scheduled for the next eligible matchup/g,
  ) ?? [];
  assert.equal(
    occupiedLegacyImmediateGuards.length,
    2,
    'both preflight and committing transaction must reject legacy immediate changes to occupied active slots',
  );
  assert.match(
    rosterMoves,
    /function requiresFreshInjuryAvailabilityAuthority[\s\S]*?moveType === 'injury-active-bench-swap'[\s\S]*?moveType === 'injury-add-drop-active'/,
  );
  assert.match(
    rosterMoves,
    /automaticInjuryReplacement \|\|[\s\S]*?requiresFreshInjuryAvailabilityAuthority\(moveType\)[\s\S]*?getAutomaticInjuryAvailabilityStatus/,
  );
  assert.match(
    rosterMoves,
    /automaticInjuryReplacement \|\|[\s\S]*?requiresFreshInjuryAvailabilityAuthority\(moveType\)[\s\S]*?resolveAutomaticInjuryAvailabilityStatus/,
  );
  assert.match(
    rosterMoves,
    /automaticInjuryReplacement \|\|[\s\S]*?requiresFreshInjuryAvailabilityAuthority\(moveType\)[\s\S]*?getReachedAutomaticInjuryReplacementOwnershipBoundaryGameIds/,
  );
  assert.match(
    rosterMoves,
    /isMixedPlayerInjuryMove\(moveType\)[\s\S]*?buildInjuryReplacementWindowPlan/,
  );
  assert.match(
    rosterMoves,
    /assertInjuryReplacementPlanPreservesTransactionProtectedGames\(\{[\s\S]*?nextPlan: preflightInjuryPlan/,
  );
  assert.match(
    automation,
    /'day-to-day',[\s\S]*?'injury-active-bench-swap'[\s\S]*?'injury-add-drop-active'/,
  );
  assert.doesNotMatch(
    automation.slice(
      automation.indexOf('const ELIGIBLE_INJURY_STATUSES'),
      automation.indexOf('// Each trigger'),
    ),
    /suspended|personal-leave/,
  );
});
