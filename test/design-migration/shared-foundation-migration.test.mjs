import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

async function source(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

test('desktop and mobile navigation use one shared nav-item primitive', async () => {
  const html = await source('src/app/shared/navbar/navbar.html');
  const css = await source('src/app/shared/navbar/navbar.css');

  assert.match(html, /class="rr-nav-item"/);
  assert.match(html, /class="rr-nav-item rr-nav-item--stacked"/);
  assert.match(css, /\.desktop-links \.rr-nav-item/);
  assert.match(css, /\.mobile-bottom-nav \.rr-nav-item/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\([^)]*\)/);
});

test('create and join league share the token-driven pixel shell', async () => {
  const [createHtml, joinHtml, primitives] = await Promise.all([
    source('src/app/features/leagues/create-league/create-league.html'),
    source('src/app/features/leagues/join-league/join-league.html'),
    source('src/rinkrat-shared-primitives.css'),
  ]);

  for (const html of [createHtml, joinHtml]) {
    assert.match(html, /rr-pixel-shell-page/);
    assert.match(html, /rr-pixel-shell-stage/);
    assert.match(html, /rr-pixel-shell-panel/);
    assert.match(html, /rr-pixel-shell-field/);
    assert.match(html, /rr-pixel-shell-submit/);
    assert.match(html, /rr-pixel-shell-error/);
  }

  assert.match(primitives, /\.rr-pixel-shell-page\s*\{/);
  assert.match(primitives, /\.rr-pixel-shell-panel\s*\{/);
  assert.match(primitives, /\.rr-pixel-shell-field/);
});

test('join league no longer duplicates the common shell implementation', async () => {
  const css = await source('src/app/features/leagues/join-league/join-league.css');
  const duplicatedSelectors = [
    '.pixel-shell-page',
    '.shell-copy',
    '.shell-card',
    '.form-field',
    '.primary-submit',
    '.status-message',
    '.mini-ref',
  ];

  for (const selector of duplicatedSelectors) {
    assert.doesNotMatch(css, new RegExp(selector.replaceAll('.', '\\.')));
  }
  assert.ok(css.split('\n').length <= 14, 'Join League should keep only feature-specific layout variables.');
});

test('support, legal, and access surfaces compose the shared card primitive', async () => {
  const files = [
    'src/app/features/support/support-home/support-home.html',
    'src/app/features/support/feedback/feedback.html',
    'src/app/features/errors/access-denied/access-denied.html',
    'src/app/features/legal/privacy/privacy.html',
    'src/app/features/legal/terms/terms.html',
  ];

  for (const file of files) {
    const html = await source(file);
    assert.match(html, /rr-card/);
    assert.match(html, /rr-card--padded/);
  }
});

test('feedback composes shared form, button, and notice primitives', async () => {
  const html = await source('src/app/features/support/feedback/feedback.html');
  assert.match(html, /rr-field-group/);
  assert.match(html, /rr-select/);
  assert.match(html, /rr-textarea/);
  assert.match(html, /rr-button rr-button--secondary/);
  assert.match(html, /rr-button rr-button--primary/);
  assert.match(html, /rr-notice rr-notice--success/);
  assert.match(html, /rr-notice rr-notice--danger/);
});

test('migrated shared surfaces are token driven and add no important overrides', async () => {
  const files = [
    'src/app/shared/navbar/navbar.css',
    'src/app/features/leagues/join-league/join-league.css',
    'src/app/features/support/support-home/support-home.css',
    'src/app/features/support/feedback/feedback.css',
    'src/app/features/errors/access-denied/access-denied.css',
    'src/app/features/legal/legal-page.css',
  ];

  for (const file of files) {
    const css = await source(file);
    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\([^)]*\)/, `${file} contains a literal color.`);
    assert.doesNotMatch(css, /!important\b/, `${file} added an important override.`);
  }
});

test('shared primitives expose migration-safe customization hooks', async () => {
  const css = await source('src/rinkrat-shared-primitives.css');
  const requiredHooks = [
    '--rr-card-border-width',
    '--rr-card-background',
    '--rr-card-padding',
    '--rr-button-min-height',
    '--rr-field-background',
    '--rr-notice-background',
    '--rr-nav-item-min-height',
    '--rr-shell-columns',
  ];

  for (const hook of requiredHooks) {
    assert.match(css, new RegExp(hook));
  }
});

test('the design-debt ceiling is lower than the Batch 7A baseline', async () => {
  const budget = JSON.parse(await source('config/design-system-budgets.json'));
  assert.ok(budget.allCssImportantDeclarations < 597);
  assert.ok(budget.allCssLiteralColors < 3295);
  assert.equal(budget.sharedPrimitiveImportantDeclarations, 0);
  assert.equal(budget.sharedPrimitiveLiteralColors, 0);
});

test('Batch 7C.1 verification and consolidated documentation are available', async () => {
  const packageJson = JSON.parse(await source('package.json'));
  assert.equal(
    packageJson.scripts?.['test:design-migration:run'],
    'node --test --test-concurrency=1 test/design-migration/*.test.mjs',
  );
  assert.equal(
    packageJson.scripts?.['audit:design-migration'],
    'node scripts/audit-shared-ui-migration.mjs',
  );
  assert.match(packageJson.scripts?.['verify:batch7c1'] ?? '', /verify:batch7b/);
  assert.match(packageJson.scripts?.['verify:batch7c1'] ?? '', /test:design-migration:run/);
  assert.match(packageJson.scripts?.['verify:batch7c1'] ?? '', /audit:design-migration/);

  const docs = await source('docs/RINKRAT_PROJECT_DOCUMENTATION.md');
  assert.match(docs, /Batch 7C\.1 — Shared UI Migration/);
});
