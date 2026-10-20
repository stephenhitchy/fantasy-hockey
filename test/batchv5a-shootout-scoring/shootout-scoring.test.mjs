import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  calculateGoalieGameBreakdown,
  calculateSkaterGameBreakdown,
} from '../../src/app/core/scoring/scoring-engine.ts';
import {
  CURRENT_SCORING_RULES_VERSION,
  LATEST_SUPPORTED_SCORING_RULES_VERSION,
  SCORING_RULES_V3_VERSION,
  SCORING_RULES_V4_VERSION,
  SCORING_RULES_V5_VERSION,
  defaultScoringRules,
  scoringRulesForVersion,
  resolveScoringRulesVersion,
  scoringRulesV4,
  scoringRulesV5,
} from '../../src/app/core/scoring/scoring-rules.ts';
import {
  buildCanonicalNhlGameFacts,
  buildCanonicalNhlGameHashes,
  CANONICAL_NHL_FACTS_SCHEMA_VERSION,
} from '../../functions/src/shared/core/nhl/nhl-canonical-facts.util.ts';
import {
  assessNhlFinalInputCompleteness,
  isReusableNhlFinalScore,
  validateNhlFinalPlayByPlay,
} from '../../functions/src/shared/core/nhl/nhl-final-input-completeness.util.ts';
import {
  getSkaterShootoutGoals,
  getTeamShootoutGoals,
} from '../../src/app/core/nhl/nhl-shootout.util.ts';

const ROOT = new URL('../../', import.meta.url);
const read = (relativePath) => readFile(new URL(relativePath, ROOT), 'utf8');
const require = createRequire(import.meta.url);
const {
  classifyPreseasonScoringTransition,
  isProjectionPointerId,
} = require('../../functions/scripts/scoring-v5-migration.util.cjs');
const {
  classifyScoringV4Migration,
} = require('../../functions/scripts/scoring-v4-migration.util.cjs');
const {
  calculateCanonicalAssetGameScore,
  compareDirectAndCanonicalGameScore,
} = require('../../functions/lib/shared/core/nhl/nhl-canonical-scoring-parity.util.js');
const {
  getSkaterAssistBreakdown,
  getTeamGoalieUnitResult,
} = require('../../functions/lib/shared/core/nhl/nhl-api.service.js');

function emptySkaterStats(overrides = {}) {
  return {
    position: 'F',
    goals: 0,
    primaryAssists: 0,
    secondaryAssists: 0,
    shotsOnGoal: 0,
    hits: 0,
    blockedShots: 0,
    plusMinus: 0,
    powerPlayPoints: 0,
    shortHandedPoints: 0,
    gameWinningGoal: false,
    overtimeGoal: false,
    shootoutGoals: 0,
    timeOnIceMinutes: 0,
    ...overrides,
  };
}

function shootoutGameFactsInput() {
  return {
    scoreboard: {
      gameId: 2026020999,
      gameState: 'FINAL',
      gameScheduleState: 'OK',
      period: 5,
      periodType: 'SO',
      clockTimeRemaining: '00:00',
      clockRunning: false,
      inIntermission: false,
      gameDate: '2026-12-01',
      startTimeUTC: '2026-12-02T03:00:00Z',
    },
    boxscore: {
      homeTeam: { id: 54, abbrev: 'VGK', score: 1 },
      awayTeam: { id: 29, abbrev: 'CBJ', score: 0 },
      gameOutcome: { lastPeriodType: 'SO' },
      playerByGameStats: {
        homeTeam: {
          forwards: [{
            playerId: 1001,
            name: { default: 'Home Shooter' },
            position: 'C',
            goals: 0,
            assists: 0,
            points: 0,
            plusMinus: 0,
            hits: 0,
            powerPlayGoals: 0,
            sog: 2,
            toi: '18:00',
            blockedShots: 0,
          }],
          defense: [],
          goalies: [{
            playerId: 2001,
            name: { default: 'Home Goalie' },
            position: 'G',
            goalsAgainst: 0,
            toi: '65:00',
            starter: true,
            decision: 'W',
            shotsAgainst: 30,
            saves: 30,
          }],
        },
        awayTeam: {
          forwards: [{
            playerId: 1002,
            name: { default: 'Away Shooter' },
            position: 'C',
            goals: 0,
            assists: 0,
            points: 0,
            plusMinus: 0,
            hits: 0,
            powerPlayGoals: 0,
            sog: 1,
            toi: '17:00',
            blockedShots: 0,
          }],
          defense: [],
          goalies: [{
            playerId: 2002,
            name: { default: 'Away Goalie' },
            position: 'G',
            goalsAgainst: 0,
            toi: '65:00',
            starter: true,
            decision: 'L',
            shotsAgainst: 28,
            saves: 28,
          }],
        },
      },
    },
    playByPlay: {
      plays: [
        {
          eventId: 500,
          typeDescKey: 'goal',
          periodDescriptor: { number: 5, periodType: 'SO' },
          timeInPeriod: '00:00',
          details: {
            scoringPlayerId: 1001,
            eventOwnerTeamId: 54,
            goalieInNetId: 2002,
            // A malformed provider assist must never leak into fantasy assists.
            assist1PlayerId: 1002,
            homeScore: 1,
            awayScore: 0,
          },
        },
        {
          eventId: 501,
          typeDescKey: 'shootout-complete',
          periodDescriptor: { number: 5, periodType: 'SO' },
          timeInPeriod: '00:00',
          details: {},
        },
      ],
    },
  };
}

