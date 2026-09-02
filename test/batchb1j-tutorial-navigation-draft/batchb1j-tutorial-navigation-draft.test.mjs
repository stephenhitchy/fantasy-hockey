import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import {
  TRAINING_CAMP_STEPS,
  TRAINING_CAMP_TOTAL_DRILLS,
} from '../../src/app/features/onboarding/training-camp/training-camp.data.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

async function sha256(relativePath) {
  const content = await readFile(new URL(relativePath, ROOT));
  return createHash('sha256').update(content).digest('hex');
}

async function sha256FunctionsIndexBeforeD1M() {
  const source = await read('functions/src/index.ts');
  const d1mExport = '  getFinalScoreReconciliationPage,\n';

  assert.equal(source.split(d1mExport).length - 1, 1);
  return createHash('sha256')
    .update(source.replace(d1mExport, ''))
    .digest('hex');
}

test('B1J exposes a complete inherited release gate instead of a missing npm script', async () => {
  const packageJson = JSON.parse(await read('package.json'));

  assert.equal(
    packageJson.scripts['test:batchb1j:run'],
    'node --no-warnings --experimental-strip-types --test --test-concurrency=1 test/batchb1j-tutorial-navigation-draft/*.test.mjs',
  );
  assert.match(packageJson.scripts['verify:batchb1j:core'], /verify:batchb1i:core/);
  assert.match(packageJson.scripts['verify:batchb1j:core'], /test:batchb1j:run/);
  assert.match(packageJson.scripts['verify:batchb1j'], /toolchain:verify/);
  assert.match(packageJson.scripts['verify:batchb1j'], /security:dependency-audit/);
  assert.match(packageJson.scripts['security:ci'], /verify:batch(?:b1j|d1j):core/);
});

test('Training Camp can leave for the Scoring Guide and return to the exact permitted lesson', async () => {
  const [source, template, guideSource, guideTemplate] = await Promise.all([
    read('src/app/features/onboarding/training-camp/training-camp.ts'),
    read('src/app/features/onboarding/training-camp/training-camp.html'),
    read('src/app/features/scoring/scoring-guide/scoring-guide.ts'),
    read('src/app/features/scoring/scoring-guide/scoring-guide.html'),
  ]);

  assert.match(source, /readonly scoringGuideQueryParams = computed/);
  assert.match(source, /from: 'training-camp'/);
  assert.match(source, /shift: this\.currentStepIndex\(\) \+ 1/);
  assert.match(source, /drill: this\.currentDrillIndex\(\) \+ 1/);
  assert.match(source, /this\.restoreRequestedLesson\(\)/);
  assert.match(source, /requestedStepIndex > this\.highestUnlockedStepIndex\(\)/);
  assert.match(template, /routerLink="\/scoring"/);
  assert.match(template, /\[queryParams\]="scoringGuideQueryParams\(\)"/);

  assert.match(guideSource, /fromTrainingCamp = queryParams\.get\('from'\) === 'training-camp'/);
  assert.match(guideSource, /\^\[1-5\]\$/);
  assert.match(guideSource, /\^\[1-2\]\$/);
  assert.match(guideTemplate, /Training Camp Paused/);
  assert.match(guideTemplate, /Back to Training Camp/);
  assert.match(guideTemplate, /routerLink="\/training-camp"/);
});

test('Training Camp remains progressive without requiring a quiz', async () => {
  const [source, template, styles] = await Promise.all([
    read('src/app/features/onboarding/training-camp/training-camp.ts'),
    read('src/app/features/onboarding/training-camp/training-camp.html'),
    read('src/app/features/onboarding/training-camp/training-camp.css'),
  ]);

  assert.equal(TRAINING_CAMP_STEPS.length, 5);
  assert.equal(TRAINING_CAMP_TOTAL_DRILLS, 10);
  assert.ok(TRAINING_CAMP_STEPS.every((step) => step.drills.length === 2));
  assert.match(source, /return 'Next Drill'/);
  assert.match(source, /training_camp_shift_cleared/);
  assert.doesNotMatch(source, /selectedAnswerId|answerState|currentChallenge|selectAnswer/);
  assert.doesNotMatch(template, /Coach Challenge|camp-challenge|challenge-feedback/);
  assert.doesNotMatch(styles, /\.camp-challenge|\.challenge-choices|\.challenge-feedback/);
});

