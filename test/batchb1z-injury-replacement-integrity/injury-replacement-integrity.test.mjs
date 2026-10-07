import assert from 'node:assert/strict';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

const ROOT = new URL('../../', import.meta.url);

async function loadPresentationUtility() {
  const presentationUrl = new URL(
    'src/app/core/cycle/injury-replacement-presentation.util.ts',
    ROOT,
  );
  const injuryWindowUrl = new URL(
    'src/app/core/cycle/injury-replacement-window.util.ts',
    ROOT,
  );
  const typescript = (await readFile(presentationUrl, 'utf8')).replace(
    /from ['"]\.\/injury-replacement-window\.util(?:\.ts)?['"];/,
    `from '${injuryWindowUrl.href}';`,
  );
  const javascript = stripTypeScriptTypes(typescript, { mode: 'strip' });

  return import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
  );
}

async function loadBrowserWindowUtility() {
  const utilityUrl = new URL(
    'src/app/core/cycle/injury-replacement-window.util.ts',
    ROOT,
  );
  const typescript = await readFile(utilityUrl, 'utf8');
  const javascript = stripTypeScriptTypes(typescript, { mode: 'strip' });

  return import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
  );
}

const {
  buildInjuryReplacementPresentation,
  resolveCycleSlotScoreSummary,
} = await loadPresentationUtility();
const {
  normalizeInjuryReplacementWindowPlan: normalizeBrowserInjuryReplacementWindowPlan,
} = await loadBrowserWindowUtility();

const require = createRequire(import.meta.url);
const {
  buildInjuryReplacementWindowPlan,
  getInjuryReplacementAssetKeyByGameId,
  getInjuryReplacementGameIds,
  getInjuryReplacementPlanAuthorityFingerprint,
  getInjuryReplacementProtectedGameIds,
  hasConsistentInjuryReplacementWindowEvidence,
  hasExactInjuryReplacementScoringAssetKeyMap,
  hasPreservedInjuryReplacementProtectedGameOwnership,
  normalizeInjuryReplacementWindowPlan,
  requireValidInjuryReplacementWindowPlan,
  resolveConsistentInjuryReplacementWindowPlan,
} = require(
  '../../functions/lib/shared/core/cycle/injury-replacement-window.util.js',
);
const cycleScoring = require(
  '../../functions/lib/shared/core/cycle/cycle-scoring.service.js',
);
const nhlApi = require(
  '../../functions/lib/shared/core/nhl/nhl-api.service.js',
);
const scoringRules = require(
  '../../functions/lib/shared/core/scoring/scoring-rules.js',
);

async function source(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function section(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);

  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);

  return text.slice(start, end);
}

function skater(assetKey, playerId, name, position = 'C', team = 'SJS') {
  return {
    assetType: 'skater',
    assetKey,
    position,
    player: {
      id: playerId,
      fullName: name,
      firstName: name.split(' ')[0],
      lastName: name.split(' ').slice(1).join(' ') || 'Fixture',
      position,
      nhlTeamAbbreviation: team,
    },
  };
}

const injuredStarter = skater('skater-1', 1, 'Will Smith', 'C', 'SJS');
const firstReplacement = skater('skater-2', 2, 'Sam Bennett', 'C', 'FLA');
const secondReplacement = skater('skater-3', 3, 'Dylan Larkin', 'C', 'DET');

function firstReplacementPlan(startedCurrentGameIds = new Set([101, 102])) {
  const retainedGameCount = startedCurrentGameIds.size;

  return buildInjuryReplacementWindowPlan({
    currentAsset: injuredStarter,
    currentScheduledGameIds: [101, 102, 103, 104, 105, 106],
    startedCurrentGameIds,
    currentSourceTeamAbbreviation: 'SJS',
    incomingAsset: firstReplacement,
    incomingScheduledGameIds: [201, 202, 203, 204, 205, 206]
      .slice(0, 6 - retainedGameCount),
    incomingSourceTeamAbbreviation: 'FLA',
    transactionId: 'txn-one',
    boundaryMilliseconds: 1_000,
    requiredGames: 6,
  });
}

function scoreSource(plan, input = {}) {
  const scheduledGameIds = getInjuryReplacementGameIds(plan);
  const gameStates = input.gameStates ?? Object.fromEntries(
    scheduledGameIds.map((gameId) => [String(gameId), 'scheduled']),
  );

  return {
    ownerId: 'owner-a',
    rosterSlotId: 'C-1',
    windowId: 'owner-a__C-1__cycle-1',
    assetKey: plan.segments.at(-1).assetKey,
    currentScore: input.currentScore ?? 0,
    scheduledGameIds,
    completedGameIds: input.completedGameIds ?? scheduledGameIds.filter(
      (gameId) => gameStates[String(gameId)] === 'final',
    ),
    injuryReplacementWindow: plan,
    gameScores: input.gameScores ?? {},
    gameStates,
  };
}

