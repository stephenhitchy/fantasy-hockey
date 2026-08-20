import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import {
  buildCommissionerAvailabilityLeagueActivity,
  buildCommissionerDraftControlLeagueActivity,
  getLeagueActivityDocumentId,
} from '../../functions/src/shared/core/league/league-activity.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function commissionerAvailability(overrides = {}) {
  return {
    playerId: 8478402,
    playerName: 'Jack Hughes',
    status: 'out',
    note: 'Private commissioner context that must never reach League Wire.',
    irEligible: true,
    updatedBy: 'commissioner-owner',
    source: 'commissioner',
    leagueId: 'private-league-id',
    requestId: 'private-request-id',
    ...overrides,
  };
}

function draftState(overrides = {}) {
  return {
    status: 'live',
    clockStatus: 'running',
    nextOverallPick: 12,
    clockUpdatedBy: 'commissioner-owner',
    serverAutomationMessage: 'Private operational context.',
    projectionSnapshotId: 'private-projection-id',
    requestId: 'private-request-id',
    ...overrides,
  };
}

test('commissioner activity identities are deterministic and hide raw trigger identities', () => {
  for (const sourceKind of ['commissioner-availability', 'draft-control']) {
    const first = getLeagueActivityDocumentId(sourceKind, 'private-cloud-event-id');
    const second = getLeagueActivityDocumentId(sourceKind, 'private-cloud-event-id');

    assert.equal(first, second);
    assert.match(first, /^activity-[a-f0-9]{40}$/);
    assert.equal(first.includes('private-cloud-event-id'), false);
  }
});

test('availability changes publish only the commissioner, bounded player name, and public status', () => {
  const activity = buildCommissionerAvailabilityLeagueActivity(
    null,
    commissionerAvailability(),
    'commissioner-owner',
  );

  assert.ok(activity);
  assert.equal(activity.category, 'commissioner');
  assert.equal(activity.eventType, 'commissioner-availability-override-set');
  assert.equal(activity.ownerId, 'commissioner-owner');
  assert.equal(activity.availabilityPlayerName, 'Jack Hughes');
  assert.equal(activity.availabilityStatus, 'out');

  const serialized = JSON.stringify(activity);
  assert.equal(serialized.includes('Private commissioner context'), false);
  assert.equal(serialized.includes('private-request-id'), false);
  assert.equal(serialized.includes('private-league-id'), false);
  assert.equal(serialized.includes('8478402'), false);
});

test('availability note-only edits stay quiet while competitive status changes publish', () => {
  const before = commissionerAvailability({ note: 'Original note.' });

  assert.equal(buildCommissionerAvailabilityLeagueActivity(
    before,
    commissionerAvailability({ note: 'Changed note only.' }),
    'commissioner-owner',
  ), null);

  const changed = buildCommissionerAvailabilityLeagueActivity(
    before,
    commissionerAvailability({
      status: 'injured-reserve',
      note: 'Still private.',
    }),
    'commissioner-owner',
  );

  assert.ok(changed);
  assert.equal(changed.availabilityStatus, 'injured-reserve');
});

test('availability deletion publishes one sanitized clear while invalid actors and statuses fail closed', () => {
  const cleared = buildCommissionerAvailabilityLeagueActivity(
    commissionerAvailability(),
    null,
    'commissioner-owner',
  );

  assert.ok(cleared);
  assert.equal(cleared.eventType, 'commissioner-availability-override-cleared');
  assert.equal(cleared.availabilityPlayerName, 'Jack Hughes');
  assert.equal(cleared.availabilityStatus, null);

  assert.equal(buildCommissionerAvailabilityLeagueActivity(
    null,
    commissionerAvailability({ updatedBy: 'ordinary-manager' }),
    'commissioner-owner',
  ), null);
  assert.equal(buildCommissionerAvailabilityLeagueActivity(
    null,
    commissionerAvailability({ source: 'espn' }),
    'commissioner-owner',
  ), null);
  assert.equal(buildCommissionerAvailabilityLeagueActivity(
    null,
    commissionerAvailability({ status: 'secret-status' }),
    'commissioner-owner',
  ), null);
});

