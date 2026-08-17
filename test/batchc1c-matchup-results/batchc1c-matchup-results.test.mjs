import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import {
  buildMatchupResultLeagueActivity,
  getLeagueActivityDocumentId,
} from '../../functions/src/shared/core/league/league-activity.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function completedMatchup(overrides = {}) {
  return {
    id: 'matchup-owner-a-owner-b',
    cycleNumber: 7,
    phase: 'regular_season',
    teamAOwnerId: 'owner-a',
    teamBOwnerId: 'owner-b',
    teamAScore: 42.75,
    teamBScore: 38.2,
    winnerOwnerId: 'owner-a',
    status: 'complete',
    completedAt: '2026-10-11T04:00:00.000Z',
    teamASeed: 1,
    teamBSeed: 4,
    teamAWindowNumber: 7,
    teamBWindowNumber: 7,
    playoffMatchupId: 'private-bracket-id',
    ...overrides,
  };
}

test('matchup activity identity is deterministic and hides cycle and matchup document IDs', () => {
  const sourceIdentity = 'cycle-7:matchup-owner-a-owner-b';
  const first = getLeagueActivityDocumentId('matchup', sourceIdentity);
  const second = getLeagueActivityDocumentId('matchup', sourceIdentity);

  assert.equal(first, second);
  assert.match(first, /^activity-[a-f0-9]{40}$/);
  assert.equal(first.includes('cycle-7'), false);
  assert.equal(first.includes('owner-a'), false);
});

test('regular-season finals publish one bounded public result without competition internals', () => {
  const activity = buildMatchupResultLeagueActivity(completedMatchup());

  assert.ok(activity);
  assert.equal(activity.category, 'matchup');
  assert.equal(activity.eventType, 'matchup-result');
  assert.equal(activity.ownerId, 'owner-a');
  assert.equal(activity.matchupPhase, 'regular_season');
  assert.equal(activity.matchupCycleNumber, 7);
  assert.equal(activity.teamAOwnerId, 'owner-a');
  assert.equal(activity.teamBOwnerId, 'owner-b');
  assert.equal(activity.teamAScore, 42.75);
  assert.equal(activity.teamBScore, 38.2);
  assert.equal(activity.winnerOwnerId, 'owner-a');
  assert.equal(activity.playoffBracketType, null);
  assert.equal(activity.playoffRoundNumber, null);
  assert.equal(activity.winnerPlace, null);
  assert.equal(activity.tieBrokenByHigherSeed, false);

  const serialized = JSON.stringify(activity);
  assert.equal(serialized.includes('private-bracket-id'), false);
  assert.equal(serialized.includes('teamASeed'), false);
  assert.equal(serialized.includes('teamAWindowNumber'), false);
  assert.equal(serialized.includes('matchup-owner-a-owner-b'), false);
});

test('regular-season ties are public finals while malformed winners and byes fail closed', () => {
  const tied = buildMatchupResultLeagueActivity(completedMatchup({
    teamAScore: 40.5,
    teamBScore: 40.5,
    winnerOwnerId: null,
  }));

  assert.ok(tied);
  assert.equal(tied.ownerId, null);
  assert.equal(tied.winnerOwnerId, null);

  assert.equal(buildMatchupResultLeagueActivity(completedMatchup({
    teamAScore: 40.5,
    teamBScore: 40.5,
    winnerOwnerId: 'owner-a',
  })), null);
  assert.equal(buildMatchupResultLeagueActivity(completedMatchup({
    winnerOwnerId: 'owner-b',
  })), null);
  assert.equal(buildMatchupResultLeagueActivity(completedMatchup({
    teamBOwnerId: null,
    winnerOwnerId: 'owner-a',
  })), null);
  assert.equal(buildMatchupResultLeagueActivity(completedMatchup({
    status: 'active',
  })), null);
});

test('playoff finals preserve advancement, placement, championship, and higher-seed tiebreak context', () => {
  const championship = buildMatchupResultLeagueActivity(completedMatchup({
    phase: 'playoffs',
    cycleNumber: 12,
    bracketType: 'championship',
    playoffRoundNumber: 2,
    teamAScore: 55,
    teamBScore: 55,
    winnerOwnerId: 'owner-a',
    winnerPlace: 1,
    loserPlace: 2,
    tieBrokenByHigherSeed: true,
  }));

  assert.ok(championship);
  assert.equal(championship.matchupPhase, 'playoffs');
  assert.equal(championship.playoffBracketType, 'championship');
  assert.equal(championship.playoffRoundNumber, 2);
  assert.equal(championship.winnerPlace, 1);
  assert.equal(championship.loserPlace, 2);
  assert.equal(championship.tieBrokenByHigherSeed, true);

  assert.equal(buildMatchupResultLeagueActivity(completedMatchup({
    phase: 'playoffs',
    teamAScore: 55,
    teamBScore: 55,
    winnerOwnerId: 'owner-a',
    tieBrokenByHigherSeed: false,
  })), null);
  assert.equal(buildMatchupResultLeagueActivity(completedMatchup({
    phase: 'playoffs',
    teamAScore: 55,
    teamBScore: 55,
    winnerOwnerId: null,
    tieBrokenByHigherSeed: true,
  })), null);
});

