import { createHash } from 'node:crypto';

import type { DraftableAsset } from '../draft/draft.models';

export const PROJECTION_SNAPSHOT_LEGACY_HASH_SCHEMA_VERSION = 1;
export const PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION = 2;
export const PROJECTION_SNAPSHOT_AUTHORITY_SCHEMA_VERSION = 2;
export const PROJECTION_SNAPSHOT_HASH_ALGORITHM = 'sha256' as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface ProjectionSnapshotChunkInput {
  chunkId: string;
  chunkIndex: number;
  assets: DraftableAsset[];
}

export interface ProjectionSnapshotHashMetadataInput {
  snapshotId: string;
  projectionVersion: number;
  scoringRulesVersion: number;
  projectionAsOfDate?: string;
  projectionContext?: 'live' | 'historical-replay';
  projectionSeason?: string;
  teamCount: number;
  targetCycleNumber: number;
  requiredGamesPerCycle: number;
  assetCount: number;
  assetDocumentCount: number;
  catalogSnapshotId: string;
  catalogHash: string;
  chunkHashes: string[];
}

export interface ProjectionSnapshotHashBundle {
  hashSchemaVersion: number;
  hashAlgorithm: typeof PROJECTION_SNAPSHOT_HASH_ALGORITHM;
  chunkHashes: string[];
  snapshotContentHash: string;
}

export interface StoredProjectionSnapshotChunk {
  chunkId: string;
  chunkIndex: number;
  assets: DraftableAsset[];
  assetCount: number;
  chunkHash?: string;
  snapshotContentHash?: string;
  snapshotHashSchemaVersion?: number;
  snapshotHashAlgorithm?: typeof PROJECTION_SNAPSHOT_HASH_ALGORITHM;
  sharedProjectionSnapshotId?: string;
}

export interface StoredProjectionSnapshotHashMetadata
  extends Omit<
    ProjectionSnapshotHashMetadataInput,
    'chunkHashes' | 'scoringRulesVersion'
  > {
  scoringRulesVersion?: number;
  activeSnapshotId: string;
  generatedByAuthority?: 'server';
  authoritySchemaVersion?: number;
  snapshotHashSchemaVersion?: number;
  snapshotHashAlgorithm?: typeof PROJECTION_SNAPSHOT_HASH_ALGORITHM;
  snapshotContentHash?: string;
  snapshotChunkHashes?: string[];
}

export interface VerifiedProjectionSnapshotHashChain {
  assets: DraftableAsset[];
  chunkHashes: string[];
  snapshotContentHash: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeCanonicalValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Projection snapshot hashing received a non-finite number.');
    }

    return Object.is(value, -0) ? 0 : value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeCanonicalValue(entry));
  }

  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};

    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];

      if (entry === undefined || typeof entry === 'function') {
        continue;
      }

      output[key] = normalizeCanonicalValue(entry);
    }

    return output;
  }

  throw new Error(`Projection snapshot hashing received unsupported value type ${typeof value}.`);
}

export function stableProjectionSnapshotJson(value: unknown): string {
  return JSON.stringify(normalizeCanonicalValue(value));
}

export function isProjectionSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

/**
 * Preserves the historical replay request identity while allowing Draft
 * readiness to bind a request to one exact availability revision.
 */
export function createServerProjectionRequestId(input: {
  requestPrefix: 'projection-replay' | 'projection-draft';
  leagueId: string;
  requestKey: string;
  targetCycleNumber: number;
  availabilityRevision?: string | null;
}): string {
  const legacyIdentity = [
    input.leagueId,
    input.requestKey,
    String(input.targetCycleNumber),
  ].join(':');
  const identity = input.availabilityRevision
    ? `${legacyIdentity}:${input.availabilityRevision}`
    : legacyIdentity;

  return `${input.requestPrefix}-${sha256(identity).slice(0, 32)}`;
}

function isSupportedHashSchema(value: unknown): value is 1 | 2 {
  return value === PROJECTION_SNAPSHOT_LEGACY_HASH_SCHEMA_VERSION ||
    value === PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION;
}