describe('injury-replacement ownership integrity', () => {
  test('a replacement before game one retains the outgoing player as an empty audit segment', () => {
    const plan = firstReplacementPlan(new Set());
    const normalized = normalizeInjuryReplacementWindowPlan(plan);

    assert.ok(normalized);
    assert.equal(normalized.replacementCount, 1);
    assert.deepEqual(
      normalized.segments.map((segment) => ({
        reason: segment.reason,
        assetKey: segment.assetKey,
        gameIds: segment.scheduledGameIds,
      })),
      [
        { reason: 'original', assetKey: 'skater-1', gameIds: [] },
        {
          reason: 'injury-replacement',
          assetKey: 'skater-2',
          gameIds: [201, 202, 203, 204, 205, 206],
        },
      ],
    );
  });

  test('a second pregame injury retains both earlier empty audit segments and still normalizes', () => {
    const firstPlan = firstReplacementPlan(new Set());
    const secondPlan = buildInjuryReplacementWindowPlan({
      previousPlan: firstPlan,
      currentAsset: firstReplacement,
      currentScheduledGameIds: [201, 202, 203, 204, 205, 206],
      startedCurrentGameIds: new Set(),
      currentSourceTeamAbbreviation: 'FLA',
      incomingAsset: secondReplacement,
      incomingScheduledGameIds: [301, 302, 303, 304, 305, 306],
      incomingSourceTeamAbbreviation: 'DET',
      transactionId: 'txn-two',
      boundaryMilliseconds: 2_000,
      requiredGames: 6,
    });
    const normalized = normalizeInjuryReplacementWindowPlan(secondPlan);

    assert.ok(normalized);
    assert.equal(normalized.replacementCount, 2);
    assert.deepEqual(
      normalized.segments.map((segment) => ({
        reason: segment.reason,
        assetKey: segment.assetKey,
        gameIds: segment.scheduledGameIds,
      })),
      [
        { reason: 'original', assetKey: 'skater-1', gameIds: [] },
        { reason: 'injury-replacement', assetKey: 'skater-2', gameIds: [] },
        {
          reason: 'injury-replacement',
          assetKey: 'skater-3',
          gameIds: [301, 302, 303, 304, 305, 306],
        },
      ],
    );
  });

  test('recognizes the exact legacy zero-start shape without inventing the missing outgoing player', () => {
    const auditedPlan = firstReplacementPlan(new Set());
    const legacyPlan = {
      ...structuredClone(auditedPlan),
      segments: [structuredClone(auditedPlan.segments[1])],
    };
    const normalizedLegacy = normalizeInjuryReplacementWindowPlan(legacyPlan);

    assert.ok(normalizedLegacy);
    assert.equal(normalizedLegacy.replacementCount, 1);
    assert.deepEqual(
      normalizedLegacy.segments.map((segment) => [
        segment.reason,
        segment.assetKey,
        segment.scheduledGameIds,
      ]),
      [['injury-replacement', 'skater-2', [201, 202, 203, 204, 205, 206]]],
    );

    const repeatedPlan = buildInjuryReplacementWindowPlan({
      previousPlan: normalizedLegacy,
      currentAsset: firstReplacement,
      currentScheduledGameIds: [201, 202, 203, 204, 205, 206],
      startedCurrentGameIds: new Set([201]),
      currentSourceTeamAbbreviation: 'FLA',
      incomingAsset: secondReplacement,
      incomingScheduledGameIds: [301, 302, 303, 304, 305],
      incomingSourceTeamAbbreviation: 'DET',
      transactionId: 'txn-two',
      boundaryMilliseconds: 2_000,
      requiredGames: 6,
    });

    assert.equal(repeatedPlan.replacementCount, 2);
    assert.deepEqual(
      repeatedPlan.segments.map((segment) => segment.reason),
      ['injury-replacement', 'injury-replacement'],
    );
    assert.equal(getInjuryReplacementGameIds(repeatedPlan).length, 6);
  });

  test('the builder rejects a cross-segment game-id overlap instead of returning a non-normalizable plan', () => {
    assert.throws(
      () => buildInjuryReplacementWindowPlan({
        currentAsset: injuredStarter,
        currentScheduledGameIds: [101, 102, 103, 104, 105, 106],
        startedCurrentGameIds: new Set([101]),
        currentSourceTeamAbbreviation: 'SJS',
        incomingAsset: firstReplacement,
        incomingScheduledGameIds: [101, 201, 202, 203, 204],
        incomingSourceTeamAbbreviation: 'FLA',
        transactionId: 'txn-overlap',
        boundaryMilliseconds: 1_000,
        requiredGames: 6,
      }),
      /valid ownership plan|unique|overlap/i,
    );
  });

  test('distinguishes absent ownership from malformed or conflicting saved ownership', () => {
    const valid = firstReplacementPlan();
    const malformed = {
      ...structuredClone(valid),
      segments: [],
    };
    const conflicting = structuredClone(valid);
    conflicting.latestTransactionId = 'txn-conflict';
    conflicting.segments[1].segmentId = 'txn-conflict__replacement-1';

    assert.equal(
      requireValidInjuryReplacementWindowPlan(undefined, 'Missing fixture'),
      null,
    );
    assert.throws(
      () => requireValidInjuryReplacementWindowPlan(malformed, 'Malformed fixture'),
      /invalid injury-replacement ownership evidence/i,
    );
    assert.throws(
      () => resolveConsistentInjuryReplacementWindowPlan({
        values: [valid, conflicting],
        context: 'Conflicting fixture',
      }),
      /conflicting injury-replacement ownership evidence/i,
    );
  });

  test('accepts scorer-managed trade evolution only for the latest segment', () => {
    const saved = firstReplacementPlan();
    const evolved = structuredClone(saved);
    evolved.segments[1].scheduledGameIds = [401, 402, 403, 404];
    evolved.segments[1].sourceTeamAbbreviation = 'DET';
    evolved.segments[1].sourceTeamAbbreviationByGameId = {
      401: 'DET',
      402: 'DET',
      403: 'DET',
      404: 'DET',
    };

    assert.equal(
      resolveConsistentInjuryReplacementWindowPlan({
        values: [evolved, saved],
        context: 'Trade-evolved fixture',
      }).segments[1].sourceTeamAbbreviation,
      'DET',
    );

    const corruptedPriorSegment = structuredClone(evolved);
    corruptedPriorSegment.segments[0].scheduledGameIds = [101, 999];
    corruptedPriorSegment.segments[0].sourceTeamAbbreviationByGameId = {
      101: 'SJS',
      999: 'SJS',
    };

    assert.throws(
      () => resolveConsistentInjuryReplacementWindowPlan({
        values: [corruptedPriorSegment, saved],
        context: 'Immutable prior-segment fixture',
      }),
      /conflicting injury-replacement ownership evidence/i,
    );
  });

  test('trade evolution may replace only unstarted IDs and must preserve protected ownership', () => {
    const previousPlan = firstReplacementPlan(new Set([101, 102]));
    const evolvedPlan = structuredClone(previousPlan);
    evolvedPlan.segments[1].scheduledGameIds = [201, 205, 206, 207];
    evolvedPlan.segments[1].sourceTeamAbbreviationByGameId = {
      '201': 'FLA',
      '205': 'FLA',
      '206': 'FLA',
      '207': 'FLA',
    };
    const protectedGameIds = getInjuryReplacementProtectedGameIds({
      completedGameIds: [101],
      liveGameIds: [201],
      incompleteFinalGameIds: [],
      appearanceGameIds: [201],
      gameStates: { '101': 'final', '201': 'live', '202': 'scheduled' },
    });
    const preserves = (nextPlan) =>
      hasPreservedInjuryReplacementProtectedGameOwnership({
        previousPlan,
        nextPlan,
        protectedGameIds,
        previousAssetKey: firstReplacement.assetKey,
        previousScheduleTeamAbbreviation: 'FLA',
      });

    assert.ok(normalizeInjuryReplacementWindowPlan(evolvedPlan));
    assert.equal(preserves(evolvedPlan), true);

    const droppedProtected = structuredClone(evolvedPlan);
    droppedProtected.segments[1].scheduledGameIds = [205, 206, 207, 208];
    droppedProtected.segments[1].sourceTeamAbbreviationByGameId = {
      '205': 'FLA',
      '206': 'FLA',
      '207': 'FLA',
      '208': 'FLA',
    };

    const reassignedProtected = structuredClone(evolvedPlan);
    reassignedProtected.segments[0].scheduledGameIds.push(201);
    reassignedProtected.segments[0].sourceTeamAbbreviationByGameId['201'] = 'SJS';
    reassignedProtected.segments[1].scheduledGameIds = [205, 206, 207];
    delete reassignedProtected.segments[1].sourceTeamAbbreviationByGameId['201'];

    const changedSourceTeam = structuredClone(evolvedPlan);
    changedSourceTeam.segments[1].sourceTeamAbbreviationByGameId['201'] = 'TBL';

    for (const invalidEvolution of [
      droppedProtected,
      reassignedProtected,
      changedSourceTeam,
    ]) {
      assert.ok(normalizeInjuryReplacementWindowPlan(invalidEvolution));
      assert.equal(preserves(invalidEvolution), false);
    }
  });

  test('allows legitimate current-segment evolution across playoff-bank and cycle copies', () => {
    const saved = firstReplacementPlan();
    const evolved = structuredClone(saved);
    evolved.segments[1].scheduledGameIds = [201, 202, 401, 402];
    evolved.segments[1].sourceTeamAbbreviation = 'DET';
    evolved.segments[1].sourceTeamAbbreviationByGameId = {
      201: 'FLA',
      202: 'FLA',
      401: 'DET',
      402: 'DET',
    };

    const selected = resolveConsistentInjuryReplacementWindowPlan({
      values: [evolved, saved, evolved, saved],
      context: 'Playoff-bank atomic copy fixture',
    });

    assert.deepEqual(selected, evolved);
    assert.deepEqual(selected.segments[0], saved.segments[0]);
    assert.equal(
      getInjuryReplacementPlanAuthorityFingerprint(selected),
      getInjuryReplacementPlanAuthorityFingerprint(evolved),
    );
  });

  test('a repeated injury preserves the exact source team for every retained game after a trade', () => {
    const traded = structuredClone(firstReplacementPlan());
    traded.segments[1].scheduledGameIds = [201, 202, 401, 402];
    traded.segments[1].sourceTeamAbbreviation = 'DET';
    traded.segments[1].sourceTeamAbbreviationByGameId = {
      201: 'FLA',
      202: 'FLA',
      401: 'DET',
      402: 'DET',
    };
    const normalizedTraded = normalizeInjuryReplacementWindowPlan(traded);

    assert.ok(normalizedTraded);

    const repeated = buildInjuryReplacementWindowPlan({
      previousPlan: normalizedTraded,
      currentAsset: firstReplacement,
      currentScheduledGameIds: [201, 202, 401, 402],
      startedCurrentGameIds: new Set([201, 401]),
      currentSourceTeamAbbreviation: 'DET',
      currentSourceTeamAbbreviationByGameId: {
        201: 'FLA',
        202: 'FLA',
        401: 'DET',
        402: 'DET',
      },
      incomingAsset: secondReplacement,
      incomingScheduledGameIds: [301, 302],
      incomingSourceTeamAbbreviation: 'DET',
      transactionId: 'txn-two',
      boundaryMilliseconds: 2_000,
      requiredGames: 6,
    });

    assert.deepEqual(
      repeated.segments[1].sourceTeamAbbreviationByGameId,
      { 201: 'FLA', 401: 'DET' },
    );
    assert.deepEqual(
      repeated.segments[2].sourceTeamAbbreviationByGameId,
      { 301: 'DET', 302: 'DET' },
    );
    assert.equal(
      resolveConsistentInjuryReplacementWindowPlan({
        values: [normalizedTraded, repeated],
        context: 'Advanced replacement fixture',
      }).latestTransactionId,
      'txn-two',
    );

    const injectedHistoricalGame = structuredClone(repeated);
    injectedHistoricalGame.segments[1].scheduledGameIds = [999, 401];
    injectedHistoricalGame.segments[1].sourceTeamAbbreviationByGameId = {
      999: 'FLA',
      401: 'DET',
    };

    assert.throws(
      () => resolveConsistentInjuryReplacementWindowPlan({
        values: [normalizedTraded, injectedHistoricalGame],
        context: 'Injected historical game fixture',
      }),
      /conflicting injury-replacement ownership evidence/i,
    );

    const reassignedHistoricalTeam = structuredClone(repeated);
    reassignedHistoricalTeam.segments[1].sourceTeamAbbreviationByGameId = {
      201: 'DET',
      401: 'DET',
    };

    assert.throws(
      () => resolveConsistentInjuryReplacementWindowPlan({
        values: [normalizedTraded, reassignedHistoricalTeam],
        context: 'Reassigned historical source fixture',
      }),
      /conflicting injury-replacement ownership evidence/i,
    );
  });

  test('rejects duplicate IDs and inconsistent replacement lineage instead of sanitizing it', () => {
    const valid = firstReplacementPlan();
    const duplicateWithinSegment = structuredClone(valid);
    duplicateWithinSegment.segments[1].scheduledGameIds = [201, 201, 202, 203];
    const wrongCount = structuredClone(valid);
    wrongCount.replacementCount = 2;
    const wrongReasonOrder = structuredClone(valid);
    wrongReasonOrder.segments[0].reason = 'injury-replacement';

    assert.equal(normalizeInjuryReplacementWindowPlan(duplicateWithinSegment), null);
    assert.equal(normalizeInjuryReplacementWindowPlan(wrongCount), null);
    assert.equal(normalizeInjuryReplacementWindowPlan(wrongReasonOrder), null);
  });

  test('requires an explicit per-game source-team map to be complete and exact', () => {
    const valid = firstReplacementPlan();
    const partialMap = structuredClone(valid);
    partialMap.segments[1].sourceTeamAbbreviationByGameId = { 201: 'FLA' };
    const extraMap = structuredClone(valid);
    extraMap.segments[1].sourceTeamAbbreviationByGameId = {
      ...extraMap.segments[1].sourceTeamAbbreviationByGameId,
      999: 'FLA',
    };
    const legacyAbsentMap = structuredClone(valid);
    for (const segment of legacyAbsentMap.segments) {
      delete segment.sourceTeamAbbreviationByGameId;
    }

    assert.equal(normalizeInjuryReplacementWindowPlan(partialMap), null);
    assert.equal(normalizeInjuryReplacementWindowPlan(extraMap), null);
    const normalizedLegacy = normalizeInjuryReplacementWindowPlan(legacyAbsentMap);
    assert.ok(normalizedLegacy);

    const materializedFallback = structuredClone(normalizedLegacy);
    for (const segment of materializedFallback.segments) {
      segment.sourceTeamAbbreviationByGameId = Object.fromEntries(
        segment.scheduledGameIds.map((gameId) => [
          String(gameId),
          segment.sourceTeamAbbreviation,
        ]),
      );
    }

    assert.equal(
      getInjuryReplacementPlanAuthorityFingerprint(normalizedLegacy),
      getInjuryReplacementPlanAuthorityFingerprint(materializedFallback),
    );
    assert.deepEqual(
      resolveConsistentInjuryReplacementWindowPlan({
        values: [materializedFallback, normalizedLegacy],
        context: 'Legacy source-map materialization fixture',
      }),
      materializedFallback,
    );
  });

  test('window evidence must exactly match its plan schedule, owner map, position, and protected IDs', () => {
    const plan = firstReplacementPlan(new Set([101]));
    const scheduledGameIds = getInjuryReplacementGameIds(plan);
    const scoringAssetKeyByGameId = getInjuryReplacementAssetKeyByGameId(plan);
    const baseEvidence = {
      plan,
      scheduledGameIds,
      scoringAssetKeyByGameId,
      assetKey: firstReplacement.assetKey,
      ownerId: 'owner-a',
      rosterSlotId: 'C-1',
      position: 'C',
      scheduleTeamAbbreviation: 'FLA',
      sourceTeamAbbreviationByGameId: {
        '101': 'SJS',
        '201': 'FLA',
        '202': 'FLA',
        '203': 'FLA',
        '204': 'FLA',
        '205': 'FLA',
      },
      completedGameIds: [101],
      liveGameIds: [],
      incompleteFinalGameIds: [],
      appearanceGameIds: [101],
      gameStates: { '101': 'final' },
    };

    assert.equal(
      hasConsistentInjuryReplacementWindowEvidence(baseEvidence),
      true,
    );
    assert.equal(
      hasConsistentInjuryReplacementWindowEvidence({
        ...baseEvidence,
        scheduledGameIds: [...scheduledGameIds].reverse(),
      }),
      false,
    );
    assert.equal(
      hasConsistentInjuryReplacementWindowEvidence({
        ...baseEvidence,
        scoringAssetKeyByGameId: { ...scoringAssetKeyByGameId, '999': 'skater-1' },
      }),
      false,
    );
    assert.equal(
      hasConsistentInjuryReplacementWindowEvidence({
        ...baseEvidence,
        position: 'D',
      }),
      false,
    );
    assert.equal(
      hasConsistentInjuryReplacementWindowEvidence({
        ...baseEvidence,
        completedGameIds: [101, 999],
      }),
      false,
    );

    const wrongScopePlan = structuredClone(plan);
    wrongScopePlan.segments[0].playerWindowContinuity = {
      schemaVersion: 1,
      continuityId: 'owner-b::C-2::skater-1::wrong-scope-original',
      ownerId: 'owner-b',
      rosterSlotId: 'C-2',
      assetKey: wrongScopePlan.segments[0].assetKey,
      priorAssignedGameIds: [],
    };
    wrongScopePlan.segments[1].playerWindowContinuity = {
      schemaVersion: 1,
      continuityId: 'owner-b::C-2::skater-2::wrong-scope-replacement',
      ownerId: 'owner-b',
      rosterSlotId: 'C-2',
      assetKey: wrongScopePlan.segments[1].assetKey,
      assignmentNotBeforeMilliseconds: 1_000,
      priorAssignedGameIds: [],
    };
    const normalizedWrongScopePlan = normalizeInjuryReplacementWindowPlan(
      wrongScopePlan,
    );
    assert.ok(normalizedWrongScopePlan);
    assert.equal(
      hasConsistentInjuryReplacementWindowEvidence({
        ...baseEvidence,
        plan: normalizedWrongScopePlan,
      }),
      false,
    );
  });

  test('rejects a segment whose skater identity can disagree with its asset key', () => {
    const valid = firstReplacementPlan();
    const wrongPlayer = structuredClone(valid);
    wrongPlayer.segments[1].asset.player.id = 99;
    const missingPlayer = structuredClone(valid);
    delete missingPlayer.segments[1].asset.player;
    const wrongPosition = structuredClone(valid);
    wrongPosition.segments[1].asset.player.position = 'D';

    assert.equal(normalizeInjuryReplacementWindowPlan(wrongPlayer), null);
    assert.equal(normalizeInjuryReplacementWindowPlan(missingPlayer), null);
    assert.equal(normalizeInjuryReplacementWindowPlan(wrongPosition), null);
  });

  test('rejects missing or corrupt replacement boundaries and continuity evidence', () => {
    const validPlan = firstReplacementPlan(new Set([101]));
    validPlan.segments[1].playerWindowContinuity = {
      schemaVersion: 1,
      continuityId: 'owner-a::C-1::skater-2::injury-txn-one',
      ownerId: 'owner-a',
      rosterSlotId: 'C-1',
      assetKey: 'skater-2',
      assignmentNotBeforeMilliseconds: 1_000,
      priorAssignedGameIds: [],
    };

    assert.ok(normalizeInjuryReplacementWindowPlan(validPlan));
    assert.ok(normalizeBrowserInjuryReplacementWindowPlan(validPlan));

    const mutations = [
      (plan) => { delete plan.segments[1].assignmentNotBeforeMilliseconds; },
      (plan) => { delete plan.segments[1].activatedAtMilliseconds; },
      (plan) => { plan.segments[1].assignmentNotBeforeMilliseconds = Number.NaN; },
      (plan) => { plan.segments[1].activatedAtMilliseconds = 1_001; },
      (plan) => { plan.segments[1].activatedAtMilliseconds = -1; },
      (plan) => { plan.segments[1].playerWindowContinuity.schemaVersion = 2; },
      (plan) => { plan.segments[1].playerWindowContinuity.assetKey = 'skater-999'; },
      (plan) => {
        plan.segments[1].playerWindowContinuity.assignmentNotBeforeMilliseconds = 999;
      },
      (plan) => {
        plan.segments[1].playerWindowContinuity.assignmentNotBeforeMilliseconds = 1_000.9;
      },
      (plan) => {
        plan.segments[1].playerWindowContinuity.priorAssignedGameIds = [77, 77];
      },
      (plan) => {
        plan.segments[0].playerWindowContinuity = {
          schemaVersion: 1,
          continuityId: 'owner-b::C-9::skater-1::draft',
          ownerId: 'owner-b',
          rosterSlotId: 'C-9',
          assetKey: 'skater-1',
          priorAssignedGameIds: [],
        };
      },
      (plan) => { plan.segments[0].segmentId = 'txn-one__not-original'; },
      (plan) => { plan.segments[1].segmentId = 'txn-one__replacement-2'; },
      (plan) => { plan.latestTransactionId = 'different-latest-transaction'; },
      (plan) => {
        plan.segments[0].asset.position = 'D';
        plan.segments[0].asset.player.position = 'D';
      },
    ];

    for (const mutate of mutations) {
      const candidate = structuredClone(validPlan);
      mutate(candidate);
      assert.equal(normalizeInjuryReplacementWindowPlan(candidate), null);
      assert.equal(normalizeBrowserInjuryReplacementWindowPlan(candidate), null);
    }

    const repeatedPlan = buildInjuryReplacementWindowPlan({
      previousPlan: firstReplacementPlan(new Set()),
      currentAsset: firstReplacement,
      currentScheduledGameIds: [201, 202, 203, 204, 205, 206],
      startedCurrentGameIds: new Set(),
      currentSourceTeamAbbreviation: 'FLA',
      incomingAsset: secondReplacement,
      incomingScheduledGameIds: [301, 302, 303, 304, 305, 306],
      incomingSourceTeamAbbreviation: 'DET',
      transactionId: 'txn-two',
      boundaryMilliseconds: 2_000,
      requiredGames: 6,
    });
    repeatedPlan.segments.at(-1).assignmentNotBeforeMilliseconds = 500;
    repeatedPlan.segments.at(-1).activatedAtMilliseconds = 500;
    assert.equal(normalizeInjuryReplacementWindowPlan(repeatedPlan), null);
    assert.equal(normalizeBrowserInjuryReplacementWindowPlan(repeatedPlan), null);
  });
});

