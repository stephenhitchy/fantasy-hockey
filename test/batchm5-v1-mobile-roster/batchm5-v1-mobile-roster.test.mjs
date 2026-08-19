import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';

import {
  buildFreeAgentRosterTargetQuery,
  buildRosterManagementActions,
} from '../../src/app/features/team/team-settings/roster-mobile-management.util.ts';
import {
  parseFreeAgentMobileViewState,
  resolveFreeAgentRoutePreferences,
  resolvePreferredRosterCandidate,
} from '../../src/app/features/free-agents/free-agent-mobile-flow.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

async function sha256(relativePath) {
  const contents = await readFile(new URL(relativePath, ROOT));
  return createHash('sha256').update(contents).digest('hex');
}

async function listFiles(relativeDirectory) {
  const rootPath = fileURLToPath(new URL(relativeDirectory, ROOT));
  const result = [];

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === 'lib' || entry.name === 'node_modules') {
          continue;
        }
        await walk(fullPath);
      } else if (entry.isFile()) {
        result.push(path.relative(rootPath, fullPath).replaceAll(path.sep, '/'));
      }
    }
  }

  await walk(rootPath);
  return result;
}

async function directoryFingerprint(relativeDirectory, excludedFiles = new Set()) {
  const files = (await listFiles(relativeDirectory)).filter((file) => !excludedFiles.has(file));
  const digest = createHash('sha256');

  for (const file of files) {
    const fileContents = await readFile(new URL(`${relativeDirectory}${file}`, ROOT));
    digest.update(file);
    digest.update('\0');
    digest.update(createHash('sha256').update(fileContents).digest('hex'));
    digest.update('\n');
  }

  return digest.digest('hex');
}

function rosterContext(overrides = {}) {
  return {
    area: 'active',
    hasAsset: true,
    assetIsSkater: true,
    hasPendingMove: false,
    busy: false,
    showMoveToIr: true,
    canMoveToIr: true,
    moveToIrDisabledReason: null,
    canStartFromBench: true,
    startDisabledReason: null,
    canActivateFromIr: true,
    activateDisabledReason: null,
    canMoveIrToBench: true,
    moveIrToBenchDisabledReason: null,
    ...overrides,
  };
}

test('open roster spots lead directly to a preselected Available Players task', () => {
  const activeActions = buildRosterManagementActions(
    rosterContext({ area: 'active', hasAsset: false }),
  );
  const benchActions = buildRosterManagementActions(
    rosterContext({ area: 'bench', hasAsset: false }),
  );
  const irActions = buildRosterManagementActions(
    rosterContext({ area: 'ir', hasAsset: false }),
  );

  assert.deepEqual(activeActions.map((action) => action.id), ['find-player']);
  assert.match(activeActions[0].detail, /exact roster slot|position and roster slot/i);
  assert.deepEqual(benchActions.map((action) => action.id), ['find-player']);
  assert.match(benchActions[0].detail, /bench spot/i);
  assert.deepEqual(irActions, []);
});

test('active roster management explains fair timing and protects a scheduled move', () => {
  const actions = buildRosterManagementActions(
    rosterContext({ hasPendingMove: true, canMoveToIr: false }),
  );

  assert.deepEqual(actions.map((action) => action.id), ['view', 'review-scheduled']);
  assert.equal(actions.find((action) => action.id === 'review-scheduled').enabled, true);
});

test('bench and Injured Reserve actions expose only relevant roster consequences', () => {
  const bench = buildRosterManagementActions(rosterContext({ area: 'bench' }));
  const ir = buildRosterManagementActions(rosterContext({ area: 'ir' }));

  assert.deepEqual(
    bench.map((action) => action.id),
    ['view', 'start', 'find-player', 'move-to-ir', 'drop'],
  );
  assert.match(bench.find((action) => action.id === 'start').detail, /scheduled safely/i);
  assert.deepEqual(
    ir.map((action) => action.id),
    ['view', 'activate', 'move-to-bench', 'drop'],
  );
  assert.match(ir.find((action) => action.id === 'activate').detail, /counted games/i);

  const reservedBench = buildRosterManagementActions(
    rosterContext({ area: 'bench', hasPendingMove: true }),
  );
  assert.deepEqual(
    reservedBench.map((action) => action.id),
    ['view', 'review-scheduled'],
  );

  const healthyActive = buildRosterManagementActions(
    rosterContext({ area: 'active', showMoveToIr: false, canMoveToIr: false }),
  );
  assert.equal(healthyActive.some((action) => action.id === 'move-to-ir'), false);
});

