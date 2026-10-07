import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  resolveActiveBenchSwapTimingPreview,
} from '../../src/app/core/transactions/active-bench-swap-timing.util.ts';
import {
  buildActiveBenchSwapTimingMessage,
} from '../../src/app/features/team/team-settings/active-bench-swap-timing.util.ts';
import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

async function sha256(relativePath) {
  const contents = await readFile(new URL(relativePath, ROOT));
  return createHash('sha256').update(contents).digest('hex');
}

function timingInput(overrides = {}) {
  return {
    activeCycleNumber: 3,
    activeFinalGames: 0,
    activeLiveGames: 0,
    activeScheduledGames: 6,
    activeWindowStatus: 'scheduled',
    activeAssignmentUntouched: true,
    immediateCycleNumber: 3,
    openFromCycleNumber: null,
    benchCurrentCycleNumber: 3,
    benchFinalGames: 0,
    benchLiveGames: 0,
    benchScheduledGames: 6,
    benchCurrentCycleHasStarted: false,
    benchEarliestCycleNumber: 3,
    ...overrides,
  };
}

test('an untouched active slot and bench block report an immediate exact matchup', () => {
  const preview = resolveActiveBenchSwapTimingPreview(timingInput());
  const message = buildActiveBenchSwapTimingMessage(preview, 'Active Player', 'Bench Player');

  assert.equal(preview.mode, 'immediate');
  assert.equal(preview.effectiveCycleNumber, 3);
  assert.equal(preview.delaySource, 'none');
  assert.match(message.headline, /happen now in Matchup 3/);
  assert.match(message.detail, /Neither Active Player's active assignment nor Bench Player's/);
});

test('the bench player is named when its NHL block is farther ahead', () => {
  const preview = resolveActiveBenchSwapTimingPreview(timingInput({
    activeAssignmentUntouched: false,
    activeWindowStatus: 'active',
    activeFinalGames: 2,
    benchCurrentCycleNumber: 4,
    benchFinalGames: 1,
    benchCurrentCycleHasStarted: true,
    benchEarliestCycleNumber: 5,
  }));
  const message = buildActiveBenchSwapTimingMessage(preview, 'Active Player', 'Bench Player');

  assert.equal(preview.delaySource, 'bench-player');
  assert.equal(preview.effectiveCycleNumber, 5);
  assert.match(message.headline, /Bench Player is the reason.*Matchup 5/);
  assert.match(message.detail, /further along/);
  assert.match(message.detail, /Matchup 4/);
  assert.match(message.detail, /1\/6 NHL team games final/);
});

test('the active player is named when its protected slot window is farther ahead', () => {
  const preview = resolveActiveBenchSwapTimingPreview(timingInput({
    activeCycleNumber: 4,
    activeAssignmentUntouched: false,
    immediateCycleNumber: 4,
    activeWindowStatus: 'active',
    activeFinalGames: 4,
    activeLiveGames: 1,
    benchCurrentCycleNumber: 3,
    benchEarliestCycleNumber: 3,
  }));
  const message = buildActiveBenchSwapTimingMessage(preview, 'Active Player', 'Bench Player');

  assert.equal(preview.delaySource, 'active-player');
  assert.equal(preview.effectiveCycleNumber, 5);
  assert.match(message.headline, /Active Player is the reason.*Matchup 5/);
  assert.match(message.detail, /active roster spot is further along/);
  assert.match(message.detail, /4\/6 NHL team games final, with 1 game live/);
});

test('two started blocks and a completed roster boundary are explained separately', () => {
  const bothPreview = resolveActiveBenchSwapTimingPreview(timingInput({
    activeAssignmentUntouched: false,
    activeWindowStatus: 'active',
    activeFinalGames: 2,
    benchFinalGames: 3,
    benchCurrentCycleHasStarted: true,
    benchEarliestCycleNumber: 4,
  }));
  const boundaryPreview = resolveActiveBenchSwapTimingPreview(timingInput({
    activeAssignmentUntouched: false,
    activeWindowStatus: 'complete',
    activeFinalGames: 6,
  }));

  assert.equal(bothPreview.delaySource, 'both-players');
  assert.match(
    buildActiveBenchSwapTimingMessage(bothPreview, 'Active Player', 'Bench Player').headline,
    /Both players hold this swap until Matchup 4/,
  );
  assert.equal(boundaryPreview.delaySource, 'roster-boundary');
  assert.match(
    buildActiveBenchSwapTimingMessage(boundaryPreview, 'Active Player', 'Bench Player').detail,
    /player is no longer holding the move/,
  );
});

test('the confirmation sheet loads, retries, and requires selection-specific timing evidence', async () => {
  const [component, template, previewService] = await Promise.all([
    read('src/app/features/team/team-settings/team-settings.ts'),
    read('src/app/features/team/team-settings/team-settings.html'),
    read('src/app/core/transactions/active-bench-swap-timing.service.ts'),
  ]);

  assert.match(component, /void this\.refreshBenchSwapTimingPreview\(\)/);
  assert.match(component, /previewActiveBenchSwapTiming\(\{/);
  assert.match(component, /generation === this\.benchSwapTimingGeneration/);
  assert.match(component, /this\.benchSwapTimingPreview\(\)/);
  assert.match(template, /Checking both players/);
  assert.match(template, /Retry timing check/);
  assert.match(template, /timingMessage\.matchupLabel/);
  assert.match(template, /The server checks both roster spots again when you confirm/);
  assert.match(previewService, /loadLatestActiveSlotWindow/);
  assert.match(previewService, /resolveRosterMoveAssetCycleEligibility/);
  assert.match(previewService, /activeSlot\.asset && !currentWindow/);
});

test('roster authority, scoring, Projection V11, Rules, and indexes remain unchanged', async () => {
  assert.equal(
    await sha256('src/app/core/scoring/scoring-engine.ts'),
    '6f36cf76c72f8199c6a3891692844c9c830103ed618be50497b5270e259da3d3',
  );
  assert.equal(
    await sha256('src/app/core/projection/projection-v11.util.ts'),
    'c22cce759a6e59b6f549d33c0442d1380a102443120b8620c0eea693b598bed9',
  );
  assert.equal(
    await sha256('functions/src/roster-authority.ts'),
    '109610878ec1f2ad2809142400721ec41bae9508b74faa84199cd3b515188288',
  );
  assert.equal(
    await sha256('firestore.rules'),
    PROTECTED_SOURCE_HASHES.firestoreRules,
  );
  assert.equal(
    await sha256('firestore.indexes.json'),
    '8e2798abd1f659d752e6fad8910ac249025e140c7ec6d03e3d336d2c814d096a',
  );
});
