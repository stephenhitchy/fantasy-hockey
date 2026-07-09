import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc
} from 'firebase/firestore';

import { db } from '../firebase';
import { getOrCreateFantasyRoster } from './roster.service';

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
  createdAt?: unknown;
  updatedAt?: unknown;
}

export async function createFantasyTeam(
  leagueId: string,
  ownerId: string
): Promise<void> {
  const teamRef = doc(db, 'leagues', leagueId, 'teams', ownerId);
  const existingTeam = await getDoc(teamRef);

  if (!existingTeam.exists()) {
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
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  }

  await getOrCreateFantasyRoster(leagueId, ownerId);
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
): Promise<void> {
  const teamRef = doc(db, 'leagues', leagueId, 'teams', ownerId);

  await updateDoc(teamRef, {
    teamName,
    updatedAt: serverTimestamp()
  });
}

export async function getLeagueTeams(
  leagueId: string
): Promise<FantasyTeam[]> {
  const teamsRef = collection(db, 'leagues', leagueId, 'teams');
  const snapshot = await getDocs(teamsRef);

  return snapshot.docs.map((teamDoc) => teamDoc.data() as FantasyTeam);
}

export function listenToLeagueTeams(
  leagueId: string,
  callback: (teams: FantasyTeam[]) => void
): () => void {
  const teamsQuery = query(
    collection(db, 'leagues', leagueId, 'teams'),
    orderBy('teamName', 'asc')
  );

  return onSnapshot(teamsQuery, (snapshot) => {
    callback(
      snapshot.docs.map((teamDoc) =>
        teamDoc.data() as FantasyTeam
      )
    );
  });
}
