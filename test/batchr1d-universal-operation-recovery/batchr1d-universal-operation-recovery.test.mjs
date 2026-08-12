import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  OperationDeadlineError,
  settleOperationWithin,
  waitForOperationCondition,
  withOperationDeadline,
} from '../../src/app/core/async/bounded-operation.util.ts';
import {
  draftPickMatchesPending,
  draftStateShowsPendingPickCommitted,
} from '../../src/app/features/draft/draft-room/draft-pick-confirmation.util.ts';
import {
  draftSettingsMatchExpectation,
} from '../../src/app/features/draft/draft-setup/draft-settings-confirmation.util.ts';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');

async function read(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

async function sha256(relativePath) {
  return createHash('sha256')
    .update(await readFile(path.join(root, relativePath)))
    .digest('hex');
}

async function hashFunctionTreeExcept(allowedRelativePaths) {
  const functionRoot = path.join(root, 'functions', 'src');
  const files = [];

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }

  await walk(functionRoot);
  const hash = createHash('sha256');
  let count = 0;

  for (const file of files) {
    const relativePath = path.relative(functionRoot, file).split(path.sep).join('/');

    if (allowedRelativePaths.has(relativePath)) {
      continue;
    }

    hash.update(relativePath);
    hash.update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
    count += 1;
  }

  return { count, digest: hash.digest('hex') };
}

test('bounded operation helpers release local UI state and safely observe late Firebase settlement', async () => {
  assert.deepEqual(
    await settleOperationWithin(Promise.resolve('confirmed'), 50),
    { status: 'fulfilled', value: 'confirmed' },
  );

  const rejected = await settleOperationWithin(
    Promise.reject(new Error('network ended')),
    50,
  );
  assert.equal(rejected.status, 'rejected');
  assert.match(String(rejected.error), /network ended/);

  const timedOut = await settleOperationWithin(
    new Promise((resolve) => setTimeout(() => resolve('late'), 30)),
    2,
  );
  assert.deepEqual(timedOut, { status: 'timed-out' });

  await assert.rejects(
    withOperationDeadline(
      new Promise((resolve) => setTimeout(() => resolve('late'), 30)),
      2,
      'Local UI deadline reached.',
    ),
    (error) => {
      assert.equal(error instanceof OperationDeadlineError, true);
      assert.equal(error.operationMayStillComplete, true);
      assert.match(error.message, /Local UI deadline reached/);
      return true;
    },
  );

  let ready = false;
  setTimeout(() => {
    ready = true;
  }, 4);
  assert.equal(await waitForOperationCondition(() => ready, 50, 2), true);
});

test('manual draft picks use an exact idempotency key and never trust aggregate draft state alone', () => {
  const pending = {
    overallPick: 8,
    assetKey: 'player:8478402',
    ownerId: 'manager-a',
    submissionId: 'pick_8_exact_request',
  };
  const pick = {
    overallPick: 8,
    round: 1,
    pickInRound: 8,
    ownerId: 'manager-a',
    selectedByUserId: 'manager-a',
    submissionId: 'pick_8_exact_request',
    asset: { assetKey: 'player:8478402' },
  };

  assert.equal(draftPickMatchesPending(pick, pending), true);
  assert.equal(
    draftPickMatchesPending({ ...pick, submissionId: 'different_request' }, pending),
    false,
  );
  assert.equal(
    draftStateShowsPendingPickCommitted(
      {
        status: 'live',
        nextOverallPick: 9,
        lastPickId: '008',
        draftedAssetKeys: ['player:8478402'],
      },
      pending,
    ),
    false,
  );
});

