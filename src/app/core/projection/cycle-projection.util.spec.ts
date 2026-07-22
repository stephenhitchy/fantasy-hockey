import { describe, expect, it } from 'vitest';

import { createFrozenCycleProjection, getVisibleCycleProjection } from './cycle-projection.util';

describe('manager-facing cycle projection calibration', () => {
  it('keeps Version 8 projections conservative without the former deep discount', () => {
    expect(getVisibleCycleProjection('LW', 100)).toBe(98);
    expect(getVisibleCycleProjection('C', 100)).toBe(98);
    expect(getVisibleCycleProjection('RW', 100)).toBe(98);
    expect(getVisibleCycleProjection('D', 100)).toBe(97);
    expect(getVisibleCycleProjection('G', 100)).toBe(96);
  });

  it('freezes the calibrated manager-facing value', () => {
    expect(
      createFrozenCycleProjection({
        position: 'C',
        projectedCyclePoints: 40,
      }),
    ).toBe(39.2);
  });
});