export function createProjectionSnapshotChunkHash(
  snapshotId: string,
  chunk: ProjectionSnapshotChunkInput,
  hashSchemaVersion = PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION,
): string {
  if (!isSupportedHashSchema(hashSchemaVersion)) {
    throw new Error(`Unsupported projection snapshot hash schema ${hashSchemaVersion}.`);
  }

  return sha256(stableProjectionSnapshotJson({
    hashSchemaVersion,
    snapshotId,
    chunkId: chunk.chunkId,
    chunkIndex: chunk.chunkIndex,
    assetCount: chunk.assets.length,
    assets: chunk.assets,
  }));
}

export function createProjectionSnapshotContentHash(
  input: ProjectionSnapshotHashMetadataInput,
  hashSchemaVersion = PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION,
): string {
  if (!isSupportedHashSchema(hashSchemaVersion)) {
    throw new Error(`Unsupported projection snapshot hash schema ${hashSchemaVersion}.`);
  }

  const canonical: Record<string, unknown> = {
    hashSchemaVersion,
    authoritySchemaVersion: PROJECTION_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
    generatedByAuthority: 'server',
    snapshotId: input.snapshotId,
    projectionVersion: input.projectionVersion,
    projectionAsOfDate: input.projectionAsOfDate ?? '',
    projectionContext: input.projectionContext ?? '',
    projectionSeason: input.projectionSeason ?? '',
    teamCount: input.teamCount,
    targetCycleNumber: input.targetCycleNumber,
    requiredGamesPerCycle: input.requiredGamesPerCycle,
    assetCount: input.assetCount,
    assetDocumentCount: input.assetDocumentCount,
    catalogSnapshotId: input.catalogSnapshotId,
    catalogHash: input.catalogHash,
    chunkHashes: input.chunkHashes,
  };

  if (hashSchemaVersion >= PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION) {
    canonical['scoringRulesVersion'] = input.scoringRulesVersion;
  }

  return sha256(stableProjectionSnapshotJson(canonical));
}

export function createProjectionSnapshotHashBundle(
  metadata: Omit<ProjectionSnapshotHashMetadataInput, 'chunkHashes'>,
  chunks: ProjectionSnapshotChunkInput[],
): ProjectionSnapshotHashBundle {
  const orderedChunks = [...chunks].sort((first, second) => {
    if (first.chunkIndex !== second.chunkIndex) {
      return first.chunkIndex - second.chunkIndex;
    }

    return first.chunkId.localeCompare(second.chunkId);
  });
  const chunkHashes = orderedChunks.map((chunk) =>
    createProjectionSnapshotChunkHash(
      metadata.snapshotId,
      chunk,
      PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION,
    ),
  );

  return {
    hashSchemaVersion: PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION,
    hashAlgorithm: PROJECTION_SNAPSHOT_HASH_ALGORITHM,
    chunkHashes,
    snapshotContentHash: createProjectionSnapshotContentHash(
      {
        ...metadata,
        chunkHashes,
      },
      PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION,
    ),
  };
}

function assertContiguousChunks(chunks: StoredProjectionSnapshotChunk[]): void {
  const ids = new Set<string>();

  chunks.forEach((chunk, index) => {
    if (ids.has(chunk.chunkId)) {
      throw new Error(`Projection snapshot contains duplicate chunk ${chunk.chunkId}.`);
    }

    ids.add(chunk.chunkId);

    if (chunk.chunkIndex !== index) {
      throw new Error(
        `Projection snapshot chunk ${chunk.chunkId} has index ${chunk.chunkIndex}; expected ${index}.`,
      );
    }

    if (chunk.assetCount !== chunk.assets.length || chunk.assetCount <= 0) {
      throw new Error(`Projection snapshot chunk ${chunk.chunkId} has an invalid asset count.`);
    }
  });
}

