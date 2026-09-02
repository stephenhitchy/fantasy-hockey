import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const source = (relativePath) => readFile(path.join(root, relativePath), 'utf8');

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  }));
  return nested.flat();
}

function relativeLuminance(hex) {
  const channels = hex
    .replace('#', '')
    .match(/.{2}/g)
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));

  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

function contrastRatio(foreground, background) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

test('semantic link and secondary-action colors meet WCAG normal-text contrast in every background theme', async () => {
  const [tokens, primitives, identities] = await Promise.all([
    source('src/rinkrat-design-tokens.css'),
    source('src/rinkrat-shared-primitives.css'),
    source('src/app/shared/pixel-theme/pixel-theme.data.ts'),
  ]);

  assert.match(tokens, /--rr-color-link:\s*var\(--accent-cyan\)/);
  assert.match(tokens, /html\[data-background-theme='light-ice'\][\s\S]*--rr-color-link:\s*var\(--rr-scoreboard-raised\)/);
  assert.match(tokens, /--rr-color-action-secondary:\s*var\(--rr-scoreboard-raised\)/);
  assert.match(tokens, /--rr-color-on-action-secondary:\s*var\(--rr-ice-white\)/);
  assert.match(primitives, /\.rr-button--secondary\s*\{[\s\S]*--rr-button-background:\s*var\(--rr-color-action-secondary\)/);
  assert.doesNotMatch(
    primitives.match(/\.rr-button--secondary\s*\{[\s\S]*?\}/)?.[0] ?? '',
    /--user-team-/,
  );

  const textPairs = [
    ['Rink Dark link', '#85dce6', '#171c23'],
    ['OLED Black link', '#85dce6', '#0d1014'],
    ['Ice Gray link', '#85dce6', '#1f252d'],
    ['Light Ice link', '#1d344d', '#f8fafc'],
    ['dark secondary action', '#f4f8fb', '#101f31'],
    ['Light Ice secondary action', '#f4f8fb', '#1d344d'],
    ['playoff primary copy', '#f4f8fb', '#203952'],
    ['playoff secondary copy', '#d8e8f4', '#203952'],
    ['playoff metadata', '#85dce6', '#203952'],
  ];

  for (const [label, foreground, background] of textPairs) {
    assert.ok(
      contrastRatio(foreground, background) >= 4.5,
      `${label} must retain at least 4.5:1 contrast`,
    );
  }

  for (const expectedIdentity of [
    /team\('BOS',[^\n]*'#000000'[^\n]*'#FFB81C'[^\n]*'#FFFFFF'/,
    /team\('MIN',[^\n]*'#154734'[^\n]*'#A6192E'[^\n]*'#EAAA00'/,
    /team\('NSH',[^\n]*'#FFB81C'[^\n]*'#041E42'[^\n]*'#FFFFFF'/,
    /team\('TBL',[^\n]*'#002868'[^\n]*'#FFFFFF'[^\n]*'#111111'/,
  ]) {
    assert.match(identities, expectedIdentity);
  }
});

test('Support and public-resource links use the contrast-safe semantic token instead of NHL secondary colors', async () => {
  const files = await Promise.all([
    source('src/app/features/support/support-home/support-home.css'),
    source('src/app/features/support/feedback/feedback.css'),
    source('src/app/features/legal/legal-page.css'),
    source('src/app/features/auth/auth.css'),
    source('src/app/layouts/main-layout/main-layout.css'),
    source('src/app/layouts/public-resource-layout/public-resource-layout.css'),
  ]);

  for (const css of files) {
    assert.doesNotMatch(css, /color:\s*var\(--user-team-secondary\)/);
    assert.match(css, /color:\s*var\(--rr-color-link\)/);
  }

  assert.match(files[0], /\.support-grid a \+ a\s*\{\s*margin-left:\s*var\(--rr-space-3\)/);
});

test('Playoff and Draft text follows the surface it is actually rendered on', async () => {
  const [playoffs, draft, globalCss, phaseTwo] = await Promise.all([
    source('src/app/features/playoffs/playoff-bracket/playoff-bracket.css'),
    source('src/app/features/draft/draft-room/draft-room.css'),
    source('src/styles.css'),
    source('src/rinkrat-page-identities-phase2.css'),
  ]);

  assert.match(playoffs, /\.back-link\s*\{[\s\S]*color:\s*var\(--rr-color-link\)/);
  assert.match(playoffs, /\.preview-card > p,[\s\S]*color:\s*var\(--text-secondary\)/);
  assert.match(playoffs, /\.section-heading a\s*\{[\s\S]*color:\s*var\(--rr-color-link\)/);
  assert.match(playoffs, /\.seed-card strong\s*\{\s*color:\s*var\(--rr-ice-white\)/);
  assert.match(playoffs, /\.seed-card div span\s*\{[\s\S]*color:\s*var\(--rr-ice-blue\)/);
  assert.match(playoffs, /\.seed-card div small\s*\{[\s\S]*color:\s*var\(--accent-cyan\)/);

  assert.match(draft, /\.back-link\s*\{[\s\S]*color:\s*var\(--rr-color-link\)/);
  assert.match(draft, /\.draft-injury-sync-banner strong\s*\{\s*color:\s*var\(--text-primary\)/);
  assert.match(draft, /\.draft-injury-sync-banner span\s*\{\s*color:\s*var\(--text-secondary\)/);
  assert.match(globalCss, /\.turn-clock-summary:not\(\.turn-clock-urgent\) strong\s*\{\s*color:\s*var\(--text-primary\)/);
  assert.doesNotMatch(globalCss, /draft-clock-bar:is\(\.clock-urgent, \.clock-paused, \.clock-stopped\)/);
  assert.doesNotMatch(globalCss, /turn-clock-summary\.turn-clock-urgent strong/);
  assert.match(phaseTwo, /draft-clock-bar :is\(span, strong, small\)\s*\{\s*color:\s*#ffffff !important/);
  assert.match(draft, /\.turn-clock-summary\.turn-clock-urgent strong\s*\{\s*color:\s*#a22626/);
});

test('Coach is an in-flow, named control while its dialog retains keyboard handling', async () => {
  const [template, layout, css] = await Promise.all([
    source('src/app/shared/coach-help/coach-help.html'),
    source('src/app/layouts/main-layout/main-layout.html'),
    source('src/app/shared/coach-help/coach-help.css'),
  ]);

  const triggerRule = css.match(/\.coach-help-trigger\s*\{[\s\S]*?\}/)?.[0] ?? '';
  assert.match(template, /aria-label="Open RinkRat Coach help"/);
  assert.match(template, /aria-controls="rinkrat-coach-panel"/);
  assert.match(template, /appDialogFocusTrap/);
  assert.match(template, /\(dialogEscape\)="close\(\)"/);
  assert.match(layout, /<main[^>]*>[\s\S]*<router-outlet><\/router-outlet>\s*<\/main>\s*<app-coach-help><\/app-coach-help>/);
  assert.match(css, /:host\s*\{[\s\S]*display:\s*block;[\s\S]*min-height:\s*54px/);
  assert.match(triggerRule, /position:\s*relative/);
  assert.doesNotMatch(triggerRule, /position:\s*fixed/);
  assert.doesNotMatch(css, /\.coach-trigger-copy\s*\{\s*display:\s*none/);
});

test('Standings, Playoffs, and Matchup protect narrow-screen labels and scores', async () => {
  const [arena, matchup] = await Promise.all([
    source('src/rinkrat-arena-phase3.css'),
    source('src/app/features/cycles/cycle-one/cycle-one.css'),
  ]);

  assert.match(
    arena,
    /@media \(max-width: 720px\)[\s\S]*app-league-standings \.standings-header,[\s\S]*app-playoff-bracket \.playoff-hero\s*\{\s*padding:\s*50px 14px 16px 18px !important/,
  );
  assert.match(matchup, /@media \(max-width: 390px\)[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) 56px minmax\(0, 1fr\)/);
  assert.match(matchup, /@media \(max-width: 340px\)[\s\S]*\.mobile-score-team app-manager-avatar\s*\{\s*display:\s*none/);
  assert.match(matchup, /\.mobile-score-team > strong\s*\{\s*line-height:\s*1\.1/);
});

test('visual repair preserves focus, disabled, loading, error, reduced-motion, and design-budget gates', async () => {
  const [support, draft, playoffs, standings, matchup, coach, globalCss, budget] = await Promise.all([
    source('src/app/features/support/support-home/support-home.css'),
    source('src/app/features/draft/draft-room/draft-room.css'),
    source('src/app/features/playoffs/playoff-bracket/playoff-bracket.css'),
    source('src/app/features/leagues/league-standings/league-standings.css'),
    source('src/app/features/cycles/cycle-one/cycle-one.css'),
    source('src/app/shared/coach-help/coach-help.css'),
    source('src/styles.css'),
    source('config/design-system-budgets.json'),
  ]);

  assert.match(globalCss, /:focus-visible/);
  assert.match(draft, /:disabled/);
  assert.match(playoffs, /\.page-loading/);
  assert.match(playoffs, /\.error-card/);
  assert.match(standings, /\.page-loading/);
  assert.match(standings, /\.error-card/);
  assert.match(matchup, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(coach, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(support, /support-diagnostics-error/);

  const configuredBudget = JSON.parse(budget).allCssImportantDeclarations;
  assert.equal(configuredBudget, 595, 'the approved !important budget must not be raised');

  const cssFiles = (await walk(path.join(root, 'src'))).filter((file) => file.endsWith('.css'));
  const allCss = (await Promise.all(cssFiles.map((file) => readFile(file, 'utf8')))).join('\n');
  assert.ok((allCss.match(/!important\b/g) ?? []).length < configuredBudget);
});
