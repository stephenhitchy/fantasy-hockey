import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildCanonicalNhlGameFacts,
  buildCanonicalNhlGameHashes,
  CANONICAL_NHL_TOI_SETTLEMENT_INTERVAL_MILLISECONDS,
  decideCanonicalNhlGameChange,
} from '../../functions/src/shared/core/nhl/nhl-canonical-facts.util.ts';

function fixture(options = {}) {
  const homeScore = options.homeScore ?? 1;
  const awayScore = options.awayScore ?? 0;
  const gameState = options.gameState ?? 'LIVE';

  return {
    scoreboard: {
      gameId: 2026020001,
      gameState,
      gameScheduleState: 'OK',
      period: options.period ?? (gameState === 'FINAL' ? 3 : 2),
      periodType: 'REG',
      clockTimeRemaining: gameState === 'FINAL'
        ? '00:00'
        : options.clockTimeRemaining ?? '10:00',
      clockRunning: gameState !== 'FINAL',
      inIntermission: false,
      startTimeUTC: '2026-09-20T23:00:00Z',
      gameDate: '2026-09-20',
    },
    boxscore: {
      id: 2026020001,
      gameState,
      gameDate: '2026-09-20',
      startTimeUTC: '2026-09-20T23:00:00Z',
      homeTeam: { abbrev: 'VGK', score: homeScore },
      awayTeam: { abbrev: 'MIN', score: awayScore },
      playerByGameStats: {
        homeTeam: {
          forwards: [{
            playerId: 101,
            name: { default: 'Home Skater' },
            position: 'C',
            goals: homeScore,
            assists: 0,
            points: homeScore,
            plusMinus: homeScore > awayScore ? 1 : 0,
            hits: options.hits ?? 1,
            powerPlayGoals: 0,
            sog: options.shotsOnGoal ?? 3,
            toi: options.toi ?? '12:00',
            blockedShots: options.blockedShots ?? 0,
          }],
          defense: [],
          goalies: [{
            playerId: 201,
            name: { default: 'Home Goalie' },
            position: 'G',
            goalsAgainst: awayScore,
            toi: gameState === 'FINAL' ? '60:00' : '40:00',
            starter: true,
            decision: '',
            shotsAgainst: 22,
            saves: 22 - awayScore,
          }],
        },
        awayTeam: {
          forwards: [{
            playerId: 102,
            name: { default: 'Away Skater' },
            position: 'LW',
            goals: awayScore,
            assists: 1,
            points: awayScore + 1,
            plusMinus: homeScore > awayScore ? -1 : 0,
            hits: 1,
            powerPlayGoals: 0,
            sog: 2,
            toi: options.awayToi ?? '11:00',
            blockedShots: 0,
          }],
          defense: [],
          goalies: [{
            playerId: 202,
            name: { default: 'Away Goalie' },
            position: 'G',
            goalsAgainst: homeScore,
            toi: gameState === 'FINAL' ? '60:00' : '40:00',
            starter: true,
            decision: '',
            shotsAgainst: 24,
            saves: 24 - homeScore,
          }],
        },
      },
    },
    playByPlay: {
      plays: [{
        eventId: 45,
        typeDescKey: 'goal',
        periodDescriptor: {
          number: options.period ?? (gameState === 'FINAL' ? 3 : 2),
          periodType: 'REG',
        },
        timeInPeriod: '07:00',
        details: {
          scoringPlayerId: 101,
          assist1PlayerId: options.assist1PlayerId,
          assist2PlayerId: options.assist2PlayerId,
          situationCode: options.situationCode ?? '1551',
          homeScore,
          awayScore,
        },
      }],
    },
  };
}

function hashes(options = {}) {
  return buildCanonicalNhlGameHashes(
    buildCanonicalNhlGameFacts(fixture(options)),
  );
}

function previousState(value, settledAtMilliseconds = 1_000_000) {
  return {
    fantasyEventHash: value.fantasyEventHash,
    timeOnIceHash: value.timeOnIceHash,
    lastSignaledTimeOnIceHash: value.timeOnIceHash,
    gameStateHash: value.gameStateHash,
    finalSettlementHash: value.finalSettlementHash,
    lastTimeOnIceSettledAtMilliseconds: settledAtMilliseconds,
  };
}

function decision(previous, current, options = {}) {
  return decideCanonicalNhlGameChange({
    previous: previousState(
      previous,
      options.settledAtMilliseconds ?? 1_000_000,
    ),
    current,
    currentGameState: options.currentGameState ?? 'live',
    nowMilliseconds: options.nowMilliseconds ?? 1_120_000,
  });
}

function affectedLeagues({
  exactCanaryLeagueIds,
  impactIndexComplete,
  playerIds,
  teamAbbreviations,
  impacts,
}) {
  if (!impactIndexComplete) {
    return [...exactCanaryLeagueIds].sort();
  }

  const players = new Set(playerIds);
  const teams = new Set(teamAbbreviations);

  return impacts
    .filter((impact) =>
      impact.playerIds.some((playerId) => players.has(playerId)) ||
      impact.teamAbbreviations.some((team) => teams.has(team))
    )
    .map((impact) => impact.leagueId)
    .sort();
}

function result(id, expected, actual, passed) {
  return { id, expected, actual, passed };
}

