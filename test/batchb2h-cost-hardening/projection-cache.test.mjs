import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertCompleteProjectionSnapshotAssetPayload,
  detachProjectionSnapshotForConsumer,
  ProjectionSnapshotAssetCache,
} from '../../src/app/core/projection/projection-snapshot-asset-cache.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

test('immutable snapshot IDs keep distinct values and coalesce concurrent chunk reads', async () => {
  const cache = new ProjectionSnapshotAssetCache(4);
  const firstLoad = deferred();
  let firstLoadCount = 0;
  let secondLoadCount = 0;

  const firstRequest = cache.getOrLoad('league-1::snapshot-a', () => {
    firstLoadCount += 1;
    return firstLoad.promise;
  });
  const duplicateRequest = cache.getOrLoad('league-1::snapshot-a', () => {
    firstLoadCount += 1;
    return Promise.resolve(['unexpected']);
  });
  const nextSnapshot = cache.getOrLoad('league-1::snapshot-b', async () => {
    secondLoadCount += 1;
    return ['snapshot-b'];
  });

  assert.strictEqual(duplicateRequest, firstRequest);
  firstLoad.resolve(['snapshot-a']);

  assert.deepEqual(await firstRequest, ['snapshot-a']);
  assert.deepEqual(await nextSnapshot, ['snapshot-b']);
  assert.equal(firstLoadCount, 1);
  assert.equal(secondLoadCount, 1);
  assert.deepEqual(
    await cache.getOrLoad('league-1::snapshot-a', async () => ['unexpected']),
    ['snapshot-a'],
  );
});

test('the bounded cache evicts the least recently used immutable snapshot', async () => {
  const cache = new ProjectionSnapshotAssetCache(2);
  const loadCounts = new Map();
  const load = (key) => cache.getOrLoad(key, async () => {
    loadCounts.set(key, (loadCounts.get(key) ?? 0) + 1);
    return key;
  });

  await load('snapshot-a');
  await load('snapshot-b');
  await load('snapshot-a');
  await load('snapshot-c');
  await load('snapshot-b');

  assert.equal(loadCounts.get('snapshot-a'), 1, 'a cache hit must promote the snapshot');
  assert.equal(loadCounts.get('snapshot-b'), 2, 'the least recently used snapshot must reload');
  assert.equal(loadCounts.get('snapshot-c'), 1);
});

test('a rejected chunk read is coalesced but never blocks a later retry', async () => {
  const cache = new ProjectionSnapshotAssetCache(2);
  const failedLoad = deferred();
  let loadCount = 0;

  const firstRequest = cache.getOrLoad('league-1::snapshot-a', () => {
    loadCount += 1;
    return failedLoad.promise;
  });
  const duplicateRequest = cache.getOrLoad('league-1::snapshot-a', async () => {
    loadCount += 1;
    return ['unexpected'];
  });

  failedLoad.reject(new Error('temporary Firestore failure'));
  await assert.rejects(firstRequest, /temporary Firestore failure/);
  await assert.rejects(duplicateRequest, /temporary Firestore failure/);

  assert.deepEqual(
    await cache.getOrLoad('league-1::snapshot-a', async () => {
      loadCount += 1;
      return ['recovered'];
    }),
    ['recovered'],
  );
  assert.equal(loadCount, 2);
});

test('an incomplete chunk load is rejected before caching and a complete retry succeeds', async () => {
  const cache = new ProjectionSnapshotAssetCache(2);
  let loadCount = 0;
  let availableAssets = ['asset-1'];
  const loadCompleteSnapshot = () => cache.getOrLoad(
    'league-1::snapshot-a',
    async () => {
      loadCount += 1;
      const assets = [...availableAssets];

      if (assets.length !== 2) {
        throw new Error(`incomplete (${assets.length} of 2)`);
      }

      return assets;
    },
  );

  await assert.rejects(loadCompleteSnapshot(), /incomplete \(1 of 2\)/);
  availableAssets = ['asset-1', 'asset-2'];

  assert.deepEqual(await loadCompleteSnapshot(), ['asset-1', 'asset-2']);
  assert.equal(loadCount, 2);
});