test('My Team produces safe roster-target query parameters for Available Players', () => {
  assert.deepEqual(buildFreeAgentRosterTargetQuery('active', 'RW', 'RW-2'), {
    position: 'RW',
    targetSlot: 'RW-2',
    rosterArea: 'active',
  });
  assert.deepEqual(buildFreeAgentRosterTargetQuery('bench', null, 'BENCH-1'), {
    position: 'ALL',
    targetSlot: 'BENCH-1',
    rosterArea: 'bench',
  });
  assert.equal(buildFreeAgentRosterTargetQuery('active', null, 'LW-1'), null);
  assert.equal(buildFreeAgentRosterTargetQuery('ir', 'LW', 'IR-1'), null);
});

test('Available Players restores a valid recent mobile task and rejects stale or malformed state', () => {
  const now = 2_000_000;
  const valid = {
    version: 1,
    savedAt: now - 1_000,
    searchTerm: 'Cutter',
    positionFilter: 'LW',
    sortMode: 'NEXT_CYCLE',
    poolTab: 'available',
    flowStep: 'roster-slot',
    selectedAddAssetKey: 'skater-8483445',
    selectedWaiverId: '',
    selectedDropSlotId: 'LW-1',
    preferredSlotId: 'LW-1',
    preferredRosterArea: 'active',
    playerPoolScrollY: 840,
  };

  assert.deepEqual(parseFreeAgentMobileViewState(JSON.stringify(valid), now), valid);
  assert.equal(
    parseFreeAgentMobileViewState(
      JSON.stringify({ ...valid, savedAt: now - 2 * 60 * 60 * 1000 - 1 }),
      now,
    ),
    null,
  );
  assert.equal(
    parseFreeAgentMobileViewState(JSON.stringify({ ...valid, poolTab: 'trades' }), now),
    null,
  );
  assert.equal(
    parseFreeAgentMobileViewState(
      JSON.stringify({ ...valid, savedAt: now + 5 * 60 * 1000 + 1 }),
      now,
    ),
    null,
  );
  assert.equal(
    parseFreeAgentMobileViewState(JSON.stringify({ ...valid, playerPoolScrollY: -1 }), now),
    null,
  );
  assert.equal(parseFreeAgentMobileViewState('{not-json', now), null);
});

test('preferred roster selection resolves only the exact compatible slot and area', () => {
  const candidates = [
    { slotId: 'LW-1', rosterArea: 'active', value: 1 },
    { slotId: 'BENCH-1', rosterArea: 'bench', value: 2 },
  ];

  assert.equal(resolvePreferredRosterCandidate(candidates, 'LW-1', 'active')?.value, 1);
  assert.equal(resolvePreferredRosterCandidate(candidates, 'LW-1', 'bench'), null);
  assert.equal(resolvePreferredRosterCandidate(candidates, '', ''), null);
});

test('route preferences validate filters and require a roster area for target handoff', () => {
  assert.deepEqual(
    resolveFreeAgentRoutePreferences({
      position: 'D',
      targetSlot: 'D-3',
      rosterArea: 'active',
      tab: 'available',
      focus: 'pending-moves',
    }),
    {
      position: 'D',
      targetSlot: 'D-3',
      rosterArea: 'active',
      poolTab: 'available',
      focusPendingMoves: true,
    },
  );

  const invalid = resolveFreeAgentRoutePreferences({
    position: 'COACH',
    targetSlot: 'D-3',
    rosterArea: 'unknown',
    tab: 'trades',
  });
  assert.equal(invalid.position, null);
  assert.equal(invalid.targetSlot, '');
  assert.equal(invalid.rosterArea, '');
  assert.equal(invalid.poolTab, null);
});

