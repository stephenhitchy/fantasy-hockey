import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  isImmediateInjuryMoveStatus,
} from '../../src/app/core/player/player-injury-move-eligibility.util.ts';
import {
  resolveFreeAgentTransactionTiming,
} from '../../src/app/features/free-agents/free-agent-transaction-comparison.util.ts';
import {
  resolveObservedFreeAgentRosterMove,
} from '../../src/app/features/free-agents/free-agent-operation-resolution.util.ts';
import {
  isImmediateActiveBenchSwapObserved,
} from '../../src/app/features/team/team-settings/roster-mobile-management.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function timingInput(overrides = {}) {
  return {
    incomingName: 'New Player',
    outgoingName: 'Injured Starter',
    rosterArea: 'active',
    isWaiver: false,
    seasonHasStarted: true,
    canApplyImmediately: false,
    canApplyInjuryImmediately: true,
    injuryReplacementCycleNumber: 4,
    effectiveCycleNumber: 5,
    slotNextCycleNumber: 5,
    outgoingCycleNumber: 4,
    outgoingWindowStatus: 'active',
    outgoingFinalGames: 3,
    outgoingLiveGames: 0,
    outgoingScheduledGames: 6,
    incomingCurrentCycleNumber: 4,
    incomingFinalGames: 2,
    incomingLiveGames: 0,
    incomingScheduledGames: 6,
    incomingHasStarted: true,
    incomingEarliestCycleNumber: 5,
    ...overrides,
  };
}

test('only known injury designations select the immediate mixed-window route', () => {
  for (const status of [
    'day-to-day',
    'out',
    'injured-reserve',
    'long-term-injured-reserve',
  ]) {
    assert.equal(isImmediateInjuryMoveStatus(status), true, status);
  }

  for (const status of ['active', 'suspended', 'personal-leave', 'unknown', null, undefined]) {
    assert.equal(isImmediateInjuryMoveStatus(status), false, String(status));
  }
});

test('injury add/drop timing preserves prior results and assigns only remaining future games', () => {
  const decision = resolveFreeAgentTransactionTiming(timingInput());

  assert.equal(decision.tone, 'ready');
  assert.equal(decision.delaySource, 'none');
  assert.equal(decision.startLabel, 'Applies now · Matchup 4');
  assert.match(decision.headline, /Injury replacement applies now/);
  assert.match(decision.detail, /keeps every already-started game and earned point/);
  assert.match(decision.detail, /only this slot’s remaining future games/);
  assert.match(decision.detail, /rechecks the injury report/);
});

test('a waiver claim never bypasses waiver timing because the outgoing player is injured', () => {
  const decision = resolveFreeAgentTransactionTiming(timingInput({ isWaiver: true }));

  assert.equal(decision.tone, 'conditional');
  assert.notEqual(decision.startLabel, 'Applies now · Matchup 4');
  assert.match(decision.headline, /If the claim is awarded/);
});

test('healthy active players stay queued while bench ownership still changes now', () => {
  const healthyActive = resolveFreeAgentTransactionTiming(timingInput({
    canApplyInjuryImmediately: false,
  }));
  const bench = resolveFreeAgentTransactionTiming(timingInput({
    rosterArea: 'bench',
    canApplyInjuryImmediately: false,
  }));

  assert.equal(healthyActive.tone, 'waiting');
  assert.equal(healthyActive.delaySource, 'both-players');
  assert.match(healthyActive.headline, /Both players are holding the move/);
  assert.match(bench.headline, /Bench changes now/);
  assert.match(bench.detail, /owned immediately/);
});

test('injury intent cannot mistake a queued pending asset for an immediate commit', () => {
  const expectation = {
    kind: 'roster-slot',
    rosterArea: 'active',
    slotId: 'C-1',
    incomingAssetKey: 'skater-new',
    requiredMode: 'immediate',
  };
  const queuedObservation = {
    activeSlots: [{
      slotId: 'C-1',
      assetKey: 'skater-old',
      pendingIncomingAssetKey: 'skater-new',
      pendingEffectiveCycleNumber: 5,
    }],
    benchSlots: [],
    waivers: [],
  };
  const committedObservation = {
    ...queuedObservation,
    activeSlots: [{
      slotId: 'C-1',
      assetKey: 'skater-new',
      pendingIncomingAssetKey: null,
      assetEligibleFromCycleNumber: 4,
    }],
  };

  assert.equal(resolveObservedFreeAgentRosterMove(expectation, queuedObservation), null);
  assert.deepEqual(
    resolveObservedFreeAgentRosterMove(expectation, committedObservation),
    { mode: 'immediate', effectiveCycleNumber: 4 },
  );
});

