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

test('shared primitives expose page composition patterns without literal colors', async () => {
  const css = await source('src/rinkrat-shared-primitives.css');
  const required = [
    '.rr-card--interactive',
    '.rr-section-heading',
    '.rr-stat-grid',
    '.rr-stat-card',
    '.rr-action-tile',
    '.rr-choice-card',
    '.rr-danger-zone',
  ];

  for (const marker of required) {
    assert.match(css, new RegExp(marker.replaceAll('.', '\\.')));
  }

  assert.equal(literalColorCount(css), 0);
  assert.doesNotMatch(css, /!important\b/);
});

test('Dashboard composes shared cards, buttons, notices, badges, and empty states', async () => {
  const html = await source('src/app/features/dashboard/dashboard.html');
  for (const marker of [
    'hero-copy rr-card rr-card--padded',
    'dashboard-mascot-card rr-card rr-card--padded rr-card--interactive',
    'training-camp-banner rr-notice rr-notice--info',
    'error-card rr-notice rr-notice--danger',
    'league-card rr-card rr-card--padded',
    'commissioner-badge rr-badge rr-badge--info',
    'open-league rr-button rr-button--primary',
  ]) {
    assert.match(html, new RegExp(marker));
  }
});

test('Account Settings composes shared panels, choices, forms, status notices, and danger controls', async () => {
  const html = await source('src/app/features/account/account-settings/account-settings.html');
  for (const marker of [
    'profile-hero rr-card rr-card--padded',
    'manager-stats rr-stat-grid',
    'account-panel favorite-team-panel rr-card rr-card--padded',
    'team-selector-button rr-choice-card',
    'team-variant-card rr-choice-card',
    'form-field rr-field-group',
    'class="rr-field"',
    'class="rr-select"',
    'save-profile-button rr-button rr-button--primary',
    'account-security-zone rr-danger-zone',
    'permanent-delete-account-button rr-button rr-button--danger',
  ]) {
    assert.match(html, new RegExp(marker));
  }
});

test('League HQ composes shared status cards, action tiles, forms, and danger controls', async () => {
  const html = await source('src/app/features/leagues/league-detail/league-detail.html');
  for (const marker of [
    'daily-injury-status rr-notice rr-notice--info',
    'league-info-grid rr-stat-grid',
    'league-info-card rr-stat-card',
    'draft-status-card rr-card rr-card--padded',
    'hub-action rr-action-tile',
    'tool-link rr-action-tile',
    'cycle-status-card rr-card rr-card--padded',
    'team-card rr-card rr-card--padded',
    'commissioner-danger-zone rr-danger-zone',
    'class="rr-field"',
    'permanent-delete-league-button rr-button rr-button--danger',
  ]) {
    assert.match(html, new RegExp(marker));
  }
});

test('migrated page palettes consolidate repeated literals without raising important debt', async () => {
  const expectations = [
    ['src/app/features/dashboard/dashboard.css', 29, 2, '--rr-dashboard-migration-color-'],
    ['src/app/features/leagues/league-detail/league-detail.css', 140, 8, '--rr-league-hq-migration-color-'],
    ['src/app/features/account/account-settings/account-settings.css', 111, 0, '--rr-account-migration-color-'],
  ];

  for (const [file, colorBudget, importantBudget, aliasMarker] of expectations) {
    const css = await source(file);
    assert.ok(literalColorCount(css) <= colorBudget, `${file} exceeded its migrated color budget.`);
    assert.ok((css.match(/!important\b/g) ?? []).length <= importantBudget, `${file} increased important overrides.`);
    assert.match(css, new RegExp(aliasMarker));
    assert.match(css, /Transitional aliases preserve the approved page palette/);
  }
});

test('the global design debt ceiling drops after the three-page migration', async () => {
  const budget = JSON.parse(await source('config/design-system-budgets.json'));
  assert.ok(budget.allCssLiteralColors <= 3079);
  assert.ok(budget.allCssImportantDeclarations <= 595);
  assert.equal(budget.dashboardCssLiteralColors, 29);
  assert.equal(budget.leagueHqCssLiteralColors, 140);
  assert.equal(budget.accountSettingsCssLiteralColors, 111);
});

test('Batch 7C.2 verification, audit, and consolidated documentation are available', async () => {
  const packageJson = JSON.parse(await source('package.json'));
  assert.equal(
    packageJson.scripts?.['test:page-design-migration:run'],
    'node --test --test-concurrency=1 test/page-design-migration/*.test.mjs',
  );
  assert.equal(
    packageJson.scripts?.['audit:page-design-migration'],
    'node scripts/audit-page-design-migration.mjs',
  );
  assert.match(packageJson.scripts?.['verify:batch7c2'] ?? '', /verify:batch7c1/);
  assert.match(packageJson.scripts?.['verify:batch7c2'] ?? '', /test:page-design-migration:run/);
  assert.match(packageJson.scripts?.['verify:batch7c2'] ?? '', /audit:page-design-migration/);

  const docs = await source('docs/RINKRAT_PROJECT_DOCUMENTATION.md');
  assert.match(docs, /Batch 7C\.2 — Dashboard, League HQ, and Account Migration/);
});
