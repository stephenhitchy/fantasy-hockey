import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where
} from 'firebase/firestore';

import { auth, db } from '../firebase';
import { defaultScoringRules, ScoringRules } from '../scoring/scoring-rules';
import { createFantasyTeam } from '../team/team.service';

export interface League {
  id: string;
  name: string;
  commissionerId: string;
  inviteCode: string;
  maxTeams: number;
  matchupFormat: string;
  scoringRules: ScoringRules;
  createdAt?: unknown;
}

function createInviteCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

export async function createLeague(name: string, maxTeams: number, username: string): Promise<string> {
  
  
  const user = auth.currentUser;

  if (!user) {
    throw new Error('You must be logged in to create a league.');
  }

  const leagueRef = doc(collection(db, 'leagues'));
  const inviteCode = createInviteCode();

  await setDoc(leagueRef, {
    id: leagueRef.id,
    name,
    commissionerId: user.uid,
    inviteCode,
    maxTeams,
    matchupFormat: 'cycle_matchup',
    scoringRules: defaultScoringRules,
    createdAt: serverTimestamp()
});

 await setDoc(doc(db, 'leagues', leagueRef.id, 'members', user.uid), {
  uid: user.uid,
  username,
  role: 'commissioner',
  joinedAt: serverTimestamp()
});

await createFantasyTeam(leagueRef.id, user.uid);

return leagueRef.id;

}

export async function getMyLeagues(): Promise<League[]> {
  const user = auth.currentUser;

  if (!user) {
    return [];
  }

  const leaguesRef = collection(db, 'leagues');
  const q = query(leaguesRef, where('commissionerId', '==', user.uid));
  const snapshot = await getDocs(q);

  return snapshot.docs.map(doc => doc.data() as League);
}

export async function getLeagueById(leagueId: string): Promise<League | null> {
  const leagueRef = doc(db, 'leagues', leagueId);
  const leagueSnap = await getDoc(leagueRef);

  if (!leagueSnap.exists()) {
    return null;
  }

  return leagueSnap.data() as League;
}