test('an immediate injury bench swap requires the exact two-slot post-swap state', () => {
  const expectation = {
    activeSlotId: 'C-1',
    benchSlotId: 'B-1',
    incomingAssetKey: 'skater-incoming',
    outgoingAssetKey: 'skater-injured',
  };
  const completedObservation = {
    activeSlots: [
      { slotId: 'C-1', assetKey: 'skater-incoming', hasPendingMove: false },
      { slotId: 'C-2', assetKey: 'skater-unrelated', hasPendingMove: true },
    ],
    benchSlots: [
      { slotId: 'B-1', assetKey: 'skater-injured' },
    ],
  };

  assert.equal(
    isImmediateActiveBenchSwapObserved(expectation, completedObservation),
    true,
  );

  const incompleteObservations = [
    {
      ...completedObservation,
      activeSlots: [
        { slotId: 'C-1', assetKey: 'skater-injured', hasPendingMove: false },
        { slotId: 'C-2', assetKey: 'skater-changed', hasPendingMove: false },
      ],
      benchSlots: [{ slotId: 'B-1', assetKey: 'skater-incoming' }],
    },
    {
      ...completedObservation,
      benchSlots: [{ slotId: 'B-1', assetKey: 'skater-someone-else' }],
    },
    {
      ...completedObservation,
      activeSlots: [{
        slotId: 'C-1',
        assetKey: 'skater-incoming',
        hasPendingMove: true,
      }],
    },
  ];

  for (const observation of incompleteObservations) {
    assert.equal(
      isImmediateActiveBenchSwapObserved(expectation, observation),
      false,
    );
  }
});

test('client routes injury add/drop and injury bench swap through explicit server move types', async () => {
  const [transport, draftService, freeAgents, teamSettings, teamTemplate] = await Promise.all([
    read('src/app/core/transactions/immediate-roster-move.service.ts'),
    read('src/app/core/draft/draft.service.ts'),
    read('src/app/features/free-agents/free-agents.ts'),
    read('src/app/features/team/team-settings/team-settings.ts'),
    read('src/app/features/team/team-settings/team-settings.html'),
  ]);

  assert.match(transport, /\| 'injury-add-drop-active'/);
  assert.match(transport, /\| 'injury-active-bench-swap'/);
  assert.match(
    transport,
    /request\.moveType === 'injury-add-drop-active'[\s\S]*?executeIdempotentRosterActionWithQuickRetry/,
  );
  assert.match(
    draftService,
    /preferImmediateInjuryReplacement[\s\S]*?'injury-add-drop-active'[\s\S]*?expectedOutgoingAssetKey/,
  );
  assert.match(
    draftService,
    /replaceInjuredRosterAsset[\s\S]*?moveType: 'injury-active-bench-swap'/,
  );
  assert.match(
    freeAgents,
    /preferImmediateInjuryReplacement: immediateInjuryReplacement/,
  );
  assert.match(freeAgents, /Every already-started game and earned point stays/);
  assert.match(freeAgents, /only the slot’s remaining future games/);
  assert.match(teamSettings, /isImmediateInjuryMoveStatus\(availability\?\.status\)/);
  assert.match(teamSettings, /The starter moved to the bench/);
  assert.match(
    teamSettings,
    /const injurySwapExpectation:[\s\S]*?await this\.awaitRosterMutationConfirmation\([\s\S]*?isImmediateActiveBenchSwapObserved\([\s\S]*?this\.getActiveBenchSwapRosterObservation\(\)/,
  );
  assert.match(
    teamSettings,
    /const confirmationObserved = isExpectedMutationObserved \?\? \(\(\) =>/,
  );
  assert.match(teamSettings, /case 'injury-active-bench-swap'/);
  assert.match(teamSettings, /case 'injury-add-drop-active'/);
  assert.match(teamSettings, /moved to the bench and kept every already-started game/);
  assert.match(teamSettings, /was placed on waivers and keeps every already-started game/);
  assert.doesNotMatch(
    teamSettings,
    /private isActiveSlotEligibleForImmediateInjuryReplacement[\s\S]{0,400}getOpenIrSlotCount/,
  );
  assert.match(teamTemplate, /Day-to-Day, Out, Injured Reserve, or Long-Term Injured Reserve/);
  assert.match(teamTemplate, /moves to Bench/);
});

test('bench ownership and open active slots stay immediate while occupied healthy active stays queued', async () => {
  const [freeAgents, authority] = await Promise.all([
    read('src/app/features/free-agents/free-agents.ts'),
    read('functions/src/roster-authority.ts'),
  ]);
  const draftService = await read('src/app/core/draft/draft.service.ts');

  assert.match(
    freeAgents,
    /dropCandidate\.rosterArea === 'bench'[\s\S]*?\('ownership-only' as const\)/,
  );
  assert.match(
    freeAgents,
    /asset === null[\s\S]*?currentWindowUntouched[\s\S]*?effectiveCycleNumber === slotNextCycleNumber/,
  );
  assert.doesNotMatch(
    freeAgents,
    /addDropRosterAsset\(\{[\s\S]*?preferImmediateCurrentCycle:/,
  );
  const queueActiveBenchSwapSource = draftService.slice(
    draftService.indexOf('export async function queueActiveBenchSwap'),
    draftService.indexOf('export async function replaceInjuredRosterAsset'),
  );
  assert.match(
    queueActiveBenchSwapSource,
    /if \(!activeSlot\.asset\)[\s\S]*?moveType: 'active-bench-swap'/,
  );
  assert.match(
    queueActiveBenchSwapSource,
    /executeSecureRosterAction\(\{[\s\S]*?action: 'queue-active-bench-swap'/,
  );
  assert.doesNotMatch(
    queueActiveBenchSwapSource,
    /if \(activeSlot\.asset\)[\s\S]*?moveType: 'active-bench-swap'/,
  );
  assert.match(
    authority,
    /const benchIndex = roster\.benchSlots\.findIndex[\s\S]*?mode:[^\n]*|actionResult\([\s\S]*?'ownership-only'/,
  );
});