test('the schedule example places the missed marker on Game 4', async () => {
  const template = await read('src/app/features/onboarding/training-camp/training-camp.html');
  const strip = template.match(/<div class="demo-game-row"[\s\S]*?<\/div>/)?.[0] ?? '';

  assert.match(strip, /class="played">1/);
  assert.match(strip, /class="played">2/);
  assert.match(strip, /class="played">3/);
  assert.match(strip, /class="missed">4/);
  assert.match(strip, /class="upcoming">5/);
  assert.match(strip, /class="upcoming">6/);
});

test('the global navbar contains only durable destinations and opens no league listeners', async () => {
  const [source, template] = await Promise.all([
    read('src/app/shared/navbar/navbar.ts'),
    read('src/app/shared/navbar/navbar.html'),
  ]);

  for (const label of [
    'Dashboard',
    'Create League',
    'Join League',
    'Scoring Guide',
    'Support',
    'Account',
  ]) {
    assert.match(template, new RegExp(`>${label}<`));
  }

  assert.doesNotMatch(template, /League HQ|My Team|Add \/ Drop|Matchup|Draft Room|Fairness Report|Scoring Calculator/);
  assert.doesNotMatch(source, /listenToFantasyDraft|listenToEarliestUnfinishedOwnerMatchup|getRememberedLastLeagueId/);
  assert.doesNotMatch(source, /PlatformAdminService|RinkRatPwaService/);
});

test('every durable league destination shares one compact-capable navigation surface', async () => {
  const [component, template, styles, team, header, leagueHq, players, matchups, schedule, standings] = await Promise.all([
    read('src/app/shared/league-quick-navigation/league-quick-navigation.ts'),
    read('src/app/shared/league-quick-navigation/league-quick-navigation.html'),
    read('src/app/shared/league-quick-navigation/league-quick-navigation.css'),
    read('src/app/features/team/team-settings/team-settings.html'),
    read('src/app/features/cycles/cycle-one/components/cycle-page-header/cycle-page-header.html'),
    read('src/app/features/leagues/league-detail/league-detail.html'),
    read('src/app/features/free-agents/free-agents.html'),
    read('src/app/features/cycles/matchup-overview/cycle-matchup-overview.html'),
    read('src/app/features/cycles/schedule-preview/cycle-schedule-preview.html'),
    read('src/app/features/leagues/league-standings/league-standings.html'),
  ]);

  assert.match(component, /export type LeagueNavigationDestination/);
  assert.match(component, /currentDestination: LeagueNavigationDestination \| null/);
  assert.match(component, /compact = false/);
  for (const label of [
    'League HQ',
    'Add / Drop Player',
    'My Team',
    'Current Matchup',
    'All Current Matchups',
    'Full Schedule',
    'League Standings',
  ]) {
    assert.match(template, new RegExp(label.replace('/', '\\/')));
  }
  assert.match(styles, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /league-quick-navigation--compact/);
  assert.match(styles, /league-nav-action--current/);

  for (const destinationTemplate of [team, header, leagueHq, players, matchups, schedule, standings]) {
    assert.match(destinationTemplate, /<app-league-quick-navigation/);
  }

  assert.match(team, /currentDestination="team"/);
  assert.match(header, /currentDestination="matchup"/);
  assert.match(header, /\[compact\]="true"/);
  assert.match(leagueHq, /currentDestination="league-hq"/);
  assert.match(players, /currentDestination="players"/);
  assert.match(matchups, /currentDestination="matchups"/);
  assert.match(schedule, /currentDestination="schedule"/);
  assert.match(standings, /currentDestination="standings"/);
});

