import { createHash } from 'node:crypto';

export const D1NC_LOAD_STAGING_PROJECT_ID = 'rinkrat-staging-d1nc-2026';
export const D1NC_LOAD_FIXTURE_MARKER = 'rinkrat-d1n-c-load-fixture-v1';
export const D1NC_LOAD_SCHEMA_VERSION = 1;
export const D1NC_LOAD_STAGES = [100, 500, 2_000, 5_000] as const;

export type D1nLoadProbeKind = 'scoring' | 'draft';

export interface D1nLoadProbeTaskPayload {
  schemaVersion: 1;
  projectId: typeof D1NC_LOAD_STAGING_PROJECT_ID;
  fixtureMarker: typeof D1NC_LOAD_FIXTURE_MARKER;
  runId: string;
  operationId: string;
  kind: D1nLoadProbeKind;
  sourceRevision: string;
  nonce: string;
  scheduledAtMilliseconds: number;
}

export interface D1nLoadProbeResult {
  kind: D1nLoadProbeKind;
  resultFingerprint: string;
  scoring?: {
    ownedGameCount: 6;
    zeroPointGameCount: number;
    aggregatePoints: number;
  };
  draft?: {
    expectedOverallPick: number;
    selectedAssetOrdinal: number;
  };
}

const RUN_ID_PATTERN = /^d1nc-[a-f0-9]{20}-(?:100|500|2000|5000)$/;
const OPERATION_ID_PATTERN = /^[a-f0-9]{32}$/;
const REVISION_PATTERN = /^[a-f0-9]{40}$/;
const NONCE_PATTERN = /^[a-f0-9]{48}$/;

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function d1nLoadSha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function resolveD1nLoadRuntimeProjectId(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  for (const value of [
    environment['GCLOUD_PROJECT'],
    environment['GOOGLE_CLOUD_PROJECT'],
    environment['GCP_PROJECT'],
  ]) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  const firebaseConfig = environment['FIREBASE_CONFIG'];
  if (typeof firebaseConfig === 'string' && firebaseConfig.trim()) {
    try {
      const parsed = JSON.parse(firebaseConfig) as Record<string, unknown>;
      const projectId = parsed['projectId'];
      if (typeof projectId === 'string' && projectId.trim()) {
        return projectId.trim();
      }
    } catch {
      return 'unknown-project';
    }
  }

  return 'unknown-project';
}

export function parseD1nLoadProbeTaskPayload(
  value: unknown,
  expectedKind: D1nLoadProbeKind,
): D1nLoadProbeTaskPayload {
  requireCondition(value && typeof value === 'object', 'D1N-C load probe payload is missing.');
  const payload = value as Record<string, unknown>;
  requireCondition(
    payload['schemaVersion'] === D1NC_LOAD_SCHEMA_VERSION,
    'D1N-C load probe schema is unsupported.',
  );
  requireCondition(
    payload['projectId'] === D1NC_LOAD_STAGING_PROJECT_ID,
    'D1N-C load probe project is not the isolated staging project.',
  );
  requireCondition(
    payload['fixtureMarker'] === D1NC_LOAD_FIXTURE_MARKER,
    'D1N-C load probe fixture marker is invalid.',
  );
  requireCondition(payload['kind'] === expectedKind, 'D1N-C load probe worker kind is invalid.');
  requireCondition(
    typeof payload['runId'] === 'string' && RUN_ID_PATTERN.test(payload['runId']),
    'D1N-C load probe run identity is invalid.',
  );
  requireCondition(
    typeof payload['operationId'] === 'string'
      && OPERATION_ID_PATTERN.test(payload['operationId']),
    'D1N-C load probe operation identity is invalid.',
  );
  requireCondition(
    typeof payload['sourceRevision'] === 'string'
      && REVISION_PATTERN.test(payload['sourceRevision']),
    'D1N-C load probe source revision is invalid.',
  );
  requireCondition(
    typeof payload['nonce'] === 'string' && NONCE_PATTERN.test(payload['nonce']),
    'D1N-C load probe nonce is invalid.',
  );
  const scheduledAtMilliseconds = finiteNumber(payload['scheduledAtMilliseconds']);
  requireCondition(
    scheduledAtMilliseconds !== null && scheduledAtMilliseconds > 0,
    'D1N-C load probe schedule is invalid.',
  );

  return {
    schemaVersion: 1,
    projectId: D1NC_LOAD_STAGING_PROJECT_ID,
    fixtureMarker: D1NC_LOAD_FIXTURE_MARKER,
    runId: payload['runId'] as string,
    operationId: payload['operationId'] as string,
    kind: expectedKind,
    sourceRevision: payload['sourceRevision'] as string,
    nonce: payload['nonce'] as string,
    scheduledAtMilliseconds,
  };
}

export function assertD1nLoadProbeRuntimeProject(projectId: string): void {
  requireCondition(
    projectId === D1NC_LOAD_STAGING_PROJECT_ID,
    'D1N-C load probes are disabled outside the isolated staging project.',
  );
}

export function buildD1nLoadProbeResult(
  kind: D1nLoadProbeKind,
  operation: Record<string, unknown>,
): D1nLoadProbeResult {
  if (kind === 'scoring') {
    const values = operation['ownedGamePoints'];
    requireCondition(
      Array.isArray(values) && values.length === 6,
      'A scoring load probe requires exactly six synthetic owned games.',
    );
    const ownedGamePoints = values.map((value) => finiteNumber(value));
    requireCondition(
      ownedGamePoints.every((value) => value !== null && Math.abs(value) <= 1_000),
      'A scoring load probe contains an invalid synthetic game value.',
    );
    const points = ownedGamePoints as number[];
    const aggregatePoints = Number(
      points.reduce((sum, value) => sum + value, 0).toFixed(4),
    );
    const zeroPointGameCount = points.filter((value) => value === 0).length;
    const resultFingerprint = d1nLoadSha256(
      JSON.stringify({ kind, ownedGamePoints: points, aggregatePoints }),
    );
    return {
      kind,
      resultFingerprint,
      scoring: {
        ownedGameCount: 6,
        zeroPointGameCount,
        aggregatePoints,
      },
    };
  }

  const expectedOverallPick = finiteNumber(operation['expectedOverallPick']);
  const selectedAssetOrdinal = finiteNumber(operation['selectedAssetOrdinal']);
  requireCondition(
    Number.isSafeInteger(expectedOverallPick) && (expectedOverallPick ?? 0) >= 1,
    'A Draft load probe requires a positive overall-pick number.',
  );
  requireCondition(
    Number.isSafeInteger(selectedAssetOrdinal) && (selectedAssetOrdinal ?? 0) >= 1,
    'A Draft load probe requires a positive synthetic asset ordinal.',
  );
  const resultFingerprint = d1nLoadSha256(
    JSON.stringify({ kind, expectedOverallPick, selectedAssetOrdinal }),
  );
  return {
    kind,
    resultFingerprint,
    draft: {
      expectedOverallPick: expectedOverallPick as number,
      selectedAssetOrdinal: selectedAssetOrdinal as number,
    },
  };
}