test('Draft opening, pause, and resume transitions publish bounded commissioner outcomes', () => {
  const opened = buildCommissionerDraftControlLeagueActivity(
    draftState({ status: 'scheduled', clockStatus: 'waiting', clockUpdatedBy: null }),
    draftState({ status: 'live', clockStatus: 'running', nextOverallPick: 1 }),
    'commissioner-owner',
  );
  const paused = buildCommissionerDraftControlLeagueActivity(
    draftState({ clockStatus: 'running' }),
    draftState({ clockStatus: 'paused' }),
    'commissioner-owner',
  );
  const resumed = buildCommissionerDraftControlLeagueActivity(
    draftState({ clockStatus: 'paused' }),
    draftState({ clockStatus: 'running' }),
    'commissioner-owner',
  );

  assert.equal(opened?.eventType, 'commissioner-draft-opened');
  assert.equal(opened?.overallPick, 1);
  assert.equal(paused?.eventType, 'commissioner-draft-clock-paused');
  assert.equal(paused?.overallPick, 12);
  assert.equal(resumed?.eventType, 'commissioner-draft-clock-resumed');
  assert.equal(resumed?.overallPick, 12);

  for (const activity of [opened, paused, resumed]) {
    const serialized = JSON.stringify(activity);
    assert.equal(serialized.includes('Private operational context'), false);
    assert.equal(serialized.includes('private-projection-id'), false);
    assert.equal(serialized.includes('private-request-id'), false);
  }
});

test('automatic Draft actions, first-manager starts, failed transitions, and non-commissioners stay off the wire', () => {
  assert.equal(buildCommissionerDraftControlLeagueActivity(
    draftState({ status: 'scheduled', clockStatus: 'waiting', clockUpdatedBy: null }),
    draftState({ clockUpdatedBy: 'server:draft-automation' }),
    'commissioner-owner',
  ), null);
  assert.equal(buildCommissionerDraftControlLeagueActivity(
    draftState({ clockStatus: 'waiting', clockUpdatedBy: null }),
    draftState({ clockStatus: 'running', clockUpdatedBy: 'first-manager' }),
    'commissioner-owner',
  ), null);
  assert.equal(buildCommissionerDraftControlLeagueActivity(
    draftState({ clockStatus: 'running' }),
    draftState({ clockStatus: 'running' }),
    'commissioner-owner',
  ), null);
  assert.equal(buildCommissionerDraftControlLeagueActivity(
    draftState({ clockStatus: 'running' }),
    draftState({ clockStatus: 'paused', clockUpdatedBy: 'ordinary-manager' }),
    'commissioner-owner',
  ), null);
});

