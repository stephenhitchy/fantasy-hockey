import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  alignHistoricalReplaySkaterData,
  alignHistoricalReplayTeamData,
  buildHistoricalReplaySkaterTimeline,
} from '../../functions/src/shared/core/draft/historical-replay-player-data.util.ts';
import {
  findPlayerNote,
  normalizePlayerNoteText,
  PLAYER_NOTE_MAX_CHARACTERS,
  PLAYER_NOTE_MAX_COUNT,
  PLAYER_NOTE_MAX_LINES,
  updatePlayerNoteRecords,
} from '../../functions/src/shared/core/user/player-note.util.ts';
import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function game(id, gameDate, home = 'AAA', away = 'ZZZ') {
  return {
    id,
    gameDate,
    gameType: 2,
    gameState: 'FUT',
    homeTeam: { abbrev: home },
    awayTeam: { abbrev: away },
  };
}

const targetSchedule = [
  game(9001, '2026-10-01', 'CCC', 'AAA'),
  game(9002, '2026-10-03', 'BBB', 'CCC'),
  game(9003, '2026-10-05', 'CCC', 'DDD'),
  game(9004, '2026-10-07', 'EEE', 'CCC'),
  game(9005, '2026-10-09', 'CCC', 'FFF'),
  game(9006, '2026-10-11', 'GGG', 'CCC'),
  game(9007, '2026-10-13', 'CCC', 'HHH'),
];

const sourceSchedules = new Map([
  ['AAA', [
    game(101, '2025-10-01', 'AAA', 'ZZZ'),
    game(102, '2025-10-03', 'YYY', 'AAA'),
    game(103, '2025-10-05', 'AAA', 'XXX'),
  ]],
  ['BBB', [
    game(201, '2025-10-01', 'BBB', 'ZZZ'),
    game(202, '2025-10-03', 'YYY', 'BBB'),
    game(203, '2025-10-05', 'BBB', 'XXX'),
    game(204, '2025-10-07', 'WWW', 'BBB'),
    game(205, '2025-10-09', 'BBB', 'VVV'),
    game(206, '2025-10-11', 'UUU', 'BBB'),
  ]],
]);

const skaterGames = [
  { gameId: 101, gameDate: '2025-10-01', teamAbbreviation: 'AAA', goals: 1 },
  { gameId: 103, gameDate: '2025-10-05', teamAbbreviation: 'AAA', goals: 2 },
  { gameId: 204, gameDate: '2025-10-07', teamAbbreviation: 'BBB', goals: 3 },
  { gameId: 206, gameDate: '2025-10-11', teamAbbreviation: 'BBB', goals: 4 },
];

test('replay skater timelines preserve source team games and trade segments', () => {
  const timeline = buildHistoricalReplaySkaterTimeline(
    skaterGames,
    'CCC',
    sourceSchedules,
  );

  assert.deepEqual(timeline.map((entry) => entry.id), [101, 102, 103, 204, 205, 206]);
});

test('replay alignment releases source stats by target date and retains future schedule markers', () => {
  const aligned = alignHistoricalReplaySkaterData({
    games: skaterGames,
    fallbackTeamAbbreviation: 'CCC',
    targetSchedule,
    sourceSchedules,
    simulatedDate: '2026-10-07',
  });

  assert.deepEqual(aligned.games.map((entry) => entry.gameId), [204, 103, 101]);
  assert.deepEqual(aligned.schedule.slice(0, 6).map((entry) => entry.id), [101, 102, 103, 204, 205, 206]);
  assert.deepEqual(
    aligned.schedule.slice(0, 6).map((entry) => entry.gameState),
    ['FINAL', 'FINAL', 'FINAL', 'FINAL', 'FUT', 'FUT'],
  );
  assert.deepEqual([...aligned.appearedGameIds].sort((a, b) => a - b), [101, 103, 204]);
});

