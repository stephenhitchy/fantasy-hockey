import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const {
  buildInjuryReplacementWindowPlan,
  getInjuryReplacementAssetKeyByGameId,
  getInjuryReplacementGameIds,
  normalizeInjuryReplacementWindowPlan,
} = require(
  '../../functions/lib/shared/core/cycle/injury-replacement-window.util.js',
);

function skater(assetKey, playerId, position = 'C', team = 'SJS') {
  return {
    assetType: 'skater',
    assetKey,
    position,
    player: {
      id: playerId,
      fullName: assetKey,
      firstName: assetKey,
      lastName: 'Fixture',
      position,
      nhlTeamAbbreviation: team,
    },
  };
}

const injuredStarter = skater('skater-1', 1, 'C', 'SJS');
const firstReplacement = skater('skater-2', 2, 'C', 'FLA');
const secondReplacement = skater('skater-3', 3, 'C', 'DET');

describe('instant injury replacement ownership', () => {
  test('keeps every already-started game and assigns only the exact remainder', () => {
    const plan = buildInjuryReplacementWindowPlan({
      currentAsset: injuredStarter,
      currentScheduledGameIds: [101, 102, 103, 104, 105, 106],
      startedCurrentGameIds: new Set([101, 102]),
      currentSourceTeamAbbreviation: 'SJS',
      incomingAsset: firstReplacement,
      incomingScheduledGameIds: [201, 202, 203, 204],
      incomingSourceTeamAbbreviation: 'FLA',
      transactionId: 'txn-one',
      boundaryMilliseconds: 1_000,
      requiredGames: 6,
    });

    assert.deepEqual(plan.segments[0].scheduledGameIds, [101, 102]);
    assert.deepEqual(plan.segments[1].scheduledGameIds, [201, 202, 203, 204]);
    assert.deepEqual(getInjuryReplacementGameIds(plan), [101, 102, 201, 202, 203, 204]);
    assert.equal(plan.replacementCount, 1);
    assert.equal(normalizeInjuryReplacementWindowPlan(plan)?.latestTransactionId, 'txn-one');
  });

  test('allows a second replacement only from the current segment without reusing old games', () => {
    const firstPlan = buildInjuryReplacementWindowPlan({
      currentAsset: injuredStarter,
      currentScheduledGameIds: [101, 102, 103, 104, 105, 106],
      startedCurrentGameIds: new Set([101, 102]),
      currentSourceTeamAbbreviation: 'SJS',
      incomingAsset: firstReplacement,
      incomingScheduledGameIds: [201, 202, 203, 204],
      incomingSourceTeamAbbreviation: 'FLA',
      transactionId: 'txn-one',
      boundaryMilliseconds: 1_000,
      requiredGames: 6,
    });
    const secondPlan = buildInjuryReplacementWindowPlan({
      previousPlan: firstPlan,
      currentAsset: firstReplacement,
      currentScheduledGameIds: [201, 202, 203, 204],
      startedCurrentGameIds: new Set([201]),
      currentSourceTeamAbbreviation: 'FLA',
      incomingAsset: secondReplacement,
      incomingScheduledGameIds: [301, 302, 303],
      incomingSourceTeamAbbreviation: 'DET',
      transactionId: 'txn-two',
      boundaryMilliseconds: 2_000,
      requiredGames: 6,
    });

    assert.deepEqual(
      secondPlan.segments.map((segment) => segment.scheduledGameIds),
      [[101, 102], [201], [301, 302, 303]],
    );
    assert.equal(secondPlan.replacementCount, 2);
    assert.equal(new Set(getInjuryReplacementGameIds(secondPlan)).size, 6);
    assert.deepEqual(getInjuryReplacementAssetKeyByGameId(secondPlan), {
      101: 'skater-1',
      102: 'skater-1',
      201: 'skater-2',
      301: 'skater-3',
      302: 'skater-3',
      303: 'skater-3',
    });
  });

  test('fails closed when a saved plan duplicates games or does not own exactly six', () => {
    const valid = buildInjuryReplacementWindowPlan({
      currentAsset: injuredStarter,
      currentScheduledGameIds: [101, 102, 103, 104, 105, 106],
      startedCurrentGameIds: new Set([101]),
      currentSourceTeamAbbreviation: 'SJS',
      incomingAsset: firstReplacement,
      incomingScheduledGameIds: [201, 202, 203, 204, 205],
      incomingSourceTeamAbbreviation: 'FLA',
      transactionId: 'txn-one',
      boundaryMilliseconds: 1_000,
      requiredGames: 6,
    });
    const duplicate = structuredClone(valid);
    duplicate.segments[1].scheduledGameIds[0] = 101;
    const short = structuredClone(valid);
    short.segments[1].scheduledGameIds.pop();

    assert.equal(normalizeInjuryReplacementWindowPlan(duplicate), null);
    assert.equal(normalizeInjuryReplacementWindowPlan(short), null);
  });
});

describe('injury replacement integration contracts', () => {
  test('the scorer resolves each owned game against its assigned segment asset', async () => {
    const [source, browserSource] = await Promise.all([
      readFile(
        new URL('../../functions/src/shared/core/cycle/cycle-scoring.service.ts', import.meta.url),
        'utf8',
      ),
      readFile(
        new URL('../../src/app/core/cycle/cycle-scoring.service.ts', import.meta.url),
        'utf8',
      ),
    ]);

    assert.match(source, /const scoringAsset = scoringAssetsByGameId\.get\(game\.id\) \?\? pick\.asset/);
    assert.match(source, /calculateSkaterGameScore\(\s*scoringAsset,/);
    assert.match(source, /getInjuryReplacementAssetKeyByGameId\(injuryReplacementPlan\)/);
    assert.match(browserSource, /const scoringAsset = scoringAssetsByGameId\.get\(game\.id\) \?\? pick\.asset/);
    assert.match(browserSource, /calculateSkaterGameScore\(\s*scoringAsset,/);
    assert.match(browserSource, /getInjuryReplacementAssetKeyByGameId\(injuryReplacementPlan\)/);
  });

  test('the rollover advances only the current replacement segment', async () => {
    const source = await readFile(
      new URL('../../functions/src/shared/core/cycle/cycle.service.ts', import.meta.url),
      'utf8',
    );

    assert.match(
      source,
      /currentInjurySegment\?\.scheduledGameIds \?\? window\.scheduledGameIds/,
    );
    assert.match(
      source,
      /currentInjurySegment\?\.sourceTeamAbbreviation \?\?/,
    );
  });

  test('server and browser roster defaults expose five bench slots', async () => {
    const [serverSource, browserSource, draftSource] = await Promise.all([
      readFile(
        new URL('../../functions/src/shared/core/team/roster-config.ts', import.meta.url),
        'utf8',
      ),
      readFile(
        new URL('../../src/app/core/team/roster-config.ts', import.meta.url),
        'utf8',
      ),
      readFile(
        new URL('../../src/app/core/draft/draft.service.ts', import.meta.url),
        'utf8',
      ),
    ]);

    assert.match(serverSource, /BENCH_SLOT_COUNT = 5/);
    assert.match(browserSource, /BENCH_SLOT_COUNT = 5/);
    assert.match(draftSource, /DEFAULT_DRAFT_BENCH_SLOTS = 5/);
  });
});