test('Draft Room begins bounded reconciliation quickly and can never leave a full-screen sending-selection lock', async () => {
  const [room, template, styles, clientAuthority] = await Promise.all([
    read('src/app/features/draft/draft-room/draft-room.ts'),
    read('src/app/features/draft/draft-room/draft-room.html'),
    read('src/app/features/draft/draft-room/draft-room.css'),
    read('src/app/core/draft/draft-authority.service.ts'),
  ]);

  assert.match(room, /createDraftPickSubmissionId/);
  assert.match(room, /armPendingPickReconciliationLoop/);
  assert.match(room, /scheduleProbe\(2_500\)/);
  assert.match(room, /scheduleProbe\(4_000\)/);
  assert.match(room, /settleOperationWithin\([\s\S]*getFantasyDraftFromServer[\s\S]*6_000/);
  assert.match(room, /settleOperationWithin\([\s\S]*getDraftPickFromServer[\s\S]*6_000/);
  assert.match(room, /45_000/);
  assert.match(room, /finishPendingPickUncertain/);
  assert.match(room, /this\.pickSubmissionPhase\(\) === 'submitting'/);
  assert.match(template, /draft-pick-sync-dock/);
  assert.match(template, /Check Now/);
  assert.doesNotMatch(template, /draft-pick-submission-shield|appViewportOverlayPortal/);
  assert.doesNotMatch(styles, /draft-pick-submission-shield/);
  assert.match(clientAuthority, /'makeSecureDraftPick'[\s\S]*timeout:\s*25_000/);
});

test('server draft picks safely retry one browser selection and cache immutable draft projections', async () => {
  const [authority, automation, clientModels, serverModels] = await Promise.all([
    read('functions/src/draft-authority.ts'),
    read('functions/src/draft-automation.ts'),
    read('src/app/core/draft/draft.models.ts'),
    read('functions/src/shared/core/draft/draft.models.ts'),
  ]);

  assert.match(authority, /submissionId\?: unknown/);
  assert.match(authority, /expectedOverallPick\?: unknown/);
  assert.match(authority, /draftPickMatchesSubmission/);
  assert.match(authority, /preflightPickSnapshot\.exists/);
  assert.match(authority, /existingPickSnapshot\.exists/);
  assert.match(authority, /submissionId:\s*submissionId \?\? null/);
  assert.match(authority, /requestedOverallPick \?\? preflightDraft\.nextOverallPick/);
  assert.match(clientModels, /submissionId\?:\s*string \| null/);
  assert.match(serverModels, /submissionId\?:\s*string \| null/);

  assert.match(automation, /DRAFT_PROJECTION_CACHE_TTL_MILLISECONDS = 5 \* 60 \* 1000/);
  assert.match(automation, /MAX_DRAFT_PROJECTION_CACHE_ENTRIES = 12/);
  assert.match(automation, /draftProjectionCache = new Map/);
  assert.match(automation, /getCachedDraftProjection/);
  assert.match(automation, /cacheDraftProjection/);
  assert.match(automation, /return projection \? cacheDraftProjection\(leagueId, projection\) : null/);
});

test('Draft Setup uses an exact submission identifier and authoritative bounded confirmation without a blocking screen', async () => {
  const [setup, template, styles, serverAuthority, models] = await Promise.all([
    read('src/app/features/draft/draft-setup/draft-setup.ts'),
    read('src/app/features/draft/draft-setup/draft-setup.html'),
    read('src/app/features/draft/draft-setup/draft-setup.css'),
    read('functions/src/draft-authority.ts'),
    read('src/app/core/draft/draft.models.ts'),
  ]);

  assert.match(setup, /createDraftSettingsSubmissionId/);
  assert.match(setup, /loadSharedProjectionSnapshotMetadata/);
  assert.match(setup, /queueSharedProjectionSnapshotGeneration/);
  assert.match(setup, /7_000/);
  assert.match(setup, /12_000/);
  assert.doesNotMatch(setup, /75_000/);
  assert.match(setup, /awaitDraftSettingsConfirmation/);
  assert.match(setup, /Date\.now\(\) \+ 35_000/);
  assert.match(setup, /getFantasyDraftFromServer/);
  assert.match(setup, /4_000/);
  assert.match(setup, /5_000/);
  assert.match(template, /draft-save-status-dock/);
  assert.doesNotMatch(template, /draft-save-lock|appViewportOverlayPortal/);
  assert.doesNotMatch(styles, /draft-save-lock/);
  assert.match(serverAuthority, /lastSettingsSubmissionId/);
  assert.match(serverAuthority, /That draft-settings submission identifier was already used for different settings/);
  assert.match(models, /lastSettingsSubmissionId\?:\s*string \| null/);

  const expectation = {
    submissionId: 'settings_exact_request',
    roundOneOrder: ['manager-a', 'manager-b'],
    scheduledStartAtMilliseconds: Date.parse('2026-09-20T19:00:00.000Z'),
    pickSeconds: 60,
    status: 'scheduled',
  };
  const draft = {
    status: 'scheduled',
    roundOneOrder: ['manager-a', 'manager-b'],
    scheduledStartAt: new Date(expectation.scheduledStartAtMilliseconds),
    pickSeconds: 60,
    nextOverallPick: 1,
    draftedAssetKeys: [],
    lastSettingsSubmissionId: 'settings_exact_request',
  };

  assert.equal(draftSettingsMatchExpectation(draft, expectation), true);
  assert.equal(
    draftSettingsMatchExpectation(
      { ...draft, lastSettingsSubmissionId: 'another_request' },
      expectation,
    ),
    false,
  );
});

test('shared overlays repair Safari locks and visually release a busy action sheet after a bounded wait', async () => {
  const [sheet, sheetTemplate, portal, app] = await Promise.all([
    read('src/app/shared/action-sheet/action-sheet.ts'),
    read('src/app/shared/action-sheet/action-sheet.html'),
    read('src/app/shared/accessibility/viewport-overlay-portal.directive.ts'),
    read('src/app/app.ts'),
  ]);

  assert.match(sheet, /DEFAULT_BUSY_VISUAL_RELEASE_MILLISECONDS = 12_000/);
  assert.match(sheet, /visualReleased\.set\(true\)/);
  assert.match(sheetTemplate, /open && !visualReleased\(\)/);
  assert.match(portal, /activeViewportOverlays = new Set<HTMLElement>/);
  assert.match(portal, /MutationObserver/);
  assert.match(portal, /!overlay\.isConnected/);
  assert.match(portal, /pageshow/);
  assert.match(portal, /pagehide/);
  assert.match(portal, /popstate/);
  assert.match(app, /NavigationEnd[\s\S]*repairViewportOverlayLock\(\)/);
});

test('roster, waiver, queue, clock, profile, and support callables have bounded local recovery', async () => {
  const [room, team, teamTemplate, freeAgents] = await Promise.all([
    read('src/app/features/draft/draft-room/draft-room.ts'),
    read('src/app/features/team/team-settings/team-settings.ts'),
    read('src/app/features/team/team-settings/team-settings.html'),
    read('src/app/features/free-agents/free-agents.ts'),
  ]);

  assert.match(room, /withOperationDeadline/);
  assert.match(room, /20_000/);
  assert.match(team, /awaitRosterMutationConfirmation/);
  assert.match(team, /20_000/);
  assert.match(teamTemplate, /roster-operation-status-dock/);
  assert.match(freeAgents, /withFreeAgentOperationTimeout/);
  assert.match(freeAgents, /25_000/);
  assert.match(freeAgents, /20_000/);

  const { stdout } = await execFileAsync(
    process.execPath,
    ['scripts/audit-async-operation-safety.mjs'],
    { cwd: root },
  );
  assert.match(stdout, /\d+ browser callables have explicit timeouts/);
});

test('R1D scripts and documentation record the required Functions-first deployment', async () => {
  const [packageJson, docs, recoveryNote] = await Promise.all([
    read('package.json'),
    read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
    read('docs/RINKRAT_ASYNC_OPERATION_RECOVERY.md'),
  ]);

  assert.match(packageJson, /"test:batchr1d:run"/);
  assert.match(packageJson, /"audit:async-operation-safety"/);
  assert.match(packageJson, /"verify:batchr1d"/);
  assert.match(docs, /Batch R1D — Universal Async Recovery and Idempotent Draft Actions/);
  assert.match(recoveryNote, /functions:makeSecureDraftPick,functions:executeDraftCommand/);
  assert.match(recoveryNote, /Functions first/);
  assert.match(recoveryNote, /No Firestore rules, indexes, or data migration/);
});

test('scoring, Projection V11, rules, indexes, and unrelated Functions remain unchanged', async () => {
  assert.equal(
    await sha256('src/app/core/scoring/scoring-rules.ts'),
    'd0ba8838c17737b00cdc5f0dea5e24ffb4e1af2154c2575baf28c3aa83de4901',
  );
  assert.equal(
    await sha256('src/app/core/scoring/scoring-engine.ts'),
    'f9cdb69372437c4cf4e70e678d98227d8777ccc13d37b7ef000ac71ba36d4e15',
  );
  assert.equal(
    await sha256('src/app/core/projection/projection-v11.util.ts'),
    'e6f3111b1feccc7107e857aa24c5317451c65a84a36c71f8158947636f20d80a',
  );
  assert.equal(
    await sha256('firestore.rules'),
    '30feadadcd17e001c22e09b05d36f981847dc756131cdc776246f1617090878a',
  );
  assert.equal(
    await sha256('firestore.indexes.json'),
    'c34b23d20b0756c1d3df1bc4fd6edbdad416dd381d1c7f40fec59c34c17b225b',
  );

  const unchangedFunctions = await hashFunctionTreeExcept(new Set([
    'index.ts',
    'league-lifecycle-authority.ts',
    'league-lifecycle-authority.util.ts',
    'league-automation.ts',
    'draft-authority.ts',
    'draft-automation.ts',
    'shared/core/draft/draft.models.ts',
    'projection-authority.ts',
    'shared/core/projection/projection-asset-catalog.service.ts',
    'shared/core/projection/projection-asset-catalog.util.ts',
    'shared/core/projection/projection-snapshot.service.ts',
    'shared/core/projection/projection-snapshot-hash.util.ts',
    'security-authority.ts',
    'security-operations.ts',
    'shared/security/auth-security.util.ts',

    // S3B intentionally hardens these public security boundaries.

    'email-notifications.ts',

    'manager-profile-authority.ts',

    'roster-authority.ts',

    'roster-moves.ts',

    'shared/core/replay/roster-move-replay-context.util.ts',

    'shared/security/firestore-document-id-core.util.ts',

    'shared/security/firestore-document-id.util.ts',
    'shared/security/firestore-document-id-policies.ts',

    'shared/security/nhl-proxy-security.util.ts',
    // S3E adds isolated monitor-only App Check readiness aggregation.
    'shared/security/app-check-enforcement-readiness.util.ts',
    // B1B adds isolated beta evidence and aggregate operations helpers.
    'beta-operations.ts',
    'shared/core/observability/beta-operations.util.ts',
  ]));
  assert.deepEqual(unchangedFunctions, {
    count: 33,
    digest: '8e98afbd4cb413b93abf7a385cb295b0490e5a28fa71fdcf23243138a42de618',
  });
});