test('Scoring V5 is supported explicitly while Production defaults remain V4', () => {
  assert.equal(CURRENT_SCORING_RULES_VERSION, SCORING_RULES_V4_VERSION);
  assert.equal(LATEST_SUPPORTED_SCORING_RULES_VERSION, SCORING_RULES_V5_VERSION);
  assert.equal(defaultScoringRules, scoringRulesV4);
  assert.deepEqual(scoringRulesForVersion(4), scoringRulesV4);
  assert.deepEqual(scoringRulesForVersion(5), scoringRulesV5);
  assert.equal(Object.hasOwn(scoringRulesV4, 'shootoutGoal'), false);
  assert.equal(Object.hasOwn(scoringRulesV4, 'shootoutGoalBreaksGoalieShutout'), false);
  assert.equal(scoringRulesV5.shootoutGoal, 2);
  assert.equal(scoringRulesV5.shootoutGoalBreaksGoalieShutout, true);
  assert.throws(
    () => scoringRulesForVersion(6),
    /Unsupported future scoring-rules version/,
  );
  assert.equal(resolveScoringRulesVersion(undefined), SCORING_RULES_V3_VERSION);
  assert.equal(resolveScoringRulesVersion(2), SCORING_RULES_V3_VERSION);
  for (const invalid of [4.5, Number.POSITIVE_INFINITY, Number.NaN, '5']) {
    assert.throws(() => scoringRulesForVersion(invalid), /Invalid scoring-rules version/);
  }
});

test('each successful shootout attempt earns only the isolated flat two points', () => {
  const base = calculateSkaterGameBreakdown(
    emptySkaterStats({
      goals: 1,
      shotsOnGoal: 1,
      gameWinningGoal: true,
      overtimeGoal: true,
    }),
    scoringRulesV5,
  );
  const withOne = calculateSkaterGameBreakdown(
    emptySkaterStats({
      goals: 1,
      shotsOnGoal: 1,
      gameWinningGoal: true,
      overtimeGoal: true,
      shootoutGoals: 1,
    }),
    scoringRulesV5,
  );
  const withTwo = calculateSkaterGameBreakdown(
    emptySkaterStats({ shootoutGoals: 2 }),
    scoringRulesV5,
  );
  const defense = calculateSkaterGameBreakdown(
    emptySkaterStats({ position: 'D', shootoutGoals: 1 }),
    scoringRulesV5,
  );

  assert.equal(withOne.total - base.total, 2);
  assert.equal(withTwo.total, 4);
  assert.equal(defense.total, 2);
  assert.deepEqual(
    withOne.lines.filter((line) => line.label.includes('Shootout')),
    [{ label: 'Shootout Goal', points: 2 }],
  );
  assert.equal(
    withOne.lines.filter((line) => line.label === 'Game-Winning Goal').length,
    1,
  );
  assert.equal(
    withOne.lines.filter((line) => line.label === 'Overtime Goal').length,
    1,
  );
});

test('Scoring V4 ignores shootout inputs and remains historically reproducible', () => {
  const withoutShootout = calculateSkaterGameBreakdown(
    emptySkaterStats(),
    scoringRulesV4,
  );
  const withShootout = calculateSkaterGameBreakdown(
    emptySkaterStats({ shootoutGoals: 9 }),
    scoringRulesV4,
  );
  const goalieWithoutShootout = calculateGoalieGameBreakdown({
    saves: 30,
    shotsAgainst: 30,
    won: true,
    shutout: true,
  }, scoringRulesV4);
  const goalieWithShootout = calculateGoalieGameBreakdown({
    saves: 30,
    shotsAgainst: 30,
    won: true,
    shutout: true,
    shootoutGoalsAgainst: 4,
  }, scoringRulesV4);

  assert.deepEqual(withShootout, withoutShootout);
  assert.deepEqual(goalieWithShootout, goalieWithoutShootout);
});