test('the create-only publisher observes only the first active-to-complete matchup transition', async () => {
  const [publisher, index, functionsPackageSource] = await Promise.all([
    read('functions/src/league-activity.ts'),
    read('functions/src/index.ts'),
    read('functions/package.json'),
  ]);
  const functionsPackage = JSON.parse(functionsPackageSource);

  assert.match(publisher, /export const publishLeagueMatchupResultActivity = onDocumentUpdated/);
  assert.match(
    publisher,
    /leagues\/\{leagueId\}\/cycles\/\{cycleId\}\/matchups\/\{matchupId\}/,
  );
  assert.match(publisher, /beforeSource\['status'\] === 'complete'/);
  assert.match(publisher, /afterSource\['status'\] !== 'complete'/);
  assert.match(publisher, /`\$\{cycleId\}:\$\{matchupId\}`/);
  assert.match(publisher, /sourceKind:\s*'matchup'/);
  assert.match(publisher, /release:\s*'Social Batch C1C'/);
  assert.match(publisher, /getLeagueActivityDocumentId/);
  assert.match(publisher, /if \(existing\.exists\)/);
  assert.match(index, /publishLeagueMatchupResultActivity/);
  assert.match(functionsPackage.scripts.logs, /publishLeagueMatchupResultActivity/);
});

test('the scoped matchup-activity inspector is read-only and validates the C1C projection contract', async () => {
  const [inspector, packageSource] = await Promise.all([
    read('functions/scripts/league-matchup-activity-inspect.cjs'),
    read('package.json'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.match(inspector, /Provide one exact Internal Test league with --league=/);
  assert.match(inspector, /leagues\/\$\{leagueId\}\/activity/);
  assert.match(inspector, /sourceKind !== 'matchup'/);
  assert.match(inspector, /league-activity-authority/);
  assert.match(inspector, /Social Batch C1C/);
  assert.match(inspector, /FORBIDDEN_FIELDS/);
  assert.match(inspector, /Privacy\/schema issues/);
  assert.match(inspector, /Inspection only\. No matchup, score, league, activity, or production setting was changed\./);
  assert.doesNotMatch(inspector, /\.set\(|\.update\(|\.delete\(|runTransaction\(|\.batch\(/);
  assert.equal(
    packageJson.scripts['social:inspect-matchup-activity'],
    'npm --prefix functions run build && node functions/scripts/league-matchup-activity-inspect.cjs',
  );
});

test('League Wire renders final results with progressive disclosure and no live-score spam', async () => {
  const [service, component, template, styles] = await Promise.all([
    read('src/app/core/league/league-activity.service.ts'),
    read('src/app/features/leagues/league-wire/league-wire.ts'),
    read('src/app/features/leagues/league-wire/league-wire.html'),
    read('src/app/features/leagues/league-wire/league-wire.css'),
  ]);

  assert.match(service, /'matchup-result'/);
  assert.match(service, /'matchup'/);
  assert.match(service, /orderBy\('occurredAt', 'desc'\)/);
  assert.match(service, /limit\(LEAGUE_ACTIVITY_LIMIT\)/);
  assert.match(component, /case 'matchup-result'/);
  assert.match(component, /won the RinkRat Championship/);
  assert.match(component, /advanced past/);
  assert.match(component, /finished tied/);
  assert.match(component, /Higher seed advanced/);
  assert.match(component, /Game Final/);
  assert.match(template, /final matchup results/);
  assert.match(template, /Only final matchup outcomes post/);
  assert.match(template, /Live score changes/);
  assert.match(styles, /data-category='matchup'/);
  assert.doesNotMatch(template, /role="dialog"|viewport-overlay|action-sheet/i);
  assert.doesNotMatch(styles, /position:\s*(?:fixed|sticky)|backdrop-filter/i);
});

test('C1C changes no competitive model, Firestore Rule, index, or safety-mode authority', async () => {
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
  assert.match(runtime, /Release Candidate 35/);
  assert.match(productionRuntime, /Release Candidate 35/);
  assert.equal(freeze.scoringRulesVersion, 3);
  assert.equal(freeze.projectionVersion, 11);
  assert.equal(freeze.requiredGamesPerRosterSlot, 6);
  assert.equal(freeze.queueMode, 'shadow');
  assert.equal(freeze.appCheckMode, 'monitor');
  assert.equal(freeze.verificationCommand, 'npm run verify:batchc1i');
  assert.equal(appCheck.mode, 'monitor');
  assert.equal(canary.automaticPromotion, false);
  assert.equal(cache.mode, 'shadow');
  assert.equal(cache.authoritativeReadsEnabled, false);
  assert.match(packageJson.scripts['verify:batchc1c:core'], /verify:batchc1b:core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batchc1i:core/);
});

test('C1C documentation and permanent roadmap record the bounded matchup-result slice', async () => {
  const [roadmap, docsRoadmap, runbook, readme, releaseRunbook] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_SOCIAL_C1C_MATCHUP_RESULTS.md'),
    read('README.md'),
    read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
  ]);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.26/);
  assert.match(roadmap, /# \[x\] C1\.15/);
  assert.match(roadmap, /# \[x\] LOG\.35/);
  assert.match(runbook, /active-to-complete/);
  assert.match(runbook, /No historical matchup backfill/);
  assert.match(runbook, /social:inspect-matchup-activity/);
  assert.match(runbook, /Privacy\/schema issues: 0/);
  assert.match(runbook, /Functions only/);
  assert.match(runbook, /Hosting RC29 only/);
  assert.match(runbook, /No Firestore Rules or index deployment/);
  assert.match(runbook, /live-score spam/i);
  assert.match(readme, /Release Candidate 35 \/ Social Batch C1I/);
  assert.match(readme, /RINKRAT_SOCIAL_C1C_MATCHUP_RESULTS\.md/);
  assert.match(releaseRunbook, /rinkrat-rc35-validation\.json/);
  assert.match(releaseRunbook, /rinkrat-rc35-invite-beta/);
});
