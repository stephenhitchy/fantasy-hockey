import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';

const ROOT = new URL('../../', import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const read = (relativePath) => readFile(new URL(relativePath, ROOT), 'utf8');
const sha256 = async (relativePath) => createHash('sha256')
  .update(await readFile(new URL(relativePath, ROOT)))
  .digest('hex');
const require = createRequire(import.meta.url);
const reconciliation = require(
  `${ROOT_PATH}functions/lib/shared/core/nhl/final-score-reconciliation.util.js`,
);
const scoringRules = require(
  `${ROOT_PATH}functions/lib/shared/core/scoring/scoring-rules.js`,
);

const STORED_SOURCE_VERSION = 'a'.repeat(64);
const CANONICAL_SOURCE_VERSION = 'b'.repeat(64);

const skaterAsset = {
  assetType: 'skater',
  assetKey: 'skater-7',
  position: 'C',
  player: {
    id: 7,
    fullName: 'Audit Skater',
    position: 'C',
    nhlTeamAbbreviation: 'SEA',
  },
};

function completeEvidence(sourceVersion, assetType = 'skater') {
  return {
    status: 'complete',
    complete: true,
    reusableFinal: true,
    requiredSources: assetType === 'skater'
      ? ['boxscore', 'play-by-play', 'player-log', 'source-version']
      : ['boxscore', 'source-version'],
    sourceVersion,
    preservedPreviousScore: false,
    failures: [],
  };
}

function canonicalFacts(overrides = {}) {
  return {
    schemaVersion: 2,
    gameId: 1,
    gameState: 'final',
    sourceGameState: 'OFF',
    sourceGameScheduleState: 'OK',
    gameDate: '2026-10-01',
    startTimeUTC: '2026-10-02T02:00:00Z',
    period: 3,
    periodType: 'REG',
    clockTimeRemaining: '00:00',
    clockRunning: false,
    inIntermission: false,
    homeTeamAbbreviation: 'SEA',
    awayTeamAbbreviation: 'VAN',
    homeScore: 2,
    awayScore: 1,
    skaters: [],
    goalies: [],
    goals: [],
    finalSettlements: [],
    finalSettlementPlayerIds: [],
    playerIds: [],
    teamAbbreviations: ['SEA', 'VAN'],
    ...overrides,
  };
}

function canonicalGame(overrides = {}) {
  return {
    sourceVersion: CANONICAL_SOURCE_VERSION,
    facts: canonicalFacts(),
    finalInputCompletenessByAssetType: {
      skater: completeEvidence(CANONICAL_SOURCE_VERSION),
      teamGoalieUnit: completeEvidence(CANONICAL_SOURCE_VERSION, 'team-goalie-unit'),
    },
    ...overrides,
  };
}

function completedWindow(overrides = {}) {
  return {
    id: 'owner-a__C-1__cycle-1',
    ownerId: 'owner-a',
    rosterSlotId: 'C-1',
    cycleNumber: 1,
    position: 'C',
    assetKey: skaterAsset.assetKey,
    asset: skaterAsset,
    status: 'complete',
    scheduledGameIds: [1],
    scheduledGameDates: ['2026-10-01'],
    scheduledGameLabels: ['vs VAN'],
    completedGameIds: [1],
    liveGameIds: [],
    appearanceGameIds: [],
    gameScores: { '1': 0 },
    gameStates: { '1': 'final' },
    gameInputCompleteness: {
      '1': completeEvidence(STORED_SOURCE_VERSION),
    },
    incompleteFinalGameIds: [],
    scheduledGames: 1,
    gamesPlayed: 1,
    actualGamesPlayed: 0,
    gamesLeft: 0,
    fantasyPoints: 0,
    frozenProjectionPoints: null,
    frozenProjectionVersion: null,
    frozenProjectionSource: null,
    frozenProjectionSnapshotId: null,
    frozenProjectionGeneratedAt: null,
    frozenProjectionFrozenAt: null,
    frozenProjectionTargetGameIds: [1],
    firstScheduledGameDate: '2026-10-01',
    lastScheduledGameDate: '2026-10-01',
    ...overrides,
  };
}

function reconcile(window, games = new Map([[1, canonicalGame()]]), overrides = {}) {
  return reconciliation.reconcileFinalizedWindow({
    window,
    teamKey: 'team-abc123',
    canonicalGamesById: games,
    scoringRules: scoringRules.defaultScoringRules,
    ...overrides,
  });
}

function appearedCanonicalFacts({ goals = 0, timeOnIceSeconds = 0 } = {}) {
  return canonicalFacts({
    skaters: [{
      playerId: 7,
      teamAbbreviation: 'SEA',
      position: 'C',
      goals,
      assists: 0,
      primaryAssists: 0,
      secondaryAssists: 0,
      shotsOnGoal: goals,
      hits: 0,
      blockedShots: 0,
      plusMinus: 0,
      powerPlayGoals: 0,
      timeOnIceSeconds,
    }],
    finalSettlements: [{
      playerId: 7,
      goals,
      assists: 0,
      shotsOnGoal: goals,
      plusMinus: 0,
      powerPlayPoints: 0,
      shortHandedPoints: 0,
      gameWinningGoal: false,
      overtimeGoal: false,
      timeOnIceSeconds,
      source: 'player-game-log',
    }],
    finalSettlementPlayerIds: [7],
    playerIds: [7],
  });
}

test('a legitimate zero and did-not-appear final is a verified match', () => {
  const result = reconcile(completedWindow());

  assert.equal(result.finalizedGameCount, 1);
  assert.equal(result.verifiedGameCount, 1);
  assert.equal(result.candidateGameCount, 0);
  assert.equal(result.unverifiableGameCount, 0);
  assert.equal(result.integrityIssueCount, 0);
  assert.deepEqual(result.findings, []);
});

test('a legitimate Team Goalie Unit zero uses its smaller complete source contract', () => {
  const goalieAsset = {
    assetType: 'team-goalie-unit',
    assetKey: 'goalie-unit-sea',
    position: 'G',
    teamAbbreviation: 'SEA',
    displayName: 'Seattle Team Goalie Unit',
  };
  const window = completedWindow({
    position: 'G',
    assetKey: goalieAsset.assetKey,
    asset: goalieAsset,
    gameInputCompleteness: {
      '1': completeEvidence(STORED_SOURCE_VERSION, 'team-goalie-unit'),
    },
  });
  const result = reconcile(window);

  assert.equal(result.verifiedGameCount, 1);
  assert.equal(result.candidateGameCount, 0);
  assert.equal(result.unverifiableGameCount, 0);
});

test('one unsupported asset produces one unverifiable finalized game', () => {
  const unknownAsset = {
    assetType: 'unknown',
    assetKey: 'unknown-7',
    position: 'C',
  };
  const result = reconcile(completedWindow({
    assetKey: unknownAsset.assetKey,
    asset: unknownAsset,
  }));

  assert.equal(result.finalizedGameCount, 1);
  assert.equal(result.verifiedGameCount, 0);
  assert.equal(result.candidateGameCount, 0);
  assert.equal(result.unverifiableGameCount, 1);
  assert.equal(result.findingCount, 1);
  assert.equal(result.findings[0].status, 'unverifiable');
  assert.equal(result.findings[0].code, 'window-asset-invalid');
});

test('missing or invalid saved final evidence remains explicitly unverifiable', () => {
  const missingScore = reconcile(completedWindow({ gameScores: {} }));
  const missing = reconcile(completedWindow({ gameInputCompleteness: {} }));
  const invalid = reconcile(completedWindow({
    gameInputCompleteness: {
      '1': {
        ...completeEvidence(STORED_SOURCE_VERSION),
        complete: false,
        reusableFinal: false,
        status: 'incomplete-boxscore',
        failures: [{
          code: 'incomplete-boxscore',
          source: 'boxscore',
          detail: 'temporary failure',
          retryable: true,
        }],
      },
    },
  }));

  assert.equal(missingScore.unverifiableGameCount, 1);
  assert.equal(missingScore.candidateGameCount, 0);
  assert.equal(missingScore.findings[0].status, 'unverifiable');
  assert.equal(missingScore.findings[0].code, 'stored-final-score-missing');
  assert.equal(missing.unverifiableGameCount, 1);
  assert.equal(missing.findings[0].code, 'stored-final-evidence-missing');
  assert.equal(invalid.unverifiableGameCount, 1);
  assert.equal(invalid.findings[0].code, 'stored-final-evidence-incomplete');
  assert.equal(missing.candidateGameCount, 0);
  assert.equal(invalid.candidateGameCount, 0);
});

test('missing, capped, or incomplete canonical evidence never becomes zero', () => {
  const missing = reconcile(completedWindow(), new Map());
  const capped = reconcile(completedWindow(), new Map(), {
    canonicalGameReadLimitIds: new Set([1]),
  });
  const incomplete = reconcile(completedWindow(), new Map([[1, canonicalGame({
    finalInputCompletenessByAssetType: {
      skater: {
        ...completeEvidence(CANONICAL_SOURCE_VERSION),
        status: 'temporarily-unavailable',
        complete: false,
        reusableFinal: false,
        failures: [{
          code: 'temporarily-unavailable',
          source: 'player-log',
          detail: 'player log unavailable',
          retryable: true,
        }],
      },
    },
  })]]));

  assert.equal(missing.findings[0].code, 'canonical-game-missing');
  assert.equal(capped.findings[0].code, 'canonical-game-read-limit-reached');
  assert.equal(incomplete.findings[0].code, 'canonical-final-evidence-incomplete');
  assert.equal(missing.unverifiableGameCount, 1);
  assert.equal(capped.unverifiableGameCount, 1);
  assert.equal(incomplete.unverifiableGameCount, 1);
});

test('point, appearance, and combined differences are review candidates only', () => {
  const pointFacts = appearedCanonicalFacts({ goals: 1, timeOnIceSeconds: 600 });
  const pointOnly = reconcile(completedWindow({
    appearanceGameIds: [1],
    actualGamesPlayed: 1,
  }), new Map([[1, canonicalGame({ facts: pointFacts })]]));
  const appearanceOnly = reconcile(completedWindow(), new Map([[1, canonicalGame({
    facts: appearedCanonicalFacts(),
  })]]));
  const combined = reconcile(completedWindow(), new Map([[1, canonicalGame({
    facts: pointFacts,
  })]]));

  assert.equal(pointOnly.findings[0].code, 'score-mismatch');
  assert.ok(pointOnly.findings[0].pointDelta > 0);
  assert.equal(appearanceOnly.findings[0].code, 'appearance-mismatch');
  assert.equal(appearanceOnly.findings[0].pointDelta, 0);
  assert.equal(combined.findings[0].code, 'score-and-appearance-mismatch');
  assert.equal(pointOnly.candidateGameCount, 1);
  assert.equal(appearanceOnly.candidateGameCount, 1);
  assert.equal(combined.candidateGameCount, 1);
});

test('missing canonical skater final settlement is unverifiable even with a boxscore line', () => {
  const facts = appearedCanonicalFacts({ goals: 1, timeOnIceSeconds: 600 });
  facts.finalSettlements = [];
  facts.finalSettlementPlayerIds = [];
  const result = reconcile(completedWindow({
    appearanceGameIds: [1],
    actualGamesPlayed: 1,
  }), new Map([[1, canonicalGame({ facts })]]));

  assert.equal(result.unverifiableGameCount, 1);
  assert.equal(result.candidateGameCount, 0);
  assert.equal(result.findings[0].code, 'canonical-final-evidence-incomplete');
  assert.equal(result.findings[0].reason, 'final-settlement-missing');
});

test('non-final or non-finite canonical output remains unverifiable', () => {
  const nonFinal = reconcile(completedWindow(), new Map([[1, canonicalGame({
    facts: canonicalFacts({ gameState: 'live' }),
  })]]));
  const invalidFinalSettlement = appearedCanonicalFacts({ goals: 1 });
  invalidFinalSettlement.skaters[0].goals = Number.NaN;
  invalidFinalSettlement.finalSettlements[0].goals = Number.NaN;
  const nonFinite = reconcile(completedWindow({
    appearanceGameIds: [1],
    actualGamesPlayed: 1,
  }), new Map([[1, canonicalGame({ facts: invalidFinalSettlement })]]));

  assert.equal(nonFinal.unverifiableGameCount, 1);
  assert.equal(nonFinal.candidateGameCount, 0);
  assert.equal(nonFinal.findings[0].code, 'canonical-final-evidence-incomplete');
  assert.match(nonFinal.findings[0].reason, /not in a final state/);
  assert.equal(nonFinite.unverifiableGameCount, 1);
  assert.equal(nonFinite.candidateGameCount, 0);
  assert.equal(nonFinite.findings[0].canonicalPoints, null);
  assert.match(nonFinite.findings[0].reason, /structurally incomplete/);
});

test('window storage invariants report integrity candidates without double-counting games', () => {
  const result = reconcile(completedWindow({
    scheduledGameIds: [1, 1],
    completedGameIds: [1, 1, 2],
    incompleteFinalGameIds: [1, 3, 3],
    appearanceGameIds: [1, 5, 5],
    liveGameIds: [4],
    gameStates: { '1': 'live', '2': 'final' },
    gameScores: { '1': 0, '2': 1, '999': 7 },
    scheduledGames: 7,
    gamesPlayed: 5,
    actualGamesPlayed: 9,
    gamesLeft: 4,
    fantasyPoints: 9,
  }), new Map([[1, canonicalGame()]]));
  const codes = new Set(result.findings.map((finding) => finding.code));

  for (const code of [
    'duplicate-scheduled-game-id',
    'duplicate-completed-game-id',
    'duplicate-incomplete-game-id',
    'duplicate-appearance-game-id',
    'completed-game-not-scheduled',
    'incomplete-game-not-scheduled',
    'appearance-game-not-scheduled',
    'game-score-not-scheduled',
    'completed-and-incomplete-game-overlap',
    'completed-game-state-not-final',
    'scheduled-game-count-mismatch',
    'games-played-count-mismatch',
    'actual-games-played-count-mismatch',
    'games-left-count-mismatch',
    'complete-window-has-pending-game',
    'fantasy-points-sum-mismatch',
  ]) {
    assert.ok(codes.has(code), `expected integrity finding ${code}`);
  }

  assert.equal(result.finalizedGameCount, 2);
  assert.ok(result.integrityIssueCount >= 15);
});

test('an unscheduled score cannot hide inside an otherwise matching window total', () => {
  const result = reconcile(completedWindow({
    gameScores: { '1': 0, '999': 5 },
    gameStates: { '1': 'final', '999': 'final' },
    fantasyPoints: 5,
  }));

  assert.equal(result.verifiedGameCount, 1);
  assert.equal(result.candidateGameCount, 0);
  assert.equal(result.unverifiableGameCount, 0);
  assert.equal(result.integrityIssueCount, 1);
  assert.equal(result.findings[0].code, 'game-score-not-scheduled');
  assert.match(result.findings[0].reason, /outside this immutable window assignment/);
});

test('a score for a future scheduled game cannot inflate an otherwise matching window', () => {
  const result = reconcile(completedWindow({
    status: 'active',
    scheduledGameIds: [1, 2],
    completedGameIds: [1],
    gameScores: { '1': 0, '2': 5 },
    gameStates: { '1': 'final', '2': 'scheduled' },
    scheduledGames: 2,
    gamesPlayed: 1,
    gamesLeft: 1,
    fantasyPoints: 5,
  }));

  assert.equal(result.verifiedGameCount, 1);
  assert.equal(result.candidateGameCount, 0);
  assert.equal(result.unverifiableGameCount, 0);
  assert.equal(result.integrityIssueCount, 1);
  assert.equal(result.findings[0].code, 'game-score-state-invalid');
  assert.match(result.findings[0].reason, /no live or final game state/);
});

test('final-game and finding limits stay visible while aggregate counts remain accurate', () => {
  const gameIds = Array.from({ length: 13 }, (_, index) => index + 1);
  const result = reconcile(completedWindow({
    scheduledGameIds: gameIds,
    completedGameIds: gameIds,
    gameStates: Object.fromEntries(gameIds.map((gameId) => [String(gameId), 'final'])),
    gameScores: Object.fromEntries(gameIds.map((gameId) => [String(gameId), 0])),
    gameInputCompleteness: Object.fromEntries(gameIds.map((gameId) => [
      String(gameId),
      completeEvidence(STORED_SOURCE_VERSION),
    ])),
    scheduledGames: 13,
    gamesPlayed: 13,
    gamesLeft: 0,
  }), new Map(), { maxFindings: 0 });

  assert.equal(result.finalizedGameCount, 12);
  assert.ok(result.integrityIssueCount >= 1);
  assert.ok(result.findingCount >= 13);
  assert.equal(result.inspectionLimitReached, true);
  assert.equal(result.findings.length, 0);
  assert.equal(result.findingsTruncated, true);
});

test('missing and malformed team-window structures fail visibly closed', () => {
  const missing = reconciliation.inspectFinalScoreTeamWindowStructure({
    rawWindows: undefined,
    teamKey: 'team-abc123',
  });
  const malformed = reconciliation.inspectFinalScoreTeamWindowStructure({
    rawWindows: [completedWindow(), null, {}, 'invalid'],
    teamKey: 'team-abc123',
  });

  assert.equal(missing.inspectionIncomplete, true);
  assert.equal(missing.allWindowCount, 0);
  assert.deepEqual(missing.safeWindowValues, []);
  assert.equal(missing.finding.code, 'team-window-structure-invalid');
  assert.match(missing.finding.reason, /cannot|hidden/);

  assert.equal(malformed.inspectionIncomplete, true);
  assert.equal(malformed.allWindowCount, 4);
  assert.equal(malformed.safeWindowValues.length, 1);
  assert.equal(malformed.finding.code, 'team-window-structure-invalid');
  assert.match(malformed.finding.reason, /3 saved team-window record/);

  const complete = reconciliation.inspectFinalScoreTeamWindowStructure({
    rawWindows: [completedWindow()],
    teamKey: 'team-abc123',
  });
  assert.equal(complete.inspectionIncomplete, false);
  assert.equal(complete.finding, null);

  for (const invalidWindow of [
    completedWindow({ liveGameIds: undefined }),
    completedWindow({ completedGameIds: [1, '2'] }),
    completedWindow({ gamesPlayed: 0.5 }),
    completedWindow({ ownerId: '' }),
    completedWindow({ cycleNumber: undefined }),
    completedWindow({ asset: { assetType: 'skater', assetKey: 'skater-7', position: 'C' } }),
    completedWindow({ asset: { ...skaterAsset, assetKey: 'skater-8' } }),
  ]) {
    const invalid = reconciliation.inspectFinalScoreTeamWindowStructure({
      rawWindows: [invalidWindow],
      teamKey: 'team-abc123',
    });

    assert.equal(invalid.inspectionIncomplete, true);
    assert.deepEqual(invalid.safeWindowValues, []);
  }
});

test('cycle scope proves expected team-document coverage before a clean result', () => {
  const complete = reconciliation.inspectFinalScoreCycleTeamWindowScope({
    expectedRosterSlotIdsByOwner: {
      'owner-a': ['C-1', 'LW-1'],
      'owner-b': ['G-1'],
    },
    totalExpectedWindowCount: 3,
    windowSchemaVersion: 1,
  });

  assert.deepEqual(complete.expectedTeamDocumentIds, ['owner-a', 'owner-b']);
  assert.deepEqual(complete.expectedRosterSlotIdsByTeam, {
    'owner-a': ['C-1', 'LW-1'],
    'owner-b': ['G-1'],
  });
  assert.equal(complete.inspectionIncomplete, false);

  for (const incomplete of [
    reconciliation.inspectFinalScoreCycleTeamWindowScope({
      expectedRosterSlotIdsByOwner: {},
      totalExpectedWindowCount: 0,
      windowSchemaVersion: 1,
    }),
    reconciliation.inspectFinalScoreCycleTeamWindowScope({
      expectedRosterSlotIdsByOwner: { 'owner-a': [] },
      totalExpectedWindowCount: 0,
      windowSchemaVersion: 1,
    }),
    reconciliation.inspectFinalScoreCycleTeamWindowScope({
      expectedRosterSlotIdsByOwner: undefined,
      totalExpectedWindowCount: 0,
      windowSchemaVersion: 1,
    }),
    reconciliation.inspectFinalScoreCycleTeamWindowScope({
      expectedRosterSlotIdsByOwner: { 'owner/a': ['C-1'] },
      totalExpectedWindowCount: 1,
      windowSchemaVersion: 1,
    }),
    reconciliation.inspectFinalScoreCycleTeamWindowScope({
      expectedRosterSlotIdsByOwner: { 'owner-a': ['C-1', 'C-1'] },
      totalExpectedWindowCount: 2,
      windowSchemaVersion: 1,
    }),
    reconciliation.inspectFinalScoreCycleTeamWindowScope({
      expectedRosterSlotIdsByOwner: { 'owner-a': ['C-1'] },
      totalExpectedWindowCount: 2,
      windowSchemaVersion: 1,
    }),
  ]) {
    assert.equal(incomplete.inspectionIncomplete, true);
    assert.match(incomplete.reason, /cannot|exceeds|malformed|inconsistent/);
  }
});

test('team-window roster scope excludes duplicate, missing, and cross-cycle windows', () => {
  const complete = reconciliation.inspectFinalScoreTeamWindowRosterScope({
    safeWindowValues: [
      completedWindow(),
      completedWindow({
        id: 'owner-a__LW-1__cycle-1',
        rosterSlotId: 'LW-1',
      }),
    ],
    expectedRosterSlotIds: ['C-1', 'LW-1'],
    teamDocumentId: 'owner-a',
    cycleNumber: 1,
  });

  assert.equal(complete.inspectionIncomplete, false);
  assert.equal(complete.safeWindowValues.length, 2);

  const incomplete = reconciliation.inspectFinalScoreTeamWindowRosterScope({
    safeWindowValues: [
      completedWindow(),
      completedWindow({ id: 'duplicate', rosterSlotId: 'C-1' }),
      completedWindow({
        id: 'wrong-cycle',
        rosterSlotId: 'LW-1',
        cycleNumber: 2,
      }),
    ],
    expectedRosterSlotIds: ['C-1', 'LW-1'],
    teamDocumentId: 'owner-a',
    cycleNumber: 1,
  });

  assert.equal(incomplete.inspectionIncomplete, true);
  assert.equal(incomplete.safeWindowValues.length, 1);
  assert.match(incomplete.reason, /1 expected window.*2 duplicate or out-of-scope/);
});

test('the callable is platform-admin-only, paged, bounded, pseudonymized, and read-only', async () => {
  const [automation, indexSource, functionsPackage] = await Promise.all([
    read('functions/src/league-automation.ts'),
    read('functions/src/index.ts'),
    read('functions/package.json'),
  ]);
  const start = automation.indexOf('function emptyFinalScoreReconciliationSummary');
  const end = automation.indexOf('export const getLeagueAutomationQueueControlCenter');
  const implementation = automation.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(implementation, /getFinalScoreReconciliationPage = onCall/);
  assert.match(implementation, /requireLeagueAutomationPlatformAdmin/);
  assert.match(implementation, /FINAL_SCORE_RECONCILIATION_TEAM_PAGE_SIZE \+ 1/);
  assert.match(implementation, /orderBy\(FieldPath\.documentId\(\)\)/);
  assert.match(implementation, /startAfter\(input\.afterTeamId\)/);
  assert.match(implementation, /FINAL_SCORE_RECONCILIATION_MAX_CANONICAL_GAME_READS/);
  assert.match(implementation, /inspectFinalScoreTeamWindowStructure/);
  assert.match(implementation, /inspectFinalScoreTeamWindowRosterScope/);
  assert.match(implementation, /inspectFinalScoreCycleTeamWindowScope/);
  assert.match(implementation, /expectedTeamDocumentIds/);
  assert.match(implementation, /missingTeamDocumentCount/);
  assert.match(implementation, /latestCycle\.id !== `cycle-\$\{cycleNumber\}`/);
  assert.match(implementation, /teamDocumentCoverageChecked/);
  assert.match(implementation, /windowGameLimitReached/);
  assert.match(implementation, /final-score-reconciliation:\$\{input\.leagueId\}:\$\{snapshot\.id\}/);
  assert.match(implementation, /writesPerformed: 0/);
  assert.match(implementation, /maxInstances: 3/);
  assert.doesNotMatch(
    implementation,
    /runTransaction|writeBatch|transaction\.(?:set|update|delete)|batch\.(?:set|update|delete)|\.doc\([^)]*\)\.(?:set|update|delete)\(/,
  );
  assert.match(indexSource, /getFinalScoreReconciliationPage/);
  assert.match(JSON.parse(functionsPackage).scripts.logs, /getFinalScoreReconciliationPage/);
});

test('the admin panel exposes bounded progress, retry, partial evidence, and no listener', async () => {
  const [service, component, template, styles, readiness] = await Promise.all([
    read('src/app/core/admin/final-score-reconciliation.service.ts'),
    read('src/app/features/release/final-score-reconciliation/final-score-reconciliation.ts'),
    read('src/app/features/release/final-score-reconciliation/final-score-reconciliation.html'),
    read('src/app/features/release/final-score-reconciliation/final-score-reconciliation.css'),
    read('src/app/features/release/release-readiness/release-readiness.html'),
  ]);

  assert.match(service, /getFinalScoreReconciliationPage/);
  assert.match(service, /timeout: 65_000/);
  assert.match(component, /MAX_SCAN_PAGES = 8/);
  assert.match(component, /leagueIdInput/);
  assert.match(component, /page\.leagueId !== leagueId/);
  assert.match(component, /requestGeneration/);
  assert.match(component, /run\.teamDocumentCoverageChecked/);
  assert.match(component, /Partial read-only results remain visible/);
  assert.match(component, /run\.teamDocumentCoverageChecked/);
  assert.match(component, /!run\.inspectionIncomplete/);
  assert.match(component, /!run\.findingsTruncated/);
  assert.match(template, /Run Detect-Only Audit/);
  assert.match(template, /Exact league ID/);
  assert.match(template, /Missing D1L\s+source evidence/);
  assert.match(template, /Retry/);
  assert.match(template, /Audit incomplete/);
  assert.match(template, /role="status"/);
  assert.match(template, /role="alert"/);
  assert.match(styles, /@media \(max-width: 520px\)/);
  assert.match(styles, /:focus-visible/);
  assert.doesNotMatch(service + component, /onSnapshot|collectionData|docData/);
  assert.doesNotMatch(styles, /!important|position:\s*fixed/);
  assert.match(readiness, /app-final-score-reconciliation/);
});

test('D1M documents acceptance, observability, exact resources, and no correction boundary', async () => {
  const [packageSource, design, handoff, readme] = await Promise.all([
    read('package.json'),
    read('docs/RINKRAT_DATA_D1M_DETECT_ONLY_FINAL_SCORE_RECONCILIATION.md'),
    read('docs/RINKRAT_CODEX_HANDOFF.md'),
    read('README.md'),
  ]);
  const scripts = JSON.parse(packageSource).scripts;

  assert.match(scripts['test:batchd1m:run'], /batchd1m-final-score-reconciliation/);
  assert.match(scripts['verify:batchd1m:core'], /verify:batchl1a:core/);
  assert.match(design, /## Acceptance criteria/);
  assert.match(design, /## Edge cases/);
  assert.match(design, /## Observability/);
  assert.match(design, /functions:getFinalScoreReconciliationPage/);
  assert.match(design, /hosting:app/);
  assert.match(design, /No Firestore Rules, indexes, TTL policies/);
  assert.match(design, /Architecture recommendations not implemented/);
  assert.match(design, /does not claim they should be equal/);
  assert.match(handoff, /D1M-A detector/);
  assert.match(readme, /RINKRAT_DATA_D1M_DETECT_ONLY_FINAL_SCORE_RECONCILIATION/);
});

test('D1M leaves scoring, Projection V11, Rules, indexes, and competitive formulas unchanged', async () => {
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
    assert.equal(await sha256(relativePath), PROTECTED_SOURCE_HASHES[hashKey]);
  }
});