test('shootout goals can break a goalie-unit shutout without altering saves or quality', () => {
  const oneSidedWinner = calculateGoalieGameBreakdown({
    saves: 30,
    shotsAgainst: 30,
    won: true,
    shutout: true,
    shootoutGoalsAgainst: 0,
  }, scoringRulesV5);
  const bothSidesScoredWinner = calculateGoalieGameBreakdown({
    saves: 30,
    shotsAgainst: 30,
    won: true,
    shutout: true,
    shootoutGoalsAgainst: 1,
  }, scoringRulesV5);

  assert.equal(
    oneSidedWinner.total - bothSidesScoredWinner.total,
    scoringRulesV5.goalieShutout,
  );
  assert.equal(
    bothSidesScoredWinner.lines.some((line) => line.label === 'Win'),
    true,
  );
  assert.equal(
    bothSidesScoredWinner.lines.some((line) => line.label === 'Shutout'),
    false,
  );
  assert.equal(
    bothSidesScoredWinner.lines.some((line) =>
      line.label === 'Shootout Goals Against (1; shutout broken)' && line.points === 0
    ),
    true,
  );

  for (const label of ['Saves (30)', 'Save Quality (100.0%; 90.0% baseline)']) {
    assert.deepEqual(
      bothSidesScoredWinner.lines.find((line) => line.label === label),
      oneSidedWinner.lines.find((line) => line.label === label),
    );
  }
});

test('canonical NHL facts preserve shootout identity separately from boxscore goals', () => {
  const input = shootoutGameFactsInput();
  const facts = buildCanonicalNhlGameFacts(input);
  const withoutShootout = buildCanonicalNhlGameFacts({
    ...input,
    playByPlay: { plays: [] },
  });
  const withoutTerminal = buildCanonicalNhlGameFacts({
    ...input,
    playByPlay: {
      plays: input.playByPlay.plays.filter(
        (play) => play.typeDescKey !== 'shootout-complete',
      ),
    },
  });

  assert.equal(CANONICAL_NHL_FACTS_SCHEMA_VERSION, 3);
  assert.equal(facts.homeTeamId, 54);
  assert.equal(facts.awayTeamId, 29);
  assert.equal(facts.boxscoreLastPeriodType, 'SO');
  assert.equal(facts.shootoutComplete, true);
  assert.equal(facts.skaters[0].goals, 0);
  assert.equal(facts.skaters[1].goals, 0);
  // Canonical facts retain the legacy raw ordering. Scoring V5, not ingestion,
  // owns the new rule that shootout events cannot award fantasy assists.
  assert.equal(facts.skaters[1].primaryAssists, 1);
  assert.deepEqual(facts.goals, [{
    eventId: 500,
    period: 5,
    periodType: 'SO',
    timeInPeriod: '00:00',
    scoringPlayerId: 1001,
    eventOwnerTeamId: 54,
    goalieInNetId: 2002,
    assist1PlayerId: 1002,
    assist2PlayerId: null,
    situationCode: '',
    homeScore: 1,
    awayScore: 0,
  }]);
  assert.notEqual(
    buildCanonicalNhlGameHashes(facts).fantasyEventHash,
    buildCanonicalNhlGameHashes(withoutShootout).fantasyEventHash,
  );
  assert.notEqual(
    buildCanonicalNhlGameHashes(facts).sourceVersion,
    buildCanonicalNhlGameHashes(withoutTerminal).sourceVersion,
  );

  const assistedAsset = {
    assetType: 'skater',
    assetKey: 'player-1002',
    position: 'C',
    player: {
      id: 1002,
      fullName: 'Away Shooter',
      teamAbbreviation: 'CBJ',
      position: 'C',
    },
  };
  const legacyScore = calculateCanonicalAssetGameScore({
    asset: assistedAsset,
    facts,
    gameIsFinal: false,
    scoringRules: scoringRulesV4,
  });
  const v5Score = calculateCanonicalAssetGameScore({
    asset: assistedAsset,
    facts,
    gameIsFinal: false,
    scoringRules: scoringRulesV5,
  });

  assert.equal(
    Number((legacyScore.points - v5Score.points).toFixed(1)),
    scoringRulesV4.forward.primaryAssist.first,
  );

  const repeatedInput = shootoutGameFactsInput();
  const repeatedGoal = repeatedInput.playByPlay.plays[0];
  const shootoutComplete = repeatedInput.playByPlay.plays[1];
  repeatedInput.playByPlay.plays = [
    repeatedGoal,
    {
      ...repeatedGoal,
      details: { ...repeatedGoal.details },
    },
    {
      ...repeatedGoal,
      eventId: undefined,
      details: { ...repeatedGoal.details },
    },
    {
      ...repeatedGoal,
      eventId: undefined,
      details: { ...repeatedGoal.details },
    },
    shootoutComplete,
  ];
  const repeatedFacts = buildCanonicalNhlGameFacts(repeatedInput);
  const shooterAsset = {
    assetType: 'skater',
    assetKey: 'player-1001',
    position: 'C',
    player: {
      id: 1001,
      fullName: 'Home Shooter',
      teamAbbreviation: 'VGK',
      position: 'C',
    },
  };
  const repeatedLegacyScore = calculateCanonicalAssetGameScore({
    asset: shooterAsset,
    facts: repeatedFacts,
    gameIsFinal: false,
    scoringRules: scoringRulesV4,
  });
  const repeatedV5Score = calculateCanonicalAssetGameScore({
    asset: shooterAsset,
    facts: repeatedFacts,
    gameIsFinal: false,
    scoringRules: scoringRulesV5,
  });

  // The canonical fact ledger keeps all received events for audit/hash
  // evidence. Scoring dedupes the replayed positive ID but retains both
  // missing-ID live successes, exactly like the direct parser.
  assert.equal(repeatedFacts.goals.length, 4);
  assert.equal(getSkaterShootoutGoals(repeatedInput.playByPlay, 1001), 3);
  assert.equal(getTeamShootoutGoals(repeatedInput.playByPlay, 54), 3);
  assert.equal(
    Number((repeatedV5Score.points - repeatedLegacyScore.points).toFixed(1)),
    3 * scoringRulesV5.shootoutGoal,
  );
});

