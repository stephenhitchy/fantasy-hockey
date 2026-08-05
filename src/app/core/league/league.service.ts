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
import { httpsCallable } from 'firebase/functions';

import { auth, db } from '../firebase';
import { functions } from '../firebase-functions';
import {
  CURRENT_SCORING_RULES_VERSION,
  defaultScoringRules,
  ScoringRules,
} from '../scoring/scoring-rules';
import { getLeagueTeams } from '../team/team.service';
import { ensureFantasyRoster } from '../transactions/roster-authority.service';
import type { DashboardLeagueActivity } from './dashboard-league-activity.models';
import {
  DEFAULT_LEAGUE_LOGO_ID,
  DEFAULT_LEAGUE_LOGO_PALETTE_ID,
  LeagueLogoId,
  LeagueLogoPaletteId,
  normalizeLeagueLogoId,
  normalizeLeagueLogoPaletteId,
} from '../../shared/league-logo/league-logo.data';
import {
  getProfileIcon,
  getRandomProfileIconId,
  getSeededProfileIconId,
  isProfileIconId,
  ProfileIconId,
} from '../../shared/profile-icon/profile-icon.data';

export interface League {
  id: string;
  name: string;
  leagueLogoId: LeagueLogoId;
  leagueLogoPaletteId: LeagueLogoPaletteId;
  commissionerId: string;
  inviteCode: string;
  maxTeams: number;
  matchupFormat: string;
  scoringRules: ScoringRules;
  scoringRulesVersion?: number;
  createdAt?: unknown;
}

export interface LeagueMember {
  uid: string;
  leagueId: string;
  username: string;
  profileIconId?: ProfileIconId;
  role: 'commissioner' | 'member';
  inviteCodeUsed: string | null;
  joinedAt?: unknown;
}

export interface LeagueInvite {
  inviteCode: string;
  leagueId: string;
  createdBy: string;
  active: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

interface DeleteLeagueRequest {
  leagueId: string;
  confirmationName: string;
}

interface DeleteLeagueResponse {
  deleted: boolean;
  leagueId: string;
}

export interface LeagueSummary {
  leagueId: string;
  leagueName: string;
  leagueLogoId: LeagueLogoId;
  leagueLogoPaletteId: LeagueLogoPaletteId;
  inviteCode: string;
  myTeamName: string;
  teamCount: number;
  maxTeams: number;

