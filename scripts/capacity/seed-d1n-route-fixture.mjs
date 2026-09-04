import { fileURLToPath } from 'node:url';

export const D1N_FIXTURE_PROJECT_ID = 'demo-rinkrat-d1n';
export const D1N_FIXTURE_LEAGUE_ID = 'd1n-capacity-league';
export const D1N_FIXTURE_EMAIL = 'commissioner@d1n.rinkrat.test';
export const D1N_FIXTURE_PASSWORD = 'D1n-Local-Fixture-2026!';

const TEAM_COUNT = 10;
const PROJECTION_ASSET_COUNT = 100;
const ACTIVITY_COUNT = 20;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
const DRAFT_STATUSES = new Set(['live', 'scheduled']);
const DEFAULT_DRAFT_START_OFFSET_MINUTES = 7 * 24 * 60;
const MIN_DRAFT_START_OFFSET_MINUTES = 1;
const MAX_DRAFT_START_OFFSET_MINUTES = 7 * 24 * 60;
const DRAFT_VISUAL_FIXTURE_ASSETS = new Map([
  [1, {
    fullName: 'Fixture Healthy Headshot',
    nhlTeamAbbreviation: 'MIN',
    headshotUrl: '/assets/profile-icons/masked-veteran.webp',
    teamLogoUrl: '/assets/team-identity-logos/MIN_light.svg',
  }],
  [2, {
    fullName: 'Fixture Injured Headshot',
    nhlTeamAbbreviation: 'OTT',
    headshotUrl: '/assets/profile-icons/teal-captain.webp',
    teamLogoUrl: '/assets/team-identity-logos/OTT_light.svg',
    availabilityStatus: 'injured-reserve',
  }],
  [3, {
    fullName: 'Fixture Broken Headshot',
    nhlTeamAbbreviation: 'TBL',
    headshotUrl: '/assets/d1n-fixture/missing-headshot.webp',
    teamLogoUrl: '/assets/team-identity-logos/TBL_light.svg',
  }],
  [4, {
    fullName: 'Brady Tkachuk',
    nhlTeamAbbreviation: 'FLA',
    headshotUrl: '/assets/profile-icons/masked-veteran.webp',
    teamLogoUrl: '/assets/team-identity-logos/FLA_light.svg',
  }],
  [5, {
    fullName: 'Fixture Extraordinarily Long Player Name',
    nhlTeamAbbreviation: 'MIN',
    teamLogoUrl: '/assets/team-identity-logos/MIN_light.svg',
  }],
]);

function parseEmulatorHost(value, label, expectedPort) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be set by the Firebase Emulator Suite.`);
  }

  const separator = value.lastIndexOf(':');
  const hostname = value.slice(0, separator).trim().toLowerCase();
  const port = Number(value.slice(separator + 1));

  if (!LOOPBACK_HOSTS.has(hostname) || port !== expectedPort) {
    throw new Error(`${label} must point to loopback port ${expectedPort}.`);
  }

  return { hostname, port };
}

export function assertD1nFixtureSafety(environment = process.env) {
  return {
    auth: parseEmulatorHost(
      environment.FIREBASE_AUTH_EMULATOR_HOST,
      'FIREBASE_AUTH_EMULATOR_HOST',
      9099,
    ),
    firestore: parseEmulatorHost(
      environment.FIRESTORE_EMULATOR_HOST,
      'FIRESTORE_EMULATOR_HOST',
      8080,
    ),
  };
}

export function resolveD1nFixtureDraftStatus(environment = process.env) {
  const status = environment.D1N_FIXTURE_DRAFT_STATUS?.trim() || 'live';

  if (!DRAFT_STATUSES.has(status)) {
    throw new Error('D1N_FIXTURE_DRAFT_STATUS must be live or scheduled.');
  }

  return status;
}

export function resolveD1nFixtureDraftStartOffsetMinutes(environment = process.env) {
  const rawOffset = environment.D1N_FIXTURE_DRAFT_START_OFFSET_MINUTES?.trim();

  if (!rawOffset) {
    return DEFAULT_DRAFT_START_OFFSET_MINUTES;
  }

  if (!/^\d+$/.test(rawOffset)) {
    throw new Error(
      `D1N_FIXTURE_DRAFT_START_OFFSET_MINUTES must be an integer from ${MIN_DRAFT_START_OFFSET_MINUTES} to ${MAX_DRAFT_START_OFFSET_MINUTES}.`,
    );
  }

  const offsetMinutes = Number(rawOffset);

  if (
    !Number.isSafeInteger(offsetMinutes) ||
    offsetMinutes < MIN_DRAFT_START_OFFSET_MINUTES ||
    offsetMinutes > MAX_DRAFT_START_OFFSET_MINUTES
  ) {
    throw new Error(
      `D1N_FIXTURE_DRAFT_START_OFFSET_MINUTES must be an integer from ${MIN_DRAFT_START_OFFSET_MINUTES} to ${MAX_DRAFT_START_OFFSET_MINUTES}.`,
    );
  }

  return offsetMinutes;
}

function emulatorUrl(endpoint, pathname) {
  return `http://${endpoint.hostname}:${endpoint.port}${pathname}`;
}