test('snapshot completeness fails closed for missing, invalid, or mismatched counts', () => {
  assert.throws(
    () => assertCompleteProjectionSnapshotAssetPayload(0, 0),
    /invalid asset count \(0\)/,
  );
  assert.throws(
    () => assertCompleteProjectionSnapshotAssetPayload(Number.NaN, 2),
    /invalid asset count \(NaN\)/,
  );
  assert.throws(
    () => assertCompleteProjectionSnapshotAssetPayload(2, 1),
    /incomplete \(1 of 2 assets loaded\)/,
  );
  assert.doesNotThrow(
    () => assertCompleteProjectionSnapshotAssetPayload(2, 2),
  );
});

test('each projection consumer receives a detached nested snapshot payload', () => {
  const cachedSnapshot = {
    metadata: { snapshotId: 'snapshot-a' },
    assets: [{ assetKey: 'skater:1', projection: { total: 42 } }],
  };
  const firstConsumer = detachProjectionSnapshotForConsumer(cachedSnapshot);

  firstConsumer.metadata.snapshotId = 'mutated';
  firstConsumer.assets[0].projection.total = 99;
  firstConsumer.assets.push({ assetKey: 'skater:2', projection: { total: 12 } });

  const nextConsumer = detachProjectionSnapshotForConsumer(cachedSnapshot);

  assert.deepEqual(nextConsumer, {
    metadata: { snapshotId: 'snapshot-a' },
    assets: [{ assetKey: 'skater:1', projection: { total: 42 } }],
  });
  assert.notStrictEqual(nextConsumer, cachedSnapshot);
  assert.notStrictEqual(nextConsumer.metadata, cachedSnapshot.metadata);
  assert.notStrictEqual(nextConsumer.assets[0], cachedSnapshot.assets[0]);
});

test('mutable pointers keep their short freshness policy and new IDs cannot reuse old assets', async () => {
  const source = await read('src/app/core/projection/projection-snapshot.service.ts');
  const pointerLoaderStart = source.indexOf('function loadProjectionSnapshotMetadataAtPointer(');
  const pointerLoaderEnd = source.indexOf('function loadProjectionSnapshotAtPointer(', pointerLoaderStart);
  const snapshotLoaderStart = pointerLoaderEnd;
  const snapshotLoaderEnd = source.indexOf('function loadProjectionSnapshotAssets(', snapshotLoaderStart);
  const assetLoaderStart = source.indexOf('function loadProjectionSnapshotAssets(');
  const assetLoaderEnd = source.indexOf('export function loadSharedProjectionSnapshotMetadata(', assetLoaderStart);
  const listenerStart = source.indexOf('export function listenToSharedProjectionSnapshot(');
  const listenerEnd = source.indexOf('interface ProjectionGenerationCallableRequest', listenerStart);
  const pointerLoader = source.slice(pointerLoaderStart, pointerLoaderEnd);
  const snapshotLoader = source.slice(snapshotLoaderStart, snapshotLoaderEnd);
  const assetLoader = source.slice(assetLoaderStart, assetLoaderEnd);
  const listener = source.slice(listenerStart, listenerEnd);

  assert.match(source, /const SNAPSHOT_READ_CACHE_MILLISECONDS = 15_000;/);
  assert.match(pointerLoader, /isRecentRead\(cached\.loadedAt\)/);
  assert.match(pointerLoader, /getProjectionReadCacheKey\(leagueId, pointerId\)/);
  assert.match(
    snapshotLoader,
    /cached\.value\)[\s\S]*existingRequest\.then\(detachProjectionSnapshotForConsumer\)[\s\S]*request\.then\(detachProjectionSnapshotForConsumer\)/,
  );
  assert.match(assetLoader, /getProjectionReadCacheKey\(leagueId, metadata\.activeSnapshotId\)/);
  assert.match(assetLoader, /immutableSnapshotAssetCache\.getOrLoad\(/);
  assert.match(
    assetLoader,
    /assertProjectionSnapshotAssetsComplete\(metadata, assets\);[\s\S]*return assets;[\s\S]*\}\s*,\s*\)\.then/,
  );
  assert.match(listener, /metadata\.activeSnapshotId === lastSnapshotId/);
  assert.match(listener, /lastSnapshotId = metadata\.activeSnapshotId/);
  assert.match(listener, /invalidateSharedProjectionReadCache\(normalizedLeagueId\)/);
  assert.match(assetLoader, /return detachProjectionSnapshotForConsumer\(\{/);
});
