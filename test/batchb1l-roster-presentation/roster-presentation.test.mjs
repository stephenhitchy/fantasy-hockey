import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  getRosterDisplayMetric,
  getRosterDisplayMetricLabel,
  getRosterDisplayPhase,
  orderRosterEntriesForDisplay,
} from '../../src/app/shared/roster-display-order/roster-display-order.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function asset(assetKey, metrics = {}) {
  return {
    assetType: 'skater',
    assetKey,
    position: 'C',
    player: {
      id: Number(assetKey.replace(/\D/g, '')) || 1,
      fullName: assetKey,
      position: 'C',
      teamAbbreviation: 'SEA',
    },
    ...metrics,
  };
}

function relativeLuminance(hex) {
  const channels = hex
    .replace('#', '')
    .match(/.{2}/g)
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) => (
      channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4
    ));

  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

function contrastRatio(first, second) {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));

  return (lighter + 0.05) / (darker + 0.05);
}

test('roster display phase changes only when current-season evidence exists', () => {
  const preseasonAssets = [
    asset('player-1', {
      currentSeasonFantasyPoints: 0,
      projectionGamesPlayed: 0,
      seasonTeamGamesPlayed: 0,
    }),
    asset('player-2', { draftProjectedSeasonPoints: 91 }),
  ];

  assert.equal(getRosterDisplayPhase(preseasonAssets), 'preseason');
  assert.equal(
    getRosterDisplayPhase([
      ...preseasonAssets,
      asset('player-3', { currentSeasonFantasyPoints: 0, seasonTeamGamesPlayed: 1 }),
    ]),
    'in-season',
  );
  assert.equal(getRosterDisplayMetricLabel('preseason'), 'Season projection');
  assert.equal(getRosterDisplayMetricLabel('in-season'), 'Season points');
});

test('preseason roster display order uses the projection feed without mutating slots', () => {
  const slots = [
    { slotId: 'slot-low', asset: asset('player-1', { draftProjectedSeasonPoints: 80 }) },
    { slotId: 'slot-missing', asset: asset('player-2') },
    { slotId: 'slot-high', asset: asset('player-3', { draftProjectedSeasonPoints: 125 }) },
    { slotId: 'slot-zero', asset: asset('player-4', { draftProjectedSeasonPoints: 0 }) },
  ];

  const ordered = orderRosterEntriesForDisplay(slots, (slot) => slot.asset, 'preseason');

  assert.deepEqual(ordered.map((slot) => slot.slotId), [
    'slot-high',
    'slot-low',
    'slot-zero',
    'slot-missing',
  ]);
  assert.deepEqual(slots.map((slot) => slot.slotId), [
    'slot-low',
    'slot-missing',
    'slot-high',
    'slot-zero',
  ]);
});

test('in-season roster display order keeps a legitimate zero distinct from missing points', () => {
  const slots = [
    {
      slotId: 'slot-tie-low-rate',
      asset: asset('player-1', {
        currentSeasonFantasyPoints: 50,
        seasonFantasyPointsPerGame: 2,
      }),
    },
    { slotId: 'slot-missing', asset: asset('player-2') },
    { slotId: 'slot-zero', asset: asset('player-3', { currentSeasonFantasyPoints: 0 }) },
    {
      slotId: 'slot-tie-high-rate',
      asset: asset('player-4', {
        currentSeasonFantasyPoints: 50,
        seasonFantasyPointsPerGame: 4,
      }),
    },
    { slotId: 'slot-leader', asset: asset('player-5', { currentSeasonFantasyPoints: 75 }) },
  ];

  const ordered = orderRosterEntriesForDisplay(slots, (slot) => slot.asset, 'in-season');

  assert.deepEqual(ordered.map((slot) => slot.slotId), [
    'slot-leader',
    'slot-tie-high-rate',
    'slot-tie-low-rate',
    'slot-zero',
    'slot-missing',
  ]);
  assert.equal(getRosterDisplayMetric(slots[2].asset, 'in-season'), 0);
  assert.equal(getRosterDisplayMetric(slots[1].asset, 'in-season'), null);
});

test('empty slots remain stable and follow populated players', () => {
  const slots = [
    { slotId: 'empty-1', asset: null },
    { slotId: 'player', asset: asset('player-1', { draftProjectedSeasonPoints: 1 }) },
    { slotId: 'empty-2', asset: null },
  ];

  const ordered = orderRosterEntriesForDisplay(slots, (slot) => slot.asset, 'preseason');

  assert.deepEqual(ordered.map((slot) => slot.slotId), ['player', 'empty-1', 'empty-2']);
});

