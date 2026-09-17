import {
  hasManagerDraftedGoalieUnit,
  shouldShowDraftPoolAsset,
} from './draft-goalie-visibility.util';

describe('Draft goalie-unit visibility', () => {
  it('activates only after the current manager drafts a goalie unit', () => {
    const picks = [
      { ownerId: 'other-manager', asset: { position: 'G' as const } },
      { ownerId: 'current-manager', asset: { position: 'D' as const } },
    ];

    expect(hasManagerDraftedGoalieUnit(picks, 'current-manager')).toBe(false);
    expect(hasManagerDraftedGoalieUnit(picks, 'other-manager')).toBe(true);
  });

  it('hides only extra goalie units from the default player pool', () => {
    expect(
      shouldShowDraftPoolAsset({
        assetPosition: 'G',
        positionFilter: 'ALL',
        managerHasGoalieUnit: true,
        showExtraGoalieUnits: false,
      }),
    ).toBe(false);
    expect(
      shouldShowDraftPoolAsset({
        assetPosition: 'D',
        positionFilter: 'ALL',
        managerHasGoalieUnit: true,
        showExtraGoalieUnits: false,
      }),
    ).toBe(true);
  });

  it('keeps manual access through either the goalie filter or the explicit toggle', () => {
    expect(
      shouldShowDraftPoolAsset({
        assetPosition: 'G',
        positionFilter: 'G',
        managerHasGoalieUnit: true,
        showExtraGoalieUnits: false,
      }),
    ).toBe(true);
    expect(
      shouldShowDraftPoolAsset({
        assetPosition: 'G',
        positionFilter: 'ALL',
        managerHasGoalieUnit: true,
        showExtraGoalieUnits: true,
      }),
    ).toBe(true);
  });
});
