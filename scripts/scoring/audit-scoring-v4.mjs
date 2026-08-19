import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  calculateGoalieGameBreakdown as calculateClientGoalieGameBreakdown,
  calculateSkaterGamePoints as calculateClientSkaterGamePoints,
} from '../../src/app/core/scoring/scoring-engine.ts';
import {
  CURRENT_SCORING_RULES_VERSION as CLIENT_CURRENT_VERSION,
  defaultScoringRules as clientV4,
  scoringRulesV3 as clientV3,
} from '../../src/app/core/scoring/scoring-rules.ts';
import {
  calculateGoalieGameBreakdown as calculateServerGoalieGameBreakdown,
  calculateSkaterGamePoints as calculateServerSkaterGamePoints,
} from '../../functions/src/shared/core/scoring/scoring-engine.ts';
import {
  CURRENT_SCORING_RULES_VERSION as SERVER_CURRENT_VERSION,
  defaultScoringRules as serverV4,
  scoringRulesV3 as serverV3,
} from '../../functions/src/shared/core/scoring/scoring-rules.ts';

const ROOT = new URL('../../', import.meta.url);
const config = JSON.parse(await readFile(new URL('config/scoring-v4-acceptance.json', ROOT), 'utf8'));

function skaterOnly(rules) {
  return {
    requiredGamesPerCycle: rules.requiredGamesPerCycle,
    forward: rules.forward,
    defense: rules.defense,
    gameWinningGoal: rules.gameWinningGoal,
    overtimeGoal: rules.overtimeGoal,
    forwardToiMultiplier: rules.forwardToiMultiplier,
    defenseToiBaseMultiplier: rules.defenseToiBaseMultiplier,
    defenseToiPlusMinusModifier: rules.defenseToiPlusMinusModifier,
    defenseToiFloor: rules.defenseToiFloor,
    defenseToiCeiling: rules.defenseToiCeiling,
  };
}

assert.equal(CLIENT_CURRENT_VERSION, 4);
assert.equal(SERVER_CURRENT_VERSION, 4);
assert.deepEqual(clientV4, serverV4);
assert.deepEqual(clientV3, serverV3);
assert.deepEqual(skaterOnly(clientV4), skaterOnly(clientV3));
assert.equal(config.scoringRulesVersion, 4);
assert.deepEqual(config.formula, {
  skaterRulesChangedFromV3: false,
  goalieGameBase: 2,
  goalieSave: 0.2,
  goalieWin: 5,
  goalieShutout: 5,
  goalieSavePercentageBaseline: 0.9,
  goalieSavePercentageBasePoints: 3,
  goalieSavePercentagePointsPerPercentagePoint: 1.8,
  goalieSavePercentageMinimum: -6,
  goalieSavePercentageMaximum: 14,
  goalieGameMaximum: 0,
});

const representativeForward = {
  position: 'F',
  goals: 2,
  primaryAssists: 1,
  secondaryAssists: 0,
  shotsOnGoal: 4,
  hits: 2,
  blockedShots: 0,
  plusMinus: 1,
  powerPlayPoints: 1,
  shortHandedPoints: 0,
  gameWinningGoal: true,
  overtimeGoal: false,
  timeOnIceMinutes: 18,
};
assert.equal(
  calculateClientSkaterGamePoints(representativeForward, clientV4),
  calculateClientSkaterGamePoints(representativeForward, clientV3),
);
assert.equal(
  calculateClientSkaterGamePoints(representativeForward, clientV4),
  calculateServerSkaterGamePoints(representativeForward, serverV4),
);

const poorVolume = { saves: 34, shotsAgainst: 40, won: false, shutout: false };
const eliteEfficiency = { saves: 19, shotsAgainst: 20, won: true, shutout: false };
const extraordinary = { saves: 50, shotsAgainst: 50, won: true, shutout: true };

const poor = calculateClientGoalieGameBreakdown(poorVolume, clientV4);
const elite = calculateClientGoalieGameBreakdown(eliteEfficiency, clientV4);
const uncapped = calculateClientGoalieGameBreakdown(extraordinary, clientV4);
const legacyCapped = calculateClientGoalieGameBreakdown(extraordinary, clientV3);

assert.ok(elite.total > poor.total, 'Elite efficiency must beat poor empty volume.');
assert.ok(uncapped.total > 28, 'Production V4 must preserve an extraordinary score above 28.');
assert.equal(legacyCapped.total, 28, 'Legacy V3 must remain exactly reconstructable at its 28-point maximum.');
assert.equal(
  uncapped.total,
  calculateServerGoalieGameBreakdown(extraordinary, serverV4).total,
);
assert.equal(
  uncapped.lines.some((line) => line.label.startsWith('Goalie Game Maximum')),
  false,
);
assert.equal(
  legacyCapped.lines.some((line) => line.label.startsWith('Goalie Game Maximum')),
  true,
);

const requiredInvariants = new Set(config.protectedInvariants);
for (const invariant of [
  'six-team-games-per-roster-slot-window',
  'seventh-game-rollover',
  'completed-window-immutability',
  'server-authoritative-scoring',
  'client-server-scoring-parity',
]) {
  assert.equal(requiredInvariants.has(invariant), true, invariant);
}

console.log('Production Scoring V4 source audit passed.');
console.log(`- Poor high-volume loss: ${poor.total.toFixed(2)} points`);
console.log(`- Low-volume elite win: ${elite.total.toFixed(2)} points`);
console.log(`- Extraordinary uncapped V4 win/shutout: ${uncapped.total.toFixed(2)} points`);
console.log(`- Same line under legacy V3: ${legacyCapped.total.toFixed(2)} points`);
console.log('Audit only. No league, score, cycle, window, projection, or production setting was changed.');
