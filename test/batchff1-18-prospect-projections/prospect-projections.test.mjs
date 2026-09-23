import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  buildProspectProjectionPriorMap,
  calculateExpectedProspectWindowContribution,
  getProspectAppearanceProbability,
  normalizeProspectEvidenceSnapshot,
  PROSPECT_PROJECTION_MODEL_VERSION,
} from '../../src/app/core/projection/prospect-projection.util.ts';
import {
  buildProjectionV11SkaterRates,
} from '../../src/app/core/projection/projection-v11.util.ts';
const require = createRequire(import.meta.url);
const { rankSharedProjectionAssets } = require(
  '../../functions/lib/shared/core/projection/projection-ranking.util.js',
);

function evidenceSnapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    prospectModelVersion: 1,
    mode: 'enabled',
    snapshotId: 'synthetic-prospect-fixture-v1',
    evidenceAsOf: '2026-09-20',
    retrievedAt: '2026-09-20T18:00:00.000Z',
    source: 'fictional unit-test fixture',
    translationProfiles: [
      {
        league: 'FICTIONAL-AHL',
        scoringFactor: 0.45,
        shotFactor: 0.65,
        physicalFactor: 0.8,
        timeOnIceFactor: 1,
        source: 'fictional held-out calibration fixture',
        asOf: '2026-09-01',
        provisional: true,
      },
    ],
    records: [
      {
        playerId: 9_000_001,
        fullName: 'Fictional Rookie',
        position: 'C',
        nhlOrganization: 'SEA',
        identityVerified: true,
        rosterStatus: 'nhl-call-up',
        birthDate: '2005-01-02',
        draftYear: 2024,
        draftSelection: 12,
        defaultAppearanceProbability: 0.7,
        defaultExpectedTimeOnIceMinutes: 15,
        evidenceAsOf: '2026-09-20',
        retrievedAt: '2026-09-20T18:00:00.000Z',
        source: 'fictional provider record',
        reviewAfter: '2026-10-01',
        qualityFlags: ['missing-peripherals'],
        seasons: [
          {
            league: 'FICTIONAL-AHL',
            season: '2025-26',
            competition: 'regular-season',
            gamesPlayed: 50,
            goals: 20,
            assists: 32,
            shotsOnGoal: 100,
            powerPlayPoints: 14,
            observedAt: '2026-04-20',
            source: 'fictional season totals',
          },
          {
            league: 'FICTIONAL-AHL',
            season: '2025-26',
            competition: 'playoffs',
            gamesPlayed: 10,
            goals: 20,
            assists: 20,
            shotsOnGoal: 80,
            observedAt: '2026-05-20',
            source: 'fictional playoff totals',
          },
        ],
        opportunity: [
          {
            effectiveFrom: '2026-10-01',
            effectiveThrough: '2026-10-31',
            source: 'fictional reviewed depth chart',
            observedAt: '2026-09-20',
            provisional: true,
            scenarios: [
              {
                label: 'significant-role',
                probability: 1,
                appearanceProbability: 0.95,
                expectedTimeOnIceMinutes: 17,
              },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

function currentSeason(gamesPlayed, shotsPerGame) {
  return {
    gamesPlayed,
    goals: 0.35 * gamesPlayed,
    assists: 0.45 * gamesPlayed,
    shotsOnGoal: shotsPerGame * gamesPlayed,
    hits: 1.1 * gamesPlayed,
    blockedShots: 0.5 * gamesPlayed,
    plusMinus: 0,
    powerPlayPoints: 0.2 * gamesPlayed,
    shortHandedPoints: 0,
    gameWinningGoals: 0.03 * gamesPlayed,
    overtimeGoals: 0,
    averageTimeOnIceMinutes: 18,
  };
}

test('useful pre-NHL evidence creates a finite prior without treating missing categories as zero', () => {
  const snapshot = normalizeProspectEvidenceSnapshot(evidenceSnapshot());
  const prior = buildProspectProjectionPriorMap(snapshot).get(9_000_001);

  assert.equal(PROSPECT_PROJECTION_MODEL_VERSION, 1);
  assert.ok(prior);
  assert.ok(Number.isFinite(prior.expectedStatsPer82.goals));
  assert.ok(Number.isFinite(prior.expectedStatsPer82.assists));
  assert.equal(prior.expectedStatsPer82.hits, undefined);
  assert.equal(prior.expectedStatsPer82.blockedShots, undefined);
  assert.ok(prior.missingCategories.includes('hits'));
  assert.ok(prior.missingCategories.includes('blockedShots'));
  assert.equal(prior.expectedStatsPer82.averageTimeOnIceMinutes, 17);

  const projection = buildProjectionV11SkaterRates({
    position: 'C',
    prospectPriorStatsPer82: prior.expectedStatsPer82,
    prospectPriorConfidence: prior.evidenceConfidence,
  });

  for (const value of Object.values(projection.expectedStatsPer82)) {
    assert.ok(Number.isFinite(value));
  }

  // Missing physical data comes from the documented C position prior, not 0.
  assert.ok(projection.expectedStatsPer82.hits > 0);
  assert.ok(projection.expectedStatsPer82.blockedShots > 0);
  assert.ok(projection.prospectPriorWeight > 0);
});

test('talent and opportunity are applied exactly once for the six assigned games', () => {
  assert.equal(
    calculateExpectedProspectWindowContribution({
      conditionalPointsPerAppearance: 10,
      appearanceProbabilities: Array(6).fill(0.95),
    }),
    57,
  );
  assert.equal(
    calculateExpectedProspectWindowContribution({
      conditionalPointsPerAppearance: 10,
      appearanceProbabilities: Array(6).fill(0.5),
    }),
    30,
  );
  assert.equal(
    calculateExpectedProspectWindowContribution({
      conditionalPointsPerAppearance: 7,
      appearanceProbabilities: Array(6).fill(1),
    }),
    42,
  );
});

test('opportunity uses exact assigned game dates and never pulls a seventh game forward', () => {
  const snapshot = normalizeProspectEvidenceSnapshot(evidenceSnapshot());
  const prior = buildProspectProjectionPriorMap(snapshot).get(9_000_001);
  assert.ok(prior);

  const assignedDates = [
    '2026-10-01',
    '2026-10-03',
    '2026-10-05',
    '2026-10-07',
    '2026-10-09',
    '2026-10-11',
  ];
  const seventhScheduledTeamGame = '2026-11-02';
  const assignedProbabilities = assignedDates.map((date) =>
    getProspectAppearanceProbability(prior, date)
  );

  assert.deepEqual(assignedProbabilities, Array(6).fill(0.95));
  assert.equal(getProspectAppearanceProbability(prior, seventhScheduledTeamGame), 0.7);
  assert.equal(
    calculateExpectedProspectWindowContribution({
      conditionalPointsPerAppearance: 10,
      appearanceProbabilities: assignedProbabilities,
    }),
    57,
  );
});

test('NHL evidence replaces the prospect prior gradually at stat-specific rates', () => {
  const snapshot = normalizeProspectEvidenceSnapshot(evidenceSnapshot());
  const prior = buildProspectProjectionPriorMap(snapshot).get(9_000_001);
  assert.ok(prior);

  const fiveGames = buildProjectionV11SkaterRates({
    position: 'C',
    currentStats: currentSeason(5, 5),
    prospectPriorStatsPer82: prior.expectedStatsPer82,
    prospectPriorConfidence: prior.evidenceConfidence,
  });
  const fiftyGames = buildProjectionV11SkaterRates({
    position: 'C',
    currentStats: currentSeason(50, 5),
    prospectPriorStatsPer82: prior.expectedStatsPer82,
    prospectPriorConfidence: prior.evidenceConfidence,
  });

  assert.ok(fiveGames.prospectPriorWeight > fiftyGames.prospectPriorWeight);
  assert.ok(fiveGames.nhlEvidenceWeight < fiftyGames.nhlEvidenceWeight);
  assert.ok(
    fiftyGames.expectedStatsPer82.shotsOnGoal >
      fiveGames.expectedStatsPer82.shotsOnGoal,
  );
});

test('a small NHL hot streak cannot overwhelm the prospect prior', () => {
  const snapshot = normalizeProspectEvidenceSnapshot(evidenceSnapshot());
  const prior = buildProspectProjectionPriorMap(snapshot).get(9_000_001);
  assert.ok(prior);

  const result = buildProjectionV11SkaterRates({
    position: 'C',
    currentStats: currentSeason(4, 7),
    prospectPriorStatsPer82: prior.expectedStatsPer82,
    prospectPriorConfidence: prior.evidenceConfidence,
  });

  assert.ok(result.expectedStatsPer82.shotsOnGoal / 82 < 5);
  assert.ok(result.expectedStatsPer82.shotsOnGoal / 82 > 1);
});

test('missing prospect goals do not become an observed zero shooting percentage', () => {
  const result = buildProjectionV11SkaterRates({
    position: 'RW',
    prospectPriorStatsPer82: {
      gamesPlayed: 82,
      shotsOnGoal: 180,
      assists: 35,
    },
    prospectPriorConfidence: 60,
  });

  assert.ok(result.shootingPercentage > 0.08);
  assert.ok(result.expectedStatsPer82.goals > 0);
});

test('disabled evidence is a safe rollback and stale payload cannot alter V11', () => {
  const disabled = normalizeProspectEvidenceSnapshot({
    ...evidenceSnapshot(),
    mode: 'disabled',
    translationProfiles: [{ malformed: true }],
    records: [{ malformed: true }],
  });
  assert.equal(buildProspectProjectionPriorMap(disabled).size, 0);

  const baseline = buildProjectionV11SkaterRates({
    position: 'D',
    currentStats: currentSeason(18, 2.5),
  });
  const explicitlyUndefined = buildProjectionV11SkaterRates({
    position: 'D',
    currentStats: currentSeason(18, 2.5),
    prospectPriorStatsPer82: undefined,
    prospectPriorConfidence: undefined,
  });

  assert.deepEqual(explicitlyUndefined, baseline);
  assert.equal(baseline.prospectPriorWeight, 0);
  assert.equal(baseline.nhlEvidenceWeight, 1);
});

test('malformed imports and invalid identity/probability inputs fail closed', () => {
  const duplicate = evidenceSnapshot();
  duplicate.records = [duplicate.records[0], duplicate.records[0]];
  assert.throws(
    () => normalizeProspectEvidenceSnapshot(duplicate),
    /duplicate playerId/i,
  );

  const invalidProbability = evidenceSnapshot();
  invalidProbability.records[0].opportunity[0].scenarios[0].appearanceProbability = 1.2;
  assert.throws(
    () => normalizeProspectEvidenceSnapshot(invalidProbability),
    /appearanceProbability/i,
  );

  const negativeStat = evidenceSnapshot();
  negativeStat.records[0].seasons[0].goals = -1;
  assert.throws(
    () => normalizeProspectEvidenceSnapshot(negativeStat),
    /goals/i,
  );

  const unverified = evidenceSnapshot();
  unverified.records[0].identityVerified = false;
  assert.throws(
    () => normalizeProspectEvidenceSnapshot(unverified),
    /identityVerified/i,
  );

  assert.throws(
    () => calculateExpectedProspectWindowContribution({
      conditionalPointsPerAppearance: 10,
      appearanceProbabilities: [0.5, Number.NaN],
    }),
    /probability/i,
  );
});

test('identical evidence is deterministic and feeds the existing league ranking', () => {
  const first = normalizeProspectEvidenceSnapshot(evidenceSnapshot());
  const second = normalizeProspectEvidenceSnapshot(evidenceSnapshot());
  assert.deepEqual(first, second);

  const ranked = rankSharedProjectionAssets([
    {
      assetType: 'skater',
      assetKey: 'skater-9000001',
      position: 'C',
      player: {
        id: 9_000_001,
        fullName: 'Fictional Rookie',
        position: 'C',
        nhlTeamAbbreviation: 'SEA',
      },
      draftFloorAdjustedCyclePoints: 49,
      projectedCyclePoints: 52,
      floorAdjustedCyclePoints: 45,
      prospectProjectionModelVersion: 1,
    },
    {
      assetType: 'skater',
      assetKey: 'skater-9000002',
      position: 'C',
      player: {
        id: 9_000_002,
        fullName: 'Fictional Veteran',
        position: 'C',
        nhlTeamAbbreviation: 'SEA',
      },
      draftFloorAdjustedCyclePoints: 45,
      projectedCyclePoints: 48,
      floorAdjustedCyclePoints: 43,
    },
    {
      assetType: 'team-goalie-unit',
      assetKey: 'goalie-unit-SEA',
      position: 'G',
      teamName: 'Seattle Kraken',
      teamAbbreviation: 'SEA',
      draftFloorAdjustedCyclePoints: 70,
      projectedCyclePoints: 72,
      floorAdjustedCyclePoints: 68,
    },
  ], 4);

  const rookie = ranked.find((asset) => asset.assetKey === 'skater-9000001');
  const goalie = ranked.find((asset) => asset.assetType === 'team-goalie-unit');
  assert.ok(typeof rookie?.draftRank === 'number');
  assert.equal(rookie?.prospectProjectionModelVersion, 1);
  assert.equal(goalie?.assetType, 'team-goalie-unit');
  assert.ok(typeof goalie?.draftRank === 'number');
});

test('server authority, immutable snapshots, and browser/server model parity are preserved', async () => {
  const [browserUtility, serverUtility, serverPool, snapshotSource, rules] = await Promise.all([
    readFile(
      new URL('../../src/app/core/projection/prospect-projection.util.ts', import.meta.url),
    ),
    readFile(
      new URL(
        '../../functions/src/shared/core/projection/prospect-projection.util.ts',
        import.meta.url,
      ),
    ),
    readFile(
      new URL(
        '../../functions/src/shared/core/draft/draft-player-pool.service.ts',
        import.meta.url,
      ),
      'utf8',
    ),
    readFile(
      new URL(
        '../../functions/src/shared/core/projection/projection-snapshot.service.ts',
        import.meta.url,
      ),
      'utf8',
    ),
    readFile(new URL('../../firestore.rules', import.meta.url), 'utf8'),
  ]);

  assert.deepEqual(browserUtility, serverUtility);
  assert.match(serverPool, /prospectPriorByPlayerId/);
  assert.match(serverPool, /getTargetCycleGames\(/);
  assert.match(serverPool, /medicalProbability \* opportunityProbability/);
  assert.match(snapshotSource, /appData', 'prospectProjectionEvidence/);
  assert.match(snapshotSource, /snapshotId = `server-v\$\{SHARED_PROJECTION_VERSION\}-\$\{Date\.now\(\)\}/);
  assert.doesNotMatch(rules, /match \/appData\/prospectProjectionEvidence[^]*allow write/);
  assert.match(rules, /match \/\{document=\*\*\} \{\s*allow read, write: if false;/);
});

test('offline evaluation clearly separates fixtures from a held-out release gate', () => {
  const defaultAttempt = spawnSync(
    process.execPath,
    [
      'scripts/projection/evaluate-prospect-projections.mjs',
      'test/batchff1-18-prospect-projections/historical-evaluation.fixture.json',
    ],
    {
      cwd: new URL('../..', import.meta.url),
      encoding: 'utf8',
    },
  );

  assert.notEqual(defaultAttempt.status, 0);
  assert.match(
    defaultAttempt.stderr,
    /Synthetic fixtures are test-only\. Pass --allow-small-synthetic-fixture explicitly\./,
  );

  const underpoweredHeldOutAttempt = spawnSync(
    process.execPath,
    [
      'scripts/projection/evaluate-prospect-projections.mjs',
      'test/batchff1-18-prospect-projections/historical-underpowered-held-out.fixture.json',
    ],
    {
      cwd: new URL('../..', import.meta.url),
      encoding: 'utf8',
    },
  );

  assert.notEqual(underpoweredHeldOutAttempt.status, 0);
  assert.match(
    underpoweredHeldOutAttempt.stderr,
    /Held-out evaluation requires at least 100 observations\./,
  );

  const output = execFileSync(
    process.execPath,
    [
      'scripts/projection/evaluate-prospect-projections.mjs',
      'test/batchff1-18-prospect-projections/historical-evaluation.fixture.json',
      '--allow-small-synthetic-fixture',
    ],
    {
      cwd: new URL('../..', import.meta.url),
      encoding: 'utf8',
    },
  );
  const result = JSON.parse(output);

  assert.equal(result.observationCount, 2);
  assert.equal(result.nhlEntrantCount, 1);
  assert.equal(result.nonEntrantCount, 1);
  assert.equal(result.evaluationStatus, 'fixture-only');
  assert.equal(result.candidateImprovedOnBaseline, true);
  assert.equal(result.releaseGateEligible, false);
  assert.equal(result.calibrationGatePassed, false);
  assert.equal('accuracyClaimSupported' in result, false);
  assert.ok(result.prospectWindowMae < result.baselineWindowMae);

  const leakageAttempt = spawnSync(
    process.execPath,
    [
      'scripts/projection/evaluate-prospect-projections.mjs',
      'test/batchff1-18-prospect-projections/historical-leakage.fixture.json',
      '--allow-small-synthetic-fixture',
    ],
    {
      cwd: new URL('../..', import.meta.url),
      encoding: 'utf8',
    },
  );

  assert.notEqual(leakageAttempt.status, 0);
  assert.match(leakageAttempt.stderr, /leaks evidence observed after the forecast date/);
});
