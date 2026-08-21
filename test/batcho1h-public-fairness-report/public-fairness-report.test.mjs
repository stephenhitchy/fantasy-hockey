import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  fairnessCheckStatusLabel,
  fairnessEvidenceLabel,
  formatFairnessMetric,
  isPublicFairnessReport,
} from '../../src/app/core/fairness/public-fairness-report.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

async function readJson(relativePath) {
  return JSON.parse(await read(relativePath));
}

test('public fairness evidence uses the exact six-game boundary and no private league data', async () => {
  const report = await readJson('public/data/rinkrat-fairness-report-v1.json');

  assert.equal(isPublicFairnessReport(report), true);
  assert.equal(report.opportunityDesign.scheduledGamesPerActiveSlot, 6);
  assert.equal(report.opportunityDesign.seventhGameRollsOver, true);
  assert.equal(report.opportunityDesign.independentRosterSlotWindows, true);
  assert.equal(report.opportunityDesign.completedWindowsImmutable, true);
  assert.equal(report.opportunityDesign.serverAuthoritativeScoring, true);
  assert.match(report.methodology.windowRule, /Games 1-6/);
  assert.match(report.methodology.windowRule, /game 7 begins the next window/);

  const serialized = JSON.stringify(report).toLowerCase();
  for (const forbidden of [
    'emailaddress',
    'phonenumber',
    'invitecode',
    'rawuserid',
    'rosterpayload',
    'waiverchoice',
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('historical methodology and limitations remain explicit instead of overstating modern proof', async () => {
  const report = await readJson('public/data/rinkrat-fairness-report-v1.json');

  assert.deepEqual(report.methodology.seasons, [
    '2013-14',
    '2014-15',
    '2015-16',
    '2016-17',
    '2017-18',
  ]);
  assert.equal(report.methodology.playoffsIncluded, false);
  assert.equal(report.methodology.regularSeasonGames, 6191);
  assert.equal(report.methodology.completeSkaterSixGameWindows, 38623);
  assert.equal(report.methodology.completeGoalieSixGameWindows, 1963);
  assert.equal(report.methodology.simulatedMatchups, 390000);
  assert.match(report.methodology.limitations.join(' '), /modern NHL scoring environment/i);
  assert.match(report.methodology.limitations.join(' '), /primary and secondary assists were reconstructed/i);
  assert.match(report.methodology.limitations.join(' '), /V4 goalie distributions.*estimates/i);
  assert.match(report.methodology.limitations.join(' '), /modern-season exact-data replication remains an open acceptance gate/i);
});

test('position and matchup findings preserve intended roles without claiming equal averages', async () => {
  const report = await readJson('public/data/rinkrat-fairness-report-v1.json');
  const positions = new Map(report.positionProfiles.map((profile) => [profile.position, profile]));

  assert.equal(positions.size, 5);
  assert.equal(positions.get('LW').meanSixGamePoints, 43.1);
  assert.equal(positions.get('RW').meanSixGamePoints, 43.2);
  assert.ok(positions.get('D').coefficientOfVariation < positions.get('LW').coefficientOfVariation);
  assert.ok(positions.get('G').meanSixGamePoints > positions.get('D').meanSixGamePoints);
  assert.equal(positions.get('G').evidenceType, 'production-v4-sensitivity-estimate');
  assert.equal(report.leagueSimulation.projectedUnderdogWinPercent, 37.5);
  assert.equal(report.leagueSimulation.closeMatchupPercentWithin25, 23.4);
  assert.equal(report.leagueSimulation.blowoutPercentAtLeast150, 7.7);
  assert.equal(report.leagueSimulation.topProjectedRosterTopFourPercent, 83);
});

test('archetype findings distinguish passes, monitoring, and open evidence', async () => {
  const report = await readJson('public/data/rinkrat-fairness-report-v1.json');
  const checks = new Map(report.archetypeChecks.map((check) => [check.id, check]));

  assert.equal(checks.get('hit-only-forward').status, 'pass');
  assert.equal(checks.get('toi-only-defense').status, 'pass-with-monitoring');
  assert.equal(checks.get('goalie-draft-wave').status, 'monitor');
  assert.equal(checks.get('modern-season-replication').status, 'open');
  assert.equal(fairnessCheckStatusLabel('pass'), 'Passed');
  assert.equal(fairnessCheckStatusLabel('monitor'), 'Monitor');
});

test('formatting helpers keep public metrics readable and evidence labels honest', () => {
  assert.equal(formatFairnessMetric({
    id: 'games',
    label: 'Games',
    value: 6,
    unit: 'games',
    evidenceType: 'production-rule',
  }), '6');
  assert.equal(formatFairnessMetric({
    id: 'rate',
    label: 'Rate',
    value: 37.5,
    unit: 'percent',
    evidenceType: 'v4-sensitivity-estimate',
  }), '37.5%');
  assert.equal(fairnessEvidenceLabel('production-rule'), 'Production rule');
  assert.equal(fairnessEvidenceLabel('production-v4-sensitivity-estimate'), 'Scoring V4 model estimate');
});

test('public JSON and CSV are reproducible source-controlled exports', async () => {
  const [source, json, csv, generator] = await Promise.all([
    readJson('config/public-fairness-report-source.json'),
    readJson('public/data/rinkrat-fairness-report-v1.json'),
    read('public/data/rinkrat-fairness-report-v1.csv'),
    read('scripts/fairness/generate-public-fairness-assets.mjs'),
  ]);

  assert.equal(source.reportId, json.reportId);
  assert.match(json.evidenceFingerprint, /^[a-f0-9]{64}$/);
  assert.match(csv, /^"section","metric_id","label","value","unit","evidence_type","notes"/);
  assert.match(csv, /"position","G-mean"/);
  assert.match(csv, /"archetype","goalie-draft-wave"/);
  assert.match(generator, /--check/);
  assert.match(generator, /Public fairness JSON is stale/);
  assert.match(generator, /Public fairness CSV is stale/);
});

test('Fairness Report and public Scoring Guide are available without the auth guard', async () => {
  const routes = await read('src/app/app.routes.ts');

  const fairnessIndex = routes.indexOf("path: 'fairness'");
  const scoringGuideIndex = routes.indexOf("path: 'scoring-guide'");
  const authShellIndex = routes.indexOf('canActivate: [authGuard]');

  assert.ok(fairnessIndex > 0 && fairnessIndex < authShellIndex);
  assert.ok(scoringGuideIndex > 0 && scoringGuideIndex < authShellIndex);
  assert.match(routes, /module\.FairnessReportPage/);
  assert.match(routes, /module\.ScoringGuide/);
});

test('public navigation exposes fairness and scoring without adding an overlay', async () => {
  const [template, styles, support, mainLayout, auth, commissioner, scoringGuide, designFoundation] = await Promise.all([
    read('src/app/features/support/fairness-report/fairness-report.html'),
    read('src/app/features/support/fairness-report/fairness-report.css'),
    read('src/app/features/support/support-home/support-home.html'),
    read('src/app/layouts/main-layout/main-layout.html'),
    read('src/app/features/auth/auth.html'),
    read('src/app/features/support/commissioner-guide/commissioner-guide.html'),
    read('src/app/features/scoring/scoring-guide/scoring-guide.html'),
    read('test/design-system/design-system-foundation.test.mjs'),
  ]);

  assert.match(template, /Public methodology/);
  assert.match(template, /Download JSON/);
  assert.match(template, /Download CSV/);
  assert.match(template, /Important evidence limits/);
  assert.match(support, /routerLink="\/fairness"/);
  assert.match(mainLayout, /routerLink="\/fairness"/);
  assert.match(auth, /routerLink="\/fairness"/);
  assert.match(commissioner, /routerLink="\/fairness"/);
  assert.match(scoringGuide, /routerLink="\/fairness"/);
  assert.match(designFoundation, /support\/fairness-report\/fairness-report\.html/);
  assert.doesNotMatch(template, /role="dialog"|viewport-overlay|rr-dialog-backdrop|action-sheet/i);
  assert.doesNotMatch(styles, /position:\s*(?:fixed|sticky)/);
  assert.match(styles, /@media \(max-width: 640px\)/);
});

test('O1H is browser-only and keeps Operations API v1 compatible with Hosting-only releases', async () => {
  const [policy, compatibility, runtime, productionRuntime, scoringRules, projection] = await Promise.all([
    readJson('config/operations-api-compatibility.json'),
    read('functions/src/shared/core/operations/operations-client-compatibility.util.ts'),
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/projection/projection-v11.util.ts'),
  ]);

  assert.equal(policy.operationsApiVersion, 1);
  assert.equal(policy.policy.browserOnlyReleaseRequiresOperationsFunctionRedeploy, false);
  assert.match(compatibility, /OPERATIONS_API_VERSION\s*=\s*1/);
  assert.match(runtime, /Release Candidate 59/);
  assert.match(productionRuntime, /Release Candidate 59/);
  assert.match(scoringRules, /CURRENT_SCORING_RULES_VERSION\s*=\s*4/);
  assert.match(projection, /PROJECTION_MODEL_VERSION\s*=\s*11/);
});

test('O1H release records complete the public fairness baseline and retain modern-data follow-up', async () => {
  const [roadmap, docsRoadmap, readme, packageSource, freeze, report] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('README.md'),
    read('package.json'),
    readJson('config/release-freeze/beta-freeze-policy.json'),
    readJson('public/data/rinkrat-fairness-report-v1.json'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.50/);
  assert.match(roadmap, /# \[x\] O1\.20 Add a public RinkRat Fairness Report/);
  assert.match(roadmap, /D1\.22 Repeat the complete six-game scoring audit/);
  assert.match(roadmap, /LOG\.72 2026-08-21 — Completed Operations Batch O1H/);
  assert.match(readme, /Release Candidate 59 \/ Operations Batch O1I/);
  assert.equal(freeze.verificationCommand, 'npm run verify:batcho1i');
  assert.equal(freeze.defaultTag, 'rinkrat-rc59-invite-beta');
  assert.equal(report.releaseLabel, 'Release Candidate 58');
  assert.match(packageJson.scripts['verify:batcho1h:core'], /fairness:verify-report/);
  assert.match(packageJson.scripts['verify:batcho1i:core'], /verify:batcho1h:core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batcho1i:core/);
});