test('goalie-unit replay alignment maps the same team schedule without inventing stats', () => {
  const sourceSchedule = [
    game(301, '2025-10-01', 'CCC', 'AAA'),
    game(302, '2025-10-03', 'BBB', 'CCC'),
    game(303, '2025-10-05', 'CCC', 'DDD'),
  ];
  const aligned = alignHistoricalReplayTeamData({
    games: [
      { gameId: 301, gameDate: '2025-10-01', saves: 30 },
      { gameId: 303, gameDate: '2025-10-05', saves: 26 },
    ],
    targetSchedule,
    sourceSchedule,
    simulatedDate: '2026-10-03',
  });

  assert.deepEqual(aligned.games.map((entry) => entry.gameId), [301]);
  assert.equal(aligned.schedule[0]?.gameState, 'FINAL');
  assert.equal(aligned.schedule[1]?.gameState, 'FINAL');
  assert.equal(aligned.schedule[2]?.gameState, 'FUT');
});

test('projection generation uses source stats, target schedules, and progressively revealed replay rows', async () => {
  const [snapshotService, playerPool] = await Promise.all([
    read('functions/src/shared/core/projection/projection-snapshot.service.ts'),
    read('functions/src/shared/core/draft/draft-player-pool.service.ts'),
  ]);

  assert.match(snapshotService, /currentSeasonOverride: replay\.sourceSeason/);
  assert.match(snapshotService, /previousSeasonOverride: previousSeason\(replay\.sourceSeason\)/);
  assert.match(snapshotService, /scheduleSeasonOverride: replay\.targetSeason/);
  assert.match(snapshotService, /historicalReplayAlignment: true/);
  assert.match(playerPool, /alignHistoricalReplaySkaterData/);
  assert.match(playerPool, /alignHistoricalReplayTeamData/);
  assert.match(playerPool, /teamSchedule: currentPlayerSchedule/);
  assert.match(playerPool, /schedule: currentPlayerSchedule/);
  assert.doesNotMatch(playerPool, /schedule: currentTeamScheduleAsOf/);
});

test('the unified Add Drop surface exposes a quiet replay freshness state and exact snapshot listener', async () => {
  const [component, template, snapshotService] = await Promise.all([
    read('src/app/features/free-agents/free-agents.ts'),
    read('src/app/features/free-agents/free-agents.html'),
    read('src/app/core/projection/projection-snapshot.service.ts'),
  ]);

  assert.match(component, /readonly playerDataRefreshing = computed/);
  assert.match(component, /snapshotDate < replayDate/);
  assert.match(template, /Updating player data…/);
  assert.match(snapshotService, /metadata\.activeSnapshotId === lastSnapshotId/);
  assert.match(snapshotService, /invalidateSharedProjectionReadCache/);
});

test('private player notes normalize plain text, enforce limits, and add update remove idempotently', () => {
  assert.equal(PLAYER_NOTE_MAX_COUNT, 100);
  assert.equal(PLAYER_NOTE_MAX_CHARACTERS, 500);
  assert.equal(PLAYER_NOTE_MAX_LINES, 8);
  assert.equal(normalizePlayerNoteText('  watch his PP1 role\r\nnext matchup  '), 'watch his PP1 role\nnext matchup');
  assert.equal(normalizePlayerNoteText('x'.repeat(501)), null);
  assert.equal(normalizePlayerNoteText(Array.from({ length: 9 }, () => 'x').join('\n')), null);

  const added = updatePlayerNoteRecords([], 'skater-8478402', 'PP1 promotion', new Date('2026-08-18T12:00:00Z'));
  assert.equal(added?.changed, true);
  assert.equal(added?.record?.note, 'PP1 promotion');

  const replay = updatePlayerNoteRecords(added?.records, 'skater-8478402', 'PP1 promotion', new Date('2026-08-18T12:05:00Z'));
  assert.equal(replay?.changed, false);

  const updated = updatePlayerNoteRecords(added?.records, 'skater-8478402', 'Monitor shot volume', new Date('2026-08-18T12:10:00Z'));
  assert.equal(findPlayerNote(updated?.records, 'skater-8478402')?.note, 'Monitor shot volume');

  const removed = updatePlayerNoteRecords(updated?.records, 'skater-8478402', '', new Date('2026-08-18T12:15:00Z'));
  assert.equal(removed?.changed, true);
  assert.equal(removed?.record, null);
  assert.deepEqual(removed?.records, []);
});

