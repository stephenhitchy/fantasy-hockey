import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DRAFT_AUTOMATION_EXPECTED_SCAN_INTERVAL_MILLISECONDS,
  DRAFT_AUTOMATION_HEALTH_MAX_FRESHNESS_MILLISECONDS,
  DRAFT_AUTOMATION_IDLE_HEARTBEAT_DUE_MILLISECONDS,
  getDraftAutomationHealthWriteDecision,
} from '../../functions/src/draft-automation-health.util.ts';

const ROOT = new URL('../../', import.meta.url);

function emptySuccess(overrides = {}) {
  return {
    schemaVersion: 1,
    status: 'success',
    activeDraftCount: 0,
    picksMade: 0,
    failedDraftCount: 0,
    failures: [],
    ...overrides,
  };
}

test('fresh identical healthy empty scans suppress duplicate health writes and logs', () => {
  const nowMilliseconds = Date.UTC(2026, 9, 21, 12, 0, 0);

  assert.deepEqual(getDraftAutomationHealthWriteDecision({
    current: emptySuccess(),
    previous: emptySuccess(),
    previousLastRunMilliseconds:
      nowMilliseconds - DRAFT_AUTOMATION_IDLE_HEARTBEAT_DUE_MILLISECONDS + 1,
    nowMilliseconds,
  }), {
    shouldWrite: false,
    reason: 'empty-repeat-suppressed',
  });
});

test('an idle heartbeat writes when its bounded freshness reserve is due', () => {
  const nowMilliseconds = Date.UTC(2026, 9, 21, 12, 0, 0);

  assert.equal(
    DRAFT_AUTOMATION_IDLE_HEARTBEAT_DUE_MILLISECONDS +
      DRAFT_AUTOMATION_EXPECTED_SCAN_INTERVAL_MILLISECONDS,
    DRAFT_AUTOMATION_HEALTH_MAX_FRESHNESS_MILLISECONDS,
  );
  assert.equal(DRAFT_AUTOMATION_HEALTH_MAX_FRESHNESS_MILLISECONDS, 4 * 60 * 1000);
  assert.deepEqual(getDraftAutomationHealthWriteDecision({
    current: emptySuccess(),
    previous: emptySuccess(),
    previousLastRunMilliseconds:
      nowMilliseconds - DRAFT_AUTOMATION_IDLE_HEARTBEAT_DUE_MILLISECONDS,
    nowMilliseconds,
  }), {
    shouldWrite: true,
    reason: 'heartbeat-due',
  });
});

test('returning from active work to empty health writes the state transition immediately', () => {
  const nowMilliseconds = Date.UTC(2026, 9, 21, 12, 0, 0);

  assert.deepEqual(getDraftAutomationHealthWriteDecision({
    current: emptySuccess(),
    previous: emptySuccess({ activeDraftCount: 1 }),
    previousLastRunMilliseconds: nowMilliseconds - 1_000,
    nowMilliseconds,
  }), {
    shouldWrite: true,
    reason: 'state-transition',
  });
});

test('failures always write immediately even when the prior failure is identical', () => {
  const nowMilliseconds = Date.UTC(2026, 9, 21, 12, 0, 0);
  const failure = emptySuccess({
    status: 'partial-error',
    activeDraftCount: 1,
    failedDraftCount: 1,
    failures: [{ leagueId: 'league-a', message: 'fixture failure' }],
  });

  assert.deepEqual(getDraftAutomationHealthWriteDecision({
    current: failure,
    previous: failure,
    previousLastRunMilliseconds: nowMilliseconds - 1_000,
    nowMilliseconds,
  }), {
    shouldWrite: true,
    reason: 'failure',
  });
});

test('active Draft work is never coalesced and the recovery scan contract is unchanged', async () => {
  const nowMilliseconds = Date.UTC(2026, 9, 21, 12, 0, 0);
  const active = emptySuccess({ activeDraftCount: 1 });

  assert.deepEqual(getDraftAutomationHealthWriteDecision({
    current: active,
    previous: active,
    previousLastRunMilliseconds: nowMilliseconds - 1_000,
    nowMilliseconds,
  }), {
    shouldWrite: true,
    reason: 'active-work',
  });

  const source = await readFile(
    new URL('functions/src/draft-automation.ts', ROOT),
    'utf8',
  );
  const workerStart = source.indexOf('export const runScheduledDraftAutomation');
  const workerEnd = source.indexOf('async function processDraftQueueWarmupTask', workerStart);
  const worker = source.slice(workerStart, workerEnd);

  assert.match(worker, /schedule:\s*'\* \* \* \* \*'/);
  assert.match(worker, /maxInstances:\s*1/);
  assert.ok(worker.indexOf('getAutomatedDraftLeagueIds()') >= 0);
  assert.ok(
    worker.indexOf('getAutomatedDraftLeagueIds()') <
      worker.indexOf('processLeagueDraftAutomation(leagueId)'),
  );
  assert.ok(
    worker.indexOf('processLeagueDraftAutomation(leagueId)') <
      worker.indexOf('getDraftAutomationHealthWriteDecision'),
  );
});
