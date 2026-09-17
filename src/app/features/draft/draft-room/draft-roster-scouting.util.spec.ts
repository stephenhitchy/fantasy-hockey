import {
  getDraftRosterPicksByPosition,
  resolveDraftRosterOwnerId,
} from './draft-roster-scouting.util';

describe('Draft roster scouting', () => {
  it('keeps an available requested team selected', () => {
    expect(
      resolveDraftRosterOwnerId({
        requestedOwnerId: 'team-c',
        currentOwnerId: 'team-a',
        availableOwnerIds: ['team-a', 'team-b', 'team-c'],
      }),
    ).toBe('team-c');
  });

  it('falls back to the current manager and then the first available team', () => {
    expect(
      resolveDraftRosterOwnerId({
        requestedOwnerId: 'removed-team',
        currentOwnerId: 'team-b',
        availableOwnerIds: ['team-a', 'team-b'],
      }),
    ).toBe('team-b');

    expect(
      resolveDraftRosterOwnerId({
        requestedOwnerId: 'removed-team',
        currentOwnerId: 'missing-manager',
        availableOwnerIds: ['team-a', 'team-b'],
      }),
    ).toBe('team-a');

    expect(
      resolveDraftRosterOwnerId({
        requestedOwnerId: 'removed-team',
        currentOwnerId: 'missing-manager',
        availableOwnerIds: [],
      }),
    ).toBe('');
  });

  it('returns only the selected roster position in Draft order without mutating picks', () => {
    const picks = [
      { ownerId: 'team-a', overallPick: 9, asset: { position: 'D' as const } },
      { ownerId: 'team-b', overallPick: 2, asset: { position: 'D' as const } },
      { ownerId: 'team-a', overallPick: 5, asset: { position: 'D' as const } },
      { ownerId: 'team-a', overallPick: 1, asset: { position: 'C' as const } },
    ];

    expect(
      getDraftRosterPicksByPosition(picks, 'team-a', 'D').map((pick) => pick.overallPick),
    ).toEqual([5, 9]);
    expect(picks.map((pick) => pick.overallPick)).toEqual([9, 2, 5, 1]);
  });
});
