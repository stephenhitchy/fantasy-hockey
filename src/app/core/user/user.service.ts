import { doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';

export interface UserProfile {
  uid: string;
  email: string;
  username: string;
  createdAt?: unknown;
}

export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  const userRef = doc(db, 'users', uid);
  const userSnap = await getDoc(userRef);

  if (!userSnap.exists()) {
    return null;
  }

  return userSnap.data() as UserProfile;
}