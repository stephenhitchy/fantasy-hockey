import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DRAFT_AVAILABILITY_MAX_AGE_MILLISECONDS,
  DRAFT_READINESS_WINDOW_MILLISECONDS,
  buildDraftReadinessRequestKey,
  draftReadinessMatchesSchedule,
  getDraftReadinessWindowState,
  isDraftAvailabilityEvidenceUsable,
} from '../../functions/src/draft-readiness.util.ts';
import {
  createServerProjectionRequestId,
} from '../../functions/src/shared/core/projection/projection-snapshot-hash.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

test('server preparation starts at the inclusive 20-minute boundary and remains due after zero', () => {
  const start = Date.parse('2026-10-06T02:00:00.000Z');
  const base = {
    draftStatus: 'scheduled',
    scheduledStartMilliseconds: start,
  };

  assert.equal(DRAFT_READINESS_WINDOW_MILLISECONDS, 20 * 60 * 1000);
  assert.equal(getDraftReadinessWindowState({
    ...base,
    nowMilliseconds: start - DRAFT_READINESS_WINDOW_MILLISECONDS - 1,
  }), 'outside-window');
  assert.equal(getDraftReadinessWindowState({
    ...base,
    nowMilliseconds: start - DRAFT_READINESS_WINDOW_MILLISECONDS,
  }), 'prepare');
  assert.equal(getDraftReadinessWindowState({
    ...base,
    nowMilliseconds: start - 1,
  }), 'prepare');
  assert.equal(getDraftReadinessWindowState({
    ...base,
    nowMilliseconds: start,
  }), 'start-due');
  assert.equal(getDraftReadinessWindowState({
    ...base,
    nowMilliseconds: start + 1,
  }), 'start-due');
  assert.equal(getDraftReadinessWindowState({
    ...base,
    draftStatus: 'live',
    nowMilliseconds: start,
  }), 'unavailable');
});

test('availability evidence fails closed when missing, future-dated, stale, or from another UTC day', () => {
  const now = Date.parse('2026-10-06T23:59:00.000Z');
  const revision = 'a'.repeat(64);

  assert.equal(DRAFT_AVAILABILITY_MAX_AGE_MILLISECONDS, 24 * 60 * 60 * 1000);
  assert.equal(isDraftAvailabilityEvidenceUsable({
    revision,
    lastSuccessfulAt: '2026-10-06T00:00:00.000Z',
    lastDailySyncKey: '2026-10-06',
    status: 'success',
    nowMilliseconds: now,
  }), true);
  assert.equal(isDraftAvailabilityEvidenceUsable({
    revision,
    lastSuccessfulAt: new Date(now - DRAFT_AVAILABILITY_MAX_AGE_MILLISECONDS - 1).toISOString(),
    lastDailySyncKey: '2026-10-06',
    status: 'success',
    nowMilliseconds: now,
  }), false);
  assert.equal(isDraftAvailabilityEvidenceUsable({
    revision,
    lastSuccessfulAt: new Date(now + 1).toISOString(),
    lastDailySyncKey: '2026-10-06',
    status: 'success',
    nowMilliseconds: now,
  }), false);
  assert.equal(isDraftAvailabilityEvidenceUsable({
    revision: null,
    lastSuccessfulAt: new Date(now).toISOString(),
    lastDailySyncKey: '2026-10-06',
    status: 'success',
    nowMilliseconds: now,
  }), false);
  assert.equal(isDraftAvailabilityEvidenceUsable({
    revision,
    lastSuccessfulAt: new Date(now).toISOString(),
    lastDailySyncKey: '2026-10-05',
    status: 'success',
    nowMilliseconds: now,
  }), false);
  assert.equal(isDraftAvailabilityEvidenceUsable({
    revision,
    lastSuccessfulAt: new Date(now).toISOString(),
    lastDailySyncKey: '2026-10-06',
    status: 'running',
    nowMilliseconds: now,
  }), false);
});

test('request identity is deterministic and changes with schedule or availability', () => {
  const base = {
    leagueId: 'league-1',
    scheduledStartMilliseconds: 1_800_000,
    availabilityRevision: 'b'.repeat(64),
  };
  const first = buildDraftReadinessRequestKey(base);

  assert.equal(first, buildDraftReadinessRequestKey(base));
  assert.notEqual(first, buildDraftReadinessRequestKey({
    ...base,
    scheduledStartMilliseconds: base.scheduledStartMilliseconds + 1,
  }));
  assert.notEqual(first, buildDraftReadinessRequestKey({
    ...base,
    availabilityRevision: 'c'.repeat(64),
  }));
  assert.equal(draftReadinessMatchesSchedule({
    readinessScheduledStartMilliseconds: 100,
    scheduledStartMilliseconds: 100,
  }), true);
  assert.equal(draftReadinessMatchesSchedule({
    readinessScheduledStartMilliseconds: 100,
    scheduledStartMilliseconds: 101,
  }), false);
});

test('Draft request identity extends but does not change legacy replay identities', () => {
  const legacyIdentity = 'league-1:replay-key:1';
  const expectedLegacyId = `projection-replay-${createHash('sha256')
    .update(legacyIdentity)
    .digest('hex')
    .slice(0, 32)}`;
  const replayId = createServerProjectionRequestId({
    requestPrefix: 'projection-replay',
    leagueId: 'league-1',
    requestKey: 'replay-key',
    targetCycleNumber: 1,
  });
  const draftId = createServerProjectionRequestId({
    requestPrefix: 'projection-draft',
    leagueId: 'league-1',
    requestKey: 'replay-key',
    targetCycleNumber: 1,
    availabilityRevision: 'd'.repeat(64),
  });

  assert.equal(replayId, expectedLegacyId);
  assert.notEqual(draftId, replayId.replace('projection-replay-', 'projection-draft-'));
});