async function expectOk(response, action) {
  if (response.ok) {
    return response;
  }

  const responseText = await response.text();
  throw new Error(`${action} failed with ${response.status}: ${responseText}`);
}

function encodeFirestoreValue(value) {
  if (value === null || value === undefined) {
    return { nullValue: null };
  }

  if (value instanceof Date) {
    return { timestampValue: value.toISOString() };
  }

  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map(encodeFirestoreValue),
      },
    };
  }

  switch (typeof value) {
    case 'boolean':
      return { booleanValue: value };
    case 'number':
      return Number.isInteger(value)
        ? { integerValue: String(value) }
        : { doubleValue: value };
    case 'string':
      return { stringValue: value };
    case 'object':
      return { mapValue: { fields: encodeFirestoreFields(value) } };
    default:
      throw new TypeError(`Unsupported fixture value: ${typeof value}`);
  }
}

function encodeFirestoreFields(data) {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, encodeFirestoreValue(value)]),
  );
}

async function resetEmulators(endpoints) {
  await Promise.all([
    fetch(
      emulatorUrl(
        endpoints.auth,
        `/emulator/v1/projects/${D1N_FIXTURE_PROJECT_ID}/accounts`,
      ),
      { method: 'DELETE' },
    ).then((response) => expectOk(response, 'Resetting the Auth emulator')),
    fetch(
      emulatorUrl(
        endpoints.firestore,
        `/emulator/v1/projects/${D1N_FIXTURE_PROJECT_ID}/databases/(default)/documents`,
      ),
      { method: 'DELETE' },
    ).then((response) => expectOk(response, 'Resetting the Firestore emulator')),
  ]);
}

async function createFixtureUser(authEndpoint) {
  const response = await fetch(
    emulatorUrl(
      authEndpoint,
      '/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key',
    ),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: D1N_FIXTURE_EMAIL,
        password: D1N_FIXTURE_PASSWORD,
        returnSecureToken: true,
      }),
    },
  );

  await expectOk(response, 'Creating the synthetic D1N Auth user');
  const result = await response.json();

  if (typeof result.localId !== 'string' || !result.localId) {
    throw new Error('The Auth emulator did not return a fixture user ID.');
  }

  return result.localId;
}

async function seedDocument(firestoreEndpoint, path, data) {
  const encodedPath = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const response = await fetch(
    emulatorUrl(
      firestoreEndpoint,
      `/v1/projects/${D1N_FIXTURE_PROJECT_ID}/databases/(default)/documents/${encodedPath}`,
    ),
    {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer owner',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields: encodeFirestoreFields(data) }),
    },
  );

  await expectOk(response, `Seeding ${path}`);
}

