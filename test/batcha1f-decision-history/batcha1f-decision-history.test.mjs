import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildManagerDecisionHistoryRows,
  isCompletedManagerDecisionType,
} from '../../src/app/core/transactions/manager-decision-history.util.ts';
import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function playerRow({
  assetKey,
  name,
  team = 'EDM',
  position = 'C',
  season = 50,
  nextSix = 30,
  positionRank = 5,
  status = 'free-agent',
  ownership = null,
} = {}) {
  return {
    assetKey,
    name,
    nhlTeamAbbreviation: team,
    position,
    seasonFantasyPoints: season,
    nextSixProjection: nextSix,
    positionRank,
    status,
    ownership,
    headshotUrl: null,
    logoUrl: null,
  };
}

function skater(assetKey, name, team = 'EDM', position = 'C') {
  const playerId = Number(assetKey.replace(/\D/g, '')) || 1;
  return {
    assetType: 'skater',
    assetKey,
    position,
    player: {
      id: playerId,
      fullName: name,
      nhlTeamAbbreviation: team,
    },
  };
}

test('Decision History includes completed manager choices and excludes unresolved operations', () => {
  for (const type of ['add-drop', 'add-open-slot', 'waiver-award', 'slot-move-activated']) {
    assert.equal(isCompletedManagerDecisionType(type), true, type);
  }

  for (const type of [
    'waiver-claim',
    'queue-add-drop',
    'queue-add-open-slot',
    'queue-waiver-award',
    'cancel-queued-move',
    'waiver-cleared',
  ]) {
    assert.equal(isCompletedManagerDecisionType(type), false, type);
  }
});

