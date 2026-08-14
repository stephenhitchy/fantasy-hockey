import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import {
  buildRegularSeasonRoundRecapLeagueActivity,
  getLeagueActivityDocumentId,
} from '../../functions/src/shared/core/league/league-activity.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function completedMatchup(overrides = {}) {
  return {
    id: 'private-matchup-id',
    cycleNumber: 9,
    phase: 'regular_season',
    teamAOwnerId: 'owner-a',
    teamBOwnerId: 'owner-b',
    teamAScore: 44.25,
    teamBScore: 41.75,
    winnerOwnerId: 'owner-a',
    status: 'complete',
    teamASeed: 1,
    teamBSeed: 4,
    playerScoreLedger: { private: true },
    ...overrides,
  };
}

function eligibleRound() {
  return [
    completedMatchup(),
    completedMatchup({
      id: 'private-matchup-c-d',
      teamAOwnerId: 'owner-c',
      teamBOwnerId: 'owner-d',
      teamAScore: 52.1,
      teamBScore: 39.4,
      winnerOwnerId: 'owner-c',
    }),
    completedMatchup({
      id: 'private-matchup-e-f',
      teamAOwnerId: 'owner-e',
      teamBOwnerId: 'owner-f',
      teamAScore: 40,
      teamBScore: 40,
      winnerOwnerId: null,
    }),
  ];
}

test('round recap identity is deterministic and hides the raw cycle ID', () => {
  const first = getLeagueActivityDocumentId('cycle-recap', 'cycle-9-private');
  const second = getLeagueActivityDocumentId('cycle-recap', 'cycle-9-private');

  assert.equal(first, second);
  assert.match(first, /^activity-[a-f0-9]{40}$/);
  assert.equal(first.includes('cycle-9-private'), false);
});

test('an eligible completed round produces one bounded top-score and closest-finish recap', () => {
  const result = buildRegularSeasonRoundRecapLeagueActivity(eligibleRound());

  assert.ok(result);
  assert.equal(result.activity.category, 'recap');
  assert.equal(result.activity.eventType, 'matchup-round-recap');
  assert.equal(result.activity.recapCycleNumber, 9);
  assert.equal(result.activity.recapMatchupCount, 3);
  assert.deepEqual(result.activity.recapTopScoreOwnerIds, ['owner-c']);
  assert.equal(result.activity.recapTopScore, 52.1);
  assert.equal(result.activity.recapClosestTeamAOwnerId, 'owner-e');
  assert.equal(result.activity.recapClosestTeamBOwnerId, 'owner-f');
  assert.equal(result.activity.recapClosestWinnerOwnerId, null);
  assert.equal(result.activity.recapClosestMargin, 0);
  assert.equal(result.activity.recapNewLeagueHighScore, false);
  assert.equal(result.activity.recapPreviousLeagueHighScore, null);

  const serialized = JSON.stringify(result.activity);
  assert.equal(serialized.includes('private-matchup'), false);
  assert.equal(serialized.includes('playerScoreLedger'), false);
  assert.equal(serialized.includes('teamASeed'), false);
});

test('top-score ties are deterministic and a tied closest matchup remains honest', () => {
  const result = buildRegularSeasonRoundRecapLeagueActivity([
    completedMatchup({ teamAScore: 55, teamBScore: 50, winnerOwnerId: 'owner-a' }),
    completedMatchup({
      teamAOwnerId: 'owner-d',
      teamBOwnerId: 'owner-c',
      teamAScore: 55,
      teamBScore: 54,
      winnerOwnerId: 'owner-d',
    }),
  ], 53);

  assert.ok(result);
  assert.deepEqual(result.activity.recapTopScoreOwnerIds, ['owner-a', 'owner-d']);
  assert.equal(result.activity.recapNewLeagueHighScore, true);
  assert.equal(result.activity.recapPreviousLeagueHighScore, 53);
  assert.equal(result.activity.recapClosestTeamAOwnerId, 'owner-d');
  assert.equal(result.activity.recapClosestTeamBOwnerId, 'owner-c');
  assert.equal(result.activity.recapClosestWinnerOwnerId, 'owner-d');
  assert.equal(result.activity.recapClosestMargin, 1);
});

test('the first processed round establishes a baseline and only a strictly higher later score is a high', () => {
  const baseline = buildRegularSeasonRoundRecapLeagueActivity(eligibleRound());
  const equal = buildRegularSeasonRoundRecapLeagueActivity(eligibleRound(), 52.1);
  const higher = buildRegularSeasonRoundRecapLeagueActivity(eligibleRound(), 52);
  const outOfOrder = buildRegularSeasonRoundRecapLeagueActivity(eligibleRound(), 52, false);

  assert.ok(baseline);
  assert.ok(equal);
  assert.ok(higher);
  assert.ok(outOfOrder);
  assert.equal(baseline.activity.recapNewLeagueHighScore, false);
  assert.equal(equal.activity.recapNewLeagueHighScore, false);
  assert.equal(higher.activity.recapNewLeagueHighScore, true);
  assert.equal(outOfOrder.activity.recapNewLeagueHighScore, false);
});

