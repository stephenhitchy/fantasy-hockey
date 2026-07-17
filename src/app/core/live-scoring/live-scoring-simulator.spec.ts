import { describe, expect, it } from 'vitest';

import { runLiveScoringDeterministicSimulator } from './live-scoring-simulator';

describe('shared live scoring deterministic simulator', () => {
  it('passes every lease, handoff, cadence, and write-suppression check', () => {
    const result = runLiveScoringDeterministicSimulator();

    expect(result.passed).toBe(true);
    expect(result.passedCount).toBe(result.totalCount);
    expect(result.totalCount).toBe(11);
  });
});
