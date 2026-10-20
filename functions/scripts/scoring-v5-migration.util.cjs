'use strict';

const SAFE_PRESEASON_DRAFT_STATUSES = new Set(['missing', 'setup', 'scheduled']);

function normalizeDraftStatus(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim().toLowerCase()
    : 'missing';
}

/**
 * Scoring V5 can cross the V4/V5 boundary only before competition exists.
 * There is deliberately no mixed-history escape hatch: an operator must
 * resolve or preserve any started league on its original scoring contract.
 */
function classifyPreseasonScoringTransition(input) {
  const alreadyTarget = input.alreadyTarget === true;
  const canonicalSource = input.canonicalSource === true;
  const cycleCount = Math.max(0, Number(input.cycleCount) || 0);
  const pickCount = Math.max(0, Number(input.pickCount) || 0);
  const draftStatus = normalizeDraftStatus(input.draftStatus);
  const blockers = [];

  if (!alreadyTarget) {
    if (!canonicalSource) blockers.push('source-scoring-contract-mismatch');
    if (cycleCount > 0) blockers.push('competition-cycle-history');
    if (pickCount > 0) blockers.push('draft-picks-exist');
    if (!SAFE_PRESEASON_DRAFT_STATUSES.has(draftStatus)) {
      blockers.push(`draft-status-${draftStatus}`);
    }
  }

  return {
    alreadyTarget,
    canonicalSource,
    eligible: blockers.length === 0,
    blockers,
    cycleCount,
    pickCount,
    draftStatus,
  };
}

/** Mutable aliases may be invalidated; content-addressed snapshot evidence is retained. */
function isProjectionPointerId(id) {
  return id === 'current' || /^target-cycle-\d+$/.test(id);
}

module.exports = {
  SAFE_PRESEASON_DRAFT_STATUSES,
  classifyPreseasonScoringTransition,
  isProjectionPointerId,
  normalizeDraftStatus,
};
