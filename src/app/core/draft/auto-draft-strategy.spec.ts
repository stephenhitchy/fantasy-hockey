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
      existingBenchRoles: new Set<'F' | 'D' | 'G'>(),
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
        existingBenchRoles: new Set(['G']),
      }),
    ).toBe(true);
  });

  it('allows the first missing bench coverage role', () => {
    expect(
      isAutomaticDraftCandidateAllowed({
        hasOpenStartingSlot: false,
        destination: 'bench',
        assetPosition: 'LW',
        existingBenchRoles: new Set(),
      }),
    ).toBe(true);
  });

  it('rejects a second forward while defense and goalie remain uncovered', () => {
    const context = {
      hasOpenStartingSlot: false,
      destination: 'bench' as const,
      assetPosition: 'RW' as const,
      existingBenchRoles: new Set<'F' | 'D' | 'G'>(['F']),
    };

    expect(isAutomaticDraftCandidateAllowed(context)).toBe(false);
    expect(getAutoDraftCandidateBlockReason(context)).toBe('duplicate-bench-role');
  });

  it('fills the missing third role after two manual bench picks', () => {
    expect(
      isAutomaticDraftCandidateAllowed({
        hasOpenStartingSlot: false,
        destination: 'bench',
        assetPosition: 'G',
        existingBenchRoles: new Set(['F', 'D']),
      }),
    ).toBe(true);
  });
});