test('the pure parser counts successes only, including repeat shooters', () => {
  const playByPlay = {
    plays: [
      null,
      { typeDescKey: 7, periodDescriptor: { periodType: 4 }, details: null },
      {
        eventId: 700,
        typeDescKey: 'goal',
        periodDescriptor: { periodType: 'SO' },
        details: { scoringPlayerId: 1001, eventOwnerTeamId: 54 },
      },
      {
        eventId: 700,
        typeDescKey: 'goal',
        periodDescriptor: { periodType: 'SO' },
        details: { scoringPlayerId: 1001, eventOwnerTeamId: 54 },
      },
      {
        typeDescKey: 'shot-on-goal',
        periodDescriptor: { periodType: 'SO' },
        details: { shootingPlayerId: 1001, eventOwnerTeamId: 54 },
      },
      {
        typeDescKey: 'missed-shot',
        periodDescriptor: { periodType: 'SO' },
        details: { shootingPlayerId: 1001, eventOwnerTeamId: 54 },
      },
      {
        typeDescKey: 'goal',
        periodDescriptor: { periodType: 'SO' },
        details: { scoringPlayerId: 1001, eventOwnerTeamId: 54 },
      },
      {
        typeDescKey: 'goal',
        periodDescriptor: { periodType: 'REG' },
        details: { scoringPlayerId: 1001, eventOwnerTeamId: 54 },
      },
      {
        typeDescKey: 'goal',
        periodDescriptor: { periodType: 'SO' },
        details: { scoringPlayerId: 1002, eventOwnerTeamId: 29 },
      },
    ],
  };

  assert.equal(getSkaterShootoutGoals(playByPlay, 1001), 2);
  assert.equal(getSkaterShootoutGoals(playByPlay, 1002), 1);
  assert.equal(getTeamShootoutGoals(playByPlay, 54), 2);
  assert.equal(getTeamShootoutGoals(playByPlay, 29), 1);
  assert.equal(getTeamShootoutGoals(playByPlay, null), 0);
  assert.deepEqual(getSkaterAssistBreakdown(playByPlay, 1001), {
    primaryAssists: 0,
    secondaryAssists: 0,
  });

  const syntheticShootoutAssist = shootoutGameFactsInput().playByPlay;
  assert.deepEqual(getSkaterAssistBreakdown(syntheticShootoutAssist, 1002), {
    primaryAssists: 1,
    secondaryAssists: 0,
  });
  assert.deepEqual(getSkaterAssistBreakdown(
    syntheticShootoutAssist,
    1002,
    { excludeShootoutGoals: true },
  ), {
    primaryAssists: 0,
    secondaryAssists: 0,
  });

  const malformedFacts = buildCanonicalNhlGameFacts({
    ...shootoutGameFactsInput(),
    playByPlay: { plays: {} },
  });
  assert.deepEqual(malformedFacts.goals, []);
  assert.equal(malformedFacts.shootoutComplete, false);
});