test('byes are neutral and a one-game round stays quiet instead of duplicating Game Final', () => {
  const withBye = buildRegularSeasonRoundRecapLeagueActivity([
    ...eligibleRound(),
    completedMatchup({
      teamAOwnerId: 'owner-g',
      teamBOwnerId: null,
      teamAScore: 0,
      teamBScore: 0,
      winnerOwnerId: null,
    }),
  ]);
  const oneGame = buildRegularSeasonRoundRecapLeagueActivity([completedMatchup()]);
  const byesOnly = buildRegularSeasonRoundRecapLeagueActivity([
    completedMatchup({ teamAOwnerId: 'owner-g', teamBOwnerId: null, winnerOwnerId: null }),
  ]);

  assert.ok(withBye);
  assert.equal(withBye.activity.recapMatchupCount, 3);
  assert.equal(oneGame, null);
  assert.equal(byesOnly, null);
});

test('playoffs, incomplete results, malformed winners, mixed cycles, duplicate owners, and bad high-water data fail closed', () => {
  assert.equal(buildRegularSeasonRoundRecapLeagueActivity([
    completedMatchup(),
    completedMatchup({
      phase: 'playoffs',
      teamAOwnerId: 'owner-c',
      teamBOwnerId: 'owner-d',
      winnerOwnerId: 'owner-c',
    }),
  ]), null);
  assert.equal(buildRegularSeasonRoundRecapLeagueActivity([
    completedMatchup(),
    completedMatchup({
      status: 'active',
      teamAOwnerId: 'owner-c',
      teamBOwnerId: 'owner-d',
      winnerOwnerId: 'owner-c',
    }),
  ]), null);
  assert.equal(buildRegularSeasonRoundRecapLeagueActivity([
    completedMatchup(),
    completedMatchup({
      teamAOwnerId: 'owner-c',
      teamBOwnerId: 'owner-d',
      teamAScore: 50,
      teamBScore: 40,
      winnerOwnerId: 'owner-d',
    }),
  ]), null);
  assert.equal(buildRegularSeasonRoundRecapLeagueActivity([
    completedMatchup(),
    completedMatchup({
      cycleNumber: 10,
      teamAOwnerId: 'owner-c',
      teamBOwnerId: 'owner-d',
      winnerOwnerId: 'owner-c',
    }),
  ]), null);
  assert.equal(buildRegularSeasonRoundRecapLeagueActivity([
    completedMatchup(),
    completedMatchup({
      teamAOwnerId: 'owner-a',
      teamBOwnerId: 'owner-d',
      winnerOwnerId: 'owner-a',
    }),
  ]), null);
  assert.equal(buildRegularSeasonRoundRecapLeagueActivity(eligibleRound(), 'bad'), null);
});

