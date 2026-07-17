import { describe, expect, it } from 'vitest';

import { createFrozenCycleProjection, getVisibleCycleProjection } from './cycle-projection.util';

describe('manager-facing cycle projection calibration', () => {
  it('keeps Version 6 projections conservative without the former deep discount', () => {
    expect(getVisibleCycleProjection('LW', 100)).toBe(95);
    expect(getVisibleCycleProjection('C', 100)).toBe(95);
    expect(getVisibleCycleProjection('RW', 100)).toBe(95);
    expect(getVisibleCycleProjection('D', 100)).toBe(93);
    expect(getVisibleCycleProjection('G', 100)).toBe(90);
  });

  it('freezes the calibrated manager-facing value', () => {
    expect(
      createFrozenCycleProjection({
        assetType: 'skater',
        assetKey: 'skater-1',
        position: 'C',
        player: {
          id: 1,
          fullName: 'Calibration Test',
          position: 'C',
          nhlTeamAbbreviation: 'VGK',
        },
        projectedCyclePoints: 40,
      }),
    ).toBe(38);
  });
});
