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

test('navigation history treats Angular’s optional navigation trigger as imperative when absent', async () => {
  const source = await read('src/app/core/navigation/navigation-history.service.ts');

  assert.match(
    source,
    /this\.navigationTrigger = event\.navigationTrigger \?\? 'imperative';/,
  );
  assert.doesNotMatch(
    source,
    /this\.navigationTrigger = event\.navigationTrigger;/,
    'Angular 22 exposes NavigationStart.navigationTrigger as optional, so direct assignment breaks strict builds',
  );
});

test('Training Camp teaches five shifts through ten focused drills', () => {
  assert.equal(TRAINING_CAMP_STEPS.length, 5);
  assert.equal(TRAINING_CAMP_TOTAL_DRILLS, 10);

  for (const [index, step] of TRAINING_CAMP_STEPS.entries()) {
    assert.equal(step.number, String(index + 1));
    assert.equal(step.drills.length, 2);
    assert.ok(step.drills.every((drill) => drill.title && drill.body && drill.coachNote));
  }

  const cycleStep = TRAINING_CAMP_STEPS[0];
  assert.match(cycleStep.drills[0].body, /Each active player gets six NHL games/i);
  assert.match(cycleStep.drills[0].body, /make that player’s score for the matchup/i);
  assert.match(cycleStep.drills[1].title, /Game 7 starts the next matchup/i);
  assert.match(cycleStep.drills[1].coachNote, /every player still counts exactly six games/i);
});

