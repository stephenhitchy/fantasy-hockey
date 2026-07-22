import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from 'firebase/firestore';

import { auth, db } from '../firebase';
import {
  CURRENT_SCORING_RULES_VERSION,
  defaultScoringRules,
  ScoringRules,
} from '../scoring/scoring-rules';
import { getLeagueTeams } from '../team/team.service';
import { createEmptyFantasyRoster, getFantasyRosterRef } from '../team/roster.service';

export interface League {
  id: string;
  name: string;
  commissionerId: string;
  inviteCode: string;
  maxTeams: number;
  matchupFormat: string;
  scoringRules: ScoringRules;
  scoringRulesVersion?: number;
  createdAt?: unknown;
}

export interface LeagueInvite {
  inviteCode: string;
  leagueId: string;
  createdBy: string;
  active: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
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

const INVITE_CODE_LENGTH = 6;
const INVITE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_INVITE_CODE_ATTEMPTS = 20;

function normalizeLeagueScoringRules(league: Partial<League>): League {
  const storedRules = league.scoringRules;

  const normalizedRules: ScoringRules = {
    ...defaultScoringRules,
    ...(storedRules ?? {}),
    forward: {
      ...defaultScoringRules.forward,
      ...(storedRules?.forward ?? {}),
      goal: {
        ...defaultScoringRules.forward.goal,
        ...(storedRules?.forward?.goal ?? {}),
      },
      primaryAssist: {
        ...defaultScoringRules.forward.primaryAssist,
        ...(storedRules?.forward?.primaryAssist ?? {}),
      },
      secondaryAssist: {
        ...defaultScoringRules.forward.secondaryAssist,
        ...(storedRules?.forward?.secondaryAssist ?? {}),
      },
    },
    defense: {
      ...defaultScoringRules.defense,
      ...(storedRules?.defense ?? {}),
      goal: {
        ...defaultScoringRules.defense.goal,
        ...(storedRules?.defense?.goal ?? {}),
      },
      primaryAssist: {
        ...defaultScoringRules.defense.primaryAssist,
        ...(storedRules?.defense?.primaryAssist ?? {}),
      },
      secondaryAssist: {
        ...defaultScoringRules.defense.secondaryAssist,
        ...(storedRules?.defense?.secondaryAssist ?? {}),
      },
    },
  };

  /*
   * Scoring V3 preserves the forward identity while giving defensemen a more
   * dependable floor and replacing goalie save-percentage cliffs with a
   * continuous scoring-environment-relative quality curve. Upgrade older
   * league documents in memory so existing leagues and new leagues calculate
   * points identically without rewriting historical cycle-window data.
   */
  if (
    typeof league.scoringRulesVersion !== 'number' ||
    league.scoringRulesVersion < CURRENT_SCORING_RULES_VERSION
  ) {
    normalizedRules.defense = {
      ...defaultScoringRules.defense,
      goal: { ...defaultScoringRules.defense.goal },
      primaryAssist: { ...defaultScoringRules.defense.primaryAssist },
      secondaryAssist: { ...defaultScoringRules.defense.secondaryAssist },
    };
    normalizedRules.defenseToiBaseMultiplier = defaultScoringRules.defenseToiBaseMultiplier;
    normalizedRules.defenseToiPlusMinusModifier = defaultScoringRules.defenseToiPlusMinusModifier;
    normalizedRules.defenseToiFloor = defaultScoringRules.defenseToiFloor;
    normalizedRules.defenseToiCeiling = defaultScoringRules.defenseToiCeiling;

    normalizedRules.goalieGameBase = defaultScoringRules.goalieGameBase;
    normalizedRules.goalieSave = defaultScoringRules.goalieSave;
    normalizedRules.goalieWin = defaultScoringRules.goalieWin;
    normalizedRules.goalieShutout = defaultScoringRules.goalieShutout;
    normalizedRules.goalieSavePercentageBaseline =
      defaultScoringRules.goalieSavePercentageBaseline;
    normalizedRules.goalieSavePercentageBasePoints =
      defaultScoringRules.goalieSavePercentageBasePoints;
    normalizedRules.goalieSavePercentagePointsPerPercentagePoint =
      defaultScoringRules.goalieSavePercentagePointsPerPercentagePoint;
    normalizedRules.goalieSavePercentageMinimum =
      defaultScoringRules.goalieSavePercentageMinimum;
    normalizedRules.goalieSavePercentageMaximum =
      defaultScoringRules.goalieSavePercentageMaximum;
    normalizedRules.goalieSavePercentageTiers = defaultScoringRules.goalieSavePercentageTiers.map(
      (tier) => ({ ...tier }),
    );
    normalizedRules.goalieGameMaximum = defaultScoringRules.goalieGameMaximum;
  }

  return {
    id: league.id ?? '',
    name: league.name ?? '',
    commissionerId: league.commissionerId ?? '',
    inviteCode: league.inviteCode ?? '',
    maxTeams: typeof league.maxTeams === 'number' ? league.maxTeams : 2,
    matchupFormat: league.matchupFormat ?? 'cycle_matchup',
    scoringRules: normalizedRules,
    scoringRulesVersion: CURRENT_SCORING_RULES_VERSION,
    createdAt: league.createdAt,
  };
}

function normalizeInviteCode(inviteCode: string): string {
  return inviteCode.trim().toUpperCase();
}

function normalizeUsername(username: string): string {
  const trimmedUsername = username.trim();

  return trimmedUsername || 'Unknown User';
}

function createInviteCodeCandidate(): string {
  const values = new Uint32Array(INVITE_CODE_LENGTH);

  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(values);
  } else {
    for (let index = 0; index < values.length; index += 1) {
      values[index] = Math.floor(Math.random() * 0xffffffff);
    }
  }

