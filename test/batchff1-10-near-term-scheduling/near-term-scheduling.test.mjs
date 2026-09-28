import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DRAFT_MINIMUM_UNPREPARED_START_LEAD_MILLISECONDS as SERVER_MINIMUM_LEAD,
  getDraftNearTermScheduleGateState,
  getEarliestSafeUnpreparedDraftStartMilliseconds,
} from '../../functions/src/draft-readiness.util.ts';
import {
  DRAFT_MINIMUM_UNPREPARED_START_LEAD_MILLISECONDS as CLIENT_MINIMUM_LEAD,
  getDraftSetupSchedulingGateState,
  getEarliestSafeDraftStartMilliseconds,
  hasStoredExactDraftReadinessForSchedule,
} from '../../src/app/core/draft/draft-scheduling-gate.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function timestamp(milliseconds) {
  return {
    toDate() {
      return new Date(milliseconds);
    },
  };
}

function exactReadyDraft(startMilliseconds) {
  return {
    status: 'scheduled',
    scheduledStartAt: timestamp(startMilliseconds),
    serverDraftReadinessStatus: 'ready',
    serverDraftReadinessScheduledStartAt: timestamp(startMilliseconds),
    serverDraftReadinessAvailabilityRevision: 'a'.repeat(64),
    serverDraftReadinessProjectionRequestId: 'projection-draft-request',
    serverDraftReadinessProjectionSnapshotId: 'projection-snapshot',
    serverDraftReadinessProjectionSnapshotHash: 'b'.repeat(64),
  };
}

test('client and server enforce the same inclusive 40-minute scheduling boundary', () => {
  const now = Date.parse('2026-10-06T01:00:00.000Z');

  assert.equal(SERVER_MINIMUM_LEAD, 40 * 60 * 1000);
  assert.equal(CLIENT_MINIMUM_LEAD, SERVER_MINIMUM_LEAD);
  assert.equal(getDraftNearTermScheduleGateState({
    scheduledStartMilliseconds: now + SERVER_MINIMUM_LEAD,
    nowMilliseconds: now,
    exactReadinessVerified: false,
  }), 'safe-lead');
  assert.equal(getDraftNearTermScheduleGateState({
    scheduledStartMilliseconds: now + SERVER_MINIMUM_LEAD - 1,
    nowMilliseconds: now,
    exactReadinessVerified: false,
  }), 'requires-exact-readiness');
  assert.equal(getDraftNearTermScheduleGateState({
    scheduledStartMilliseconds: now + 2 * 60 * 1000,
    nowMilliseconds: now,
    exactReadinessVerified: true,
  }), 'requires-exact-readiness');
  assert.equal(
    getEarliestSafeUnpreparedDraftStartMilliseconds(now),
    now + SERVER_MINIMUM_LEAD,
  );
});

test('Draft Setup rounds its displayed earliest safe time up to an enterable minute', () => {
  const now = Date.parse('2026-10-06T01:00:41.250Z');
  const exactMinimum = now + CLIENT_MINIMUM_LEAD;
  const displayedMinimum = getEarliestSafeDraftStartMilliseconds(now);

  assert.equal(displayedMinimum, Date.parse('2026-10-06T01:41:00.000Z'));
  assert.ok(displayedMinimum >= exactMinimum);
  assert.equal(displayedMinimum % 60_000, 0);
});

test('exact saved readiness remains inspectable but never bypasses the 40-minute policy', () => {
  const now = Date.parse('2026-10-06T01:00:00.000Z');
  const start = now + 2 * 60 * 1000;
  const ready = exactReadyDraft(start);

  assert.equal(hasStoredExactDraftReadinessForSchedule(ready, start), true);
  assert.equal(getDraftSetupSchedulingGateState({
    draft: ready,
    selectedStartMilliseconds: start,
    nowMilliseconds: now,
  }), 'unsafe-near-term');
  assert.equal(getDraftSetupSchedulingGateState({
    draft: ready,
    selectedStartMilliseconds: start + 60_000,
    nowMilliseconds: now,
  }), 'unsafe-near-term');
  assert.equal(hasStoredExactDraftReadinessForSchedule({
    ...ready,
    serverDraftReadinessProjectionSnapshotHash: null,
  }, start), false);
  assert.equal(hasStoredExactDraftReadinessForSchedule({
    ...ready,
    serverDraftReadinessAvailabilityRevision: 'stale',
  }, start), false);
});

test('Draft Setup exposes the gate before save and no longer queues a browser build', async () => {
  const [component, template, service] = await Promise.all([
    read('src/app/features/draft/draft-setup/draft-setup.ts'),
    read('src/app/features/draft/draft-setup/draft-setup.html'),
    read('src/app/core/draft/draft.service.ts'),
  ]);
  const saveStart = component.indexOf('async saveDraftOrder(): Promise<void>');
  const saveEnd = component.indexOf('private isPossiblyCommittedDraftSettingsError', saveStart);
  const saveBody = component.slice(saveStart, saveEnd);
  const serviceStart = service.indexOf('export async function saveFantasyDraft(');
  const serviceEnd = service.indexOf('export function getScheduledStartDate', serviceStart);
  const serviceBody = service.slice(serviceStart, serviceEnd);

  assert.match(template, /class="preparation-gate rr-notice"/);
  assert.match(template, /aria-live="polite"/);
  assert.match(component, /getEarliestSafeStartText/);
  assert.match(component, /membership and the order can be finalized safely/);
  assert.doesNotMatch(saveBody, /queueSharedProjectionSnapshotGeneration/);
  assert.doesNotMatch(saveBody, /createSharedProjectionGenerationRequestId/);
  assert.doesNotMatch(saveBody, /generationReason: 'draft-setup'/);
  assert.doesNotMatch(serviceBody, /projectionPreparationRequestId/);
});