test('direct and canonical goalie scoring map shootout goals to the opposing team', () => {
  const oneSided = shootoutGameFactsInput();
  const homeAsset = {
    assetType: 'team-goalie-unit',
    assetKey: 'goalie-unit-VGK',
    position: 'G',
    teamName: 'Vegas Golden Knights',
    teamAbbreviation: 'VGK',
    teamLogoUrl: '',
  };
  const awayAsset = {
    ...homeAsset,
    assetKey: 'goalie-unit-CBJ',
    teamName: 'Columbus Blue Jackets',
    teamAbbreviation: 'CBJ',
  };
  const homeResult = getTeamGoalieUnitResult(
    oneSided.boxscore,
    'VGK',
    oneSided.playByPlay,
  );
  const awayResult = getTeamGoalieUnitResult(
    oneSided.boxscore,
    'CBJ',
    oneSided.playByPlay,
  );

  assert.equal(homeResult.shootoutGoalsAgainst, 0);
  assert.equal(homeResult.won, true);
  assert.equal(homeResult.shutout, true);
  assert.equal(awayResult.shootoutGoalsAgainst, 1);
  assert.equal(awayResult.won, false);
  assert.equal(awayResult.shutout, false);

  const homeDirect = calculateGoalieGameBreakdown({
    saves: homeResult.saves,
    shotsAgainst: homeResult.shotsAgainst,
    won: homeResult.won,
    shutout: homeResult.shutout,
    shootoutGoalsAgainst: homeResult.shootoutGoalsAgainst,
  }, scoringRulesV5);
  const awayDirect = calculateGoalieGameBreakdown({
    saves: awayResult.saves,
    shotsAgainst: awayResult.shotsAgainst,
    won: awayResult.won,
    shutout: awayResult.shutout,
    shootoutGoalsAgainst: awayResult.shootoutGoalsAgainst,
  }, scoringRulesV5);
  const oneSidedFacts = buildCanonicalNhlGameFacts(oneSided);

  assert.equal(homeDirect.lines.some((line) => line.label === 'Win'), true);
  assert.equal(homeDirect.lines.some((line) => line.label === 'Shutout'), true);
  assert.equal(awayDirect.lines.some((line) => line.label === 'Win'), false);
  assert.equal(awayDirect.lines.some((line) => line.label === 'Shutout'), false);
  assert.equal(
    calculateCanonicalAssetGameScore({
      asset: homeAsset,
      facts: oneSidedFacts,
      gameIsFinal: true,
      scoringRules: scoringRulesV5,
    }).points,
    homeDirect.total,
  );

  const bothSides = shootoutGameFactsInput();
  bothSides.playByPlay.plays.splice(1, 0, {
    eventId: 502,
    typeDescKey: 'goal',
    periodDescriptor: { number: 5, periodType: 'SO' },
    timeInPeriod: '00:00',
    details: {
      scoringPlayerId: 1002,
      eventOwnerTeamId: 29,
      goalieInNetId: 2001,
      homeScore: 0,
      awayScore: 0,
    },
  });
  const bothHomeResult = getTeamGoalieUnitResult(
    bothSides.boxscore,
    'VGK',
    bothSides.playByPlay,
  );
  const bothHomeDirect = calculateGoalieGameBreakdown({
    saves: bothHomeResult.saves,
    shotsAgainst: bothHomeResult.shotsAgainst,
    won: bothHomeResult.won,
    shutout: bothHomeResult.shutout,
    shootoutGoalsAgainst: bothHomeResult.shootoutGoalsAgainst,
  }, scoringRulesV5);
  const bothFacts = buildCanonicalNhlGameFacts(bothSides);

  assert.equal(bothHomeResult.shootoutGoalsAgainst, 1);
  assert.equal(bothHomeDirect.lines.some((line) => line.label === 'Win'), true);
  assert.equal(bothHomeDirect.lines.some((line) => line.label === 'Shutout'), false);
  assert.equal(
    calculateCanonicalAssetGameScore({
      asset: homeAsset,
      facts: bothFacts,
      gameIsFinal: true,
      scoringRules: scoringRulesV5,
    }).points,
    bothHomeDirect.total,
  );
});

