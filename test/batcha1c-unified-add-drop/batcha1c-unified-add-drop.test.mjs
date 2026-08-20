import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import {
  buildLeaguePlayerBoardRows,
  filterLeaguePlayerBoardRows,
} from '../../src/app/core/player/league-player-board.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function asset(assetKey, name, position, seasonPoints, nextSix, extras = {}) {
  return {
    assetType: 'skater',
    assetKey,
    position,
    player: {
      id: Number(assetKey.replace(/\D/g, '')) || 1,
      fullName: name,
      position,
      nhlTeamAbbreviation: extras.team ?? 'VGK',
      teamLogoUrl: `https://example.test/${assetKey}.svg`,
      headshotUrl: `https://example.test/${assetKey}.png`,
    },
    currentSeasonFantasyPoints: seasonPoints,
    seasonFantasyPointsPerGame: seasonPoints === null ? null : seasonPoints / 40,
    availabilityAdjustedCyclePoints: nextSix,
    projectedCyclePoints: nextSix,
    currentTeamCycleNumber: extras.cycle ?? 2,
    currentTeamCycleGames: extras.markers ?? [],
    availabilityStatus: extras.status ?? 'active',
    availabilityLabel: extras.label ?? 'Active',
    availabilityReturnDate: extras.returnDate ?? null,
  };
}

test('the former Player Board and Add / Drop routes are one guarded Add / Drop surface', async () => {
  const [routes, navbar, leagueHq, standings] = await Promise.all([
    read('src/app/app.routes.ts'),
    read('src/app/shared/navbar/navbar.html'),
    read('src/app/features/leagues/league-detail/league-detail.html'),
    read('src/app/features/leagues/league-standings/league-standings.html'),
  ]);

  assert.match(routes, /path: 'leagues\/:leagueId\/players',[\s\S]*?title: 'Add \/ Drop'[\s\S]*?canDeactivate: \[pendingRosterActionGuard\][\s\S]*?FreeAgents/);
  assert.match(routes, /path: 'leagues\/:leagueId\/free-agents',[\s\S]*?redirectTo: 'leagues\/:leagueId\/players'/);
  assert.match(routes, /path: 'leagues\/:leagueId\/players\/:assetKey',[\s\S]*?Player Intel/);
  assert.match(navbar, /\['\/leagues', activeLeagueId, 'players'\][\s\S]*?>\s*Add\/Drop\s*</);
  assert.match(leagueHq, /\['\/leagues', leagueId, 'players'\][\s\S]*?<strong>Add \/ Drop<\/strong>/);
  assert.match(standings, /\['\/leagues', leagueId, 'players'\][\s\S]*?>\s*Add \/ Drop\s*</);

  await assert.rejects(
    access(new URL('src/app/features/players/league-player-board/league-player-board.ts', ROOT)),
  );
});

test('free agents and exact-position Roster Fit are the default directory choices', async () => {
  const component = await read('src/app/features/free-agents/free-agents.ts');
  const template = await read('src/app/features/free-agents/free-agents.html');

  assert.match(component, /boardStatusFilter = signal<LeaguePlayerBoardStatusFilter>\('free-agent'\)/);
  assert.match(component, /boardSortMode = signal<LeaguePlayerBoardSortMode>\('roster-fit'\)/);
  assert.match(component, /const UNIFIED_PLAYER_PAGE_SIZE = 50/);
  assert.match(template, /<option value="free-agent">Free agents/);
  assert.match(template, /<option value="all">All players/);
  assert.match(template, /<option value="rostered">Rostered/);
  assert.match(template, /<option value="waivers">Waivers/);
  assert.match(template, /<option value="watched">Watched/);
  assert.match(template, /<option value="roster-fit">Roster fit \(for you\)<\/option>/);
  assert.match(template, /<option value="next-six">Next 6 projection<\/option>/);
});

test('next-six sorting and free-agent filtering stay deterministic while all-player ranks remain available', () => {
  const rows = buildLeaguePlayerBoardRows({
    assets: [
      asset('skater-1', 'First Free Agent', 'C', 70, 40),
      asset('skater-2', 'Second Free Agent', 'LW', 95, 55),
      asset('skater-3', 'Rostered Star', 'D', 120, 48),
    ],
    ownershipByAssetKey: new Map([['skater-3', {
      assetKey: 'skater-3',
      ownerId: 'owner-3',
      teamName: 'Rink Rats',
      managerName: 'Manager Three',
      area: 'active',
      slotLabel: 'D1',
    }]]),
  });

  assert.deepEqual(
    filterLeaguePlayerBoardRows(rows, { status: 'free-agent', sortMode: 'next-six' })
      .map((row) => row.assetKey),
    ['skater-2', 'skater-1'],
  );
  assert.equal(rows.find((row) => row.assetKey === 'skater-3')?.overallRank, 1);
  assert.equal(rows.find((row) => row.assetKey === 'skater-2')?.nextSixOverallRank, 1);
});