test('server rejects every changed schedule inside 40 minutes without an immediate-start exception', async () => {
  const authority = await read('functions/src/draft-authority.ts');
  const saveStart = authority.indexOf('async function saveDraftSettings(');
  const saveEnd = authority.indexOf('async function activateScheduledDraft(', saveStart);
  const saveBody = authority.slice(saveStart, saveEnd);
  const transactionIndex = saveBody.indexOf('await db.runTransaction');

  assert.ok(transactionIndex > 0);
  assert.match(saveBody, /initialNearTermGateState === 'requires-exact-readiness'/);
  assert.match(saveBody, /createUnsafeNearTermScheduleError/);
  assert.doesNotMatch(saveBody, /await loadPreparedProjectionSnapshotForScheduledDraft/);
  assert.match(authority, /earliest safe start:/);
  assert.match(authority, /Your existing Draft settings were not changed/);
});

test('changed settings stay stopped and clear old schedule-bound readiness', async () => {
  const authority = await read('functions/src/draft-authority.ts');
  const saveStart = authority.indexOf('async function saveDraftSettings(');
  const saveEnd = authority.indexOf('async function activateScheduledDraft(', saveStart);
  const saveBody = authority.slice(saveStart, saveEnd);

  assert.match(saveBody, /serverDraftReadinessStatus: null/);
  assert.match(saveBody, /serverDraftReadinessScheduleGeneration: null/);
  assert.match(saveBody, /projectionPreparationRequestId: null/);
  assert.match(saveBody, /nextOverallPick: 1/);
  assert.match(saveBody, /draftedAssetKeys: \[\]/);
  assert.match(saveBody, /clockStatus: 'stopped'/);
  assert.match(saveBody, /pickStartedAt: null/);
  assert.match(saveBody, /serverAutomationStatus: status === 'scheduled'/);
});

test('duplicate saves ignore evolving server readiness but reject changed commissioner settings', async () => {
  const authority = await read('functions/src/draft-authority.ts');
  const helperStart = authority.indexOf('function draftSettingsMatchRequest(');
  const helperEnd = authority.indexOf('function createUnsafeNearTermScheduleError(', helperStart);
  const helper = authority.slice(helperStart, helperEnd);

  assert.match(helper, /lastSettingsSubmissionId/);
  assert.match(helper, /scheduledStartMilliseconds/);
  assert.match(helper, /roundOneOrder/);
  assert.match(helper, /pickSeconds/);
  assert.match(helper, /orderMode/);
  assert.doesNotMatch(helper, /projectionPreparation/);
  assert.doesNotMatch(helper, /serverDraftReadiness/);
  assert.match(authority, /already-exists/);
});

test('one schedule and availability revision retains one server request identity', async () => {
  const [automation, projectionAuthority] = await Promise.all([
    read('functions/src/draft-automation.ts'),
    read('functions/src/projection-authority.ts'),
  ]);

  assert.match(automation, /buildDraftReadinessRequestKey\(\{/);
  assert.match(automation, /generationReason\] === 'pre-draft'|generationReason'\] === 'pre-draft'|generationReason\s*===\s*'pre-draft'/);
  assert.match(automation, /queueServerDraftProjectionSnapshotRefresh/);
  assert.match(projectionAuthority, /return \{ status: 'already-queued' as const, requestId: activeRequestId \}/);
  assert.match(projectionAuthority, /const PROJECTION_TASK_MAX_CONCURRENT_DISPATCHES = 2/);
});

test('FF1.26 documentation defines the gate, staging evidence, deployment, and rollback', async () => {
  const [documentation, packageSource, roadmap, docsRoadmap] = await Promise.all([
    read('docs/RINKRAT_FF1_10_NEAR_TERM_SCHEDULING_GATE.md'),
    read('package.json'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
  ]);
  const packageJson = JSON.parse(packageSource);

  for (const value of [
    'Architecture recommendation',
    'Implemented behavior',
    'Acceptance criteria',
    'Edge cases',
    'Tests',
    'Deployment resources',
    'Observability',
    'Rollback',
    'Production Scoring V4',
    'Projection V11',
    'six-game',
    'Game 7',
    'exact-once',
    '429',
  ]) {
    assert.match(documentation, new RegExp(value, 'i'));
  }

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /FF1\.26 near-term Draft scheduling gate/);
  assert.match(packageJson.scripts['verify:batchff1-10:core'], /verify:batchff1-9:core/);

  const deploymentSection = documentation.slice(
    documentation.indexOf('## Deployment resources'),
    documentation.indexOf('## Observability'),
  );
  assert.ok(
    deploymentSection.indexOf('functions:executeDraftCommand') <
      deploymentSection.indexOf('hosting:app'),
  );
  assert.match(
    deploymentSection,
    /functions:processProjectionGenerationTask[\s\S]*must not be deployed/,
  );
});
