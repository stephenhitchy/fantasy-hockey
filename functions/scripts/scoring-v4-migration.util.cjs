'use strict';

const SAFE_PRESEASON_DRAFT_STATUSES = new Set(['missing', 'setup', 'scheduled']);

function normalizeDraftStatus(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim().toLowerCase()
    : 'missing';
}

function classifyScoringV4Migration(input) {
  const draftStatus = normalizeDraftStatus(input.draftStatus);
  const cycleCount = Math.max(0, Number(input.cycleCount) || 0);
  const completedCycleCount = Math.max(0, Number(input.completedCycleCount) || 0);
  const pickCount = Math.max(0, Number(input.pickCount) || 0);
  const allowMixedHistory = input.allowMixedHistory === true;
  const alreadyV4 = input.alreadyV4 === true;

  const blockers = [];

  if (!alreadyV4) {
    if (cycleCount > 0 && !allowMixedHistory) {
      blockers.push('competition-cycle-history');
    }
    if (completedCycleCount > 0 && !allowMixedHistory) {
      blockers.push('completed-cycle-history');
    }
    if (pickCount > 0 && !allowMixedHistory) {
      blockers.push('draft-picks-exist');
    }
    if (draftStatus === 'live') {
      blockers.push('draft-status-live');
    } else if (!SAFE_PRESEASON_DRAFT_STATUSES.has(draftStatus) && !allowMixedHistory) {
      blockers.push(`draft-status-${draftStatus}`);
    }
  }

  return {
    alreadyV4,
    eligible: blockers.length === 0,
    blockers,
    draftStatus,
    cycleCount,
    completedCycleCount,
    pickCount,
    mixedHistoryAllowed: allowMixedHistory,
  };
}

function isProjectionPointerId(id) {
  return id === 'current' || /^target-cycle-\d+$/.test(id);
}

module.exports = {
  SAFE_PRESEASON_DRAFT_STATUSES,
  classifyScoringV4Migration,
  isProjectionPointerId,
  normalizeDraftStatus,
};
