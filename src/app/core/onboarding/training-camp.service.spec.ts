import {
  CURRENT_TRAINING_CAMP_VERSION,
  hasCompletedTrainingCamp,
} from './training-camp.service';

describe('training camp progress', () => {
  it('treats missing or older progress as incomplete', () => {
    expect(hasCompletedTrainingCamp(null)).toBe(false);
    expect(hasCompletedTrainingCamp({ trainingCampVersion: 0 } as never)).toBe(false);
  });

  it('recognizes the current training camp version', () => {
    expect(
      hasCompletedTrainingCamp({ trainingCampVersion: CURRENT_TRAINING_CAMP_VERSION } as never),
    ).toBe(true);
  });
});
