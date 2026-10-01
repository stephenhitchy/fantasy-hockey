import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  validateAnchoredSeasonCapacity,
} from '../../functions/lib/shared/core/draft/anchored-season-capacity.util.js';
import {
  selectProjectionTargetGames,
} from '../../functions/lib/shared/core/draft/projection-target-games.util.js';
import {
  buildSeasonWindowSourcePlanFromAnchor,
  validateSeasonWindowSourcePlan,
} from '../../functions/lib/shared/core/draft/season-window-source-plan.util.js';
import {
  buildSourceNhlTargetGameIdsByTeam,
} from '../../functions/lib/shared/core/cycle/cycle-window-selection.util.js';
import {
  projectionGameIdMapsMatch,
  shouldMutateProjectionControl,
  shouldPublishProjectionResult,
  shouldReuseActiveProjectionRequest,
} from '../../functions/lib/shared/core/projection/projection-publication-guard.util.js';

const ROOT = new URL('../../', import.meta.url);

function readIntegerConstant(source, name) {
  const match = source.match(
    new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*([\\d_]+);`),
  );

  assert.ok(match, `Expected ${name} to be declared.`);
  return Number(match[1].replaceAll('_', ''));
}

function teams(gameCount = 82) {
  return Array.from({ length: 32 }, (_, index) => ({
    teamAbbreviation: `T${String(index).padStart(2, '0')}`,
    regularSeasonGameCount: gameCount,
  }));
}

function sourcePlanFixture({
  initialNhlBlockNumber,
  finalPrefixGameCount,
  requiredThroughGameNumber = 78,
}) {
  const anchorTeams = Array.from({ length: 32 }, (_, index) => {
    const teamAbbreviation = `T${String(index).padStart(2, '0')}`;
    const regularSeasonGameIds = Array.from(
      { length: 82 },
      (_, gameIndex) => (index + 1) * 1_000 + gameIndex + 1,
    );
    const openingStart = (initialNhlBlockNumber - 1) * 6;

    return {
      teamAbbreviation,
      regularSeasonGameCount: regularSeasonGameIds.length,
      regularSeasonGameIds,
      finalPrefixGameCount,
      targetGameIds: regularSeasonGameIds.slice(openingStart, openingStart + 6),
    };
  });
  const sourceGameIdsByTeam = Object.fromEntries(
    anchorTeams.map((team) => [
      team.teamAbbreviation,
      team.regularSeasonGameIds.slice(0, requiredThroughGameNumber),
    ]),
  );

  return { anchorTeams, sourceGameIdsByTeam };
}

function anchoredPublication(overrides = {}) {
  const anchorHash = 'a'.repeat(64);

  return {
    requestExists: true,
    requestStatus: 'processing',
    requestLeagueId: 'league-1',
    requestRequestedBy: 'server:draft-automation',
    requestTargetCycleNumber: 1,
    requestTargetSourceBlockNumber: 2,
    requestSeasonWindowAnchorEvidenceHash: anchorHash,
    requestTargetGameIdsMatch: true,
    requestSourceGamePlanMatches: true,
    activeRequestId: 'request-a',
    expectedRequestId: 'request-a',
    expectedLeagueId: 'league-1',
    expectedRequestedBy: 'server:draft-automation',
    expectedTargetCycleNumber: 1,
    expectedTargetSourceBlockNumber: 2,
    expectedSeasonWindowAnchorEvidenceHash: anchorHash,
    requiresDraftScheduleBinding: true,
    draftExists: true,
    draftStatus: 'scheduled',
    expectedDraftScheduleGeneration: 4,
    expectedDraftScheduledStartMilliseconds: 1_000,
    draftScheduleGeneration: 4,
    draftScheduledStartMilliseconds: 1_000,
    draftAnchorScheduleGeneration: 4,
    draftAnchorStatus: 'ready',
    draftInitialNhlBlockNumber: 2,
    draftSeasonWindowAnchorEvidenceHash: anchorHash,
    draftTargetGameIdsMatch: true,
    draftSourceGamePlanMatches: true,
    generationReason: 'pre-draft',
    ...overrides,
  };
}

test('T-40 finalization deadline covers the paced all-club anchor load', async () => {
  const [draftAutomation, requestPacing] = await Promise.all([
    readFile(new URL(
      '../../functions/src/draft-automation.ts',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../../functions/src/shared/core/projection/team-schedule-request-pacing.util.ts',
      import.meta.url,
    ), 'utf8'),
  ]);
  const delayMilliseconds = readIntegerConstant(
    requestPacing,
    'STRICT_TEAM_SCHEDULE_REQUEST_DELAY_MILLISECONDS',
  );
  const finalizationDeadlineSeconds = readIntegerConstant(
    draftAutomation,
    'DRAFT_FINALIZATION_TASK_DISPATCH_DEADLINE_SECONDS',
  );
  const pacingFloorSeconds = ((32 - 1) * delayMilliseconds) / 1_000;

  assert.ok(
    finalizationDeadlineSeconds >= pacingFloorSeconds + 60,
    'T-40 finalization needs the 32-club pacing floor plus a bounded fetch margin.',
  );
  assert.match(
    draftAutomation,
    /taskType: 'draft-finalization'[\s\S]*?dispatchDeadlineSeconds:\s*DRAFT_FINALIZATION_TASK_DISPATCH_DEADLINE_SECONDS/,
  );
  assert.match(
    draftAutomation,
    /processDraftClockDeadline = onTaskDispatched[\s\S]*?timeoutSeconds:\s*DRAFT_FINALIZATION_TASK_DISPATCH_DEADLINE_SECONDS/,
  );
});

test('late-season capacity preserves a regular matchup and every playoff round through block 13', () => {
  const capacity = validateAnchoredSeasonCapacity({
    finalizedTeamCount: 8,
    activeNhlTeamCount: 32,
    initialNhlBlockNumber: 10,
    requiredGamesPerCycle: 6,
    teams: teams(),
  });

  assert.deepEqual(capacity, {
    regularSeasonCycleCount: 1,
    playoffRoundCount: 3,
    finalRequiredSourceBlock: 13,
    requiredThroughGameNumber: 78,
  });
});

test('anchor readiness rejects a truncated late schedule even when its opening block exists', () => {
  const evidence = teams();
  evidence[17] = { ...evidence[17], regularSeasonGameCount: 77 };

  assert.throws(() => validateAnchoredSeasonCapacity({
    finalizedTeamCount: 8,
    activeNhlTeamCount: 32,
    initialNhlBlockNumber: 10,
    requiredGamesPerCycle: 6,
    teams: evidence,
  }), /incomplete through game 78 for: T17/);
});

test('anchor capacity fails closed for a corrupt non-six-game format and a too-late start', () => {
  assert.throws(() => validateAnchoredSeasonCapacity({
    finalizedTeamCount: 4,
    activeNhlTeamCount: 32,
    initialNhlBlockNumber: 2,
    requiredGamesPerCycle: 5,
    teams: teams(),
  }), /protected 6-game matchup format/);
  assert.throws(() => validateAnchoredSeasonCapacity({
    finalizedTeamCount: 8,
    activeNhlTeamCount: 32,
    initialNhlBlockNumber: 11,
    requiredGamesPerCycle: 6,
    teams: teams(),
  }), /starts too late/);
});

test('Draft-opening projection uses frozen game IDs even if provider ordering changes', () => {
  const reordered = [
    { id: 107 },
    { id: 106 },
    { id: 108 },
    { id: 110 },
    { id: 109 },
    { id: 112 },
    { id: 111 },
  ];
  const selected = selectProjectionTargetGames(
    reordered,
    2,
    6,
    [106, 107, 108, 109, 110, 111],
    'T00',
  );

  assert.deepEqual(selected.map((game) => game.id), [106, 107, 108, 109, 110, 111]);
  assert.throws(() => selectProjectionTargetGames(
    reordered.filter((game) => game.id !== 109),
    2,
    6,
    [106, 107, 108, 109, 110, 111],
    'T00',
  ), /no longer contains every game frozen/);
});

test('a 7-final anchor keeps Fantasy Matchup 1 on exact NHL games 7-12 and freezes the complete plan', () => {
  const fixture = sourcePlanFixture({
    initialNhlBlockNumber: 2,
    finalPrefixGameCount: 7,
  });
  const validated = validateSeasonWindowSourcePlan({
    finalizedTeamCount: 8,
    initialNhlBlockNumber: 2,
    requiredGamesPerCycle: 6,
    activeNhlTeamAbbreviations: fixture.anchorTeams.map(
      (team) => team.teamAbbreviation,
    ),
    anchorTeams: fixture.anchorTeams,
    sourceGameIdsByTeam: fixture.sourceGameIdsByTeam,
  });
  const targets = buildSourceNhlTargetGameIdsByTeam(
    validated.sourceGameIdsByTeam,
    2,
    6,
  );

  assert.deepEqual(targets.T00, [1007, 1008, 1009, 1010, 1011, 1012]);
  assert.equal(validated.sourceGameIdsByTeam.T00.length, 78);
});

test('an arbitrary 37-final anchor keeps Matchup 1 on games 37-42', () => {
  const fixture = sourcePlanFixture({
    initialNhlBlockNumber: 7,
    finalPrefixGameCount: 37,
  });
  const validated = validateSeasonWindowSourcePlan({
    finalizedTeamCount: 2,
    initialNhlBlockNumber: 7,
    requiredGamesPerCycle: 6,
    activeNhlTeamAbbreviations: fixture.anchorTeams.map(
      (team) => team.teamAbbreviation,
    ),
    anchorTeams: fixture.anchorTeams,
    sourceGameIdsByTeam: fixture.sourceGameIdsByTeam,
  });
  const targets = buildSourceNhlTargetGameIdsByTeam(
    validated.sourceGameIdsByTeam,
    7,
    6,
  );

  assert.deepEqual(targets.T00, [1037, 1038, 1039, 1040, 1041, 1042]);
});

test('a ready intermediate anchor repairs a truncated plan only from its already-frozen IDs', () => {
  const fixture = sourcePlanFixture({
    initialNhlBlockNumber: 2,
    finalPrefixGameCount: 7,
  });
  const truncated = structuredClone(fixture.sourceGameIdsByTeam);
  truncated.T00 = truncated.T00.slice(0, 12);

  assert.throws(() => validateSeasonWindowSourcePlan({
    finalizedTeamCount: 8,
    initialNhlBlockNumber: 2,
    requiredGamesPerCycle: 6,
    activeNhlTeamAbbreviations: fixture.anchorTeams.map(
      (team) => team.teamAbbreviation,
    ),
    anchorTeams: fixture.anchorTeams,
    sourceGameIdsByTeam: truncated,
  }), /T00 is incomplete/);

  const recovered = buildSeasonWindowSourcePlanFromAnchor({
    finalizedTeamCount: 8,
    initialNhlBlockNumber: 2,
    requiredGamesPerCycle: 6,
    activeNhlTeamAbbreviations: fixture.anchorTeams.map(
      (team) => team.teamAbbreviation,
    ),
    anchorTeams: fixture.anchorTeams,
  });

  assert.equal(recovered.sourceGameIdsByTeam.T00.length, 78);
  assert.deepEqual(
    recovered.sourceGameIdsByTeam.T00,
    fixture.anchorTeams[0].regularSeasonGameIds.slice(0, 78),
  );
});

test('later Projection V11 blocks select exact frozen IDs despite provider insertion and reorder', () => {
  const providerSchedule = [
    { id: 1019 },
    { id: 1013 },
    { id: 999999 },
    { id: 1017 },
    { id: 1015 },
    { id: 1018 },
    { id: 1014 },
    { id: 1016 },
  ];
  const selected = selectProjectionTargetGames(
    providerSchedule,
    3,
    6,
    [1013, 1014, 1015, 1016, 1017, 1018],
    'T00',
  );

  assert.deepEqual(
    selected.map((game) => game.id),
    [1013, 1014, 1015, 1016, 1017, 1018],
  );
});

test('stale worker A cannot publish after reschedule B replaces the active request', () => {
  assert.equal(shouldPublishProjectionResult(anchoredPublication()), true);
  assert.equal(shouldPublishProjectionResult(anchoredPublication({
    activeRequestId: 'request-b',
    draftScheduleGeneration: 5,
    draftAnchorScheduleGeneration: 5,
  })), false);
  assert.equal(shouldMutateProjectionControl('request-b', 'request-a'), false);
  assert.equal(shouldMutateProjectionControl('request-a', 'request-a'), true);
});

test('pre-draft publication ignores Firestore map key order but preserves each team game sequence', () => {
  const canonical = Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => [
      `T${String(index).padStart(2, '0')}`,
      [index * 10 + 1, index * 10 + 2, index * 10 + 3],
    ]),
  );
  const firestoreOrdered = Object.fromEntries(
    Object.entries(canonical).reverse(),
  );

  assert.equal(
    projectionGameIdMapsMatch(canonical, firestoreOrdered),
    true,
  );
  assert.equal(shouldPublishProjectionResult(anchoredPublication({
    requestTargetGameIdsMatch: projectionGameIdMapsMatch(
      canonical,
      firestoreOrdered,
    ),
    draftTargetGameIdsMatch: projectionGameIdMapsMatch(
      canonical,
      firestoreOrdered,
    ),
  })), true);

  const changedSequence = structuredClone(firestoreOrdered);
  changedSequence.T00 = [2, 1, 3];
  assert.equal(
    projectionGameIdMapsMatch(canonical, changedSequence),
    false,
  );

  const changedGame = structuredClone(firestoreOrdered);
  changedGame.T00 = [1, 2, 999];
  assert.equal(projectionGameIdMapsMatch(canonical, changedGame), false);

  const missingTeam = structuredClone(firestoreOrdered);
  delete missingTeam.T31;
  assert.equal(projectionGameIdMapsMatch(canonical, missingTeam), false);

  const extraTeam = structuredClone(firestoreOrdered);
  extraTeam.EXTRA = [1, 2, 3];
  assert.equal(projectionGameIdMapsMatch(canonical, extraTeam), false);

  const invalidGame = structuredClone(firestoreOrdered);
  invalidGame.T00 = [1, 2, 0];
  assert.equal(projectionGameIdMapsMatch(canonical, invalidGame), false);
});

test('publication rejects source/hash/ID drift and preserves legacy requests only without a new anchor', () => {
  assert.equal(shouldPublishProjectionResult(anchoredPublication({
    draftInitialNhlBlockNumber: 3,
  })), false);
  assert.equal(shouldPublishProjectionResult(anchoredPublication({
    draftSeasonWindowAnchorEvidenceHash: 'b'.repeat(64),
  })), false);
  assert.equal(shouldPublishProjectionResult(anchoredPublication({
    draftTargetGameIdsMatch: false,
  })), false);
  assert.equal(shouldPublishProjectionResult(anchoredPublication({
    requestSourceGamePlanMatches: false,
  })), false);
  assert.equal(shouldPublishProjectionResult(anchoredPublication({
    draftSourceGamePlanMatches: false,
  })), false);

  const legacy = anchoredPublication({
    requestTargetSourceBlockNumber: 1,
    expectedTargetSourceBlockNumber: 1,
    requestSeasonWindowAnchorEvidenceHash: undefined,
    expectedSeasonWindowAnchorEvidenceHash: null,
    requestTargetGameIdsMatch: true,
    requiresDraftScheduleBinding: false,
    draftAnchorStatus: null,
    generationReason: 'pre-draft',
  });
  assert.equal(shouldPublishProjectionResult(legacy), true);
  assert.equal(shouldPublishProjectionResult({
    ...legacy,
    draftAnchorStatus: 'ready',
  }), false);
});

test('queue dedupe reuses only the exact live immutable projection context', () => {
  const base = {
    activeRequestId: 'request-a',
    nextRequestId: 'request-b',
    activeStatus: 'queued',
    activeLeaseExpiresAt: 20_000,
    now: 10_000,
    activePayloadHash: 'same-anchor-plan-and-schedule',
    nextPayloadHash: 'same-anchor-plan-and-schedule',
  };

  assert.equal(shouldReuseActiveProjectionRequest(base), true);
  assert.equal(shouldReuseActiveProjectionRequest({
    ...base,
    nextPayloadHash: 'same-source-block-but-new-plan-or-schedule',
  }), false);
  assert.equal(shouldReuseActiveProjectionRequest({
    ...base,
    now: 20_000,
  }), false);
});

test('production wiring retains immutable snapshots and uses guarded publication/control mutation', async () => {
  const [authority, snapshotService, draftAutomation, draftAuthority] = await Promise.all([
    readFile(new URL('functions/src/projection-authority.ts', ROOT), 'utf8'),
    readFile(new URL(
      'functions/src/shared/core/projection/projection-snapshot.service.ts',
      ROOT,
    ), 'utf8'),
    readFile(new URL('functions/src/draft-automation.ts', ROOT), 'utf8'),
    readFile(new URL('functions/src/draft-authority.ts', ROOT), 'utf8'),
  ]);

  assert.match(authority, /publishPointers: false/);
  assert.match(authority, /shouldPublishProjectionResult\(\{/);
  assert.match(authority, /shouldMutateProjectionControl\(/);
  assert.match(authority, /targetGameIdsByTeam: claimed\.targetGameIdsByTeam/);
  assert.match(authority, /buildSourceNhlTargetGameIdsByTeam\(/);
  assert.match(authority, /seasonWindowSourceGamePlanHash/);
  assert.match(snapshotService, /if \(input\.publishPointers !== false\)/);
  assert.match(draftAutomation, /const finalizedTeamCount = draft\.roundOneOrder\.length/);
  assert.match(draftAutomation, /validateAnchoredSeasonCapacity\(\{/);
  assert.match(draftAutomation, /buildSeasonWindowSourcePlanFromAnchor\(\{/);
  assert.match(draftAutomation, /validateSeasonWindowSourcePlan\(\{/);
  assert.match(draftAuthority, /validateSeasonWindowSourcePlan\(\{/);
  assert.doesNotMatch(draftAutomation, /leagueTeamCount/);
});

test('new Hosting accepts legacy schema 2 and requires exact schema 3 anchor evidence', async () => {
  const [browserSource, draftRoomSource, bindingSource, serverHashSource] = await Promise.all([
    readFile(new URL(
      'src/app/core/projection/projection-snapshot.service.ts',
      ROOT,
    ), 'utf8'),
    readFile(new URL(
      'src/app/features/draft/draft-room/draft-room.ts',
      ROOT,
    ), 'utf8'),
    readFile(new URL(
      'src/app/features/draft/draft-room/draft-projection-pool-binding.util.ts',
      ROOT,
    ), 'utf8'),
    readFile(new URL(
      'functions/src/shared/core/projection/projection-snapshot-hash.util.ts',
      ROOT,
    ), 'utf8'),
  ]);

  assert.match(browserSource, /isSupportedProjectionSnapshotHashSchemaVersion/);
  assert.match(draftRoomSource, /isDraftProjectionSnapshotSchemaCompatible\(draft, snapshot\.metadata\)/);
  assert.match(bindingSource, /snapshotHashSchemaVersion ===[\s\S]*?ANCHORED_PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION/);
  assert.match(bindingSource, /seasonWindowAnchorEvidenceHash\) === draftAnchorHash/);
  assert.match(serverHashSource, /targetSourceBlockNumber/);
  assert.match(serverHashSource, /seasonWindowAnchorEvidenceHash/);
});
