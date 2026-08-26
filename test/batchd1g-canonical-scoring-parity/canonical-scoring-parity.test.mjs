import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import {
  applyCanonicalNhlFinalSettlements,
  buildCanonicalNhlGameFacts,
  buildCanonicalNhlGameHashes,
  CANONICAL_NHL_FACTS_SCHEMA_VERSION,
} from '../../functions/src/shared/core/nhl/nhl-canonical-facts.util.ts';

const ROOT = new URL('../../', import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const read = (relativePath) => readFile(new URL(relativePath, ROOT), 'utf8');
const sha256 = async (relativePath) => createHash('sha256')
  .update(await readFile(new URL(relativePath, ROOT)))
  .digest('hex');

const STAGE = mkdtempSync(path.join(tmpdir(), 'rinkrat-d1g-parity-'));
const SHARED = path.join(STAGE, 'shared/core');
for (const directory of ['draft', 'player', 'scoring', 'nhl']) {
  mkdirSync(path.join(SHARED, directory), { recursive: true });
}
for (const relativePath of [
  'draft/draft.models.ts',
  'player/player.models.ts',
  'scoring/scoring-rules.ts',
  'scoring/scoring-engine.ts',
  'nhl/nhl-canonical-scoring-parity.util.ts',
]) {
  cpSync(
    path.join(ROOT_PATH, 'functions/src/shared/core', relativePath),
    path.join(SHARED, relativePath),
  );
}
writeFileSync(path.join(SHARED, 'nhl/nhl-canonical-facts.util.ts'), `
export interface CanonicalNhlSkaterFacts {
  playerId: number; teamAbbreviation: string; position: string; goals: number;
  assists: number; primaryAssists: number; secondaryAssists: number;
  shotsOnGoal: number; hits: number; blockedShots: number; plusMinus: number;
  powerPlayGoals: number; timeOnIceSeconds: number;
}
export interface CanonicalNhlGoalieFacts {
  playerId: number; teamAbbreviation: string; goalsAgainst: number; saves: number;
  shotsAgainst: number; starter: boolean; decision: string; timeOnIceSeconds: number;
}
export interface CanonicalNhlSkaterFinalSettlement {
  playerId: number; goals: number; assists: number; shotsOnGoal: number;
  plusMinus: number; powerPlayPoints: number; shortHandedPoints: number;
  gameWinningGoal: boolean; overtimeGoal: boolean; timeOnIceSeconds: number;
  source: 'player-game-log';
}
export interface CanonicalNhlGoalEvent {
  eventId: number | null; period: number | null; periodType: string;
  timeInPeriod: string; scoringPlayerId: number | null;
  assist1PlayerId: number | null; assist2PlayerId: number | null;
  situationCode: string; homeScore: number | null; awayScore: number | null;
}
export interface CanonicalNhlGameFacts {
  schemaVersion: 2; gameId: number; gameState: 'scheduled' | 'live' | 'final';
  sourceGameState: string; sourceGameScheduleState: string; gameDate: string;
  startTimeUTC: string; period: number | null; periodType: string;
  clockTimeRemaining: string; clockRunning: boolean; inIntermission: boolean;
  homeTeamAbbreviation: string; awayTeamAbbreviation: string;
  homeScore: number; awayScore: number; skaters: CanonicalNhlSkaterFacts[];
  goalies: CanonicalNhlGoalieFacts[]; goals: CanonicalNhlGoalEvent[];
  finalSettlements: CanonicalNhlSkaterFinalSettlement[];
  finalSettlementPlayerIds: number[]; playerIds: number[]; teamAbbreviations: string[];
}
`);
const TSCONFIG = path.join(STAGE, 'tsconfig.json');
writeFileSync(TSCONFIG, JSON.stringify({
  compilerOptions: {
    target: 'ES2022', module: 'Node16', moduleResolution: 'Node16', strict: true,
    skipLibCheck: true, types: [], rootDir: STAGE, outDir: path.join(STAGE, 'lib'),
  },
  files: [
    path.join(SHARED, 'draft/draft.models.ts'),
    path.join(SHARED, 'player/player.models.ts'),
    path.join(SHARED, 'scoring/scoring-rules.ts'),
    path.join(SHARED, 'scoring/scoring-engine.ts'),
    path.join(SHARED, 'nhl/nhl-canonical-facts.util.ts'),
    path.join(SHARED, 'nhl/nhl-canonical-scoring-parity.util.ts'),
  ],
}, null, 2));
execFileSync('tsc', ['--project', TSCONFIG], { stdio: 'pipe' });
const require = createRequire(import.meta.url);
const parity = require(path.join(STAGE, 'lib/shared/core/nhl/nhl-canonical-scoring-parity.util.js'));
const scoring = require(path.join(STAGE, 'lib/shared/core/scoring/scoring-engine.js'));
const rulesModule = require(path.join(STAGE, 'lib/shared/core/scoring/scoring-rules.js'));

function rawFinalGame() {
  return {
    scoreboard: {
      gameId: 2026020001, gameState: 'FINAL', gameScheduleState: 'OK', period: 3,
      periodType: 'REG', clockTimeRemaining: '00:00', clockRunning: false,
      inIntermission: false, gameDate: '2026-10-10', startTimeUTC: '2026-10-11T00:00:00Z',
    },
    boxscore: {
      homeTeam: { abbrev: 'MIN', score: 3 }, awayTeam: { abbrev: 'WPG', score: 1 },
      playerByGameStats: {
        homeTeam: {
          forwards: [{ playerId: 101, name: { default: 'Home Skater' }, position: 'C', goals: 1, assists: 1, points: 2, plusMinus: 1, hits: 2, powerPlayGoals: 0, sog: 3, toi: '20:30', blockedShots: 1 }],
          defense: [],
          goalies: [{ playerId: 201, name: { default: 'Home Goalie' }, position: 'G', goalsAgainst: 1, toi: '60:00', starter: true, decision: 'W', shotsAgainst: 31, saves: 30 }],
        },
        awayTeam: { forwards: [], defense: [], goalies: [{ playerId: 202, name: { default: 'Away Goalie' }, position: 'G', goalsAgainst: 3, toi: '60:00', starter: true, decision: 'L', shotsAgainst: 29, saves: 26 }] },
      },
    },
    playByPlay: { plays: [
      { eventId: 1, typeDescKey: 'goal', periodDescriptor: { number: 1, periodType: 'REG' }, timeInPeriod: '05:00', details: { scoringPlayerId: 101, assist1PlayerId: 102, situationCode: '1551', homeScore: 1, awayScore: 0 } },
      { eventId: 2, typeDescKey: 'goal', periodDescriptor: { number: 3, periodType: 'REG' }, timeInPeriod: '19:00', details: { scoringPlayerId: 103, assist1PlayerId: 101, situationCode: '1551', homeScore: 3, awayScore: 1 } },
    ] },
  };
}

function parityFacts() {
  const facts = buildCanonicalNhlGameFacts(rawFinalGame());
  return applyCanonicalNhlFinalSettlements({
    facts,
    entriesByPlayerId: new Map([[101, {
      gameId: 2026020001, goals: 1, assists: 1, shots: 3, plusMinus: 1,
      powerPlayPoints: 1, shorthandedPoints: 0, gameWinningGoals: 1,
      otGoals: 0, toi: '20:30',
    }]]),
  });
}

const skaterAsset = {
  assetType: 'skater', assetKey: 'skater:101', position: 'C',
  player: { id: 101, fullName: 'Home Skater', position: 'C', nhlTeamAbbreviation: 'MIN' },
};
const goalieAsset = {
  assetType: 'team-goalie-unit', assetKey: 'goalie:MIN', position: 'G',
  teamName: 'Minnesota', teamAbbreviation: 'MIN',
};

test('final player logs settle one canonical game record and change its final hash', () => {
  const before = buildCanonicalNhlGameFacts(rawFinalGame());
  const beforeHash = buildCanonicalNhlGameHashes(before).finalSettlementHash;
  const after = parityFacts();
  const afterHash = buildCanonicalNhlGameHashes(after).finalSettlementHash;

  assert.equal(CANONICAL_NHL_FACTS_SCHEMA_VERSION, 2);
  assert.equal(after.finalSettlements.length, 1);
  assert.deepEqual(after.finalSettlementPlayerIds, [101]);
  assert.deepEqual(after.finalSettlements[0], {
    playerId: 101, goals: 1, assists: 1, shotsOnGoal: 3, plusMinus: 1,
    powerPlayPoints: 1, shortHandedPoints: 0, gameWinningGoal: true,
    overtimeGoal: false, timeOnIceSeconds: 1230, source: 'player-game-log',
  });
  assert.notEqual(beforeHash, afterHash);
});

test('canonical skater and goalie calculations match the direct scoring engine', () => {
  const facts = parityFacts();
  const directSkater = Number(scoring.calculateSkaterGameBreakdown({
    position: 'F', goals: 1, primaryAssists: 1, secondaryAssists: 0,
    shotsOnGoal: 3, hits: 2, blockedShots: 1, plusMinus: 1,
    powerPlayPoints: 1, shortHandedPoints: 0, gameWinningGoal: true,
    overtimeGoal: false, timeOnIceMinutes: 20.5,
  }, rulesModule.defaultScoringRules).total.toFixed(1));
  const skater = parity.calculateCanonicalAssetGameScore({
    asset: skaterAsset, facts, gameIsFinal: true,
    scoringRules: rulesModule.defaultScoringRules,
  });
  const directGoalie = Number(scoring.calculateGoalieGameBreakdown({
    saves: 30, shotsAgainst: 31, won: true, shutout: false,
  }, rulesModule.defaultScoringRules).total.toFixed(1));
  const goalie = parity.calculateCanonicalAssetGameScore({
    asset: goalieAsset, facts, gameIsFinal: true,
    scoringRules: rulesModule.defaultScoringRules,
  });

  assert.equal(skater.complete, true);
  assert.equal(skater.points, directSkater);
  assert.equal(goalie.complete, true);
  assert.equal(goalie.points, directGoalie);
});

test('parity reports matched, mismatch, and incomplete without becoming authority', () => {
  const facts = parityFacts();
  const game = { sourceVersion: buildCanonicalNhlGameHashes(facts).sourceVersion, facts };
  const canonical = parity.calculateCanonicalAssetGameScore({ asset: skaterAsset, facts, gameIsFinal: true, scoringRules: rulesModule.defaultScoringRules });
  const matched = parity.compareDirectAndCanonicalGameScore({ gameId: facts.gameId, asset: skaterAsset, canonicalGame: game, gameIsFinal: true, scoringRules: rulesModule.defaultScoringRules, directPoints: canonical.points, directAppeared: true });
  const mismatch = parity.compareDirectAndCanonicalGameScore({ gameId: facts.gameId, asset: skaterAsset, canonicalGame: game, gameIsFinal: true, scoringRules: rulesModule.defaultScoringRules, directPoints: canonical.points + 1, directAppeared: true });
  const incompleteFacts = { ...facts, finalSettlements: [], finalSettlementPlayerIds: [] };
  const incomplete = parity.compareDirectAndCanonicalGameScore({ gameId: facts.gameId, asset: skaterAsset, canonicalGame: { sourceVersion: 'v', facts: incompleteFacts }, gameIsFinal: true, scoringRules: rulesModule.defaultScoringRules, directPoints: canonical.points, directAppeared: true });

  assert.equal(matched.status, 'matched');
  assert.equal(mismatch.status, 'mismatch');
  assert.equal(incomplete.status, 'incomplete');
  assert.equal(incomplete.canonicalPoints, null);
});

test('D1G centralizes final settlement and keeps canonical scoring shadow-only', async () => {
  const [feed, automation, cycle, paritySource] = await Promise.all([
    read('functions/src/nhl-canonical-impact-feed.ts'),
    read('functions/src/league-automation.ts'),
    read('functions/src/shared/core/cycle/cycle-scoring.service.ts'),
    read('functions/src/shared/core/nhl/nhl-canonical-scoring-parity.util.ts'),
  ]);

  assert.match(feed, /FINAL_SETTLEMENT_CONCURRENCY\s*=\s*6/);
  assert.match(feed, /FINAL_SETTLEMENT_SECOND_CHECKPOINT_MILLISECONDS\s*=\s*5 \* 60 \* 1000/);
  assert.match(feed, /FINAL_SETTLEMENT_FINAL_CHECKPOINT_MILLISECONDS\s*=\s*28 \* 60 \* 1000/);
  assert.match(feed, /applyCanonicalNhlFinalSettlements/);
  assert.match(feed, /gameVersions:\s*request\.gameVersions/);
  assert.doesNotMatch(feed, /runLeagueAutomation\(/);

  assert.match(automation, /shadowOnly:\s*true/);
  assert.match(automation, /authoritativeReadsEnabled:\s*false/);
  assert.match(automation, /canonical-shadow-parity/);
  assert.match(automation, /canonicalParityCohort\.passing/);
  assert.match(automation, /canonicalGameVersions/);
  assert.match(automation, /canonical-game-version-set-invalid/);
  assert.match(cycle, /compareDirectAndCanonicalGameScore/);
  assert.match(cycle, /directPoints:\s*scoreResult\.points/);
  assert.match(paritySource, /calculateCanonicalAssetGameScore/);
});

test('coalesced tasks carry the exact canonical game/version set and older tasks cannot prove newer data', async () => {
  const automation = await read('functions/src/league-automation.ts');

  assert.match(automation, /canonicalPendingGameVersions/);
  assert.match(automation, /buildCanonicalLeagueAggregateSourceVersion/);
  assert.match(automation, /canonicalGameIds:\s*schedule\.canonicalGameIds/);
  assert.match(automation, /canonicalGameVersions:\s*schedule\.canonicalGameVersions/);
  assert.match(automation, /gameIds:\s*payloadCanonicalGameIds/);
  assert.match(automation, /payloadCanonicalAggregateVersion === payloadCanonicalSourceVersion/);
  assert.match(automation, /decideCanonicalRequestCompletion/);
  assert.match(automation, /pending-follow-up/);
});

test('Primary requires current parity from every exact Canary league', async () => {
  const [automation, service, template] = await Promise.all([
    read('functions/src/league-automation.ts'),
    read('src/app/core/admin/scoring-queue-control.service.ts'),
    read('src/app/features/release/scoring-queue-control-center/scoring-queue-control-center.html'),
  ]);

  assert.match(automation, /loadCanonicalScoringParityCohort/);
  assert.match(automation, /passingLeagueCount === leagueIds\.length/);
  assert.match(automation, /minimumComparedAtMilliseconds/);
  assert.match(service, /canonicalParityExpectedLeagueCount/);
  assert.match(service, /canonicalParityCohortPassing/);
  assert.match(template, /Canary cohort passes/);
  assert.match(template, /shadow only/i);
});

test('D1G preserves competitive formulas, Projection V11, Rules, and indexes', async () => {
  const protectedPaths = [
    ['src/app/core/scoring/scoring-rules.ts', 'scoringRules'],
    ['functions/src/shared/core/scoring/scoring-rules.ts', 'scoringRules'],
    ['src/app/core/scoring/scoring-engine.ts', 'scoringEngine'],
    ['functions/src/shared/core/scoring/scoring-engine.ts', 'scoringEngine'],
    ['src/app/core/projection/projection-v11.util.ts', 'projectionV11'],
    ['functions/src/shared/core/projection/projection-v11.util.ts', 'projectionV11'],
    ['firestore.rules', 'firestoreRules'],
    ['firestore.indexes.json', 'firestoreIndexes'],
  ];

  for (const [relativePath, hashKey] of protectedPaths) {
    assert.equal(await sha256(relativePath), PROTECTED_SOURCE_HASHES[hashKey], relativePath);
  }
});

test('D1G release scripts, documentation, and synchronized roadmaps are present', async () => {
  const [packageJson, readme, docs, rootRoadmap, docsRoadmap] = await Promise.all([
    read('package.json'), read('README.md'), read('docs/RINKRAT_DATA_D1G_CANONICAL_SCORING_PARITY.md'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'), read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
  ]);
  const scripts = JSON.parse(packageJson).scripts;

  assert.match(scripts['test:batchd1g:run'], /batchd1g-canonical-scoring-parity/);
  assert.match(scripts['verify:batchd1g:core'], /verify:batchd1f2:core/);
  assert.match(readme, /RINKRAT_DATA_D1G_CANONICAL_SCORING_PARITY/);
  assert.match(docs, /direct NHL scoring remains authoritative/i);
  assert.match(rootRoadmap, /Version 1\.54\.5/);
  assert.equal(rootRoadmap, docsRoadmap);
});
