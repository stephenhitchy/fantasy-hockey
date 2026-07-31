import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

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

test('Free Agents composes shared pool, filter, waiver, comparison, and confirmation foundations', async () => {
  const html = await source('src/app/features/free-agents/free-agents.html');
  for (const marker of [
    'free-agents-page rr-page-shell',
    'free-agent-hero rr-card rr-card--padded',
    'message-card fairness-card rr-notice rr-notice--info',
    'filter-row decision-filter-row rr-toolbar',
    'waiver-queue-card rr-data-panel',
    'asset-row decision-asset-card rr-list-row',
    'roster-slot-step rr-card rr-card--padded',
    'slot-choice-card rr-choice-card',
    'move-comparison-panel rr-data-panel',
    'confirm-move-button rr-button rr-button--primary',
  ]) {
    assert.match(html, new RegExp(marker));
  }
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
  const expectations = [
    ['src/app/features/team/team-settings/team-settings.css', 224, 4, '--rr-team-migration-color-'],
    ['src/app/features/free-agents/free-agents.css', 168, 8, '--rr-free-agents-migration-color-'],
    ['src/app/features/draft/draft-setup/draft-setup.css', 91, 0, '--rr-draft-setup-migration-color-'],
    ['src/app/features/draft/draft-room/draft-room.css', 189, 1, '--rr-draft-room-migration-color-'],
    ['src/app/features/cycles/cycle-one/cycle-one.css', 392, 1, null],
  ];
  for (const [file, colorBudget, importantBudget, aliasMarker] of expectations) {
    const css = await source(file);
    assert.ok(literalColorCount(css) <= colorBudget, `${file} exceeded its migrated color budget.`);
    assert.ok((css.match(/!important\b/g) ?? []).length <= importantBudget, `${file} increased important overrides.`);
    if (aliasMarker) {
      assert.match(css, new RegExp(aliasMarker));
      assert.match(css, /Transitional aliases preserve the approved page palette during Batch 7C\.3/);
    } else {
      assert.doesNotMatch(css, /--rr-game-center-migration-color-/);
    }
  }
});

test('Batch 7C.3 lowers the global debt ceiling and provides verification, audit, and consolidated documentation', async () => {
  const budget = JSON.parse(await source('config/design-system-budgets.json'));
  assert.ok(budget.allCssLiteralColors <= 2862);
  assert.ok(budget.allCssImportantDeclarations <= 595);
  assert.equal(budget.teamSettingsCssLiteralColors, 224);
  assert.equal(budget.freeAgentsCssLiteralColors, 168);
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