test('Draft projections load independently and can be retried without reloading the room', async () => {
  const [source, template] = await Promise.all([
    read('src/app/features/draft/draft-room/draft-room.ts'),
    read('src/app/features/draft/draft-room/draft-room.html'),
  ]);

  const loadMethod = source.match(
    /async loadDraftRoom\(\): Promise<void> \{[\s\S]*?\n  \}\n\n  private finishInitialDraftRoomLoading/,
  )?.[0] ?? '';

  assert.match(loadMethod, /this\.finishInitialDraftRoomLoading\(\);/);
  assert.match(loadMethod, /void this\.loadPlayerPool\(\);/);
  assert.doesNotMatch(loadMethod, /await this\.loadPlayerPool\(\)/);
  assert.match(source, /DRAFT_PROJECTION_LOAD_SLOW_DELAY_MILLISECONDS = 4_000/);
  assert.match(source, /projectionLoadSlow = signal\(false\)/);
  assert.match(source, /const requestId = \+\+this\.playerPoolRequestId/);
  assert.match(source, /isPlayerPoolRequestActive\(requestId\)/);
  assert.match(source, /retryPlayerPool\(\): void/);
  assert.match(template, /The Draft Room is ready\. Rankings are still loading\./);
  assert.match(template, /Retry Rankings/);
});

test('B1J changes no protected scoring, projection formula, Rules, or Function authority', async () => {
  assert.equal(await sha256('src/app/core/scoring/scoring-rules.ts'), PROTECTED_SOURCE_HASHES.scoringRules);
  assert.equal(await sha256('src/app/core/scoring/scoring-engine.ts'), PROTECTED_SOURCE_HASHES.scoringEngine);
  assert.equal(await sha256('src/app/core/projection/projection-v11.util.ts'), PROTECTED_SOURCE_HASHES.projectionV11);
  assert.equal(await sha256('firestore.rules'), PROTECTED_SOURCE_HASHES.firestoreRules);
  assert.equal(
    await sha256FunctionsIndexBeforeD1M(),
    // D1M adds only the reviewed getFinalScoreReconciliationPage export; the
    // complete post-L1A Functions index remains byte-for-byte pinned here.
    '5f22b04ebdb3cbb34c95d7cc60c1f3a84cbc6efdf5f90781037160f6fdd46b1d',
  );
});

test('RC65 documentation and synchronized roadmaps point to the B1J gate', async () => {
  const [runtime, productionRuntime, freezeSource, readme, runbook, releaseDoc, rootRoadmap, docsRoadmap] =
    await Promise.all([
      read('src/environments/app-runtime.config.ts'),
      read('src/environments/app-runtime.config.production.ts'),
      read('config/release-freeze/beta-freeze-policy.json'),
      read('README.md'),
      read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
      read('docs/releases/RC65_B1J_TUTORIAL_NAV_DRAFT_READINESS.md'),
      read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
      read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    ]);
  const freeze = JSON.parse(freezeSource);

  assert.match(runtime, /Release Candidate 65/);
  assert.match(productionRuntime, /Release Candidate 65/);
  assert.equal(freeze.releaseLabel, 'Release Candidate 65');
  assert.equal(freeze.verificationCommand, 'npm run verify:batchb1j');
  assert.equal(freeze.defaultTag, 'rinkrat-rc65-invite-beta');
  assert.match(readme, /RC65 \/ B1J/);
  assert.match(runbook, /npm run verify:batchb1j/);
  assert.match(releaseDoc, /Hosting only/);
  assert.equal(rootRoadmap, docsRoadmap);
  assert.match(rootRoadmap, /^RINKRAT COMPETITIVE ROADMAP\nVersion 1\.54\.\d+/);
  assert.match(rootRoadmap, /# \[x\] B1\.39/);
  assert.match(rootRoadmap, /# \[x\] B1\.40/);
  assert.match(rootRoadmap, /# \[x\] B1\.41/);
});