test('shootout attribution is required only for the V5 goalie evidence contract', () => {
  const missingTeamAttribution = {
    plays: [{
      typeDescKey: 'goal',
      periodDescriptor: { periodType: 'SO' },
      details: { scoringPlayerId: 1001 },
    }],
  };

  assert.equal(
    validateNhlFinalPlayByPlay(missingTeamAttribution).availability,
    'available',
  );

  const incompleteShootout = shootoutGameFactsInput();
  incompleteShootout.playByPlay.plays = incompleteShootout.playByPlay.plays
    .filter((play) => play.typeDescKey !== 'shootout-complete');
  assert.equal(
    validateNhlFinalPlayByPlay(incompleteShootout.playByPlay, {
      requireShootoutTeamAttribution: true,
      expectedShootoutTeamIds: [54, 29],
      requireCompletedShootout: true,
      gameEndedInShootout: true,
    }).availability,
    'malformed',
  );
  const duplicateEvent = shootoutGameFactsInput();
  duplicateEvent.playByPlay.plays.splice(1, 0, {
    ...duplicateEvent.playByPlay.plays[0],
    details: { ...duplicateEvent.playByPlay.plays[0].details },
  });
  assert.equal(
    validateNhlFinalPlayByPlay(duplicateEvent.playByPlay, {
      requireShootoutTeamAttribution: true,
      expectedShootoutTeamIds: [54, 29],
      requireCompletedShootout: true,
      gameEndedInShootout: true,
    }).availability,
    'malformed',
  );
  assert.equal(
    validateNhlFinalPlayByPlay(shootoutGameFactsInput().playByPlay, {
      requireShootoutTeamAttribution: true,
      expectedShootoutTeamIds: [54, 29],
      requireCompletedShootout: true,
      gameEndedInShootout: true,
    }).availability,
    'available',
  );
  assert.equal(
    validateNhlFinalPlayByPlay(shootoutGameFactsInput().playByPlay, {
      requireShootoutTeamAttribution: true,
      expectedShootoutTeamIds: [54, 29],
      requireCompletedShootout: true,
      gameEndedInShootout: false,
    }).availability,
    'malformed',
  );
  const malformedShootoutAssist = shootoutGameFactsInput();
  malformedShootoutAssist.playByPlay.plays[0].details.assist1PlayerId = 'invalid';
  assert.equal(
    validateNhlFinalPlayByPlay(malformedShootoutAssist.playByPlay).availability,
    'malformed',
  );
  assert.equal(
    validateNhlFinalPlayByPlay(malformedShootoutAssist.playByPlay, {
      requireShootoutTeamAttribution: true,
      expectedShootoutTeamIds: [54, 29],
      requireCompletedShootout: true,
      gameEndedInShootout: true,
      ignoreShootoutAssistFields: true,
    }).availability,
    'available',
  );
  assert.equal(
    validateNhlFinalPlayByPlay(missingTeamAttribution, {
      requireShootoutTeamAttribution: true,
    }).availability,
    'malformed',
  );
  assert.equal(
    validateNhlFinalPlayByPlay({
      plays: [{
        typeDescKey: 'goal',
        periodDescriptor: { periodType: 'SO' },
        details: { scoringPlayerId: 1001, eventOwnerTeamId: 999 },
      }],
    }, {
      requireShootoutTeamAttribution: true,
      expectedShootoutTeamIds: [54, 29],
    }).availability,
    'malformed',
  );

  const legacyGoalieEvidence = assessNhlFinalInputCompleteness({
    assetType: 'team-goalie-unit',
    boxscore: { availability: 'available' },
    playByPlay: { availability: 'not-required' },
    playerLog: { availability: 'not-required' },
    sourceVersion: 'a'.repeat(64),
  });
  const v5GoalieEvidence = assessNhlFinalInputCompleteness({
    assetType: 'team-goalie-unit',
    boxscore: { availability: 'available' },
    playByPlay: { availability: 'available' },
    playerLog: { availability: 'not-required' },
    sourceVersion: 'b'.repeat(64),
    requireGoaliePlayByPlay: true,
  });

  assert.deepEqual(legacyGoalieEvidence.requiredSources, [
    'boxscore',
    'source-version',
  ]);
  assert.deepEqual(v5GoalieEvidence.requiredSources, [
    'boxscore',
    'play-by-play',
    'source-version',
  ]);
  assert.equal(legacyGoalieEvidence.complete, true);
  assert.equal(v5GoalieEvidence.complete, true);
  assert.equal(isReusableNhlFinalScore({
    assetType: 'team-goalie-unit',
    gameState: 'final',
    score: 12,
    completeness: legacyGoalieEvidence,
  }), true);
  assert.equal(isReusableNhlFinalScore({
    assetType: 'team-goalie-unit',
    gameState: 'final',
    score: 12,
    completeness: legacyGoalieEvidence,
    requireGoaliePlayByPlay: true,
  }), false);
  assert.equal(isReusableNhlFinalScore({
    assetType: 'team-goalie-unit',
    gameState: 'final',
    score: 12,
    completeness: v5GoalieEvidence,
    requireGoaliePlayByPlay: true,
  }), true);

  const facts = buildCanonicalNhlGameFacts(shootoutGameFactsInput());
  const sourceVersion = buildCanonicalNhlGameHashes(facts).sourceVersion;
  const homeGoalieUnit = {
    assetType: 'team-goalie-unit',
    assetKey: 'goalie-unit-VGK',
    position: 'G',
    teamName: 'Vegas Golden Knights',
    teamAbbreviation: 'VGK',
    teamLogoUrl: '',
  };
  const legacyMalformedEvidence = assessNhlFinalInputCompleteness({
    assetType: 'team-goalie-unit',
    boxscore: { availability: 'available' },
    playByPlay: { availability: 'malformed' },
    playerLog: { availability: 'not-required' },
    sourceVersion,
    requireGoaliePlayByPlay: true,
  });
  const v5CompleteEvidence = assessNhlFinalInputCompleteness({
    assetType: 'team-goalie-unit',
    boxscore: { availability: 'available' },
    playByPlay: { availability: 'available' },
    playerLog: { availability: 'not-required' },
    sourceVersion,
    requireGoaliePlayByPlay: true,
  });
  const canonicalGame = {
    sourceVersion,
    facts,
    finalInputCompletenessByAssetType: {
      teamGoalieUnit: legacyMalformedEvidence,
      scoringV5: { teamGoalieUnit: v5CompleteEvidence },
    },
  };
  const legacyCanonical = calculateCanonicalAssetGameScore({
    asset: homeGoalieUnit,
    facts,
    gameIsFinal: true,
    scoringRules: scoringRulesV4,
  });
  const v5Canonical = calculateCanonicalAssetGameScore({
    asset: homeGoalieUnit,
    facts,
    gameIsFinal: true,
    scoringRules: scoringRulesV5,
  });

  assert.equal(compareDirectAndCanonicalGameScore({
    gameId: facts.gameId,
    asset: homeGoalieUnit,
    canonicalGame,
    gameIsFinal: true,
    scoringRules: scoringRulesV4,
    directPoints: legacyCanonical.points,
    directAppeared: true,
  }).status, 'incomplete');
  assert.equal(compareDirectAndCanonicalGameScore({
    gameId: facts.gameId,
    asset: homeGoalieUnit,
    canonicalGame,
    gameIsFinal: true,
    scoringRules: scoringRulesV5,
    directPoints: v5Canonical.points,
    directAppeared: true,
  }).status, 'matched');
});

