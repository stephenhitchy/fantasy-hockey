function hasPattern(value, pattern) {
  return typeof value === 'string' && pattern.test(value);
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

  return {
    schemaVersion: 1,
    ready: blockers.length === 0,
    blockers,
  };
}
