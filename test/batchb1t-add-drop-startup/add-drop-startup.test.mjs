import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

async function sha256(relativePath) {
  const contents = await readFile(new URL(relativePath, ROOT));
  return createHash('sha256').update(contents).digest('hex');
}

test('Projection V11 chunk reads are deduplicated by immutable snapshot identity', async () => {
  const source = await read('src/app/core/projection/projection-snapshot.service.ts');
  const activeLoaderStart = source.indexOf('function loadProjectionSnapshotAssets(');
  const metadataExportStart = source.indexOf('export function loadSharedProjectionSnapshotMetadata(');
  const activeLoader = source.slice(activeLoaderStart, metadataExportStart);
  const listenerStart = source.indexOf('export function listenToSharedProjectionSnapshot(');
  const listenerEnd = source.indexOf('interface ProjectionGenerationCallableRequest', listenerStart);
  const listener = source.slice(listenerStart, listenerEnd);

  assert.ok(activeLoaderStart >= 0 && metadataExportStart > activeLoaderStart);
  assert.match(activeLoader, /metadata\.activeSnapshotId/);
  assert.match(activeLoader, /activeSnapshotReadInFlight\.get\(cacheKey\)/);
  assert.match(activeLoader, /activeSnapshotReadInFlight\.set\(cacheKey, request\)/);
  assert.match(activeLoader, /getProjectionSnapshotAssetsRef\(leagueId, metadata\.activeSnapshotId\)/);
  assert.match(source, /return loadProjectionSnapshotAssets\(leagueId, metadata\)/);
  assert.match(listener, /loadProjectionSnapshotAssets\(normalizedLeagueId, metadata\)/);
  assert.doesNotMatch(
    listener,
    /loadSharedProjectionSnapshotById\([\s\S]*metadata\.activeSnapshotId/,
  );
});

test('Add Drop renders independently of the full pool and fails closed on missing roster ownership', async () => {
  const [source, template] = await Promise.all([
    read('src/app/features/free-agents/free-agents.ts'),
    read('src/app/features/free-agents/free-agents.html'),
  ]);
  const loadPageStart = source.indexOf('async loadPage(): Promise<void>');
  const loadPoolStart = source.indexOf('async loadPlayerPool(', loadPageStart);
  const loadPage = source.slice(loadPageStart, loadPoolStart);

  assert.match(loadPage, /void this\.loadPlayerPool\(\)/);
  assert.doesNotMatch(loadPage, /await this\.loadPlayerPool\(\)/);
  assert.match(source, /readonly rosterOwnershipReady = computed/);
  assert.match(source, /Object\.prototype\.hasOwnProperty\.call\(rosters, team\.ownerId\)/);
  assert.match(
    source,
    /this\.rosterOwnershipReady\(\)[\s\S]*buildLeaguePlayerBoardRows/,
  );
  assert.match(template, /No player is being shown as a free agent without ownership proof/);
});

test('a denied roster stream gets one bounded credential refresh and a visible retry', async () => {
  const [source, template] = await Promise.all([
    read('src/app/features/free-agents/free-agents.ts'),
    read('src/app/features/free-agents/free-agents.html'),
  ]);

  assert.match(source, /listenToFantasyRoster\([\s\S]*handleRosterListenerError\(team\.ownerId, error\)/);
  assert.match(source, /permissionDenied && !this\.rosterListenerRecoveryAttempted/);
  assert.match(source, /await user\.getIdToken\(true\)/);
  assert.match(source, /this\.clearRosterListeners\(\)[\s\S]*this\.refreshRosterListeners\(this\.teams\(\)\)/);
  assert.match(source, /if \(this\.rosterReadRecovering\(\) \|\| this\.destroyed\)/);
  assert.match(template, /Retry roster connection/);
  assert.match(template, /\[disabled\]="rosterReadRecovering\(\)"/);
});

test('new leagues prewarm the directory and recovery reuses bounded NHL fact caches', async () => {
  const [createSource, serverProjection] = await Promise.all([
    read('src/app/features/leagues/create-league/create-league.ts'),
    read('functions/src/shared/core/projection/projection-snapshot.service.ts'),
  ]);

  assert.match(createSource, /queueSharedProjectionSnapshotGeneration\(\{/);
  assert.match(createSource, /generationReason: 'player-directory'/);
  assert.match(createSource, /void queueSharedProjectionSnapshotGeneration/);
  assert.match(createSource, /\.catch\(\(error: unknown\) =>/);
  assert.match(
    serverProjection,
    /forceRefresh: generationReason !== 'player-directory'/,
  );
});

test('competitive formulas and Firebase policy remain unchanged while roster authority stays pinned', async () => {
  assert.equal(
    await sha256('src/app/core/scoring/scoring-engine.ts'),
    '6f36cf76c72f8199c6a3891692844c9c830103ed618be50497b5270e259da3d3',
  );
  assert.equal(
    await sha256('src/app/core/projection/projection-v11.util.ts'),
    'c22cce759a6e59b6f549d33c0442d1380a102443120b8620c0eea693b598bed9',
  );
  assert.equal(
    await sha256('src/app/core/projection/projection-ranking.util.ts'),
    '2363a76ba5379bb18516c43633b163aaa117f241de5c647ae8ee338dedae8c5f',
  );
  assert.equal(
    await sha256('functions/src/roster-authority.ts'),
    'e49c9c82233a5e45527cc5d931b572a80c63a4fcf8610e70919619a743e9d5aa',
  );
  assert.equal(
    await sha256('firestore.rules'),
    PROTECTED_SOURCE_HASHES.firestoreRules,
  );
  assert.equal(
    await sha256('firestore.indexes.json'),
    '8e2798abd1f659d752e6fad8910ac249025e140c7ec6d03e3d336d2c814d096a',
  );
});