describe('injury-replacement score presentation', () => {
  test('labels a retained zero-game audit segment without producing an inverted game range', () => {
    const plan = firstReplacementPlan(new Set());
    const presentation = buildInjuryReplacementPresentation(
      scoreSource(plan, { currentScore: 0 }),
    );

    assert.ok(presentation);
    assert.deepEqual(
      presentation.segments.map((segment) => ({
        assetName: segment.assetName,
        points: segment.points,
        gameCount: segment.gameCount,
        gameRangeLabel: segment.gameRangeLabel,
      })),
      [
        {
          assetName: 'Will Smith',
          points: 0,
          gameCount: 0,
          gameRangeLabel: 'No games',
        },
        {
          assetName: 'Sam Bennett',
          points: 0,
          gameCount: 6,
          gameRangeLabel: 'Games 1–6',
        },
      ],
    );
    assert.doesNotMatch(presentation.accessibleLabel, /Games 1[–-]0/);
  });

  test('sums each player segment, preserves an explicit zero, and leaves scheduled missing scores at zero', () => {
    const plan = firstReplacementPlan();
    const presentation = buildInjuryReplacementPresentation(
      scoreSource(plan, {
        currentScore: 34,
        gameScores: {
          101: 0,
          102: 26,
          201: 8,
        },
        gameStates: {
          101: 'final',
          102: 'final',
          201: 'final',
          202: 'scheduled',
          203: 'scheduled',
          204: 'scheduled',
        },
      }),
    );

    assert.ok(presentation);
    assert.equal(presentation.totalPoints, 34);
    assert.deepEqual(
      presentation.segments.map((segment) => ({
        assetName: segment.assetName,
        points: segment.points,
        gameRangeLabel: segment.gameRangeLabel,
        current: segment.current,
      })),
      [
        {
          assetName: 'Will Smith',
          points: 26,
          gameRangeLabel: 'Games 1–2',
          current: false,
        },
        {
          assetName: 'Sam Bennett',
          points: 8,
          gameRangeLabel: 'Games 3–6',
          current: true,
        },
      ],
    );
    assert.match(presentation.accessibleLabel, /Will Smith/i);
    assert.match(presentation.accessibleLabel, /Sam Bennett/i);
    assert.match(presentation.accessibleLabel, /34/);
  });

  test('fails closed when a begun game is missing score evidence or the segment sum disagrees with the total', () => {
    const plan = firstReplacementPlan();
    const missingFinalEvidence = scoreSource(plan, {
      currentScore: 8,
      gameScores: { 101: 0, 201: 8 },
      gameStates: {
        101: 'final',
        102: 'final',
        201: 'final',
        202: 'scheduled',
        203: 'scheduled',
        204: 'scheduled',
      },
    });
    const mismatchedTotal = scoreSource(plan, {
      currentScore: 35,
      gameScores: { 101: 0, 102: 26, 201: 8 },
      gameStates: {
        101: 'final',
        102: 'final',
        201: 'final',
        202: 'scheduled',
        203: 'scheduled',
        204: 'scheduled',
      },
    });

    assert.equal(buildInjuryReplacementPresentation(missingFinalEvidence), null);
    assert.equal(buildInjuryReplacementPresentation(mismatchedTotal), null);
  });

  test('marks every replacement boundary and keeps a zero-point middle player visible', () => {
    const firstPlan = firstReplacementPlan();
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
    const presentation = buildInjuryReplacementPresentation(
      scoreSource(secondPlan, {
        currentScore: 34,
        gameScores: { 101: 10, 102: 16, 201: 0, 301: 8 },
        gameStates: {
          101: 'final',
          102: 'final',
          201: 'final',
          301: 'final',
          302: 'scheduled',
          303: 'scheduled',
        },
      }),
    );

    assert.ok(presentation);
    assert.deepEqual(
      presentation.segments.map((segment) => [
        segment.assetName,
        segment.points,
        segment.current,
      ]),
      [
        ['Will Smith', 26, false],
        ['Sam Bennett', 0, false],
        ['Dylan Larkin', 8, true],
      ],
    );
    assert.deepEqual(
      presentation.gameOwnership
        .filter((game) => game.segmentStart)
        .map((game) => [game.gameNumber, game.assetName, game.currentSegment]),
      [
        [3, 'Sam Bennett', false],
        [4, 'Dylan Larkin', true],
      ],
    );
    assert.match(
      presentation.gameOwnership[3].ariaLabel,
      /Game 4.*Dylan Larkin.*replacement/i,
    );
  });

  test('resolves a replaced slot by exact window, then owner and slot, before asset fallback', () => {
    const exactWindow = {
      windowId: 'owner-a__C-1__cycle-1',
      ownerId: 'owner-a',
      rosterSlotId: 'C-1',
      assetKey: 'skater-2',
      currentScore: 34,
    };
    const sameAssetElsewhere = {
      windowId: 'owner-b__C-2__cycle-1',
      ownerId: 'owner-b',
      rosterSlotId: 'C-2',
      assetKey: 'skater-2',
      currentScore: 5,
    };
    const result = {
      windowScores: {
        [exactWindow.windowId]: exactWindow,
        [sameAssetElsewhere.windowId]: sameAssetElsewhere,
      },
      assetScores: { 'skater-2': sameAssetElsewhere },
    };

    assert.equal(
      resolveCycleSlotScoreSummary(result, {
        ownerId: 'owner-a',
        rosterSlotId: 'C-1',
        cycleWindowId: exactWindow.windowId,
        assetKey: 'skater-2',
      }),
      exactWindow,
    );
    assert.equal(
      resolveCycleSlotScoreSummary(result, {
        ownerId: 'owner-a',
        rosterSlotId: 'C-1',
        cycleWindowId: 'stale-window-id',
        assetKey: 'skater-2',
      }),
      exactWindow,
    );
  });
});