function buildEmptyRoster() {
  const positions = [
    ...Array(3).fill('LW'),
    ...Array(3).fill('C'),
    ...Array(3).fill('RW'),
    ...Array(4).fill('D'),
    'G',
  ];
  const counts = new Map();

  return {
    schemaVersion: 2,
    activeSlots: positions.map((position) => {
      const slotNumber = (counts.get(position) ?? 0) + 1;
      counts.set(position, slotNumber);
      return {
        slotId: `${position}-${slotNumber}`,
        position,
        slotNumber,
        asset: null,
        pendingMove: null,
        openFromCycleNumber: null,
      };
    }),
    benchSlots: Array.from({ length: 3 }, (_, index) => ({
      slotId: `B-${index + 1}`,
      slotNumber: index + 1,
      asset: null,
    })),
    irSlots: Array.from({ length: 3 }, (_, index) => ({
      slotId: `IR-${index + 1}`,
      slotNumber: index + 1,
      asset: null,
    })),
  };
}

function buildProjectionAssets(now) {
  const positions = ['LW', 'C', 'RW', 'D'];

  return Array.from({ length: PROJECTION_ASSET_COUNT }, (_, index) => {
    const rank = index + 1;

    if (index >= PROJECTION_ASSET_COUNT - 10) {
      const isVisualGoalieUnit = rank === PROJECTION_ASSET_COUNT - 9;

      return {
        assetType: 'team-goalie-unit',
        assetKey: `team-goalie-unit:fixture-${rank}`,
        position: 'G',
        teamName: isVisualGoalieUnit
          ? 'Fixture Minnesota Goalie Unit'
          : `Fixture Goalie Unit ${rank}`,
        teamAbbreviation: isVisualGoalieUnit ? 'MIN' : `F${String(rank).padStart(2, '0')}`,
        ...(isVisualGoalieUnit
          ? { teamLogoUrl: '/assets/team-identity-logos/MIN_light.svg' }
          : {}),
        projectedCyclePoints: 24 - index / 10,
        projectedSeasonPoints: 300 - index,
        draftRank: rank,
        balancedRank: rank,
        draftPositionRank: index - (PROJECTION_ASSET_COUNT - 11),
        positionRank: index - (PROJECTION_ASSET_COUNT - 11),
        projectionModelVersion: 11,
        availabilityStatus: 'active',
      };
    }

    const position = positions[index % positions.length];
    const visualFixture = DRAFT_VISUAL_FIXTURE_ASSETS.get(rank);
    return {
      assetType: 'skater',
      assetKey: `skater:${10_000 + index}`,
      position,
      player: {
        id: 10_000 + index,
        fullName:
          visualFixture?.fullName ?? `Fixture ${position} ${String(rank).padStart(3, '0')}`,
        position,
        nhlTeamAbbreviation:
          visualFixture?.nhlTeamAbbreviation ??
          `T${String((index % 32) + 1).padStart(2, '0')}`,
        ...(visualFixture?.headshotUrl
          ? { headshotUrl: visualFixture.headshotUrl }
          : {}),
        ...(visualFixture?.teamLogoUrl
          ? { teamLogoUrl: visualFixture.teamLogoUrl }
          : {}),
      },
      projectedCyclePoints: 40 - index / 5,
      projectedSeasonPoints: 500 - index * 2,
      draftRank: rank,
      balancedRank: rank,
      draftPositionRank: Math.floor(index / positions.length) + 1,
      positionRank: Math.floor(index / positions.length) + 1,
      projectionModelVersion: 11,
      availabilityStatus: visualFixture?.availabilityStatus ?? 'active',
      availabilityReturnDate:
        visualFixture?.availabilityStatus === 'injured-reserve'
          ? new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)
            .toISOString()
            .slice(0, 10)
          : null,
      reliabilityRating: 80,
      projectionModelConfidence: 0.8,
    };
  });
}

