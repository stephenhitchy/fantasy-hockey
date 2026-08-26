import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  isInternalNavigationHistoryEligible,
  recordInternalNavigation,
  resolvePreviousInternalNavigation,
} from '../../src/app/core/navigation/navigation-history.util.ts';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('history-aware back returns to the page the manager actually visited', () => {
  const history = [
    '/dashboard',
    '/leagues/league-1/team',
    '/leagues/league-1/players',
  ];
  const resolution = resolvePreviousInternalNavigation(
    history,
    '/leagues/league-1/players',
  );

  assert.deepEqual(resolution, {
    destination: '/leagues/league-1/team',
    remainingHistory: ['/dashboard', '/leagues/league-1/team'],
  });

  assert.deepEqual(
    recordInternalNavigation(history, '/leagues/league-1/team', 'popstate'),
    ['/dashboard', '/leagues/league-1/team'],
  );
});

test('invite credentials never enter session navigation history', () => {
  assert.equal(isInternalNavigationHistoryEligible('/join/AB7K9Q'), false);
  assert.equal(isInternalNavigationHistoryEligible('/join/AB7K9Q?from=email'), false);
  assert.equal(isInternalNavigationHistoryEligible('/dashboard'), true);
  assert.deepEqual(
    recordInternalNavigation(['/dashboard'], '/join/AB7K9Q'),
    ['/dashboard'],
  );
});

