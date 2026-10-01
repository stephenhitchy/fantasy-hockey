import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  isClientProjectionGenerationReason,
  projectionGenerationRequiresCommissioner,
} from '../../functions/src/shared/core/projection/projection-generation-access.util.ts';
import {
  buildRosterManagementActions,
} from '../../src/app/features/team/team-settings/roster-mobile-management.util.ts';
import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

async function sha256(relativePath) {
  const contents = await readFile(new URL(relativePath, ROOT));
  return createHash('sha256').update(contents).digest('hex');
}

function activeRosterContext(overrides = {}) {
  return {
    area: 'active',
    hasAsset: true,
    assetIsSkater: true,
    hasPendingMove: false,
    busy: false,
    showMoveToIr: false,
    canMoveToIr: false,
    moveToIrDisabledReason: null,
    canStartFromBench: false,
    startDisabledReason: null,
    canActivateFromIr: false,
    activateDisabledReason: null,
    canMoveIrToBench: false,
    moveIrToBenchDisabledReason: null,
    ...overrides,
  };
}

test('league members may request one bounded player-directory projection without gaining commissioner rebuild access', () => {
  assert.equal(isClientProjectionGenerationReason('player-directory'), true);
  assert.equal(projectionGenerationRequiresCommissioner('player-directory'), false);
  assert.equal(projectionGenerationRequiresCommissioner('manual'), true);
  assert.equal(projectionGenerationRequiresCommissioner('cycle-refresh'), true);
  assert.equal(isClientProjectionGenerationReason('server-emergency'), false);
  assert.equal(isClientProjectionGenerationReason('unknown-reason'), false);
});

test('Add Drop loads current or draft-pinned evidence before automatically generating the directory', async () => {
  const [source, template, authority, browserSnapshot, serverSnapshot] = await Promise.all([
    read('src/app/features/free-agents/free-agents.ts'),
    read('src/app/features/free-agents/free-agents.html'),
    read('functions/src/projection-authority.ts'),
    read('src/app/core/projection/projection-snapshot.service.ts'),
    read('functions/src/shared/core/projection/projection-snapshot.service.ts'),
  ]);

  const currentRead = source.indexOf('loadSharedProjectionSnapshot(this.leagueId)');
  const pinnedRead = source.indexOf('serverDraftProjectionSnapshotId');
  const generation = source.indexOf("generationReason: 'player-directory'");

  assert.ok(currentRead >= 0);
  assert.ok(pinnedRead > currentRead);
  assert.ok(generation > pinnedRead);
  assert.match(source, /loadSharedProjectionSnapshotById\([\s\S]*pinnedSnapshotId/);
  assert.doesNotMatch(source, /commissioner must refresh them in Projection Lab/);
  assert.match(template, /Preparing players automatically/);
  assert.match(template, /You do not need[\s\S]*commissioner or Projection Lab/);
  assert.match(authority, /projectionGenerationRequiresCommissioner\(generationReason\)/);
  assert.match(browserSnapshot, /\| 'player-directory'/);
  assert.match(serverSnapshot, /\| 'player-directory'/);
});

test('active roster management always exposes the bench-swap path before availability is known', async () => {
  const actions = buildRosterManagementActions(activeRosterContext());
  const swap = actions.find((action) => action.id === 'swap-with-bench');

  assert.ok(swap);
  assert.equal(swap.enabled, true);
  assert.match(swap.detail, /If none are eligible, the next screen will explain/i);

  const busySwap = buildRosterManagementActions(activeRosterContext({ busy: true }))
    .find((action) => action.id === 'swap-with-bench');
  assert.equal(busySwap?.enabled, false);

  const scheduled = buildRosterManagementActions(
    activeRosterContext({ hasPendingMove: true }),
  );
  assert.equal(scheduled.some((action) => action.id === 'swap-with-bench'), false);
});

test('the active-first swap sheet shows compatible bench choices or a truthful empty state', async () => {
  const [source, template, styles] = await Promise.all([
    read('src/app/features/team/team-settings/team-settings.ts'),
    read('src/app/features/team/team-settings/team-settings.html'),
    read('src/rinkrat-mobile-roster-v1.css'),
  ]);

  assert.match(source, /beginActiveBenchSwapPicker/);
  assert.match(source, /slot\.asset\?\.position === activeSlot\.position/);
  assert.match(source, /!this\.isBenchSlotReservedForActiveSwap\(slot\)/);
  assert.match(source, /this\.beginBenchSwap\(candidate\.slotId, activeSlot\.slotId\)/);
  assert.match(source, /benchSwapRestrictedTargetSlotId/);
  assert.match(template, /title="Swap with Bench"/);
  assert.match(template, /No matching bench player is available/);
  assert.match(template, /The active player[\s\S]*has not been changed/);
  assert.match(styles, /\.active-bench-picker-option\s*\{/);
  assert.match(styles, /grid-template-columns:\s*3\.5rem minmax\(0, 1fr\) auto/);
});

test('lineup confirmation keeps the theme-independent high-visibility commit palette', async () => {
  const [template, teamStyles, primitives, visualSystem] = await Promise.all([
    read('src/app/features/team/team-settings/team-settings.html'),
    read('src/app/features/team/team-settings/team-settings.css'),
    read('src/rinkrat-shared-primitives.css'),
    read('src/rinkrat-visual-system.css'),
  ]);

  assert.match(template, /confirmBenchSwap\(\$event\)[\s\S]*data-commit-ready/);
  assert.match(
    teamStyles,
    /\.ir-activation-confirm:not\(\.rr-button--commit\):not\(\.rr-button--danger\)/,
  );
  assert.match(primitives, /\.rr-button--commit\s*\{[\s\S]*var\(--rr-commit-face-top\)/);
  assert.match(visualSystem, /button\[class\*='submit'\][\s\S]*:not\(\.rr-button--commit\)/);
  const protectedRuleStart = teamStyles.indexOf(
    '.ir-activation-confirm:not(.rr-button--commit):not(.rr-button--danger)',
  );
  const protectedRuleEnd = teamStyles.indexOf('}', protectedRuleStart);
  assert.ok(protectedRuleStart >= 0 && protectedRuleEnd > protectedRuleStart);
  assert.doesNotMatch(teamStyles.slice(protectedRuleStart, protectedRuleEnd), /!important/);
});

test('competitive formulas, roster authority, Rules, and indexes remain unchanged', async () => {
  assert.equal(
    await sha256('src/app/core/scoring/scoring-engine.ts'),
    '6f36cf76c72f8199c6a3891692844c9c830103ed618be50497b5270e259da3d3',
  );
  assert.equal(
    await sha256('src/app/core/projection/projection-v11.util.ts'),
    'c22cce759a6e59b6f549d33c0442d1380a102443120b8620c0eea693b598bed9',
  );
  assert.equal(
    await sha256('src/app/core/projection/projection-ranking.util.ts'),
    'cd03dc6f81fde413b70b78e0df427c0a858318bdbcc15bc424b6042c783205ad',
  );
  assert.equal(
    await sha256('functions/src/roster-authority.ts'),
    'a3df8b53f02aca18aa5cde91c597d77cad1e89cb26d987b8025df6f65178db76',
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
