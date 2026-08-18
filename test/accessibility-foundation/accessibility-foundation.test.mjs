import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

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

test('ships one reusable dialog focus trap with focus restoration and Escape handling', async () => {
  const source = await readFile(
    path.join(root, 'src/app/shared/accessibility/dialog-focus-trap.directive.ts'),
    'utf8',
  );

  assert.match(source, /selector:\s*'\[appDialogFocusTrap\]'/);
  assert.match(source, /standalone:\s*true/);
  assert.match(source, /event\.key !== 'Tab'/);
  assert.match(source, /event\.key === 'Escape'/);
  assert.match(source, /dialogEscape\.emit\(\)/);
  assert.match(source, /restoreTarget\??\.isConnected/);
  assert.match(source, /requestAnimationFrame/);
});

test('every modal dialog uses the shared focus trap', async () => {
  const htmlFiles = (await walk(path.join(root, 'src/app'))).filter((file) => file.endsWith('.html'));

  for (const file of htmlFiles) {
    const html = await readFile(file, 'utf8');
    const dialogTags = html.match(/<[^>]*role="dialog"[^>]*>/gs) ?? [];

    for (const tag of dialogTags) {
      assert.match(
        tag,
        /appDialogFocusTrap/,
        `${path.relative(root, file)} has a dialog without the shared focus trap.`,
      );
    }
  }
});

test('dismissible dialogs expose Escape and non-dismissible draft routing is explicit', async () => {
  const [coach, navbar, team, league] = await Promise.all([
    readFile(path.join(root, 'src/app/shared/coach-help/coach-help.html'), 'utf8'),
    readFile(path.join(root, 'src/app/shared/navbar/navbar.html'), 'utf8'),
    readFile(path.join(root, 'src/app/features/team/team-settings/team-settings.html'), 'utf8'),
    readFile(path.join(root, 'src/app/features/leagues/league-detail/league-detail.html'), 'utf8'),
  ]);

  assert.match(coach, /\(dialogEscape\)="close\(\)"/);
  assert.match(navbar, /\(dialogEscape\)="closeMore\(\)"/);
  assert.match(team, /\(dialogEscape\)="cancelIrActivation\(\)"/);
  assert.match(team, /\(dialogEscape\)="cancelIrBenchActivation\(\)"/);
  assert.match(team, /\(dialogEscape\)="cancelBenchSwap\(\)"/);
  assert.match(team, /\(dialogEscape\)="cancelRosterDrop\(\)"/);
  assert.match(league, /\[dialogCloseOnEscape\]="false"/);
});

test('authentication is a semantic form with named autocomplete-enabled controls', async () => {
  const html = await readFile(path.join(root, 'src/app/features/auth/auth.html'), 'utf8');

  assert.match(html, /<form[\s\S]*\(ngSubmit\)="submit\(\)"/);
  assert.match(html, /type="submit"\s+class="primary-submit"/);
  assert.match(html, /name="username"[\s\S]*autocomplete="username"/);
  assert.match(html, /name="email"[\s\S]*autocomplete="email"/);
  assert.match(html, /name="password"[\s\S]*\[attr\.autocomplete\]="passwordAutocomplete\(\)"/);
  assert.match(html, /role="alert"[\s\S]*aria-live="assertive"/);
  assert.match(html, /role="status"[\s\S]*aria-live="polite"/);
});

test('authentication validation focuses the first invalid control', async () => {
  const source = await readFile(path.join(root, 'src/app/features/auth/auth.ts'), 'utf8');

  assert.match(source, /validateCurrentForm\(\)/);
  assert.match(source, /setValidationError\(/);
  assert.match(source, /focusTarget\.focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /invalidField = signal/);
});

test('favorite-team selection follows radio-group keyboard conventions', async () => {
  const [html, source] = await Promise.all([
    readFile(path.join(root, 'src/app/features/auth/auth.html'), 'utf8'),
    readFile(path.join(root, 'src/app/features/auth/auth.ts'), 'utf8'),
  ]);

  assert.match(html, /role="radiogroup"/);
  assert.match(html, /role="radio"/);
  assert.match(html, /\[attr\.aria-checked\]/);
  assert.match(html, /\(keydown\)="handleTeamGridKeydown\(\$event, team\)"/);
  assert.match(source, /ArrowRight/);
  assert.match(source, /ArrowLeft/);
  assert.match(source, /Home/);
  assert.match(source, /End/);
});

test('route changes announce the page, update the document title, and focus the heading', async () => {
  const [html, source, routes] = await Promise.all([
    readFile(path.join(root, 'src/app/layouts/main-layout/main-layout.html'), 'utf8'),
    readFile(path.join(root, 'src/app/layouts/main-layout/main-layout.ts'), 'utf8'),
    readFile(path.join(root, 'src/app/app.routes.ts'), 'utf8'),
  ]);

  assert.match(html, /role="status"\s+aria-live="polite"\s+aria-atomic="true"/);
  assert.match(html, /#mainContent/);
  assert.match(source, /documentTitle\.setTitle/);
  assert.match(source, /querySelector<HTMLElement>\('h1'\)/);
  assert.match(source, /target\.focus\(\{ preventScroll: true \}\)/);

  const expectedTitles = [
    'Dashboard',
    'League HQ',
    'Game Center',
    'Draft Room',
    'My Team',
    'Add / Drop',
    'Account Settings',
  ];
  for (const title of expectedTitles) {
    assert.match(routes, new RegExp(`title: '${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  }
});

test('visually hidden announcements use a reusable shared primitive', async () => {
  const css = await readFile(path.join(root, 'src/rinkrat-shared-primitives.css'), 'utf8');
  assert.match(css, /\.rr-visually-hidden\s*\{/);
  assert.match(css, /clip:\s*rect\(0 0 0 0\)/);
});

test('Batch 7B verification and consolidated documentation remain available', async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(
    packageJson.scripts?.['test:accessibility:run'],
    'node --test --test-concurrency=1 test/accessibility-foundation/*.test.mjs',
  );
  assert.equal(packageJson.scripts?.['audit:accessibility'], 'node scripts/audit-accessibility.mjs');
  assert.match(packageJson.scripts?.['verify:batch7b'] ?? '', /verify:batch7a/);
  assert.match(packageJson.scripts?.['verify:batch7b'] ?? '', /test:accessibility:run/);
  assert.match(packageJson.scripts?.['verify:batch7b'] ?? '', /audit:accessibility/);

  const docs = await readFile(path.join(root, 'docs/RINKRAT_PROJECT_DOCUMENTATION.md'), 'utf8');
  assert.match(docs, /Batch 7B — Accessibility Foundations/);
});
