import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { buildFreeAgentMoveLens } from '../../src/app/features/free-agents/free-agent-move-lens.util.ts';
import {
  buildLeaguePlayerRosterFitRecommendations,
  compareLeaguePlayerRosterFitRecommendations,
} from '../../src/app/core/player/league-player-roster-fit.util.ts';
import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function skater({
  key,
  name,
  team = 'EDM',
  position = 'C',
  nextSix = 30,
  rest = 220,
  floor = 24,
  uncertainty = 4,
  expectedGames = 6,
  reliability = 78,
  seasonFppg = 5,
  replacement = 4,
  status = 'active',
} = {}) {
  return {
    assetType: 'skater',
    assetKey: key,
    position,
    player: {
      id: Number(String(key).replace(/\D/g, '')) || 1,
      fullName: name,
      nhlTeamAbbreviation: team,
    },
    projectedCyclePoints: nextSix,
    availabilityAdjustedCyclePoints: nextSix,
    projectedRestOfSeasonPoints: rest,
    projectionFloorPoints: floor,
    projectionUncertaintyPoints: uncertainty,
    expectedGamesAvailable: expectedGames,
    scheduledGamesInProjectionCycle: 6,
    reliabilityRating: reliability,
    seasonFantasyPointsPerGame: seasonFppg,
    cycleValueAboveReplacement: replacement,
    availabilityStatus: status,
  };
}

function boardRow({
  key,
  name,
  position = 'C',
  status = 'free-agent',
  nextSix = 30,
  rest = 220,
  expectedGames = 6,
  reliability = 80,
  positionRank = 5,
  positionCount = 40,
  availabilityLabel = 'Active',
} = {}) {
  return {
    assetKey: key,
    asset: skater({
      key,
      name,
      position,
      nextSix,
      rest,
      expectedGames,
      reliability,
    }),
    name,
    nhlTeamAbbreviation: 'EDM',
    position,
    logoUrl: null,
    headshotUrl: null,
    status,
    ownership: null,
    watched: false,
    seasonFantasyPoints: 100,
    seasonFantasyPointsPerGame: 5,
    seasonGamesPlayed: 20,
    overallRank: 20,
    positionRank: 6,
    nextSixProjection: nextSix,
    nextSixOverallRank: 20,
    nextSixPositionRank: positionRank,
    nextSixOverallRankCount: 200,
    nextSixPositionRankCount: positionCount,
    restOfSeasonProjection: rest,
    projectedFinalSeasonPoints: 320,
    projectionFloor: nextSix - 5,
    projectionCeiling: nextSix + 5,
    reliabilityRating: reliability,
    projectionConfidence: reliability,
    recentFiveGameFantasyPointsPerGame: 5,
    recentTenGameFantasyPointsPerGame: 5,
    recentTwentyGameFantasyPointsPerGame: 5,
    seasonAverageTimeOnIceMinutes: 18,
    recentAverageTimeOnIceMinutes: 18,
    expectedGamesAvailable: expectedGames,
    expectedGamesMissed: 6 - expectedGames,
    scheduleDifficultyLabel: 'Average',
    availabilityLabel,
    draftRank: 20,
    cycleRank: 20,
    cyclePositionRank: positionRank,
    overallRankCount: 200,
    positionRankCount: positionCount,
  };
}

function rosterAsset(row) {
  return {
    assetType: 'skater',
    assetKey: row.assetKey,
    position: row.position,
    player: row.asset.player,
    cycleScore: { cycleNumber: 1, gamesCounted: 0, fantasyPoints: 0 },
  };
}

function roster({ active = [], bench = [] } = {}) {
  return {
    schemaVersion: 1,
    activeSlots: active,
    benchSlots: bench,
    irSlots: [],
  };
}

test('a clearly stronger incoming player produces a transparent add lean', () => {
  const result = buildFreeAgentMoveLens({
    incoming: skater({ key: 'skater-1', name: 'Incoming', nextSix: 38, rest: 280, floor: 31, expectedGames: 6, reliability: 88, seasonFppg: 6.3 }),
    outgoing: skater({ key: 'skater-2', name: 'Outgoing', nextSix: 25, rest: 190, floor: 19, expectedGames: 4.5, reliability: 65, seasonFppg: 4.1 }),
    transactionType: 'free-agent',
    openSlot: false,
  });

  assert.equal(result.verdict, 'lean-add');
  assert.equal(result.headline, 'Leans add');
  assert.equal(result.confidence, 'high');
  assert.ok(result.incomingSignalCount >= 4);
  assert.equal(result.outgoingSignalCount, 0);
  assert.ok(result.factors.length <= 3);
  assert.match(result.summary, /favor Incoming/);
});