test('scheduled automation prepares before opening and keeps the clock fail-closed', async () => {
  const source = await read('functions/src/draft-automation.ts');
  const prepareIndex = source.indexOf('await prepareScheduledDraftReadiness(leagueId, draft)');
  const openIndex = source.indexOf('opened = await openScheduledDraftIfReady(leagueId)', prepareIndex);

  assert.ok(prepareIndex > 0);
  assert.ok(openIndex > prepareIndex);
  assert.match(source, /loadPreparedProjectionSnapshotForScheduledDraft\(leagueId, initialDraft\)/);
  assert.match(source, /serverDraftReadinessStatus !== 'ready'/);
  assert.match(source, /serverDraftReadinessProjectionSnapshotId[\s\S]*?projection\.metadata\.activeSnapshotId/);
  assert.match(source, /serverDraftReadinessAvailabilityRevision[\s\S]*?projection\.metadata\.availabilityRevision/);
  assert.match(source, /serverDraftReadinessProjectionRequestId[\s\S]*?projection\.metadata\.generationRequestId/);
  assert.match(source, /status: 'live',[\s\S]*?startedAt: FieldValue\.serverTimestamp\(\)/);
});

test('preparation is durable, retryable, and duplicate-safe without changing worker limits', async () => {
  const [automation, projectionAuthority] = await Promise.all([
    read('functions/src/draft-automation.ts'),
    read('functions/src/projection-authority.ts'),
  ]);

  assert.match(automation, /buildDraftReadinessRequestKey/);
  assert.match(automation, /serverDraftReadinessAttemptCount/);
  assert.match(automation, /getDraftReadinessRetryDelayMilliseconds/);
  assert.match(automation, /serverDraftReadinessRetryAfterAt/);
  assert.match(automation, /The clock remains locked and the server will retry automatically/);
  assert.match(projectionAuthority, /requestPrefix: 'projection-draft'/);
  assert.match(projectionAuthority, /generationReason: 'pre-draft'/);
  assert.match(projectionAuthority, /availabilityRevision: input\.availabilityRevision \?\? null/);
  assert.match(projectionAuthority, /activeRequestId !== requestId/);
  assert.match(projectionAuthority, /return \{ status: 'already-queued' as const, requestId: activeRequestId \}/);
  assert.match(projectionAuthority, /maxConcurrentDispatches: PROJECTION_TASK_MAX_CONCURRENT_DISPATCHES/);
  assert.match(projectionAuthority, /const PROJECTION_TASK_MAX_CONCURRENT_DISPATCHES = 2/);
  assert.match(automation, /maxInstances: 1/);
});

test('Projection V11 records and verifies the exact availability input without changing its version', async () => {
  const [projection, authority] = await Promise.all([
    read('functions/src/shared/core/projection/projection-snapshot.service.ts'),
    read('functions/src/projection-authority.ts'),
  ]);

  assert.match(projection, /export const SHARED_PROJECTION_VERSION = 11/);
  assert.match(projection, /expectedAvailabilityRevision/);
  assert.match(projection, /context\.availabilityRevision !== input\.expectedAvailabilityRevision/);
  assert.match(projection, /availabilityRevision: context\.availabilityRevision/);
  assert.match(projection, /createHash\('sha256'\)[\s\S]*?lastDailySyncKey[\s\S]*?records: orderedRecords/);
  assert.match(projection, /globalSnapshot\?\.exists\(\) && manualSnapshot !== null/);
  assert.match(authority, /expectedAvailabilityRevision: claimed\.availabilityRevision/);
});

test('manual activation and client presentation use the same server readiness evidence', async () => {
  const [authority, component, clientModel, serverModel] = await Promise.all([
    read('functions/src/draft-authority.ts'),
    read('src/app/features/draft/draft-room/draft-room.ts'),
    read('src/app/core/draft/draft.models.ts'),
    read('functions/src/shared/core/draft/draft.models.ts'),
  ]);

  assert.match(authority, /loadPreparedProjectionSnapshotForScheduledDraft/);
  assert.match(authority, /Draft readiness changed before the clock could start/);
  assert.match(component, /Server Draft Data Ready/);
  assert.match(component, /Server Preparing Draft Data/);
  assert.match(component, /Preparation Retry Scheduled/);
  assert.match(component, /serverDraftReadinessMessage/);
  assert.match(component, /return serverStatus === 'ready'/);
  assert.doesNotMatch(component, /this\.preDraftPreparationReady\(\)/);
  assert.match(clientModel, /serverDraftReadinessStatus/);
  assert.match(serverModel, /serverDraftReadinessStatus/);
});

test('FF1.19 documentation preserves release boundaries and protected contracts', async () => {
  const [rootRoadmap, docsRoadmap, implementationDoc] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_FF1_3_DRAFT_READINESS.md'),
  ]);

  assert.equal(rootRoadmap, docsRoadmap);
  assert.match(rootRoadmap, /\[~\] FF1\.19/);
  for (const contract of [
    'Production Scoring V4',
    'Projection V11',
    'six-game',
    'Game 7',
    'Rules',
    'indexes',
    'TTL',
    'App Check',
    'worker',
  ]) {
    assert.match(implementationDoc, new RegExp(contract));
  }
  assert.match(implementationDoc, /functions:runScheduledDraftAutomation/);
  assert.match(implementationDoc, /functions:processProjectionGenerationTask/);
  assert.match(implementationDoc, /functions:executeDraftCommand/);
  assert.match(implementationDoc, /hosting:app/);
});
