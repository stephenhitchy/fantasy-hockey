import { deleteField, doc, serverTimestamp, updateDoc } from 'firebase/firestore';

import { db } from '../firebase';
import type { UserProfile } from '../user/user.service';

export const CURRENT_TRAINING_CAMP_VERSION = 1;

export function hasCompletedTrainingCamp(profile: UserProfile | null | undefined): boolean {
  return (profile?.trainingCampVersion ?? 0) >= CURRENT_TRAINING_CAMP_VERSION;
}

export function hasDeferredTrainingCamp(profile: UserProfile | null | undefined): boolean {
  return (profile?.trainingCampDeferredVersion ?? 0) >= CURRENT_TRAINING_CAMP_VERSION;
}

/**
 * Completing Training Camp is preferred, but a manager may deliberately choose
 * to finish it later. Either explicit outcome is enough to move onboarding to
 * email verification without pretending that a deferred tutorial was completed.
 */
export function hasResolvedTrainingCampOnboarding(
  profile: UserProfile | null | undefined,
): boolean {
  return hasCompletedTrainingCamp(profile) || hasDeferredTrainingCamp(profile);
}

export async function completeTrainingCamp(userId: string): Promise<void> {
  await updateDoc(doc(db, 'users', userId), {
    trainingCampVersion: CURRENT_TRAINING_CAMP_VERSION,
    trainingCampCompletedAt: serverTimestamp(),
    trainingCampDeferredVersion: deleteField(),
    trainingCampDeferredAt: deleteField(),
  });
}

export async function deferTrainingCamp(userId: string): Promise<void> {
  await updateDoc(doc(db, 'users', userId), {
    trainingCampDeferredVersion: CURRENT_TRAINING_CAMP_VERSION,
    trainingCampDeferredAt: serverTimestamp(),
  });
}
