import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildCurrentRosterWindowByAssetKey,
  buildProjectionProgressMarkers,
  buildRosterWindowProgressMarkers,
} from '../../src/app/core/player/league-player-window-progress.util.ts';
import { buildPlayerOpportunityLens } from '../../src/app/core/player/player-opportunity-lens.util.ts';
import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function windowRecord({
  assetKey = 'skater-1',
  ownerId = 'owner-a',
  rosterSlotId = 'C-1',
  cycleNumber = 1,
  status = 'active',
} = {}) {
  return {
    id: `${ownerId}-${rosterSlotId}-${cycleNumber}`,
    ownerId,
    rosterSlotId,
    cycleNumber,
    position: 'C',
    assetKey,
    asset: { assetType: 'skater', assetKey, position: 'C', player: { id: 1, fullName: 'Test Player' } },
    status,
    scheduledGameIds: [11, 12, 13, 14, 15, 16],
    scheduledGameDates: ['2026-10-01', '2026-10-03', '2026-10-05', '2026-10-07', '2026-10-09', '2026-10-11'],
    scheduledGameLabels: ['vs BOS', '@ NYR', 'vs TOR', '@ MTL', 'vs BUF', '@ OTT'],
    completedGameIds: [11],
    liveGameIds: [],
    appearanceGameIds: [11],
    gameScores: { '11': 4.5 },
    gameStates: { '11': 'final' },
    scheduledGames: 6,
    gamesPlayed: 1,
    actualGamesPlayed: 1,
    gamesLeft: 5,
    fantasyPoints: 4.5,
    frozenProjectionPoints: 30,
    frozenProjectionVersion: 11,
    frozenProjectionSource: 'shared-snapshot',
    frozenProjectionSnapshotId: 'snapshot-1',
    frozenProjectionGeneratedAt: '2026-09-30T00:00:00Z',
    frozenProjectionFrozenAt: '2026-10-01T00:00:00Z',
    frozenProjectionTargetGameIds: [11, 12, 13, 14, 15, 16],
    firstScheduledGameDate: '2026-10-01',
    lastScheduledGameDate: '2026-10-11',
  };
}

function ownership(area = 'active', assetKey = 'skater-1') {
  return {
    assetKey,
    ownerId: 'owner-a',
    teamName: 'Ice Rats',
    managerName: 'Alex',
    area,
    rosterSlotId: area === 'active' ? 'C-1' : `${area}-1`,
    slotLabel: area === 'active' ? 'C1' : area,
  };
}

test('active roster rows resolve the newest exact owner slot and asset window', () => {
  const older = windowRecord({ cycleNumber: 1, status: 'complete' });
  const current = windowRecord({ cycleNumber: 2, status: 'active' });
  const future = windowRecord({ cycleNumber: 3, status: 'scheduled' });
  const map = buildCurrentRosterWindowByAssetKey(
    new Map([['skater-1', ownership()]]),
    {
      1: [{ id: 'owner-a', ownerId: 'owner-a', cycleNumber: 1, expectedRosterSlotIds: ['C-1'], windows: [older], completedWindowCount: 1, totalWindowCount: 1, status: 'complete' }],
      2: [{ id: 'owner-a', ownerId: 'owner-a', cycleNumber: 2, expectedRosterSlotIds: ['C-1'], windows: [current], completedWindowCount: 0, totalWindowCount: 1, status: 'active' }],
      3: [{ id: 'owner-a', ownerId: 'owner-a', cycleNumber: 3, expectedRosterSlotIds: ['C-1'], windows: [future], completedWindowCount: 0, totalWindowCount: 1, status: 'scheduled' }],
    },
  );

  assert.equal(map.get('skater-1')?.cycleNumber, 2);
  assert.equal(map.get('skater-1')?.gamesPlayed, 1);
});