test('the publisher observes only first regular-season cycle completion and writes activity plus a server-only high-water mark', async () => {
  const [publisher, index, functionsPackageSource] = await Promise.all([
    read('functions/src/league-activity.ts'),
    read('functions/src/index.ts'),
    read('functions/package.json'),
  ]);
  const functionsPackage = JSON.parse(functionsPackageSource);

  assert.match(publisher, /export const publishLeagueRoundRecapActivity = onDocumentUpdated/);
  assert.match(publisher, /leagues\/\{leagueId\}\/cycles\/\{cycleId\}/);
  assert.match(publisher, /beforeSource\['status'\] === 'complete'/);
  assert.match(publisher, /afterSource\['status'\] !== 'complete'/);
  assert.match(publisher, /afterSource\['phase'\] !== 'regular_season'/);
  assert.match(publisher, /afterSource\['cycleNumber'\]/);
  assert.match(publisher, /afterSource\['totalMatchupCount'\]/);
  assert.match(publisher, /completedMatchupCount !== totalMatchupCount/);
  assert.match(publisher, /matchupSnapshots\.size !== totalMatchupCount/);
  assert.match(publisher, /recap\.activity\.recapCycleNumber !== cycleNumber/);
  assert.match(publisher, /socialMilestones\/regular-season-scoring/);
  assert.match(publisher, /highestRegularSeasonTeamScore/);
  assert.match(publisher, /invalid regular-season scoring milestone/);
  assert.match(publisher, /previousLastRecapCycleNumber === cycleNumber - 1/);
  assert.match(publisher, /cycleNumber >= previousLastRecapCycleNumber/);
  assert.match(publisher, /recap\.highestScore > previousHighScore/);
  assert.match(publisher, /transaction\.create\(activityReference/);
  assert.match(publisher, /sourceKind: 'cycle-recap'/);
  assert.match(publisher, /release: 'Social Batch C1F'/);
  assert.match(index, /publishLeagueRoundRecapActivity/);
  assert.match(functionsPackage.scripts.logs, /publishLeagueRoundRecapActivity/);
});

test('League Wire renders the recap through the existing bounded feed while preserving announcements and pinning', async () => {
  const [service, component, template, styles] = await Promise.all([
    read('src/app/core/league/league-activity.service.ts'),
    read('src/app/features/leagues/league-wire/league-wire.ts'),
    read('src/app/features/leagues/league-wire/league-wire.html'),
    read('src/app/features/leagues/league-wire/league-wire.css'),
  ]);

  assert.match(service, /'matchup-round-recap'/);
  assert.match(service, /'recap'/);
  assert.match(service, /orderBy\('occurredAt', 'desc'\)/);
  assert.match(service, /limit\(LEAGUE_ACTIVITY_LIMIT\)/);
  assert.match(service, /'pinned-announcement'/);
  assert.equal((service.match(/onSnapshot\(/g) ?? []).length, 2);
  assert.match(component, /case 'matchup-round-recap'/);
  assert.match(component, /set a new League Wire scoring high/);
  assert.match(component, /Top score:/);
  assert.match(component, /Closest:/);
  assert.match(component, /Round Recap/);
  assert.match(template, /Post announcement/);
  assert.match(template, /Pinned announcement/);
  assert.match(template, /completed-round recap/);
  assert.match(styles, /data-category='recap'/);
  assert.doesNotMatch(template, /role="dialog"|viewport-overlay|action-sheet/i);
  assert.doesNotMatch(styles, /position:\s*(?:fixed|sticky)|backdrop-filter/i);
});

test('C1F advances RC32 while preserving competitive models, Rules, indexes, and safety modes', async () => {
  const [
    scoringRules,
    scoringEngine,
    projectionV11,
    firestoreRules,
    firestoreIndexes,
    runtime,
    productionRuntime,
    freezeSource,
    appCheckSource,
    canarySource,
    cacheSource,
    packageSource,
  ] = await Promise.all([
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/scoring/scoring-engine.ts'),
    read('src/app/core/projection/projection-v11.util.ts'),
    read('firestore.rules'),
    read('firestore.indexes.json'),
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('config/release-freeze/beta-freeze-policy.json'),
    read('config/app-check-enforcement-readiness.json'),
    read('config/app-check-callable-canary.json'),
    read('config/nhl-shared-cache-policy.json'),
    read('package.json'),
  ]);
  const freeze = JSON.parse(freezeSource);
  const appCheck = JSON.parse(appCheckSource);
  const canary = JSON.parse(canarySource);
  const cache = JSON.parse(cacheSource);
  const packageJson = JSON.parse(packageSource);

  assert.equal(createHash('sha256').update(scoringRules).digest('hex'), PROTECTED_SOURCE_HASHES.scoringRules);
  assert.equal(createHash('sha256').update(scoringEngine).digest('hex'), PROTECTED_SOURCE_HASHES.scoringEngine);
  assert.equal(createHash('sha256').update(projectionV11).digest('hex'), PROTECTED_SOURCE_HASHES.projectionV11);
  assert.equal(createHash('sha256').update(firestoreRules).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreRules);
  assert.equal(createHash('sha256').update(firestoreIndexes).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreIndexes);
  assert.match(runtime, /Release Candidate 32/);
  assert.match(productionRuntime, /Release Candidate 32/);
  assert.equal(freeze.scoringRulesVersion, 3);
  assert.equal(freeze.projectionVersion, 11);
  assert.equal(freeze.requiredGamesPerRosterSlot, 6);
  assert.equal(freeze.queueMode, 'shadow');
  assert.equal(freeze.appCheckMode, 'monitor');
  assert.equal(freeze.verificationCommand, 'npm run verify:batchc1f');
  assert.equal(appCheck.mode, 'monitor');
  assert.equal(canary.automaticPromotion, false);
  assert.equal(cache.mode, 'shadow');
  assert.equal(cache.authoritativeReadsEnabled, false);
  assert.match(packageJson.scripts['verify:batchc1f:core'], /verify:batchc1e:core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batchc1f:core/);
});

test('C1F documentation and roadmap record the bounded recap and site-first workflow', async () => {
  const [roadmap, docsRoadmap, runbook, readme, releaseRunbook] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_SOCIAL_C1F_ROUND_RECAPS.md'),
    read('README.md'),
    read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
  ]);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.23/);
  assert.match(roadmap, /# \[x\] C1\.18/);
  assert.match(roadmap, /# \[x\] LOG\.38/);
  assert.match(runbook, /League Wire-era/);
  assert.match(runbook, /one automated gate/i);
  assert.match(runbook, /functions:publishLeagueRoundRecapActivity/);
  assert.match(runbook, /Do not deploy Rules, indexes, TTL/);
  assert.match(runbook, /Site-first smoke test/);
  assert.match(readme, /Release Candidate 32 \/ Social Batch C1F/);
  assert.match(readme, /RINKRAT_SOCIAL_C1F_ROUND_RECAPS\.md/);
  assert.match(releaseRunbook, /npm run verify:batchc1f/);
  assert.match(releaseRunbook, /rinkrat-rc32-validation\.json/);
  assert.match(releaseRunbook, /rinkrat-rc32-invite-beta/);
});
