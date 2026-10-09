import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildRosterManagementActions,
  isExactQueuedBenchSwapPromotion,
} from '../../src/app/features/team/team-settings/roster-mobile-management.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function activeContext(overrides = {}) {
  return {
    area: 'active',
    hasAsset: true,
    assetIsSkater: true,
    hasPendingMove: false,
    busy: false,
    showMoveToIr: true,
    canMoveToIr: true,
    moveToIrDisabledReason: null,
    canReplaceInjuredPlayerNow: true,
    canStartFromBench: true,
    startDisabledReason: null,
    canActivateFromIr: false,
    activateDisabledReason: null,
    canMoveIrToBench: false,
    moveIrToBenchDisabledReason: null,
    ...overrides,
  };
}

function exactQueuedBenchSwap(overrides = {}) {
  return {
    managerId: 'owner-a',
    activeAssetKey: 'skater-1',
    activePosition: 'C',
    pendingMove: {
      moveType: 'add-drop',
      incomingAssetKey: 'skater-2',
      outgoingAssetKey: 'skater-1',
      sourceWaiverId: null,
      queuedByOwnerId: 'owner-a',
      sourceBenchSlotId: 'B-1',
      outgoingDestination: 'bench',
    },
    benchSlotId: 'B-1',
    benchAssetKey: 'skater-2',
    benchPosition: 'C',
    ...overrides,
  };
}

test('an eligible injured starter leads with an explicit immediate replacement action', () => {
  const actions = buildRosterManagementActions(activeContext());

  assert.deepEqual(
    actions.map((action) => action.id),
    ['view', 'replace-injured-now', 'find-player', 'move-to-ir', 'drop'],
  );
  assert.equal(actions[1].label, 'Replace Injured Player Now');
  assert.match(actions[1].detail, /takes effect immediately/i);

  const irOnly = actions.find((action) => action.id === 'move-to-ir');
  assert.equal(irOnly?.label, 'Move to IR Without a Replacement');
  assert.equal(irOnly?.tone, 'secondary');
  assert.match(irOnly?.detail ?? '', /does not start a bench player now/i);
  assert.match(irOnly?.detail ?? '', /fair matchup boundary/i);
  assert.equal(
    actions.some((action) => action.id === 'swap-with-bench'),
    false,
  );
});

test('the Barkov-to-Aho queued-swap shape keeps the immediate replacement action', () => {
  const promotable = buildRosterManagementActions(activeContext({ hasPendingMove: true }));
  assert.deepEqual(
    promotable.map((action) => action.id),
    ['view', 'replace-injured-now', 'review-scheduled'],
  );

  const unrelated = buildRosterManagementActions(
    activeContext({
      hasPendingMove: true,
      canReplaceInjuredPlayerNow: false,
    }),
  );
  assert.deepEqual(
    unrelated.map((action) => action.id),
    ['view', 'review-scheduled'],
  );
});

test('queued promotion requires the exact manager, slot, assets, and bench origin', () => {
  assert.equal(isExactQueuedBenchSwapPromotion(exactQueuedBenchSwap()), true);

  const invalidOverrides = [
    { managerId: 'owner-b' },
    { activeAssetKey: 'skater-9' },
    { benchSlotId: 'B-2' },
    { benchAssetKey: 'skater-3' },
    { benchPosition: 'RW' },
    { pendingMove: null },
    { pendingMove: { ...exactQueuedBenchSwap().pendingMove, sourceWaiverId: 'waiver-1' } },
    { pendingMove: { ...exactQueuedBenchSwap().pendingMove, sourceBenchSlotId: 'B-2' } },
    { pendingMove: { ...exactQueuedBenchSwap().pendingMove, incomingAssetKey: 'skater-3' } },
    { pendingMove: { ...exactQueuedBenchSwap().pendingMove, outgoingAssetKey: 'skater-9' } },
    { pendingMove: { ...exactQueuedBenchSwap().pendingMove, outgoingDestination: 'waivers' } },
  ];

  for (const override of invalidOverrides) {
    assert.equal(isExactQueuedBenchSwapPromotion(exactQueuedBenchSwap(override)), false);
  }
});

test('the eligible injury path bypasses ordinary timing and dispatches the immediate callable', async () => {
  const [source, template] = await Promise.all([
    read('src/app/features/team/team-settings/team-settings.ts'),
    read('src/app/features/team/team-settings/team-settings.html'),
  ]);
  const refreshStart = source.indexOf('private async refreshBenchSwapTimingPreview');
  const refreshEnd = source.indexOf('  canConfirmBenchSwap(): boolean', refreshStart);
  const refresh = source.slice(refreshStart, refreshEnd);
  const confirmStart = source.indexOf('async confirmBenchSwap');
  const confirmEnd = source.indexOf('  beginIrBenchActivation', confirmStart);
  const confirm = source.slice(confirmStart, confirmEnd);
  const actionStart = source.indexOf('handleRosterManagerAction');
  const actionEnd = source.indexOf('  async openFreeAgentsForRosterSlot', actionStart);
  const action = source.slice(actionStart, actionEnd);

  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart);
  assert.ok(confirmStart >= 0 && confirmEnd > confirmStart);
  assert.ok(actionStart >= 0 && actionEnd > actionStart);
  assert.ok(
    refresh.indexOf('this.isPendingBenchSwapInjuryReplacement()') <
      refresh.indexOf('previewActiveBenchSwapTiming({'),
  );
  assert.match(refresh, /isPendingBenchSwapInjuryReplacement\(\)[\s\S]*return;/);
  assert.match(
    confirm,
    /const request = injuryReplacement[\s\S]*replaceInjuredRosterAsset\([\s\S]*:[\s\S]*queueActiveBenchSwap\(/,
  );
  assert.match(confirm, /if \(!injuryReplacement && !this\.benchSwapTimingPreview\(\)\)/);
  assert.match(action, /case 'replace-injured-now':[\s\S]*beginActiveBenchSwapPicker\(slotId\)/);
  assert.match(template, /isActiveBenchPickerInjuryReplacement\(\)[\s\S]*Replace Injured Player Now/);
  assert.match(template, /remaining future games[\s\S]*games and points already started stay protected/i);
});