test('the two create-only publishers verify the live commissioner and reuse League Wire authority', async () => {
  const [publisher, index, functionsPackageSource] = await Promise.all([
    read('functions/src/league-activity.ts'),
    read('functions/src/index.ts'),
    read('functions/package.json'),
  ]);
  const functionsPackage = JSON.parse(functionsPackageSource);

  assert.match(publisher, /export const publishLeagueAvailabilityOverrideActivity = onDocumentWritten/);
  assert.match(publisher, /leagues\/\{leagueId\}\/playerAvailability\/\{playerId\}/);
  assert.match(publisher, /export const publishLeagueDraftControlActivity = onDocumentUpdated/);
  assert.match(publisher, /leagues\/\{leagueId\}\/draft\/current/);
  assert.match(publisher, /getLeagueCommissionerId/);
  assert.match(publisher, /leagueSnapshot\.data\(\)\?\.\['commissionerId'\]/);
  assert.match(publisher, /resolveSourceDocumentId\(\s*event\.id,\s*'commissioner-availability'/);
  assert.match(publisher, /resolveSourceDocumentId\(event\.id, 'draft-control'\)/);
  assert.match(publisher, /release:\s*'Social Batch C1D'/);
  assert.match(publisher, /if \(existing\.exists\)/);
  assert.match(publisher, /transaction\.create\(activityReference/);
  assert.match(index, /publishLeagueAvailabilityOverrideActivity/);
  assert.match(index, /publishLeagueDraftControlActivity/);
  assert.match(functionsPackage.scripts.logs, /publishLeagueAvailabilityOverrideActivity/);
  assert.match(functionsPackage.scripts.logs, /publishLeagueDraftControlActivity/);
});

test('League Wire renders commissioner outcomes without another listener or blocking mobile surface', async () => {
  const [service, component, template, styles] = await Promise.all([
    read('src/app/core/league/league-activity.service.ts'),
    read('src/app/features/leagues/league-wire/league-wire.ts'),
    read('src/app/features/leagues/league-wire/league-wire.html'),
    read('src/app/features/leagues/league-wire/league-wire.css'),
  ]);

  assert.match(service, /'commissioner'/);
  assert.match(service, /'commissioner-availability-override-set'/);
  assert.match(service, /'commissioner-draft-clock-resumed'/);
  assert.match(service, /orderBy\('occurredAt', 'desc'\)/);
  assert.match(service, /limit\(LEAGUE_ACTIVITY_LIMIT\)/);
  assert.match(component, /marked \${playerName} \${statusLabel}/);
  assert.match(component, /cleared \${playerName}'s availability override/);
  assert.match(component, /opened the Draft/);
  assert.match(component, /paused the Draft clock/);
  assert.match(component, /resumed the Draft clock/);
  assert.match(component, /Commissioner/);
  assert.doesNotMatch(template, /Commissioner notes and failed attempts stay off the wire/);
  assert.match(styles, /data-category='commissioner'/);
  assert.doesNotMatch(template, /role="dialog"|viewport-overlay|action-sheet/i);
  assert.doesNotMatch(styles, /position:\s*(?:fixed|sticky)|backdrop-filter/i);
  assert.equal((service.match(/onSnapshot\(/g) ?? []).length, 2);
});

test('C1D remains intact under RC34 while preserving competitive models, Rules, indexes, and safety modes', async () => {
  const [
    scoringRules,
    scoringEngine,
    projectionV11,
    firestoreRules,
    firestoreIndexes,
    runtime,
    productionRuntime,
    freezeSource,
    appCheckSource,
    canarySource,
    cacheSource,
    packageSource,
  ] = await Promise.all([
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/scoring/scoring-engine.ts'),
    read('src/app/core/projection/projection-v11.util.ts'),
    read('firestore.rules'),
    read('firestore.indexes.json'),
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('config/release-freeze/beta-freeze-policy.json'),
    read('config/app-check-enforcement-readiness.json'),
    read('config/app-check-callable-canary.json'),
    read('config/nhl-shared-cache-policy.json'),
    read('package.json'),
  ]);
  const freeze = JSON.parse(freezeSource);
  const appCheck = JSON.parse(appCheckSource);
  const canary = JSON.parse(canarySource);
  const cache = JSON.parse(cacheSource);
  const packageJson = JSON.parse(packageSource);

  assert.equal(createHash('sha256').update(scoringRules).digest('hex'), PROTECTED_SOURCE_HASHES.scoringRules);
  assert.equal(createHash('sha256').update(scoringEngine).digest('hex'), PROTECTED_SOURCE_HASHES.scoringEngine);
  assert.equal(createHash('sha256').update(projectionV11).digest('hex'), PROTECTED_SOURCE_HASHES.projectionV11);
  assert.equal(createHash('sha256').update(firestoreRules).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreRules);
  assert.equal(createHash('sha256').update(firestoreIndexes).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreIndexes);
  assert.match(runtime, /Release Candidate 56/);
  assert.match(productionRuntime, /Release Candidate 56/);
  assert.equal(freeze.scoringRulesVersion, 4);
  assert.equal(freeze.projectionVersion, 11);
  assert.equal(freeze.requiredGamesPerRosterSlot, 6);
  assert.equal(freeze.queueMode, 'shadow');
  assert.equal(freeze.appCheckMode, 'monitor');
  assert.equal(freeze.verificationCommand, 'npm run verify:batcho1f');
  assert.equal(appCheck.mode, 'monitor');
  assert.equal(canary.automaticPromotion, false);
  assert.equal(cache.mode, 'shadow');
  assert.equal(cache.authoritativeReadsEnabled, false);
  assert.match(packageJson.scripts['verify:batchc1d:core'], /verify:batchc1c:core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batcho1f:core/);
});

test('C1D documentation and roadmap record the bounded transparency slice and simple owner workflow', async () => {
  const [roadmap, docsRoadmap, runbook, readme, releaseRunbook] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_SOCIAL_C1D_COMMISSIONER_TRANSPARENCY.md'),
    read('README.md'),
    read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
  ]);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.47/);
  assert.match(roadmap, /# \[x\] C1\.2/);
  assert.match(roadmap, /# \[x\] C1\.16/);
  assert.match(roadmap, /# \[x\] LOG\.36/);
  assert.match(runbook, /commissioner note/i);
  assert.match(runbook, /note-only edit creates no activity/i);
  assert.match(runbook, /Automatic scheduled openings/);
  assert.match(runbook, /one automated verification gate/i);
  assert.match(runbook, /functions:publishLeagueAvailabilityOverrideActivity,functions:publishLeagueDraftControlActivity/);
  assert.match(runbook, /Do not deploy Firestore Rules, indexes, TTL configuration/);
  assert.match(runbook, /Site-first smoke test/);
  assert.match(readme, /Release Candidate 56 \/ Operations Batch O1F/);
  assert.match(readme, /RINKRAT_SOCIAL_C1D_COMMISSIONER_TRANSPARENCY\.md/);
  assert.match(releaseRunbook, /npm run verify:batcho1f/);
  assert.match(releaseRunbook, /rinkrat-rc56-validation\.json/);
  assert.match(releaseRunbook, /rinkrat-rc56-invite-beta/);
});
