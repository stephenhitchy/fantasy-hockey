import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  createProjectionSnapshotHashBundle,
  PROJECTION_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
  PROJECTION_SNAPSHOT_HASH_ALGORITHM,
  PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION,
  verifyProjectionSnapshotHashChain,
} from '../../functions/src/shared/core/projection/projection-snapshot-hash.util.ts';

async function read(relativePath) {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function buildHashFixture() {
  const snapshotId = 'projection-v11-fixture';
  const assets = [
    {
      assetType: 'skater',
      assetKey: 'skater-8478402',
      position: 'C',
      projectedCyclePoints: 78.4,
      balancedRank: 1,
      player: {
        id: 8478402,
        fullName: 'Connor McDavid',
        position: 'C',
        nhlTeamAbbreviation: 'EDM',
      },
    },
    {
      assetType: 'team-goalie-unit',
      assetKey: 'goalie-unit-VGK',
      position: 'G',
      projectedCyclePoints: 92.1,
      balancedRank: 2,
      teamAbbreviation: 'VGK',
      teamName: 'Vegas Golden Knights',
    },
  ];
  const chunks = [
    {
      chunkId: 'chunk-0001',
      chunkIndex: 0,
      assets,
    },
  ];
  const metadataInput = {
    snapshotId,
    projectionVersion: 11,
    scoringRulesVersion: 4,
    projectionAsOfDate: '2026-10-07',
    projectionContext: 'live',
    projectionSeason: '20262027',
    teamCount: 6,
    targetCycleNumber: 1,
    requiredGamesPerCycle: 6,
    assetCount: assets.length,
    assetDocumentCount: chunks.length,
    catalogSnapshotId: 'catalog-v1-20262027-fixture',
    catalogHash: 'a'.repeat(64),
  };
  const bundle = createProjectionSnapshotHashBundle(metadataInput, chunks);
  const storedChunks = chunks.map((chunk, index) => ({
    ...chunk,
    assetCount: chunk.assets.length,
    chunkHash: bundle.chunkHashes[index],
    snapshotContentHash: bundle.snapshotContentHash,
    snapshotHashSchemaVersion: PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION,
    snapshotHashAlgorithm: PROJECTION_SNAPSHOT_HASH_ALGORITHM,
    sharedProjectionSnapshotId: snapshotId,
  }));
  const storedMetadata = {
    ...metadataInput,
    activeSnapshotId: snapshotId,
    generatedByAuthority: 'server',
    authoritySchemaVersion: PROJECTION_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
    snapshotHashSchemaVersion: PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION,
    snapshotHashAlgorithm: PROJECTION_SNAPSHOT_HASH_ALGORITHM,
    snapshotContentHash: bundle.snapshotContentHash,
    snapshotChunkHashes: bundle.chunkHashes,
  };

  return { assets, chunks, metadataInput, bundle, storedChunks, storedMetadata };
}

const [
  hashSource,
  serverSnapshotSource,
  catalogSource,
  draftAutomationSource,
  draftAuthoritySource,
  serverDraftModelsSource,
  clientDraftModelsSource,
  projectionAuthoritySource,
  functionsIndexSource,
  functionsPackageSource,
  clientProjectionSource,
  draftRoomSource,
  readinessServiceSource,
  readinessComponentSource,
  readinessTemplateSource,
  projectionLabSource,
  projectionLabTemplateSource,
  draftSetupSource,
  rulesSource,
  emulatorRulesTestSource,
  packageSource,
  roadmapRootSource,
  roadmapDocsSource,
  documentationSource,
  readmeSource,
  runtimeConfigSource,
  productionRuntimeConfigSource,
  scoringRulesSource,
  projectionV11Source,
] = await Promise.all([
  read('functions/src/shared/core/projection/projection-snapshot-hash.util.ts'),
  read('functions/src/shared/core/projection/projection-snapshot.service.ts'),
  read('functions/src/shared/core/projection/projection-asset-catalog.service.ts'),
  read('functions/src/draft-automation.ts'),
  read('functions/src/draft-authority.ts'),
  read('functions/src/shared/core/draft/draft.models.ts'),
  read('src/app/core/draft/draft.models.ts'),
  read('functions/src/projection-authority.ts'),
  read('functions/src/index.ts'),
  read('functions/package.json'),
  read('src/app/core/projection/projection-snapshot.service.ts'),
  read('src/app/features/draft/draft-room/draft-room.ts'),
  read('src/app/core/release/release-readiness.service.ts'),
  read('src/app/features/release/release-readiness/release-readiness.ts'),
  read('src/app/features/release/release-readiness/release-readiness.html'),
  read('src/app/features/projections/projection-lab/projection-lab.ts'),
  read('src/app/features/projections/projection-lab/projection-lab.html'),
  read('src/app/features/draft/draft-setup/draft-setup.ts'),
  read('firestore.rules'),
  read('test/firestore-rules/firestore.rules.test.mjs'),
  read('package.json'),
  read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
  read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
  read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
  read('README.md'),
  read('src/environments/app-runtime.config.ts'),
  read('src/environments/app-runtime.config.production.ts'),
  read('functions/src/shared/core/scoring/scoring-rules.ts'),
  read('functions/src/shared/core/projection/projection-v11.util.ts'),
]);

test('projection snapshot hashing is deterministic and the exact chain verifies', () => {
  const fixture = buildHashFixture();
  const second = createProjectionSnapshotHashBundle(
    { ...fixture.metadataInput },
    fixture.chunks.map((chunk) => ({
      chunkIndex: chunk.chunkIndex,
      chunkId: chunk.chunkId,
      assets: chunk.assets.map((asset) => ({ ...asset })),
    })),
  );
  const verified = verifyProjectionSnapshotHashChain(
    fixture.storedMetadata,
    fixture.storedChunks,
  );

  assert.equal(second.snapshotContentHash, fixture.bundle.snapshotContentHash);
  assert.deepEqual(second.chunkHashes, fixture.bundle.chunkHashes);
  assert.deepEqual(verified.assets, fixture.assets);
  assert.equal(verified.snapshotContentHash, fixture.bundle.snapshotContentHash);
  assert.match(verified.snapshotContentHash, /^[a-f0-9]{64}$/);
});

test('projection snapshot verification rejects asset, chunk, catalog, and matchup tampering', () => {
  const fixture = buildHashFixture();
  const tamperedAssetChunks = structuredClone(fixture.storedChunks);
  tamperedAssetChunks[0].assets[0].projectedCyclePoints = 999;

  assert.throws(
    () => verifyProjectionSnapshotHashChain(fixture.storedMetadata, tamperedAssetChunks),
    /failed integrity verification/,
  );
  assert.throws(
    () => verifyProjectionSnapshotHashChain(
      { ...fixture.storedMetadata, targetCycleNumber: 2 },
      fixture.storedChunks,
    ),
    /root hash failed integrity verification/,
  );
  assert.throws(
    () => verifyProjectionSnapshotHashChain(
      { ...fixture.storedMetadata, catalogHash: 'b'.repeat(64) },
      fixture.storedChunks,
    ),
    /root hash failed integrity verification/,
  );
  assert.throws(
    () => verifyProjectionSnapshotHashChain(
      fixture.storedMetadata,
      [{ ...fixture.storedChunks[0], chunkIndex: 1 }],
    ),
    /expected 0/,
  );
});

test('normal and emergency server projection generation writes versioned chunk and root hashes', () => {
  assert.match(hashSource, /PROJECTION_SNAPSHOT_LEGACY_HASH_SCHEMA_VERSION = 1/);
  assert.match(hashSource, /PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION = 2/);
  assert.match(hashSource, /PROJECTION_SNAPSHOT_AUTHORITY_SCHEMA_VERSION = 2/);
  assert.match(hashSource, /stableProjectionSnapshotJson/);
  assert.match(hashSource, /createProjectionSnapshotChunkHash/);
  assert.match(hashSource, /createProjectionSnapshotContentHash/);
  assert.match(hashSource, /verifyProjectionSnapshotHashChain/);
  assert.equal(
    (serverSnapshotSource.match(/snapshotIntegrityStatus: 'verified'/g) ?? []).length >= 2,
    true,
  );
  assert.equal(
    (serverSnapshotSource.match(/schemaVersion: 3/g) ?? []).length >= 2,
    true,
  );
  assert.match(serverSnapshotSource, /snapshotChunkHashes: integrity\.snapshotChunkHashes/);
  assert.match(serverSnapshotSource, /loadCanonicalProjectionAssetCatalog/);
  assert.match(catalogSource, /failed integrity verification/);
});

test('legacy S2A snapshots can be sealed only when they were server generated and catalog validated', () => {
  assert.match(serverSnapshotSource, /export async function sealSharedProjectionSnapshotIntegrity/);
  assert.match(serverSnapshotSource, /metadata\.generatedByAuthority !== 'server'/);
  assert.match(serverSnapshotSource, /metadata\.catalogValidationStatus !== 'validated'/);
  assert.match(serverSnapshotSource, /must be regenerated instead of being trusted/);
  assert.match(serverSnapshotSource, /canonical server chunk layout/);
  assert.match(serverSnapshotSource, /validateProjectionAssetsAgainstCatalog\(assets, catalog\)/);
  assert.match(serverSnapshotSource, /integrityMigratedAt/);
});

test('projection snapshots and chunks are browser read-only and emulator coverage includes both paths', () => {
  assert.match(
    rulesSource,
    /match \/projectionSnapshots\/\{snapshotId\}[\s\S]*?allow create, update, delete: if false;[\s\S]*?match \/assets\/\{assetKey\}[\s\S]*?allow create, update, delete: if false;/,
  );
  assert.doesNotMatch(rulesSource, /function sharedProjectionWriteAllowed\(/);
  assert.doesNotMatch(rulesSource, /function validSharedProjectionAsset\(/);
  assert.match(emulatorRulesTestSource, /projection pointers and asset chunks are browser read-only/);
  assert.match(emulatorRulesTestSource, /Commissioner projection pointer write/);
  assert.match(emulatorRulesTestSource, /Commissioner projection asset chunk write/);
});

test('Draft authority pins and verifies the exact snapshot root hash for manual and automatic selections', () => {
  for (const source of [serverDraftModelsSource, clientDraftModelsSource]) {
    assert.match(source, /serverDraftProjectionSnapshotHash\?: string \| null/);
    assert.match(source, /serverDraftProjectionAuthorityVersion\?: number \| null/);
    assert.match(source, /serverDraftProjectionCatalogHash\?: string \| null/);
    assert.match(source, /projectionSnapshotHash\?: string \| null/);
  }

  assert.match(draftAutomationSource, /isVerifiedDraftProjection/);
  assert.match(draftAutomationSource, /serverDraftProjectionSnapshotHash/);
  assert.match(draftAutomationSource, /The verified Draft projection hash changed/);
  assert.match(draftAutomationSource, /projectionSnapshotHash,/);
  assert.match(draftAuthoritySource, /projectionSnapshotHash = projection\.metadata\.snapshotContentHash/);
  assert.match(draftAuthoritySource, /draft\.serverDraftProjectionSnapshotHash !== projectionSnapshotHash/);
  assert.match(draftAuthoritySource, /projectionAuthorityVersion: PROJECTION_SNAPSHOT_AUTHORITY_SCHEMA_VERSION/);
  assert.match(draftSetupSource, /serverDraftProjectionSnapshotHash: null/);
  assert.match(draftRoomSource, /The Draft pool did not match its verified server content hash/);
});

test('platform administrators can verify or restore a prior snapshot only before Draft picks exist', () => {
  assert.match(projectionAuthoritySource, /export const manageProjectionSnapshotIntegrity = onCall/);
  assert.match(projectionAuthoritySource, /Only a platform administrator/);
  assert.match(projectionAuthoritySource, /action === 'restore-previous'/);
  assert.match(projectionAuthoritySource, /!pickSnapshot\.empty/);
  assert.match(projectionAuthoritySource, /latestDraftStatus === 'live'/);
  assert.match(projectionAuthoritySource, /serverDraftProjectionSnapshotHash: null/);
  assert.match(projectionAuthoritySource, /projection-integrity-/);
  assert.match(projectionAuthoritySource, /Security Batch S2B/);
  assert.match(functionsIndexSource, /manageProjectionSnapshotIntegrity/);
  assert.match(functionsPackageSource, /manageProjectionSnapshotIntegrity/);
});

test('Release Readiness and Projection Lab expose integrity state and guarded recovery controls', () => {
  assert.match(clientProjectionSource, /'manageProjectionSnapshotIntegrity'/);
  assert.match(
    clientProjectionSource,
    /ProjectionIntegrityCommandAction = 'verify-current' \| 'restore-previous'/,
  );
  assert.match(readinessServiceSource, /action: 'verify-current'/);
  assert.match(readinessServiceSource, /action: 'restore-previous'/);
  assert.match(readinessServiceSource, /server hashed and Draft ready/);
  assert.match(readinessServiceSource, /verifyReleaseReadinessProjectionIntegrity/);
  assert.match(readinessServiceSource, /restorePreviousReleaseReadinessProjection/);
  assert.match(readinessComponentSource, /verifyProjectionIntegrity/);
  assert.match(readinessComponentSource, /restorePreviousProjection/);
  assert.match(readinessTemplateSource, /Verify Projection Integrity/);
  assert.match(readinessTemplateSource, /Restore Previous Verified Snapshot/);
  assert.match(projectionLabSource, /snapshotContentHash/);
  assert.match(projectionLabSource, /root \$\{rootHash\}/);
  assert.match(projectionLabTemplateSource, /Server hash verified/);
  assert.match(projectionLabTemplateSource, /Integrity check required/);
});

test('S2B verification, RC14, documentation, and permanent roadmap stay synchronized', () => {
  const packageJson = JSON.parse(packageSource);
  const functionsPackage = JSON.parse(functionsPackageSource);

  assert.equal(
    packageJson.scripts['test:batchs2b:run'],
    'node --no-warnings --experimental-strip-types --test --test-concurrency=1 test/batchs2b-projection-hash-draft-integrity/*.test.mjs',
  );
  assert.match(packageJson.scripts['verify:batchs2b'], /verify:batchs2a-1/);
  assert.match(packageJson.scripts['verify:batchs2b'], /test:batchs2b:run/);
  assert.match(packageJson.scripts['verify:batchs2b'], /validate:release-manifest/);
  assert.equal(roadmapRootSource, roadmapDocsSource);
  assert.match(roadmapRootSource, /Version 1\.\d+(?:\.\d+)?/);
  assert.match(roadmapRootSource, /# \[x\] S2\.2 .*Security Batch S2B/);
  assert.match(roadmapRootSource, /# \[x\] S2\.5 .*Security Batch S2B/);
  assert.match(roadmapRootSource, /# \[x\] S2\.6 .*Security Batch S2B/);
  assert.match(roadmapRootSource, /# \[x\] S2\.7 .*Security Batch S2B/);
  assert.match(roadmapRootSource, /# \[x\] S2\.10 .*Security Batch S2B/);
  assert.match(roadmapRootSource, /# \[x\] SEQ\.5 Security Batch S2B/);
  assert.match(documentationSource, /Batch S2B — Projection Content Hash and Draft Integrity/);
  assert.match(readmeSource, /Release Candidate \d+/);
  assert.match(runtimeConfigSource, /releaseLabel: 'Release Candidate \d+'/g);
  assert.match(productionRuntimeConfigSource, /releaseLabel: 'Release Candidate \d+'/g);
  assert.match(functionsPackage.scripts.logs, /manageProjectionSnapshotIntegrity/);
});

test('Production Scoring V4 and Projection V11 math remain byte-for-byte controlled', () => {
  assert.equal(
    sha256(scoringRulesSource),
    '74107aa688b4a3825c52fe14003cd824485197fd3559822fab4134bff940e2da',
  );
  assert.equal(
    sha256(projectionV11Source),
    'e6f3111b1feccc7107e857aa24c5317451c65a84a36c71f8158947636f20d80a',
  );
});
