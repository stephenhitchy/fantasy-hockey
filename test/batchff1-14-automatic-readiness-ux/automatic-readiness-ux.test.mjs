import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  getDraftProjectionPoolBinding,
  getDraftProjectionPoolBindingKey,
  getDraftProjectionPoolSource,
  shouldReloadDraftProjectionPool,
} from '../../src/app/features/draft/draft-room/draft-projection-pool-binding.util.ts';

const ROOT = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), 'utf8');
const START = Date.parse('2026-10-06T01:00:00.000Z');
const HASH = 'a'.repeat(64);
const AVAILABILITY = 'b'.repeat(64);

function timestamp(milliseconds) {
  return {
    milliseconds,
    toDate() {
      return new Date(this.milliseconds);
    },
  };
}

function readyScheduledDraft(overrides = {}) {
  return {
    status: 'scheduled',
    scheduledStartAt: timestamp(START),
    serverDraftReadinessStatus: 'ready',
    serverDraftReadinessScheduledStartAt: timestamp(START),
    serverDraftReadinessAvailabilityRevision: AVAILABILITY,
    serverDraftReadinessProjectionRequestId: 'draft-projection-request',
    serverDraftReadinessProjectionSnapshotId: 'draft-projection-snapshot',
    serverDraftReadinessProjectionSnapshotHash: HASH,
    ...overrides,
  };
}

test('scheduled Draft pool binding requires exact complete server readiness', () => {
  assert.deepEqual(getDraftProjectionPoolBinding(readyScheduledDraft()), {
    snapshotId: 'draft-projection-snapshot',
    snapshotHash: HASH,
  });

  assert.equal(getDraftProjectionPoolBinding(readyScheduledDraft({
    serverDraftReadinessScheduledStartAt: timestamp(START + 60_000),
  })), null);
  assert.equal(getDraftProjectionPoolBinding(readyScheduledDraft({
    serverDraftReadinessStatus: 'preparing-projection',
  })), null);
  assert.equal(getDraftProjectionPoolBinding(readyScheduledDraft({
    serverDraftReadinessProjectionSnapshotHash: 'incomplete',
  })), null);
});

test('live and complete Drafts use only their frozen server binding', () => {
  const frozen = {
    status: 'live',
    serverDraftProjectionSnapshotId: 'frozen-snapshot',
    serverDraftProjectionSnapshotHash: HASH,
  };

  assert.deepEqual(getDraftProjectionPoolBinding(frozen), {
    snapshotId: 'frozen-snapshot',
    snapshotHash: HASH,
  });
  assert.deepEqual(getDraftProjectionPoolBinding({ ...frozen, status: 'complete' }), {
    snapshotId: 'frozen-snapshot',
    snapshotHash: HASH,
  });
  assert.equal(getDraftProjectionPoolBinding({
    ...frozen,
    serverDraftProjectionSnapshotHash: null,
  }), null);
  assert.deepEqual(getDraftProjectionPoolSource({
    ...frozen,
    serverDraftProjectionSnapshotHash: null,
  }), { kind: 'invalid-frozen-binding' });
});

test('only Draft setup can use the league-wide shared projection pointer', () => {
  assert.deepEqual(getDraftProjectionPoolSource(null), { kind: 'shared' });
  assert.deepEqual(getDraftProjectionPoolSource({ status: 'setup' }), { kind: 'shared' });
  assert.deepEqual(getDraftProjectionPoolSource(readyScheduledDraft({
    serverDraftReadinessStatus: 'preparing-projection',
  })), { kind: 'waiting-for-readiness' });
  assert.deepEqual(getDraftProjectionPoolSource(readyScheduledDraft()), {
    kind: 'exact',
    binding: {
      snapshotId: 'draft-projection-snapshot',
      snapshotHash: HASH,
    },
  });
});

test('the same exact readiness and frozen board share one reload identity', () => {
  const scheduled = readyScheduledDraft();
  const live = {
    status: 'live',
    serverDraftProjectionSnapshotId:
      scheduled.serverDraftReadinessProjectionSnapshotId,
    serverDraftProjectionSnapshotHash:
      scheduled.serverDraftReadinessProjectionSnapshotHash,
  };

  assert.equal(
    getDraftProjectionPoolBindingKey(scheduled),
    getDraftProjectionPoolBindingKey(live),
  );
});

