export type AutoDraftPositionCode = 'LW' | 'C' | 'RW' | 'D' | 'G';

export type AutoDraftRosterArea = 'active' | 'bench' | null;

export type AutoDraftBenchRole = 'F' | 'D' | 'G';

export interface AutoDraftCandidateContext {
  hasOpenStartingSlot: boolean;
  destination: AutoDraftRosterArea;
  assetPosition: AutoDraftPositionCode;
  existingBenchRoleCounts: Readonly<Record<AutoDraftBenchRole, number>>;
}

export type AutoDraftCandidateBlockReason =
  | 'fill-starters-first'
  | 'bench-role-filled'
  | null;

export const AUTO_DRAFT_BENCH_ROLE_TARGETS: Readonly<
  Record<AutoDraftBenchRole, number>
> = {
  F: 2,
  D: 1,
  G: 0,
};

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
 * 2. Fill the bench with two forwards and one defenseman. A second team goalie
 *    unit is left on waivers because it cannot be injured.
 *
 * Manual drafting is intentionally unaffected by this policy. If a manager manually
 * uses a bench slot before enabling auto-draft, later automatic picks fill as much of
 * the remaining target as the open roster spots allow.
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

  const role = getAutoDraftBenchRole(context.assetPosition);

  return context.existingBenchRoleCounts[role] >= AUTO_DRAFT_BENCH_ROLE_TARGETS[role]
    ? 'bench-role-filled'
    : null;
}

export function isAutomaticDraftCandidateAllowed(
  context: AutoDraftCandidateContext,
): boolean {
  return getAutoDraftCandidateBlockReason(context) === null;
}
