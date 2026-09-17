import {
  getAutoDraftBenchRole,
  getAutoDraftCandidateBlockReason,
  isAutomaticDraftCandidateAllowed,
} from './auto-draft-strategy';

describe('auto-draft roster strategy', () => {
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
      existingBenchRoleCounts: { F: 0, D: 0, G: 0 },
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
        existingBenchRoleCounts: { F: 0, D: 0, G: 0 },
      }),
    ).toBe(true);
  });

  it('allows a second forward on the automatic bench', () => {
    const context = {
      hasOpenStartingSlot: false,
      destination: 'bench' as const,
      assetPosition: 'RW' as const,
      existingBenchRoleCounts: { F: 1, D: 0, G: 0 },
    };

    expect(isAutomaticDraftCandidateAllowed(context)).toBe(true);
    expect(getAutoDraftCandidateBlockReason(context)).toBe(null);
  });

  it('rejects a third forward after two automatic bench forwards', () => {
    const context = {
      hasOpenStartingSlot: false,
      destination: 'bench' as const,
      assetPosition: 'C' as const,
      existingBenchRoleCounts: { F: 2, D: 0, G: 0 },
    };

    expect(isAutomaticDraftCandidateAllowed(context)).toBe(false);
    expect(getAutoDraftCandidateBlockReason(context)).toBe('bench-role-full');
  });

  it('never allows a goalie unit on the automatic bench', () => {
    const context = {
      hasOpenStartingSlot: false,
      destination: 'bench' as const,
      assetPosition: 'G' as const,
      existingBenchRoleCounts: { F: 1, D: 1, G: 0 },
    };

    expect(isAutomaticDraftCandidateAllowed(context)).toBe(false);
    expect(getAutoDraftCandidateBlockReason(context)).toBe('bench-role-full');
  });
});