test('completed add/drop history joins recorded assets to current Player Board metrics', () => {
  const rows = buildManagerDecisionHistoryRows([
    {
      id: 'transaction-1',
      type: 'add-drop',
      ownerId: 'owner-a',
      addedAsset: skater('skater-1', 'Incoming Player'),
      droppedAsset: skater('skater-2', 'Outgoing Player', 'BOS', 'LW'),
      effectiveCycleNumber: 4,
      effectiveLabel: 'Matchup 4',
      createdAt: new Date('2026-11-01T12:00:00Z'),
    },
  ], [
    playerRow({ assetKey: 'skater-1', name: 'Incoming Player', season: 80, nextSix: 35, positionRank: 3 }),
    playerRow({ assetKey: 'skater-2', name: 'Outgoing Player', team: 'BOS', position: 'LW', season: 60, nextSix: 25, positionRank: 12 }),
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'Add / Drop');
  assert.equal(rows[0].effectiveCycleNumber, 4);
  assert.equal(rows[0].added.name, 'Incoming Player');
  assert.equal(rows[0].dropped?.name, 'Outgoing Player');
  assert.equal(rows[0].currentSeasonDifference, 20);
  assert.equal(rows[0].currentNextSixDifference, 10);
});

test('open-slot and waiver-award outcomes remain understandable without inventing missing current data', () => {
  const rows = buildManagerDecisionHistoryRows([
    {
      id: 'transaction-open',
      type: 'add-open-slot',
      ownerId: 'owner-a',
      addedAsset: skater('skater-3', 'Open Slot Add', 'TOR', 'RW'),
      droppedAsset: null,
      createdAt: '2026-11-03T12:00:00Z',
    },
    {
      id: 'transaction-waiver',
      type: 'waiver-award',
      ownerId: 'owner-a',
      waiverAsset: skater('skater-4', 'Waiver Winner', 'NYR', 'D'),
      droppedAsset: skater('skater-5', 'Dropped Asset', 'MTL', 'D'),
      createdAt: '2026-11-04T12:00:00Z',
    },
  ], []);

  assert.deepEqual(rows.map((row) => row.label), ['Waiver claim won', 'Added to open slot']);
  assert.equal(rows[0].added.current, null);
  assert.equal(rows[0].currentSeasonDifference, null);
  assert.equal(rows[1].dropped, null);
});

test('the private transaction fetch is bounded and reuses the existing owner-only projection', async () => {
  const service = await read('src/app/core/draft/draft.service.ts');

  assert.match(service, /export async function getOwnerTransactionsOnce/);
  assert.match(service, /Math\.max\(1, Math\.min\(100, Math\.trunc\(maximumResults\)\)\)/);
  assert.match(service, /getOwnerTransactionsRef\(leagueId, ownerId\)/);
  assert.match(service, /orderBy\('occurredAt', 'desc'\)/);
  assert.match(service, /limit\(normalizedLimit\)/);
  const oneTimeReadSource = service.slice(
    service.indexOf('export async function getOwnerTransactionsOnce'),
    service.indexOf('export function listenToOwnerTransactions'),
  );
  assert.doesNotMatch(oneTimeReadSource, /onSnapshot\(/);
});

test('Decision History is a guarded, secondary route linked from Add Drop and Team Settings', async () => {
  const [routes, addDrop, teamSettings] = await Promise.all([
    read('src/app/app.routes.ts'),
    read('src/app/features/free-agents/free-agents.html'),
    read('src/app/features/team/team-settings/team-settings.html'),
  ]);

  assert.match(routes, /path: 'leagues\/:leagueId\/decision-history'/);
  assert.match(routes, /canActivate: \[leagueMemberGuard\]/);
  assert.match(routes, /features\/free-agents\/decision-history\/decision-history/);
  assert.match(addDrop, /\['\/leagues', leagueId, 'decision-history'\]/);
  assert.match(teamSettings, /\['\/leagues', leagueId, 'decision-history'\]/);
});

test('the page remains bounded, current-data honest, and mobile-first', async () => {
  const [component, template, styles] = await Promise.all([
    read('src/app/features/free-agents/decision-history/decision-history.ts'),
    read('src/app/features/free-agents/decision-history/decision-history.html'),
    read('src/app/features/free-agents/decision-history/decision-history.css'),
  ]);

  assert.match(component, /getOwnerTransactionsOnce\(this\.leagueId, user\.uid, 75\)/);
  assert.match(component, /DECISION_HISTORY_PAGE_SIZE = 20/);
  assert.match(component, /buildManagerDecisionHistoryRows/);
  assert.match(template, /Today’s comparison/);
  assert.match(template, /Added − dropped today/);
  assert.match(template, /Show \{\{ hiddenCount\(\) > 20 \? 20 : hiddenCount\(\) \}\} more/);
  assert.match(styles, /@media \(max-width: 700px\)/);
  assert.match(styles, /decision-player-pair[\s\S]*?grid-template-columns: 1fr/);
  assert.doesNotMatch(template, /role="dialog"|innerHTML|viewport-overlay|action-sheet/i);
  assert.doesNotMatch(styles, /position:\s*(?:fixed|sticky)|backdrop-filter/i);
});

test('Player Intel returns to Decision History when opened from a past move', async () => {
  const [component, template] = await Promise.all([
    read('src/app/features/players/league-player-detail/league-player-detail.ts'),
    read('src/app/features/players/league-player-detail/league-player-detail.html'),
  ]);

  assert.match(component, /openedFromDecisionHistory/);
  assert.match(component, /queryParamMap\.get\('from'\) === 'decision-history'/);
  assert.match(template, /Back to Decision History/);
  assert.match(template, /openedFromDecisionHistory/);
});

test('A1F leaves competitive sources, Rules, indexes, and inactive safety controls unchanged', async () => {
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
  assert.equal(freeze.scoringRulesVersion, 3);
  assert.equal(freeze.projectionVersion, 11);
  assert.equal(freeze.requiredGamesPerRosterSlot, 6);
  assert.equal(freeze.queueMode, 'shadow');
  assert.equal(freeze.appCheckMode, 'monitor');
  assert.equal(appCheck.mode, 'monitor');
  assert.equal(canary.automaticPromotion, false);
  assert.equal(cache.mode, 'shadow');
  assert.equal(cache.authoritativeReadsEnabled, false);
});

test('A1F advances RC44, completes A1.7, and records replay refresh latency as work in progress', async () => {
  const [runtime, productionRuntime, freezeSource, packageSource, roadmap, docsRoadmap, docs, readme, runbook] = await Promise.all([
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('config/release-freeze/beta-freeze-policy.json'),
    read('package.json'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_PRODUCT_A1F_DECISION_HISTORY.md'),
    read('README.md'),
    read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
  ]);
  const freeze = JSON.parse(freezeSource);
  const packageJson = JSON.parse(packageSource);

  assert.match(runtime, /Release Candidate 46/);
  assert.match(productionRuntime, /Release Candidate 46/);
  assert.equal(freeze.releaseLabel, 'Release Candidate 46');
  assert.equal(freeze.verificationCommand, 'npm run verify:batcha1h');
  assert.equal(freeze.defaultTag, 'rinkrat-rc46-invite-beta');
  assert.match(packageJson.scripts['verify:batcha1f:core'], /verify:batcha1e:core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batcha1h:core/);
  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.37/);
  assert.match(roadmap, /# \[x\] A1\.7/);
  assert.match(roadmap, /\[~\] A1\.16 Reduce historical-replay player-data catch-up latency/);
  assert.match(roadmap, /# \[x\] LOG\.53 2026-08-18/);
  assert.match(docs, /owner-private transaction projection/);
  assert.match(docs, /current comparison/i);
  assert.match(docs, /A1\.16/);
  assert.match(readme, /Release Candidate 46 \/ Product Batch A1H/);
  assert.match(runbook, /npm run verify:batcha1h/);
  assert.match(runbook, /rinkrat-rc46-validation\.json/);
  assert.match(runbook, /rinkrat-rc46-invite-beta/);
});

test('A1F is Hosting-only and introduces no Function, Rule, index, TTL, or migration surface', async () => {
  const [docs, functionsIndex, firestoreRules, firestoreIndexes] = await Promise.all([
    read('docs/RINKRAT_PRODUCT_A1F_DECISION_HISTORY.md'),
    read('functions/src/index.ts'),
    read('firestore.rules'),
    read('firestore.indexes.json'),
  ]);

  assert.match(docs, /--only hosting:app/);
  assert.match(docs, /adds no Firestore listener, Cloud Function, Rule, index, TTL policy, migration/i);
  assert.doesNotMatch(docs, /--only functions:/);
  assert.doesNotMatch(functionsIndex, /DecisionHistory|decisionHistory|getAddDropDecisionHistory|saveAddDropDecision/);
  assert.equal(createHash('sha256').update(firestoreRules).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreRules);
  assert.equal(createHash('sha256').update(firestoreIndexes).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreIndexes);
});
