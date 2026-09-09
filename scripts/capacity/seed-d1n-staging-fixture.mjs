import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import {
  buildD1nFixtureDocuments,
  D1N_FIXTURE_EMAIL,
  D1N_FIXTURE_LEAGUE_ID,
  resolveD1nFixtureDraftStartOffsetMinutes,
  resolveD1nFixtureDraftStatus,
} from './seed-d1n-route-fixture.mjs';
import { D1N_STAGING_PROJECT_ID } from './prepare-d1n-staging-hosting.mjs';

export const D1N_STAGING_SEED_ACKNOWLEDGEMENT =
  `seed-synthetic-fixture-in-${D1N_STAGING_PROJECT_ID}`;
export const D1N_STAGING_MAX_RESIDUAL_DRAFT_PICKS = 250;

const D1N_STAGING_FIXTURE_LEAGUE_NAME = 'D1N Capacity Fixture';
const D1N_STAGING_FIXTURE_INVITE_CODE = 'D1N100';

const requireFunctions = createRequire(
  new URL('../../functions/package.json', import.meta.url),
);

export function assertD1nStagingSeedSafety(environment = process.env) {
  if (
    environment.FIRESTORE_EMULATOR_HOST ||
    environment.FIREBASE_AUTH_EMULATOR_HOST ||
    environment.FIREBASE_DATABASE_EMULATOR_HOST
  ) {
    throw new Error('D1N staging seeding refuses every Emulator Suite environment.');
  }

  if (environment.D1N_STAGING_PROJECT_ID !== D1N_STAGING_PROJECT_ID) {
    throw new Error(`D1N_STAGING_PROJECT_ID must equal ${D1N_STAGING_PROJECT_ID}.`);
  }

  if (environment.D1N_STAGING_ACK !== D1N_STAGING_SEED_ACKNOWLEDGEMENT) {
    throw new Error('D1N_STAGING_ACK does not authorize the exact staging fixture.');
  }

  const password = environment.D1N_STAGING_FIXTURE_PASSWORD ?? '';

  if (
    password.length < 20 ||
    password.length > 128 ||
    !/[a-z]/.test(password) ||
    !/[A-Z]/.test(password) ||
    !/[0-9]/.test(password) ||
    !/[^A-Za-z0-9]/.test(password)
  ) {
    throw new Error(
      'D1N_STAGING_FIXTURE_PASSWORD must be 20–128 characters with upper, lower, number, and symbol.',
    );
  }

  return {
    password,
    draftStatus: resolveD1nFixtureDraftStatus(environment),
    draftStartOffsetMinutes: resolveD1nFixtureDraftStartOffsetMinutes(environment),
  };
}

export function assertD1nStagingFixtureResetScope({
  leagueExists,
  leagueData,
  commissionerId,
  residualDraftPickCount,
}) {
  if (
    !Number.isInteger(residualDraftPickCount) ||
    residualDraftPickCount < 0 ||
    residualDraftPickCount > D1N_STAGING_MAX_RESIDUAL_DRAFT_PICKS
  ) {
    throw new Error(
      `D1N staging reset refuses more than ${D1N_STAGING_MAX_RESIDUAL_DRAFT_PICKS} residual Draft picks.`,
    );
  }

  if (!leagueExists) {
    if (residualDraftPickCount > 0) {
      throw new Error('D1N staging reset found Draft picks without the exact synthetic league parent.');
    }
    return;
  }

  if (
    leagueData?.id !== D1N_FIXTURE_LEAGUE_ID ||
    leagueData?.name !== D1N_STAGING_FIXTURE_LEAGUE_NAME ||
    leagueData?.inviteCode !== D1N_STAGING_FIXTURE_INVITE_CODE ||
    leagueData?.commissionerId !== commissionerId ||
    leagueData?.maxTeams !== 10 ||
    leagueData?.teamCount !== 10 ||
    leagueData?.scoringRulesVersion !== 4
  ) {
    throw new Error(
      'D1N staging reset refuses to modify a league that does not match the exact synthetic fixture identity.',
    );
  }
}

