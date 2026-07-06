import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { getDoc, updateDoc } from 'firebase/firestore';
import { collection, getDocs } from 'firebase/firestore';

export async function createFantasyTeam(
  leagueId: string,
  ownerId: string
) {
  const teamRef = doc(db, 'leagues', leagueId, 'teams', ownerId);

  await setDoc(teamRef, {
    id: ownerId,
    ownerId,
    teamName: 'Unnamed Team',
    logo: '',
    wins: 0,
    losses: 0,
    ties: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    waiverPriority: 1,
    draftPosition: null,
    createdAt: serverTimestamp()
  });
}

export interface FantasyTeam {
  id: string;
  ownerId: string;
  teamName: string;
  logo: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  waiverPriority: number;
  draftPosition: number | null;
}

export async function getFantasyTeam(
  leagueId: string,
  ownerId: string
): Promise<FantasyTeam | null> {

  const teamRef = doc(db, 'leagues', leagueId, 'teams', ownerId);

  const snapshot = await getDoc(teamRef);

  if (!snapshot.exists()) {
    return null;
  }

  return snapshot.data() as FantasyTeam;
}

export async function updateTeamName(
  leagueId: string,
  ownerId: string,
  teamName: string
) {

  const teamRef = doc(db, 'leagues', leagueId, 'teams', ownerId);

  await updateDoc(teamRef, {
    teamName
  });

}

export async function getLeagueTeams(leagueId: string): Promise<FantasyTeam[]> {
  const teamsRef = collection(db, 'leagues', leagueId, 'teams');
  const snapshot = await getDocs(teamsRef);

  return snapshot.docs.map(doc => doc.data() as FantasyTeam);
}