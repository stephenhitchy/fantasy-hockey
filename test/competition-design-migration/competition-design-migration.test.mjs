import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  COMPETITION_STYLE_EXPECTATIONS,
  COMPETITION_TEMPLATE_EXPECTATIONS,
} from '../../scripts/competition-design-migration.expectations.mjs';

const root = process.cwd();

async function source(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

function literalColorCount(css) {
  return (css.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\([^)]*\)/g) ?? []).length;
}

test('shared primitives expose competition, roster, and dialog composition patterns without new literal colors', async () => {
  const css = await source('src/rinkrat-shared-primitives.css');
  for (const marker of [
    '.rr-toolbar',
    '.rr-list-row',
    '.rr-data-panel',
    '.rr-dialog-backdrop',
    '.rr-dialog',
    '.rr-dialog__header',
    '.rr-dialog__actions',
    '.rr-score-number',
  ]) {
    assert.match(css, new RegExp(marker.replaceAll('.', '\\.')));
  }
  assert.equal(literalColorCount(css), 0);
  assert.doesNotMatch(css, /!important\b/);
});

test('My Team composes shared page, roster, status, form, and dialog foundations', async () => {
  const html = await source('src/app/features/team/team-settings/team-settings.html');
  for (const marker of [
    'team-page rr-page-shell',
    'team-hero-card rr-card rr-card--padded',
    'team-stat-bar rr-stat-grid',
    'quick-actions-card rr-card rr-card--padded',
    'current-matchup-card rr-card rr-card--padded',
    'transaction-ledger-row rr-list-row',
    'roster-section rr-card rr-card--padded',
    'fantasy-position-group rr-data-panel',
    'fantasy-player-card rr-card',
    'ir-activation-backdrop rr-dialog-backdrop',
    'ir-activation-dialog rr-dialog',
    'ir-activation-dialog-actions rr-dialog__actions',
  ]) {
    assert.match(html, new RegExp(marker));
  }
});

test('Add / Drop composes the shared Player Board, filters, roster choices, and confirmation foundations', async () => {
  const html = await source('src/app/features/free-agents/free-agents.html');
  for (const marker of [
    'unified-player-page rr-page-shell',
    'unified-player-controls rr-card rr-card--padded',
    'class="rr-field',
    'class="unified-player-list"',
    'unified-player-row rr-card',
    'transaction-incoming-row unified-player-row rr-card',
    'transaction-roster-list',
    'transaction-confirmation rr-card rr-card--padded',
    'rr-button--commit',
  ]) {
    assert.match(html, new RegExp(marker));
  }
  assert.doesNotMatch(html, /app-action-sheet|rr-dialog-backdrop|viewport-overlay/i);
});

test('Draft Setup composes shared cards, statistics, controls, notices, and order rows', async () => {
  const html = await source('src/app/features/draft/draft-setup/draft-setup.html');
  for (const marker of [
    'draft-setup-page rr-page-shell',
    'draft-summary rr-stat-grid',
    'summary-card rr-stat-card',
    'requirements-card rr-card rr-card--padded',
    'schedule-card rr-card rr-card--padded',
    'schedule-status rr-badge',
    'schedule-input-group rr-field-group',
    'class="rr-field"',
    'class="rr-select"',
    'order-row rr-list-row',
    'save-button rr-button rr-button--primary',
  ]) {
    assert.match(html, new RegExp(marker));
  }
});

test('Draft Room composes shared clock, roster-needs, pool, queue, and roster foundations', async () => {
  const html = await source('src/app/features/draft/draft-room/draft-room.html');
  for (const marker of [
    'draft-room-page rr-page-shell',
    'draft-clock-bar rr-card rr-card--padded',
    'draft-roster-needs rr-card rr-card--padded',
    'draft-roster-need rr-choice-card',
    'draft-pick-track-item rr-list-row',
    'player-pool-panel rr-card rr-card--padded',
    'pool-controls rr-toolbar',
    'draft-asset-card rr-list-row',
    'sidebar-card queue-card rr-card rr-card--padded',
    'sidebar-card roster-card rr-card rr-card--padded',
  ]) {
    assert.match(html, new RegExp(marker));
  }
});

test('Game Center composes shared shell, matchup cards, progress, badges, and controls without restoring the rejected overview', async () => {
  const files = await Promise.all([
    source('src/app/features/cycles/cycle-one/cycle-one.html'),
    source('src/app/features/cycles/cycle-one/components/cycle-matchup-card/cycle-matchup-card.html'),
    source('src/app/features/cycles/cycle-one/components/cycle-matchup-team-panel/cycle-matchup-team-panel.html'),
    source('src/app/features/cycles/cycle-one/components/cycle-page-header/cycle-page-header.html'),
    source('src/app/features/cycles/cycle-one/components/cycle-status-banners/cycle-status-banners.html'),
  ]);
  const combined = files.join('\n');
  for (const marker of [
    'cycle-page rr-page-shell',
    'dev-controls-card rr-card',
    'matchup-detail-card rr-card rr-card--padded',
    'team-matchup-panel rr-data-panel',
    'team-roster-progress-track rr-progress',
    'team-roster-progress-fill rr-progress__value',
    'schedule-preview-header-link rr-button rr-button--secondary',
    'shared-scoring-status-card rr-notice rr-notice--info',
  ]) {
    assert.match(combined, new RegExp(marker));
  }
  assert.doesNotMatch(combined, /cycle-matchup-overview|matchup-summary-stage|combined matchup progress/i);
});



