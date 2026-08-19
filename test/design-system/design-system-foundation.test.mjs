import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const sourceRoot = path.join(root, 'src');
const tokenPath = path.join(sourceRoot, 'rinkrat-design-tokens.css');
const primitivePath = path.join(sourceRoot, 'rinkrat-shared-primitives.css');

async function exists(relativePath) {
  try {
    await access(path.join(root, relativePath), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(fullPath) : [fullPath];
    }),
  );
  return nested.flat();
}

function customPropertyValue(css, propertyName, selector = ':root') {
  const selectorStart = css.indexOf(`${selector} {`);
  assert.notEqual(selectorStart, -1, `Missing ${selector} token block.`);
  const blockEnd = css.indexOf('\n}', selectorStart);
  assert.notEqual(blockEnd, -1, `Unclosed ${selector} token block.`);
  const block = css.slice(selectorStart, blockEnd);
  const match = block.match(new RegExp(`${propertyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*([^;]+);`));
  assert.ok(match, `Missing ${propertyName} in ${selector}.`);
  return match[1].trim();
}

test('loads the token source first and opt-in primitives last', async () => {
  const angular = JSON.parse(await readFile(path.join(root, 'angular.json'), 'utf8'));
  const styles = angular.projects['fantasy-hockey'].architect.build.options.styles;

  assert.equal(styles[0], 'src/rinkrat-design-tokens.css');
  assert.equal(styles.at(-1), 'src/rinkrat-shared-primitives.css');
  assert.equal(new Set(styles).size, styles.length, 'Global styles must not be loaded twice.');
});

test('centralizes every global root token block in one file', async () => {
  const topLevelCss = (await readdir(sourceRoot))
    .filter((name) => name.endsWith('.css'))
    .filter((name) => name !== 'rinkrat-design-tokens.css');

  for (const fileName of topLevelCss) {
    const css = await readFile(path.join(sourceRoot, fileName), 'utf8');
    assert.doesNotMatch(css, /(^|\n)\s*:root\s*\{/, `${fileName} defines a second global token root.`);
  }
});

test('preserves the approved dark, OLED, gray, and Light Ice theme values', async () => {
  const css = await readFile(tokenPath, 'utf8');

  assert.equal(customPropertyValue(css, '--page-bg'), '#0e1116');
  assert.equal(customPropertyValue(css, '--surface-1'), '#171c23');
  assert.equal(customPropertyValue(css, '--text-primary'), '#f4f1e8');
  assert.equal(customPropertyValue(css, '--page-bg', "html[data-background-theme='oled-black']"), '#050607');
  assert.equal(customPropertyValue(css, '--page-bg', "html[data-background-theme='ice-gray']"), '#15181d');
  assert.equal(customPropertyValue(css, '--page-bg', "html[data-background-theme='light-ice']"), '#dfe5eb');
  assert.equal(customPropertyValue(css, '--text-primary', "html[data-background-theme='light-ice']"), '#18202a');
  assert.equal(customPropertyValue(css, '--rr-scoreboard', "html[data-background-theme='light-ice']"), '#122337');
});

test('provides semantic color, type, spacing, sizing, motion, and layer tokens', async () => {
  const css = await readFile(tokenPath, 'utf8');
  const required = [
    '--rr-color-page',
    '--rr-color-surface',
    '--rr-color-text',
    '--rr-color-primary',
    '--rr-color-success',
    '--rr-font-display',
    '--rr-font-interface',
    '--rr-font-numeric',
    '--rr-font-code',
    '--rr-text-md',
    '--rr-space-4',
    '--rr-control-min-height',
    '--rr-touch-target',
    '--rr-shadow-card',
    '--rr-duration-normal',
    '--rr-ease-standard',
    '--rr-z-dialog',
  ];

  for (const property of required) {
    assert.match(css, new RegExp(`${property}\\s*:`), `Missing semantic token ${property}.`);
  }
});

test('defines opt-in primitives for cards, controls, forms, statuses, progress, and states', async () => {
  const css = await readFile(primitivePath, 'utf8');
  const primitives = [
    '.rr-card',
    '.rr-button',
    '.rr-button--primary',
    '.rr-field',
    '.rr-select',
    '.rr-textarea',
    '.rr-badge',
    '.rr-notice',
    '.rr-progress',
    '.rr-state',
    '.rr-spinner',
  ];

  for (const selector of primitives) {
    assert.match(css, new RegExp(selector.replaceAll('.', '\\.') + '(?:\\s|,|\\{|:)'), `Missing ${selector}.`);
  }

  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /--rr-touch-target/);
});

test('keeps shared primitives free of hard-coded colors and important overrides', async () => {
  const css = await readFile(primitivePath, 'utf8');
  assert.doesNotMatch(css, /!important\b/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(css, /\b(?:rgb|rgba|hsl|hsla)\([^)]*\)/);
});