test('player-note callables derive ownership from auth and never accept an owner identifier', async () => {
  const [publisher, index, client] = await Promise.all([
    read('functions/src/player-note.ts'),
    read('functions/src/index.ts'),
    read('src/app/core/player/player-note.service.ts'),
  ]);

  assert.match(publisher, /requireAuthenticatedUserId\(request\.auth/);
  assert.match(publisher, /requireVerifiedEmail\(request\.auth/);
  assert.match(publisher, /managerPlayerNotes\/\$\{userId\}/);
  assert.doesNotMatch(publisher, /data\['ownerId'\]|data\['userId'\]/);
  assert.match(index, /getPlayerNote/);
  assert.match(index, /setPlayerNote/);
  assert.match(client, /PLAYER_NOTE_MAX_CHARACTERS = 500/);
});

test('Player Intel keeps notes private, inline, bounded, and mobile-safe', async () => {
  const [component, template, styles] = await Promise.all([
    read('src/app/features/players/league-player-detail/league-player-detail.ts'),
    read('src/app/features/players/league-player-detail/league-player-detail.html'),
    read('src/app/features/players/league-player-detail/league-player-detail.css'),
  ]);

  assert.match(component, /getPlayerNote\(this\.assetKey\)/);
  assert.match(component, /setPlayerNote\(/);
  assert.match(template, /My note/);
  assert.match(template, /maxlength="500"/);
  assert.match(template, /Private/);
  assert.match(styles, /player-intel-note/);
  assert.doesNotMatch(template, /role="dialog"|innerHTML|overlay/i);
  assert.doesNotMatch(styles, /position:\s*(?:fixed|sticky)|backdrop-filter/i);
});

test('permanent account deletion removes private player notes', async () => {
  const index = await read('functions/src/index.ts');
  assert.match(index, /managerPlayerNotes\/\$\{userId\}/);
  assert.match(index, /managerPlayerNotesSnapshot\.exists/);
  assert.match(index, /managerPlayerNotesRef\.delete\(\)/);
});

test('A1D preserves Scoring V3, Projection V11, Rules, indexes, and safety modes', async () => {
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

test('A1D advances release operations to RC42 and permanently records replay alignment and private notes', async () => {
  const [
    runtime,
    productionRuntime,
    freezeSource,
    packageSource,
    functionsPackageSource,
    roadmap,
    docsRoadmap,
    docs,
    readme,
    runbook,
    p1cGuard,
  ] = await Promise.all([
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('config/release-freeze/beta-freeze-policy.json'),
    read('package.json'),
    read('functions/package.json'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_PRODUCT_A1D_REPLAY_PLAYER_NOTES.md'),
    read('README.md'),
    read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
    read('test/batchp1c-replay-capacity/batchp1c-replay-capacity.test.mjs'),
  ]);
  const freeze = JSON.parse(freezeSource);
  const packageJson = JSON.parse(packageSource);
  const functionsPackage = JSON.parse(functionsPackageSource);

  assert.match(runtime, /Release Candidate 53/);
  assert.match(productionRuntime, /Release Candidate 53/);
  assert.equal(freeze.releaseLabel, 'Release Candidate 53');
  assert.equal(freeze.verificationCommand, 'npm run verify:batcho1c');
  assert.equal(freeze.defaultTag, 'rinkrat-rc53-invite-beta');
  assert.match(packageJson.scripts['verify:batcha1d:core'], /verify:batcha1c:core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batcho1c:core/);
  assert.match(functionsPackage.scripts.logs, /getPlayerNote/);
  assert.match(functionsPackage.scripts.logs, /setPlayerNote/);
  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.44/);
  assert.match(roadmap, /# \[x\] A1\.6 Add custom player notes/);
  assert.match(roadmap, /# \[x\] A1\.14/);
  assert.match(roadmap, /# \[x\] LOG\.51 2026-08-18/);
  assert.match(docs, /source-season[\s\S]*game rows/i);
  assert.match(docs, /private player notes/i);
  assert.match(docs, /site-first/i);
  assert.match(readme, /Release Candidate 53 \/ Operations Batch O1C/);
  assert.match(readme, /RINKRAT_PRODUCT_A1D_REPLAY_PLAYER_NOTES\.md/);
  assert.match(runbook, /npm run verify:batcho1c/);
  assert.match(runbook, /rinkrat-rc53-validation\.json/);
  assert.match(runbook, /rinkrat-rc53-invite-beta/);
  assert.match(p1cGuard, /historical-replay-player-data\.util\.ts/);
  assert.match(p1cGuard, /player-note\.ts/);
  assert.match(p1cGuard, /player-note\.util\.ts/);
});
