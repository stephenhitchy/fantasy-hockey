import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const COMPILED_SCORING = mkdtempSync(path.join(tmpdir(), 'rinkrat-o1i-scoring-'));
const SCORING_ROOT = path.join(ROOT_PATH, 'src/app/core/scoring');
const SCORING_TSCONFIG = path.join(COMPILED_SCORING, 'tsconfig.json');

writeFileSync(SCORING_TSCONFIG, JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'Node16',
    moduleResolution: 'Node16',
    strict: true,
    skipLibCheck: true,
    rootDir: SCORING_ROOT,
    outDir: COMPILED_SCORING,
  },
  files: [
    path.join(SCORING_ROOT, 'scoring-rules.ts'),
    path.join(SCORING_ROOT, 'scoring-engine.ts'),
    path.join(SCORING_ROOT, 'public-scoring-calculator.util.ts'),
  ],
}, null, 2));

execFileSync('tsc', ['--project', SCORING_TSCONFIG], { stdio: 'pipe' });
const require = createRequire(import.meta.url);
const {
  calculatePublicGoalieScore,
  calculatePublicSkaterScore,
  DEFENSE_SCORING_PRESETS,
  FORWARD_SCORING_PRESETS,
  GOALIE_SCORING_PRESETS,
} = require(path.join(COMPILED_SCORING, 'public-scoring-calculator.util.js'));

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function luminance(hex) {
  const rgb = hex.match(/[a-f\d]{2}/gi).map((value) => parseInt(value, 16) / 255);
  const linear = rgb.map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(first, second) {
  const [high, low] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
}

test('isolated scoring compiler uses a TypeScript 6 compatible project file', async () => {
  const source = await read('test/batcho1i-public-scoring-calculator/public-scoring-calculator.test.mjs');

  assert.match(source, /writeFileSync\(SCORING_TSCONFIG/);
  assert.match(source, /module:\s*'Node16'/);
  assert.match(source, /moduleResolution:\s*'Node16'/);
  assert.match(source, /execFileSync\('tsc', \['--project', SCORING_TSCONFIG\]/);
  assert.doesNotMatch(source, /execFileSync\('tsc', \[\s*'--target'/);
});

test('public calculator uses exact Production Scoring V4 forward and defense results', () => {
  const forward = calculatePublicSkaterScore('forward', FORWARD_SCORING_PRESETS[0].input);
  const defense = calculatePublicSkaterScore('defense', DEFENSE_SCORING_PRESETS[0].input);

  assert.equal(forward.valid, true);
  assert.equal(forward.breakdown.total, 25.75);
  assert.equal(forward.repeatedSixGameTotal, 154.5);
  assert.match(forward.breakdown.lines.map((line) => line.label).join('\n'), /Game-Winning Goal/);

  assert.equal(defense.valid, true);
  assert.equal(defense.breakdown.total, 22);
  assert.match(defense.breakdown.lines.map((line) => line.label).join('\n'), /Defensive TOI/);
});

test('public goalie presets prove efficiency separation and the uncapped V4 ceiling', () => {
  const efficient = calculatePublicGoalieScore(GOALIE_SCORING_PRESETS[0].input);
  const poor = calculatePublicGoalieScore(GOALIE_SCORING_PRESETS[1].input);
  const shutout = calculatePublicGoalieScore(GOALIE_SCORING_PRESETS[2].input);

  assert.equal(efficient.breakdown.total, 21.6);
  assert.equal(poor.breakdown.total, 2.8);
  assert.equal(shutout.breakdown.total, 32);
  assert.equal(shutout.breakdown.lines.some((line) => /Maximum/.test(line.label)), false);
});

test('calculator rejects impossible scoring inputs instead of inventing a score', () => {
  assert.equal(calculatePublicGoalieScore({ saves: 31, shotsAgainst: 30, won: false, shutout: false }).valid, false);
  assert.equal(calculatePublicGoalieScore({ saves: 29, shotsAgainst: 30, won: true, shutout: true }).valid, false);

  const overtimeWithoutGoal = calculatePublicSkaterScore('forward', {
    goals: 0,
    primaryAssists: 0,
    secondaryAssists: 0,
    shotsOnGoal: 0,
    hits: 0,
    blockedShots: 0,
    plusMinus: 0,
    powerPlayPoints: 0,
    shortHandedPoints: 0,
    gameWinningGoal: true,
    overtimeGoal: true,
    timeOnIceMinutes: 1,
  });
  assert.equal(overtimeWithoutGoal.valid, false);

  const impossibleSpecialTeams = calculatePublicSkaterScore('forward', {
    goals: 1,
    primaryAssists: 0,
    secondaryAssists: 0,
    shotsOnGoal: 1,
    hits: 0,
    blockedShots: 0,
    plusMinus: 0,
    powerPlayPoints: 2,
    shortHandedPoints: 0,
    gameWinningGoal: false,
    overtimeGoal: false,
    timeOnIceMinutes: 1,
  });
  assert.equal(impossibleSpecialTeams.valid, false);
});

test('public calculator route is unauthenticated and uses no server scoring call', async () => {
  const [routes, component, template, styles] = await Promise.all([
    read('src/app/app.routes.ts'),
    read('src/app/features/scoring/scoring-calculator/scoring-calculator.ts'),
    read('src/app/features/scoring/scoring-calculator/scoring-calculator.html'),
    read('src/app/features/scoring/scoring-calculator/scoring-calculator.css'),
  ]);

  assert.ok(routes.indexOf("path: 'scoring-calculator'") < routes.indexOf('canActivate: [authGuard]'));
  assert.match(component, /calculatePublicSkaterScore/);
  assert.match(component, /calculatePublicGoalieScore/);
  assert.doesNotMatch(component, /httpsCallable|AngularFirestore|Firestore|fetch\(/);
  assert.match(template, /Same game repeated six times/);
  assert.match(template, /This is a scale example, not a projection/);
  assert.doesNotMatch(template, /role="dialog"|viewport-overlay|rr-dialog-backdrop|action-sheet/i);
  assert.doesNotMatch(styles, /position:\s*(?:fixed|sticky)/);
  assert.match(styles, /@media \(max-width: 720px\)/);
});

test('Scoring Guide and completed matchup breakdown ignore favorite-team colors', async () => {
  const [guide, cycle] = await Promise.all([
    read('src/app/features/scoring/scoring-guide/scoring-guide.css'),
    read('src/app/features/cycles/cycle-one/cycle-one.css'),
  ]);

  assert.doesNotMatch(guide, /--user-team-(?:primary|secondary|tertiary)/);
  assert.match(guide, /--scoring-guide-accent:\s*#4ca8e8/);
  assert.match(guide, /--scoring-guide-action:\s*#1f6f9f/);
  assert.match(guide, /--scoring-guide-number:\s*var\(--text-primary\)/);

  assert.match(cycle, /--matchup-breakdown-text:\s*#f8fafc/);
  assert.match(cycle, /--matchup-breakdown-muted:\s*#cbd5e1/);
  assert.match(cycle, /--matchup-breakdown-subtle:\s*#9fb0c7/);
  assert.match(cycle, /--matchup-breakdown-positive:\s*#4ade80/);
  assert.match(cycle, /--matchup-breakdown-negative:\s*#fb7185/);
  assert.match(cycle, /--matchup-breakdown-neutral:\s*#facc15/);
});

test('fixed completed-matchup scoring colors clear a strong contrast floor', () => {
  const background = '#0f172a';
  for (const color of ['#f8fafc', '#cbd5e1', '#9fb0c7', '#4ade80', '#fb7185', '#facc15']) {
    assert.ok(contrast(color, background) >= 4.5, `${color} should remain readable on ${background}`);
  }
});

test('Scoring Guide and Fairness Report link to the calculator', async () => {
  const [guide, fairness, support] = await Promise.all([
    read('src/app/features/scoring/scoring-guide/scoring-guide.html'),
    read('src/app/features/support/fairness-report/fairness-report.html'),
    read('src/app/features/support/support-home/support-home.html'),
  ]);
  assert.match(guide, /routerLink="\/scoring-calculator"/);
  assert.match(fairness, /routerLink="\/scoring-calculator"/);
  assert.match(support, /routerLink="\/scoring-calculator"/);
});

test('O1I is Hosting-only and keeps Operations API v1 unchanged', async () => {
  const [compatibility, functionIndex, runtime, productionRuntime] = await Promise.all([
    read('config/operations-api-compatibility.json'),
    read('functions/src/index.ts'),
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
  ]);

  assert.match(compatibility, /"operationsApiVersion":\s*1/);
  assert.match(runtime, /Release Candidate 65/);
  assert.match(productionRuntime, /Release Candidate 65/);
  assert.doesNotMatch(functionIndex, /scoringCalculator|publicScoringCalculator/);
});

test('roadmap and release gate record O1I without rewriting the O1H evidence release', async () => {
  const [roadmap, docsRoadmap, readme, freezeSource, reportSource, packageSource] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('README.md'),
    read('config/release-freeze/beta-freeze-policy.json'),
    read('config/public-fairness-report-source.json'),
    read('package.json'),
  ]);
  const freeze = JSON.parse(freezeSource);
  const report = JSON.parse(reportSource);
  const packageJson = JSON.parse(packageSource);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.54/);
  assert.match(roadmap, /# \[x\] O1\.30 Keep scoring-reference/);
  assert.match(roadmap, /LOG\.73 2026-08-21 — Completed Operations Batch O1I/);
  assert.match(readme, /Release Candidate 65 \/ Beta Batch B1J/);
  assert.equal(freeze.releaseLabel, 'Release Candidate 65');
  assert.equal(freeze.verificationCommand, 'npm run verify:batchb1j');
  assert.equal(freeze.defaultTag, 'rinkrat-rc65-invite-beta');
  assert.equal(report.publishedReleaseLabel, 'Release Candidate 58');
  assert.match(packageJson.scripts['verify:batcho1i:core'], /verify:batcho1h:core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batch(?:b1j|d1j):core/);
});