test('each player row keeps Player Intel, injury return context, Matchup number, and a two-row six-game tracker', async () => {
  const [template, styles, component] = await Promise.all([
    read('src/app/features/free-agents/free-agents.html'),
    read('src/app/features/free-agents/free-agents.css'),
    read('src/app/features/free-agents/free-agents.ts'),
  ]);

  assert.match(template, /\['\/leagues', leagueId, 'players', row\.assetKey\]/);
  assert.match(template, /getBoardAvailabilityLabel\(row\.asset\)/);
  assert.match(template, /getBoardAvailabilityReturnLabel\(row\.asset\)/);
  assert.match(template, /getBoardCycleLabel\(row\)/);
  assert.match(template, /getBoardCycleMarker\(row, dotIndex\)/);
  assert.match(template, /@for \(dotIndex of cycleDotSlots/);
  assert.match(template, />Season<\/small>/);
  assert.match(component, /return `Return \$\{this\.formatCompactDate\(returnDate\)\}`/);
  assert.match(component, /'Return date TBD'/);
  assert.match(styles, /unified-player-main[\s\S]*?grid-template-columns:\s*58px minmax\(145px, 1\.15fr\) 86px minmax\(270px, 1\.55fr\)/);
  assert.match(styles, /unified-cycle-dots[\s\S]*?grid-template-columns:\s*repeat\(3, 20px\)/);
  assert.match(styles, /cycle-marker-played[\s\S]*?#8ce7b0/);
  assert.match(styles, /cycle-marker-missed[\s\S]*?#ff8b8b/);
  assert.match(styles, /cycle-marker-upcoming[\s\S]*?#ffe187/);
});

test('only free agents and public waivers expose Add or Claim while rostered players remain inspectable', async () => {
  const [template, component] = await Promise.all([
    read('src/app/features/free-agents/free-agents.html'),
    read('src/app/features/free-agents/free-agents.ts'),
  ]);

  assert.match(template, /row\.status === 'free-agent' \|\| row\.status === 'waivers'/);
  assert.match(template, /\(click\)="startBoardTransaction\(row\)"/);
  assert.match(component, /if \(row\.status === 'free-agent'\) \{[\s\S]*?return true/);
  assert.match(component, /waiver && waiver\.droppedByOwnerId !== this\.userId/);
  assert.match(component, /getWaiverActionLabel/);
  assert.doesNotMatch(template, /row\.status === 'rostered'[\s\S]{0,120}\(click\)="startBoardTransaction/);
});

test('the second step reuses the player-row layout and limits choices to computed valid roster candidates', async () => {
  const [template, component] = await Promise.all([
    read('src/app/features/free-agents/free-agents.html'),
    read('src/app/features/free-agents/free-agents.ts'),
  ]);

  assert.match(template, /class="transaction-incoming-row unified-player-row rr-card"/);
  assert.match(template, /class="unified-player-row transaction-roster-row rr-card"/);
  assert.match(template, /@for \(candidate of dropCandidates\(\)/);
  assert.match(template, /\['\/leagues', leagueId, 'players', outgoing\.assetKey\]/);
  assert.match(template, /getDropCandidateActionLabel\(candidate\)/);
  assert.match(component, /return candidate\.moveType === 'open-slot' \? 'Use slot' : 'Select to drop'/);
  assert.match(template, /RinkRat verifies the exact six-game timeline before confirmation/);
  assert.match(component, /roster\.activeSlots[\s\S]*?slot\.position === addAsset\.position/);
  assert.match(component, /!slot\.pendingMove/);
  assert.match(component, /roster\.benchSlots/);
  assert.match(component, /isBenchCandidateReservedForActiveSwap/);
});

test('the unified browser remains read-only and delegates competitive mutations to existing server authorities', async () => {
  const component = await read('src/app/features/free-agents/free-agents.ts');

  assert.match(component, /addDropRosterAsset/);
  assert.match(component, /addFreeAgentToOpenRosterSlot/);
  assert.match(component, /placeWaiverClaim/);
  assert.match(component, /processWaiver/);
  assert.match(component, /cancelQueuedRosterMove/);
  assert.doesNotMatch(component, /\b(?:setDoc|updateDoc|deleteDoc|writeBatch)\s*\(/);
});

test('the browser follows only the exact current Projection V11 pointer and reloads chunks when its snapshot changes', async () => {
  const [projectionService, unifiedComponent] = await Promise.all([
    read('src/app/core/projection/projection-snapshot.service.ts'),
    read('src/app/features/free-agents/free-agents.ts'),
  ]);

  assert.match(projectionService, /export function listenToSharedProjectionSnapshot/);
  assert.match(projectionService, /getProjectionSnapshotRef\(normalizedLeagueId, SNAPSHOT_POINTER_ID\)/);
  assert.match(projectionService, /metadata\.activeSnapshotId === lastSnapshotId/);
  assert.match(projectionService, /invalidateSharedProjectionReadCache\(normalizedLeagueId\)/);
  assert.match(projectionService, /loadSharedProjectionSnapshotById/);
  assert.equal((projectionService.match(/return onSnapshot\(/g) ?? []).length, 1);
  assert.match(unifiedComponent, /listenToSharedProjectionSnapshot/);
  assert.match(unifiedComponent, /this\.playerPool\.set\(snapshot\.assets\)/);
  assert.match(unifiedComponent, /loadSharedProjectionSnapshotFresh/);
});

test('historical replay queues refresh after scoring and projection completion catches up to a newer replay date', async () => {
  const [automation, authority] = await Promise.all([
    read('functions/src/league-automation.ts'),
    read('functions/src/projection-authority.ts'),
  ]);

  const scoringIndex = automation.indexOf('const result = await runHistoricalReplayAutomationWithRetry(leagueId);');
  const queueIndex = automation.indexOf('await queueServerProjectionSnapshotRefresh({', scoringIndex);
  assert.ok(scoringIndex >= 0 && queueIndex > scoringIndex);
  assert.match(automation, /if \(releasedGameCount > 0\) \{[\s\S]*?try \{[\s\S]*?queueServerProjectionSnapshotRefresh/);
  assert.match(automation, /Historical replay completed, but the non-blocking player-stat refresh was not queued/);
  assert.match(authority, /async function queueHistoricalReplayProjectionCatchUp/);
  assert.match(authority, /completedRequestId\.startsWith\('projection-replay-'\)/);
  assert.match(authority, /getExpectedProjectionSnapshotContext/);
  assert.match(authority, /completedAsOfDate >= expectedContext\.projectionAsOfDate/);
  assert.match(authority, /replay-catchup-/);
  assert.match(authority, /Projection V11 completed, but a newer replay date could not be queued for catch-up/);
});

test('A1C stays mobile-bounded and adds no transaction modal, broad projection listener, Rule, index, or TTL policy', async () => {
  const [template, styles, routes, indexes, ttl] = await Promise.all([
    read('src/app/features/free-agents/free-agents.html'),
    read('src/app/features/free-agents/free-agents.css'),
    read('src/app/app.routes.ts'),
    read('firestore.indexes.json'),
    read('config/firestore-ttl-baseline.json'),
  ]);

  assert.match(template, /hiddenBoardRowCount/);
  assert.match(styles, /@media \(max-width: 560px\)/);
  assert.match(styles, /min-height:\s*var\(--rr-mobile-control-min-height\)/);
  assert.doesNotMatch(template, /role="dialog"|viewport-overlay|action-sheet|backdrop/i);
  assert.doesNotMatch(styles, /backdrop-filter/i);
  assert.match(routes, /pendingRosterActionGuard/);
  assert.doesNotMatch(indexes, /playerBoard|addDrop/);
  assert.doesNotMatch(ttl, /playerBoard|addDrop/);
});

test('A1C preserves scoring, Projection V11, Rules, indexes, and inactive safety controls', async () => {
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

test('the current release retains A1C while A1D advances release operations to RC42', async () => {
  const [runtime, productionRuntime, freezeSource, packageSource, roadmap, docsRoadmap, docs, readme, runbook] = await Promise.all([
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('config/release-freeze/beta-freeze-policy.json'),
    read('package.json'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_PRODUCT_A1C_UNIFIED_ADD_DROP.md'),
    read('README.md'),
    read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
  ]);
  const freeze = JSON.parse(freezeSource);
  const packageJson = JSON.parse(packageSource);

  assert.match(runtime, /Release Candidate 54/);
  assert.match(productionRuntime, /Release Candidate 54/);
  assert.equal(freeze.releaseLabel, 'Release Candidate 54');
  assert.equal(freeze.verificationCommand, 'npm run verify:batcho1d');
  assert.equal(freeze.defaultTag, 'rinkrat-rc54-invite-beta');
  assert.match(packageJson.scripts['verify:batcha1d:core'], /verify:batcha1c:core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batcho1d:core/);
  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.45/);
  assert.match(roadmap, /# \[x\] A1\.13 Unify Player Board and Add \/ Drop/);
  assert.match(roadmap, /# \[x\] LOG\.50 2026-08-18/);
  assert.match(docs, /processHistoricalReplayAdvance,functions:processProjectionGenerationTask/);
  assert.match(docs, /site-first/i);
  assert.match(readme, /Release Candidate 54 \/ Operations Batch O1D/);
  assert.match(readme, /RINKRAT_PRODUCT_A1C_UNIFIED_ADD_DROP\.md/);
  assert.match(runbook, /npm run verify:batcho1d/);
  assert.match(runbook, /rinkrat-rc54-validation\.json/);
  assert.match(runbook, /rinkrat-rc54-invite-beta/);
});
