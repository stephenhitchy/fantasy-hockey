function hasPattern(value, pattern) {
  return typeof value === 'string' && pattern.test(value);
}

function countPattern(value, pattern) {
  return typeof value === 'string' ? [...value.matchAll(pattern)].length : 0;
}

export function evaluateProtectedRosterRuntimeContract(input = {}) {
  const blockers = [];
  const requirePattern = (label, value, pattern) => {
    if (!hasPattern(value, pattern)) {
      blockers.push(label);
    }
  };

  requirePattern(
    'The browser roster contract must expose five bench slots.',
    input.browserRosterConfig,
    /BENCH_SLOT_COUNT\s*=\s*5\b/,
  );
  requirePattern(
    'The Functions roster contract must expose five bench slots.',
    input.serverRosterConfig,
    /BENCH_SLOT_COUNT\s*=\s*5\b/,
  );
  requirePattern(
    'Server roster migration must preserve five bench slots.',
    input.rosterAuthority,
    /benchSlots\.length\s*!==\s*5\b/,
  );
  requirePattern(
    'Server Draft authority must create five bench slots.',
    input.draftAuthority,
    /DEFAULT_BENCH_SLOTS\s*=\s*5\b/,
  );
  requirePattern(
    'Server Draft automation must retain the 19-round roster contract.',
    input.draftAutomation,
    /:\s*19,\s*\n\s*rosterRequirements:/,
  );
  requirePattern(
    'Server Draft automation must retain five fallback bench slots.',
    input.draftAutomation,
    /:\s*5,\s*\n\s*roundOneOrder:/,
  );
  requirePattern(
    'Auto-Draft must retain three forward bench targets.',
    input.draftPickEngine,
    /F:\s*3,/,
  );
  requirePattern(
    'Auto-Draft must retain two defense bench targets.',
    input.draftPickEngine,
    /D:\s*2,/,
  );
  requirePattern(
    'Draft Ranking V4 must remain bound to the five-bench demand model.',
    input.projectionRanking,
    /DRAFT_RANKING_MODEL_VERSION\s*=\s*4\b/,
  );
  requirePattern(
    'The immediate roster authority must retain injury-replacement actions.',
    input.rosterMoves,
    /moveType\s*===\s*'injury-replacement'/,
  );
  requirePattern(
    'The scorer must resolve injury-window ownership by exact game id.',
    input.cycleScoring,
    /getInjuryReplacementAssetKeyByGameId\(injuryReplacementPlan\)/,
  );
  requirePattern(
    'Window rollover must advance only the current injury-replacement segment.',
    input.cycleService,
    /currentInjurySegment\?\.scheduledGameIds\s*\?\?\s*window\.scheduledGameIds/,
  );
  requirePattern(
    'The versioned injury-replacement window normalizer must remain present.',
    input.injuryReplacementWindow,
    /normalizeInjuryReplacementWindowPlan/,
  );
  requirePattern(
    'Zero-game outgoing injury segments must remain as audit evidence.',
    input.injuryReplacementWindow,
    /const retainedSegments = \[\.\.\.priorSegments, currentSegment\];/,
  );
  requirePattern(
    'Every built injury plan must round-trip through its normalizer.',
    input.injuryReplacementWindow,
    /const normalizedPlan = normalizeInjuryReplacementWindowPlan\(plan\)/,
  );
  requirePattern(
    'Known B1V zero-start ownership must remain backward-compatible.',
    input.injuryReplacementWindow,
    /hasLegacyOmittedOriginalSegment/,
  );
  requirePattern(
    'Injury segments must retain exact per-game NHL source-team evidence.',
    input.injuryReplacementWindow,
    /sourceTeamAbbreviationByGameId/,
  );
  requirePattern(
    'Injury plan copies must distinguish scorer-managed current-segment evolution from immutable history.',
    input.injuryReplacementWindow,
    /hasCompatiblePlanLineage/,
  );
  requirePattern(
    'Injury plans must strictly validate nested player-window continuity evidence.',
    input.injuryReplacementWindow,
    /normalizePlayerWindowContinuity\(/,
  );
  requirePattern(
    'Repeated injury boundaries must remain monotonic.',
    input.injuryReplacementWindow,
    /replacementBoundariesAreMonotonic/,
  );
  requirePattern(
    'Every injury segment must retain one roster-slot position.',
    input.injuryReplacementWindow,
    /segmentPositions\.size !== 1/,
  );
  requirePattern(
    'Injury windows must preserve exact plan, schedule, owner-map, and protected-game evidence.',
    input.injuryReplacementWindow,
    /hasConsistentInjuryReplacementWindowEvidence/,
  );
  requirePattern(
    'Saved injury ownership must fail closed when present but malformed.',
    input.cycleScoring,
    /requireValidInjuryReplacementWindowPlan\(/,
  );
  requirePattern(
    'Browser fallback scoring must also fail closed on malformed injury ownership.',
    input.browserCycleScoring,
    /requireValidInjuryReplacementWindowPlan\(/,
  );
  requirePattern(
    'Server cycle-window copies must fail closed on malformed injury ownership.',
    input.assetCycleWindow,
    /requireValidInjuryReplacementWindowPlan\(/,
  );
  requirePattern(
    'Server cycle windows must validate exact injury ownership evidence.',
    input.assetCycleWindow,
    /hasConsistentInjuryReplacementWindowEvidence\(/,
  );
  requirePattern(
    'Server cycle-window writes must reject conflicting injury ownership copies.',
    input.assetCycleWindow,
    /resolveConsistentInjuryReplacementWindowPlan\(/,
  );
  requirePattern(
    'Browser cycle-window copies must reject conflicting injury ownership copies.',
    input.browserAssetCycleWindow,
    /resolveConsistentInjuryReplacementWindowPlan\(/,
  );
  requirePattern(
    'Browser cycle windows must validate exact injury ownership evidence.',
    input.browserAssetCycleWindow,
    /hasConsistentInjuryReplacementWindowEvidence\(/,
  );
  requirePattern(
    'League automation must fail closed on malformed injury ownership.',
    input.leagueAutomation,
    /requireValidInjuryReplacementWindowPlan\(/,
  );
  requirePattern(
    'Roster moves must transactionally recheck injury availability.',
    input.rosterMoves,
    /transactionMoveToIrAvailabilityStatus/,
  );
  requirePattern(
    'Injury replacement must reject a saved game allowance mismatch.',
    input.rosterMoves,
    /previousPlan\.requiredGames !== gamesPerCycle/,
  );
  requirePattern(
    'Repeated injury replacement must verify every retained game against its exact NHL source team.',
    input.rosterMoves,
    /verifiedScheduleEvidenceByGameId/,
  );
  requirePattern(
    'Roster moves must reject bench assets reserved by queued moves.',
    input.rosterMoves,
    /That bench player is reserved for another scheduled lineup move\./,
  );
  requirePattern(
    'Secure roster actions must transactionally reread injury eligibility.',
    input.rosterAuthority,
    /resolveAuthoritativeAvailabilityStatus\(/,
  );
  requirePattern(
    'Secure queued swaps must reject already-reserved bench assets.',
    input.rosterAuthority,
    /isBenchSlotReserved\(roster, benchSlotId\)/,
  );
  requirePattern(
    'Add/drop receipts must derive a private deterministic transaction id.',
    input.rosterActionIdempotency,
    /createRosterActionTransactionId/,
  );
  requirePattern(
    'Add/drop receipts must bind retries to an exact request fingerprint.',
    input.rosterActionIdempotency,
    /createRosterActionRequestFingerprint/,
  );
  requirePattern(
    'Add/drop receipts must reject a reused identifier with different intent.',
    input.rosterActionIdempotency,
    /status:\s*'conflict'/,
  );
  requirePattern(
    'Secure add/drop authority must read the receipt inside its transaction.',
    input.rosterAuthority,
    /transaction\.get\(transactionRef\)/,
  );
  requirePattern(
    'Immediate add/drop authority must read the receipt inside its transaction.',
    input.rosterMoves,
    /submissionId && isImmediateAdd[\s\S]+transaction\.get\(transactionRef\)/,
  );
  requirePattern(
    'Secure add/drop authority must verify the exact outgoing asset.',
    input.rosterAuthority,
    /expectedOutgoingAssetKey/,
  );
  requirePattern(
    'Immediate add/drop authority must verify the exact outgoing asset.',
    input.rosterMoves,
    /expectedOutgoingAssetKey/,
  );
  requirePattern(
    'Immediate add/drop authority must reject duplicate ownership on the caller roster.',
    input.rosterMoves,
    /rosterContainsAsset\(roster, incomingKey\)/,
  );
  requirePattern(
    'Interactive add/drop identity must use exact forced player evidence.',
    input.rosterMoves,
    /getCurrentNhlPlayerTeamIdentity\(playerId, true\)/,
  );
  requirePattern(
    'Roster-action puck-drop checks must preserve postponed and cancelled game states.',
    input.rosterMoves,
    /hasNhlGameReachedStartSafetyBoundary\(/,
  );
  requirePattern(
    'The browser must assign one stable add/drop submission identifier.',
    input.freeAgents,
    /createRosterActionSubmissionId/,
  );
  requirePattern(
    'The browser must keep add/drop recovery through the callable envelope.',
    input.freeAgents,
    /ROSTER_ACTION_CONFIRMATION_WINDOW_MS/,
  );
  requirePattern(
    'The add/drop recovery envelope must include callable and retry timing.',
    input.rosterActionTransport,
    /ROSTER_ACTION_CALLABLE_TIMEOUT_MS[\s\S]+ROSTER_ACTION_QUICK_RETRY_WINDOW_MS[\s\S]+7_000/,
  );
  requirePattern(
    'The browser must perform an exact server roster reconciliation read.',
    input.browserRosterService,
    /getDocFromServer/,
  );
  requirePattern(
    'Ambiguous add/drop transport failures must remain recoverable.',
    input.rosterActionTransport,
    /isPossiblyCommittedRosterActionError/,
  );
  requirePattern(
    'Scoring must load final logs for every effective segment asset.',
    input.cycleScoring,
    /effectiveSkaterAssetsByKey/,
  );
  requirePattern(
    'Scoring must reject missing or conflicting saved per-game owners before final reuse.',
    input.cycleScoring,
    /hasExactInjuryReplacementScoringAssetKeyMap\(/,
  );
  requirePattern(
    'Scoring must preserve started injury-game ownership across plan evolution.',
    input.cycleScoring,
    /hasPreservedInjuryReplacementProtectedGameOwnership\(/,
  );
  requirePattern(
    'Opponent-overlap game IDs must not inherit another segment owner.',
    input.cycleScoring,
    /previousGameBelongsToCurrentSegment/,
  );
  requirePattern(
    'Repeated injury moves must validate protected cycle and playoff window evidence.',
    input.rosterMoves,
    /assertWindowPreservesSelectedInjuryReplacementPlan\(/,
  );
  requirePattern(
    'Regular asynchronous rollover must use the current injury segment only.',
    input.cycleService,
    /previousCurrentInjurySegment\?\.scheduledGameIds/,
  );
  requirePattern(
    'Playoff banks must retain the mixed-player ownership plan.',
    input.playoffWindowBank,
    /injuryReplacementWindow/,
  );
  requirePattern(
    'Playoff banks must retain exact game-to-player ownership.',
    input.playoffWindowBank,
    /scoringAssetKeyByGameId/,
  );
  requirePattern(
    'Playoff bank updates must preserve started injury-game ownership.',
    input.playoffWindowBank,
    /hasPreservedInjuryReplacementProtectedGameOwnership\(/,
  );
  requirePattern(
    'Playoff rollover must use the current injury segment only.',
    input.playoffWindowBank,
    /currentInjurySegment\?\.scheduledGameIds/,
  );
  requirePattern(
    'Canonical impact routing must include every injury segment player and source team.',
    input.canonicalImpactFeed,
    /injuryReplacementWindow\?\.segments/,
  );
  requirePattern(
    'Final reconciliation must compare each game with its segment owner.',
    input.finalScoreReconciliation,
    /asset:\s*scoringAsset/,
  );

  if (
    countPattern(
      input.rosterMoves,
      /isBenchSlotReserved\([^)]*benchSlotId\)/g,
    ) < 2
  ) {
    blockers.push(
      'Reserved-bench rejection must remain in both preflight and transaction authority.',
    );
  }

  return {
    schemaVersion: 1,
    ready: blockers.length === 0,
    blockers,
  };
}