export function verifyProjectionSnapshotHashChain(
  metadata: StoredProjectionSnapshotHashMetadata,
  chunks: StoredProjectionSnapshotChunk[],
): VerifiedProjectionSnapshotHashChain {
  if (
    metadata.generatedByAuthority !== 'server' ||
    metadata.authoritySchemaVersion !== PROJECTION_SNAPSHOT_AUTHORITY_SCHEMA_VERSION
  ) {
    throw new Error('Projection snapshot is not sealed by the current server authority.');
  }

  const hashSchemaVersion = metadata.snapshotHashSchemaVersion;

  if (
    !isSupportedHashSchema(hashSchemaVersion) ||
    metadata.snapshotHashAlgorithm !== PROJECTION_SNAPSHOT_HASH_ALGORITHM ||
    !isProjectionSha256(metadata.snapshotContentHash)
  ) {
    throw new Error('Projection snapshot is missing its deterministic content hash.');
  }

  const scoringRulesVersion =
    hashSchemaVersion === PROJECTION_SNAPSHOT_LEGACY_HASH_SCHEMA_VERSION
      ? 3
      : metadata.scoringRulesVersion;

  if (
    typeof scoringRulesVersion !== 'number' ||
    !Number.isInteger(scoringRulesVersion) ||
    scoringRulesVersion < 3
  ) {
    throw new Error('Projection snapshot is missing its scoring-rules identity.');
  }

  if (
    metadata.activeSnapshotId !== metadata.snapshotId ||
    !metadata.snapshotId ||
    !metadata.catalogSnapshotId ||
    !isProjectionSha256(metadata.catalogHash)
  ) {
    throw new Error('Projection snapshot identity metadata is incomplete.');
  }

  const orderedChunks = [...chunks].sort((first, second) => {
    if (first.chunkIndex !== second.chunkIndex) {
      return first.chunkIndex - second.chunkIndex;
    }

    return first.chunkId.localeCompare(second.chunkId);
  });
  assertContiguousChunks(orderedChunks);

  const expectedChunkHashes = metadata.snapshotChunkHashes;

  if (
    orderedChunks.length !== metadata.assetDocumentCount ||
    !Array.isArray(expectedChunkHashes) ||
    expectedChunkHashes.length !== orderedChunks.length
  ) {
    throw new Error('Projection snapshot chunk manifest is incomplete.');
  }

  const actualChunkHashes = orderedChunks.map((chunk, index) => {
    if (
      chunk.sharedProjectionSnapshotId !== metadata.snapshotId ||
      chunk.snapshotHashSchemaVersion !== hashSchemaVersion ||
      chunk.snapshotHashAlgorithm !== PROJECTION_SNAPSHOT_HASH_ALGORITHM ||
      chunk.snapshotContentHash !== metadata.snapshotContentHash ||
      !isProjectionSha256(chunk.chunkHash)
    ) {
      throw new Error(`Projection snapshot chunk ${chunk.chunkId} is missing authority metadata.`);
    }

    const actualHash = createProjectionSnapshotChunkHash(
      metadata.snapshotId,
      chunk,
      hashSchemaVersion,
    );

    if (
      actualHash !== chunk.chunkHash ||
      actualHash !== expectedChunkHashes[index]
    ) {
      throw new Error(`Projection snapshot chunk ${chunk.chunkId} failed integrity verification.`);
    }

    return actualHash;
  });
  const assets = orderedChunks.flatMap((chunk) => chunk.assets);

  if (assets.length !== metadata.assetCount) {
    throw new Error(
      `Projection snapshot asset count mismatch (${assets.length} of ${metadata.assetCount}).`,
    );
  }

  const actualRootHash = createProjectionSnapshotContentHash(
    {
      snapshotId: metadata.snapshotId,
      projectionVersion: metadata.projectionVersion,
      scoringRulesVersion,
      projectionAsOfDate: metadata.projectionAsOfDate,
      projectionContext: metadata.projectionContext,
      projectionSeason: metadata.projectionSeason,
      teamCount: metadata.teamCount,
      targetCycleNumber: metadata.targetCycleNumber,
      requiredGamesPerCycle: metadata.requiredGamesPerCycle,
      assetCount: metadata.assetCount,
      assetDocumentCount: metadata.assetDocumentCount,
      catalogSnapshotId: metadata.catalogSnapshotId,
      catalogHash: metadata.catalogHash,
      chunkHashes: actualChunkHashes,
    },
    hashSchemaVersion,
  );

  if (actualRootHash !== metadata.snapshotContentHash) {
    throw new Error('Projection snapshot root hash failed integrity verification.');
  }

  return {
    assets,
    chunkHashes: actualChunkHashes,
    snapshotContentHash: actualRootHash,
  };
}
