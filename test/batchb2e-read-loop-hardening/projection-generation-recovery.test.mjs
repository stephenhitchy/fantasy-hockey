import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  getProjectionGenerationRecoveryAction,
  isProjectionGenerationActiveStatus,
  isStaleProjectionGenerationState,
  shouldRecoverProjectionGenerationRequest,
} from '../../functions/src/shared/core/projection/projection-generation-recovery.util.ts';

async function read(relativePath) {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

function state({
  status = 'queued',
  leaseExpiresAtMilliseconds = 1_000,
  activeRequestId = 'projection-request-1',
} = {}) {
  return {
    status,
    leaseExpiresAtMilliseconds,
    activeRequestId,
  };
}

test('only queued and processing controls with expired leases are stale', () => {
  assert.equal(isProjectionGenerationActiveStatus('queued'), true);
  assert.equal(isProjectionGenerationActiveStatus('processing'), true);
  assert.equal(isProjectionGenerationActiveStatus('ready'), false);
  assert.equal(isProjectionGenerationActiveStatus('error'), false);

  assert.equal(isStaleProjectionGenerationState(state(), 1_000), true);
  assert.equal(isStaleProjectionGenerationState(state({
    status: 'processing',
    leaseExpiresAtMilliseconds: 999,
  }), 1_000), true);
  assert.equal(isStaleProjectionGenerationState(state({
    leaseExpiresAtMilliseconds: 1_001,
  }), 1_000), false);
  assert.equal(isStaleProjectionGenerationState(state({
    leaseExpiresAtMilliseconds: 0,
  }), 1_000), false);
  assert.equal(isStaleProjectionGenerationState(state({
    status: 'ready',
  }), 1_000), false);
});

test('transaction revalidation preserves completed, refreshed, and replaced controls', () => {
  const candidate = state();

  assert.equal(getProjectionGenerationRecoveryAction({
    candidate,
    current: state({ status: 'processing' }),
    cutoffMilliseconds: 1_000,
  }), 'recover-active');

  assert.equal(getProjectionGenerationRecoveryAction({
    candidate,
    current: state({ leaseExpiresAtMilliseconds: 1_001 }),
    cutoffMilliseconds: 1_000,
  }), 'skip');

  assert.equal(getProjectionGenerationRecoveryAction({
    candidate,
    current: state({ activeRequestId: 'projection-request-2' }),
    cutoffMilliseconds: 1_000,
  }), 'skip');

  assert.equal(getProjectionGenerationRecoveryAction({
    candidate: state({ status: 'ready' }),
    current: state({ activeRequestId: 'projection-request-2' }),
    cutoffMilliseconds: 1_000,
  }), 'skip');

  assert.equal(getProjectionGenerationRecoveryAction({
    candidate,
    current: state({ status: 'ready' }),
    cutoffMilliseconds: 1_000,
  }), 'cleanup-terminal');

  assert.equal(getProjectionGenerationRecoveryAction({
    candidate: state({ status: 'error' }),
    current: state({ status: 'error' }),
    cutoffMilliseconds: 1_000,
  }), 'cleanup-terminal');

  assert.equal(getProjectionGenerationRecoveryAction({
    candidate,
    current: state({ status: 'unknown' }),
    cutoffMilliseconds: 1_000,
  }), 'skip');
});

test('recovery never overwrites terminal or mismatched request evidence', () => {
  const exactActiveRequest = {
    exists: true,
    status: 'processing',
    documentRequestId: 'projection-request-1',
    expectedRequestId: 'projection-request-1',
  };

  assert.equal(
    shouldRecoverProjectionGenerationRequest(exactActiveRequest),
    true,
  );
  assert.equal(shouldRecoverProjectionGenerationRequest({
    ...exactActiveRequest,
    status: 'ready',
  }), false);
  assert.equal(shouldRecoverProjectionGenerationRequest({
    ...exactActiveRequest,
    status: 'error',
  }), false);
  assert.equal(shouldRecoverProjectionGenerationRequest({
    ...exactActiveRequest,
    documentRequestId: 'projection-request-2',
  }), false);
  assert.equal(shouldRecoverProjectionGenerationRequest({
    ...exactActiveRequest,
    exists: false,
  }), false);
});

test('the bounded sweep deterministically drains the oldest 100 leases first', async () => {
  const authority = await read('functions/src/projection-authority.ts');
  const queryStart = authority.indexOf(
    ".collection('projectionGenerationControls')",
  );
  const queryEnd = authority.indexOf('.get();', queryStart);
  const query = authority.slice(queryStart, queryEnd);

  assert.ok(queryStart >= 0);
  assert.match(query, /\.where\('leaseExpiresAt', '<=', cutoff\)/);
  assert.match(query, /\.orderBy\('leaseExpiresAt', 'asc'\)/);
  assert.match(query, /\.limit\(PROJECTION_STALE_SWEEP_LIMIT\)/);
  assert.ok(
    query.indexOf(".orderBy('leaseExpiresAt', 'asc')") <
      query.indexOf('.limit(PROJECTION_STALE_SWEEP_LIMIT)'),
  );
  assert.match(authority, /const PROJECTION_STALE_SWEEP_LIMIT = 100;/);

  const leases = Array.from({ length: 150 }, (_, index) => 150 - index);
  const ordered = leases.toSorted((left, right) => left - right);
  assert.deepEqual(ordered.slice(0, 100),
    Array.from({ length: 100 }, (_, index) => index + 1));
  assert.deepEqual(ordered.slice(100),
    Array.from({ length: 50 }, (_, index) => index + 101));
});

test('recovery uses bounded transactions and retires terminal leases without changing producer behavior', async () => {
  const authority = await read('functions/src/projection-authority.ts');
  const controlWrites = authority
    .split('transaction.set(controlRef, {')
    .slice(1)
    .map((source) => source.slice(0, source.indexOf('}, { merge: true });')));
  const terminalControlWrites = controlWrites.filter((source) =>
    /status: '(?:ready|error)'/.test(source)
  );

  assert.equal(terminalControlWrites.length, 5);
  for (const write of terminalControlWrites) {
    assert.match(write, /leaseExpiresAt: Timestamp\.fromMillis\(Date\.now\(\)\)/);
    assert.doesNotMatch(write, /leaseExpiresAt: FieldValue\.delete\(\)/);
  }

  assert.match(authority, /const PROJECTION_STALE_RECOVERY_CONCURRENCY = 10;/);
  assert.match(
    authority,
    /slice\(offset, offset \+ PROJECTION_STALE_RECOVERY_CONCURRENCY\)/,
  );
  assert.match(authority, /const currentSnapshot = await transaction\.get\(candidate\.ref\);/);
  assert.match(authority, /getProjectionGenerationRecoveryAction\(\{/);
  assert.match(authority, /const requestSnapshot = requestRef[\s\S]*await transaction\.get\(requestRef\)/);
  assert.match(authority, /shouldRecoverProjectionGenerationRequest\(\{/);
  assert.match(
    authority,
    /transaction\.set\(db\.doc\('appData\/projectionGeneration'\), \{[\s\S]*staleRecoveryCount: FieldValue\.increment\(1\)/,
  );
  assert.match(
    authority,
    /if \(action === 'cleanup-terminal'\) \{[\s\S]*transaction\.update\(candidate\.ref, \{[\s\S]*leaseExpiresAt: FieldValue\.delete\(\)/,
  );
  assert.match(
    authority,
    /transaction\.set\(candidate\.ref, \{[\s\S]*status: 'error'[\s\S]*leaseExpiresAt: FieldValue\.delete\(\)/,
  );
});

test('read-loop hardening adds no composite Firestore index', async () => {
  const indexes = JSON.parse(await read('firestore.indexes.json'));
  const projectionControlIndexes = indexes.indexes.filter(
    (index) => index.collectionGroup === 'projectionGenerationControls',
  );

  assert.deepEqual(projectionControlIndexes, []);
});