test('slot matching fails closed for a stale outgoing asset and for non-active roster areas', () => {
  const stale = windowRecord({ assetKey: 'skater-old', cycleNumber: 2 });
  const map = buildCurrentRosterWindowByAssetKey(
    new Map([
      ['skater-1', ownership('active', 'skater-1')],
      ['skater-bench', ownership('bench', 'skater-bench')],
    ]),
    {
      2: [{ id: 'owner-a', ownerId: 'owner-a', cycleNumber: 2, expectedRosterSlotIds: ['C-1'], windows: [stale], completedWindowCount: 0, totalWindowCount: 1, status: 'active' }],
    },
  );

  assert.equal(map.has('skater-1'), false);
  assert.equal(map.has('skater-bench'), false);
});

test('authoritative roster markers mirror Game Center played missed upcoming and unavailable states', () => {
  const source = windowRecord({ cycleNumber: 2 });
  source.completedGameIds = [11, 12];
  source.appearanceGameIds = [11];
  source.liveGameIds = [13];
  source.scheduledGameIds = [11, 12, 13, 14];
  source.scheduledGameDates = source.scheduledGameDates.slice(0, 4);
  source.scheduledGameLabels = source.scheduledGameLabels.slice(0, 4);

  const markers = buildRosterWindowProgressMarkers(source, 6);
  assert.deepEqual(markers.map((marker) => marker.status), [
    'played',
    'missed',
    'upcoming',
    'upcoming',
    'unavailable',
    'unavailable',
  ]);
  assert.equal(markers[0].displayLabel, 'vs BOS');
  assert.equal(markers[2].statusLabel, 'Live');
});

test('projection markers remain an explicitly labeled NHL block fallback', () => {
  const markers = buildProjectionProgressMarkers([
    { gameId: 21, gameDate: '2026-10-01', opponentAbbreviation: 'BOS', venue: 'home', status: 'played' },
    { gameId: 22, gameDate: '2026-10-03', opponentAbbreviation: 'NYR', venue: 'away', status: 'upcoming' },
  ], 3);

  assert.equal(markers[0].displayLabel, 'vs BOS');
  assert.equal(markers[1].displayLabel, '@ NYR');
  assert.equal(markers[2].displayLabel, 'Schedule pending');
});

test('the next-six lens makes reduced availability and schedule impact explicit', () => {
  const lens = buildPlayerOpportunityLens({
    expectedGamesAvailable: 4,
    scheduledGamesInProjectionCycle: 6,
    scheduleDifficultyLabel: 'Favorable',
    scheduleStrengthAdjustment: 1.4,
    projectionBackToBackGames: 1,
    projectionRestAdvantageGames: 2,
    roleAdjustment: 0.7,
    recentFormAdjustment: 0.5,
  });

  assert.equal(lens.headline, 'Reduced to 4 of 6');
  assert.equal(lens.factors[0]?.key, 'availability');
  assert.ok(lens.factors.some((factor) => factor.key === 'schedule' && factor.value.includes('+1.4 FP')));
  assert.match(lens.summary, /Availability currently removes about 2 games/);
  assert.ok(lens.factors.length <= 3);
});

test('the next-six lens reports a full opportunity without inventing a strong effect', () => {
  const lens = buildPlayerOpportunityLens({
    expectedGamesAvailable: 6,
    scheduledGamesInProjectionCycle: 6,
    scheduleDifficultyLabel: 'Neutral',
    scheduleStrengthAdjustment: 0,
    projectionBackToBackGames: 1,
    projectionRestAdvantageGames: 1,
    roleAdjustment: 0,
    recentFormAdjustment: 0,
  });

  assert.equal(lens.headline, 'Full six-game opportunity');
  assert.ok(lens.factors.every((factor) => factor.impact === 'neutral'));
  assert.ok(lens.factors.length <= 3);
});

