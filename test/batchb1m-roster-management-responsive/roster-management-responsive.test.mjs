import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { resolveAssetPortrait } from '../../src/app/shared/asset-portrait/asset-portrait.util.ts';
import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

async function sha256(relativePath) {
  const contents = await readFile(new URL(relativePath, ROOT));
  return createHash('sha256').update(contents).digest('hex');
}

const skater = {
  assetType: 'skater',
  player: {
    id: 8478402,
    fullName: 'Charlie McAvoy',
    nhlTeamAbbreviation: 'BOS',
    headshotUrl: 'https://assets.nhle.com/mugs/nhl/20252026/BOS/8478402.png',
    teamLogoUrl: 'https://assets.nhle.com/logos/nhl/svg/BOS_light.svg',
  },
};

const goalieUnit = {
  assetType: 'team-goalie-unit',
  teamName: 'Boston Bruins',
  teamAbbreviation: 'BOS',
  teamLogoUrl: 'https://assets.nhle.com/logos/nhl/svg/BOS_light.svg',
};

test('skaters resolve the stable NHL headshot and keep the team logo secondary', () => {
  assert.deepEqual(resolveAssetPortrait(skater), {
    primaryImageUrl: skater.player.headshotUrl,
    primaryKind: 'headshot',
    primaryAlt: 'Charlie McAvoy headshot',
    teamBadgeUrl: skater.player.teamLogoUrl,
    fallbackLabel: 'Player image unavailable',
    playerId: 8478402,
  });
});

test('missing or failed skater images use a neutral player placeholder, never another face or a primary team logo', () => {
  const missing = resolveAssetPortrait({
    ...skater,
    player: { ...skater.player, headshotUrl: undefined },
  });
  const failed = resolveAssetPortrait(skater, new Set([skater.player.headshotUrl]));

  for (const portrait of [missing, failed]) {
    assert.equal(portrait.primaryImageUrl, null);
    assert.equal(portrait.primaryKind, 'player-placeholder');
    assert.equal(portrait.teamBadgeUrl, skater.player.teamLogoUrl);
  }
});

test('fantasy team-goalie units retain the NHL team-logo identity', () => {
  const portrait = resolveAssetPortrait(goalieUnit);

  assert.equal(portrait.primaryImageUrl, goalieUnit.teamLogoUrl);
  assert.equal(portrait.primaryKind, 'team-logo');
  assert.equal(portrait.teamBadgeUrl, null);
  assert.equal(portrait.playerId, null);
});

