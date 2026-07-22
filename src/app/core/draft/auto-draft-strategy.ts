export type AutoDraftPositionCode = 'LW' | 'C' | 'RW' | 'D' | 'G';

export type AutoDraftRosterArea = 'active' | 'bench' | null;

export type AutoDraftBenchRole = 'F' | 'D' | 'G';

export interface AutoDraftCandidateContext {
  hasOpenStartingSlot: boolean;
  destination: AutoDraftRosterArea;
  assetPosition: AutoDraftPositionCode;
  existingBenchRoles: ReadonlySet<AutoDraftBenchRole>;
}

export type AutoDraftCandidateBlockReason =
  | 'fill-starters-first'
  | 'duplicate-bench-role'
  | null;

export function getAutoDraftBenchRole(position: AutoDraftPositionCode): AutoDraftBenchRole {
  if (position === 'D') {
    return 'D';
  }

  if (position === 'G') {
    return 'G';
  }

  return 'F';
}

/**
 * Auto-draft follows two strict phases:
 * 1. Fill every active roster slot.
 * 2. Fill the three bench coverage roles: one forward, one defenseman, and one goalie unit.
 *
 * Manual drafting is intentionally unaffected by this policy. If a manager manually
 * creates duplicate bench roles before enabling auto-draft, later automatic picks use
 * any still-missing role whenever an open bench slot remains.
 */
export function getAutoDraftCandidateBlockReason(
  context: AutoDraftCandidateContext,
): AutoDraftCandidateBlockReason {
  if (context.hasOpenStartingSlot) {
    return context.destination === 'active' ? null : 'fill-starters-first';
  }

  if (context.destination !== 'bench') {
    return 'fill-starters-first';
  }

  return context.existingBenchRoles.has(getAutoDraftBenchRole(context.assetPosition))
    ? 'duplicate-bench-role'
    : null;
}

export function isAutomaticDraftCandidateAllowed(
  context: AutoDraftCandidateContext,
): boolean {
  return getAutoDraftCandidateBlockReason(context) === null;
}