test('Game Center uses a wider responsive roster and a compact two-row six-game marker grid', async () => {
  const css = await source('src/app/features/cycles/cycle-one/cycle-one.css');
  const globalCss = await source('src/styles.css');

  assert.match(css, /\.g \.cycle-page \{[\s\S]*?width: 100%;[\s\S]*?max-width: 1760px;[\s\S]*?padding: 28px 10px 48px;/);
  assert.match(css, /\.g \.teams-comparison \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) 20px minmax\(0, 1fr\);/);
  assert.match(css, /@media \(max-width: 1180px\) \{[\s\S]*?\.g \.teams-comparison \{[\s\S]*?grid-template-columns: 1fr;/);
  assert.match(css, /\.g \.fantasy-player-main strong \{[\s\S]*?font-size: 14px;[\s\S]*?white-space: normal;/);
  assert.match(css, /\.g \.window-game-markers \{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);[\s\S]*?width: 82px;/);
  assert.match(globalCss, /app-cycle-one \.single-team-view \.window-game-markers \{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
});

test('competition palettes consolidate repeated literals without raising important debt', async () => {
  for (const expectation of COMPETITION_STYLE_EXPECTATIONS) {
    const css = await source(expectation.relativePath);
    assert.ok(
      literalColorCount(css) <= expectation.literalColorBudget,
      `${expectation.relativePath} exceeded its current color budget.`,
    );
    assert.ok(
      (css.match(/!important\b/g) ?? []).length <= expectation.importantBudget,
      `${expectation.relativePath} increased important overrides.`,
    );
    for (const marker of expectation.requiredMarkers) {
      assert.match(css, new RegExp(marker));
    }
    for (const marker of expectation.forbiddenMarkers) {
      assert.doesNotMatch(css, new RegExp(marker));
    }
  }
});

test('current audit follows the unified Add / Drop replacement instead of retired Batch 7C.3 markers', async () => {
  const expectation = COMPETITION_TEMPLATE_EXPECTATIONS.find(
    (item) => item.relativePath === 'src/app/features/free-agents/free-agents.html',
  );
  assert.ok(expectation, 'Missing current Add / Drop audit expectation.');
  assert.deepEqual(expectation.requiredMarkers, [
    'unified-player-page rr-page-shell',
    'unified-player-controls rr-card rr-card--padded',
    'class="rr-field',
    'class="rr-select"',
    'class="unified-player-list"',
    'unified-player-row rr-card',
    'transaction-incoming-row unified-player-row rr-card',
    'transaction-roster-list',
    'transaction-confirmation rr-card rr-card--padded',
    'rr-button--commit',
  ]);
  assert.ok(expectation.forbiddenMarkers.includes('replacement-player-card'));
  assert.ok(expectation.forbiddenMarkers.includes('rr-dialog-backdrop'));

  const [audit, packageSource, roadmap, docsRoadmap] = await Promise.all([
    source('scripts/audit-competition-design-migration.mjs'),
    source('package.json'),
    source('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    source('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
  ]);
  const packageJson = JSON.parse(packageSource);
  assert.match(audit, /competition-design-migration\.expectations\.mjs/);
  assert.match(audit, /unified Add \/ Drop/);
  assert.doesNotMatch(audit, /const templates = new Map/);
  assert.match(packageJson.scripts['verify:batcho1h:core'], /verify:batcho1g:core/);
  assert.match(packageJson.scripts['verify:batcho1f:core'], /verify:batcho1e:core/);
  assert.match(
    packageJson.scripts['verify:batcho1e:core'],
    /test:batcho1e:run && npm run audit:competition-design-migration && npm run test:batcho1e-2:run && npm run validate:release-manifest/,
  );
  assert.match(packageJson.scripts['security:ci'], /Operations Batch O1H/);
  assert.equal(roadmap, docsRoadmap);
  const versionMatch = roadmap.match(/^Version (\d+)\.(\d+)(?:\.(\d+))?$/m);
  assert.ok(versionMatch, 'Missing semantic roadmap version.');
  const [, majorText, minorText, patchText = '0'] = versionMatch;
  const [major, minor, patch] = [majorText, minorText, patchText].map(Number);
  assert.ok(
    major > 1 || (major === 1 && (minor > 46 || (minor === 46 && patch >= 1))),
    'The current roadmap must retain the O1E.1 audit rebaseline or a later version.',
  );
  assert.match(roadmap, /LOG\.68 2026-08-20 — Completed Operations Batch O1E\.1/);
});

test('Batch 7C.3 lowers the global debt ceiling and provides verification, audit, and consolidated documentation', async () => {
  const budget = JSON.parse(await source('config/design-system-budgets.json'));
  assert.ok(budget.allCssLiteralColors <= 2862);
  assert.ok(budget.allCssImportantDeclarations <= 595);
  assert.equal(budget.teamSettingsCssLiteralColors, 224);
  assert.equal(budget.freeAgentsCssLiteralColors, 8);
  assert.equal(budget.draftSetupCssLiteralColors, 91);
  assert.equal(budget.draftRoomCssLiteralColors, 189);
  assert.equal(budget.gameCenterCssLiteralColors, 392);

  const packageJson = JSON.parse(await source('package.json'));
  assert.equal(
    packageJson.scripts?.['test:competition-design-migration:run'],
    'node --test --test-concurrency=1 test/competition-design-migration/*.test.mjs',
  );
  assert.equal(
    packageJson.scripts?.['audit:competition-design-migration'],
    'node scripts/audit-competition-design-migration.mjs',
  );
  assert.match(packageJson.scripts?.['verify:batch7c3'] ?? '', /verify:batch7c2/);
  assert.match(packageJson.scripts?.['verify:batch7c3'] ?? '', /test:competition-design-migration:run/);
  assert.match(packageJson.scripts?.['verify:batch7c3'] ?? '', /audit:competition-design-migration/);

  const docs = await source('docs/RINKRAT_PROJECT_DOCUMENTATION.md');
  assert.match(docs, /Batch 7C\.3 — Competition Surface Design Migration/);
});