  isCommissioner: boolean;
  wins: number;
  losses: number;
  ties: number;
  dashboardActivity?: DashboardLeagueActivity;

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
    leagueLogoId: normalizeLeagueLogoId(league.leagueLogoId),
    leagueLogoPaletteId: normalizeLeagueLogoPaletteId(league.leagueLogoPaletteId),
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

function getNewTeamDocument(
  ownerId: string,
  defaultTeamName: string,
  profileIconId: ProfileIconId,
) {
  const managerName = normalizeUsername(defaultTeamName);

  return {
    id: ownerId,
    ownerId,
    teamName: managerName,
    managerName,
    profileIconId: getProfileIcon(profileIconId).id,
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
  leagueLogoId: LeagueLogoId = DEFAULT_LEAGUE_LOGO_ID,
  leagueLogoPaletteId: LeagueLogoPaletteId = DEFAULT_LEAGUE_LOGO_PALETTE_ID,
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
  const normalizedUsername = normalizeUsername(username);
  const normalizedProfileIconId = getRandomProfileIconId();

  const league: League = {
    id: leagueRef.id,
    name: trimmedName,
    leagueLogoId: normalizeLeagueLogoId(leagueLogoId),
    leagueLogoPaletteId: normalizeLeagueLogoPaletteId(leagueLogoPaletteId),
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
    profileIconId: normalizedProfileIconId,
    role: 'commissioner',
    inviteCodeUsed: null,
    joinedAt: serverTimestamp(),
  });

  batch.set(
    teamRef,
    getNewTeamDocument(user.uid, normalizedUsername, normalizedProfileIconId),
  );
  await batch.commit();

  // Firestore rules intentionally deny browser-created roster documents.
  // Initialize the commissioner roster through the authenticated server
  // authority after the league, member, and team records exist. If this
  // transient follow-up fails, roster pages retry the same callable lazily.
  try {
    await ensureFantasyRoster(leagueRef.id);
  } catch (error) {
    console.warn('League created; roster initialization will retry when needed.', error);
  }

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

export async function deleteLeaguePermanently(
  leagueId: string,
  confirmationName: string,
): Promise<void> {
  const user = auth.currentUser;

  if (!user) {
    throw new Error('You must be logged in to delete a league.');
  }

  const normalizedLeagueId = leagueId.trim();
  const normalizedConfirmationName = confirmationName.trim();

  if (!normalizedLeagueId) {
    throw new Error('This league is still loading.');
  }

  if (!normalizedConfirmationName) {
    throw new Error('Type the full league name before deleting it.');
  }

  const callable = httpsCallable<DeleteLeagueRequest, DeleteLeagueResponse>(
    functions,
    'deleteLeague',
    { timeout: 600_000 },
  );

  try {
    const result = await callable({
      leagueId: normalizedLeagueId,
      confirmationName: normalizedConfirmationName,
    });

    if (!result.data.deleted || result.data.leagueId !== normalizedLeagueId) {
      throw new Error('The server could not confirm that the league was deleted.');
    }
  } catch (error: unknown) {
    const record = error && typeof error === 'object'
      ? error as { code?: unknown; message?: unknown }
      : {};
    const code = typeof record.code === 'string' ? record.code : '';
    const rawMessage = typeof record.message === 'string' ? record.message.trim() : '';
    const message = rawMessage
      .replace(/^FirebaseError:\s*/i, '')
      .replace(/^\[functions\/[^\]]+\]\s*/i, '')
      .trim();

    if (message) {
      throw new Error(message);
    }

    if (code.includes('permission-denied')) {
      throw new Error('Only the league commissioner can permanently delete this league.');
    }

    if (code.includes('failed-precondition')) {
      throw new Error('The confirmation name did not exactly match the league name.');
    }

    if (code.includes('not-found')) {
      throw new Error('This league no longer exists.');
    }

    throw new Error('The league could not be deleted. Please try again.');
  }
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

export async function getMyLeagueSummaries(
  options: { includeDashboardActivity?: boolean } = {},
): Promise<LeagueSummary[]> {
  const user = auth.currentUser;

  if (!user) {
    return [];
  }

  const leagues = await getMyLeagues();
  const dashboardActivityModule = options.includeDashboardActivity
    ? import('./dashboard-league-activity.service')
    : null;

  // Team collections are independent, so fetch them together instead of
  // paying one mobile network round trip per league in sequence.
  return Promise.all(
    leagues.map(async (league): Promise<LeagueSummary> => {
      const teams = await getLeagueTeams(league.id);
      const myTeam = teams.find((team) => team.ownerId === user.uid);

      const isCommissioner = league.commissionerId === user.uid;
      const dashboardActivity = dashboardActivityModule
        ? await (await dashboardActivityModule).getDashboardLeagueActivity({
            leagueId: league.id,
            ownerId: user.uid,
            isCommissioner,
            teamCount: teams.length,
            maxTeams: league.maxTeams,
            teams,
          })
        : undefined;

      return {
        leagueId: league.id,
        leagueName: league.name,
        leagueLogoId: league.leagueLogoId,
        leagueLogoPaletteId: league.leagueLogoPaletteId,
        inviteCode: league.inviteCode,
        myTeamName: myTeam?.teamName ?? 'Unnamed Team',
        teamCount: teams.length,
        maxTeams: league.maxTeams,
        isCommissioner,
        wins: myTeam?.wins ?? 0,
        losses: myTeam?.losses ?? 0,
        ties: myTeam?.ties ?? 0,
        dashboardActivity,
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
  const normalizedUsername = normalizeUsername(username);
  const existingMemberSnapshot = await getDoc(memberRef);

  if (existingMemberSnapshot.exists()) {
    const [leagueSnapshot, existingTeamSnapshot] = await Promise.all([
      getDoc(leagueRef),
      getDoc(teamRef),
    ]);

    if (!leagueSnapshot.exists()) {
      throw new Error('This league no longer exists.');
    }

    const league = normalizeLeagueScoringRules(leagueSnapshot.data() as Partial<League>);

    if (league.inviteCode !== normalizedInviteCode) {
      throw new Error('This invite code does not match the league.');
    }

    const existingMember = existingMemberSnapshot.data() as Partial<LeagueMember>;
    const existingTeam = existingTeamSnapshot.exists()
      ? (existingTeamSnapshot.data() as Partial<{
          managerName: string;
          profileIconId: ProfileIconId;
        }>)
      : null;
    const resolvedProfileIconId = isProfileIconId(existingTeam?.profileIconId)
      ? existingTeam.profileIconId
      : isProfileIconId(existingMember.profileIconId)
        ? existingMember.profileIconId
        : getRandomProfileIconId();

    const repairBatch = writeBatch(db);
    let repairNeeded = false;

    if (!existingTeamSnapshot.exists()) {
      repairBatch.set(
        teamRef,
        getNewTeamDocument(user.uid, normalizedUsername, resolvedProfileIconId),
      );
      repairNeeded = true;
    } else {
      const teamPatch: Record<string, unknown> = {};

      if (existingTeam?.managerName !== normalizedUsername) {
        teamPatch['managerName'] = normalizedUsername;
      }

      if (existingTeam?.profileIconId !== resolvedProfileIconId) {
        teamPatch['profileIconId'] = resolvedProfileIconId;
      }

      if (Object.keys(teamPatch).length > 0) {
        repairBatch.set(
          teamRef,
          {
            ...teamPatch,
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );
        repairNeeded = true;
      }
    }

    if (
      existingMember.username !== normalizedUsername ||
      existingMember.profileIconId !== resolvedProfileIconId
    ) {
      repairBatch.set(
        memberRef,
        {
          username: normalizedUsername,
          profileIconId: resolvedProfileIconId,
        },
        { merge: true },
      );
      repairNeeded = true;
    }

    if (repairNeeded) {
      await repairBatch.commit();
    }

    // Existing or repaired memberships use the same server-owned roster
    // initializer. This also repairs legacy accounts that predate schema v2.
    await ensureFantasyRoster(leagueId);

    return leagueId;
  }

  // A new league membership gets its own random identity. The icon is stored
  // on the league member/team documents and is independent from every other
  // league this account belongs to.
  const profileIconId = getRandomProfileIconId();
  const joinBatch = writeBatch(db);

  joinBatch.set(memberRef, {
    uid: user.uid,
    leagueId,
    username: normalizedUsername,
    profileIconId,
    role: 'member',
    inviteCodeUsed: normalizedInviteCode,
    joinedAt: serverTimestamp(),
  });

  joinBatch.set(
    teamRef,
    getNewTeamDocument(user.uid, normalizedUsername, profileIconId),
  );

  await joinBatch.commit();
  await ensureFantasyRoster(leagueId);

  return leagueId;
}

export async function ensureLeagueProfileIcon(
  leagueId: string,
): Promise<ProfileIconId> {
  const user = auth.currentUser;

  if (!user || !leagueId) {
    throw new Error('Your league account is still loading.');
  }

  const memberRef = getLeagueMemberRef(leagueId, user.uid);
  const teamRef = getLeagueTeamRef(leagueId, user.uid);
  const [memberSnapshot, teamSnapshot] = await Promise.all([
    getDoc(memberRef),
    getDoc(teamRef),
  ]);

  const memberData = memberSnapshot.exists()
    ? (memberSnapshot.data() as Partial<LeagueMember>)
    : null;
  const teamData = teamSnapshot.exists()
    ? (teamSnapshot.data() as Partial<{ profileIconId: ProfileIconId }>)
    : null;
  const resolvedProfileIconId = isProfileIconId(teamData?.profileIconId)
    ? teamData.profileIconId
    : isProfileIconId(memberData?.profileIconId)
      ? memberData.profileIconId
      : getRandomProfileIconId();

  if (
    memberData?.profileIconId === resolvedProfileIconId &&
    teamData?.profileIconId === resolvedProfileIconId
  ) {
    return resolvedProfileIconId;
  }

  const batch = writeBatch(db);

  batch.set(
    memberRef,
    { profileIconId: resolvedProfileIconId },
    { merge: true },
  );
  batch.set(
    teamRef,
    {
      profileIconId: resolvedProfileIconId,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  await batch.commit();

  return resolvedProfileIconId;
}

export async function syncManagerNameForLeague(
  leagueId: string,
  username: string,
): Promise<void> {
  const user = auth.currentUser;

  if (!user || !leagueId) {
    return;
  }

  const normalizedUsername = normalizeUsername(username);
  const batch = writeBatch(db);

  batch.set(
    getLeagueMemberRef(leagueId, user.uid),
    { username: normalizedUsername },
    { merge: true },
  );

  batch.set(
    getLeagueTeamRef(leagueId, user.uid),
    {
      managerName: normalizedUsername,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  await batch.commit();
}

export async function syncManagerNameAcrossLeagues(username: string): Promise<void> {
  const user = auth.currentUser;

  if (!user) {
    return;
  }

  const normalizedUsername = normalizeUsername(username);
  const leagues = await getMyLeagues();

  for (let startIndex = 0; startIndex < leagues.length; startIndex += 200) {
    const batch = writeBatch(db);
    const leagueChunk = leagues.slice(startIndex, startIndex + 200);

    for (const league of leagueChunk) {
      batch.set(
        getLeagueMemberRef(league.id, user.uid),
        { username: normalizedUsername },
        { merge: true },
      );
      batch.set(
        getLeagueTeamRef(league.id, user.uid),
        {
          managerName: normalizedUsername,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    }

    await batch.commit();
  }
}

export async function updateLeagueProfileIcon(
  leagueId: string,
  profileIconId: ProfileIconId,
): Promise<void> {
  const user = auth.currentUser;

  if (!user || !leagueId) {
    throw new Error('Your league account is still loading.');
  }

  const normalizedProfileIconId = getProfileIcon(profileIconId).id;
  const batch = writeBatch(db);

  batch.set(
    getLeagueMemberRef(leagueId, user.uid),
    { profileIconId: normalizedProfileIconId },
    { merge: true },
  );
  batch.set(
    getLeagueTeamRef(leagueId, user.uid),
    {
      profileIconId: normalizedProfileIconId,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  await batch.commit();
}

export function getLeagueIdentityProfileIconId(
  ownerId: string,
  storedProfileIconId?: string | null,
): ProfileIconId {
  return getProfileIcon(storedProfileIconId ?? getSeededProfileIconId(ownerId)).id;
}