test('corner back links use one global history coordinator with safe fallbacks', async () => {
  const [app, service, team, support, scoring, decisionHistory] = await Promise.all([
    read('src/app/app.ts'),
    read('src/app/core/navigation/navigation-history.service.ts'),
    read('src/app/features/team/team-settings/team-settings.html'),
    read('src/app/features/support/support-home/support-home.html'),
    read('src/app/features/scoring/scoring-guide/scoring-guide.html'),
    read('src/app/features/free-agents/decision-history/decision-history.html'),
  ]);

  assert.match(app, /NavigationHistoryService/);
  assert.match(service, /a\.league-return-link/);
  assert.match(service, /a\.support-back/);
  assert.match(service, /a\.decision-back-link/);
  assert.match(service, /event\.stopImmediatePropagation\(\)/);
  assert.match(service, /resolvePreviousInternalNavigation/);
  assert.match(service, /Wait for Angular's first completed navigation/);
  assert.doesNotMatch(service, /const initialUrl = normalizeInternalNavigationUrl\(router\.url\)/);
  assert.match(
    service,
    /recordInternalNavigation\(\s*previous\.remainingHistory,\s*this\.router\.url/,
  );
  assert.match(team, /data-rinkrat-history-back/);
  assert.match(
    support,
    /routerLink="\/dashboard"[^>]*class="support-back"[^>]*data-rinkrat-history-back/,
  );
  assert.doesNotMatch(support, /routerLink="\/" class="support-back"/);
  assert.match(scoring, /routerLink="\/support" data-rinkrat-history-back>Back<\/a>/);
  assert.match(decisionHistory, /decision-back-link[^>]*data-rinkrat-history-back/);
});

test('public resources share the persistent RinkRat navigation shell', async () => {
  const [routes, layout, navbar, auth, invite] = await Promise.all([
    read('src/app/app.routes.ts'),
    read('src/app/layouts/public-resource-layout/public-resource-layout.html'),
    read('src/app/shared/navbar/navbar.html'),
    read('src/app/features/auth/auth.html'),
    read('src/app/features/leagues/invite-link/invite-link.html'),
  ]);

  assert.match(routes, /public-resource-layout/);
  for (const path of [
    'privacy',
    'terms',
    'support',
    'status',
    'support/known-issues',
    'commissioner-guide',
    'fairness',
    'scoring-guide',
    'scoring-calculator',
  ]) {
    assert.match(routes, new RegExp(`path: '${path.replace('/', '\\/')}'`));
  }
  assert.match(layout, /<app-navbar><\/app-navbar>/);
  assert.match(layout, /<router-outlet><\/router-outlet>/);
  assert.match(auth, /^<app-navbar><\/app-navbar>/);
  assert.match(invite, /^<app-navbar><\/app-navbar>/);
  assert.match(navbar, /@if \(authenticated\(\)\)/);
  assert.match(navbar, /Scoring Guide/);
  assert.match(navbar, /Dashboard/);
  assert.match(navbar, /Create League/);
  assert.match(navbar, /Join League/);
  assert.match(navbar, /Account/);
  assert.doesNotMatch(navbar, /Scoring Calculator|Fairness Report/);
  assert.doesNotMatch(
    navbar,
    /icon-home" aria-hidden="true"><\/span>\s*<span class="nav-icon pixel-icon icon-home/,
  );
});

test('high-value league destinations retain stable icons and visual priority inside league pages', async () => {
  const [quickNavigation, quickNavigationStyles, dashboard, team] = await Promise.all([
    read('src/app/shared/league-quick-navigation/league-quick-navigation.html'),
    read('src/app/shared/league-quick-navigation/league-quick-navigation.css'),
    read('src/app/features/dashboard/dashboard.html'),
    read('src/app/features/team/team-settings/team-settings.html'),
  ]);

  assert.match(quickNavigation, /league-nav-action--priority[\s\S]*?icon-players[\s\S]*?Add \/ Drop Player/);
  assert.match(quickNavigation, /league-nav-action--priority[\s\S]*?icon-team[\s\S]*?My Team/);
  assert.match(quickNavigation, /league-nav-action--priority[\s\S]*?icon-matchup[\s\S]*?Current Matchup/);
  assert.match(quickNavigationStyles, /\.league-nav-action--priority/);
  assert.match(dashboard, /icon-team icon-sm[\s\S]*?<span>My Team<\/span>/);
  assert.match(team, /<app-league-quick-navigation/);
});

test('dashboard, League HQ, and My Team use the clearer matchup label and larger navigation', async () => {
  const [activity, leagueHome, leagueComponent, team] = await Promise.all([
    read('src/app/core/league/dashboard-league-activity.util.ts'),
    read('src/app/features/leagues/league-detail/league-detail.html'),
    read('src/app/features/leagues/league-detail/league-detail.ts'),
    read('src/app/features/team/team-settings/team-settings.html'),
  ]);

  assert.match(activity, /primaryActionLabel: 'Open Current Matchup'/);
  assert.doesNotMatch(activity, /primaryActionLabel: 'Open Game Center'/);
  assert.match(leagueHome, /icon-matchup icon-sm[\s\S]*?Open Current Matchup/);
  assert.doesNotMatch(leagueHome, /View Current Matchup/);

  assert.match(team, /<app-league-quick-navigation/);
  assert.doesNotMatch(team, /Projection Lab/);
  const sharedNavigationStyles = await read(
    'src/app/shared/league-quick-navigation/league-quick-navigation.css',
  );
  assert.match(sharedNavigationStyles, /min-height: 58px/);
  assert.match(
    sharedNavigationStyles,
    /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/,
  );
  assert.doesNotMatch(leagueHome, /getDailyInjuryStatusTimeLabel/);
  assert.doesNotMatch(leagueComponent, /getDailyInjuryStatusTimeLabel/);
});

test('Draft auto-entry and initial loading cannot permanently trap a manager', async () => {
  const [component, template, draftRoom, draftRoomTemplate] = await Promise.all([
    read('src/app/features/leagues/league-detail/league-detail.ts'),
    read('src/app/features/leagues/league-detail/league-detail.html'),
    read('src/app/features/draft/draft-room/draft-room.ts'),
    read('src/app/features/draft/draft-room/draft-room.html'),
  ]);

  const entryMethod = component.match(
    /async enterDraftRoom\(\): Promise<void> \{[\s\S]*?\n  \}\n\n  async reloadIntoDraftRoom/,
  )?.[0] ?? '';

  assert.match(entryMethod, /Promise\.race/);
  assert.match(entryMethod, /if \(navigationSucceeded\) \{[\s\S]*?this\.hasEnteredDraftRoom = true/);
  assert.doesNotMatch(
    entryMethod.split('if (navigationSucceeded)')[0] ?? '',
    /this\.hasEnteredDraftRoom = true/,
  );
  assert.match(entryMethod, /this\.draftEntryInProgress\.set\(false\)/);
  assert.match(component, /reloadIntoDraftRoom/);
  assert.match(component, /window\.location\.assign\(draftUrl\)/);
  assert.match(template, /Open Draft Room/);
  assert.match(template, /Reload &amp; Open Draft Room/);
  assert.match(template, /draftEntryRecoveryVisible\(\)/);
  assert.match(draftRoom, /DRAFT_INITIAL_LOAD_RECOVERY_DELAY_MILLISECONDS = 8_000/);
  assert.match(draftRoom, /draftLoadRecoveryVisible = signal\(false\)/);
  assert.match(draftRoom, /window\.location\.reload\(\)/);
  assert.match(draftRoomTemplate, /Joining Draft/);
  assert.match(draftRoomTemplate, /Reload Draft Room/);
});

test('corner return controls describe the new history-aware behavior', async () => {
  const [draft, matchup, support, fairness, createLeague] = await Promise.all([
    read('src/app/features/draft/draft-room/draft-room.html'),
    read('src/app/features/cycles/cycle-one/cycle-one.html'),
    read('src/app/features/support/support-home/support-home.html'),
    read('src/app/features/support/fairness-report/fairness-report.html'),
    read('src/app/features/leagues/create-league/create-league.html'),
  ]);

  for (const template of [draft, matchup]) {
    assert.match(template, /aria-label="Back to the previous RinkRat page"/);
    assert.doesNotMatch(template, /Back to League/);
  }

  assert.match(support, /data-rinkrat-history-back>← Back<\/a>/);
  assert.match(fairness, /data-rinkrat-history-back>← Back<\/a>/);
  assert.match(createLeague, /data-rinkrat-history-back>← Back<\/a>/);
});

test('B1H safeguards remain under the RC65 protected scoring and projection baseline', async () => {
  const [runtime, productionRuntime, scoring, projection, freezeSource] = await Promise.all([
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/projection/projection-snapshot.service.ts'),
    read('config/release-freeze/beta-freeze-policy.json'),
  ]);
  const freeze = JSON.parse(freezeSource);

  assert.match(runtime, /Release Candidate 65/);
  assert.match(productionRuntime, /Release Candidate 65/);
  assert.match(scoring, /CURRENT_SCORING_RULES_VERSION\s*=\s*4/);
  assert.match(projection, /SHARED_PROJECTION_VERSION\s*=\s*11/);
  assert.equal(freeze.releaseLabel, 'Release Candidate 65');
  assert.equal(freeze.requiredGamesPerRosterSlot, 6);
  assert.equal(freeze.queueMode, 'shadow');
  assert.equal(freeze.appCheckMode, 'monitor');
});

test('B1H release documentation and the permanent roadmap stay synchronized', async () => {
  const [packageSource, readme, runbook, batchDocumentation, roadmapRoot, roadmapDocs] =
    await Promise.all([
      read('package.json'),
      read('README.md'),
      read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
      read('docs/RINKRAT_BETA_B1H_NAVIGATION_RELIABILITY.md'),
      read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
      read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    ]);
  const packageJson = JSON.parse(packageSource);

  assert.equal(roadmapRoot, roadmapDocs);
  assert.match(roadmapRoot, /Version 1\.54\.4/);
  assert.match(roadmapRoot, /# \[x\] B1\.34 Make every manager-facing route easier to escape and re-enter/);
  assert.match(roadmapRoot, /# \[x\] B1\.35 Rebuild Training Camp as a progressive, game-like sequence/);
  assert.match(roadmapRoot, /# \[x\] B1\.36 Repair Training Camp position help/);
  assert.match(roadmapRoot, /\[ \] B1\.37 Audit manager-facing typography and copy density/);
  assert.match(roadmapRoot, /\[ \] B1\.38 Prove Identity Architect completion notices on Safari/);
  assert.match(roadmapRoot, /# \[x\] LOG\.79 2026-08-24/);
  assert.match(roadmapRoot, /# \[x\] LOG\.80 2026-08-24/);

  assert.match(packageJson.scripts['verify:batchb1h:core'], /verify:batchb1g:core/);
  assert.match(packageJson.scripts['verify:batchb1h:core'], /test:batchb1h:run/);
  assert.match(packageJson.scripts['security:ci'], /verify:batchb1j:core/);
  assert.match(readme, /Release Candidate 65 \/ Beta Batch B1J/);
  assert.match(readme, /RINKRAT_BETA_B1H_NAVIGATION_RELIABILITY\.md/);
  assert.match(runbook, /firebase deploy --only hosting:app/);
  assert.match(runbook, /RC62 Rules and Functions remain required/);
  assert.match(batchDocumentation, /Do not deploy Functions, Rules, indexes, or TTL policies for B1H/);
});