export async function clearBoundedD1nStagingDraftPicks(
  firestore,
  commissionerId,
) {
  const leagueRef = firestore.doc(`leagues/${D1N_FIXTURE_LEAGUE_ID}`);
  const picks = firestore.collection(
    `leagues/${D1N_FIXTURE_LEAGUE_ID}/draft/current/picks`,
  );
  const [leagueSnapshot, picksSnapshot] = await Promise.all([
    leagueRef.get(),
    picks.limit(D1N_STAGING_MAX_RESIDUAL_DRAFT_PICKS + 1).get(),
  ]);
  const residualDraftPicks = picksSnapshot.docs ?? [];

  assertD1nStagingFixtureResetScope({
    leagueExists: leagueSnapshot.exists,
    leagueData: leagueSnapshot.data?.(),
    commissionerId,
    residualDraftPickCount: residualDraftPicks.length,
  });

  if (residualDraftPicks.length === 0) {
    return 0;
  }

  const batch = firestore.batch();

  for (const pick of residualDraftPicks) {
    batch.delete(pick.ref);
  }

  await batch.commit();

  const remaining = await picks.limit(1).get();

  if (!remaining.empty) {
    throw new Error(
      'D1N staging reset did not clear the bounded synthetic Draft pick collection.',
    );
  }

  return residualDraftPicks.length;
}

export async function seedD1nStagingFixture(environment = process.env) {
  const safety = assertD1nStagingSeedSafety(environment);
  const { applicationDefault, deleteApp, initializeApp } = requireFunctions('firebase-admin/app');
  const { getAuth } = requireFunctions('firebase-admin/auth');
  const { getFirestore } = requireFunctions('firebase-admin/firestore');
  const app = initializeApp({
    credential: applicationDefault(),
    projectId: D1N_STAGING_PROJECT_ID,
  }, `d1n-staging-seed-${Date.now()}`);

  try {
    if (app.options.projectId !== D1N_STAGING_PROJECT_ID) {
      throw new Error('Firebase Admin did not bind to the exact D1N staging project.');
    }

    const auth = getAuth(app);
    const firestore = getFirestore(app);
    let user;
    let residualDraftPicksDeleted;

    try {
      user = await auth.getUserByEmail(D1N_FIXTURE_EMAIL);
      residualDraftPicksDeleted =
        await clearBoundedD1nStagingDraftPicks(firestore, user.uid);
      user = await auth.updateUser(user.uid, {
        password: safety.password,
        emailVerified: true,
        disabled: false,
      });
    } catch (error) {
      if (error?.code !== 'auth/user-not-found') {
        throw error;
      }

      residualDraftPicksDeleted =
        await clearBoundedD1nStagingDraftPicks(firestore, '__missing-d1n-fixture-user__');
      user = await auth.createUser({
        email: D1N_FIXTURE_EMAIL,
        password: safety.password,
        emailVerified: true,
        disabled: false,
        displayName: 'D1N Commissioner',
      });
    }

    const fixture = buildD1nFixtureDocuments(user.uid, new Date(), {
      draftStatus: safety.draftStatus,
      draftStartOffsetMinutes: safety.draftStartOffsetMinutes,
    });
    const writer = firestore.bulkWriter();

    for (const [path, data] of fixture.documents) {
      writer.set(firestore.doc(path), data);
    }

    await writer.close();

    return {
      projectId: D1N_STAGING_PROJECT_ID,
      leagueId: 'd1n-capacity-league',
      email: D1N_FIXTURE_EMAIL,
      draftStatus: safety.draftStatus,
      draftStartOffsetMinutes: safety.draftStartOffsetMinutes,
      residualDraftPicksDeleted,
      ...fixture.aggregate,
    };
  } finally {
    await deleteApp(app);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedD1nStagingFixture()
    .then((result) => {
      console.log('The isolated D1N staging fixture is ready.');
      console.log(JSON.stringify(result, null, 2));
      console.log('The fixture password was not printed or persisted.');
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
