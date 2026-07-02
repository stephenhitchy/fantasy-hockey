import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '../firebase';

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