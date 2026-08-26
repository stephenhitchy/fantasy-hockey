import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const htmlPath = 'src/app/features/leagues/league-detail/league-detail.html';
const cssPath = 'src/app/features/leagues/league-detail/league-detail.css';
const tsPath = 'src/app/features/leagues/league-detail/league-detail.ts';

const source = (path) => readFile(path, 'utf8');

function expectOrder(text, markers) {
  let prior = -1;

  for (const marker of markers) {
    const position = text.indexOf(marker);
    assert.ok(position >= 0, `Missing expected marker: ${marker}`);
    assert.ok(position > prior, `${marker} is out of the intended League HQ order.`);
    prior = position;
  }
}

test('the invite code is promoted into the top header priority area', async () => {
  const html = await source(htmlPath);

  assert.match(html, /class="league-header-priority"/);
  assert.match(html, /class="top-invite-card rr-card rr-card--padded"/);
  assert.match(html, /<h2 id="invite-code-title">League Code<\/h2>/);
  assert.match(html, /class="copy-invite-button rr-button rr-button--primary"/);
  assert.doesNotMatch(html, /<section class="invite-card rr-card rr-card--padded">/);

  expectOrder(html, [
    'class="league-header"',
    'class="top-invite-card',
    'class="league-navigation-card"',
    'class="my-team-card',
  ]);
});



test('the invite code uses a clear monospaced font for ambiguous letters and numbers', async () => {
  const [css, tokens] = await Promise.all([
    source(cssPath),
    source('src/rinkrat-design-tokens.css'),
  ]);

  assert.match(tokens, /--rr-font-code:\s*ui-monospace/);
  assert.match(css, /\.top-invite-code-row \.invite-code\s*\{[\s\S]*font-family:\s*var\(--rr-font-code\)/);
  assert.match(css, /font-variant-numeric:\s*tabular-nums slashed-zero/);
  assert.match(css, /letter-spacing:\s*0\.08em/);
});

test('the invite card communicates capacity with semantic progress', async () => {
  const [html, ts] = await Promise.all([source(htmlPath), source(tsPath)]);

  for (const marker of [
    'inviteAvailabilityLabel()',
    'leagueFillPercentage()',
    'role="progressbar"',
    'aria-label="League team slots filled"',
    '[attr.aria-valuemax]="league()?.maxTeams ?? 0"',
    '[attr.aria-valuenow]="teams().length"',
  ]) {
    assert.match(html, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(ts, /readonly openTeamSpots = computed/);
  assert.match(ts, /readonly leagueFillPercentage = computed/);
  assert.match(ts, /readonly inviteAvailabilityLabel = computed/);
  assert.match(ts, /Math\.min\(100, Math\.round/);
});

test('primary header actions adapt to draft and season state', async () => {
  const html = await source(htmlPath);

  const primaryNav = html.match(/<nav class="league-actions"[\s\S]*?<\/nav>/)?.[0] ?? '';

  expectOrder(primaryNav, [
    "draft()?.status === 'live'",
    'Enter Live Draft',
    "draft()?.status !== 'complete'",
    'Draft Setup',
    '} @else {',
    'Draft Room',
    '} @else if (cycle()) {',
    'Open My Matchup',
    `[routerLink]="['/leagues', leagueId, 'team']"`,
  ]);

  assert.match(primaryNav, /<a class="primary-action/);
  assert.doesNotMatch(primaryNav, /secondary-action/);
});

test('team identity flows into league activity, status, teams, and tools without duplicate page tiles', async () => {
  const html = await source(htmlPath);

  expectOrder(html, [
    'id="my-league-team-title"',
    '<app-league-wire',
    'id="league-status-title"',
    'class="teams-section"',
    'class="league-secondary-tools"',
    'class="commissioner-danger-zone',
  ]);

  assert.match(html, /<app-league-quick-navigation[\s\S]*?currentDestination="league-hq"/);
  assert.doesNotMatch(html, /Most-used league pages|league-essentials-card|id="league-essentials-title"/);
  assert.doesNotMatch(
    html,
    /\['\/leagues', leagueId, 'leaders'\]/,
    'Point Leaders remains available from Players and More rather than duplicating primary navigation.',
  );
});

test('less-frequent and commissioner tools are separated from essential navigation', async () => {
  const html = await source(htmlPath);

  assert.match(html, /class="league-tools general-league-tools"/);
  assert.match(html, /<strong id="league-tools-title">Schedule and analysis<\/strong>/);
  assert.match(html, /class="league-tools commissioner-tools"/);
  assert.match(html, /League Management/);
  assert.match(html, /Owner Tools/);
  assert.match(html, /Private diagnostics/);
  assert.match(html, /Scoring Diagnostics/);
  assert.match(html, /Release Readiness/);

  const navigationStart = html.indexOf('<app-league-quick-navigation');
  const navigationEnd = html.indexOf('</section>', navigationStart);
  const diagnostics = html.indexOf('Scoring Diagnostics');
  assert.ok(navigationStart >= 0 && navigationEnd > navigationStart);
  assert.ok(diagnostics > navigationEnd, 'Technical diagnostics must not crowd the shared league navigation.');
});

test('cycle matchup cards are available behind disclosure instead of dominating the page', async () => {
  const html = await source(htmlPath);

  assert.match(html, /<details class="cycle-matchup-preview">/);
  assert.match(html, /<strong>Preview every matchup<\/strong>/);
  assert.match(html, /\{\{ matchups\(\)\.length \}\} in \{\{ currentCycleLabel\(\) \}\}/);
  assert.match(html, /class="matchup-list"/);
});

test('the new hierarchy is responsive and uses the shared token system', async () => {
  const css = await source(cssPath);
  const newSection = css.slice(css.indexOf('/* Batch 8B:'));

  for (const marker of [
    '.league-header-priority',
    '.top-invite-card',
    '.league-status-grid',
    '.cycle-matchup-preview',
    '.commissioner-tools-body',
    '@media (max-width: 980px)',
    '@media (max-width: 720px)',
  ]) {
    assert.match(newSection, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.equal((newSection.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).length, 0);
  assert.equal((newSection.match(/!important\b/g) ?? []).length, 0);
  assert.match(newSection, /var\(--rr-color-surface-raised\)/);
  assert.match(newSection, /var\(--user-team-primary\)/);
});

test('the reorganization changes presentation only', async () => {
  const ts = await source(tsPath);

  assert.doesNotMatch(ts, /setDoc\(|updateDoc\(|deleteDoc\(|addDoc\(/);
  assert.doesNotMatch(ts, /executeSecureRosterAction|makeSecureDraftPick|openNextCompetitionPeriod/);
});