test('a clearly stronger outgoing player produces a hold lean', () => {
  const result = buildFreeAgentMoveLens({
    incoming: skater({ key: 'skater-3', name: 'Incoming', nextSix: 20, rest: 140, floor: 14, expectedGames: 3, reliability: 52, seasonFppg: 3.2, status: 'out' }),
    outgoing: skater({ key: 'skater-4', name: 'Roster Star', nextSix: 35, rest: 260, floor: 29, expectedGames: 6, reliability: 86, seasonFppg: 6.1 }),
    transactionType: 'free-agent',
    openSlot: false,
  });

  assert.equal(result.verdict, 'lean-hold');
  assert.equal(result.headline, 'Leans hold');
  assert.ok(result.outgoingSignalCount >= 4);
  assert.match(result.summary, /keeping Roster Star/);
  assert.match(result.uncertainty, /Injury or return timing/);
});

test('mixed evidence remains a close call instead of inventing certainty', () => {
  const result = buildFreeAgentMoveLens({
    incoming: skater({ key: 'skater-5', name: 'Short-Term Play', nextSix: 34, rest: 180, floor: 27, expectedGames: 6, reliability: 58, seasonFppg: 5.8 }),
    outgoing: skater({ key: 'skater-6', name: 'Long-Term Hold', nextSix: 27, rest: 240, floor: 24, expectedGames: 5.5, reliability: 82, seasonFppg: 5.1 }),
    transactionType: 'free-agent',
    openSlot: false,
  });

  assert.equal(result.verdict, 'close-call');
  assert.equal(result.headline, 'Close call');
  assert.match(result.summary, /Signals are split/);
});

test('waiver recommendations always disclose that priority cost is outside the lens', () => {
  const result = buildFreeAgentMoveLens({
    incoming: skater({ key: 'skater-7', name: 'Waiver Target', nextSix: 36, rest: 250 }),
    outgoing: skater({ key: 'skater-8', name: 'Drop Option', nextSix: 24, rest: 170 }),
    transactionType: 'waiver',
    openSlot: false,
  });

  assert.equal(result.headline, 'Leans claim');
  assert.match(result.uncertainty, /Waiver priority cost.*not scored/);
});

test('open-slot guidance uses replacement value and availability without pretending a player is being dropped', () => {
  const result = buildFreeAgentMoveLens({
    incoming: skater({ key: 'skater-9', name: 'Open Slot Add', replacement: 8, expectedGames: 6, reliability: 84 }),
    outgoing: null,
    transactionType: 'free-agent',
    openSlot: true,
  });

  assert.equal(result.verdict, 'lean-add');
  assert.equal(result.headline, 'Leans add');
  assert.match(result.summary, /open slot/);
  assert.ok(result.factors.some((factor) => factor.key === 'replacement-value'));
});

test('thin open-slot evidence shows caution rather than a false strong recommendation', () => {
  const result = buildFreeAgentMoveLens({
    incoming: skater({ key: 'skater-10', name: 'Risky Add', replacement: -3, expectedGames: 2, reliability: 45, status: 'injured-reserve' }),
    outgoing: null,
    transactionType: 'waiver',
    openSlot: true,
  });

  assert.equal(result.verdict, 'open-slot-caution');
  assert.equal(result.headline, 'Open-slot caution');
  assert.notEqual(result.confidence, 'high');
  assert.match(result.uncertainty, /Waiver priority cost/);
});

test('roster-fit ordering favors a strong open-slot player without inventing a drop comparison', () => {
  const target = boardRow({ key: 'skater-101', name: 'Open Slot Target', nextSix: 38, rest: 280, reliability: 88, positionRank: 3 });
  const weaker = boardRow({ key: 'skater-102', name: 'Depth Option', nextSix: 24, rest: 175, reliability: 68, positionRank: 20 });
  const leagueRoster = roster({
    active: [
      { slotId: 'C1', position: 'C', slotNumber: 1, asset: null, pendingMove: null },
    ],
    bench: [],
  });

  const recommendations = buildLeaguePlayerRosterFitRecommendations({
    rows: [target, weaker],
    roster: leagueRoster,
    requiredGames: 6,
  });
  const result = recommendations.get(target.assetKey);

  assert.equal(result?.hasOpenSlot, true);
  assert.equal(result?.comparisonAssetKey, null);
  assert.equal(result?.tier, 'strong');
  assert.match(result?.summary ?? '', /Open slot/);
});