test('My Team and Matchup use display-only ordering and expose its metric', async () => {
  const [teamSource, teamTemplate, matchupSource, matchupTemplate, mobileTemplate] = await Promise.all([
    read('src/app/features/team/team-settings/team-settings.ts'),
    read('src/app/features/team/team-settings/team-settings.html'),
    read('src/app/features/cycles/cycle-one/cycle-one.ts'),
    read('src/app/features/cycles/cycle-one/components/cycle-matchup-team-panel/cycle-matchup-team-panel.html'),
    read('src/app/features/cycles/cycle-one/components/cycle-mobile-head-to-head/cycle-mobile-head-to-head.html'),
  ]);

  assert.match(teamSource, /getPositionSlotsForDisplay/);
  assert.match(teamSource, /return orderRosterEntriesForDisplay\(/);
  assert.match(teamTemplate, /getPositionSlotsForDisplay\('D'\)/);
  assert.match(teamTemplate, /getPositionSlotsForDisplay\('G'\)/);
  assert.match(teamTemplate, /getRosterAssetDisplayMetric\(asset\)/);
  assert.match(teamTemplate, /roster-display-order-note/);

  assert.match(matchupSource, /getTeamPicksByPositionForDisplay/);
  assert.match(matchupSource, /getTeamPicksByPositionForDisplay\(matchup\.teamAOwnerId, position\)/);
  assert.match(matchupTemplate, /getTeamPicksByPositionForDisplay\(ownerId, position\)/);
  assert.match(matchupTemplate, /getAssetRosterDisplayMetric\(pick\.asset\)/);
  assert.match(matchupTemplate, /matchup-roster-order-note/);
  assert.match(mobileTemplate, /mobile-roster-order-note/);
  assert.match(mobileTemplate, /class="mobile-roster-rank"/);

  assert.match(teamSource, /getPositionSlots\(position/);
  assert.match(matchupSource, /getTeamPicksByPosition\(ownerId/);
});

test('roster action emphasis and IR activation layout remain accessible and responsive', async () => {
  const [template, styles, mobileStyles] = await Promise.all([
    read('src/app/features/team/team-settings/team-settings.html'),
    read('src/app/features/team/team-settings/team-settings.css'),
    read('src/rinkrat-mobile-roster-v1.css'),
  ]);

  assert.match(template, /hero-add-drop-action/);
  assert.match(template, /activate-action roster-promote-action/);
  assert.match(template, /mini-roster-action roster-promote-action/);
  assert.match(template, /<fieldset class="ir-activation-choice-group">/);
  assert.match(template, /<fieldset class="ir-activation-choice-group ir-activation-compact-choice-group">/);
  assert.match(template, /class="ir-activation-target ir-activation-target--no-logo"/);
  assert.match(template, /<legend>[\s\S]*Choose the starting/);
  assert.match(styles, /\.mini-roster-action\.roster-promote-action[\s\S]*background: var\(--rr-info\);[\s\S]*color: var\(--rr-scoreboard\);/);
  assert.match(styles, /\.mini-roster-action\.roster-promote-action:focus-visible/);
  assert.match(styles, /\.mini-roster-action\.roster-promote-action:disabled/);
  assert.match(styles, /\.ir-activation-target:focus-within/);
  assert.match(styles, /@media \(max-width: 420px\)[\s\S]*\.ir-activation-dialog-actions[\s\S]*flex-direction: column-reverse/);
  assert.match(styles, /\.ir-activation-target\.ir-activation-target--no-logo[\s\S]*grid-template-columns: 18px minmax\(0, 1fr\) auto/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.ir-activation-target[\s\S]*transition: none/);
  assert.match(mobileStyles, /\.roster-manager-action--primary[\s\S]*background: var\(--rr-info\);[\s\S]*color: var\(--rr-scoreboard\);/);
  assert.ok(contrastRatio('#78b7ff', '#07111d') >= 4.5);
});

test('Coach glossary definitions render above the Coach modal on desktop and mobile', async () => {
  const [termStyles, coachStyles, termTemplate] = await Promise.all([
    read('src/app/shared/hockey-terms/hockey-term-chip.css'),
    read('src/app/shared/coach-help/coach-help.css'),
    read('src/app/shared/hockey-terms/hockey-term-chip.html'),
  ]);

  assert.match(coachStyles, /\.coach-help-backdrop[\s\S]*?z-index: 1490/);
  assert.match(termStyles, /\.hockey-term-popover[\s\S]*?z-index: calc\(var\(--rr-z-viewport-overlay, 2000\) \+ 10\)/);
  assert.doesNotMatch(termStyles, /\.hockey-term-popover[\s\S]*?z-index: 1000/);
  assert.match(termStyles, /@media \(max-width: 520px\)[\s\S]*bottom: calc\(82px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(termTemplate, /\[attr\.aria-label\]="'Define ' \+ definition\(\)\.label"/);
  assert.match(termTemplate, /aria-label="Close definition"/);
});

test('B1L adds a focused gate on top of the inherited staging gate', async () => {
  const packageJson = JSON.parse(await read('package.json'));

  assert.equal(
    packageJson.scripts['test:batchb1l:run'],
    'node --no-warnings --experimental-strip-types --test --test-concurrency=1 test/batchb1l-roster-presentation/*.test.mjs',
  );
  assert.match(packageJson.scripts['verify:batchb1l'], /test:batchb1l:run/);
  assert.match(packageJson.scripts['verify:batchb1l'], /verify:batchd1n-staging:core/);
  assert.match(packageJson.scripts['verify:batchb1l'], /security:dependency-audit/);
});
