import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where
} from 'firebase/firestore';
import { createFantasyTeam, getLeagueTeams } from '../team/team.service';
import { auth, db } from '../firebase';
import { defaultScoringRules, ScoringRules } from '../scoring/scoring-rules';

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

export interface LeagueSummary {
  leagueId: string;
  leagueName: string;
  inviteCode: string;
  myTeamName: string;
  teamCount: number;
  maxTeams: number;

  isCommissioner: boolean;

  topOffensivePlayer?: {
    name: string;
    teamLogo: string;
    points: number;
  };
  topDefensivePlayer?: {
    name: string;
    teamLogo: string;
    points: number;
  };
  topGoalie?: {
    name: string;
    teamLogo: string;
    points: number;
  };
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
  const leagueSnapshot = await getDocs(leaguesRef);

  const leagues: League[] = [];

  for (const leagueDoc of leagueSnapshot.docs) {
    const memberRef = doc(db, 'leagues', leagueDoc.id, 'members', user.uid);
    const memberSnap = await getDoc(memberRef);

    if (memberSnap.exists()) {
      leagues.push(leagueDoc.data() as League);
    }
  }

  return leagues;
}

export async function getLeagueById(leagueId: string): Promise<League | null> {
  const leagueRef = doc(db, 'leagues', leagueId);
  const leagueSnap = await getDoc(leagueRef);

  if (!leagueSnap.exists()) {
    return null;
  }

  return leagueSnap.data() as League;
}

export async function getMyLeagueSummaries(): Promise<LeagueSummary[]> {
  const user = auth.currentUser;
  

  if (!user) {
    return [];
  }

  const leagues = await getMyLeagues();
  const summaries: LeagueSummary[] = [];

  for (const league of leagues) {
    const teams = await getLeagueTeams(league.id);
    const myTeam = teams.find(team => team.ownerId === user.uid);

    summaries.push({
      leagueId: league.id,
      leagueName: league.name,
      inviteCode: league.inviteCode,
      myTeamName: myTeam?.teamName ?? 'Unnamed Team',
      teamCount: teams.length,
      maxTeams: league.maxTeams,

      isCommissioner: league.commissionerId === user.uid,

      topOffensivePlayer: {
        name: 'TBD',
        teamLogo: '🏒',
        points: 0
      },
      topDefensivePlayer: {
        name: 'TBD',
        teamLogo: '🛡️',
        points: 0
      },
      topGoalie: {
        name: 'TBD',
        teamLogo: '🥅',
        points: 0
      }
    });
  }

  return summaries;
}

export async function joinLeagueByInviteCode(
  inviteCode: string,
  username: string
): Promise<string> {
  const user = auth.currentUser;

  if (!user) {
    throw new Error('You must be logged in to join a league.');
  }

  const leaguesRef = collection(db, 'leagues');
  const q = query(
    leaguesRef,
    where('inviteCode', '==', inviteCode.trim().toUpperCase())
  );

  const snapshot = await getDocs(q);

  if (snapshot.empty) {
    throw new Error('No league found with that invite code.');
  }

  const leagueDoc = snapshot.docs[0];
  const leagueId = leagueDoc.id;

  await setDoc(doc(db, 'leagues', leagueId, 'members', user.uid), {
    uid: user.uid,
    username,
    role: 'member',
    joinedAt: serverTimestamp()
  });

  await createFantasyTeam(leagueId, user.uid);

  return leagueId;
}