test('V5 migration is preseason-only and never permits mixed scoring history', async () => {
  assert.deepEqual(classifyScoringV4Migration({
    alreadyV4: false,
    sourceScoringRulesVersion: 5,
    cycleCount: 0,
    completedCycleCount: 0,
    pickCount: 0,
    draftStatus: 'scheduled',
    allowMixedHistory: true,
  }).blockers, ['newer-scoring-version']);
  assert.deepEqual(classifyPreseasonScoringTransition({
    alreadyTarget: false,
    canonicalSource: true,
    cycleCount: 0,
    pickCount: 0,
    draftStatus: 'scheduled',
  }).blockers, []);
  assert.deepEqual(classifyPreseasonScoringTransition({
    alreadyTarget: false,
    canonicalSource: true,
    cycleCount: 1,
    pickCount: 1,
    draftStatus: 'live',
  }).blockers, [
    'competition-cycle-history',
    'draft-picks-exist',
    'draft-status-live',
  ]);
  assert.deepEqual(classifyPreseasonScoringTransition({
    alreadyTarget: false,
    canonicalSource: false,
    cycleCount: 0,
    pickCount: 0,
    draftStatus: 'setup',
  }).blockers, ['source-scoring-contract-mismatch']);
  assert.equal(isProjectionPointerId('current'), true);
  assert.equal(isProjectionPointerId('target-cycle-3'), true);
  assert.equal(isProjectionPointerId('immutable-snapshot-1'), false);

  const [migrate, rollback, legacyMigrate, legacyRollback, inspect] = await Promise.all([
    read('functions/scripts/scoring-v5-migrate.cjs'),
    read('functions/scripts/scoring-v5-rollback.cjs'),
    read('functions/scripts/scoring-v4-migrate.cjs'),
    read('functions/scripts/scoring-v4-rollback.cjs'),
    read('functions/scripts/scoring-v5-inspect.cjs'),
  ]);
  assert.match(migrate, /RINKRAT_APPLY_SCORING_V5/);
  assert.match(migrate, /APPLY_PRESEASON_ONLY/);
  assert.match(rollback, /RINKRAT_ROLLBACK_SCORING_V5/);
  assert.match(rollback, /ROLLBACK_PRESEASON_ONLY/);
  assert.match(migrate, /db\.runTransaction/);
  assert.match(rollback, /db\.runTransaction/);
  assert.match(migrate, /projectionDocuments\.size > 200/);
  assert.match(rollback, /projectionDocuments\.size > 200/);
  assert.doesNotMatch(`${migrate}\n${rollback}`, /bulkWriter/);
  assert.match(migrate, /serverDraftReadinessStatus: null/);
  assert.match(rollback, /serverDraftReadinessStatus: null/);
  assert.match(legacyMigrate, /db\.runTransaction/);
  assert.match(legacyRollback, /db\.runTransaction/);
  assert.match(legacyMigrate, /sourceScoringRulesVersionValid/);
  assert.doesNotMatch(`${legacyMigrate}\n${legacyRollback}`, /bulkWriter/);
  assert.match(inspect, /supported legacy V3 retained/);
  assert.doesNotMatch(
    `${migrate}\n${rollback}`,
    /RINKRAT_ALLOW_MIXED|ALLOW_TEST_LEAGUE_ONLY/,
  );
});

