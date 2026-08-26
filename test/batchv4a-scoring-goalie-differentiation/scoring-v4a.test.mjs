import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  calculateGoalieGameBreakdown,
  calculateGoalieGamePoints,
  calculateGoalieSaveQualityPoints,
  calculateSkaterGamePoints,
} from '../../src/app/core/scoring/scoring-engine.ts';
import {
  CURRENT_SCORING_RULES_VERSION,
  SCORING_RULES_V3_VERSION,
  defaultScoringRules,
  scoringRulesForVersion,
  scoringRulesV3,
} from '../../src/app/core/scoring/scoring-rules.ts';
import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';

const ROOT = new URL('../../', import.meta.url);
const require = createRequire(import.meta.url);
const {
  classifyScoringV4Migration,
  isProjectionPointerId,
} = require('../../functions/scripts/scoring-v4-migration.util.cjs');

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function forwardStats(overrides = {}) {
  return {
    position: 'F',
    goals: 1,
    primaryAssists: 1,
    secondaryAssists: 1,
    shotsOnGoal: 4,
    hits: 2,
    blockedShots: 1,
    plusMinus: 1,
    powerPlayPoints: 1,
    shortHandedPoints: 0,
    gameWinningGoal: true,
    overtimeGoal: false,
    timeOnIceMinutes: 18,
    ...overrides,
  };
}

function defenseStats(overrides = {}) {
  return {
    position: 'D',
    goals: 1,
    primaryAssists: 1,
    secondaryAssists: 1,
    shotsOnGoal: 3,
    hits: 2,
    blockedShots: 4,
    plusMinus: 2,
    powerPlayPoints: 1,
    shortHandedPoints: 0,
    gameWinningGoal: false,
    overtimeGoal: false,
    timeOnIceMinutes: 25,
    ...overrides,
  };
}

test('Production Scoring V4 changes only the Team Goalie Unit formula', () => {
  assert.equal(SCORING_RULES_V3_VERSION, 3);
  assert.equal(CURRENT_SCORING_RULES_VERSION, 4);

  for (const field of [
    'requiredGamesPerCycle',
    'forward',
    'defense',
    'gameWinningGoal',
    'overtimeGoal',
    'forwardToiMultiplier',
    'defenseToiBaseMultiplier',
    'defenseToiPlusMinusModifier',
    'defenseToiFloor',
    'defenseToiCeiling',
  ]) {
    assert.deepEqual(defaultScoringRules[field], scoringRulesV3[field], field);
  }

  assert.deepEqual({
    gameBase: defaultScoringRules.goalieGameBase,
    save: defaultScoringRules.goalieSave,
    win: defaultScoringRules.goalieWin,
    shutout: defaultScoringRules.goalieShutout,
    baseline: defaultScoringRules.goalieSavePercentageBaseline,
    qualityBase: defaultScoringRules.goalieSavePercentageBasePoints,
    qualitySlope: defaultScoringRules.goalieSavePercentagePointsPerPercentagePoint,
    qualityMinimum: defaultScoringRules.goalieSavePercentageMinimum,
    qualityMaximum: defaultScoringRules.goalieSavePercentageMaximum,
    gameMaximum: defaultScoringRules.goalieGameMaximum,
  }, {
    gameBase: 2,
    save: 0.2,
    win: 5,
    shutout: 5,
    baseline: 0.9,
    qualityBase: 3,
    qualitySlope: 1.8,
    qualityMinimum: -6,
    qualityMaximum: 14,
    gameMaximum: 0,
  });
});

test('LW, C, and RW continue sharing one forward formula without a position-specific modifier', async () => {
  const rulesSource = await read('src/app/core/scoring/scoring-rules.ts');
  const engineSource = await read('src/app/core/scoring/scoring-engine.ts');

  assert.match(engineSource, /stats\.position === 'D'[\s\S]*?rules\.defense[\s\S]*?: rules\.forward/);
  assert.doesNotMatch(rulesSource, /rightWing|leftWing|centerScoring|rwMultiplier|lwMultiplier|centerMultiplier/i);
});