test('the page reveals one drill at a time and unlocks later shifts through natural progress', async () => {
  const [source, template, styles] = await Promise.all([
    read('src/app/features/onboarding/training-camp/training-camp.ts'),
    read('src/app/features/onboarding/training-camp/training-camp.html'),
    read('src/app/features/onboarding/training-camp/training-camp.css'),
  ]);

  assert.match(source, /currentDrillIndex = signal\(0\)/);
  assert.match(source, /highestUnlockedStepIndex = signal\(0\)/);
  assert.match(source, /sessionStorage\.setItem\(this\.progressStorageKey\(\)/);
  assert.match(source, /training_camp_shift_cleared/);
  assert.match(source, /readonly canAdvance = computed\(\(\) => !this\.saving\(\)\)/);

  assert.match(template, /Five shifts\. Two quick drills each\./);
  assert.match(template, /One idea appears at a time/);
  assert.match(template, /@switch \(currentDrill\(\)\.id\)/);
  assert.match(template, /\[disabled\]="!canOpenStep\(index\) \|\| saving\(\)"/);
  assert.match(source, /return 'Next Drill'/);
  assert.doesNotMatch(template, /@for \(drill of currentStep\(\)\.drills/);
  assert.doesNotMatch(template, /Coach Challenge|camp-challenge/);
  assert.doesNotMatch(source, /answerState|selectedAnswerId|training_camp_challenge_answered/);

  assert.match(styles, /@keyframes camp-drill-enter/);
  assert.match(styles, /\.camp-step-tabs button\.locked/);
  assert.match(styles, /\.camp-step-tabs button\.cleared/);
});

test('completion, deferral, verification, and invite continuation authority remain intact', async () => {
  const [source, template] = await Promise.all([
    read('src/app/features/onboarding/training-camp/training-camp.ts'),
    read('src/app/features/onboarding/training-camp/training-camp.html'),
  ]);

  assert.match(source, /completeTrainingCamp\(this\.userId\)/);
  assert.match(source, /deferTrainingCamp\(this\.userId\)/);
  assert.match(source, /markPendingLeagueInviteTrainingCampComplete/);
  assert.match(source, /requestVerificationEmail\(\)/);
  assert.match(source, /getVerificationEmailState\(\)/);
  assert.match(source, /hasResolvedTrainingCampOnboarding/);
  assert.match(source, /continueAfterTrainingCamp/);
  assert.match(source, /return 'Finish Later'/);
  assert.doesNotMatch(template, /Later &amp; Verify/);
  assert.match(template, /I Verified — Continue/);
  assert.match(template, /verificationSendButtonLabel\(\)/);
  assert.match(template, /Click to send the first verification email/);
});

test('hockey definitions allow only one panel and stay inside the viewport', async () => {
  const [coordinator, source, template, styles, campStyles] = await Promise.all([
    read('src/app/shared/hockey-terms/hockey-term-popover-coordinator.service.ts'),
    read('src/app/shared/hockey-terms/hockey-term-chip.ts'),
    read('src/app/shared/hockey-terms/hockey-term-chip.html'),
    read('src/app/shared/hockey-terms/hockey-term-chip.css'),
    read('src/app/features/onboarding/training-camp/training-camp.css'),
  ]);

  assert.match(coordinator, /activePanelIdState = signal<string \| null>\(null\)/);
  assert.match(coordinator, /toggle\(panelId: string\): boolean/);
  assert.match(source, /computed\(\(\) => this\.coordinator\.activePanelId\(\) === this\.panelId\)/);
  assert.match(source, /HostListener\('document:pointerdown'/);
  assert.match(source, /HostListener\('document:keydown\.escape'\)/);
  assert.match(source, /Math\.min\(320, viewportWidth - viewportMargin \* 2\)/);
  assert.match(source, /availableBelow/);
  assert.match(source, /availableAbove/);
  assert.match(source, /panel\.scrollHeight/);

  assert.match(template, /#termPanel/);
  assert.match(template, /\[style\.max-height\.px\]/);
  assert.match(template, /\[class\.positioned\]="panelPosition\(\)"/);
  assert.match(styles, /\.hockey-term-popover\s*\{[\s\S]*position:\s*fixed;/);
  assert.match(styles, /overflow:\s*auto;/);
  assert.match(styles, /z-index:\s*1000;/);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*bottom:/);
  assert.match(campStyles, /\.camp-lesson-card\s*\{[\s\S]*overflow:\s*visible;/);
});

test('the fantasy-football comparison stays available without overwhelming the first view', async () => {
  const template = await read('src/app/features/onboarding/training-camp/training-camp.html');

  assert.match(template, /<details class="football-comparison-guide">/);
  assert.doesNotMatch(template, /<details class="football-comparison-guide" open>/);
  assert.match(template, /Know fantasy football\?/);
  assert.match(template, /Open the WR · RB · QB comparison/);
  assert.match(template, /not an exact point-for-point comparison/i);
  assert.match(template, /Positional value reminder/);
  assert.match(template, /alternatives at the same position/i);
  assert.equal(TRAINING_CAMP_STEPS[1].id, 'roster');
});

test('Training Camp numbers use the readable UI typeface', async () => {
  const styles = await read('src/app/features/onboarding/training-camp/training-camp.css');

  assert.match(
    styles,
    /\.camp-progress-copy,[\s\S]*\.six-game-strip span,[\s\S]*\.player-metrics strong,[\s\S]*font-family:\s*var\(--rr-font-ui/,
  );
  assert.match(styles, /font-variant-numeric:\s*tabular-nums/);
});

test('B1I preserves scoring, projections, rules, and server authority', async () => {
  assert.equal(
    await sha256('src/app/core/scoring/scoring-rules.ts'),
    PROTECTED_SOURCE_HASHES.scoringRules,
  );
  assert.equal(
    await sha256('src/app/core/scoring/scoring-engine.ts'),
    PROTECTED_SOURCE_HASHES.scoringEngine,
  );
  assert.equal(
    await sha256('src/app/core/projection/projection-v11.util.ts'),
    PROTECTED_SOURCE_HASHES.projectionV11,
  );
  assert.equal(
    await sha256('firestore.rules'),
    PROTECTED_SOURCE_HASHES.firestoreRules,
  );
  assert.equal(
    await sha256('functions/src/index.ts'),
    '9d6ef3cb9e2bcc9426e8d1aedd0c17e9b71508cc7395ba660c1d286c807f14fc',
  );
});

test('B1I safeguards remain documented under the current RC65 release', async () => {
  const [
    packageSource,
    runtime,
    productionRuntime,
    freezeSource,
    readme,
    runbook,
    batchDocumentation,
    rootRoadmap,
    docsRoadmap,
  ] = await Promise.all([
    read('package.json'),
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('config/release-freeze/beta-freeze-policy.json'),
    read('README.md'),
    read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
    read('docs/RINKRAT_BETA_B1I_PROGRESSIVE_TRAINING_CAMP.md'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
  ]);
  const packageJson = JSON.parse(packageSource);
  const freeze = JSON.parse(freezeSource);

  assert.equal(
    packageJson.scripts['test:batchb1i:run'],
    'node --no-warnings --experimental-strip-types --test --test-concurrency=1 test/batchb1i-progressive-training-camp/*.test.mjs',
  );
  assert.match(packageJson.scripts['verify:batchb1i:core'], /verify:batchb1h:core/);
  assert.match(packageJson.scripts['verify:batchb1i'], /toolchain:verify/);
  assert.match(packageJson.scripts['security:ci'], /verify:batch(?:b1j|d1j):core/);
  assert.match(runtime, /Release Candidate 65/);
  assert.match(productionRuntime, /Release Candidate 65/);
  assert.equal(freeze.releaseLabel, 'Release Candidate 65');
  assert.equal(freeze.verificationCommand, 'npm run verify:batchb1j');
  assert.equal(freeze.defaultTag, 'rinkrat-rc65-invite-beta');
  assert.match(readme, /Release Candidate 65 \/ Beta Batch B1J/);
  assert.match(runbook, /firebase deploy --only hosting:app/);
  assert.match(batchDocumentation, /one focused drill at a time/i);
  assert.equal(rootRoadmap, docsRoadmap);
  assert.match(rootRoadmap, /Version 1\.54\.\d+/);
  assert.match(rootRoadmap, /# \[x\] B1\.35/);
  assert.match(rootRoadmap, /# \[x\] B1\.36/);
  assert.match(rootRoadmap, /# \[x\] LOG\.80/);
});
