import { resolveDraftMobileSelectionLabel } from './draft-mobile-selection.util';

describe('Draft mobile selection label', () => {
  it('identifies a player whose position is full and will use the bench', () => {
    expect(
      resolveDraftMobileSelectionLabel({
        selected: false,
        destination: 'bench',
      }),
    ).toBe('Select for Bench');
  });

  it('keeps starter and unavailable choices neutral until review', () => {
    expect(
      resolveDraftMobileSelectionLabel({
        selected: false,
        destination: 'active',
      }),
    ).toBe('Select');
    expect(
      resolveDraftMobileSelectionLabel({
        selected: false,
        destination: null,
      }),
    ).toBe('Select');
  });

  it('keeps the selected state visible regardless of destination', () => {
    expect(
      resolveDraftMobileSelectionLabel({
        selected: true,
        destination: 'bench',
      }),
    ).toBe('Selected');
  });
});