test('V4 skater results remain exactly equal to legacy Production Scoring V3', () => {
  for (const stats of [
    forwardStats(),
    forwardStats({ goals: 3, shotsOnGoal: 7, shortHandedPoints: 1, overtimeGoal: true }),
    forwardStats({ goals: 0, primaryAssists: 0, secondaryAssists: 0, shotsOnGoal: 8 }),
    defenseStats(),
    defenseStats({ goals: 0, primaryAssists: 0, secondaryAssists: 0, plusMinus: -5 }),
    defenseStats({ goals: 0, primaryAssists: 0, secondaryAssists: 0, plusMinus: 6 }),
  ]) {
    assert.equal(
      calculateSkaterGamePoints(stats, defaultScoringRules),
      calculateSkaterGamePoints(stats, scoringRulesV3),
    );
  }
});

test('the V4 save-quality curve is continuous, wider, and bounded', () => {
  assert.equal(calculateGoalieSaveQualityPoints(0.85, defaultScoringRules), -6);
  assert.equal(calculateGoalieSaveQualityPoints(0.9, defaultScoringRules), 3);
  assert.equal(calculateGoalieSaveQualityPoints(0.95, defaultScoringRules), 12);
  assert.equal(calculateGoalieSaveQualityPoints(1, defaultScoringRules), 14);
  assert.equal(calculateGoalieSaveQualityPoints(0.7, defaultScoringRules), -6);
});

test('poor high-volume goaltending no longer receives a safe background score', () => {
  const breakdown = calculateGoalieGameBreakdown({
    saves: 34,
    shotsAgainst: 40,
    won: false,
    shutout: false,
  }, defaultScoringRules);

  assert.equal(breakdown.total, 2.8);
  assert.deepEqual(
    breakdown.lines.map(({ label, points }) => [label, points]),
    [
      ['Completed Team Game', 2],
      ['Saves (34)', 6.8],
      ['Save Quality (85.0%; 90.0% baseline)', -6],
    ],
  );
});

test('efficient low-volume wins remain clearly valuable', () => {
  assert.equal(calculateGoalieGamePoints({
    saves: 19,
    shotsAgainst: 20,
    won: true,
    shutout: false,
  }, defaultScoringRules), 22.8);
});

