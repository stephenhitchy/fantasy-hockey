import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  createProjectionCatalogHash,
  validateProjectionAssetsAgainstCatalog,
} from '../../functions/src/shared/core/projection/projection-asset-catalog.util.ts';

async function read(relativePath) {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function buildFixture() {
  const canonicalAssets = [
    {
      assetType: 'skater',
      assetKey: 'skater-8478402',
      playerId: 8478402,
      fullName: 'Connor McDavid',
      position: 'C',
      teamAbbreviation: 'EDM',
      teamLogoUrl: 'edm.svg',
      headshotUrl: '',
      birthDate: '1997-01-13',
    },
    {
      assetType: 'team-goalie-unit',
      assetKey: 'goalie-unit-VGK',
      position: 'G',
      teamAbbreviation: 'VGK',
      teamName: 'Vegas Golden Knights',
      teamLogoUrl: 'vgk.svg',
    },
  ];
  const catalog = {
    catalogId: 'catalog-v1-20262027-fixture',
    schemaVersion: 1,
    season: '20262027',
    contentHash: createProjectionCatalogHash(canonicalAssets),
    generatedAt: '2026-08-07T00:00:00.000Z',
    assetCount: canonicalAssets.length,
    skaterCount: 1,
    goalieUnitCount: 1,
    assets: canonicalAssets,
    assetsByKey: new Map(canonicalAssets.map((asset) => [asset.assetKey, asset])),
    cacheHit: true,
  };
  const assets = [
    {
      assetType: 'skater',
      assetKey: 'skater-8478402',
      position: 'C',
      player: {
        id: 8478402,
        fullName: 'Connor McDavid',
        position: 'C',
        nhlTeamAbbreviation: 'EDM',
        teamLogoUrl: 'edm.svg',
      },
    },
    {
      assetType: 'team-goalie-unit',
      assetKey: 'goalie-unit-VGK',
      position: 'G',
      teamAbbreviation: 'VGK',
      teamName: 'Vegas Golden Knights',
      teamLogoUrl: 'vgk.svg',
    },
  ];

  return { canonicalAssets, catalog, assets };
}

const [
  authoritySource,
  catalogServiceSource,
  catalogUtilSource,
  serverSnapshotSource,
  functionsIndexSource,
  functionsPackageSource,
  clientSnapshotSource,
  readinessSource,
  projectionLabSource,
  projectionLabTemplate,
  rulesSource,
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
  read('functions/src/projection-authority.ts'),
  read('functions/src/shared/core/projection/projection-asset-catalog.service.ts'),
  read('functions/src/shared/core/projection/projection-asset-catalog.util.ts'),
  read('functions/src/shared/core/projection/projection-snapshot.service.ts'),
  read('functions/src/index.ts'),
  read('functions/package.json'),
  read('src/app/core/projection/projection-snapshot.service.ts'),
  read('src/app/core/release/release-readiness.service.ts'),
  read('src/app/features/projections/projection-lab/projection-lab.ts'),
  read('src/app/features/projections/projection-lab/projection-lab.html'),
  read('firestore.rules'),
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

test('canonical catalog hashing is deterministic and independent of asset order', () => {
  const { canonicalAssets } = buildFixture();
  const first = createProjectionCatalogHash(canonicalAssets);
  const second = createProjectionCatalogHash([...canonicalAssets].reverse());

  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test('canonical validation accepts exact assets and records catalog cache usage', () => {
  const { catalog, assets } = buildFixture();
  const result = validateProjectionAssetsAgainstCatalog(assets, catalog);

  assert.equal(result.catalogId, catalog.catalogId);
  assert.equal(result.catalogHash, catalog.contentHash);
  assert.equal(result.catalogSeason, catalog.season);
  assert.equal(result.validatedAssetCount, 2);
  assert.equal(result.catalogCacheHit, true);
});

test('canonical validation rejects fake, duplicated, missing, or position-modified assets', () => {
  const { catalog, assets } = buildFixture();

  assert.throws(
    () => validateProjectionAssetsAgainstCatalog([
      { ...assets[0], assetKey: 'skater-9999999' },
      assets[1],
    ], catalog),
    /unknown asset/,
  );

  assert.throws(
    () => validateProjectionAssetsAgainstCatalog([
      { ...assets[0], position: 'LW', player: { ...assets[0].player, position: 'LW' } },
      assets[1],
    ], catalog),
    /does not match the server NHL catalog/,
  );

  assert.throws(
    () => validateProjectionAssetsAgainstCatalog([assets[0], assets[0]], catalog),
    /duplicate asset/,
  );

  assert.throws(
    () => validateProjectionAssetsAgainstCatalog([assets[0]], catalog),
    /missing 1 canonical asset/,
  );
});

test('Projection V11 generation is queued, idempotent, bounded, and server-authoritative', () => {
  assert.match(authoritySource, /export const requestProjectionSnapshotGeneration = onCall/);
  assert.match(authoritySource, /export const processProjectionGenerationTask = onTaskDispatched/);
  assert.match(authoritySource, /export const recoverStaleProjectionGenerationRequests = onSchedule/);
  assert.match(authoritySource, /PROJECTION_TASK_MAX_CONCURRENT_DISPATCHES = 2/);
  assert.match(authoritySource, /requestPayloadHash/);
  assert.match(authoritySource, /existing\['requestedBy'\] !== userId/);
  assert.match(authoritySource, /buildProjectionTaskId/);
  assert.match(authoritySource, /activeRequestId/);
  assert.match(authoritySource, /generationReason === 'window-boundary'/);
  assert.match(authoritySource, /catalogCacheHit/);
  assert.match(functionsIndexSource, /requestProjectionSnapshotGeneration/);
  assert.match(functionsIndexSource, /processProjectionGenerationTask/);
  assert.match(functionsIndexSource, /recoverStaleProjectionGenerationRequests/);
});

test('normal and emergency Projection V11 snapshots must pass the server NHL identity catalog', () => {
  assert.match(catalogServiceSource, /getCurrentNhlDraftSkaters/);
  assert.match(catalogServiceSource, /NHL_DRAFT_CLUBS/);
  assert.match(catalogServiceSource, /projectionAssetCatalogs/);
  assert.match(catalogServiceSource, /server:nhl-current-rosters/);
  assert.match(catalogUtilSource, /Projection output contains unknown asset/);
  assert.match(catalogUtilSource, /Projection output contains duplicate asset/);
  assert.match(catalogUtilSource, /Projection output is missing/);
  assert.equal(
    (serverSnapshotSource.match(/validateProjectionAssetsAgainstCatalog\(/g) ?? []).length,
    2,
  );
  assert.match(serverSnapshotSource, /generatedByAuthority: 'server'/);
  assert.match(serverSnapshotSource, /catalogValidationStatus: 'validated'/);
  assert.match(serverSnapshotSource, /canonicalAssetCount: catalogValidation\.validatedAssetCount/);
  assert.match(serverSnapshotSource, /catalogCacheHit: catalogValidation\.catalogCacheHit/);
});

test('the browser requests generation and follows server progress without writing projection assets', () => {
  assert.match(clientSnapshotSource, /'requestProjectionSnapshotGeneration'/);
  assert.match(clientSnapshotSource, /projectionGenerationRequests/);
  assert.match(clientSnapshotSource, /onSnapshot/);
  assert.match(clientSnapshotSource, /9 \* 60 \* 1000/);
  assert.match(clientSnapshotSource, /generatedByAuthority !== 'server'/);
  assert.doesNotMatch(clientSnapshotSource, /\bwriteBatch\b/);
  assert.doesNotMatch(clientSnapshotSource, /\bsetDoc\b/);
  assert.doesNotMatch(clientSnapshotSource, /loadDraftPlayerPool/);
});

test('Release Readiness and Projection Lab surface catalog authority without claiming final S2 hash enforcement', () => {
  assert.match(readinessSource, /projectionServerValidated/);
  assert.match(readinessSource, /server catalog/);
  assert.match(readinessSource, /predates the server NHL asset-catalog authority/);
  assert.match(projectionLabSource, /isSnapshotServerValidated/);
  assert.match(projectionLabSource, /getSnapshotAuthorityLabel/);
  assert.match(projectionLabTemplate, /Server catalog verified/);
  assert.match(projectionLabTemplate, /Refresh required/);
});

test('Firestore progress access is member-only and the reported compiler warnings are removed', () => {
  assert.match(rulesSource, /match \/projectionGenerationRequests\/\{requestId\}/);
  assert.match(rulesSource, /resource\.data\.leagueId is string/);
  assert.match(rulesSource, /isLeagueMember\(resource\.data\.leagueId\)/);
  assert.match(rulesSource, /allow list: if false;/);
  assert.match(rulesSource, /allow create, update, delete: if false;/);

  for (const removedHelper of [
    'draftQueuePath',
    'sharedProjectionPointerPath',
    'validLeagueName',
    'validLeagueLogoId',
    'validLeagueLogoPaletteId',
    'validRosterDocument',
    'validGlobalPlayerAvailabilityWrite',
  ]) {
    assert.doesNotMatch(rulesSource, new RegExp(`function ${removedHelper}\\(`));
  }
});

test('S2A verification, documentation, RC13, and the permanent roadmap are synchronized', () => {
  const packageJson = JSON.parse(packageSource);
  const functionsPackage = JSON.parse(functionsPackageSource);

  assert.equal(
    packageJson.scripts['test:batchs2a:run'],
    'node --no-warnings --experimental-strip-types --test --test-concurrency=1 test/batchs2a-projection-authority/*.test.mjs',
  );
  assert.match(packageJson.scripts['verify:batchs2a'], /verify:batchs1c/);
  assert.match(packageJson.scripts['verify:batchs2a'], /test:batchs2a:run/);
  assert.match(packageJson.scripts['verify:batchs2a'], /validate:release-manifest/);
  assert.match(functionsPackage.scripts.logs, /processProjectionGenerationTask/);
  assert.equal(roadmapRootSource, roadmapDocsSource);
  assert.match(roadmapRootSource, /Version 1\.4/);
  assert.match(roadmapRootSource, /# \[x\] S2\.1 .*Security Batch S2A/);
  assert.match(roadmapRootSource, /# \[x\] S2\.3 .*Security Batch S2A/);
  assert.match(roadmapRootSource, /# \[x\] S2\.4 .*Security Batch S2A/);
  assert.match(roadmapRootSource, /# \[x\] SEQ\.4 Security Batch S2A/);
  assert.match(roadmapRootSource, /\[ \] S2\.2 Make projectionSnapshots/);
  assert.match(documentationSource, /Batch S2A — Server Projection V11 Generation/);
  assert.match(documentationSource, /Firestore Rules warning cleanup/);
  assert.match(readmeSource, /Release Candidate 13/);
  assert.match(runtimeConfigSource, /releaseLabel: 'Release Candidate 13'/);
  assert.match(productionRuntimeConfigSource, /releaseLabel: 'Release Candidate 13'/);
});

test('Production Scoring V3 and Projection V11 math remain byte-for-byte unchanged', () => {
  assert.equal(
    sha256(scoringRulesSource),
    'd0ba8838c17737b00cdc5f0dea5e24ffb4e1af2154c2575baf28c3aa83de4901',
  );
  assert.equal(
    sha256(projectionV11Source),
    'e6f3111b1feccc7107e857aa24c5317451c65a84a36c71f8158947636f20d80a',
  );
});
