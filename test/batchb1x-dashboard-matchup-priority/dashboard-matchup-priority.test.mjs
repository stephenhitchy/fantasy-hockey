import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  clampDashboardLeagueRailIndex,
  getDashboardLeagueRailIndex,
} from '../../src/app/features/dashboard/dashboard-league-carousel.util.ts';

const projectRoot = resolve(import.meta.dirname, '..', '..');
const read = (path) => readFile(join(projectRoot, path), 'utf8');

test('B1X dashboard matchup rail calculations remain bounded and deterministic', () => {
  assert.equal(clampDashboardLeagueRailIndex(-2, 4), 0);
  assert.equal(clampDashboardLeagueRailIndex(2, 4), 2);
  assert.equal(clampDashboardLeagueRailIndex(9, 4), 3);
  assert.equal(clampDashboardLeagueRailIndex(Number.NaN, 4), 0);
  assert.equal(clampDashboardLeagueRailIndex(2, 0), 0);

  const offsets = [0, 360, 720, 1080];
  assert.equal(getDashboardLeagueRailIndex(0, offsets), 0);
  assert.equal(getDashboardLeagueRailIndex(354, offsets), 1);
  assert.equal(getDashboardLeagueRailIndex(899, offsets), 2);
  assert.equal(getDashboardLeagueRailIndex(1100, offsets), 3);
  assert.equal(getDashboardLeagueRailIndex(20, []), 0);
});

test('B1X makes league matchups the first dashboard feature and emphasizes both scores', async () => {
  const template = await read('src/app/features/dashboard/dashboard.html');
  const leagueSectionIndex = template.indexOf('class="leagues-section"');
  const briefingIndex = template.indexOf('class="manager-briefing');
  const nhlScoreboardIndex = template.indexOf('<app-nhl-scoreboard');

  assert.notEqual(leagueSectionIndex, -1);
  assert.ok(leagueSectionIndex < briefingIndex);
  assert.ok(leagueSectionIndex < nhlScoreboardIndex);
  assert.match(template, /<h2>Matchups<\/h2>/);
  assert.match(template, /class="dashboard-matchup-team dashboard-matchup-team--mine"[\s\S]*?matchup\.myScore/);
  assert.match(template, /class="dashboard-matchup-team dashboard-matchup-team--opponent"[\s\S]*?matchup\.opponentScore/);
  assert.match(template, /league\.myTeamName/);
  assert.match(template, /matchup\.opponentTeamName/);
});

test('B1X offers swipe, arrow-button, and keyboard navigation without a new data source', async () => {
  const [template, component, styles] = await Promise.all([
    read('src/app/features/dashboard/dashboard.html'),
    read('src/app/features/dashboard/dashboard.ts'),
    read('src/app/features/dashboard/dashboard.css'),
  ]);

  assert.match(template, /#leagueRail[\s\S]*?role="region"[\s\S]*?tabindex="0"/);
  assert.match(template, /handleLeagueRailKeydown\(\$event\)/);
  assert.match(template, /handleLeagueRailScroll\(\)/);
  assert.match(template, /\[disabled\]="!canOpenPreviousLeague\(\)"/);
  assert.match(template, /\[disabled\]="!canOpenNextLeague\(\)"/);
  assert.match(component, /event\.key === 'ArrowLeft'/);
  assert.match(component, /event\.key === 'ArrowRight'/);
  assert.match(component, /rail\.scrollTo\(\{/);
  assert.match(component, /prefers-reduced-motion: reduce/);
  assert.match(component, /Math\.abs\(rail\.scrollLeft - pointer\.startScrollLeft\) > 2/);
  assert.ok(
    component.indexOf("Date.now() - this.lastLeagueCardDragAt < 700") <
      component.indexOf("target.closest('a, button, input, select, textarea, [role=\"button\"]')"),
  );
  assert.doesNotMatch(component, /onSnapshot|addEventListener/);
  assert.match(styles, /scroll-snap-type:\s*x mandatory/);
  assert.match(styles, /overscroll-behavior-x:\s*contain/);
  assert.match(styles, /touch-action:\s*pan-x pan-y pinch-zoom/);
});

test('B1X removes routine league creation from the dashboard and signed-in mobile bottom edge', async () => {
  const [dashboard, navbar, navbarStyles, layoutStyles, mobileAudit] = await Promise.all([
    read('src/app/features/dashboard/dashboard.html'),
    read('src/app/shared/navbar/navbar.html'),
    read('src/app/shared/navbar/navbar.css'),
    read('src/app/layouts/main-layout/main-layout.css'),
    read('scripts/audit-mobile-readability.mjs'),
  ]);

  assert.doesNotMatch(dashboard, /routerLink="\/leagues\/(?:create|join)"/);
  assert.match(dashboard, /Create or join from the top-right menu/);

  const signedOutBottomNavigation = navbar.match(
    /@if \(!authenticated\(\)\) \{[\s\S]*?<nav class="mobile-bottom-nav[\s\S]*?<\/nav>[\s\S]*?\}/,
  )?.[0] ?? '';
  assert.match(signedOutBottomNavigation, /mobile-bottom-nav--signed-out/);
  assert.doesNotMatch(signedOutBottomNavigation, /\/dashboard|\/leagues\/(?:create|join)|\/scoring"/);

  for (const destination of ['/dashboard', '/scoring', '/leagues/create', '/leagues/join']) {
    assert.match(navbar, new RegExp(`routerLink="${destination.replaceAll('/', '\\/')}"`));
  }

  assert.match(navbarStyles, /max-height:\s*min\(86dvh, 760px\)/);
  assert.match(layoutStyles, /--rr-mobile-nav-height:\s*0px/);
  assert.match(layoutStyles, /padding:\s*20px 10px calc\(24px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(mobileAudit, /Create League/);
  assert.match(mobileAudit, /Mobile \$\{label\} destination is missing from the durable global navigation/);
  assert.match(mobileAudit, /Signed-in destinations were restored to the persistent mobile bottom navigation/);
});

test('B1X is documented as a Hosting-only presentation change', async () => {
  const [packageSource, documentation] = await Promise.all([
    read('package.json'),
    read('docs/RINKRAT_PRODUCT_B1X_DASHBOARD_MATCHUP_PRIORITY.md'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.match(packageJson.scripts?.['verify:batchb1x:core'] ?? '', /verify:batchd1lf:core/);
  assert.match(packageJson.scripts?.['verify:batchb1x:core'] ?? '', /test:batchb1x:run/);
  assert.match(documentation, /Hosting-only/);
  assert.match(documentation, /Production Scoring V4/);
  assert.match(documentation, /Projection V11/);
  assert.match(documentation, /No\s+Firestore listener/);
});