export function buildD1nFixtureDocuments(
  commissionerId,
  now = new Date(),
  {
    draftStatus = 'live',
    draftStartOffsetMinutes = DEFAULT_DRAFT_START_OFFSET_MINUTES,
  } = {},
) {
  if (!DRAFT_STATUSES.has(draftStatus)) {
    throw new Error('The D1N fixture draft status must be live or scheduled.');
  }

  if (
    !Number.isSafeInteger(draftStartOffsetMinutes) ||
    draftStartOffsetMinutes < MIN_DRAFT_START_OFFSET_MINUTES ||
    draftStartOffsetMinutes > MAX_DRAFT_START_OFFSET_MINUTES
  ) {
    throw new Error(
      `The D1N fixture Draft start offset must be an integer from ${MIN_DRAFT_START_OFFSET_MINUTES} to ${MAX_DRAFT_START_OFFSET_MINUTES} minutes.`,
    );
  }

  const ownerIds = [
    commissionerId,
    ...Array.from({ length: TEAM_COUNT - 1 }, (_, index) => `fixture-owner-${index + 2}`),
  ];
  const projectionAssets = buildProjectionAssets(now);
  const projectionSnapshotId = 'fixture-v11';
  const projectionMetadata = {
    snapshotId: projectionSnapshotId,
    activeSnapshotId: projectionSnapshotId,
    status: 'ready',
    projectionVersion: 11,
    scoringRulesVersion: 4,
    generatedAt: now.toISOString(),
    generatedBy: 'd1n-local-fixture',
    assetCount: projectionAssets.length,
    assetDocumentCount: 1,
    assetStorageVersion: 1,
    teamCount: TEAM_COUNT,
    targetCycleNumber: 1,
    requiredGamesPerCycle: 6,
    generationReason: 'manual',
    draftReadyUntil: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    message: 'Synthetic D1N Projection V11 fixture.',
    projectionContext: 'live',
    authoritySchemaVersion: 2,
    generatedByAuthority: 'server',
    catalogValidationStatus: 'validated',
    snapshotHashSchemaVersion: 2,
    snapshotHashAlgorithm: 'sha256',
    snapshotContentHash: 'a'.repeat(64),
    snapshotChunkHashes: ['b'.repeat(64)],
    snapshotIntegrityStatus: 'verified',
  };
  const documents = new Map();

  documents.set(`users/${commissionerId}`, {
    uid: commissionerId,
    email: D1N_FIXTURE_EMAIL,
    username: 'D1N Commissioner',
    favoriteTeamAbbreviation: 'MIN',
    favoriteTeamVariantId: 'current-home',
    teamIdentityUnlocks: [],
    reducedMotion: false,
    defaultLandingPage: 'dashboard',
    backgroundTheme: 'rink-dark',
    injuryEmailEnabled: false,
    hockeyExperience: 'advanced',
    trainingCampVersion: 0,
    profileIconId: 'emerald-visor',
    createdAt: now,
    updatedAt: now,
  });
  documents.set(`publicProfiles/${commissionerId}`, {
    uid: commissionerId,
    username: 'D1N Commissioner',
    favoriteTeamAbbreviation: 'MIN',
    favoriteTeamVariantId: 'current-home',
    updatedAt: now,
  });
  documents.set(`leagues/${D1N_FIXTURE_LEAGUE_ID}`, {
    id: D1N_FIXTURE_LEAGUE_ID,
    name: 'D1N Capacity Fixture',
    leagueLogoId: 'classic-shield',
    leagueLogoPaletteId: 'ice-blue',
    commissionerId,
    inviteCode: 'D1N100',
    maxTeams: TEAM_COUNT,
    teamCount: TEAM_COUNT,
    joinStatus: 'full',
    matchupFormat: 'cycle_matchup',
    scoringRules: {},
    scoringRulesVersion: 4,
    authoritySchemaVersion: 1,
    competitionSettingsLocked: true,
    createdAt: now,
    updatedAt: now,
  });
  documents.set(`leagues/${D1N_FIXTURE_LEAGUE_ID}/members/${commissionerId}`, {
    uid: commissionerId,
    leagueId: D1N_FIXTURE_LEAGUE_ID,
    username: 'D1N Commissioner',
    role: 'commissioner',
    inviteCodeUsed: null,
    profileIconId: 'emerald-visor',
    joinedAt: now,
  });

  ownerIds.forEach((ownerId, index) => {
    documents.set(`leagues/${D1N_FIXTURE_LEAGUE_ID}/teams/${ownerId}`, {
      id: ownerId,
      ownerId,
      teamName: `Fixture Team ${String(index + 1).padStart(2, '0')}`,
      managerName: index === 0 ? 'D1N Commissioner' : `Fixture Manager ${index + 1}`,
      profileIconId: 'emerald-visor',
      logo: '',
      wins: TEAM_COUNT - index,
      losses: index,
      ties: 0,
      pointsFor: 1000 - index * 10,
      pointsAgainst: 900 + index * 10,
      waiverPriority: index + 1,
      draftPosition: index + 1,
      createdAt: now,
      updatedAt: now,
    });
    documents.set(`leagues/${D1N_FIXTURE_LEAGUE_ID}/teams/${ownerId}/roster/current`, {
      ...buildEmptyRoster(),
      createdAt: now,
      updatedAt: now,
    });
    documents.set(
      `leagues/${D1N_FIXTURE_LEAGUE_ID}/cycles/cycle-1/teamWindows/${ownerId}`,
      {
        id: `${ownerId}__cycle-1`,
        ownerId,
        cycleNumber: 1,
        expectedRosterSlotIds: [],
        windows: [],
        completedWindowCount: 0,
        totalWindowCount: 0,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      },
    );
    documents.set(`leagues/${D1N_FIXTURE_LEAGUE_ID}/draft/current/queues/${ownerId}`, {
      ownerId,
      assetKeys: index === 0 ? ['skater:10000'] : [],
      autoDraftEnabled: false,
      consecutiveClockExpirations: 0,
      autoDraftActivatedByTimeout: false,
      updatedAt: now,
    });
  });

  documents.set(`leagues/${D1N_FIXTURE_LEAGUE_ID}/draft/current`, {
    schemaVersion: 2,
    status: draftStatus,
    format: 'snake',
    totalRounds: 17,
    rosterRequirements: { LW: 3, C: 3, RW: 3, D: 4, G: 1 },
    benchSlots: 3,
    roundOneOrder: ownerIds,
    nextOverallPick: 1,
    draftedAssetKeys: [],
    scheduledStartAt:
      draftStatus === 'scheduled'
        ? new Date(now.getTime() + draftStartOffsetMinutes * 60 * 1000)
        : null,
    pickSeconds: 120,
    clockStatus: 'paused',
    pickStartedAt: null,
    currentPickSeconds: 120,
    pausedRemainingSeconds: 120,
    clockUpdatedBy: commissionerId,
    clockUpdatedAt: now,
    lastPickId: null,
    serverDraftProjectionSnapshotId: projectionSnapshotId,
    serverDraftProjectionSnapshotHash: projectionMetadata.snapshotContentHash,
    serverDraftProjectionAuthorityVersion: 2,
    createdAt: now,
    updatedAt: now,
  });
  documents.set(`leagues/${D1N_FIXTURE_LEAGUE_ID}/cycles/cycle-1`, {
    id: 'cycle-1',
    cycleNumber: 1,
    status: 'active',
    phase: 'regular_season',
    matchupIds: ['matchup-1'],
    windowSchemaVersion: 1,
    totalExpectedWindowCount: 0,
    activeWindowCount: 0,
    completedWindowCount: 0,
    matchupCompletionSchemaVersion: 1,
    totalMatchupCount: 1,
    completedMatchupCount: 0,
    pendingMatchupCount: 1,
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  documents.set(
    `leagues/${D1N_FIXTURE_LEAGUE_ID}/cycles/cycle-1/matchups/matchup-1`,
    {
      id: 'matchup-1',
      cycleNumber: 1,
      phase: 'regular_season',
      teamAOwnerId: ownerIds[0],
      teamBOwnerId: ownerIds[1],
      teamAScore: 0,
      teamBScore: 0,
      winnerOwnerId: null,
      status: 'active',
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    },
  );

  for (const pointerId of ['current', projectionSnapshotId, 'target-cycle-1']) {
    documents.set(
      `leagues/${D1N_FIXTURE_LEAGUE_ID}/projectionSnapshots/${pointerId}`,
      projectionMetadata,
    );
  }
  documents.set(
    `leagues/${D1N_FIXTURE_LEAGUE_ID}/projectionSnapshots/${projectionSnapshotId}/assets/chunk-000`,
    { assets: projectionAssets },
  );
  documents.set(`leagues/${D1N_FIXTURE_LEAGUE_ID}/historicalReplay/control`, {
    enabled: false,
    status: 'inactive',
    targetSeason: '20262027',
    sourceSeason: '20252026',
    simulatedDate: null,
    seasonStartDate: null,
    daysAdvanced: 0,
    lastReleasedGameCount: 0,
    totalReleasedGameCount: 0,
    message: 'Synthetic D1N fixture.',
    lastError: '',
    lastActiveCycleNumbers: [1],
    updatedAt: now,
  });
  documents.set('appData/playerAvailability', {
    schemaVersion: 1,
    status: 'success',
    lastSuccessfulSyncAt: now,
    lastDailySyncKey: now.toISOString().slice(0, 10),
    records: projectionAssets
      .filter((asset) => asset.assetType === 'skater')
      .slice(0, 20)
      .map((asset) => ({
        playerId: asset.player.id,
        playerName: asset.player.fullName,
        status: asset.availabilityStatus,
        note:
          asset.availabilityStatus === 'injured-reserve'
            ? 'Synthetic Draft visual evidence only.'
            : '',
        updatedAt: now.toISOString(),
        updatedBy: 'd1n-local-fixture',
        externalStatus:
          asset.availabilityStatus === 'injured-reserve'
            ? 'Injured Reserve'
            : 'Active',
        ...(asset.availabilityReturnDate
          ? { externalReturnDate: asset.availabilityReturnDate }
          : {}),
        syncedAt: now.toISOString(),
      })),
    updatedAt: now,
  });
  documents.set(`leagues/${D1N_FIXTURE_LEAGUE_ID}/liveScoring/control`, {
    id: 'control',
    schemaVersion: 2,
    status: 'idle',
    holderClientId: '',
    lastError: '',
    nextRefreshAt: now,
    updatedAt: now,
  });

  Array.from({ length: ACTIVITY_COUNT }, (_, index) => index).forEach((index) => {
    documents.set(
      `leagues/${D1N_FIXTURE_LEAGUE_ID}/activity/fixture-${String(index + 1).padStart(2, '0')}`,
      {
        schemaVersion: 1,
        category: 'roster',
        eventType: 'add-drop',
        ownerId: ownerIds[index % ownerIds.length],
        primaryAsset: {
          name: `Fixture Player ${index + 1}`,
          position: 'C',
          assetType: 'skater',
        },
        secondaryAsset: null,
        occurredAt: new Date(now.getTime() - index * 60_000),
        authority: 'league-activity-authority',
      },
    );
  });

  return {
    documents,
    ownerIds,
    aggregate: {
      teams: ownerIds.length,
      rosters: ownerIds.length,
      activeCycleTeamWindows: ownerIds.length,
      projectionAssets: projectionAssets.length,
      activityDocuments: ACTIVITY_COUNT,
    },
  };
}

export async function seedD1nRouteFixture(environment = process.env) {
  const endpoints = assertD1nFixtureSafety(environment);
  const draftStatus = resolveD1nFixtureDraftStatus(environment);
  await resetEmulators(endpoints);
  const commissionerId = await createFixtureUser(endpoints.auth);
  const fixture = buildD1nFixtureDocuments(commissionerId, new Date(), { draftStatus });

  await Promise.all(
    [...fixture.documents.entries()].map(([path, data]) =>
      seedDocument(endpoints.firestore, path, data),
    ),
  );

  return {
    projectId: D1N_FIXTURE_PROJECT_ID,
    leagueId: D1N_FIXTURE_LEAGUE_ID,
    email: D1N_FIXTURE_EMAIL,
    password: D1N_FIXTURE_PASSWORD,
    draftStatus,
    ...fixture.aggregate,
  };
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  seedD1nRouteFixture()
    .then((result) => {
      console.log('D1N local route fixture is ready.');
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
