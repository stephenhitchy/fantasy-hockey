import { describe, expect, it } from 'vitest';
import { runWindowProjectionDeterministicSimulator } from './window-projection-simulator';

describe('window projection deterministic simulator', () => {
  it('passes every independent-window projection check', () => {
    const result = runWindowProjectionDeterministicSimulator();

    expect(result.totalCount).toBe(10);
    expect(result.passedCount).toBe(10);
    expect(result.passed).toBe(true);
    expect(result.checks.filter((entry) => !entry.passed)).toEqual([]);
  });
});