test('portaled Manage Roster Spot content owns styles that do not depend on the route host ancestor', async () => {
  const [styles, actionSheetTemplate, viewportPortal] = await Promise.all([
    read('src/rinkrat-mobile-roster-v1.css'),
    read('src/app/shared/action-sheet/action-sheet.html'),
    read('src/app/shared/accessibility/viewport-overlay-portal.directive.ts'),
  ]);

  assert.match(actionSheetTemplate, /rr-action-sheet-backdrop[\s\S]*appViewportOverlayPortal/);
  assert.match(viewportPortal, /document\.body\.appendChild\(this\.host\)/);
  assert.match(styles, /(?:^|\n)\.roster-manager-summary\s*\{/);
  assert.match(styles, /(?:^|\n)\.roster-manager-action\s*\{/);
  assert.doesNotMatch(styles, /app-team-settings \.roster-manager-(?:summary|identity|action)/);
  assert.match(
    styles,
    /\.roster-manager-portrait\s*\{[\s\S]*?width:\s*3\.5rem[\s\S]*?height:\s*3\.5rem/,
  );
});

test('lineup destination cards keep occupant copy in the flexible track at phone widths', async () => {
  const styles = await read('src/app/features/team/team-settings/team-settings.css');
  const lastGenericMobileGrid = styles.lastIndexOf('.ir-activation-target {');
  const finalLineupGrid = styles.lastIndexOf('.ir-activation-target.lineup-change-target');

  assert.ok(lastGenericMobileGrid >= 0);
  assert.ok(finalLineupGrid > lastGenericMobileGrid);
  assert.match(styles.slice(finalLineupGrid), /grid-template-columns:\s*18px minmax\(0, 1fr\)/);
  assert.match(
    styles,
    /\.lineup-change-target \.ir-activation-target-copy strong,[\s\S]*?word-break:\s*normal/,
  );
  assert.match(styles, /@media \(max-width: 390px\)/);
  assert.doesNotMatch(styles.slice(finalLineupGrid), /grid-template-columns:\s*18px 30px minmax/);
});

test('roster cards separate details navigation from Manage or Add actions with valid elements', async () => {
  const [template, source, freeAgentTemplate] = await Promise.all([
    read('src/app/features/team/team-settings/team-settings.html'),
    read('src/app/features/team/team-settings/team-settings.ts'),
    read('src/app/features/free-agents/free-agents.html'),
  ]);

  assert.match(template, /class="fantasy-player-main roster-player-detail-link"/);
  assert.match(template, /role="link"[\s\S]*?tabindex="0"/);
  assert.ok(
    (
      template.match(/\(click\)="\$event\.stopPropagation\(\); openRosterAssetDetail\(asset\)"/g) ??
      []
    ).length >= 5,
  );
  assert.match(template, /Manage \/ Move/);
  assert.doesNotMatch(template, /View Stats/);
  assert.doesNotMatch(template, /<button\b[^>]*>\s*<button\b/);
  assert.match(source, /handleRosterCardSurfaceClick/);
  assert.match(source, /target\.closest\('button, a, input, select, textarea/);
  assert.match(freeAgentTemplate, /row\.status === 'free-agent' \|\| row\.status === 'waivers'/);
  assert.match(freeAgentTemplate, /startBoardTransaction\(row\)/);
});

test('all roster and add/drop identity surfaces use the compact failure-safe portrait component', async () => {
  const [teamTemplate, freeAgentTemplate, portraitTemplate, portraitStyles] = await Promise.all([
    read('src/app/features/team/team-settings/team-settings.html'),
    read('src/app/features/free-agents/free-agents.html'),
    read('src/app/shared/asset-portrait/asset-portrait.html'),
    read('src/app/shared/asset-portrait/asset-portrait.css'),
  ]);

  assert.ok((teamTemplate.match(/<app-asset-portrait/g) ?? []).length >= 10);
  assert.ok((freeAgentTemplate.match(/<app-asset-portrait/g) ?? []).length >= 3);
  assert.match(portraitTemplate, /asset-portrait__placeholder/);
  assert.match(portraitTemplate, /\(error\)="markImageUnavailable/);
  assert.match(portraitTemplate, /asset-portrait__team-badge/);
  assert.match(portraitStyles, /object-fit:\s*cover/);
  assert.match(
    portraitStyles,
    /\.asset-portrait--team-logo \.asset-portrait__primary|object-fit:\s*contain/,
  );
});

test('mobile sheets reset their own scroll root and respect dynamic viewport and safe-area bounds', async () => {
  const [template, styles, sharedSheetStyles] = await Promise.all([
    read('src/app/features/team/team-settings/team-settings.html'),
    read('src/app/features/team/team-settings/team-settings.css'),
    read('src/app/shared/action-sheet/action-sheet.css'),
  ]);

  assert.ok((template.match(/data-overlay-scroll-root/g) ?? []).length >= 4);
  assert.match(styles, /max-height:\s*calc\(100dvh - 44px\)/);
  assert.match(styles, /max-height:\s*96dvh/);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
  assert.match(
    sharedSheetStyles,
    /padding-bottom:\s*max\(var\(--rr-space-4\), env\(safe-area-inset-bottom\)\)/,
  );
});

test('missing scoring evidence stays missing instead of becoming a displayed zero', async () => {
  const [source, template] = await Promise.all([
    read('src/app/features/team/team-settings/team-settings.ts'),
    read('src/app/features/team/team-settings/team-settings.html'),
  ]);

  assert.match(source, /getRosterAssetCurrentCycleScore\(asset: unknown\): number \| null/);
  assert.match(source, /currentScore \?\? null/);
  assert.match(source, /getRosterAssetGameProgress/);
  assert.match(template, /Current points/);
  assert.match(template, /Next 6 projection/);
  assert.match(template, /Six-game progress/);
});

test('roster authority, scoring, Projection V11, Rules, and indexes remain unchanged', async () => {
  const protectedFiles = new Map([
    [
      'src/app/core/transactions/roster-move-eligibility.service.ts',
      'cbabe659b326511531db101c66fc7edd8e4ac441328dcd5f7ffc4223c9607b47',
    ],
    [
      'src/app/core/draft/draft.service.ts',
      '45d3a535db9f75986e7a99ad35f2e5541ad5229c20d57b52b5d32d4ec9ac2244',
    ],
    [
      'src/app/core/scoring/scoring-rules.ts',
      PROTECTED_SOURCE_HASHES.scoringRules,
    ],
    [
      'src/app/core/projection/projection-v11.util.ts',
      PROTECTED_SOURCE_HASHES.projectionV11,
    ],
    ['firestore.rules', PROTECTED_SOURCE_HASHES.firestoreRules],
    ['firestore.indexes.json', PROTECTED_SOURCE_HASHES.firestoreIndexes],
  ]);

  for (const [file, expectedHash] of protectedFiles) {
    assert.equal(await sha256(file), expectedHash, `${file} must remain unchanged`);
  }
});
