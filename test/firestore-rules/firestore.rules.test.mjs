import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

import {
  collection,
  deleteField,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';

import {
  createAuthenticatedClient,
  createSignedOutClient,
  deleteSeededDocument,
  expectAllowed,
  expectDenied,
  resetAllEmulators,
  resetFirestoreEmulator,
  seedDocument,
} from './emulator-helpers.mjs';

const LEAGUE_ID = 'rules-fixture-league';
const VALID_ICON = 'emerald-visor';

let commissioner;
let manager;
let opponent;
let outsider;
let signedOut;

function validProfile(client, username) {
  return {
    uid: client.uid,
    email: client.email,
    username,
    favoriteTeamAbbreviation: 'MIN',
    favoriteTeamVariantId: 'home',
    teamIdentityUnlocks: [],
    reducedMotion: false,
    defaultLandingPage: 'dashboard',
    backgroundTheme: 'rink-dark',
    injuryEmailEnabled: false,
    hockeyExperience: 'basic',
    trainingCampVersion: 0,
    profileIconId: VALID_ICON,
  };
}

function validPublicProfile(client, username) {
  return {
    uid: client.uid,
    username,
    favoriteTeamAbbreviation: 'MIN',
    favoriteTeamVariantId: 'home',
    updatedAt: serverTimestamp(),
  };
}

function validRoster(assetPrefix = 'fixture') {
  return {
    schemaVersion: 2,
    activeSlots: Array.from({ length: 14 }, (_, index) => ({
      slotId: `active-${index + 1}`,
      asset: {
        assetKey: `${assetPrefix}-active-${index + 1}`,
      },
    })),
    benchSlots: Array.from({ length: 3 }, (_, index) => ({
      slotId: `bench-${index + 1}`,
      asset: {
        assetKey: `${assetPrefix}-bench-${index + 1}`,
      },
    })),
    irSlots: Array.from({ length: 3 }, (_, index) => ({
      slotId: `ir-${index + 1}`,
      asset: null,
    })),
  };
}

async function seedLeagueFixture() {
  const now = new Date('2026-07-30T15:00:00.000Z');

  await Promise.all([
    seedDocument(`users/${commissioner.uid}`, validProfile(commissioner, 'Commissioner')),
    seedDocument(`users/${manager.uid}`, validProfile(manager, 'Manager')),
    seedDocument(`users/${opponent.uid}`, validProfile(opponent, 'Opponent')),
    seedDocument(`publicProfiles/${commissioner.uid}`, {
      uid: commissioner.uid,
      username: 'Commissioner',
      favoriteTeamAbbreviation: 'MIN',
      favoriteTeamVariantId: 'home',
      updatedAt: now,
    }),
    seedDocument(`publicProfiles/${manager.uid}`, {
      uid: manager.uid,
      username: 'Manager',
      favoriteTeamAbbreviation: 'MIN',
      favoriteTeamVariantId: 'home',
      updatedAt: now,
    }),
    seedDocument(`publicProfiles/${opponent.uid}`, {
      uid: opponent.uid,
      username: 'Opponent',
      favoriteTeamAbbreviation: 'MIN',
      favoriteTeamVariantId: 'home',
      updatedAt: now,
    }),
    seedDocument(`leagues/${LEAGUE_ID}`, {
      id: LEAGUE_ID,
      commissionerId: commissioner.uid,
      name: 'Rules Fixture League',
      inviteCode: 'ABC123',
      maxTeams: 4,
      matchupFormat: 'cycle_matchup',
      scoringRules: {},
    }),
    seedDocument('leagueInvites/ABC123', {
      inviteCode: 'ABC123',
      leagueId: LEAGUE_ID,
      createdBy: commissioner.uid,
      active: true,
    }),
    seedDocument(`leagues/${LEAGUE_ID}/members/${commissioner.uid}`, {
      uid: commissioner.uid,
      leagueId: LEAGUE_ID,
      role: 'commissioner',
      username: 'Commissioner',
      profileIconId: VALID_ICON,
    }),
    seedDocument(`leagues/${LEAGUE_ID}/members/${manager.uid}`, {
      uid: manager.uid,
      leagueId: LEAGUE_ID,
      role: 'member',
      username: 'Manager',
      profileIconId: VALID_ICON,
    }),
    seedDocument(`leagues/${LEAGUE_ID}/members/${opponent.uid}`, {
      uid: opponent.uid,
      leagueId: LEAGUE_ID,
      role: 'member',
      username: 'Opponent',
      profileIconId: VALID_ICON,
    }),
    seedDocument(`leagues/${LEAGUE_ID}/teams/${commissioner.uid}`, {
      id: commissioner.uid,
      ownerId: commissioner.uid,
      teamName: 'Commissioner Team',
      managerName: 'Commissioner',
      profileIconId: VALID_ICON,
      logo: '/assets/test-logo.png',
    }),
    seedDocument(`leagues/${LEAGUE_ID}/teams/${manager.uid}`, {
      id: manager.uid,
      ownerId: manager.uid,
      teamName: 'Manager Team',
      managerName: 'Manager',
      profileIconId: VALID_ICON,
      logo: '/assets/test-logo.png',
    }),
    seedDocument(`leagues/${LEAGUE_ID}/teams/${opponent.uid}`, {
      id: opponent.uid,
      ownerId: opponent.uid,
      teamName: 'Opponent Team',
      managerName: 'Opponent',
      profileIconId: VALID_ICON,
      logo: '/assets/test-logo.png',
    }),
    seedDocument(`leagues/${LEAGUE_ID}/teams/${manager.uid}/roster/current`, validRoster()),
    seedDocument(`leagues/${LEAGUE_ID}/draft/current`, {
      id: 'current',
      status: 'live',
      clockStatus: 'running',
      roundOneOrder: [manager.uid, opponent.uid],
      nextOverallPick: 1,
      draftedAssetKeys: [],
      pickStartedAt: new Date(Date.now() - 5_000),
      currentPickSeconds: 120,
      pickSeconds: 120,
      pausedRemainingSeconds: null,
      clockUpdatedBy: commissioner.uid,
      clockUpdatedAt: now,
      lastPickId: null,
      updatedAt: now,
    }),
    seedDocument(`leagues/${LEAGUE_ID}/draft/current/queues/${manager.uid}`, {
      ownerId: manager.uid,
      assetKeys: [],
      autoDraftEnabled: false,
      consecutiveClockExpirations: 0,
      autoDraftActivatedByTimeout: false,
      updatedAt: now,
    }),
    seedDocument(`leagues/${LEAGUE_ID}/transactions/fixture-transaction`, {
      ownerId: manager.uid,
      type: 'add-drop',
    }),
    seedDocument(`leagues/${LEAGUE_ID}/waivers/fixture-asset`, {
      droppedByOwnerId: manager.uid,
      status: 'active',
      claims: [],
      assetKey: 'fixture-asset',
      asset: { assetKey: 'fixture-asset' },
    }),
    seedDocument(`leagues/${LEAGUE_ID}/cycles/cycle-1`, {
      id: 'cycle-1',
      cycleNumber: 1,
      status: 'active',
    }),
    seedDocument(`leagues/${LEAGUE_ID}/cycles/cycle-1/matchups/matchup-1`, {
      id: 'matchup-1',
      homeOwnerId: manager.uid,
      awayOwnerId: opponent.uid,
    }),
    seedDocument(`leagues/${LEAGUE_ID}/cycles/cycle-1/rosterPicks/pick-1`, {
      id: 'pick-1',
      ownerId: manager.uid,
    }),
    seedDocument(`leagues/${LEAGUE_ID}/cycles/cycle-1/teamWindows/${manager.uid}`, {
      ownerId: manager.uid,
      cycleNumber: 1,
    }),
    seedDocument(`leagues/${LEAGUE_ID}/playoffs/current`, {
      id: 'current',
      status: 'active',
    }),
    seedDocument(`leagues/${LEAGUE_ID}/playoffWindowBanks/${manager.uid}`, {
      ownerId: manager.uid,
    }),
    seedDocument(`leagues/${LEAGUE_ID}/playoffWindowBanks/${manager.uid}/windows/window-1`, {
      id: 'window-1',
      ownerId: manager.uid,
    }),
    seedDocument(`leagues/${LEAGUE_ID}/liveScoring/control`, {
      id: 'control',
      schemaVersion: 2,
      status: 'idle',
      holderClientId: '',
      nextRefreshAt: now,
    }),
    seedDocument(`leagues/${LEAGUE_ID}/playerAvailabilitySync/legacy`, {
      status: 'success',
    }),
  ]);
}

before(async () => {
  await resetAllEmulators();
  commissioner = await createAuthenticatedClient('commissioner');
  manager = await createAuthenticatedClient('manager');
  opponent = await createAuthenticatedClient('opponent');
  outsider = await createAuthenticatedClient('outsider');
  signedOut = createSignedOutClient();
});

beforeEach(async () => {
  await resetFirestoreEmulator();
  await seedLeagueFixture();
});

after(async () => {
  await Promise.all([
    commissioner.cleanup(),
    manager.cleanup(),
    opponent.cleanup(),
    outsider.cleanup(),
    signedOut.cleanup(),
  ]);
});

describe('account profile boundaries', () => {
  test('signed-out users cannot read private or public profiles', async () => {
    await expectDenied(
      getDoc(doc(signedOut.db, 'users', manager.uid)),
      'Signed-out private profile read',
    );
    await expectDenied(
      getDoc(doc(signedOut.db, 'publicProfiles', manager.uid)),
      'Signed-out public profile read',
    );
  });

  test('a signed-in user can create their own valid profile', async () => {
    await expectAllowed(
      setDoc(doc(outsider.db, 'users', outsider.uid), validProfile(outsider, 'Outsider')),
      'Own profile creation',
    );
  });

  test('signed-in users cannot read another manager private profile', async () => {
    await expectDenied(
      getDoc(doc(outsider.db, 'users', manager.uid)),
      'Another manager private profile read',
    );
  });

  test('signed-in users can read a display-safe public profile without email', async () => {
    const snapshot = await getDoc(doc(outsider.db, 'publicProfiles', manager.uid));
    assert.equal(snapshot.exists(), true);
    assert.equal(snapshot.data().username, 'Manager');
    assert.equal(snapshot.data().favoriteTeamAbbreviation, 'MIN');
    assert.equal('email' in snapshot.data(), false);
  });

  test('a user can create their own display-safe public profile', async () => {
    await expectAllowed(
      setDoc(
        doc(outsider.db, 'publicProfiles', outsider.uid),
        validPublicProfile(outsider, 'Outsider'),
      ),
      'Own public profile creation',
    );
  });

  test('an owner can update their private profile to neutral RinkRat colors and a familiarity level', async () => {
    await expectAllowed(
      updateDoc(doc(manager.db, 'users', manager.uid), {
        favoriteTeamAbbreviation: 'RR',
        favoriteTeamVariantId: 'current-home',
        hockeyExperience: 'new',
      }),
      'Neutral identity and hockey familiarity update',
    );
  });

  test('an owner cannot save an unsupported hockey familiarity level', async () => {
    await expectDenied(
      updateDoc(doc(manager.db, 'users', manager.uid), {
        hockeyExperience: 'expert',
      }),
      'Unsupported hockey familiarity update',
    );
  });

  test('an owner can update their own display-safe public profile to the neutral RinkRat identity', async () => {
    await expectAllowed(
      setDoc(doc(manager.db, 'publicProfiles', manager.uid), {
        uid: manager.uid,
        username: 'Manager Updated',
        favoriteTeamAbbreviation: 'RR',
        favoriteTeamVariantId: 'current-home',
        updatedAt: serverTimestamp(),
      }),
      'Own neutral public profile update',
    );
  });

  test('users cannot write another manager public profile or add private fields', async () => {
    await expectDenied(
      updateDoc(doc(outsider.db, 'publicProfiles', manager.uid), {
        username: 'Forged Manager',
        updatedAt: serverTimestamp(),
      }),
      'Another manager public profile update',
    );
    await expectDenied(
      setDoc(doc(outsider.db, 'publicProfiles', outsider.uid), {
        ...validPublicProfile(outsider, 'Outsider'),
        email: outsider.email,
      }),
      'Private field in public profile',
    );
  });

  test('listing all private or public user profiles is denied', async () => {
    await expectDenied(
      getDocs(collection(manager.db, 'users')),
      'Private user profile collection listing',
    );
    await expectDenied(
      getDocs(collection(manager.db, 'publicProfiles')),
      'Public profile collection listing',
    );
  });

  test('an owner cannot change protected profile fields such as email', async () => {
    await expectDenied(
      updateDoc(doc(manager.db, 'users', manager.uid), {
        email: 'changed@rinkrat.test',
      }),
      'Protected profile field update',
    );
  });
});


describe('league onboarding compatibility', () => {
  test('browser clients cannot create a league or its commissioner records directly', async () => {
    const leagueId = 'new-rules-league';
    const inviteCode = 'NEW123';
    const batch = writeBatch(outsider.db);

    batch.set(doc(outsider.db, 'leagues', leagueId), {
      id: leagueId,
      commissionerId: outsider.uid,
      name: 'New Rules League',
      inviteCode,
      maxTeams: 6,
      matchupFormat: 'cycle_matchup',
      scoringRules: {},
      createdAt: serverTimestamp(),
    });
    batch.set(doc(outsider.db, 'leagueInvites', inviteCode), {
      inviteCode,
      leagueId,
      createdBy: outsider.uid,
      active: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    batch.set(doc(outsider.db, 'leagues', leagueId, 'members', outsider.uid), {
      uid: outsider.uid,
      leagueId,
      username: 'Outsider',
      profileIconId: VALID_ICON,
      role: 'commissioner',
      inviteCodeUsed: null,
      joinedAt: serverTimestamp(),
    });
    batch.set(doc(outsider.db, 'leagues', leagueId, 'teams', outsider.uid), {
      id: outsider.uid,
      ownerId: outsider.uid,
      teamName: 'Outsider',
      managerName: 'Outsider',
      profileIconId: VALID_ICON,
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
    });

    await expectDenied(batch.commit(), 'Browser-direct league creation batch');
  });

  test('a signed-in invitee can create membership and team before server roster initialization', async () => {
    const batch = writeBatch(outsider.db);

    batch.set(doc(outsider.db, 'leagues', LEAGUE_ID, 'members', outsider.uid), {
      uid: outsider.uid,
      leagueId: LEAGUE_ID,
      username: 'Outsider',
      profileIconId: VALID_ICON,
      role: 'member',
      inviteCodeUsed: 'ABC123',
      joinedAt: serverTimestamp(),
    });
    batch.set(doc(outsider.db, 'leagues', LEAGUE_ID, 'teams', outsider.uid), {
      id: outsider.uid,
      ownerId: outsider.uid,
      teamName: 'Outsider',
      managerName: 'Outsider',
      profileIconId: VALID_ICON,
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
    });

    await expectAllowed(batch.commit(), 'Join-league onboarding batch without roster');
  });
});

describe('league membership and reads', () => {
  test('members can read the league and outsiders cannot', async () => {
    await expectAllowed(
      getDoc(doc(manager.db, 'leagues', LEAGUE_ID)),
      'League member read',
    );
    await expectDenied(
      getDoc(doc(outsider.db, 'leagues', LEAGUE_ID)),
      'League outsider read',
    );
  });

  test('members can read team and roster records while outsiders cannot', async () => {
    await expectAllowed(
      getDoc(doc(opponent.db, 'leagues', LEAGUE_ID, 'teams', manager.uid)),
      'Opponent team read',
    );
    await expectAllowed(
      getDoc(
        doc(opponent.db, 'leagues', LEAGUE_ID, 'teams', manager.uid, 'roster', 'current'),
      ),
      'Opponent roster read',
    );
    await expectDenied(
      getDoc(
        doc(outsider.db, 'leagues', LEAGUE_ID, 'teams', manager.uid, 'roster', 'current'),
      ),
      'Outsider roster read',
    );
  });
});

describe('league competition settings authority', () => {
  test('commissioners can update only approved league presentation fields', async () => {
    await expectAllowed(
      updateDoc(doc(commissioner.db, 'leagues', LEAGUE_ID), {
        name: 'Renamed Rules Fixture League',
        leagueLogoId: 'rink-rat',
        leagueLogoPaletteId: 'ice-blue',
        updatedAt: serverTimestamp(),
      }),
      'Commissioner cosmetic league update',
    );
  });

  test('commissioners cannot delete an existing approved league emblem field', async () => {
    await seedDocument(`leagues/${LEAGUE_ID}`, {
      id: LEAGUE_ID,
      commissionerId: commissioner.uid,
      name: 'Rules Fixture League',
      inviteCode: 'ABC123',
      maxTeams: 4,
      matchupFormat: 'cycle_matchup',
      scoringRules: {},
      leagueLogoId: 'rink-rat',
      leagueLogoPaletteId: 'rink-gold',
    });

    await expectDenied(
      updateDoc(doc(commissioner.db, 'leagues', LEAGUE_ID), {
        leagueLogoId: deleteField(),
        updatedAt: serverTimestamp(),
      }),
      'Commissioner league emblem deletion',
    );
  });

  test('commissioners cannot change scoring or the six-game competition contract', async () => {
    await expectDenied(
      updateDoc(doc(commissioner.db, 'leagues', LEAGUE_ID), {
        scoringRules: { requiredGamesPerCycle: 3 },
        scoringRulesVersion: 999,
      }),
      'Commissioner scoring contract tamper',
    );
  });

  test('commissioners cannot change ownership, capacity, invite identity, or hidden fields', async () => {
    await expectDenied(
      updateDoc(doc(commissioner.db, 'leagues', LEAGUE_ID), {
        commissionerId: manager.uid,
        maxTeams: 12,
        inviteCode: 'HACKED',
        hiddenAuthorityBypass: true,
      }),
      'Commissioner protected league field tamper',
    );
  });

  test('league audit records are readable by members but browser-writable by nobody', async () => {
    await seedDocument(`leagues/${LEAGUE_ID}/audit/league-created`, {
      id: 'league-created',
      leagueId: LEAGUE_ID,
      action: 'league-created',
      actorId: commissioner.uid,
      authority: 'cloud-function',
    });

    await expectAllowed(
      getDoc(doc(manager.db, 'leagues', LEAGUE_ID, 'audit', 'league-created')),
      'Member league audit read',
    );
    await expectDenied(
      setDoc(doc(commissioner.db, 'leagues', LEAGUE_ID, 'audit', 'forged'), {
        action: 'scoring-rules-changed',
        actorId: commissioner.uid,
      }),
      'Commissioner forged league audit write',
    );
  });
});

describe('standings authority hardening', () => {
  test('commissioners can edit safe team identity fields', async () => {
    await expectAllowed(
      updateDoc(doc(commissioner.db, 'leagues', LEAGUE_ID, 'teams', manager.uid), {
        teamName: 'Renamed by Commissioner',
        updatedAt: serverTimestamp(),
      }),
      'Commissioner safe team identity update',
    );
  });

  test('commissioners cannot directly change standings or waiver priority', async () => {
    await expectDenied(
      updateDoc(doc(commissioner.db, 'leagues', LEAGUE_ID, 'teams', manager.uid), {
        wins: 99,
        pointsFor: 9999,
        waiverPriority: 1,
        updatedAt: serverTimestamp(),
      }),
      'Commissioner standings tamper',
    );
  });

  test('team owners cannot directly change their own standings', async () => {
    await expectDenied(
      updateDoc(doc(manager.db, 'leagues', LEAGUE_ID, 'teams', manager.uid), {
        losses: 0,
        pointsAgainst: 0,
        updatedAt: serverTimestamp(),
      }),
      'Owner standings tamper',
    );
  });
});

describe('roster authority hardening', () => {
  test('an owner cannot overwrite the roster with forged and duplicated assets', async () => {
    const forgedRoster = validRoster('forged');
    const duplicatedAsset = { assetKey: 'forged-duplicate', displayName: 'Invented Player' };

    forgedRoster.activeSlots = forgedRoster.activeSlots.map((slot) => ({
      ...slot,
      asset: duplicatedAsset,
    }));

    await expectDenied(
      setDoc(
        doc(manager.db, 'leagues', LEAGUE_ID, 'teams', manager.uid, 'roster', 'current'),
        forgedRoster,
      ),
      'Owner forged roster overwrite',
    );
  });

  test('another manager cannot change the owner roster', async () => {
    await expectDenied(
      setDoc(
        doc(opponent.db, 'leagues', LEAGUE_ID, 'teams', manager.uid, 'roster', 'current'),
        validRoster('opponent-forgery'),
      ),
      'Opponent roster overwrite',
    );
  });

  test('browser clients cannot recreate their own missing roster document', async () => {
    await deleteSeededDocument(
      `leagues/${LEAGUE_ID}/teams/${manager.uid}/roster/current`,
    );

    await expectDenied(
      setDoc(
        doc(manager.db, 'leagues', LEAGUE_ID, 'teams', manager.uid, 'roster', 'current'),
        validRoster('client-create'),
      ),
      'Owner browser roster creation',
    );
  });

  test('commissioners cannot overwrite a roster directly after cycle authority hardening', async () => {
    await expectDenied(
      setDoc(
        doc(commissioner.db, 'leagues', LEAGUE_ID, 'teams', manager.uid, 'roster', 'current'),
        validRoster('commissioner-overwrite'),
      ),
      'Commissioner roster overwrite',
    );
  });
});

describe('draft authority hardening', () => {
  test('browser clients cannot submit a non-canonical manual pick object', async () => {
    const batch = writeBatch(manager.db);
    const draftRef = doc(manager.db, 'leagues', LEAGUE_ID, 'draft', 'current');
    const pickRef = doc(
      manager.db,
      'leagues',
      LEAGUE_ID,
      'draft',
      'current',
      'picks',
      'pick-1',
    );

    batch.set(pickRef, {
      ownerId: manager.uid,
      round: 1,
      pickInRound: 1,
      overallPick: 1,
      asset: {
        assetKey: 'forged-asset-key',
        displayName: 'Non-canonical Client Asset',
        projectedCyclePoints: 999999,
      },
      selectionType: 'manual',
      selectedByUserId: manager.uid,
      autoPickReason: null,
      madeAt: serverTimestamp(),
    });
    batch.update(draftRef, {
      status: 'live',
      nextOverallPick: 2,
      draftedAssetKeys: ['forged-asset-key'],
      clockStatus: 'running',
      pickStartedAt: serverTimestamp(),
      currentPickSeconds: 120,
      pausedRemainingSeconds: null,
      clockUpdatedBy: manager.uid,
      clockUpdatedAt: serverTimestamp(),
      lastPickId: 'pick-1',
      updatedAt: serverTimestamp(),
    });

    await expectDenied(batch.commit(), 'Forged manual draft pick batch');
  });

  test('browser clients cannot place a manual pick into their roster directly', async () => {
    const batch = writeBatch(manager.db);
    const draftRef = doc(manager.db, 'leagues', LEAGUE_ID, 'draft', 'current');
    const pickRef = doc(
      manager.db,
      'leagues',
      LEAGUE_ID,
      'draft',
      'current',
      'picks',
      'pick-with-roster',
    );
    const rosterRef = doc(
      manager.db,
      'leagues',
      LEAGUE_ID,
      'teams',
      manager.uid,
      'roster',
      'current',
    );
    const draftRoster = validRoster('draft-placement');

    batch.set(pickRef, {
      ownerId: manager.uid,
      round: 1,
      pickInRound: 1,
      overallPick: 1,
      asset: { assetKey: 'draft-placement-active-1' },
      selectionType: 'manual',
      selectedByUserId: manager.uid,
      autoPickReason: null,
      madeAt: serverTimestamp(),
    });
    batch.set(rosterRef, {
      ...draftRoster,
      updatedAt: serverTimestamp(),
    });
    batch.update(draftRef, {
      status: 'live',
      nextOverallPick: 2,
      draftedAssetKeys: ['draft-placement-active-1'],
      clockStatus: 'running',
      pickStartedAt: serverTimestamp(),
      currentPickSeconds: 120,
      pausedRemainingSeconds: null,
      clockUpdatedBy: manager.uid,
      clockUpdatedAt: serverTimestamp(),
      lastPickId: 'pick-with-roster',
      updatedAt: serverTimestamp(),
    });

    await expectDenied(batch.commit(), 'Manual draft roster placement batch');
  });

  test('a manager cannot pick when another manager owns the current turn', async () => {
    await seedDocument(`leagues/${LEAGUE_ID}/draft/current`, {
      id: 'current',
      status: 'live',
      clockStatus: 'running',
      roundOneOrder: [opponent.uid, manager.uid],
      nextOverallPick: 1,
      draftedAssetKeys: [],
      pickStartedAt: new Date(Date.now() - 5_000),
      currentPickSeconds: 120,
      pickSeconds: 120,
      pausedRemainingSeconds: null,
      clockUpdatedBy: commissioner.uid,
      clockUpdatedAt: new Date(),
      lastPickId: null,
      updatedAt: new Date(),
    });

    const batch = writeBatch(manager.db);
    const draftRef = doc(manager.db, 'leagues', LEAGUE_ID, 'draft', 'current');
    const pickRef = doc(
      manager.db,
      'leagues',
      LEAGUE_ID,
      'draft',
      'current',
      'picks',
      'wrong-owner-pick',
    );

    batch.set(pickRef, {
      ownerId: manager.uid,
      round: 1,
      pickInRound: 1,
      overallPick: 1,
      asset: { assetKey: 'forged-asset-key' },
      selectionType: 'manual',
      selectedByUserId: manager.uid,
      autoPickReason: null,
      madeAt: serverTimestamp(),
    });
    batch.update(draftRef, {
      status: 'live',
      nextOverallPick: 2,
      draftedAssetKeys: ['forged-asset-key'],
      clockStatus: 'running',
      pickStartedAt: serverTimestamp(),
      currentPickSeconds: 120,
      pausedRemainingSeconds: null,
      clockUpdatedBy: manager.uid,
      clockUpdatedAt: serverTimestamp(),
      lastPickId: 'wrong-owner-pick',
      updatedAt: serverTimestamp(),
    });

    await expectDenied(batch.commit(), 'Wrong-owner manual draft pick');
  });

  test('commissioners cannot arbitrarily update draft records or completed picks', async () => {
    await seedDocument(`leagues/${LEAGUE_ID}/draft/current/picks/existing-pick`, {
      overallPick: 1,
      ownerId: manager.uid,
      asset: { assetKey: 'fixture' },
    });

    await expectDenied(
      updateDoc(doc(commissioner.db, 'leagues', LEAGUE_ID, 'draft', 'current'), {
        tamperedByCommissioner: true,
      }),
      'Commissioner draft update',
    );
    await expectDenied(
      updateDoc(
        doc(
          commissioner.db,
          'leagues',
          LEAGUE_ID,
          'draft',
          'current',
          'picks',
          'existing-pick',
        ),
        { asset: { assetKey: 'replacement' } },
      ),
      'Commissioner draft pick update',
    );
  });

  test('commissioners cannot create draft state directly from the browser', async () => {
    await deleteSeededDocument(`leagues/${LEAGUE_ID}/draft/current`);

    await expectDenied(
      setDoc(doc(commissioner.db, 'leagues', LEAGUE_ID, 'draft', 'current'), {
        status: 'setup',
        format: 'snake',
        roundOneOrder: [manager.uid, opponent.uid],
        nextOverallPick: 1,
        draftedAssetKeys: [],
      }),
      'Commissioner direct draft creation',
    );
  });

  test('the manager on the clock cannot change draft clock state directly', async () => {
    await expectDenied(
      updateDoc(doc(manager.db, 'leagues', LEAGUE_ID, 'draft', 'current'), {
        clockStatus: 'paused',
      }),
      'Manager direct draft clock update',
    );
  });


  test('the frozen projection pool cannot be changed during a live draft', async () => {
    await expectDenied(
      setDoc(
        doc(
          commissioner.db,
          'leagues',
          LEAGUE_ID,
          'projectionSnapshots',
          'current',
        ),
        {
          status: 'ready',
          activeSnapshotId: 'tampered-snapshot',
          assetCount: 1,
        },
      ),
      'Commissioner live-draft projection pointer write',
    );
  });

  test('draft queues are private to their owner and readable by the commissioner', async () => {
    const queuePath = [
      'leagues',
      LEAGUE_ID,
      'draft',
      'current',
      'queues',
      manager.uid,
    ];

    await expectAllowed(getDoc(doc(manager.db, ...queuePath)), 'Owner draft queue read');
    await expectAllowed(
      getDoc(doc(commissioner.db, ...queuePath)),
      'Commissioner draft queue read',
    );
    await expectDenied(getDoc(doc(opponent.db, ...queuePath)), 'Opponent draft queue read');
  });

  test('only a manager can edit their own draft queue', async () => {
    const managerQueueRef = doc(
      manager.db,
      'leagues',
      LEAGUE_ID,
      'draft',
      'current',
      'queues',
      manager.uid,
    );
    const commissionerQueueRef = doc(
      commissioner.db,
      'leagues',
      LEAGUE_ID,
      'draft',
      'current',
      'queues',
      manager.uid,
    );

    await expectAllowed(
      updateDoc(managerQueueRef, {
        assetKeys: ['skater-101'],
        autoDraftEnabled: true,
        updatedAt: serverTimestamp(),
      }),
      'Owner draft queue update',
    );
    await expectDenied(
      updateDoc(commissionerQueueRef, {
        assetKeys: ['skater-999'],
        autoDraftEnabled: true,
        updatedAt: serverTimestamp(),
      }),
      'Commissioner editing another manager queue',
    );
  });
});

describe('transactions and waivers authority hardening', () => {
  test('members can read transaction and waiver records while outsiders cannot', async () => {
    await expectAllowed(
      getDoc(doc(manager.db, 'leagues', LEAGUE_ID, 'transactions', 'fixture-transaction')),
      'Member transaction read',
    );
    await expectAllowed(
      getDoc(doc(manager.db, 'leagues', LEAGUE_ID, 'waivers', 'fixture-asset')),
      'Member waiver read',
    );
    await expectDenied(
      getDoc(doc(outsider.db, 'leagues', LEAGUE_ID, 'transactions', 'fixture-transaction')),
      'Outsider transaction read',
    );
    await expectDenied(
      getDoc(doc(outsider.db, 'leagues', LEAGUE_ID, 'waivers', 'fixture-asset')),
      'Outsider waiver read',
    );
  });

  test('ordinary managers cannot create transaction records directly', async () => {
    await expectDenied(
      setDoc(doc(manager.db, 'leagues', LEAGUE_ID, 'transactions', 'minimal-client-write'), {
        ownerId: manager.uid,
        type: 'add-drop',
        forgedPayload: { arbitrary: true },
      }),
      'Minimal owner transaction write',
    );
  });

  test('ordinary managers cannot create arbitrary waiver assets', async () => {
    await expectDenied(
      setDoc(doc(manager.db, 'leagues', LEAGUE_ID, 'waivers', 'invented-asset'), {
        droppedByOwnerId: manager.uid,
        status: 'active',
        claims: [],
        assetKey: 'invented-asset',
        asset: {
          assetKey: 'invented-asset',
          displayName: 'Invented Client Asset',
        },
      }),
      'Arbitrary waiver asset write',
    );
  });


  test('ordinary managers cannot append waiver claims directly', async () => {
    await expectDenied(
      updateDoc(doc(manager.db, 'leagues', LEAGUE_ID, 'waivers', 'fixture-asset'), {
        claims: [{ ownerId: manager.uid, moveType: 'open-slot' }],
      }),
      'Direct waiver claim update',
    );
  });

  test('commissioners cannot bypass the waiver authority function', async () => {
    await expectDenied(
      updateDoc(doc(commissioner.db, 'leagues', LEAGUE_ID, 'waivers', 'fixture-asset'), {
        status: 'cleared',
      }),
      'Commissioner waiver update',
    );
  });

  test('commissioners cannot forge transaction audit records', async () => {
    await expectDenied(
      setDoc(doc(commissioner.db, 'leagues', LEAGUE_ID, 'transactions', 'forged-audit'), {
        ownerId: manager.uid,
        type: 'commissioner-forgery',
      }),
      'Commissioner transaction creation',
    );
  });

});

describe('scoring, cycles, and playoff authority baseline', () => {
  test('members can read competition records while outsiders cannot', async () => {
    await expectAllowed(
      getDoc(doc(manager.db, 'leagues', LEAGUE_ID, 'cycles', 'cycle-1')),
      'Member cycle read',
    );
    await expectAllowed(
      getDoc(
        doc(manager.db, 'leagues', LEAGUE_ID, 'cycles', 'cycle-1', 'matchups', 'matchup-1'),
      ),
      'Member matchup read',
    );
    await expectAllowed(
      getDoc(doc(manager.db, 'leagues', LEAGUE_ID, 'playoffs', 'current')),
      'Member playoff read',
    );
    await expectDenied(
      getDoc(doc(outsider.db, 'leagues', LEAGUE_ID, 'cycles', 'cycle-1')),
      'Outsider cycle read',
    );
  });

  test('commissioners cannot directly alter competition records', async () => {
    const updates = [
      doc(commissioner.db, 'leagues', LEAGUE_ID, 'cycles', 'cycle-1'),
      doc(
        commissioner.db,
        'leagues',
        LEAGUE_ID,
        'cycles',
        'cycle-1',
        'matchups',
        'matchup-1',
      ),
      doc(
        commissioner.db,
        'leagues',
        LEAGUE_ID,
        'cycles',
        'cycle-1',
        'rosterPicks',
        'pick-1',
      ),
      doc(
        commissioner.db,
        'leagues',
        LEAGUE_ID,
        'cycles',
        'cycle-1',
        'teamWindows',
        manager.uid,
      ),
      doc(commissioner.db, 'leagues', LEAGUE_ID, 'playoffs', 'current'),
      doc(
        commissioner.db,
        'leagues',
        LEAGUE_ID,
        'playoffWindowBanks',
        manager.uid,
      ),
      doc(
        commissioner.db,
        'leagues',
        LEAGUE_ID,
        'playoffWindowBanks',
        manager.uid,
        'windows',
        'window-1',
      ),
    ];

    for (const [index, reference] of updates.entries()) {
      await expectDenied(
        updateDoc(reference, { [`commissionerTamper${index}`]: true }),
        `Commissioner competition write ${index + 1}`,
      );
    }
  });

  test('commissioners cannot create or delete cycle and playoff records from the browser', async () => {
    await expectDenied(
      setDoc(doc(commissioner.db, 'leagues', LEAGUE_ID, 'cycles', 'cycle-2'), {
        id: 'cycle-2',
        cycleNumber: 2,
        status: 'active',
      }),
      'Commissioner cycle creation',
    );
    await expectDenied(
      setDoc(doc(commissioner.db, 'leagues', LEAGUE_ID, 'playoffs', 'replacement'), {
        id: 'replacement',
        status: 'active',
      }),
      'Commissioner playoff creation',
    );
  });

  test('projection accuracy analytics can mark a cycle without changing competition fields', async () => {
    await expectAllowed(
      updateDoc(doc(commissioner.db, 'leagues', LEAGUE_ID, 'cycles', 'cycle-1'), {
        projectionAccuracyStatus: 'complete',
        projectionAccuracyAssetCount: 17,
        projectionAccuracyProjectionVersions: [9],
        projectionAccuracyUpdatedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
      'Projection accuracy cycle marker',
    );
  });

  test('ordinary managers cannot directly alter competition records', async () => {
    await expectDenied(
      updateDoc(doc(manager.db, 'leagues', LEAGUE_ID, 'cycles', 'cycle-1'), {
        tampered: true,
      }),
      'Manager cycle write',
    );
    await expectDenied(
      updateDoc(doc(manager.db, 'leagues', LEAGUE_ID, 'playoffs', 'current'), {
        tampered: true,
      }),
      'Manager playoff write',
    );
  });

  test('live-scoring documents are readable by members but browser writes are denied to everyone', async () => {
    const memberRef = doc(manager.db, 'leagues', LEAGUE_ID, 'liveScoring', 'control');
    const commissionerRef = doc(
      commissioner.db,
      'leagues',
      LEAGUE_ID,
      'liveScoring',
      'control',
    );

    await expectAllowed(getDoc(memberRef), 'Member live-scoring read');
    await expectDenied(
      updateDoc(commissionerRef, { status: 'refreshing' }),
      'Commissioner browser live-scoring write',
    );
    await expectDenied(
      updateDoc(memberRef, { status: 'refreshing' }),
      'Manager browser live-scoring write',
    );
  });
});

describe('injury and availability authority baseline', () => {
  test('commissioners cannot write the global availability document directly', async () => {
    await expectDenied(
      setDoc(doc(commissioner.db, 'appData', 'playerAvailability'), {
        source: 'ESPN',
        status: 'success',
        dailyKey: '2026-07-30',
        lastAttemptAt: serverTimestamp(),
        updatedBy: commissioner.uid,
        refreshLeagueId: LEAGUE_ID,
        message: 'Commissioner browser attempted a global availability write.',
        records: [],
      }),
      'Commissioner global availability write',
    );
  });

  test('ordinary managers cannot write the global availability document', async () => {
    await expectDenied(
      setDoc(doc(manager.db, 'appData', 'playerAvailability'), {
        source: 'ESPN',
        status: 'success',
        dailyKey: '2026-07-30',
        lastAttemptAt: serverTimestamp(),
        updatedBy: manager.uid,
        refreshLeagueId: LEAGUE_ID,
        message: 'Manager attempted global availability write.',
        records: [],
      }),
      'Manager global availability write',
    );
  });

  test('commissioner overrides are league-scoped and ordinary managers cannot create them', async () => {
    const commissionerOverride = doc(
      commissioner.db,
      'leagues',
      LEAGUE_ID,
      'playerAvailability',
      '8478402',
    );
    const managerOverride = doc(
      manager.db,
      'leagues',
      LEAGUE_ID,
      'playerAvailability',
      '8478403',
    );

    await expectAllowed(
      setDoc(commissionerOverride, {
        playerId: 8478402,
        playerName: 'Fixture Player',
        status: 'out',
        note: 'Fixture override',
        irEligible: true,
        updatedAt: serverTimestamp(),
        updatedBy: commissioner.uid,
        source: 'commissioner',
        leagueId: LEAGUE_ID,
      }),
      'Commissioner league availability override',
    );
    await expectDenied(
      setDoc(managerOverride, {
        playerId: 8478403,
        playerName: 'Fixture Player Two',
        status: 'out',
        note: 'Unauthorized override',
        irEligible: true,
        updatedAt: serverTimestamp(),
        updatedBy: manager.uid,
        source: 'commissioner',
        leagueId: LEAGUE_ID,
      }),
      'Manager league availability override',
    );
  });
});