test('keeps primitive adoption limited to deliberately reviewed templates', async () => {
  const approved = new Set([
    'src/app/features/account/account-settings/account-settings.html',
    'src/app/features/admin/admin-center/admin-center.html',
    'src/app/features/support/known-issues/known-issues.html',
    'src/app/features/cycles/cycle-one/components/cycle-matchup-breakdown/cycle-matchup-breakdown.html',
    'src/app/features/cycles/cycle-one/components/cycle-matchup-card/cycle-matchup-card.html',
    'src/app/features/cycles/cycle-one/components/cycle-matchup-finish-card/cycle-matchup-finish-card.html',
    'src/app/features/cycles/cycle-one/components/cycle-matchup-team-panel/cycle-matchup-team-panel.html',
    'src/app/features/cycles/cycle-one/components/cycle-mobile-head-to-head/cycle-mobile-head-to-head.html',
    'src/app/features/cycles/cycle-one/components/cycle-page-header/cycle-page-header.html',
    'src/app/features/cycles/cycle-one/components/offline-matchup-snapshot/offline-matchup-snapshot.html',
    'src/app/features/cycles/cycle-one/components/cycle-status-banners/cycle-status-banners.html',
    'src/app/features/cycles/cycle-one/cycle-one.html',
    'src/app/features/draft/draft-room/draft-room.html',
    'src/app/features/draft/draft-setup/draft-setup.html',
    'src/app/features/free-agents/free-agents.html',
    'src/app/features/free-agents/decision-history/decision-history.html',
    'src/app/features/team/team-settings/team-settings.html',
    'src/app/features/dashboard/dashboard.html',
    'src/app/features/dashboard/nhl-scoreboard/nhl-scoreboard.html',
    'src/app/features/leagues/league-detail/league-detail.html',
    'src/app/features/leagues/commissioner-playbook/commissioner-playbook.html',
    'src/app/features/leagues/league-wire/league-wire.html',
    'src/app/features/players/league-player-board/league-player-board.html',
    'src/app/features/errors/access-denied/access-denied.html',
    'src/app/features/leagues/create-league/create-league.html',
    'src/app/features/leagues/join-league/join-league.html',
    'src/app/features/legal/privacy/privacy.html',
    'src/app/features/legal/terms/terms.html',
    'src/app/features/release/invite-beta-validation/invite-beta-validation.html',
    'src/app/features/support/feedback/feedback.html',
    'src/app/features/support/commissioner-guide/commissioner-guide.html',
    'src/app/features/support/support-home/support-home.html',
    'src/app/shared/admin-session-step-up/admin-session-step-up.html',
  ]);
  const appFiles = (await walk(path.join(sourceRoot, 'app'))).filter((filePath) => filePath.endsWith('.html'));

  for (const filePath of appFiles) {
    const html = await readFile(filePath, 'utf8');
    const usesMigratedPrimitive =
      /\brr-(?:card|button|field|select|textarea|badge|notice|progress|state|spinner)\b/.test(html);
    if (!usesMigratedPrimitive) continue;

    const relativePath = path.relative(root, filePath);
    assert.equal(
      approved.has(relativePath),
      true,
      `${relativePath} uses a visual primitive without being in the reviewed migration allowlist.`,
    );
  }
});

test('keeps every stylesheet structurally balanced', async () => {
  const cssFiles = (await walk(sourceRoot)).filter((filePath) => filePath.endsWith('.css'));

  for (const filePath of cssFiles) {
    const css = await readFile(filePath, 'utf8');
    let depth = 0;
    let minimumDepth = 0;
    for (const character of css) {
      if (character === '{') depth += 1;
      if (character === '}') depth -= 1;
      minimumDepth = Math.min(minimumDepth, depth);
    }
    assert.equal(minimumDepth, 0, `${path.relative(root, filePath)} closes a block before opening it.`);
    assert.equal(depth, 0, `${path.relative(root, filePath)} has unbalanced braces.`);
  }
});

test('ships a repeatable debt audit and consolidated Batch 7A documentation', async () => {
  assert.equal(await exists('scripts/audit-design-system.mjs'), true);
  assert.equal(await exists('config/design-system-budgets.json'), true);

  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts?.['audit:design-system'], 'node scripts/audit-design-system.mjs');
  assert.match(packageJson.scripts?.['verify:batch7a'] ?? '', /verify:batch6c/);
  assert.match(packageJson.scripts?.['verify:batch7a'] ?? '', /test:design-system:run/);
  assert.match(packageJson.scripts?.['verify:batch7a'] ?? '', /audit:design-system/);

  const docs = await readFile(path.join(root, 'docs', 'RINKRAT_PROJECT_DOCUMENTATION.md'), 'utf8');
  assert.match(docs, /Batch 7A — Design-System Foundation/);
});
