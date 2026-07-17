import { describe, expect, it } from 'vitest';

import { runFullSeasonLifecycleSimulator } from './season-lifecycle-simulator';

describe('full season lifecycle simulator', () => {
  it('passes the complete four-team release lifecycle', () => {
    const result = runFullSeasonLifecycleSimulator();

    expect(result.passed).toBe(true);
    expect(result.passedCount).toBe(result.totalCount);
    expect(result.milestones.every((milestone) => milestone.status === 'passed')).toBe(true);
  });
});
