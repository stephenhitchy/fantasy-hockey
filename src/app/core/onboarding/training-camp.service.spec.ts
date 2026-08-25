import {
  CURRENT_TRAINING_CAMP_VERSION,
  hasCompletedTrainingCamp,
  hasDeferredTrainingCamp,
  hasResolvedTrainingCampOnboarding,
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

  it('keeps a deliberate finish-later choice separate from completion', () => {
    const deferredProfile = {
      trainingCampVersion: 0,
      trainingCampDeferredVersion: CURRENT_TRAINING_CAMP_VERSION,
    } as never;

    expect(hasCompletedTrainingCamp(deferredProfile)).toBe(false);
    expect(hasDeferredTrainingCamp(deferredProfile)).toBe(true);
    expect(hasResolvedTrainingCampOnboarding(deferredProfile)).toBe(true);
  });

  it('does not release onboarding until completion or an explicit deferral', () => {
    expect(hasResolvedTrainingCampOnboarding(null)).toBe(false);
    expect(
      hasResolvedTrainingCampOnboarding({
        trainingCampVersion: 0,
        trainingCampDeferredVersion: 0,
      } as never),
    ).toBe(false);
    expect(
      hasResolvedTrainingCampOnboarding({
        trainingCampVersion: CURRENT_TRAINING_CAMP_VERSION,
      } as never),
    ).toBe(true);
  });
});