test('roster-fit recommendations compare with the lowest-projected legal same-position option', () => {
  const target = boardRow({ key: 'skater-201', name: 'Waiver Upgrade', nextSix: 36, rest: 270, reliability: 84 });
  const weakCenter = boardRow({ key: 'skater-202', name: 'Weak Center', status: 'rostered', nextSix: 24, rest: 180 });
  const strongCenter = boardRow({ key: 'skater-203', name: 'Strong Center', status: 'rostered', nextSix: 33, rest: 255 });
  const leagueRoster = roster({
    active: [
      { slotId: 'C1', position: 'C', slotNumber: 1, asset: rosterAsset(weakCenter), pendingMove: null },
      { slotId: 'C2', position: 'C', slotNumber: 2, asset: rosterAsset(strongCenter), pendingMove: null },
    ],
    bench: [],
  });

  const recommendations = buildLeaguePlayerRosterFitRecommendations({
    rows: [target, weakCenter, strongCenter],
    roster: leagueRoster,
    requiredGames: 6,
  });
  const result = recommendations.get(target.assetKey);

  assert.equal(result?.comparisonAssetKey, weakCenter.assetKey);
  assert.equal(result?.comparisonName, weakCenter.name);
  assert.equal(result?.comparisonArea, 'active');
  assert.equal(result?.nextSixEdge, 12);
  assert.equal(result?.restOfSeasonEdge, 90);
  assert.equal(result?.tier, 'strong');
  assert.ok(result?.detailLines.some((line) => /lowest-projected legal same-position active/.test(line)));
});

test('roster-fit ordering is deterministic and places stronger transparent evidence first', () => {
  const target = boardRow({ key: 'skater-301', name: 'Best Target', nextSix: 37, rest: 275, reliability: 90 });
  const middle = boardRow({ key: 'skater-302', name: 'Middle Target', nextSix: 29, rest: 220, reliability: 72 });
  const weak = boardRow({ key: 'skater-303', name: 'Weak Target', nextSix: 19, rest: 140, reliability: 45, expectedGames: 3 });
  const incumbent = boardRow({ key: 'skater-304', name: 'Incumbent', status: 'rostered', nextSix: 24, rest: 185 });
  const leagueRoster = roster({
    active: [{ slotId: 'C1', position: 'C', slotNumber: 1, asset: rosterAsset(incumbent), pendingMove: null }],
    bench: [],
  });
  const recommendations = buildLeaguePlayerRosterFitRecommendations({
    rows: [target, middle, weak, incumbent],
    roster: leagueRoster,
    requiredGames: 6,
  });
  const sorted = [weak, middle, target].sort((left, right) =>
    compareLeaguePlayerRosterFitRecommendations(
      recommendations.get(left.assetKey),
      recommendations.get(right.assetKey),
    ),
  );

  assert.deepEqual(sorted.map((row) => row.assetKey), [target.assetKey, middle.assetKey, weak.assetKey]);
});