test('both direct and canonical scoring paths wire shootout data without changing Projection V11', async () => {
  const [
    clientNhl,
    serverNhl,
    clientCycle,
    serverCycle,
    canonicalParity,
    projectionV11,
    clientShootout,
    serverShootout,
    clientLeague,
    serverLeagueAutomation,
  ] = await Promise.all([
    read('src/app/core/nhl/nhl-api.service.ts'),
    read('functions/src/shared/core/nhl/nhl-api.service.ts'),
    read('src/app/core/cycle/cycle-scoring.service.ts'),
    read('functions/src/shared/core/cycle/cycle-scoring.service.ts'),
    read('functions/src/shared/core/nhl/nhl-canonical-scoring-parity.util.ts'),
    read('src/app/core/projection/projection-v11.util.ts'),
    read('src/app/core/nhl/nhl-shootout.util.ts'),
    read('functions/src/shared/core/nhl/nhl-shootout.util.ts'),
    read('src/app/core/league/league.service.ts'),
    read('functions/src/league-automation.ts'),
  ]);

  for (const source of [clientNhl, serverNhl]) {
    assert.match(source, /getSkaterShootoutGoals/);
    assert.match(source, /getTeamShootoutGoals/);
  }
  assert.equal(clientShootout, serverShootout);
  for (const source of [clientCycle, serverCycle, canonicalParity]) {
    assert.match(source, /shootoutGoals/);
    assert.match(source, /shootoutGoalsAgainst/);
  }
  assert.doesNotMatch(projectionV11, /shootoutGoal/i);
  for (const source of [clientLeague, serverLeagueAutomation]) {
    assert.match(source, /normalizedVersion === SCORING_RULES_V5_VERSION/);
    assert.match(source, /delete normalized(?:Rules)?\.shootoutGoal/);
    assert.match(source, /delete normalized(?:Rules)?\.shootoutGoalBreaksGoalieShutout/);
  }
});

test('version transitions bind requests, publication, readiness, and canonical rebuilds', async () => {
  const [
    projectionAuthority,
    projectionSnapshot,
    releaseReadiness,
    canonicalFeed,
    draftAutomation,
    restoreVerifier,
  ] = await Promise.all([
    read('functions/src/projection-authority.ts'),
    read('functions/src/shared/core/projection/projection-snapshot.service.ts'),
    read('src/app/core/release/release-readiness.service.ts'),
    read('functions/src/nhl-canonical-impact-feed.ts'),
    read('functions/src/draft-automation.ts'),
    read('scripts/security/firestore-restore-verify.cjs'),
  ]);

  assert.match(
    projectionAuthority,
    /scoringRulesVersion: input\.scoringRulesVersion \?\? null/,
  );
  assert.match(
    projectionSnapshot,
    /The league scoring version changed before projection publication/,
  );
  assert.match(
    projectionSnapshot,
    /The league scoring version changed before emergency projection publication/,
  );
  assert.match(
    projectionSnapshot,
    /The league scoring version changed before projection integrity publication/,
  );
  assert.match(
    releaseReadiness,
    /projection\?\.scoringRulesVersion === leagueScoringRulesVersion/,
  );
  assert.match(
    releaseReadiness,
    /leagueScoringRulesVersion === SCORING_RULES_V5_VERSION/,
  );
  assert.match(
    canonicalFeed,
    /previousFacts[\s\S]*?input\.nowMilliseconds/,
  );
  assert.match(
    draftAutomation,
    /transactionScoringRulesVersion !==[\s\S]*?projection\.metadata\.scoringRulesVersion/,
  );
  assert.match(draftAutomation, /async function restoreProjectionPointers[\s\S]*?db\.runTransaction/);
  assert.match(restoreVerifier, /scoringV5Contracts/);
});
