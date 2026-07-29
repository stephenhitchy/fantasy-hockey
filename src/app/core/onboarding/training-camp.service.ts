import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';

import { db } from '../firebase';
import type { UserProfile } from '../user/user.service';

export const CURRENT_TRAINING_CAMP_VERSION = 1;

export function hasCompletedTrainingCamp(profile: UserProfile | null | undefined): boolean {
  return (profile?.trainingCampVersion ?? 0) >= CURRENT_TRAINING_CAMP_VERSION;
}

export async function completeTrainingCamp(userId: string): Promise<void> {
  await updateDoc(doc(db, 'users', userId), {
    trainingCampVersion: CURRENT_TRAINING_CAMP_VERSION,
    trainingCampCompletedAt: serverTimestamp(),
  });
}
