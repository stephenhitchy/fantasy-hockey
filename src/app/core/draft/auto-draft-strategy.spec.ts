import {
  AUTO_DRAFT_BENCH_ROLE_TARGETS,
  getAutoDraftBenchRole,
  getAutoDraftCandidateBlockReason,
  isAutomaticDraftCandidateAllowed,
} from './auto-draft-strategy';

describe('auto-draft roster strategy', () => {
  const noBenchPlayers = { F: 0, D: 0, G: 0 } as const;

  it('targets three forwards, two defensemen, and no reserve goalie unit', () => {
    expect(AUTO_DRAFT_BENCH_ROLE_TARGETS).toEqual({ F: 3, D: 2, G: 0 });
  });

  it('maps all forward positions into one bench coverage role', () => {
    expect(getAutoDraftBenchRole('LW')).toBe('F');
    expect(getAutoDraftBenchRole('C')).toBe('F');
    expect(getAutoDraftBenchRole('RW')).toBe('F');
    expect(getAutoDraftBenchRole('D')).toBe('D');
    expect(getAutoDraftBenchRole('G')).toBe('G');
  });

  it('requires all starting roster slots before any bench pick', () => {
    const context = {
      hasOpenStartingSlot: true,
      destination: 'bench' as const,
      assetPosition: 'G' as const,
      existingBenchRoleCounts: noBenchPlayers,
    };

    expect(isAutomaticDraftCandidateAllowed(context)).toBe(false);
    expect(getAutoDraftCandidateBlockReason(context)).toBe('fill-starters-first');
  });

  it('allows a player that fills an unfinished starting slot', () => {
    expect(
      isAutomaticDraftCandidateAllowed({
        hasOpenStartingSlot: true,
        destination: 'active',
        assetPosition: 'C',
        existingBenchRoleCounts: { F: 0, D: 0, G: 1 },
      }),
    ).toBe(true);
  });

  it('allows the first missing bench coverage role', () => {
    expect(
      isAutomaticDraftCandidateAllowed({
        hasOpenStartingSlot: false,
        destination: 'bench',
        assetPosition: 'LW',
        existingBenchRoleCounts: noBenchPlayers,
      }),
    ).toBe(true);
  });

  it('allows a third forward while the three-forward target remains open', () => {
    expect(
      isAutomaticDraftCandidateAllowed({
        hasOpenStartingSlot: false,
        destination: 'bench',
        assetPosition: 'RW',
        existingBenchRoleCounts: { F: 2, D: 0, G: 0 },
      }),
    ).toBe(true);
  });

  it('rejects a fourth forward after the three-forward target is filled', () => {
    const context = {
      hasOpenStartingSlot: false,
      destination: 'bench' as const,
      assetPosition: 'RW' as const,
      existingBenchRoleCounts: { F: 3, D: 0, G: 0 },
    };

    expect(isAutomaticDraftCandidateAllowed(context)).toBe(false);
    expect(getAutoDraftCandidateBlockReason(context)).toBe('bench-role-filled');
  });

  it('fills defense after three forward bench picks', () => {
    expect(
      isAutomaticDraftCandidateAllowed({
        hasOpenStartingSlot: false,
        destination: 'bench',
        assetPosition: 'D',
        existingBenchRoleCounts: { F: 3, D: 0, G: 0 },
      }),
    ).toBe(true);
  });

  it('does not use a bench slot on a second goalie unit', () => {
    const context = {
      hasOpenStartingSlot: false,
      destination: 'bench' as const,
      assetPosition: 'G' as const,
      existingBenchRoleCounts: noBenchPlayers,
    };

    expect(isAutomaticDraftCandidateAllowed(context)).toBe(false);
    expect(getAutoDraftCandidateBlockReason(context)).toBe('bench-role-filled');
  });
});
