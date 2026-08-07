import { createHash } from 'node:crypto';

import type { DraftableAsset } from '../draft/draft.models';

export const PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION = 1;
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
  extends Omit<ProjectionSnapshotHashMetadataInput, 'chunkHashes'> {
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

export function createProjectionSnapshotChunkHash(
  snapshotId: string,
  chunk: ProjectionSnapshotChunkInput,
): string {
  return sha256(stableProjectionSnapshotJson({
    hashSchemaVersion: PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION,
    snapshotId,
    chunkId: chunk.chunkId,
    chunkIndex: chunk.chunkIndex,
    assetCount: chunk.assets.length,
    assets: chunk.assets,
  }));
}

export function createProjectionSnapshotContentHash(
  input: ProjectionSnapshotHashMetadataInput,
): string {
  return sha256(stableProjectionSnapshotJson({
    hashSchemaVersion: PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION,
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
  }));
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
    createProjectionSnapshotChunkHash(metadata.snapshotId, chunk),
  );

  return {
    hashSchemaVersion: PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION,
    hashAlgorithm: PROJECTION_SNAPSHOT_HASH_ALGORITHM,
    chunkHashes,
    snapshotContentHash: createProjectionSnapshotContentHash({
      ...metadata,
      chunkHashes,
    }),
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

  if (
    metadata.snapshotHashSchemaVersion !== PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION ||
    metadata.snapshotHashAlgorithm !== PROJECTION_SNAPSHOT_HASH_ALGORITHM ||
    !isProjectionSha256(metadata.snapshotContentHash)
  ) {
    throw new Error('Projection snapshot is missing its deterministic content hash.');
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
      chunk.snapshotHashSchemaVersion !== PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION ||
      chunk.snapshotHashAlgorithm !== PROJECTION_SNAPSHOT_HASH_ALGORITHM ||
      chunk.snapshotContentHash !== metadata.snapshotContentHash ||
      !isProjectionSha256(chunk.chunkHash)
    ) {
      throw new Error(`Projection snapshot chunk ${chunk.chunkId} is missing authority metadata.`);
    }

    const actualHash = createProjectionSnapshotChunkHash(metadata.snapshotId, chunk);

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

  const actualRootHash = createProjectionSnapshotContentHash({
    snapshotId: metadata.snapshotId,
    projectionVersion: metadata.projectionVersion,
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
  });

  if (actualRootHash !== metadata.snapshotContentHash) {
    throw new Error('Projection snapshot root hash failed integrity verification.');
  }

  return {
    assets,
    chunkHashes: actualChunkHashes,
    snapshotContentHash: actualRootHash,
  };
}