test('team-goalie-unit aggregation still combines every active goalie before scoring once', async () => {
  const [clientNhl, serverNhl, cycleScoring] = await Promise.all([
    read('src/app/core/nhl/nhl-api.service.ts'),
    read('functions/src/shared/core/nhl/nhl-api.service.ts'),
    read('functions/src/shared/core/cycle/cycle-scoring.service.ts'),
  ]);

  for (const source of [clientNhl, serverNhl]) {
    assert.match(source, /const activeGoalies = \(teamStats\.goalies \?\? \[\]\)\.filter/);
    assert.match(source, /const saves = activeGoalies\.reduce/);
    assert.match(source, /const shotsAgainst = activeGoalies\.reduce/);
    assert.match(source, /goalies: activeGoalies\.map/);
  }
  assert.match(cycleScoring, /const stats: GoalieGameStats = \{[\s\S]*?saves: goalieResult\.saves,[\s\S]*?shotsAgainst: goalieResult\.shotsAgainst/);
  assert.match(cycleScoring, /calculateGoalieGameBreakdown\(stats, scoringRules\)\.total/);
});

test('exceptional V4 goalie games are uncapped while V3 remains reproducible', () => {
  const stats = {
    saves: 50,
    shotsAgainst: 50,
    won: true,
    shutout: true,
  };
  const v4 = calculateGoalieGameBreakdown(stats, defaultScoringRules);
  const v3 = calculateGoalieGameBreakdown(stats, scoringRulesV3);

  assert.equal(v4.total, 36);
  assert.equal(v4.lines.some((line) => line.label.startsWith('Goalie Game Maximum')), false);
  assert.equal(v3.total, 28);
  assert.equal(v3.lines.some((line) => line.label === 'Goalie Game Maximum (28)'), true);
  assert.deepEqual(scoringRulesForVersion(3), scoringRulesV3);
  assert.deepEqual(scoringRulesForVersion(4), defaultScoringRules);
});

test('client and server scoring sources remain byte-for-byte identical', async () => {
  const [clientRules, serverRules, clientEngine, serverEngine] = await Promise.all([
    read('src/app/core/scoring/scoring-rules.ts'),
    read('functions/src/shared/core/scoring/scoring-rules.ts'),
    read('src/app/core/scoring/scoring-engine.ts'),
    read('functions/src/shared/core/scoring/scoring-engine.ts'),
  ]);

  assert.equal(clientRules, serverRules);
  assert.equal(clientEngine, serverEngine);
  assert.equal(sha256(clientRules), PROTECTED_SOURCE_HASHES.scoringRules);
  assert.equal(sha256(clientEngine), PROTECTED_SOURCE_HASHES.scoringEngine);
});

test('Projection V11 and Draft math carry Scoring V4 identity without changing Projection V11', async () => {
  const [projectionV11, hashUtility, serverSnapshot, clientSnapshot, draftPool] = await Promise.all([
    read('src/app/core/projection/projection-v11.util.ts'),
    read('functions/src/shared/core/projection/projection-snapshot-hash.util.ts'),
    read('functions/src/shared/core/projection/projection-snapshot.service.ts'),
    read('src/app/core/projection/projection-snapshot.service.ts'),
    read('functions/src/shared/core/draft/draft-player-pool.service.ts'),
  ]);

  assert.equal(sha256(projectionV11), PROTECTED_SOURCE_HASHES.projectionV11);
  assert.match(hashUtility, /PROJECTION_SNAPSHOT_LEGACY_HASH_SCHEMA_VERSION = 1/);
  assert.match(hashUtility, /PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION = 2/);
  assert.match(hashUtility, /canonical\['scoringRulesVersion'\] = input\.scoringRulesVersion/);
  assert.match(serverSnapshot, /must be migrated to Production Scoring V\$\{CURRENT_SCORING_RULES_VERSION\}/);
  assert.match(serverSnapshot, /before emergency Projection V\$\{SHARED_PROJECTION_VERSION\} rankings can be generated/);
  assert.match(clientSnapshot, /metadata\.scoringRulesVersion !== CURRENT_SCORING_RULES_VERSION/);
  assert.match(draftPool, /uncapped Production Scoring V4 save quality, wins, and shutouts/);
  assert.doesNotMatch(draftPool, /Math\.min\([^\n]*goalieGameMaximum/);
});

test('the Scoring Guide, test lab, and calibration expose V4 and legacy V3 honestly', async () => {
  const [guide, guideTemplate, scoringTest, calibration, goalieLab] = await Promise.all([
    read('src/app/features/scoring/scoring-guide/scoring-guide.ts'),
    read('src/app/features/scoring/scoring-guide/scoring-guide.html'),
    read('src/app/features/scoring-test/scoring-test.html'),
    read('src/app/core/scoring/historical-scoring-calibration.service.ts'),
    read('src/app/features/scoring-test/team-goalie-lab/team-goalie-lab.ts'),
  ]);

  assert.match(guide, /Maximum per NHL game/);
  assert.match(guide, /'No cap'/);
  assert.match(guide, /goaliePoorEfficiencyExample/);
  assert.match(guide, /goalieEliteEfficiencyExample/);
  assert.match(guideTemplate, /Save percentage/);
  assert.match(scoringTest, /uncapped Production Scoring V4/);
  assert.match(calibration, /current-v4/);
  assert.match(calibration, /legacy-v3/);
  assert.match(calibration, /Legacy goalie-cap removal/);
  assert.match(goalieLab, /calculateGoalieGameBreakdown/);
});

test('league creation, authority repair, scoring, Draft readiness, and projection integrity are version-aligned', async () => {
  const [lifecycle, automation, draftAuthority, draftAutomation, projectionAuthority] = await Promise.all([
    read('functions/src/league-lifecycle-authority.ts'),
    read('functions/src/league-automation.ts'),
    read('functions/src/draft-authority.ts'),
    read('functions/src/draft-automation.ts'),
    read('functions/src/projection-authority.ts'),
  ]);

  assert.match(lifecycle, /scoringRulesVersion: CURRENT_SCORING_RULES_VERSION/);
  assert.match(lifecycle, /Authority-schema repair must never double as a scoring migration/);
  assert.match(lifecycle, /const scoringRulesVersion = storedScoringVersion >= CURRENT_SCORING_RULES_VERSION/);
  assert.match(lifecycle, /: SCORING_RULES_V3_VERSION;/);
  assert.match(lifecycle, /const scoringRules = scoringRulesForVersion\(scoringRulesVersion\)/);
  assert.match(automation, /scoringRulesForVersion\(version\)/);
  assert.match(automation, /V3 leagues remain V3 until the guarded preseason V4 migration/);
  assert.match(draftAuthority, /expectedScoringRulesVersion/);
  assert.match(draftAutomation, /metadata\.scoringRulesVersion === expectedScoringRulesVersion/);
  assert.match(projectionAuthority, /metadata\.scoringRulesVersion === expectedScoringRulesVersion/);
});

test('migration, inspection, and preseason rollback are guarded and never rewrite competition history', async () => {
  const [migration, helper, inspection, rollback, packageSource] = await Promise.all([
    read('functions/scripts/scoring-v4-migrate.cjs'),
    read('functions/scripts/scoring-v4-migration.util.cjs'),
    read('functions/scripts/scoring-v4-inspect.cjs'),
    read('functions/scripts/scoring-v4-rollback.cjs'),
    read('package.json'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.match(migration, /RINKRAT_APPLY_SCORING_V4/);
  assert.match(migration, /RINKRAT_ALLOW_MIXED_SCORING_HISTORY/);
  assert.match(migration, /ALLOW_TEST_LEAGUE_ONLY/);
  assert.match(migration, /classifyScoringV4Migration/);
  assert.match(migration, /--eligible-only/);
  assert.match(migration, /will skip .* blocked league/);
  assert.match(migration, /projectionPointerRefs/);
  assert.match(migration, /immutableCompletedWindowsRewritten: false/);
  assert.match(migration, /projectionAssetsRewritten: false/);
  assert.match(helper, /competition-cycle-history/);
  assert.match(helper, /draft-picks-exist/);
  assert.match(helper, /draft-status-live/);
  assert.doesNotMatch(migration, /writer\.(?:set|update|delete)\(\s*db\.(?:doc|collection)\(`leagues\/\$\{[^}]+\}\/cycles/);
  assert.match(inspection, /--allow-legacy-history/);
  assert.match(inspection, /Preserved V3 leagues with competition history/);
  assert.match(inspection, /Inspection only\. No league, score, cycle, window, standing, roster, Draft, transaction, waiver, or projection was changed/);
  assert.match(rollback, /ROLLBACK_PRESEASON_ONLY/);
  assert.match(rollback, /blocked once any competition cycle exists/);
  assert.match(rollback, /projectionPointerRefs/);
  assert.match(rollback, /immutableCompletedWindowsRewritten: false/);
  assert.match(rollback, /projectionAssetsRewritten: false/);
  assert.match(packageJson.scripts['scoring:v4:migrate'], /scoring-v4-migrate/);
  assert.match(packageJson.scripts['scoring:v4:inspect'], /scoring-v4-inspect/);
  assert.match(packageJson.scripts['scoring:v4:rollback'], /scoring-v4-rollback/);
  assert.match(packageJson.scripts['scoring:audit-v4'], /audit-scoring-v4/);
  assert.match(packageJson.scripts['beta:audit-season-plan'], /audit-private-season-plan/);
});

test('the migration classifier permits only deliberate preseason or exact disposable-test transitions', () => {
  assert.deepEqual(classifyScoringV4Migration({
    alreadyV4: false,
    cycleCount: 0,
    completedCycleCount: 0,
    pickCount: 0,
    draftStatus: 'scheduled',
    allowMixedHistory: false,
  }).blockers, []);

  assert.deepEqual(classifyScoringV4Migration({
    alreadyV4: false,
    cycleCount: 1,
    completedCycleCount: 1,
    pickCount: 3,
    draftStatus: 'complete',
    allowMixedHistory: false,
  }).blockers, [
    'competition-cycle-history',
    'completed-cycle-history',
    'draft-picks-exist',
    'draft-status-complete',
  ]);

  assert.deepEqual(classifyScoringV4Migration({
    alreadyV4: false,
    cycleCount: 3,
    completedCycleCount: 2,
    pickCount: 90,
    draftStatus: 'complete',
    allowMixedHistory: true,
  }).blockers, []);

  assert.deepEqual(classifyScoringV4Migration({
    alreadyV4: false,
    cycleCount: 0,
    completedCycleCount: 0,
    pickCount: 0,
    draftStatus: 'live',
    allowMixedHistory: true,
  }).blockers, ['draft-status-live']);

  assert.equal(isProjectionPointerId('current'), true);
  assert.equal(isProjectionPointerId('target-cycle-12'), true);
  assert.equal(isProjectionPointerId('snapshot-immutable'), false);
});

test('source-controlled scoring and private-season acceptance gates match the audited release plan', async () => {
  const [scoringSource, seasonSource, scoringAudit, seasonAudit] = await Promise.all([
    read('config/scoring-v4-acceptance.json'),
    read('config/private-season-launch-gates.json'),
    read('scripts/scoring/audit-scoring-v4.mjs'),
    read('scripts/release/audit-private-season-plan.mjs'),
  ]);
  const scoring = JSON.parse(scoringSource);
  const season = JSON.parse(seasonSource);

  assert.equal(scoring.scoringRulesVersion, 4);
  assert.equal(scoring.projectionVersion, 11);
  assert.equal(scoring.formula.skaterRulesChangedFromV3, false);
  assert.equal(scoring.formula.goalieGameMaximum, 0);
  assert.deepEqual(scoring.protectedInvariants, [
    'six-team-games-per-roster-slot-window',
    'seventh-game-rollover',
    'completed-window-immutability',
    'server-authoritative-scoring',
    'frozen-window-projections',
    'queued-boundary-roster-moves',
    'multiple-active-slot-cycles',
    'no-duplicate-game-scoring',
    'client-server-scoring-parity',
  ]);
  assert.equal(season.greenThresholds.confirmedCoreActionReliabilityPercentMinimum, 99.5);
  assert.equal(season.greenThresholds.fourWeekLeagueRetentionPercentMinimum, 70);
  assert.equal(season.greenThresholds.stagedClientLoadTestMinimum, 5000);
  assert.deepEqual(season.controlledActivatedLeagueWaves, [5, 10, 25, 50, 100]);
  assert.match(scoringAudit, /Audit only/);
  assert.match(seasonAudit, /Audit only/);
});

test('the six-game window remains frozen and server scoring matches the D1G shadow-parity baseline', async () => {
  const [serverSelection, clientSelection, serverScoring] = await Promise.all([
    read('functions/src/shared/core/cycle/cycle-window-selection.util.ts'),
    read('src/app/core/cycle/cycle-window-selection.util.ts'),
    read('functions/src/shared/core/cycle/cycle-scoring.service.ts'),
  ]);

  assert.equal(serverSelection, clientSelection);
  assert.equal(sha256(serverSelection), 'fbd0683f7dda81406248921545a3dfaa8e247818b06366e821763615e7eb063c');
  assert.equal(sha256(serverScoring), '9c20a12fbcdd148fcd2e2a926aad4869830f7191d81ad8eec19dcb878648c83e');
});

test('RC51 release identity and inherited safety controls are preserved', async () => {
  const [rules, indexes, runtime, productionRuntime, freezeSource, manifestSource, appCheckSource, canarySource, cacheSource, worker] = await Promise.all([
    read('firestore.rules'),
    read('firestore.indexes.json'),
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('config/release-freeze/beta-freeze-policy.json'),
    read('public/release-manifest.json'),
    read('config/app-check-enforcement-readiness.json'),
    read('config/app-check-callable-canary.json'),
    read('config/nhl-shared-cache-policy.json'),
    read('public/rinkrat-sw.js'),
  ]);
  const freeze = JSON.parse(freezeSource);
  const manifest = JSON.parse(manifestSource);
  const appCheck = JSON.parse(appCheckSource);
  const canary = JSON.parse(canarySource);
  const cache = JSON.parse(cacheSource);

  assert.equal(sha256(rules), PROTECTED_SOURCE_HASHES.firestoreRules);
  assert.equal(sha256(indexes), PROTECTED_SOURCE_HASHES.firestoreIndexes);
  assert.match(runtime, /Release Candidate 65/);
  assert.match(productionRuntime, /Release Candidate 65/);
  assert.equal(freeze.scoringRulesVersion, 4);
  assert.equal(freeze.projectionVersion, 11);
  assert.equal(freeze.requiredGamesPerRosterSlot, 6);
  assert.equal(freeze.queueMode, 'shadow');
  assert.equal(freeze.appCheckMode, 'monitor');
  assert.equal(freeze.verificationCommand, 'npm run verify:batchb1j');
  assert.equal(freeze.defaultTag, 'rinkrat-rc65-invite-beta');
  assert.equal(manifest.scoringRulesVersion, 4);
  assert.equal(manifest.projectionVersion, 11);
  assert.equal(appCheck.mode, 'monitor');
  assert.equal(canary.automaticPromotion, false);
  assert.equal(cache.mode, 'shadow');
  assert.equal(cache.authoritativeReadsEnabled, false);
  assert.match(worker, /RINKRAT_CACHE_VERSION = 'rc55-v1'/);
});

test('the permanent roadmap converts the launch gameplan into explicit product and operating gates', async () => {
  const [roadmap, docsRoadmap, scoringDoc, operationsDoc, releaseRunbook, readme] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_SCORING_V4_GOALIE_DIFFERENTIATION.md'),
    read('docs/RINKRAT_OPERATIONS_O1_TESTER_SEASON_PUBLIC_LAUNCH.md'),
    read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
    read('README.md'),
  ]);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.54/);
  assert.match(roadmap, /# \[x\] D1\.20/);
  assert.match(roadmap, /\[~\] D1\.23/);
  assert.match(roadmap, /\[ \] D1\.24/);
  assert.match(roadmap, /# \[x\] D1\.26/);
  assert.match(roadmap, /\[~\] D1\.27/);
  assert.match(roadmap, /# \[x\] D1\.28/);
  assert.match(roadmap, /PHASE O1 — TESTER-SEASON OPERATIONS AND PUBLIC-LAUNCH FOUNDATION/);
  for (const [milestone, date] of [
    ['O1.M1', '2026-09-27'],
    ['O1.M2', '2026-10-31'],
    ['O1.M3', '2027-04-30'],
    ['O1.M4', '2027-07-15'],
    ['O1.M5', '2027-09-21'],
  ]) {
    assert.match(roadmap, new RegExp(`${milestone} ${date}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  for (const requirement of [
    '2–4 leagues',
    '99.5%',
    'four-week retention',
    'Founding Commissioner Program',
    '5,000-client',
    'WCAG 2.2',
    '5 → 10 → 25 → 50 → 100',
    '18+',
  ]) {
    assert.match(roadmap, new RegExp(requirement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(scoringDoc, /No final cap is applied/);
  assert.match(scoringDoc, /poor unit/i);
  assert.match(operationsDoc, /activated league/i);
  assert.match(operationsDoc, /support/i);
  assert.match(releaseRunbook, /Production Scoring V4 preseason cutover prerequisite/);
  assert.match(releaseRunbook, /scoring:v4:rollback/);
  assert.match(releaseRunbook, /--eligible-only/);
  assert.match(releaseRunbook, /--allow-legacy-history/);
  assert.match(readme, /Scoring Batch V4A/);
});

test('League HQ imports the current scoring version used by verified Draft snapshot fallback', async () => {
  const source = await read('src/app/features/leagues/league-detail/league-detail.ts');

  assert.match(
    source,
    /import \{ CURRENT_SCORING_RULES_VERSION \} from '\.\.\/\.\.\/\.\.\/core\/scoring\/scoring-rules';/,
  );
  assert.match(
    source,
    /metadata\.scoringRulesVersion ===\s*\(this\.league\(\)\?\.scoringRulesVersion \?\? CURRENT_SCORING_RULES_VERSION\)/,
  );
});