test('the transaction screen exposes one compact optional explanation only after a roster choice exists', async () => {
  const [component, template, styles] = await Promise.all([
    read('src/app/features/free-agents/free-agents.ts'),
    read('src/app/features/free-agents/free-agents.html'),
    read('src/app/features/free-agents/free-agents.css'),
  ]);

  assert.match(component, /readonly boardRosterFitByAssetKey = computed/);
  assert.match(component, /compareLeaguePlayerRosterFitRecommendations/);
  assert.match(component, /suggestedRosterFitComparisonAssetKey/);
  assert.match(template, /Suggested comparison/);
  assert.doesNotMatch(component, /selectedDropSlotId\.set\(this\.suggestedRosterFitComparisonAssetKey/);
  assert.match(component, /readonly moveLens = computed/);
  assert.match(component, /buildFreeAgentMoveLens/);
  assert.match(template, /@if \(moveLens\(\); as lens\)/);
  assert.match(template, /Move lens/);
  assert.match(template, /<summary>Why\?<\/summary>/);
  assert.match(template, /guidance, not a guarantee/);
  assert.match(styles, /transaction-move-lens/);
  assert.match(styles, /@media \(max-width: 560px\)/);
  assert.doesNotMatch(template, /role="dialog"|viewport-overlay|action-sheet|innerHTML/i);
  const lensStyles = styles.slice(
    styles.indexOf('.transaction-move-lens {'),
    styles.indexOf('.transaction-timing-details {'),
  );
  assert.doesNotMatch(lensStyles, /position:\s*(?:fixed|sticky)/i);
});

test('the lens uses only existing player evidence and introduces no new network or authority surface', async () => {
  const [utility, functionsIndex, rules, indexes] = await Promise.all([
    read('src/app/features/free-agents/free-agent-move-lens.util.ts'),
    read('functions/src/index.ts'),
    read('firestore.rules'),
    read('firestore.indexes.json'),
  ]);

  for (const field of [
    'projectedCyclePoints',
    'projectedRestOfSeasonPoints',
    'projectionFloorPoints',
    'expectedGamesAvailable',
    'seasonFantasyPointsPerGame',
    'reliabilityRating',
    'cycleValueAboveReplacement',
  ]) {
    assert.match(utility, new RegExp(field));
  }

  assert.doesNotMatch(utility, /fetch\(|httpsCallable|onSnapshot|collection\(|doc\(/);
  assert.doesNotMatch(functionsIndex, /MoveLens|WaiverRecommendation|recommendWaiver|gradeAddDrop/);
  assert.equal(createHash('sha256').update(rules).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreRules);
  assert.equal(createHash('sha256').update(indexes).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreIndexes);
});

test('A1G preserves competitive sources and inactive safety controls', async () => {
  const [
    scoringRules,
    scoringEngine,
    projectionV11,
    freezeSource,
    appCheckSource,
    canarySource,
    cacheSource,
  ] = await Promise.all([
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/scoring/scoring-engine.ts'),
    read('src/app/core/projection/projection-v11.util.ts'),
    read('config/release-freeze/beta-freeze-policy.json'),
    read('config/app-check-enforcement-readiness.json'),
    read('config/app-check-callable-canary.json'),
    read('config/nhl-shared-cache-policy.json'),
  ]);
  const freeze = JSON.parse(freezeSource);
  const appCheck = JSON.parse(appCheckSource);
  const canary = JSON.parse(canarySource);
  const cache = JSON.parse(cacheSource);

  assert.equal(createHash('sha256').update(scoringRules).digest('hex'), PROTECTED_SOURCE_HASHES.scoringRules);
  assert.equal(createHash('sha256').update(scoringEngine).digest('hex'), PROTECTED_SOURCE_HASHES.scoringEngine);
  assert.equal(createHash('sha256').update(projectionV11).digest('hex'), PROTECTED_SOURCE_HASHES.projectionV11);
  assert.equal(freeze.scoringRulesVersion, 4);
  assert.equal(freeze.projectionVersion, 11);
  assert.equal(freeze.requiredGamesPerRosterSlot, 6);
  assert.equal(freeze.queueMode, 'shadow');
  assert.equal(freeze.appCheckMode, 'monitor');
  assert.equal(appCheck.mode, 'monitor');
  assert.equal(canary.automaticPromotion, false);
  assert.equal(cache.mode, 'shadow');
  assert.equal(cache.authoritativeReadsEnabled, false);
});

test('A1G advances RC45, completes A1.8, and keeps replay latency work in progress', async () => {
  const [runtime, productionRuntime, freezeSource, packageSource, roadmap, docsRoadmap, docs, readme, runbook] = await Promise.all([
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('config/release-freeze/beta-freeze-policy.json'),
    read('package.json'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_PRODUCT_A1G_TRANSPARENT_MOVE_LENS.md'),
    read('README.md'),
    read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
  ]);
  const freeze = JSON.parse(freezeSource);
  const packageJson = JSON.parse(packageSource);

  assert.match(runtime, /Release Candidate 59/);
  assert.match(productionRuntime, /Release Candidate 59/);
  assert.equal(freeze.releaseLabel, 'Release Candidate 59');
  assert.equal(freeze.verificationCommand, 'npm run verify:batcho1i');
  assert.equal(freeze.defaultTag, 'rinkrat-rc59-invite-beta');
  assert.match(packageJson.scripts['verify:batcha1g:core'], /verify:batcha1f:core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batcho1i:core/);
  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.50/);
  assert.match(roadmap, /# \[x\] A1\.8/);
  assert.match(roadmap, /\[~\] A1\.16 Reduce historical-replay player-data catch-up latency/);
  assert.match(roadmap, /# \[x\] LOG\.54 2026-08-18/);
  assert.match(docs, /simple directional signals/i);
  assert.match(docs, /waiver priority cost/i);
  assert.match(docs, /Hosting-only/i);
  assert.match(readme, /Release Candidate 59 \/ Operations Batch O1I/);
  assert.match(runbook, /npm run verify:batcho1i/);
  assert.match(runbook, /rinkrat-rc59-validation\.json/);
  assert.match(runbook, /rinkrat-rc59-invite-beta/);
});