test('Add Drop uses all active team windows and never labels a free-agent NHL block as a fantasy matchup', async () => {
  const [component, template] = await Promise.all([
    read('src/app/features/free-agents/free-agents.ts'),
    read('src/app/features/free-agents/free-agents.html'),
  ]);

  assert.match(component, /teamWindowsByCycle = signal<Record<number, FantasyTeamCycleWindows\[\]>>/);
  assert.match(component, /teamWindowSnapshotReady = computed/);
  assert.match(component, /activeCycleNumbers\.every\(\(cycleNumber\) => loadedByCycle\[cycleNumber\] === true\)/);
  assert.match(component, /buildCurrentRosterWindowByAssetKey/);
  assert.match(component, /\[cycleNumber\]: teamWindows/);
  assert.match(component, /row\.ownership\?\.area === 'active'[\s\S]*?\? undefined/);
  assert.match(component, /return blockNumber \? `NHL Block \$\{blockNumber\}`/);
  assert.match(template, /getBoardCycleLabel\(row\)/);
  assert.match(template, /getBoardCycleMarker\(row, dotIndex\)/);
  assert.doesNotMatch(template, /getBoardCycleLabel\(row\.asset\)|getCurrentCycleMarker\(row\.asset/);
});

test('Player Intel reuses the same exact active window and keeps schedule explanation progressive', async () => {
  const [service, component, template, styles] = await Promise.all([
    read('src/app/core/player/league-player-board.service.ts'),
    read('src/app/features/players/league-player-detail/league-player-detail.ts'),
    read('src/app/features/players/league-player-detail/league-player-detail.html'),
    read('src/app/features/players/league-player-detail/league-player-detail.css'),
  ]);

  assert.match(service, /getActiveLeagueCycles/);
  assert.match(service, /getCycleTeamWindows/);
  assert.match(service, /currentWindowByAssetKey/);
  assert.match(component, /currentRosterWindow/);
  assert.match(component, /buildRosterWindowProgressMarkers/);
  assert.match(component, /this\.row\(\)\?\.ownership\?\.area === 'active'[\s\S]*?\? undefined/);
  assert.match(template, /currentScheduleContextLabel\(\)/);
  assert.match(template, /Next-six lens/);
  assert.match(template, /factor\.value/);
  assert.match(styles, /player-intel-opportunity-lens/);
  assert.doesNotMatch(template, /role="dialog"|innerHTML|overlay/i);
  assert.doesNotMatch(styles, /position:\s*(?:fixed|sticky)|backdrop-filter/i);
});

test('A1E preserves Scoring V3, Projection V11, Rules, indexes, and inactive safety controls', async () => {
  const [
    scoringRules,
    scoringEngine,
    projectionV11,
    firestoreRules,
    firestoreIndexes,
    freezeSource,
    appCheckSource,
    canarySource,
    cacheSource,
  ] = await Promise.all([
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/scoring/scoring-engine.ts'),
    read('src/app/core/projection/projection-v11.util.ts'),
    read('firestore.rules'),
    read('firestore.indexes.json'),
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
  assert.equal(createHash('sha256').update(firestoreRules).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreRules);
  assert.equal(createHash('sha256').update(firestoreIndexes).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreIndexes);
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

test('A1E remains preserved under RC44 and permanently records slot-window parity and the opportunity lens', async () => {
  const [runtime, productionRuntime, freezeSource, packageSource, roadmap, docsRoadmap, docs, readme, runbook] = await Promise.all([
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('config/release-freeze/beta-freeze-policy.json'),
    read('package.json'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_PRODUCT_A1E_WINDOW_SYNC_OPPORTUNITY.md'),
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
  assert.match(packageJson.scripts['verify:batcha1e:core'], /verify:batcha1d:core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batcho1i:core/);
  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.50/);
  assert.match(roadmap, /# \[x\] A1\.4/);
  assert.match(roadmap, /# \[x\] A1\.15/);
  assert.match(roadmap, /# \[x\] LOG\.52 2026-08-18/);
  assert.match(docs, /authoritative .*roster-slot window/i);
  assert.match(docs, /Next-six lens/);
  assert.match(docs, /site-first/i);
  assert.match(readme, /Release Candidate 59 \/ Operations Batch O1I/);
  assert.match(readme, /RINKRAT_PRODUCT_A1E_WINDOW_SYNC_OPPORTUNITY\.md/);
  assert.match(runbook, /npm run verify:batcho1i/);
  assert.match(runbook, /rinkrat-rc59-validation\.json/);
  assert.match(runbook, /rinkrat-rc59-invite-beta/);
});