test('reload decisions ignore repeated delivery and react to first, ready, invalidated, and live states', () => {
  const same = {
    hadObservedDraftSnapshot: true,
    previousStatus: 'scheduled',
    nextStatus: 'scheduled',
    previousBindingKey: `snapshot:${HASH}`,
    nextBindingKey: `snapshot:${HASH}`,
  };

  assert.equal(shouldReloadDraftProjectionPool(same), false);
  assert.equal(shouldReloadDraftProjectionPool({
    ...same,
    hadObservedDraftSnapshot: false,
  }), true);
  assert.equal(shouldReloadDraftProjectionPool({
    ...same,
    previousBindingKey: null,
  }), true);
  assert.equal(shouldReloadDraftProjectionPool({
    ...same,
    nextBindingKey: null,
  }), true);
  assert.equal(shouldReloadDraftProjectionPool({
    ...same,
    previousStatus: 'setup',
    nextStatus: 'scheduled',
    previousBindingKey: null,
    nextBindingKey: null,
  }), true);
  assert.equal(shouldReloadDraftProjectionPool({
    ...same,
    previousStatus: 'scheduled',
    nextStatus: 'live',
  }), true);
  assert.equal(shouldReloadDraftProjectionPool({
    ...same,
    previousStatus: 'scheduled',
    nextStatus: 'setup',
    previousBindingKey: null,
    nextBindingKey: null,
  }), true);
});

test('the existing Draft listener automatically reloads exact readiness without a new listener', async () => {
  const source = await read('src/app/features/draft/draft-room/draft-room.ts');
  const listenerStart = source.indexOf('this.stopDraftListener = listenToFantasyDraft(');
  const listenerEnd = source.indexOf('this.stopPickListener = listenToDraftPicks(', listenerStart);
  const listener = source.slice(listenerStart, listenerEnd);

  assert.match(listener, /getDraftProjectionPoolBindingKey\(draft\)/);
  assert.match(listener, /shouldReloadDraftProjectionPool/);
  assert.match(listener, /void this\.loadPlayerPool\(\)/);
  assert.equal((source.match(/listenToFantasyDraft\(/g) ?? []).length, 1);
});

test('a scheduled lobby never falls back to an unrelated current projection pointer', async () => {
  const source = await read('src/app/features/draft/draft-room/draft-room.ts');
  const start = source.indexOf('async loadPlayerPool(): Promise<void>');
  const end = source.indexOf('retryPlayerPool(): void', start);
  const loadPlayerPool = source.slice(start, end);

  const waitingGuard = loadPlayerPool.indexOf(
    "projectionSource.kind === 'waiting-for-readiness'",
  );
  const frozenGuard = loadPlayerPool.indexOf(
    "projectionSource.kind === 'invalid-frozen-binding'",
  );
  const currentPointerRead = loadPlayerPool.indexOf(
    'loadSharedProjectionSnapshot(this.leagueId)',
  );

  assert.ok(waitingGuard > 0);
  assert.ok(frozenGuard > waitingGuard);
  assert.ok(currentPointerRead > waitingGuard);
  assert.ok(currentPointerRead > frozenGuard);
  assert.match(loadPlayerPool, /loadSharedProjectionSnapshotById/);
  assert.match(loadPlayerPool, /projectionBinding\?\.snapshotHash/);
  assert.doesNotMatch(loadPlayerPool, /generateSharedProjectionSnapshot/);
  assert.doesNotMatch(loadPlayerPool, /queueSharedProjectionSnapshotGeneration/);
});

test('Draft Room copy makes server ownership and local reload behavior explicit', async () => {
  const [source, template] = await Promise.all([
    read('src/app/features/draft/draft-room/draft-room.ts'),
    read('src/app/features/draft/draft-room/draft-room.html'),
  ]);

  assert.match(template, /server prepares and verifies the exact Projection V11 Draft rankings automatically/i);
  assert.match(template, /no commissioner action or open browser is required/i);
  assert.match(template, /Reload Rankings/);
  assert.match(template, /role="status" aria-live="polite"/);
  assert.match(
    template,
    /class="pool-error-block rr-notice rr-notice--danger"[\s\S]*?role="alert"[\s\S]*?aria-live="assertive"[\s\S]*?aria-atomic="true"/,
  );
  assert.doesNotMatch(source, /commissioner must refresh|ask the commissioner/i);
  assert.doesNotMatch(template, /Retry Rankings/);
});

test('FF1.30 documents the implemented boundary and next server slice', async () => {
  const [documentation, handoff, packageSource] = await Promise.all([
    read('docs/RINKRAT_FF1_14_AUTOMATIC_READINESS_UX.md'),
    read('docs/RINKRAT_CODEX_HANDOFF.md'),
    read('package.json'),
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
  ]) {
    assert.match(documentation, new RegExp(value, 'i'));
  }

  assert.match(handoff, /FF1\.30/);
  assert.equal(
    packageJson.scripts['verify:batchff1-14:core'],
    'npm run verify:batchff1-13:core && npm run test:batchff1-14:run && npm run validate:release-manifest',
  );
});