export function runPreseasonScoringCertification() {
  const baseline = hashes();
  const scenarios = [];

  const unchanged = decision(baseline, hashes());
  scenarios.push(result(
    'identical-snapshot',
    'unchanged:false',
    `${unchanged.kind}:${unchanged.shouldSignal}`,
    unchanged.kind === 'unchanged' && unchanged.shouldSignal === false,
  ));

  const clockOnly = decision(
    hashes({ clockTimeRemaining: '10:00' }),
    hashes({ clockTimeRemaining: '08:00' }),
  );
  scenarios.push(result(
    'clock-only-suppressed',
    'unchanged:false',
    `${clockOnly.kind}:${clockOnly.shouldSignal}`,
    clockOnly.kind === 'unchanged' && clockOnly.shouldSignal === false,
  ));

  const toiDeferred = decision(
    hashes({ toi: '12:00' }),
    hashes({ toi: '13:00' }),
  );
  scenarios.push(result(
    'toi-only-deferred',
    'toi-deferred:false',
    `${toiDeferred.kind}:${toiDeferred.shouldSignal}`,
    toiDeferred.kind === 'toi-deferred' && toiDeferred.shouldSignal === false,
  ));

  const toiSettled = decision(
    hashes({ toi: '12:00' }),
    hashes({ toi: '13:00' }),
    {
      nowMilliseconds:
        1_000_000 + CANONICAL_NHL_TOI_SETTLEMENT_INTERVAL_MILLISECONDS,
    },
  );
  scenarios.push(result(
    'toi-heartbeat-settlement',
    'toi-settlement:true',
    `${toiSettled.kind}:${toiSettled.shouldSignal}`,
    toiSettled.kind === 'toi-settlement' && toiSettled.shouldSignal === true,
  ));

  for (const [id, options] of [
    ['shot-change', { shotsOnGoal: 4 }],
    ['hit-change', { hits: 2 }],
    ['block-change', { blockedShots: 1 }],
    ['score-change', { homeScore: 2 }],
    ['assist-order-change', { assist1PlayerId: 102, assist2PlayerId: 101 }],
    ['period-transition', { period: 3 }],
  ]) {
    const current = decision(baseline, hashes(options));
    scenarios.push(result(
      id,
      'signal:true',
      `${current.kind}:${current.shouldSignal}`,
      current.shouldSignal === true,
    ));
  }

  const finalSettlement = decision(
    baseline,
    hashes({ gameState: 'FINAL', toi: '20:00' }),
    { currentGameState: 'final' },
  );
  scenarios.push(result(
    'final-settlement',
    'final-settlement:true',
    `${finalSettlement.kind}:${finalSettlement.shouldSignal}`,
    finalSettlement.kind === 'final-settlement' &&
      finalSettlement.shouldSignal === true,
  ));

  const finalCorrection = decision(
    hashes({ gameState: 'FINAL', toi: '20:00' }),
    hashes({ gameState: 'FINAL', toi: '20:15', homeScore: 2 }),
    { currentGameState: 'final' },
  );
  scenarios.push(result(
    'post-final-correction',
    'signal:true',
    `${finalCorrection.kind}:${finalCorrection.shouldSignal}`,
    finalCorrection.shouldSignal === true,
  ));

  const routed = affectedLeagues({
    exactCanaryLeagueIds: ['league-a', 'league-b'],
    impactIndexComplete: true,
    playerIds: [101],
    teamAbbreviations: ['VGK'],
    impacts: [
      { leagueId: 'league-a', playerIds: [101], teamAbbreviations: [] },
      { leagueId: 'league-b', playerIds: [999], teamAbbreviations: ['BOS'] },
    ],
  });
  scenarios.push(result(
    'affected-league-routing',
    'league-a',
    routed.join(','),
    routed.join(',') === 'league-a',
  ));

  const fallback = affectedLeagues({
    exactCanaryLeagueIds: ['league-a', 'league-b'],
    impactIndexComplete: false,
    playerIds: [101],
    teamAbbreviations: ['VGK'],
    impacts: [],
  });
  scenarios.push(result(
    'incomplete-index-fails-open',
    'league-a,league-b',
    fallback.join(','),
    fallback.join(',') === 'league-a,league-b',
  ));

  const duplicate = baseline.sourceVersion === hashes().sourceVersion;
  scenarios.push(result(
    'duplicate-source-version',
    'same-version',
    duplicate ? 'same-version' : 'different-version',
    duplicate,
  ));

  const newerVersion = hashes({ homeScore: 2 }).sourceVersion;
  scenarios.push(result(
    'newer-version-follow-up-required',
    'different-version',
    newerVersion === baseline.sourceVersion
      ? 'same-version'
      : 'different-version',
    newerVersion !== baseline.sourceVersion,
  ));

  const passedScenarioCount = scenarios.filter((entry) => entry.passed).length;

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scenarioCount: scenarios.length,
    passedScenarioCount,
    failedScenarioCount: scenarios.length - passedScenarioCount,
    ready: passedScenarioCount === scenarios.length,
    scenarios,
  };
}

function outputPathFromArgs(argv) {
  const outputIndex = argv.indexOf('--output');
  return outputIndex >= 0 && argv[outputIndex + 1]
    ? resolve(argv[outputIndex + 1])
    : null;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = runPreseasonScoringCertification();
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const outputPath = outputPathFromArgs(process.argv.slice(2));

  if (outputPath) {
    await writeFile(outputPath, serialized, 'utf8');
  }

  process.stdout.write(serialized);

  if (!report.ready) {
    process.exitCode = 1;
  }
}