describe('injury-replacement server authority contracts', () => {
  test('rejects a reserved incoming bench player both before slow work and again in the transaction', async () => {
    const rosterMoves = await source('functions/src/roster-moves.ts');
    const preflightBench = section(
      rosterMoves,
      'const preflightBenchSlot =',
      '      } else {',
    );
    const transactionInjuryReplacement = section(
      rosterMoves,
      "} else if (moveType === 'injury-replacement') {",
      "} else if (moveType === 'active-bench-swap') {",
    );

    assert.match(
      preflightBench,
      /isBenchSlotReserved\(preflightRoster,\s*(?:benchSlotId|preflightBenchSlot\.slotId)\)/,
    );
    assert.match(
      transactionInjuryReplacement,
      /isBenchSlotReserved\(roster,\s*(?:benchSlotId|benchSlot\.slotId)\)/,
    );
    assert.match(preflightBench, /reserved for another scheduled lineup move/i);
    assert.match(transactionInjuryReplacement, /reserved for another scheduled lineup move/i);
  });

  test('rereads authoritative injury eligibility inside the Firestore transaction', async () => {
    const rosterMoves = await source('functions/src/roster-moves.ts');
    const transactionAvailability = section(
      rosterMoves,
      "let transactionMoveToIrAvailabilityStatus = '';",
      "if (\n        (moveType === 'add-drop-active'",
    );
    const transactionInjuryReplacement = section(
      rosterMoves,
      "} else if (moveType === 'injury-replacement') {",
      "} else if (moveType === 'active-bench-swap') {",
    );

    assert.match(transactionAvailability, /transaction\.get\([\s\S]*playerAvailability/);
    assert.match(
      transactionAvailability,
      /transaction\.get\(db\.doc\('appData\/playerAvailability'\)\)/,
    );
    assert.match(
      transactionAvailability,
      /resolveAuthoritativeAvailabilityStatus\([\s\S]*transactionMoveToIrAvailabilityStatus/,
    );
    assert.match(transactionAvailability, /IR_ELIGIBLE_STATUSES\.has/);
    assert.doesNotMatch(
      transactionInjuryReplacement,
      /IR_ELIGIBLE_STATUSES\.has\(preflightMoveToIrAvailabilityStatus\)/,
    );
  });

  test('secure IR and queued-swap actions repeat injury and reservation checks in their transaction', async () => {
    const rosterAuthority = await source('functions/src/roster-authority.ts');
    const simpleOwnerAction = section(
      rosterAuthority,
      'async function executeSimpleOwnerAction(',
      'async function placeWaiverClaim(',
    );
    const transactionBody = simpleOwnerAction.slice(
      simpleOwnerAction.indexOf('return db.runTransaction(async (transaction: any) => {'),
    );
    const activeToIr = section(
      transactionBody,
      "if (action === 'move-active-to-ir') {",
      "if (action === 'activate-ir-active') {",
    );
    const queuedSwap = section(
      transactionBody,
      "if (action === 'queue-active-bench-swap') {",
      "if (action === 'move-bench-to-ir') {",
    );
    const benchToIr = section(
      transactionBody,
      "if (action === 'move-bench-to-ir') {",
      "if (action === 'activate-ir-to-bench') {",
    );

    for (const irMove of [activeToIr, benchToIr]) {
      assert.match(irMove, /transaction\.get\([\s\S]*playerAvailability/);
      assert.match(irMove, /resolveAuthoritativeAvailabilityStatus\(/);
      assert.match(irMove, /IR_ELIGIBLE_STATUSES\.has\(status\)/);
    }
    assert.match(queuedSwap, /isBenchSlotReserved\(roster, benchSlotId\)/);
    assert.match(queuedSwap, /reserved for another scheduled lineup move/i);
  });

  test('server and browser scoring fail visibly for malformed-present ownership while roster moves reject disagreement', async () => {
    const [serverScoring, browserScoring, rosterMoves] = await Promise.all([
      source('functions/src/shared/core/cycle/cycle-scoring.service.ts'),
      source('src/app/core/cycle/cycle-scoring.service.ts'),
      source('functions/src/roster-moves.ts'),
    ]);
    const moveSelection = section(
      rosterMoves,
      'function selectCurrentInjuryReplacementPlanFromCopies(',
      'function rosterContainsAsset(',
    );

    assert.match(serverScoring, /requireValidInjuryReplacementWindowPlan/);
    assert.match(browserScoring, /requireValidInjuryReplacementWindowPlan/);
    assert.doesNotMatch(
      serverScoring,
      /normalizeInjuryReplacementWindowPlan\(pick\.injuryReplacementWindow\)/,
    );
    assert.doesNotMatch(
      browserScoring,
      /normalizeInjuryReplacementWindowPlan\(\s*pick\.injuryReplacementWindow/,
    );
    assert.match(moveSelection, /resolveConsistentInjuryReplacementWindowPlan/);
    assert.match(moveSelection, /throw new HttpsError/);
    assert.match(moveSelection, /No roster move was applied/i);
  });

  test('schedule verification follows every saved source team through the shared NHL fetcher', async () => {
    const rosterMoves = await source('functions/src/roster-moves.ts');
    const scheduleLoader = section(
      rosterMoves,
      'async function loadRosterMoveScheduleForTeam(',
      'function getStartedScheduledGameIds(',
    );
    const injuryPreflight = section(
      rosterMoves,
      "if (moveType === 'injury-replacement') {",
      '    return db.runTransaction',
    );

    assert.match(scheduleLoader, /getNhlTeamSeasonSchedule\(/);
    assert.match(scheduleLoader, /'near-live-canary'/);
    assert.doesNotMatch(scheduleLoader, /await fetch\(/);
    assert.match(
      injuryPreflight,
      /sourceTeamAbbreviationByGameId\[String\(gameId\)\]/,
    );
    assert.match(injuryPreflight, /requiredTeamAbbreviations/);
    assert.match(injuryPreflight, /\.\.\.retainedSegmentTeamAbbreviations/);
    assert.match(injuryPreflight, /\.\.\.outgoingTeamAbbreviations/);
    assert.match(injuryPreflight, /loadRosterMoveScheduleForTeam\(teamAbbreviation\)/);
    assert.match(injuryPreflight, /verifiedScheduleEvidenceByGameId/);
    assert.match(injuryPreflight, /schedulesByTeam\.get\(sourceTeam\)/);
    assert.match(injuryPreflight, /homeTeam !== sourceTeam && awayTeam !== sourceTeam/);
    assert.match(
      injuryPreflight,
      /segment\.sourceTeamAbbreviationByGameId\?\.\[String\(gameId\)\]/,
    );
    assert.match(
      injuryPreflight,
      /previousPlan\.requiredGames !== gamesPerCycle/,
    );

    const outgoingSourceSelection = section(
      injuryPreflight,
      'const outgoingTeamAbbreviations =',
      'const retainedSegmentTeamAbbreviations =',
    );
    const planSourceLookup =
      'currentSegment?.sourceTeamAbbreviationByGameId?.[String(gameId)]';
    const windowSourceLookup =
      'asString(sourceTeamAbbreviationByGameId[String(gameId)])';

    assert.notEqual(
      outgoingSourceSelection.indexOf(planSourceLookup),
      -1,
      'Outgoing schedule verification must consult the saved current-segment per-game source team.',
    );
    assert.notEqual(
      outgoingSourceSelection.indexOf(windowSourceLookup),
      -1,
      'Outgoing schedule verification must retain the top-level window map as a legacy fallback.',
    );
    assert.ok(
      outgoingSourceSelection.indexOf(planSourceLookup) <
        outgoingSourceSelection.indexOf(windowSourceLookup),
      'The segment ownership plan must take precedence over the top-level window fallback.',
    );
  });

  test('playoff injury ownership is copied and race-checked atomically across bank and cycle evidence', async () => {
    const rosterMoves = await source('functions/src/roster-moves.ts');
    const copySelector = section(
      rosterMoves,
      'function selectCurrentInjuryReplacementPlanFromCopies(',
      'function selectCurrentInjuryReplacementPlan(',
    );
    const preflightReads = section(
      rosterMoves,
      'const [\n      preflightRosterSnapshot,',
      '    const preflightRoster =',
    );
    const injuryPreflight = section(
      rosterMoves,
      "if (moveType === 'injury-replacement') {",
      '    return db.runTransaction',
    );
    const transactionInjuryReplacement = section(
      rosterMoves,
      "} else if (moveType === 'injury-replacement') {",
      "} else if (moveType === 'active-bench-swap') {",
    );

    assert.match(copySelector, /presentCopies\.length > 0/);
    assert.match(copySelector, /presentCopies\.length !== copies\.length/);
    assert.match(copySelector, /resolveConsistentInjuryReplacementWindowPlan\(/);
    assert.match(preflightReads, /preflightPlayoffBankSnapshot/);
    assert.match(preflightReads, /playoffBankRef[\s\S]*playoffBankRef\.get\(\)/);

    for (const identifier of [
      'preflightBankPick',
      'preflightBankWindow',
    ]) {
      assert.match(injuryPreflight, new RegExp(identifier));
    }
    assert.match(
      injuryPreflight,
      /selectCurrentInjuryReplacementPlanFromCopies\([\s\S]*preflightWindow[\s\S]*preflightBankWindow[\s\S]*pickData[\s\S]*preflightBankPick/,
    );
    assert.match(
      injuryPreflight,
      /assertWindowPreservesSelectedInjuryReplacementPlan\([\s\S]*preflightWindow/,
    );
    assert.match(
      injuryPreflight,
      /assertWindowPreservesSelectedInjuryReplacementPlan\([\s\S]*preflightBankWindow/,
    );

    for (const identifier of ['savedBankPick', 'savedBankWindow']) {
      assert.match(transactionInjuryReplacement, new RegExp(identifier));
    }
    assert.match(
      transactionInjuryReplacement,
      /selectCurrentInjuryReplacementPlanFromCopies\([\s\S]*savedWindow[\s\S]*savedBankWindow[\s\S]*savedPickData[\s\S]*savedBankPick/,
    );
    assert.match(
      transactionInjuryReplacement,
      /getInjuryReplacementPlanAuthorityFingerprint\(savedExistingPlan\)[\s\S]*preflightExistingInjuryPlanFingerprint/,
    );
    assert.match(
      transactionInjuryReplacement,
      /assertWindowPreservesSelectedInjuryReplacementPlan\([\s\S]*savedWindow/,
    );
    assert.match(
      transactionInjuryReplacement,
      /assertWindowPreservesSelectedInjuryReplacementPlan\([\s\S]*savedBankWindow/,
    );
    assert.match(transactionInjuryReplacement, /throw new HttpsError\(\s*'aborted'/);
  });

  test('server and browser scoring resolve historical segment games through their exact source teams', async () => {
    const [serverScoring, browserScoring] = await Promise.all([
      source('functions/src/shared/core/cycle/cycle-scoring.service.ts'),
      source('src/app/core/cycle/cycle-scoring.service.ts'),
    ]);

    for (const scorer of [serverScoring, browserScoring]) {
      assert.match(
        scorer,
        /segment\.sourceTeamAbbreviationByGameId\?\.\[String\(gameId\)\]/,
      );
      assert.match(scorer, /schedulesByTeam\[sourceTeam\]/);
    }

    assert.match(
      serverScoring,
      /previous\?\.sourceTeamAbbreviationByGameId\?\.\[String\(gameId\)\]/,
    );
    const scheduleDiscovery = section(
      serverScoring,
      'function getUniqueDraftedTeams(',
      'function getUniqueSkaterAssets(',
    );
    assert.match(scheduleDiscovery, /previousResult\?\.windowScores\?\.\[windowId\]/);
    assert.match(scheduleDiscovery, /previousInjuryReplacementPlan/);
    assert.match(scheduleDiscovery, /resolveConsistentInjuryReplacementWindowPlan\(/);
    assert.match(scheduleDiscovery, /injuryReplacementPlan\.segments\.map/);
    assert.match(scheduleDiscovery, /segment\.sourceTeamAbbreviation/);
    assert.match(scheduleDiscovery, /segment\.sourceTeamAbbreviationByGameId/);
    assert.match(
      serverScoring,
      /resolveConsistentInjuryReplacementWindowPlan\([\s\S]*previousInjuryReplacementPlan[\s\S]*savedInjuryReplacementPlan/,
    );
    assert.match(serverScoring, /effectiveSkaterAssetsByKey/);
    assert.match(
      serverScoring,
      /for \(const scoringAssets of scoringAssetByWindowGameId\.values\(\)\)/,
    );
    assert.match(
      serverScoring,
      /const skatersNeedingLogs = effectiveSkaterAssets\.filter/,
    );
    assert.match(serverScoring, /hasExactInjuryReplacementScoringAssetKeyMap\(/);
    assert.match(
      serverScoring,
      /hasPreservedInjuryReplacementProtectedGameOwnership\(/,
    );
    assert.match(serverScoring, /previousGameBelongsToCurrentSegment/);
  });

  test('a previous-result-only legacy plan discovers the outgoing team and settles its newly final log', async (t) => {
    const plan = firstReplacementPlan(new Set([101]));
    const legacyPlan = structuredClone(plan);
    for (const segment of legacyPlan.segments) {
      delete segment.sourceTeamAbbreviationByGameId;
    }

    const windowId = 'owner-a__C-1__cycle-1';
    const scheduledGameIds = getInjuryReplacementGameIds(legacyPlan);
    const previousSummary = {
      windowId,
      ownerId: 'owner-a',
      rosterSlotId: 'C-1',
      cycleNumber: 1,
      assetKey: firstReplacement.assetKey,
      asset: firstReplacement,
      status: 'active',
      currentScore: 0,
      scheduledGameIds,
      completedGameIds: [],
      liveGameIds: [],
      appearanceGameIds: [],
      incompleteFinalGameIds: [101],
      gameScores: {},
      gameStates: { 101: 'final' },
      gameInputCompleteness: {},
      gamesPlayed: 0,
      actualGamesPlayed: 0,
      gamesLeft: 6,
      scheduleTeamAbbreviation: 'FLA',
      teamIdentityChanged: false,
      injuryReplacementWindow: legacyPlan,
      scoringAssetKeyByGameId:
        getInjuryReplacementAssetKeyByGameId(legacyPlan),
    };
    const scheduleCalls = [];
    const gameLogCalls = [];
    const scheduledGame = (id, team, state) => ({
      id,
      gameDate: '2026-10-01',
      startTimeUTC: '2026-10-01T23:00:00Z',
      gameType: 2,
      gameState: state,
      homeTeam: { abbrev: team, ...(state === 'FINAL' ? { score: 2 } : {}) },
      awayTeam: {
        abbrev: team === 'SJS' ? 'ANA' : 'TBL',
        ...(state === 'FINAL' ? { score: 1 } : {}),
      },
    });

    t.mock.method(nhlApi, 'getNhlTeamSeasonSchedule', async (team) => {
      scheduleCalls.push(team);
      return team === 'SJS'
        ? [scheduledGame(101, 'SJS', 'FINAL')]
        : [201, 202, 203, 204, 205].map((id) => scheduledGame(id, 'FLA', 'FUT'));
    });
    t.mock.method(nhlApi, 'getGameBoxscore', async () => ({
      homeTeam: { abbrev: 'SJS', score: 2 },
      awayTeam: { abbrev: 'ANA', score: 1 },
      playerByGameStats: {
        homeTeam: {
          forwards: [{
            playerId: injuredStarter.player.id,
            name: { default: injuredStarter.player.fullName },
            position: 'C',
            goals: 1,
            assists: 0,
            points: 1,
            plusMinus: 1,
            hits: 0,
            powerPlayGoals: 0,
            sog: 2,
            toi: '12:00',
            blockedShots: 0,
          }],
          defense: [],
          goalies: [],
        },
        awayTeam: { forwards: [], defense: [], goalies: [] },
      },
    }));
    t.mock.method(nhlApi, 'getGamePlayByPlay', async () => ({
      plays: [{
        eventId: 1,
        typeDescKey: 'goal',
        details: {
          scoringPlayerId: injuredStarter.player.id,
          homeScore: 1,
          awayScore: 0,
        },
      }],
    }));
    t.mock.method(nhlApi, 'getRegularSeasonGameLog', async (playerId) => {
      gameLogCalls.push(playerId);
      return {
        gameLog: playerId === injuredStarter.player.id
          ? [{
              gameId: 101,
              teamAbbrev: 'SJS',
              homeRoadFlag: 'H',
              gameDate: '2026-10-01',
              goals: 1,
              assists: 0,
              points: 1,
              plusMinus: 1,
              powerPlayPoints: 0,
              gameWinningGoals: 1,
              otGoals: 0,
              shots: 2,
              shorthandedPoints: 0,
              toi: '12:00',
              opponentAbbrev: 'ANA',
            }]
          : [],
      };
    });

    const result = await cycleScoring.calculateCycleScoring({
      picks: [{
        overallPick: 1,
        round: 1,
        pickInRound: 1,
        ownerId: 'owner-a',
        rosterSlotId: 'C-1',
        cycleWindowId: windowId,
        snapshotCycleNumber: 1,
        asset: firstReplacement,
      }],
      cycleNumber: 1,
      season: '20262027',
      requiredGamesPerCycle: 6,
      scoringRules: scoringRules.defaultScoringRules,
      previousResult: {
        cycleNumber: 1,
        assetScores: { [firstReplacement.assetKey]: previousSummary },
        windowScores: { [windowId]: previousSummary },
        teamScores: { 'owner-a': 0 },
        allGamesFinal: false,
        hasLiveGames: false,
        hasIncompleteFinalGames: true,
        nextScheduledStart: null,
        dataFingerprint: 'legacy-previous-only-fixture',
      },
    });

    assert.ok(scheduleCalls.includes('SJS'));
    assert.ok(scheduleCalls.includes('FLA'));
    assert.ok(gameLogCalls.includes(injuredStarter.player.id));
    assert.equal(
      result.windowScores[windowId].scoringAssetKeyByGameId['101'],
      injuredStarter.assetKey,
    );
    assert.ok(
      result.windowScores[windowId].completedGameIds.includes(101),
      JSON.stringify(result.windowScores[windowId].gameInputCompleteness['101']),
    );
  });

  test('missing, extra, or reassigned prior owner maps fail before NHL reads or final reuse', async (t) => {
    const plan = firstReplacementPlan(new Set([101]));
    const windowId = 'owner-a__C-1__cycle-1';
    const expectedMap = getInjuryReplacementAssetKeyByGameId(plan);
    const scheduleCalls = [];
    t.mock.method(nhlApi, 'getNhlTeamSeasonSchedule', async (team) => {
      scheduleCalls.push(team);
      return [];
    });
    const baseSummary = {
      ...scoreSource(plan, {
        gameStates: { '101': 'final' },
        completedGameIds: [101],
        gameScores: { '101': 2 },
      }),
      cycleNumber: 1,
      asset: firstReplacement,
      currentScore: 2,
      gamesPlayed: 1,
      actualGamesPlayed: 1,
      gamesLeft: 5,
      scheduleTeamAbbreviation: 'FLA',
      sourceTeamAbbreviationByGameId: {
        '101': 'SJS',
        '201': 'FLA',
        '202': 'FLA',
        '203': 'FLA',
        '204': 'FLA',
        '205': 'FLA',
      },
      incompleteFinalGameIds: [],
      gameInputCompleteness: {},
      status: 'active',
    };
    const invalidMaps = [
      undefined,
      { ...expectedMap, '999': injuredStarter.assetKey },
      { ...expectedMap, '101': firstReplacement.assetKey },
    ];

    for (const scoringAssetKeyByGameId of invalidMaps) {
      const previousSummary = {
        ...baseSummary,
        scoringAssetKeyByGameId,
      };

      await assert.rejects(
        cycleScoring.calculateCycleScoring({
          picks: [{
            overallPick: 1,
            round: 1,
            pickInRound: 1,
            ownerId: 'owner-a',
            rosterSlotId: 'C-1',
            cycleWindowId: windowId,
            snapshotCycleNumber: 1,
            asset: firstReplacement,
          }],
          cycleNumber: 1,
          season: '20262027',
          requiredGamesPerCycle: 6,
          scoringRules: scoringRules.defaultScoringRules,
          previousResult: {
            cycleNumber: 1,
            assetScores: { [firstReplacement.assetKey]: previousSummary },
            windowScores: { [windowId]: previousSummary },
            teamScores: { 'owner-a': 2 },
            allGamesFinal: false,
            hasLiveGames: false,
            hasIncompleteFinalGames: false,
            nextScheduledStart: null,
            dataFingerprint: 'invalid-owner-map-fixture',
          },
        }),
        /conflicting injury-replacement game ownership/,
      );
    }

    assert.deepEqual(scheduleCalls, []);
    assert.equal(hasExactInjuryReplacementScoringAssetKeyMap(plan, expectedMap), true);
  });

  test('opponent-overlap IDs do not borrow the outgoing owner or source team', async (t) => {
    const futureGame = (id, home, away) => ({
      id,
      gameDate: '2099-10-01',
      startTimeUTC: '2099-10-02T02:00:00Z',
      gameType: 2,
      gameState: 'FUT',
      homeTeam: { abbrev: home },
      awayTeam: { abbrev: away },
    });
    const sharedFlaDetGame = futureGame(201, 'FLA', 'DET');
    const schedules = {
      SJS: [futureGame(101, 'SJS', 'ANA')],
      FLA: [
        futureGame(105, 'FLA', 'SJS'),
        sharedFlaDetGame,
        futureGame(202, 'FLA', 'TBL'),
        futureGame(203, 'FLA', 'BOS'),
        futureGame(204, 'FLA', 'TOR'),
      ],
      DET: [
        sharedFlaDetGame,
        futureGame(301, 'DET', 'CHI'),
        futureGame(302, 'DET', 'CBJ'),
        futureGame(303, 'DET', 'PIT'),
      ],
    };
    t.mock.method(
      nhlApi,
      'getNhlTeamSeasonSchedule',
      async (team) => schedules[team] ?? [],
    );
    const windowId = 'owner-a__C-1__cycle-1';
    const firstPlan = buildInjuryReplacementWindowPlan({
      currentAsset: injuredStarter,
      currentScheduledGameIds: [101, 102, 103, 104, 105, 106],
      startedCurrentGameIds: new Set([101]),
      currentSourceTeamAbbreviation: 'SJS',
      incomingAsset: firstReplacement,
      incomingScheduledGameIds: [105, 201, 202, 203, 204],
      incomingSourceTeamAbbreviation: 'FLA',
      transactionId: 'overlap-first',
      boundaryMilliseconds: 1_000,
      requiredGames: 6,
    });
    const oldSingleAssetSummary = {
      ownerId: 'owner-a',
      rosterSlotId: 'C-1',
      windowId,
      assetKey: injuredStarter.assetKey,
      asset: injuredStarter,
      currentScore: 0,
      scheduledGameIds: [101, 102, 103, 104, 105, 106],
      completedGameIds: [],
      liveGameIds: [],
      appearanceGameIds: [],
      incompleteFinalGameIds: [],
      gameScores: {},
      gameStates: Object.fromEntries(
        [101, 102, 103, 104, 105, 106].map((id) => [String(id), 'scheduled']),
      ),
      gameInputCompleteness: {},
      scheduleTeamAbbreviation: 'SJS',
      sourceTeamAbbreviationByGameId: Object.fromEntries(
        [101, 102, 103, 104, 105, 106].map((id) => [String(id), 'SJS']),
      ),
      gamesPlayed: 0,
      actualGamesPlayed: 0,
      gamesLeft: 6,
      status: 'scheduled',
    };
    const scoringInput = (asset, plan, previousSummary) => ({
      picks: [{
        overallPick: 1,
        round: 1,
        pickInRound: 1,
        ownerId: 'owner-a',
        rosterSlotId: 'C-1',
        cycleWindowId: windowId,
        snapshotCycleNumber: 1,
        asset,
        injuryReplacementWindow: plan,
      }],
      cycleNumber: 1,
      season: '20262027',
      requiredGamesPerCycle: 6,
      scoringRules: scoringRules.defaultScoringRules,
      previousResult: {
        cycleNumber: 1,
        assetScores: { [previousSummary.assetKey]: previousSummary },
        windowScores: { [windowId]: previousSummary },
        teamScores: { 'owner-a': 0 },
        allGamesFinal: false,
        hasLiveGames: false,
        hasIncompleteFinalGames: false,
        nextScheduledStart: null,
        dataFingerprint: 'opponent-overlap-fixture',
      },
    });

    const firstResult = await cycleScoring.calculateCycleScoring(
      scoringInput(firstReplacement, firstPlan, oldSingleAssetSummary),
    );
    const firstSummary = firstResult.windowScores[windowId];
    assert.equal(firstSummary.scoringAssetKeyByGameId['105'], firstReplacement.assetKey);
    assert.equal(firstSummary.sourceTeamAbbreviationByGameId['105'], 'FLA');

    const secondPlan = buildInjuryReplacementWindowPlan({
      previousPlan: firstSummary.injuryReplacementWindow,
      currentAsset: firstReplacement,
      currentScheduledGameIds:
        firstSummary.injuryReplacementWindow.segments.at(-1).scheduledGameIds,
      startedCurrentGameIds: new Set([105]),
      currentSourceTeamAbbreviation: 'FLA',
      currentSourceTeamAbbreviationByGameId:
        firstSummary.sourceTeamAbbreviationByGameId,
      existingSourceTeamAbbreviationByGameId:
        firstSummary.sourceTeamAbbreviationByGameId,
      incomingAsset: secondReplacement,
      incomingScheduledGameIds: [201, 301, 302, 303],
      incomingSourceTeamAbbreviation: 'DET',
      transactionId: 'overlap-second',
      boundaryMilliseconds: 2_000,
      requiredGames: 6,
    });
    const secondResult = await cycleScoring.calculateCycleScoring(
      scoringInput(secondReplacement, secondPlan, firstSummary),
    );
    const secondSummary = secondResult.windowScores[windowId];
    assert.equal(secondSummary.scoringAssetKeyByGameId['201'], secondReplacement.assetKey);
    assert.equal(secondSummary.sourceTeamAbbreviationByGameId['201'], 'DET');
  });

  test('canonical impact routing retains every replacement player and source team for live and final updates', async () => {
    const canonicalFeed = await source(
      'functions/src/nhl-canonical-impact-feed.ts',
    );
    const impactBuilder = section(
      canonicalFeed,
      'async function buildLeagueScoringImpact(',
      'async function buildCanaryImpactIndex(',
    );
    const scheduledFeed = canonicalFeed.slice(
      canonicalFeed.indexOf('export const pollCanonicalNhlImpactFeed'),
    );

    assert.match(
      canonicalFeed,
      /requireValidInjuryReplacementWindowPlan/,
    );
    assert.match(
      impactBuilder,
      /pick\.injuryReplacementWindow/,
    );
    assert.match(impactBuilder, /injuryReplacementWindow\?\.segments/);
    assert.match(impactBuilder, /segment\.asset\.player\.id/);
    assert.match(impactBuilder, /segment\.sourceTeamAbbreviation/);
    assert.match(
      impactBuilder,
      /Object\.values\(segment\.sourceTeamAbbreviationByGameId \?\? \{\}\)/,
    );
    assert.match(
      impactBuilder,
      /league-impact-player-limit-exceeded/,
    );
    assert.match(
      impactBuilder,
      /league-impact-team-limit-exceeded/,
    );
    assert.doesNotMatch(impactBuilder, /\.slice\(0, IMPACT_INDEX_MAX_/);
    assert.match(
      scheduledFeed,
      /impactIndex\.impacts\.flatMap\(\(impact\) => impact\.playerIds\)/,
    );
    assert.match(
      scheduledFeed,
      /finalSettlementPlayerIds,/,
    );
  });

  test('cycle-window and automation copy paths reject malformed or conflicting ownership instead of dropping it', async () => {
    const [serverWindows, browserWindows, automation] = await Promise.all([
      source('functions/src/shared/core/cycle/asset-cycle-window.service.ts'),
      source('src/app/core/cycle/asset-cycle-window.service.ts'),
      source('functions/src/league-automation.ts'),
    ]);

    for (const windowService of [serverWindows, browserWindows]) {
      assert.match(windowService, /requireValidInjuryReplacementWindowPlan\(/);
      assert.match(windowService, /resolveConsistentInjuryReplacementWindowPlan\(/);
      assert.match(windowService, /hasConsistentInjuryReplacementWindowEvidence\(/);
      assert.match(
        windowService,
        /hasPreservedInjuryReplacementProtectedGameOwnership\(/,
      );
      assert.doesNotMatch(
        windowService,
        /summary\?\.injuryReplacementWindow\s*\?\?[\s\S]{0,120}normalizeInjuryReplacementWindowPlan/,
      );
    }

    assert.match(automation, /requireValidInjuryReplacementWindowPlan\(/);
    assert.doesNotMatch(automation, /normalizeInjuryReplacementWindowPlan\(/);
  });
});

describe('injury-replacement rollover contracts', () => {
  test('both regular-season rollover paths advance only the current replacement segment', async () => {
    const cycleService = await source(
      'functions/src/shared/core/cycle/cycle.service.ts',
    );
    const completedSeedRollover = section(
      cycleService,
      'async function loadCompletedContinuitySeeds',
      'export async function startNextCycle',
    );
    const asynchronousRollover = section(
      cycleService,
      'async function buildNextWindowSnapshotPicks',
      'export interface AdvanceCompletedWindowOptions',
    );

    assert.match(
      completedSeedRollover,
      /const currentInjurySegment = injuryReplacementWindow\?\.segments\.at\(-1\)/,
    );
    assert.match(
      completedSeedRollover,
      /completedScheduledGameIds:\s*currentInjurySegment\?\.scheduledGameIds\s*\?\?\s*window\.scheduledGameIds/,
    );
    assert.match(
      completedSeedRollover,
      /completedScheduleTeamAbbreviation:\s*currentInjurySegment\?\.sourceTeamAbbreviation\s*\?\?\s*window\.scheduleTeamAbbreviation/,
    );

    assert.match(
      asynchronousRollover,
      /const previousCurrentInjurySegment\s*=\s*previousInjuryReplacementWindow\?\.segments\.at\(-1\)/,
    );
    assert.match(
      asynchronousRollover,
      /completedScheduledGameIds:\s*previousCurrentInjurySegment\?\.scheduledGameIds\s*\?\?\s*previousSummary\.scheduledGameIds/,
    );
    assert.match(
      asynchronousRollover,
      /completedScheduleTeamAbbreviation:\s*previousCurrentInjurySegment\?\.sourceTeamAbbreviation\s*\?\?\s*previousSummary\.scheduleTeamAbbreviation/,
    );
  });

  test('playoff rollover advances only the current replacement segment', async () => {
    const playoffService = await source(
      'functions/src/shared/core/playoffs/playoff-window-bank.service.ts',
    );
    const rollover = playoffService.slice(
      playoffService.indexOf('async function createNextPlayoffBankWindow'),
    );

    assert.notEqual(
      rollover.length,
      playoffService.length,
      'Missing playoff rollover source section.',
    );
    assert.match(
      rollover,
      /const currentInjurySegment\s*=\s*previousInjuryReplacementWindow\?\.segments\.at\(-1\)/,
    );
    assert.match(
      rollover,
      /completedScheduledGameIds:\s*currentInjurySegment\?\.scheduledGameIds\s*\?\?\s*previousWindow\.scheduledGameIds/,
    );
    assert.match(
      rollover,
      /completedScheduleTeamAbbreviation:\s*currentInjurySegment\?\.sourceTeamAbbreviation\s*\?\?\s*previousWindow\.scheduleTeamAbbreviation/,
    );
  });

  test('playoff banks preserve, fingerprint, and reconstruct exact mixed-player ownership', async () => {
    const playoffService = await source(
      'functions/src/shared/core/playoffs/playoff-window-bank.service.ts',
    );
    const normalization = section(
      playoffService,
      'function normalizeSlotWindow(',
      'function normalizeSlotWindows(',
    );
    const fingerprint = section(
      playoffService,
      'function bankFingerprint(',
      'function bankPickAuthorityFingerprint(',
    );
    const previousResult = section(
      playoffService,
      'function buildPreviousScoringResultFromBanks(',
      'export async function syncPlayoffWindowBankScores(',
    );

    assert.match(normalization, /requireValidInjuryReplacementWindowPlan\(/);
    assert.match(normalization, /getInjuryReplacementAssetKeyByGameId\(/);
    assert.match(normalization, /hasConsistentInjuryReplacementWindowEvidence\(/);
    assert.match(normalization, /conflicting[\s\S]*game ownership/i);
    assert.match(normalization, /injuryReplacementWindow/);
    assert.match(normalization, /scoringAssetKeyByGameId/);
    assert.match(fingerprint, /injuryReplacementWindow:\s*window\.injuryReplacementWindow/);
    assert.match(fingerprint, /scoringAssetKeyByGameId:\s*window\.scoringAssetKeyByGameId/);
    assert.match(previousResult, /injuryReplacementWindow:\s*window\.injuryReplacementWindow/);
    assert.match(previousResult, /getInjuryReplacementAssetKeyByGameId\(/);
    assert.match(
      playoffService,
      /hasPreservedInjuryReplacementProtectedGameOwnership\(/,
    );
  });
});

describe('injury-replacement presentation integration contracts', () => {
  test('desktop, mobile, and My Team expose the split score and an accessible swap boundary on game dots', async () => {
    const [
      desktop,
      mobile,
      mobileComponent,
      cyclePresenter,
      myTeam,
      myTeamPresenter,
      sharedBreakdown,
    ] = await Promise.all([
      source(
        'src/app/features/cycles/cycle-one/components/cycle-matchup-team-panel/cycle-matchup-team-panel.html',
      ),
      source(
        'src/app/features/cycles/cycle-one/components/cycle-mobile-head-to-head/cycle-mobile-head-to-head.html',
      ),
      source(
        'src/app/features/cycles/cycle-one/components/cycle-mobile-head-to-head/cycle-mobile-head-to-head.ts',
      ),
      source('src/app/features/cycles/cycle-one/cycle-one.ts'),
      source('src/app/features/team/team-settings/team-settings.html'),
      source('src/app/features/team/team-settings/team-settings.ts'),
      source(
        'src/app/shared/injury-replacement-score-breakdown/injury-replacement-score-breakdown.html',
      ),
    ]);

    assert.match(cyclePresenter, /buildInjuryReplacementPresentation/);
    assert.match(cyclePresenter, /resolveCycleSlotScoreSummary/);
    assert.match(cyclePresenter, /replacementBoundary:\s*ownership\?\.segmentStart/);
    assert.match(cyclePresenter, /ariaLabel:\s*`\$\{ownershipLabel\}/);

    assert.match(desktop, /app-injury-replacement-score-breakdown/);
    assert.match(desktop, /Slot total/);
    assert.match(desktop, /getPickCurrentCycleScore/);
    assert.match(desktop, /marker-replacement-boundary/);
    assert.match(desktop, /\[attr\.aria-label\]="marker\.ariaLabel"/);
    assert.match(mobile, /app-injury-replacement-score-breakdown/);
    assert.match(mobile, /Slot total/);
    assert.match(mobile, /getPickCurrentCycleScore/);
    assert.match(mobile, /\[attr\.aria-label\]="marker\.ariaLabel"/);
    assert.match(mobileComponent, /marker\.replacementBoundary/);

    assert.match(myTeamPresenter, /getRosterSlotInjuryReplacementPresentation/);
    assert.match(myTeamPresenter, /resolveCycleSlotScoreSummary/);
    assert.match(myTeamPresenter, /replacementBoundary:\s*owner\?\.segmentStart/);
    assert.match(myTeam, /app-injury-replacement-score-breakdown/);
    assert.match(myTeam, /getRosterSlotCurrentCycleScore/);
    assert.match(myTeam, /roster-marker-replacement-boundary/);
    assert.match(myTeam, /\[attr\.aria-label\]="marker\.ariaLabel"/);

    assert.match(sharedBreakdown, /role="group"/);
    assert.match(sharedBreakdown, /\[attr\.aria-label\]="breakdown\.accessibleLabel"/);
    assert.match(sharedBreakdown, /Slot total/);
    assert.match(sharedBreakdown, /segment\.assetName/);
    assert.match(sharedBreakdown, /segment\.points\.toFixed\(1\)/);
    assert.match(sharedBreakdown, /segment\.gameRangeLabel/);
  });

  test('Game Film resolves each owned game against its segment player instead of the current replacement', async () => {
    const detail = await source(
      'src/app/features/cycles/cycle-asset-detail/cycle-asset-detail.ts',
    );
    const skaterRows = section(
      detail,
      'private async loadSnapshotSkaterGameRows(',
      'private async loadSnapshotGoalieUnitGameRows(',
    );

    assert.match(skaterRows, /buildInjuryReplacementPresentation\(summary\)/);
    assert.match(skaterRows, /replacement\?\.segments\.map/);
    assert.match(skaterRows, /replacement\?\.gameOwnership/);
    assert.match(skaterRows, /segment\.asset/);
    assert.match(skaterRows, /scoringAsset/);
    assert.match(skaterRows, /snapshotGame\.gameId/);
    assert.match(
      skaterRows,
      /getRegularSeasonGameLog\([\s\S]*\.player\.id,\s*season,?\s*\)/,
    );
    assert.match(
      skaterRows,
      /findSkaterBoxscoreLine\(gameData\.boxscore,\s*[\s\S]*\.player\.id\)/,
    );
  });

  test('the injury-replacement confirmation explains retained, replacement, and excluded bench points', async () => {
    const myTeamPresenter = await source(
      'src/app/features/team/team-settings/team-settings.ts',
    );
    const timingMessage = section(
      myTeamPresenter,
      'readonly benchSwapTimingMessage = computed',
      'readonly rosterManagerAsset = computed',
    );

    assert.match(timingMessage, /keeps every game and point already started/i);
    assert.match(timingMessage, /remaining future games/i);
    assert.match(timingMessage, /earlier bench points never transfer/i);
  });
});