  return Array.from(
    values,
    (value) => INVITE_CODE_ALPHABET[value % INVITE_CODE_ALPHABET.length],
  ).join('');
}

function getLeagueInviteRef(inviteCode: string) {
  return doc(db, 'leagueInvites', normalizeInviteCode(inviteCode));
}

function getLeagueRef(leagueId: string) {
  return doc(db, 'leagues', leagueId);
}

function getLeagueMemberRef(leagueId: string, userId: string) {
  return doc(db, 'leagues', leagueId, 'members', userId);
}

function getLeagueTeamRef(leagueId: string, ownerId: string) {
  return doc(db, 'leagues', leagueId, 'teams', ownerId);
}

function getNewTeamDocument(ownerId: string, defaultTeamName: string) {
  return {
    id: ownerId,
    ownerId,
    teamName: normalizeUsername(defaultTeamName),
    logo: '',
    wins: 0,
    losses: 0,
    ties: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    waiverPriority: 1,
    draftPosition: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function getNewRosterDocument() {
  const roster = createEmptyFantasyRoster();

  return {
    schemaVersion: roster.schemaVersion,
    activeSlots: roster.activeSlots,
    benchSlots: roster.benchSlots,
    irSlots: roster.irSlots,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

async function createUniqueInviteCode(): Promise<string> {
  for (let attempt = 0; attempt < MAX_INVITE_CODE_ATTEMPTS; attempt += 1) {
    const inviteCode = createInviteCodeCandidate();
    const inviteSnapshot = await getDoc(getLeagueInviteRef(inviteCode));

    if (!inviteSnapshot.exists()) {
      return inviteCode;
    }
  }

  throw new Error('Unable to generate a unique league invite code. Please try again.');
}

async function createLeagueInviteDocument(league: League): Promise<void> {
  const inviteCode = normalizeInviteCode(league.inviteCode);

  if (!inviteCode) {
    throw new Error('This league does not have a valid invite code.');
  }

  const inviteRef = getLeagueInviteRef(inviteCode);
  const inviteSnapshot = await getDoc(inviteRef);

  if (inviteSnapshot.exists()) {
    const existingInvite = inviteSnapshot.data() as Partial<LeagueInvite>;

    if (existingInvite.leagueId && existingInvite.leagueId !== league.id) {
      throw new Error('This invite code is already assigned to another league.');
    }

    return;
  }

  await setDoc(inviteRef, {
    inviteCode,
    leagueId: league.id,
    createdBy: league.commissionerId,
    active: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  } satisfies LeagueInvite);
}

async function ensureCommissionerInviteDocuments(leagues: League[], userId: string): Promise<void> {
  const commissionerLeagues = leagues.filter((league) => league.commissionerId === userId);

  await Promise.all(commissionerLeagues.map((league) => createLeagueInviteDocument(league)));
}

function getLeagueIdFromMembershipPath(membershipPath: string): string | null {
  const pathParts = membershipPath.split('/');
  const leaguesIndex = pathParts.lastIndexOf('leagues');

  if (leaguesIndex < 0 || pathParts.length <= leaguesIndex + 1) {
    return null;
  }

  return pathParts[leaguesIndex + 1] || null;
}

export async function createLeague(
  name: string,
  maxTeams: number,
  username: string,
): Promise<string> {
  const user = auth.currentUser;

  if (!user) {
    throw new Error('You must be logged in to create a league.');
  }

  const trimmedName = name.trim();

  if (!trimmedName) {
    throw new Error('Please enter a league name.');
  }

  if (!Number.isInteger(maxTeams) || maxTeams < 2 || maxTeams > 12) {
    throw new Error('League size must be between 2 and 12 teams.');
  }

  const leagueRef = doc(collection(db, 'leagues'));
  const inviteCode = await createUniqueInviteCode();
  const inviteRef = getLeagueInviteRef(inviteCode);
  const memberRef = getLeagueMemberRef(leagueRef.id, user.uid);
  const teamRef = getLeagueTeamRef(leagueRef.id, user.uid);
  const rosterRef = getFantasyRosterRef(leagueRef.id, user.uid);
  const normalizedUsername = normalizeUsername(username);

  const league: League = {
    id: leagueRef.id,
    name: trimmedName,
    commissionerId: user.uid,
    inviteCode,
    maxTeams,
    matchupFormat: 'cycle_matchup',
    scoringRules: defaultScoringRules,
    scoringRulesVersion: CURRENT_SCORING_RULES_VERSION,
  };

  const batch = writeBatch(db);

  batch.set(leagueRef, {
    ...league,
    createdAt: serverTimestamp(),
  });

  batch.set(inviteRef, {
    inviteCode,
    leagueId: leagueRef.id,
    createdBy: user.uid,
    active: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  } satisfies LeagueInvite);

  batch.set(memberRef, {
    uid: user.uid,
    leagueId: leagueRef.id,
    username: normalizedUsername,
    role: 'commissioner',
    inviteCodeUsed: null,
    joinedAt: serverTimestamp(),
  });

  batch.set(teamRef, getNewTeamDocument(user.uid, normalizedUsername));
  batch.set(rosterRef, getNewRosterDocument());

  await batch.commit();

  return leagueRef.id;
}

export async function getMyLeagues(): Promise<League[]> {
  const user = auth.currentUser;

  if (!user) {
    return [];
  }

  const membershipsQuery = query(collectionGroup(db, 'members'), where('uid', '==', user.uid));

  const membershipSnapshot = await getDocs(membershipsQuery);
  const leagueIds: string[] = Array.from(
    new Set<string>(
      membershipSnapshot.docs
        .map((membershipDocument) => getLeagueIdFromMembershipPath(membershipDocument.ref.path))
        .filter((leagueId): leagueId is string => Boolean(leagueId)),
    ),
  );

  const leagueSnapshots = await Promise.all(
    leagueIds.map((leagueId) => getDoc(getLeagueRef(leagueId))),
  );

  const leagues = leagueSnapshots
    .filter((leagueSnapshot) => leagueSnapshot.exists())
    .map((leagueSnapshot) => normalizeLeagueScoringRules(leagueSnapshot.data() as Partial<League>))
    .sort((first, second) => first.name.localeCompare(second.name));

  return leagues;
}

export async function getLeagueById(leagueId: string): Promise<League | null> {
  const leagueSnapshot = await getDoc(getLeagueRef(leagueId));

  if (!leagueSnapshot.exists()) {
    return null;
  }

  const league = normalizeLeagueScoringRules(leagueSnapshot.data() as Partial<League>);
  const user = auth.currentUser;

  if (user?.uid === league.commissionerId) {
    await createLeagueInviteDocument(league);
  }

  return league;
}

export async function getMyLeagueSummaries(): Promise<LeagueSummary[]> {
  const user = auth.currentUser;

  if (!user) {
    return [];
  }

  const leagues = await getMyLeagues();

  // Team collections are independent, so fetch them together instead of
  // paying one mobile network round trip per league in sequence.
  return Promise.all(
    leagues.map(async (league): Promise<LeagueSummary> => {
      const teams = await getLeagueTeams(league.id);
      const myTeam = teams.find((team) => team.ownerId === user.uid);

      return {
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
          points: 0,
        },
        topDefensivePlayer: {
          name: 'TBD',
          teamLogo: '🛡️',
          points: 0,
        },
        topGoalie: {
          name: 'TBD',
          teamLogo: '🥅',
          points: 0,
        },
      };
    }),
  );
}

export async function joinLeagueByInviteCode(
  inviteCode: string,
  username: string,
): Promise<string> {
  const user = auth.currentUser;

  if (!user) {
    throw new Error('You must be logged in to join a league.');
  }

  const normalizedInviteCode = normalizeInviteCode(inviteCode);

  if (!normalizedInviteCode) {
    throw new Error('Please enter a league invite code.');
  }

  const inviteRef = getLeagueInviteRef(normalizedInviteCode);
  const inviteSnapshot = await getDoc(inviteRef);

  if (!inviteSnapshot.exists()) {
    throw new Error('No league found with that invite code.');
  }

  const invite = inviteSnapshot.data() as LeagueInvite;

  if (!invite.active || !invite.leagueId || invite.inviteCode !== normalizedInviteCode) {
    throw new Error('This league invite is no longer active.');
  }

  const leagueId = invite.leagueId;
  const leagueRef = getLeagueRef(leagueId);
  const memberRef = getLeagueMemberRef(leagueId, user.uid);
  const teamRef = getLeagueTeamRef(leagueId, user.uid);
  const rosterRef = getFantasyRosterRef(leagueId, user.uid);
  const normalizedUsername = normalizeUsername(username);

  // A user may always check their own membership document. If it exists,
  // they already belong to the league and can safely read the league-owned
  // documents needed to repair any legacy partial setup.
  const existingMemberSnapshot = await getDoc(memberRef);

  if (existingMemberSnapshot.exists()) {
    const [leagueSnapshot, existingTeamSnapshot, existingRosterSnapshot] = await Promise.all([
      getDoc(leagueRef),
      getDoc(teamRef),
      getDoc(rosterRef),
    ]);

    if (!leagueSnapshot.exists()) {
      throw new Error('This league no longer exists.');
    }

    const league = normalizeLeagueScoringRules(leagueSnapshot.data() as Partial<League>);

    if (league.inviteCode !== normalizedInviteCode) {
      throw new Error('This invite code does not match the league.');
    }

    const repairBatch = writeBatch(db);
    let repairNeeded = false;

    if (!existingTeamSnapshot.exists()) {
      repairBatch.set(teamRef, getNewTeamDocument(user.uid, normalizedUsername));
      repairNeeded = true;
    }

    if (!existingRosterSnapshot.exists()) {
      repairBatch.set(rosterRef, getNewRosterDocument());
      repairNeeded = true;
    }

    if (repairNeeded) {
      await repairBatch.commit();
    }

    return leagueId;
  }

  // New joins are atomic: membership, team, and roster are created together.
  // The security rules validate the invite and confirm the league exists.
  // If any write is rejected, none of these documents are created.
  const joinBatch = writeBatch(db);

  joinBatch.set(memberRef, {
    uid: user.uid,
    leagueId,
    username: normalizedUsername,
    role: 'member',
    inviteCodeUsed: normalizedInviteCode,
    joinedAt: serverTimestamp(),
  });

  joinBatch.set(teamRef, getNewTeamDocument(user.uid, normalizedUsername));
  joinBatch.set(rosterRef, getNewRosterDocument());

  await joinBatch.commit();

  return leagueId;
}