test('My Team uses explicit mobile Manage actions without nested clickable roster cards', async () => {
  const [template, source, styles] = await Promise.all([
    read('src/app/features/team/team-settings/team-settings.html'),
    read('src/app/features/team/team-settings/team-settings.ts'),
    read('src/rinkrat-mobile-roster-v1.css'),
  ]);

  assert.match(template, /class="roster-manage-button/);
  assert.match(template, /openRosterManager\('active'/);
  assert.match(template, /openRosterManager\('bench'/);
  assert.match(template, /openRosterManager\('ir'/);
  assert.match(template, /<app-action-sheet/);
  assert.match(template, /Six-game count/);
  assert.match(template, /Find Player/);
  assert.doesNotMatch(template, /class="fantasy-player-card[^>]*role="button"/s);
  assert.doesNotMatch(template, /class="fantasy-player-card[^>]*\(click\)=/s);

  assert.match(source, /buildRosterManagementActions/);
  assert.match(source, /buildFreeAgentRosterTargetQuery/);
  assert.match(source, /openFreeAgentsForRosterSlot/);
  assert.match(styles, /app-team-settings \.roster-manage-button/);
  assert.match(styles, /grid-template-columns:\s*1fr/);
});

test('Add / Drop uses a focused player-board flow with exact timing and valid roster choices', async () => {
  const [template, source, styles] = await Promise.all([
    read('src/app/features/free-agents/free-agents.html'),
    read('src/app/features/free-agents/free-agents.ts'),
    read('src/app/features/free-agents/free-agents.css'),
  ]);

  for (const required of [
    'Add / Drop',
    'Free agents',
    'All players',
    'Rostered',
    'Waivers',
    'Next 6 projection',
    'Select a player to drop or an open slot',
    'Selected move',
    'pending-roster-moves',
  ]) {
    assert.match(template, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(template, /getBoardActionLabel\(row\)/);
  assert.match(source, /Review Your Claim/);
  assert.match(source, /Compare & Claim/);
  assert.match(source, /sessionStorage\.setItem/);
  assert.match(source, /storedValue = sessionStorage\.getItem/);
  assert.match(source, /focusPendingMovesRequested/);
  assert.match(source, /restorePlayerPoolScroll/);
  assert.match(source, /getConfirmationTimingTitle/);
  assert.match(source, /!this\.isBenchCandidateReservedForActiveSwap\(slot\)/);
  assert.match(source, /A direct handoff from My Team represents a new roster task/);
  assert.match(template, /id="pending-roster-moves"[\s\S]*tabindex="-1"/);
  assert.match(styles, /@media \(max-width: 560px\)/);
  assert.match(styles, /min-height:\s*var\(--rr-mobile-control-min-height\)/);
  assert.doesNotMatch(template, /role="dialog"|appViewportOverlayPortal|View six-game status & full stats/i);
});

test('shared action sheet is an accessible desktop dialog and mobile bottom sheet', async () => {
  const [source, template, styles, viewportPortal] = await Promise.all([
    read('src/app/shared/action-sheet/action-sheet.ts'),
    read('src/app/shared/action-sheet/action-sheet.html'),
    read('src/app/shared/action-sheet/action-sheet.css'),
    read('src/app/shared/accessibility/viewport-overlay-portal.directive.ts'),
  ]);

  assert.match(source, /DialogFocusTrapDirective/);
  assert.match(source, /ViewportOverlayPortalDirective/);
  assert.match(source, /if \(this\.busy\)/);
  assert.match(viewportPortal, /document\.body\.appendChild\(this\.host\)/);
  assert.match(viewportPortal, /body\.style\.overflow = 'hidden'/);
  assert.match(viewportPortal, /releaseViewportLock/);
  assert.match(viewportPortal, /window\.scrollTo\(scrollX, scrollY\)/);
  assert.match(template, /role="dialog"/);
  assert.match(template, /aria-modal="true"/);
  assert.match(template, /appViewportOverlayPortal/);
  assert.match(template, /appDialogFocusTrap/);
  assert.match(template, /\(dialogEscape\)="requestClose\(\)"/);
  assert.match(template, /ng-content select="\[action-sheet-actions\]"/);
  assert.match(styles, /@media \(max-width: 680px\)/);
  assert.match(styles, /align-items:\s*end/);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
  assert.match(styles, /prefers-reduced-motion/);
});

test('roster writes block route changes and browser exit until the server operation finishes', async () => {
  const [routes, guard, teamSource, freeAgentSource, teamTemplate, freeAgentTemplate] =
    await Promise.all([
      read('src/app/app.routes.ts'),
      read('src/app/core/guards/pending-roster-action.guard.ts'),
      read('src/app/features/team/team-settings/team-settings.ts'),
      read('src/app/features/free-agents/free-agents.ts'),
      read('src/app/features/team/team-settings/team-settings.html'),
      read('src/app/features/free-agents/free-agents.html'),
    ]);

  assert.equal((routes.match(/canDeactivate:\s*\[pendingRosterActionGuard\]/g) ?? []).length, 2);
  assert.match(guard, /component\.canLeaveRosterPage\(\)/);
  assert.match(teamSource, /@HostListener\('window:beforeunload'/);
  assert.match(freeAgentSource, /@HostListener\('window:beforeunload'/);
  assert.match(teamSource, /return this\.rosterMoveLoading\(\) \|\| this\.saving\(\)/);
  assert.match(freeAgentSource, /return this\.moving\(\)/);
  assert.match(teamTemplate, /Waiting for the secure response or live roster update/);
  assert.match(freeAgentTemplate, /Waiting for the secure response or live roster update/);
});

test('V1 keeps the readable interface font prioritized and loads decorative fonts without inline handlers', async () => {
  const [index, angular, styles] = await Promise.all([
    read('src/index.html'),
    read('angular.json'),
    read('src/rinkrat-mobile-roster-v1.css'),
  ]);

  assert.match(index, /Barlow\+Condensed[^>]+rel="stylesheet"[^>]+fetchpriority="high"/s);
  assert.match(index, /Pixelify\+Sans[^>]+rel="stylesheet"/s);
  assert.doesNotMatch(index, /onload=/);
  assert.match(index, /<noscript>/);

  const config = JSON.parse(angular);
  const globalStyles = config.projects['fantasy-hockey'].architect.build.options.styles;
  assert.equal(globalStyles.at(-1), 'src/rinkrat-shared-primitives.css');
  assert.equal(globalStyles.at(-2), 'src/rinkrat-transaction-workbench.css');
  assert.equal(globalStyles.at(-3), 'src/rinkrat-mobile-roster-v1.css');
  assert.match(styles, /box-shadow:\s*none/);
  assert.match(styles, /border-width:\s*1px/);
  assert.doesNotMatch(styles, /#[0-9a-fA-F]{3,8}/);
  assert.match(styles, /prefers-reduced-motion:[\s\S]*animation:\s*none/);
});

test('M5-V1 foundations still preserve scoring, Projection V11, Firestore rules, and indexes', async () => {
  assert.equal(
    await sha256('src/app/core/scoring/scoring-rules.ts'),
    '74107aa688b4a3825c52fe14003cd824485197fd3559822fab4134bff940e2da',
  );
  assert.equal(
    await sha256('src/app/core/scoring/scoring-engine.ts'),
    '6f36cf76c72f8199c6a3891692844c9c830103ed618be50497b5270e259da3d3',
  );
  assert.equal(
    await sha256('src/app/core/projection/projection-v11.util.ts'),
    'e6f3111b1feccc7107e857aa24c5317451c65a84a36c71f8158947636f20d80a',
  );
  assert.equal(
    await sha256('src/app/core/draft/draft-player-pool.service.ts'),
    'ab6ee7c4ea5e92966b80f928897b3c2b01b1fcc8bafe7738e67a2651cd048300',
  );
  assert.equal(
    await sha256('firestore.rules'),
    PROTECTED_SOURCE_HASHES.firestoreRules,
  );
  assert.equal(
    await sha256('firestore.indexes.json'),
    '62f09a69e4e487eb9bfa1935e874d32a07e8fa0cddba48205903d62e19261a13',
  );
});

test('all M5-V1 files are present and non-empty', async () => {
  for (const file of [
    'src/app/shared/action-sheet/action-sheet.ts',
    'src/app/shared/action-sheet/action-sheet.html',
    'src/app/shared/action-sheet/action-sheet.css',
    'src/app/core/guards/pending-roster-action.guard.ts',
    'src/app/features/team/team-settings/roster-mobile-management.util.ts',
    'src/app/features/free-agents/free-agent-mobile-flow.util.ts',
    'src/rinkrat-mobile-roster-v1.css',
  ]) {
    assert.ok((await read(file)).trim().length > 0, `${file} should not be empty`);
  }
});
