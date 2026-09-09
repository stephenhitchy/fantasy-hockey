import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { D1N_FIXTURE_LEAGUE_ID } from './seed-d1n-route-fixture.mjs';
import { D1N_STAGING_PROJECT_ID } from './prepare-d1n-staging-hosting.mjs';

export const FF132_STAGING_ACKNOWLEDGEMENT =
  `exercise-ff132-server-preparation-in-${D1N_STAGING_PROJECT_ID}`;
export const FF132_STAGING_MAINTENANCE_ACKNOWLEDGEMENT =
  `reserve-exclusive-shared-availability-window-in-${D1N_STAGING_PROJECT_ID}`;
export const FF132_DRAFT_SCHEDULER_JOB =
  'firebase-schedule-runScheduledDraftAutomation-us-central1';
export const FF132_AVAILABILITY_TASK_QUEUE = 'refreshDraftPlayerAvailabilityTask';
export const FF132_PROJECTION_TASK_QUEUE = 'processProjectionGenerationTask';
export const FF132_DRAFT_CLOCK_TASK_QUEUE = 'processDraftClockDeadline';
export const FF132_REGION = 'us-central1';
export const FF132_EVIDENCE_LOCK_PATH =
  'appData/ff132ServerOwnedDraftPreparationEvidenceLock';

const DEFAULT_TIMEOUT_MILLISECONDS = 30 * 60 * 1000;
const POLL_INTERVAL_MILLISECONDS = 1_000;
const AVAILABILITY_BOUNDARY_MILLISECONDS = 25 * 60 * 1000;
const PROJECTION_BOUNDARY_MILLISECONDS = 20 * 60 * 1000;
const BOUNDARY_SETTLE_MILLISECONDS = 750;
const NATURAL_SCHEDULER_MINIMUM_INITIAL_LEAD_MILLISECONDS = 60_000;
const NATURAL_SCHEDULER_MINIMUM_RETRY_LEAD_MILLISECONDS = 60_000;
const NATURAL_SCHEDULER_MAX_OBSERVATION_MILLISECONDS = 90_000;
export const FF132_NATURAL_SCHEDULER_CORRELATION_MAX_MILLISECONDS = 59_000;
const MANUAL_SCHEDULER_MINIMUM_REMAINING_MILLISECONDS = 20_000;
const MANUAL_SCHEDULER_COMPLETION_GUARD_MILLISECONDS = 2_000;
const TASK_BUCKET_MILLISECONDS = 5 * 60 * 1000;
const TASK_BUCKET_DUPLICATE_SAFETY_MARGIN_MILLISECONDS = 60_000;
const MINIMUM_TASK_RETRY_DELAY_MILLISECONDS = 25_000;
const MAXIMUM_TASK_RETRY_DELAY_MILLISECONDS = 5 * 60 * 1000;
const EVIDENCE_UTC_HORIZON_MILLISECONDS = 40 * 60 * 1000;
const LOCK_CLEANUP_RESERVE_MILLISECONDS = 10 * 60 * 1000;
const SAFE_RESET_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
const MAX_DRAFT_INVENTORY = 50;
const MAX_AVAILABILITY_RECORDS = 500;
const MAX_PROJECTION_SNAPSHOT_CHUNKS = 100;
const PROJECTION_SNAPSHOT_ASSET_CHUNK_SIZE = 25;
const MAX_SOURCE_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_SOURCE_ARCHIVE_EXPANDED_BYTES = 50 * 1024 * 1024;
const MAX_SOURCE_ARCHIVE_ENTRY_BYTES = 10 * 1024 * 1024;
const MINIMUM_FIXTURE_START_SAFETY_MILLISECONDS = 2 * 60 * 1000;
const GIT_REVISION_PATTERN = /^[a-f0-9]{40}$/;
const SHA1_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PROJECTION_REQUEST_ID_PATTERN = /^projection-draft-[a-f0-9]{32}$/;
const CLOUD_BUILD_PATTERN = /^projects\/[0-9]+\/locations\/us-central1\/builds\/[a-f0-9-]+$/;
const SERVER_DRAFT_ACTOR = 'server:draft-automation';
const SCHEDULER_EXPECTED_TARGET = 'runScheduledDraftAutomation';
const PUBLIC_FAILURE_CODE = 'FF132_EVIDENCE_FAILED';
const PUBLIC_CHECKPOINTS = Object.freeze([
  'preflight',
  'runtime-provenance',
  'fixture-safety',
  'availability-boundary',
  'availability-retry',
  'near-zero',
  'projection-boundary',
  'duplicate-convergence',
  'cleanup',
]);
export const FF132_REQUIRED_STAGING_FUNCTIONS = Object.freeze([
  'continueServerDraftAutomation',
  'executeDraftCommand',
  'processAutoDraftQueueChange',
  'processDraftClockDeadline',
  'processProjectionGenerationTask',
  'refreshDailyPlayerAvailability',
  'refreshDraftPlayerAvailabilityTask',
  'refreshGlobalPlayerAvailabilityScheduled',
  'runScheduledDraftAutomation',
]);
const ALLOWED_TOOLING_DELTA = Object.freeze([
  'docs/RINKRAT_CODEX_HANDOFF.md',
  'docs/RINKRAT_FF1_32_SERVER_OWNED_DRAFT_PREPARATION_STAGING.md',
  'package.json',
  'scripts/capacity/run-ff132-server-owned-draft-preparation-staging-evidence.mjs',
  'test/batchff1-16-server-owned-draft-preparation-staging/server-owned-draft-preparation-staging.test.mjs',
]);
const EXPECTED_FF132_PACKAGE_SCRIPTS = Object.freeze({
  'staging:ff1:exercise-server-preparation':
    'node scripts/capacity/run-ff132-server-owned-draft-preparation-staging-evidence.mjs',
  'test:batchff1-16:run':
    'node --no-warnings --experimental-strip-types --test --test-concurrency=1 test/batchff1-16-server-owned-draft-preparation-staging/*.test.mjs',
  'verify:batchff1-16:core':
    'npm run verify:batchff1-15:core && npm run test:batchff1-16:run && npm run validate:release-manifest',
  'verify:batchff1-16':
    'npm run toolchain:verify && npm run verify:batchff1-16:core && npm run security:dependency-audit',
});
const requireFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));
const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

const DRAFT_READINESS_FIELDS = Object.freeze([
  'projectionPreparationRequestId',
  'projectionPreparationStatus',
  'serverAutomationLastErrorAt',
  'serverAutomationMessage',
  'serverAutomationStatus',
  'serverAutomationUpdatedAt',
  'serverDraftReadinessAttemptCount',
  'serverDraftReadinessAvailabilityRevision',
  'serverDraftReadinessMessage',
  'serverDraftReadinessProjectionRequestId',
  'serverDraftReadinessProjectionSnapshotHash',
  'serverDraftReadinessProjectionSnapshotId',
  'serverDraftReadinessRetryAfterAt',
  'serverDraftReadinessScheduledStartAt',
  'serverDraftReadinessStatus',
  'serverDraftReadinessUpdatedAt',
  'serverDraftProjectionAuthorityVersion',
  'serverDraftProjectionCatalogHash',
  'serverDraftProjectionSnapshotHash',
  'serverDraftProjectionSnapshotId',
  'serverProjectionFallbackUsed',
]);

export class Ff132PublicEvidenceError extends Error {
  constructor(checkpoint = 'preflight', cleanupState = 'not-required') {
    const safeCheckpoint = PUBLIC_CHECKPOINTS.includes(checkpoint)
      ? checkpoint
      : 'preflight';
    const safeCleanupState = cleanupState === 'complete'
      ? 'complete'
      : cleanupState === 'cleanup-required'
        ? 'cleanup-required'
        : 'not-required';

    super(`${PUBLIC_FAILURE_CODE}:${safeCheckpoint}:${safeCleanupState}`);
    this.name = 'Ff132PublicEvidenceError';
    this.code = PUBLIC_FAILURE_CODE;
    this.checkpoint = safeCheckpoint;
    this.cleanupState = safeCleanupState;
  }

  toJSON() {
    return {
      errorCode: this.code,
      checkpoint: this.checkpoint,
      cleanupState: this.cleanupState,
    };
  }
}

function assertCheckpoint(checkpoint) {
  assert.equal(PUBLIC_CHECKPOINTS.includes(checkpoint), true);
  return checkpoint;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    timeout: options.timeout ?? 60_000,
  });

  if (result.error || result.status !== 0) {
    const operation = [command, ...args.slice(0, 2)].join(' ');
    throw new Error(`The guarded ${operation} command failed.`);
  }

  return result.stdout.trim();
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function timestampMilliseconds(value) {
  if (value && typeof value.toMillis === 'function') {
    return value.toMillis();
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function exactFirestoreTimestamp(value) {
  if (!value || typeof value !== 'object' || typeof value.toMillis !== 'function') {
    return null;
  }

  const seconds = value.seconds ?? value._seconds;
  const nanoseconds = value.nanoseconds ?? value._nanoseconds;

  if (
    !Number.isSafeInteger(seconds) ||
    !Number.isSafeInteger(nanoseconds) ||
    nanoseconds < 0 ||
    nanoseconds > 999_999_999
  ) {
    return null;
  }

  return { seconds: String(seconds), nanoseconds };
}

function canonicalize(value) {
  const exactTimestamp = exactFirestoreTimestamp(value);

  if (exactTimestamp) {
    return { $firestoreTimestamp: exactTimestamp };
  }

  const timestamp = timestampMilliseconds(value);

  if (timestamp !== null && (value instanceof Date || typeof value === 'object')) {
    return { $timestampMilliseconds: timestamp };
  }

  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonicalize(value[key])]),
    );
  }

  return value;
}

function contentHash(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

export function hashFf132DocumentData(value) {
  return contentHash(value);
}

function omitKeys(value, keys) {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.has(key)),
  );
}

function parseJsonCommand(command, args) {
  const output = runCommand(command, args);
  return output ? JSON.parse(output) : [];
}

export function assertFf132StagingSafety(environment = process.env) {
  if (
    environment.FIRESTORE_EMULATOR_HOST ||
    environment.FIREBASE_AUTH_EMULATOR_HOST ||
    environment.FIREBASE_DATABASE_EMULATOR_HOST
  ) {
    throw new Error('FF1.32 staging evidence refuses every Emulator Suite environment.');
  }

  if (environment.FF132_STAGING_PROJECT_ID !== D1N_STAGING_PROJECT_ID) {
    throw new Error(`FF132_STAGING_PROJECT_ID must equal ${D1N_STAGING_PROJECT_ID}.`);
  }

  if (environment.FF132_STAGING_ACK !== FF132_STAGING_ACKNOWLEDGEMENT) {
    throw new Error('FF132_STAGING_ACK does not authorize this exact isolated staging run.');
  }

  if (
    environment.FF132_STAGING_MAINTENANCE_ACK !==
    FF132_STAGING_MAINTENANCE_ACKNOWLEDGEMENT
  ) {
    throw new Error(
      'FF132_STAGING_MAINTENANCE_ACK must reserve the isolated shared-state window.',
    );
  }

  const deployedRevision = environment.FF132_DEPLOYED_RELEASE_REVISION ?? '';

  if (!GIT_REVISION_PATTERN.test(deployedRevision)) {
    throw new Error(
      'FF132_DEPLOYED_RELEASE_REVISION must be the exact 40-character staging revision.',
    );
  }

  const timeoutMilliseconds = Number(
    environment.FF132_STAGING_TIMEOUT_MILLISECONDS ?? DEFAULT_TIMEOUT_MILLISECONDS,
  );

  if (
    !Number.isInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 15 * 60 * 1000 ||
    timeoutMilliseconds > 45 * 60 * 1000
  ) {
    throw new Error(
      'FF132_STAGING_TIMEOUT_MILLISECONDS must be an integer from 900000 through 2700000.',
    );
  }

  return { deployedRevision, timeoutMilliseconds };
}

export function readCleanPushedToolingState(deployedRevision, repositoryRoot = REPOSITORY_ROOT) {
  const git = (args) => runCommand('git', args, { cwd: repositoryRoot });
  const status = git(['status', '--porcelain=v1', '--untracked-files=all']);

  if (status) {
    throw new Error('FF1.32 staging evidence requires a clean Git worktree.');
  }

  const toolingRevision = git(['rev-parse', 'HEAD']);
  const upstreamRevision = git(['rev-parse', '@{upstream}']);
  const branch = git(['branch', '--show-current']);
  const upstream = git([
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{upstream}',
  ]);

  if (!GIT_REVISION_PATTERN.test(toolingRevision) || upstreamRevision !== toolingRevision) {
    throw new Error('The evidence tooling commit must be pushed exactly to its configured upstream.');
  }
  assert.equal(branch, 'main', 'FF1.32 staging evidence must run from merged main.');
  assert.equal(upstream, 'origin/main', 'Merged main must track origin/main exactly.');
  const remoteMain = git(['ls-remote', '--exit-code', 'origin', 'refs/heads/main']);
  assert.deepEqual(
    remoteMain.split(/\s+/),
    [toolingRevision, 'refs/heads/main'],
    'The live origin/main ref must equal the evidence tooling commit.',
  );

  git(['cat-file', '-e', `${deployedRevision}^{commit}`]);
  git(['merge-base', '--is-ancestor', deployedRevision, toolingRevision]);

  const changedPaths = git([
    'diff',
    '--name-only',
    `${deployedRevision}..${toolingRevision}`,
  ])
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort();

  assert.deepEqual(
    changedPaths,
    [...ALLOWED_TOOLING_DELTA].sort(),
    'The clean pushed delta must equal the reviewed FF1.32 documentation/test/tooling slice.',
  );

  const deployedPackage = JSON.parse(
    git(['show', `${deployedRevision}:package.json`]),
  );
  const toolingPackage = JSON.parse(git(['show', `${toolingRevision}:package.json`]));
  const deployedScripts = { ...(deployedPackage.scripts ?? {}) };
  const toolingScripts = { ...(toolingPackage.scripts ?? {}) };

  for (const [name, value] of Object.entries(EXPECTED_FF132_PACKAGE_SCRIPTS)) {
    assert.equal(deployedScripts[name], undefined, `The deployed package already defines ${name}.`);
    assert.equal(toolingScripts[name], value, `The FF1.32 package script ${name} is not exact.`);
    delete toolingScripts[name];
  }

  delete deployedPackage.scripts;
  delete toolingPackage.scripts;
  assert.deepEqual(toolingPackage, deployedPackage, 'Non-script package metadata changed.');
  assert.deepEqual(toolingScripts, deployedScripts, 'An unrelated package script changed.');

  return { toolingRevision, changedPathCount: changedPaths.length };
}

export async function verifyFf132StagingManifest(deployedRevision, fetchImplementation = fetch) {
  const response = await fetchImplementation(
    `https://${D1N_STAGING_PROJECT_ID}.web.app/release-manifest.json?ff132=${Date.now()}`,
    { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } },
  );

  if (!response.ok) {
    throw new Error(`The staging release manifest returned HTTP ${response.status}.`);
  }

  const manifest = await response.json();
  assert.equal(manifest.schemaVersion, 1, 'The staging manifest schema is unsupported.');
  assert.equal(manifest.releaseLabel, 'Release Candidate 65', 'The staging release label changed.');
  assert.equal(manifest.sourceRevision, deployedRevision, 'The staging runtime revision is not exact.');
  assert.equal(manifest.scoringRulesVersion, 4, 'Staging no longer advertises Scoring V4.');
  assert.equal(manifest.projectionVersion, 11, 'Staging no longer advertises Projection V11.');

  return manifest;
}

function deployedFunctionName(entry) {
  return String(entry?.name ?? entry?.id ?? '').split('/').at(-1);
}

export function assertFf132StagingFunctionInventory(entries) {
  assert.equal(Array.isArray(entries), true, 'The staging Function inventory is malformed.');
  const byName = new Map(entries.map((entry) => [deployedFunctionName(entry), entry]));
  const verified = [];

  for (const name of FF132_REQUIRED_STAGING_FUNCTIONS) {
    const entry = byName.get(name);
    assert.ok(entry, `The required staging Function ${name} is missing.`);
    assert.equal(
      entry.name,
      `projects/${D1N_STAGING_PROJECT_ID}/locations/${FF132_REGION}/functions/${name}`,
      `The required staging Function ${name} has an unexpected resource identity.`,
    );
    assert.equal(
      String(entry.state ?? entry.status ?? '').toUpperCase(),
      'ACTIVE',
      `The required staging Function ${name} is not ACTIVE.`,
    );
    assert.equal(
      entry.buildConfig?.runtime ?? entry.runtime,
      'nodejs22',
      `The required staging Function ${name} is not on Node 22.`,
    );

    assert.equal(
      entry.buildConfig?.entryPoint,
      name,
      `The required staging Function ${name} has an unexpected entry point.`,
    );
    const source = entry.buildConfig?.source?.storageSource;
    const resolvedSource = entry.buildConfig?.sourceProvenance?.resolvedStorageSource;
    const sourceHash = entry.labels?.['firebase-functions-hash'];
    const revision = entry.serviceConfig?.revision;
    const buildName = entry.buildConfig?.build;
    const serviceName = name.toLowerCase();
    const serviceAccountEmail = entry.serviceConfig?.serviceAccountEmail;

    assert.match(sourceHash, SHA1_PATTERN, 'A deployed Function source hash is missing.');
    assert.deepEqual(
      resolvedSource,
      source,
      'The resolved deployed source does not match the configured source generation.',
    );
    assert.match(
      source?.bucket ?? '',
      new RegExp(`^gcf-v2-sources-[0-9]+-${FF132_REGION}$`),
      'A deployed Function source bucket is unexpected.',
    );
    assert.equal(
      source?.object,
      `${name}/function-source.zip`,
      'A deployed Function source object is unexpected.',
    );
    assert.match(
      String(source?.generation ?? ''),
      /^[0-9]+$/,
      'A deployed Function source generation is missing.',
    );
    assert.match(
      revision ?? '',
      /^[a-z0-9-]+-[0-9]{5}-[a-z]+$/,
      'A deployed Cloud Run revision is missing.',
    );
    assert.match(buildName ?? '', CLOUD_BUILD_PATTERN, 'A deployed Cloud Build identity is missing.');
    assert.equal(
      entry.serviceConfig?.allTrafficOnLatestRevision,
      true,
      'A required Function is not routing all traffic to its latest revision.',
    );
    assert.equal(
      entry.serviceConfig?.service,
      `projects/${D1N_STAGING_PROJECT_ID}/locations/${FF132_REGION}/services/${serviceName}`,
      'A required Function points at an unexpected Cloud Run service.',
    );
    assert.match(
      entry.serviceConfig?.uri ?? '',
      /^https:\/\/[a-z0-9-]+-uc\.a\.run\.app$/,
      'A required Function URI is missing or unexpected.',
    );
    assert.equal(
      entry.buildConfig?.serviceAccount?.split('/').at(-1),
      serviceAccountEmail,
      'The build and runtime service accounts diverge.',
    );

    verified.push({
      name,
      sourceHash,
      buildName,
      revision,
      serviceName,
      serviceAccountEmail,
      uri: entry.serviceConfig.uri,
      source: {
        bucket: source.bucket,
        object: source.object,
        generation: String(source.generation),
      },
    });
  }

  assert.equal(
    new Set(verified.map((entry) => entry.sourceHash)).size,
    1,
    'The required Functions do not share one exact deployed source package.',
  );

  return verified;
}

export function assertFf132CloudRunDeployment(deployedFunction, service, revision) {
  const source = deployedFunction.source;
  const storageUri = `gs://${source.bucket}/${source.object}#${source.generation}`;
  const buildId = deployedFunction.buildName.split('/').at(-1);
  const serviceTraffic = service?.status?.traffic ?? [];
  const readyCondition = (revision?.status?.conditions ?? []).find(
    (condition) => condition.type === 'Ready',
  );

  assert.equal(service?.metadata?.name, deployedFunction.serviceName);
  assert.equal(service?.status?.latestCreatedRevisionName, deployedFunction.revision);
  assert.equal(service?.status?.latestReadyRevisionName, deployedFunction.revision);
  assert.equal(service?.status?.url, deployedFunction.uri);
  assert.equal(serviceTraffic.length, 1);
  assert.equal(serviceTraffic[0]?.revisionName, deployedFunction.revision);
  assert.equal(serviceTraffic[0]?.percent, 100);
  assert.equal(
    service?.metadata?.labels?.['firebase-functions-hash'],
    deployedFunction.sourceHash,
  );
  assert.equal(
    service?.spec?.template?.metadata?.labels?.['firebase-functions-hash'],
    deployedFunction.sourceHash,
  );
  assert.equal(
    service?.metadata?.annotations?.['run.googleapis.com/build-name'],
    deployedFunction.buildName,
  );
  assert.equal(
    service?.metadata?.annotations?.['run.googleapis.com/build-source-location'],
    storageUri,
  );
  assert.equal(
    service?.metadata?.annotations?.['run.googleapis.com/build-function-target'],
    deployedFunction.name,
  );
  assert.equal(revision?.metadata?.name, deployedFunction.revision);
  assert.equal(
    revision?.metadata?.labels?.['firebase-functions-hash'],
    deployedFunction.sourceHash,
  );
  assert.equal(
    JSON.parse(revision?.metadata?.annotations?.['run.googleapis.com/build-id'] ?? '{}').worker,
    buildId,
  );
  assert.equal(
    JSON.parse(
      revision?.metadata?.annotations?.['run.googleapis.com/build-source-location'] ?? '{}',
    ).worker,
    storageUri,
  );
  assert.equal(revision?.spec?.serviceAccountName, deployedFunction.serviceAccountEmail);
  assert.equal(readyCondition?.status, 'True');
  assert.match(
    revision?.status?.imageDigest ?? '',
    /@sha256:[a-f0-9]{64}$/,
    'The deployed Cloud Run image digest is missing.',
  );
  assert.equal(
    revision?.spec?.containers?.[0]?.image,
    revision?.status?.imageDigest,
    'The active revision does not use its reported immutable image digest.',
  );

  return true;
}

export function inspectFf132CloudRunDeployments(functions) {
  for (const deployedFunction of functions) {
    const service = parseJsonCommand('gcloud', [
      'run',
      'services',
      'describe',
      deployedFunction.serviceName,
      `--region=${FF132_REGION}`,
      `--project=${D1N_STAGING_PROJECT_ID}`,
      '--format=json',
    ]);
    const revision = parseJsonCommand('gcloud', [
      'run',
      'revisions',
      'describe',
      deployedFunction.revision,
      `--region=${FF132_REGION}`,
      `--project=${D1N_STAGING_PROJECT_ID}`,
      '--format=json',
    ]);
    assertFf132CloudRunDeployment(deployedFunction, service, revision);
  }

  return functions.length;
}

export function inspectFf132StagingFunctionInventory() {
  const entries = FF132_REQUIRED_STAGING_FUNCTIONS.map((name) =>
    parseJsonCommand('gcloud', [
      'functions',
      'describe',
      name,
      '--gen2',
      `--region=${FF132_REGION}`,
      `--project=${D1N_STAGING_PROJECT_ID}`,
      '--format=json',
    ]),
  );

  return assertFf132StagingFunctionInventory(entries);
}

function isIgnoredFunctionsPath(relativePath) {
  const segments = relativePath.split('/');
  const basename = segments.at(-1) ?? '';

  return (
    segments.includes('node_modules') ||
    segments.includes('.git') ||
    basename === 'firebase-debug.log' ||
    /^firebase-debug\..*\.log$/.test(basename) ||
    basename.endsWith('.local')
  );
}

async function collectFileDigestManifest(rootPath, { applyFunctionsIgnore = false } = {}) {
  const manifest = new Map();

  async function visit(relativeDirectory = '') {
    const absoluteDirectory = path.join(rootPath, relativeDirectory);
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;

      if (applyFunctionsIgnore && isIgnoredFunctionsPath(relativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        await visit(relativePath);
        continue;
      }

      assert.equal(entry.isFile(), true, 'The Function source tree contains a non-file entry.');
      const bytes = await readFile(path.join(rootPath, relativePath));
      manifest.set(relativePath, {
        byteLength: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  }

  await visit();
  return manifest;
}

export function assertExactFunctionSourceManifest(localManifest, deployedManifest) {
  const local = [...localManifest.entries()].sort(([left], [right]) => left.localeCompare(right));
  const deployed = [...deployedManifest.entries()].sort(([left], [right]) =>
    left.localeCompare(right));
  assert.deepEqual(deployed, local, 'A deployed Function source archive differs from local source.');
  return local.length;
}

function validateArchiveEntry(entry) {
  assert.equal(entry.includes('\\'), false, 'Source archive paths cannot contain backslashes.');
  const normalized = entry.replace(/\\/g, '/');
  assert.ok(normalized.length > 0 && normalized.length <= 500);
  assert.equal(normalized.includes('\0'), false);
  assert.equal(/[\u0000-\u001f\u007f]/.test(normalized), false);
  assert.equal(path.posix.isAbsolute(normalized), false);
  assert.equal(/^[a-zA-Z]:/.test(normalized), false);
  const segments = normalized.endsWith('/')
    ? normalized.slice(0, -1).split('/')
    : normalized.split('/');
  assert.equal(segments.some((segment) => !segment || segment === '.' || segment === '..'), false);
}

export function assertSafeArchiveEntries(entries) {
  assert.ok(Array.isArray(entries) && entries.length > 0 && entries.length <= 1_000);
  entries.forEach(validateArchiveEntry);
  assert.equal(
    new Set(entries.map((entry) => entry.replace(/\\/g, '/'))).size,
    entries.length,
    'The deployed source archive contains duplicate file paths.',
  );
  return entries.length;
}

function decodeArchiveName(bytes, utf8) {
  if (!utf8) {
    assert.equal(
      bytes.every((byte) => byte > 0x1f && byte < 0x7f),
      true,
      'A non-UTF-8 source archive path is not strict ASCII.',
    );
    return bytes.toString('ascii');
  }

  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function findEndOfCentralDirectory(archive) {
  const minimumOffset = Math.max(0, archive.byteLength - 65_557);

  for (let offset = archive.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) !== 0x06054b50) {
      continue;
    }

    const commentLength = archive.readUInt16LE(offset + 20);

    if (offset + 22 + commentLength === archive.byteLength) {
      return offset;
    }
  }

  throw new Error('The deployed source archive has no bounded terminal directory record.');
}

export function assertFf132SourceArchiveBuffer(archive, expectedManifest) {
  assert.ok(Buffer.isBuffer(archive), 'The deployed source archive is not a byte buffer.');
  assert.ok(
    archive.byteLength > 22 && archive.byteLength <= MAX_SOURCE_ARCHIVE_BYTES,
    'The deployed source archive exceeds its reviewed byte envelope.',
  );
  assert.ok(expectedManifest instanceof Map && expectedManifest.size > 0);
  assert.ok(expectedManifest.size <= 1_000);

  const endOffset = findEndOfCentralDirectory(archive);
  const diskNumber = archive.readUInt16LE(endOffset + 4);
  const centralDirectoryDisk = archive.readUInt16LE(endOffset + 6);
  const diskEntryCount = archive.readUInt16LE(endOffset + 8);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralDirectorySize = archive.readUInt32LE(endOffset + 12);
  const centralDirectoryOffset = archive.readUInt32LE(endOffset + 16);

  assert.equal(diskNumber, 0, 'Multi-disk source archives are forbidden.');
  assert.equal(centralDirectoryDisk, 0, 'Multi-disk source archives are forbidden.');
  assert.equal(diskEntryCount, entryCount, 'The source archive entry count is inconsistent.');
  assert.ok(entryCount > 0 && entryCount <= 1_000);
  assert.notEqual(entryCount, 0xffff, 'ZIP64 source archives are outside this evidence envelope.');
  assert.notEqual(
    centralDirectorySize,
    0xffffffff,
    'ZIP64 source archives are outside this evidence envelope.',
  );
  assert.notEqual(
    centralDirectoryOffset,
    0xffffffff,
    'ZIP64 source archives are outside this evidence envelope.',
  );
  assert.equal(
    centralDirectoryOffset + centralDirectorySize,
    endOffset,
    'The source archive central directory is not exactly contained.',
  );

  const entries = [];
  const normalizedPaths = new Set();
  const caseFoldedPaths = new Set();
  let centralOffset = centralDirectoryOffset;
  let expandedBytes = 0;
  let compressedBytes = 0;

  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(
      archive.readUInt32LE(centralOffset),
      0x02014b50,
      'The source archive central directory is malformed.',
    );
    const versionMadeBy = archive.readUInt16LE(centralOffset + 4);
    const flags = archive.readUInt16LE(centralOffset + 8);
    const method = archive.readUInt16LE(centralOffset + 10);
    const entryCompressedBytes = archive.readUInt32LE(centralOffset + 20);
    const entryExpandedBytes = archive.readUInt32LE(centralOffset + 24);
    const nameLength = archive.readUInt16LE(centralOffset + 28);
    const extraLength = archive.readUInt16LE(centralOffset + 30);
    const commentLength = archive.readUInt16LE(centralOffset + 32);
    const startDisk = archive.readUInt16LE(centralOffset + 34);
    const externalAttributes = archive.readUInt32LE(centralOffset + 38);
    const localHeaderOffset = archive.readUInt32LE(centralOffset + 42);
    const entryEnd = centralOffset + 46 + nameLength + extraLength + commentLength;

    assert.ok(entryEnd <= endOffset, 'A source archive entry escapes the central directory.');
    assert.equal(startDisk, 0, 'A source archive entry uses another disk.');
    assert.equal(
      flags & (0x1 | 0x40 | 0x2000),
      0,
      'Encrypted source archive entries are forbidden.',
    );
    assert.ok(method === 0 || method === 8, 'The source archive compression method is unsupported.');
    assert.notEqual(entryCompressedBytes, 0xffffffff, 'ZIP64 entries are forbidden.');
    assert.notEqual(entryExpandedBytes, 0xffffffff, 'ZIP64 entries are forbidden.');
    assert.notEqual(localHeaderOffset, 0xffffffff, 'ZIP64 entries are forbidden.');
    assert.ok(entryCompressedBytes <= MAX_SOURCE_ARCHIVE_ENTRY_BYTES);
    assert.ok(entryExpandedBytes <= MAX_SOURCE_ARCHIVE_ENTRY_BYTES);

    const nameBytes = archive.subarray(centralOffset + 46, centralOffset + 46 + nameLength);
    const entryPath = decodeArchiveName(nameBytes, Boolean(flags & 0x800));
    validateArchiveEntry(entryPath);
    const isDirectory = entryPath.endsWith('/');
    const host = versionMadeBy >>> 8;

    if (host === 3) {
      const unixType = (externalAttributes >>> 16) & 0o170000;
      assert.equal(
        unixType,
        isDirectory ? 0o040000 : 0o100000,
        'The source archive contains a symlink or special file.',
      );
    } else {
      assert.equal(host, 0, 'The source archive host type is unsupported.');
      assert.equal(
        Boolean(externalAttributes & 0x10),
        isDirectory,
        'The source archive DOS entry type is inconsistent.',
      );
    }

    const normalizedPath = entryPath.replace(/\\/g, '/');
    assert.equal(normalizedPaths.has(normalizedPath), false, 'Duplicate source archive path.');
    const collisionKey = normalizedPath
      .replace(/\/$/, '')
      .normalize('NFC')
      .toLocaleLowerCase('en-US');
    assert.equal(
      caseFoldedPaths.has(collisionKey),
      false,
      'Case-colliding source archive paths are forbidden.',
    );
    normalizedPaths.add(normalizedPath);
    caseFoldedPaths.add(collisionKey);

    if (isDirectory) {
      assert.equal(entryExpandedBytes, 0, 'A source archive directory contains bytes.');
    } else {
      const expected = expectedManifest.get(normalizedPath);
      assert.ok(expected, 'The deployed archive contains a file absent from clean Git source.');
      assert.equal(entryExpandedBytes, expected.byteLength, 'A deployed file length changed.');
      expandedBytes += entryExpandedBytes;
      compressedBytes += entryCompressedBytes;
    }

    entries.push({
      entryPath,
      nameBytes,
      flags,
      method,
      compressedBytes: entryCompressedBytes,
      localHeaderOffset,
      isDirectory,
    });
    centralOffset = entryEnd;
  }

  assert.equal(centralOffset, endOffset, 'The source archive central directory has extra bytes.');
  assert.ok(expandedBytes <= MAX_SOURCE_ARCHIVE_EXPANDED_BYTES);
  assert.ok(compressedBytes <= MAX_SOURCE_ARCHIVE_BYTES);
  assert.equal(
    entries.filter((entry) => !entry.isDirectory).length,
    expectedManifest.size,
    'The deployed source archive file count differs from clean Git source.',
  );
  assert.equal(
    expandedBytes,
    [...expectedManifest.values()].reduce((sum, entry) => sum + entry.byteLength, 0),
    'The deployed source archive expanded size differs from clean Git source.',
  );

  const localRanges = [];

  for (const entry of entries) {
    const offset = entry.localHeaderOffset;
    assert.ok(offset + 30 <= centralDirectoryOffset);
    assert.equal(archive.readUInt32LE(offset), 0x04034b50, 'A local ZIP header is malformed.');
    const localFlags = archive.readUInt16LE(offset + 6);
    const localMethod = archive.readUInt16LE(offset + 8);
    const localNameLength = archive.readUInt16LE(offset + 26);
    const localExtraLength = archive.readUInt16LE(offset + 28);
    const localNameStart = offset + 30;
    const localNameEnd = localNameStart + localNameLength;
    const dataStart = localNameEnd + localExtraLength;
    const dataEnd = dataStart + entry.compressedBytes;

    assert.equal(localFlags, entry.flags, 'A local ZIP header changed its flags.');
    assert.equal(
      localFlags & (0x1 | 0x40 | 0x2000),
      0,
      'Encrypted local ZIP entries are forbidden.',
    );
    assert.equal(localMethod, entry.method, 'A local ZIP header changed compression method.');
    assert.ok(dataEnd <= centralDirectoryOffset, 'Compressed source bytes escape their envelope.');
    assert.deepEqual(
      archive.subarray(localNameStart, localNameEnd),
      entry.nameBytes,
      'A local ZIP path differs from its central entry.',
    );
    localRanges.push([offset, dataEnd]);
  }

  localRanges.sort(([left], [right]) => left - right);
  for (let index = 1; index < localRanges.length; index += 1) {
    assert.ok(
      localRanges[index][0] >= localRanges[index - 1][1],
      'Source archive local entries overlap.',
    );
  }

  return entries.length;
}

export async function verifyFf132DeployedFunctionSourceArchives(
  functions,
  deployedRevision,
  { commandRunner = runCommand } = {},
) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'rinkrat-ff132-functions-'));

  try {
    const gitArchivePath = path.join(temporaryRoot, 'functions-source.tar');
    commandRunner('git', [
      'archive',
      '--format=tar',
      `--output=${gitArchivePath}`,
      deployedRevision,
      'functions',
    ], { cwd: REPOSITORY_ROOT });
    commandRunner('tar', ['-xf', gitArchivePath, '-C', temporaryRoot]);
    const cleanFunctionsRoot = path.join(temporaryRoot, 'functions');
    commandRunner(
      'npm',
      ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
      {
        cwd: cleanFunctionsRoot,
        timeout: 300_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    commandRunner(
      'npm',
      ['run', 'build'],
      {
        cwd: cleanFunctionsRoot,
        timeout: 180_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const cleanGitManifest = await collectFileDigestManifest(cleanFunctionsRoot, {
      applyFunctionsIgnore: true,
    });

    for (const deployedFunction of functions) {
      const functionDirectory = path.join(temporaryRoot, deployedFunction.name);
      const archivePath = path.join(temporaryRoot, `${deployedFunction.name}.zip`);
      const source = deployedFunction.source;
      const storageUri = `gs://${source.bucket}/${source.object}#${source.generation}`;

      commandRunner(
        'gcloud',
        ['storage', 'cp', storageUri, archivePath, '--quiet'],
        { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      );
      const archiveStats = await stat(archivePath);
      assert.ok(
        archiveStats.isFile() && archiveStats.size <= MAX_SOURCE_ARCHIVE_BYTES,
        'The downloaded Function source archive exceeds its reviewed byte envelope.',
      );
      assertFf132SourceArchiveBuffer(await readFile(archivePath), cleanGitManifest);
      commandRunner('unzip', ['-qq', '-o', archivePath, '-d', functionDirectory]);
      const deployedManifest = await collectFileDigestManifest(functionDirectory);
      assertExactFunctionSourceManifest(cleanGitManifest, deployedManifest);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  return functions.length;
}

function normalizedHttpsUrl(value) {
  const url = new URL(value ?? 'https://invalid.invalid');
  assert.equal(url.protocol, 'https:');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.href;
}

export function assertFf132SchedulerJob(job, schedulerFunction) {
  assert.equal(job?.state, 'ENABLED', 'The Draft scheduler job is not enabled.');
  assert.equal(job?.schedule, '* * * * *', 'The Draft scheduler cadence is not every minute.');
  assert.equal(job?.timeZone, 'UTC', 'The Draft scheduler time zone is not UTC.');
  assert.equal(job?.attemptDeadline, '540s', 'The Draft scheduler deadline changed.');
  assert.equal(job?.httpTarget?.httpMethod, 'POST', 'The Draft scheduler target is not POST.');
  assert.equal(
    job?.name,
    `projects/${D1N_STAGING_PROJECT_ID}/locations/${FF132_REGION}/jobs/${FF132_DRAFT_SCHEDULER_JOB}`,
    'The Draft scheduler identity is unexpected.',
  );
  assert.equal(schedulerFunction?.name, SCHEDULER_EXPECTED_TARGET);
  assert.equal(
    normalizedHttpsUrl(job?.httpTarget?.uri),
    normalizedHttpsUrl(schedulerFunction?.uri),
    'The Draft scheduler does not target the verified Function URI.',
  );
  assert.equal(
    normalizedHttpsUrl(job?.httpTarget?.oidcToken?.audience),
    normalizedHttpsUrl(schedulerFunction?.uri),
    'The Draft scheduler OIDC audience diverges from the verified Function URI.',
  );
  assert.equal(
    job?.httpTarget?.oidcToken?.serviceAccountEmail,
    schedulerFunction?.serviceAccountEmail,
    'The Draft scheduler service account diverges from the verified Function.',
  );
  assert.equal(
    Number(job?.retryConfig?.retryCount ?? 0),
    0,
    'The Draft scheduler unexpectedly retries a failed scan.',
  );
  assert.equal(job?.retryConfig?.maxRetryDuration, '0s');
  assert.equal(job?.retryConfig?.minBackoffDuration, '5s');
  assert.equal(job?.retryConfig?.maxBackoffDuration, '3600s');
  assert.equal(job?.retryConfig?.maxDoublings, 5);
  const statusCode = Number(job?.status?.code ?? 0);
  assert.equal(statusCode, 0, 'The Draft scheduler reports an unhealthy prior attempt.');

  return {
    lastAttemptMilliseconds: timestampMilliseconds(job?.lastAttemptTime) ?? 0,
    scheduleTimeMilliseconds: timestampMilliseconds(job?.scheduleTime),
  };
}

export function inspectFf132SchedulerJob(schedulerFunction) {
  const job = parseJsonCommand('gcloud', [
    'scheduler',
    'jobs',
    'describe',
    FF132_DRAFT_SCHEDULER_JOB,
    '--location',
    FF132_REGION,
    '--project',
    D1N_STAGING_PROJECT_ID,
    '--format=json',
  ]);

  return assertFf132SchedulerJob(job, schedulerFunction);
}

export function assertFf132AvailabilityTaskQueue(queue) {
  assert.equal(
    queue?.name,
    `projects/${D1N_STAGING_PROJECT_ID}/locations/${FF132_REGION}/queues/${FF132_AVAILABILITY_TASK_QUEUE}`,
  );
  assert.equal(queue?.state, 'RUNNING');
  assert.equal(queue?.rateLimits?.maxConcurrentDispatches, 1);
  assert.equal(queue?.retryConfig?.maxAttempts, 3);
  assert.equal(queue?.retryConfig?.minBackoff, '30s');
  assert.equal(queue?.retryConfig?.maxBackoff, '120s');
  assert.equal(queue?.retryConfig?.maxDoublings, 2);
  return true;
}

export function inspectFf132AvailabilityTaskQueue() {
  return assertFf132AvailabilityTaskQueue(
    parseJsonCommand('gcloud', [
      'tasks',
      'queues',
      'describe',
      FF132_AVAILABILITY_TASK_QUEUE,
      `--location=${FF132_REGION}`,
      `--project=${D1N_STAGING_PROJECT_ID}`,
      '--format=json',
    ]),
  );
}

export function assertFf132ProjectionTaskQueue(queue) {
  assert.equal(
    queue?.name,
    `projects/${D1N_STAGING_PROJECT_ID}/locations/${FF132_REGION}/queues/${FF132_PROJECTION_TASK_QUEUE}`,
  );
  assert.equal(queue?.state, 'RUNNING');
  assert.equal(queue?.rateLimits?.maxConcurrentDispatches, 2);
  assert.equal(queue?.rateLimits?.maxDispatchesPerSecond, 500);
  assert.equal(queue?.rateLimits?.maxBurstSize, 100);
  assert.equal(queue?.retryConfig?.maxAttempts, 1);
  assert.equal(queue?.retryConfig?.minBackoff, '0.100s');
  assert.equal(queue?.retryConfig?.maxBackoff, '3600s');
  assert.equal(queue?.retryConfig?.maxDoublings, 16);
  return true;
}

export function inspectFf132ProjectionTaskQueue() {
  return assertFf132ProjectionTaskQueue(
    parseJsonCommand('gcloud', [
      'tasks',
      'queues',
      'describe',
      FF132_PROJECTION_TASK_QUEUE,
      `--location=${FF132_REGION}`,
      `--project=${D1N_STAGING_PROJECT_ID}`,
      '--format=json',
    ]),
  );
}

export function assertFf132DraftClockTaskQueue(queue) {
  assert.equal(
    queue?.name,
    `projects/${D1N_STAGING_PROJECT_ID}/locations/${FF132_REGION}/queues/${FF132_DRAFT_CLOCK_TASK_QUEUE}`,
  );
  assert.equal(queue?.state, 'RUNNING');
  assert.equal(queue?.rateLimits?.maxConcurrentDispatches, 10);
  assert.equal(queue?.rateLimits?.maxDispatchesPerSecond, 500);
  assert.equal(queue?.rateLimits?.maxBurstSize, 100);
  assert.equal(queue?.retryConfig?.maxAttempts, 5);
  assert.equal(queue?.retryConfig?.minBackoff, '2s');
  assert.equal(queue?.retryConfig?.maxBackoff, '3600s');
  assert.equal(queue?.retryConfig?.maxDoublings, 16);
  return true;
}

export function inspectFf132DraftClockTaskQueue() {
  return assertFf132DraftClockTaskQueue(
    parseJsonCommand('gcloud', [
      'tasks',
      'queues',
      'describe',
      FF132_DRAFT_CLOCK_TASK_QUEUE,
      `--location=${FF132_REGION}`,
      `--project=${D1N_STAGING_PROJECT_ID}`,
      '--format=json',
    ]),
  );
}

export function listFf132QueueTasks(queueName) {
  const tasks = parseJsonCommand('gcloud', [
    'tasks',
    'list',
    '--project',
    D1N_STAGING_PROJECT_ID,
    '--location',
    FF132_REGION,
    '--queue',
    queueName,
    '--format=json',
  ]);

  assert.equal(Array.isArray(tasks), true, 'Cloud Tasks did not return a bounded task list.');
  return tasks;
}

function queueTaskId(task) {
  return String(task?.name ?? '').split('/').at(-1) ?? '';
}

export function buildFf132ScheduledDraftStartTaskId(scheduledStartMilliseconds) {
  assert.equal(Number.isSafeInteger(scheduledStartMilliseconds), true);
  return createHash('sha256')
    .update(
      `scheduled-draft-start:${D1N_FIXTURE_LEAGUE_ID}:${scheduledStartMilliseconds}`,
    )
    .digest('hex')
    .slice(0, 40);
}

export function assertFf132OwnedClockQueueTasks(tasks, expectedTaskIds) {
  assert.equal(Array.isArray(tasks), true, 'The Draft-clock queue inventory is malformed.');
  assert.ok(tasks.length <= 10, 'The isolated Draft-clock queue is unexpectedly large.');
  const allowed = expectedTaskIds instanceof Set
    ? expectedTaskIds
    : new Set(expectedTaskIds ?? []);
  assert.ok(allowed.size > 0 && allowed.size <= 3);
  const observed = tasks.map(queueTaskId);
  assert.equal(new Set(observed).size, observed.length, 'The Draft-clock queue has duplicate IDs.');

  for (const taskId of observed) {
    assert.match(taskId, SHA1_PATTERN, 'A Draft-clock task identity is malformed.');
    assert.equal(
      allowed.has(taskId),
      true,
      'The Draft-clock queue contains a task not owned by this evidence run.',
    );
  }

  return observed;
}

function deleteFf132ClockQueueTask(taskId) {
  assert.match(taskId, SHA1_PATTERN);
  runCommand('gcloud', [
    'tasks',
    'delete',
    taskId,
    '--project',
    D1N_STAGING_PROJECT_ID,
    '--location',
    FF132_REGION,
    '--queue',
    FF132_DRAFT_CLOCK_TASK_QUEUE,
    '--quiet',
  ]);
}

async function drainFf132OwnedClockQueueTasks(expectedTaskIds, timeoutMilliseconds) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMilliseconds) {
    const tasks = listFf132QueueTasks(FF132_DRAFT_CLOCK_TASK_QUEUE);
    assertFf132OwnedClockQueueTasks(tasks, expectedTaskIds);

    if (tasks.length === 0) {
      return tasks;
    }

    for (const task of tasks) {
      const taskId = queueTaskId(task);
      const dispatchCount = Number(task?.dispatchCount ?? 0);
      const responseCount = Number(task?.responseCount ?? 0);
      assert.ok(Number.isSafeInteger(dispatchCount) && dispatchCount >= 0);
      assert.ok(Number.isSafeInteger(responseCount) && responseCount >= 0);

      // Do not delete a request already executing against the pre-reset state.
      // Once its response is recorded, deleting its exact ID safely suppresses
      // only later retries; a task that began after reset reads the safe Draft.
      if (dispatchCount > responseCount) {
        continue;
      }

      try {
        deleteFf132ClockQueueTask(taskId);
      } catch (error) {
        const remaining = listFf132QueueTasks(FF132_DRAFT_CLOCK_TASK_QUEUE);
        assertFf132OwnedClockQueueTasks(remaining, expectedTaskIds);

        if (remaining.some((entry) => queueTaskId(entry) === taskId)) {
          throw error;
        }
      }
    }

    await wait(POLL_INTERVAL_MILLISECONDS);
  }

  throw new Error(
    'The exact runner-owned Draft-clock task cleanup did not finish before timeout.',
  );
}

export function assertFf132SingleQueueTask(tasks, expectedTaskId) {
  assert.equal(tasks.length, 1, 'The availability queue must contain one bounded task.');
  assert.equal(
    queueTaskId(tasks[0]),
    expectedTaskId,
    'The availability queue contains an unexpected task identity.',
  );
  return tasks[0];
}

export function describeFf132QueueTask(queueName, taskId) {
  assert.match(taskId, SHA1_PATTERN, 'The expected Cloud Task identity is malformed.');
  return parseJsonCommand('gcloud', [
    'tasks',
    'describe',
    taskId,
    '--project',
    D1N_STAGING_PROJECT_ID,
    '--location',
    FF132_REGION,
    '--queue',
    queueName,
    '--format=json',
  ]);
}

export function assertFf132FirstFailedTaskAttempt(task, expectedTaskId, runStartedAt) {
  assert.equal(
    task?.name,
    `projects/${D1N_STAGING_PROJECT_ID}/locations/${FF132_REGION}/queues/${FF132_AVAILABILITY_TASK_QUEUE}/tasks/${expectedTaskId}`,
    'The Cloud Task resource identity changed.',
  );
  assert.equal(queueTaskId(task), expectedTaskId, 'The Cloud Task identity changed.');
  assert.equal(task?.dispatchCount, 1, 'The retry budget advanced before baseline restoration.');
  assert.equal(task?.responseCount, 1, 'The first failed response was not isolated.');
  const createMilliseconds = timestampMilliseconds(task?.createTime);
  const scheduleMilliseconds = timestampMilliseconds(task?.scheduleTime);
  const firstDispatchMilliseconds = timestampMilliseconds(task?.firstAttempt?.dispatchTime);
  const lastDispatchMilliseconds = timestampMilliseconds(task?.lastAttempt?.dispatchTime);
  const lastResponseMilliseconds = timestampMilliseconds(task?.lastAttempt?.responseTime);
  const lastStatusCode = Number(task?.lastAttempt?.responseStatus?.code);

  assert.ok(createMilliseconds !== null && createMilliseconds >= runStartedAt - 5_000);
  assert.ok(scheduleMilliseconds !== null);
  assert.ok(firstDispatchMilliseconds !== null && lastDispatchMilliseconds !== null);
  assert.ok(lastResponseMilliseconds !== null);
  assert.ok(Number.isSafeInteger(lastStatusCode) && lastStatusCode !== 0);
  assert.equal(lastDispatchMilliseconds, firstDispatchMilliseconds);
  assert.ok(lastResponseMilliseconds >= lastDispatchMilliseconds);
  assert.ok(
    scheduleMilliseconds - lastResponseMilliseconds >= MINIMUM_TASK_RETRY_DELAY_MILLISECONDS &&
      scheduleMilliseconds - lastResponseMilliseconds <= MAXIMUM_TASK_RETRY_DELAY_MILLISECONDS,
    'The exact task retry schedule is outside the bounded queue policy.',
  );

  return {
    createMilliseconds,
    scheduleMilliseconds,
    firstDispatchMilliseconds,
    lastResponseMilliseconds,
  };
}

function requestLogTimestamp(entry) {
  return timestampMilliseconds(entry?.timestamp);
}

export function assertFf132RequestLogs(
  entries,
  { deployedFunction, userAgent, minimumTimestamp, maximumTimestamp, expectedStatuses },
) {
  assert.equal(Array.isArray(entries), true, 'Cloud Run request logs are malformed.');
  const relevant = entries.filter((entry) => {
    const timestamp = requestLogTimestamp(entry);
    return (
      entry?.resource?.type === 'cloud_run_revision' &&
      entry?.resource?.labels?.project_id === D1N_STAGING_PROJECT_ID &&
      entry?.resource?.labels?.location === FF132_REGION &&
      entry?.resource?.labels?.service_name === deployedFunction.serviceName &&
      entry?.resource?.labels?.revision_name === deployedFunction.revision &&
      entry?.labels?.['firebase-functions-hash'] === deployedFunction.sourceHash &&
      entry?.httpRequest?.requestMethod === 'POST' &&
      String(entry?.httpRequest?.userAgent ?? '').includes(userAgent) &&
      timestamp !== null &&
      timestamp >= minimumTimestamp &&
      timestamp <= maximumTimestamp
    );
  });

  assert.deepEqual(
    relevant.map((entry) => Number(entry.httpRequest.status)),
    expectedStatuses,
    'The verified revision did not produce the expected bounded request sequence.',
  );
  return relevant.map((entry) => requestLogTimestamp(entry));
}

export function readFf132RequestLogs(
  deployedFunction,
  userAgent,
  minimumTimestamp,
  maximumTimestamp,
) {
  const start = new Date(minimumTimestamp).toISOString();
  const end = new Date(maximumTimestamp).toISOString();
  const filter = [
    'resource.type="cloud_run_revision"',
    `resource.labels.project_id="${D1N_STAGING_PROJECT_ID}"`,
    `resource.labels.location="${FF132_REGION}"`,
    `resource.labels.service_name="${deployedFunction.serviceName}"`,
    `resource.labels.revision_name="${deployedFunction.revision}"`,
    'httpRequest.requestMethod="POST"',
    `httpRequest.userAgent:"${userAgent}"`,
    `timestamp>="${start}"`,
    `timestamp<="${end}"`,
  ].join(' AND ');

  return parseJsonCommand('gcloud', [
    'logging',
    'read',
    filter,
    `--project=${D1N_STAGING_PROJECT_ID}`,
    '--order=asc',
    '--limit=10',
    '--format=json',
  ]);
}

export function readFf132ApplicationLogs(
  deployedFunction,
  minimumTimestamp,
  maximumTimestamp,
) {
  const start = new Date(minimumTimestamp).toISOString();
  const end = new Date(maximumTimestamp).toISOString();
  const filter = [
    'resource.type="cloud_run_revision"',
    `resource.labels.project_id="${D1N_STAGING_PROJECT_ID}"`,
    `resource.labels.location="${FF132_REGION}"`,
    `resource.labels.service_name="${deployedFunction.serviceName}"`,
    `resource.labels.revision_name="${deployedFunction.revision}"`,
    `timestamp>="${start}"`,
    `timestamp<="${end}"`,
  ].join(' AND ');

  return parseJsonCommand('gcloud', [
    'logging',
    'read',
    filter,
    `--project=${D1N_STAGING_PROJECT_ID}`,
    '--order=asc',
    '--limit=50',
    '--format=json',
  ]);
}

export function assertFf132AlreadyCurrentCompletionLog(entries, deployedFunction) {
  const matched = entries.filter((entry) => {
    const message = String(entry?.jsonPayload?.message ?? entry?.textPayload ?? '');
    return (
      entry?.resource?.labels?.service_name === deployedFunction.serviceName &&
      entry?.resource?.labels?.revision_name === deployedFunction.revision &&
      entry?.labels?.['firebase-functions-hash'] === deployedFunction.sourceHash &&
      message.includes('Automatic Draft availability preparation completed') &&
      entry?.jsonPayload?.status === 'already-current'
    );
  });

  assert.equal(matched.length, 1, 'The correlated retry completion log is missing or duplicated.');
  return true;
}

export function assertFf132NaturalSchedulerAttempt(
  before,
  after,
  expectedSchedulerMilliseconds,
) {
  assert.ok(after.lastAttemptMilliseconds > before.lastAttemptMilliseconds);
  assert.ok(
    after.lastAttemptMilliseconds >= expectedSchedulerMilliseconds - 2_000 &&
      after.lastAttemptMilliseconds <=
        expectedSchedulerMilliseconds +
          FF132_NATURAL_SCHEDULER_CORRELATION_MAX_MILLISECONDS,
    'The scheduler did not naturally run inside the selected minute boundary.',
  );
  return after.lastAttemptMilliseconds - expectedSchedulerMilliseconds;
}

export function triggerFf132DraftScheduler() {
  runCommand('gcloud', [
    'scheduler',
    'jobs',
    'run',
    FF132_DRAFT_SCHEDULER_JOB,
    '--location',
    FF132_REGION,
    '--project',
    D1N_STAGING_PROJECT_ID,
    '--quiet',
  ]);
}

export function assertFf132ManualSchedulerCompletion({
  beforeScheduler,
  afterScheduler,
  beforeAutomationMilliseconds,
  afterAutomationMilliseconds,
  triggerStartedMilliseconds,
  maximumCompletionMilliseconds,
  requestLogs,
  deployedFunction,
  minimumRequestTimestamp,
}) {
  assert.ok(afterScheduler.lastAttemptMilliseconds > beforeScheduler.lastAttemptMilliseconds);
  assert.ok(
    afterScheduler.lastAttemptMilliseconds >= triggerStartedMilliseconds - 2_000 &&
      afterScheduler.lastAttemptMilliseconds <= maximumCompletionMilliseconds,
    'The accepted manual scheduler delivery was not observed before the next minute.',
  );
  assert.ok(afterAutomationMilliseconds > beforeAutomationMilliseconds);
  assert.ok(
    afterAutomationMilliseconds >= triggerStartedMilliseconds - 2_000 &&
      afterAutomationMilliseconds <= maximumCompletionMilliseconds,
    'The manual scheduler delivery did not persist its completion marker in time.',
  );
  assert.ok(
    afterAutomationMilliseconds >= afterScheduler.lastAttemptMilliseconds - 2_000,
    'The automation completion marker predates the accepted scheduler delivery.',
  );
  const timestamps = assertFf132RequestLogs(requestLogs, {
    deployedFunction,
    userAgent: 'Google-Cloud-Scheduler',
    minimumTimestamp: minimumRequestTimestamp,
    maximumTimestamp: maximumCompletionMilliseconds,
    expectedStatuses: [200],
  });
  assert.equal(timestamps.length, 1);
  return Math.max(0, afterAutomationMilliseconds - triggerStartedMilliseconds);
}

async function readDraftAutomationMilliseconds(draftAutomationRef) {
  const snapshot = await draftAutomationRef.get();
  return timestampMilliseconds(snapshot.get('lastRunAt')) ?? 0;
}

async function runCorrelatedFf132DraftScheduler({
  schedulerFunction,
  draftAutomationRef,
  timeoutMilliseconds,
  expectedAvailabilityTaskBucketMilliseconds = null,
}) {
  const safeWindow = await waitFor(
    'A completed natural scheduler run with room before the next minute',
    async () => {
      const nowMilliseconds = Date.now();
      const scheduler = inspectFf132SchedulerJob(schedulerFunction);
      const automationMilliseconds = await readDraftAutomationMilliseconds(draftAutomationRef);
      return { nowMilliseconds, scheduler, automationMilliseconds };
    },
    ({ nowMilliseconds, scheduler, automationMilliseconds }) => {
      const minuteStart = Math.floor(nowMilliseconds / 60_000) * 60_000;
      const nextMinute = minuteStart + 60_000;
      return (
        nextMinute - nowMilliseconds >= MANUAL_SCHEDULER_MINIMUM_REMAINING_MILLISECONDS &&
        scheduler.lastAttemptMilliseconds >= minuteStart - 2_000 &&
        scheduler.lastAttemptMilliseconds <= nowMilliseconds + 2_000 &&
        automationMilliseconds >= scheduler.lastAttemptMilliseconds - 2_000 &&
        automationMilliseconds <= nowMilliseconds + 2_000
      );
    },
    Math.min(timeoutMilliseconds, 3 * 60_000),
  );
  if (expectedAvailabilityTaskBucketMilliseconds !== null) {
    assertDuplicateTaskBucketIsSafe(
      Date.now(),
      expectedAvailabilityTaskBucketMilliseconds,
    );
  }
  const triggerStartedMilliseconds = Date.now();
  const maximumCompletionMilliseconds =
    (Math.floor(triggerStartedMilliseconds / 60_000) + 1) * 60_000 -
    MANUAL_SCHEDULER_COMPLETION_GUARD_MILLISECONDS;
  assert.ok(
    maximumCompletionMilliseconds - triggerStartedMilliseconds >=
      MANUAL_SCHEDULER_MINIMUM_REMAINING_MILLISECONDS -
        MANUAL_SCHEDULER_COMPLETION_GUARD_MILLISECONDS,
  );
  const priorLogs = readFf132RequestLogs(
    schedulerFunction,
    'Google-Cloud-Scheduler',
    Math.floor(triggerStartedMilliseconds / 60_000) * 60_000 - 2_000,
    triggerStartedMilliseconds,
  );
  const priorRequestTimestamp = priorLogs.reduce(
    (maximum, entry) => Math.max(maximum, requestLogTimestamp(entry) ?? 0),
    0,
  );
  const minimumRequestTimestamp = Math.max(
    triggerStartedMilliseconds - 2_000,
    priorRequestTimestamp + 1,
  );

  triggerFf132DraftScheduler();
  const afterScheduler = await waitFor(
    'The exact accepted manual scheduler attempt',
    () => inspectFf132SchedulerJob(schedulerFunction),
    (state) =>
      state.lastAttemptMilliseconds > safeWindow.scheduler.lastAttemptMilliseconds &&
      state.lastAttemptMilliseconds >= triggerStartedMilliseconds - 2_000 &&
      state.lastAttemptMilliseconds <= maximumCompletionMilliseconds,
    Math.min(timeoutMilliseconds, 60_000),
  );
  const afterAutomationMilliseconds = await waitFor(
    'The exact accepted manual scheduler completion marker',
    () => readDraftAutomationMilliseconds(draftAutomationRef),
    (value) =>
      value > safeWindow.automationMilliseconds &&
      value >= triggerStartedMilliseconds - 2_000 &&
      value <= maximumCompletionMilliseconds,
    Math.min(timeoutMilliseconds, 60_000),
  );
  const requestLogs = await waitFor(
    'The exact accepted manual scheduler HTTP 200',
    () =>
      readFf132RequestLogs(
        schedulerFunction,
        'Google-Cloud-Scheduler',
        minimumRequestTimestamp,
        maximumCompletionMilliseconds,
      ),
    (entries) => entries.some((entry) => Number(entry?.httpRequest?.status) === 200),
    Math.min(timeoutMilliseconds, 60_000),
  );

  return assertFf132ManualSchedulerCompletion({
    beforeScheduler: safeWindow.scheduler,
    afterScheduler,
    beforeAutomationMilliseconds: safeWindow.automationMilliseconds,
    afterAutomationMilliseconds,
    triggerStartedMilliseconds,
    maximumCompletionMilliseconds,
    requestLogs,
    deployedFunction: schedulerFunction,
    minimumRequestTimestamp,
  });
}

async function waitFor(label, readValue, predicate, timeoutMilliseconds) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMilliseconds) {
    const value = await readValue();

    if (predicate(value)) {
      return value;
    }

    await wait(POLL_INTERVAL_MILLISECONDS);
  }

  throw new Error(`${label} did not reach the required state before the bounded timeout.`);
}

async function waitUntilBoundary(scheduledStartAt, boundaryMilliseconds, label) {
  const target = scheduledStartAt.getTime() - boundaryMilliseconds + BOUNDARY_SETTLE_MILLISECONDS;
  const delay = target - Date.now();

  if (delay < -5_000) {
    throw new Error(`${label} was missed; refusing to simulate a natural boundary.`);
  }

  if (delay > 0) {
    await wait(delay);
  }

  const remaining = scheduledStartAt.getTime() - Date.now();
  assert.ok(
    remaining <= boundaryMilliseconds && remaining >= boundaryMilliseconds - 10_000,
    `${label} was not observed at its natural boundary.`,
  );
}

async function waitUntilBeforeBoundary(scheduledStartAt, boundaryMilliseconds) {
  const target = scheduledStartAt.getTime() - boundaryMilliseconds - 2_000;
  const delay = target - Date.now();

  if (delay > 0) {
    await wait(delay);
  }
}

export function getNextSafeNaturalSchedulerMinute(
  nowMilliseconds,
  minimumLeadMilliseconds,
) {
  assert.equal(Number.isFinite(nowMilliseconds), true);
  assert.equal(Number.isFinite(minimumLeadMilliseconds), true);
  let candidateMilliseconds =
    Math.ceil((nowMilliseconds + 1) / 60_000) * 60_000;

  while (
    candidateMilliseconds - nowMilliseconds < minimumLeadMilliseconds ||
    Math.floor(candidateMilliseconds / 60_000) % 5 !== 0
  ) {
    candidateMilliseconds += 60_000;
  }

  return candidateMilliseconds;
}

function buildNaturalT25Start(nowMilliseconds, minimumLeadMilliseconds) {
  const schedulerMilliseconds = getNextSafeNaturalSchedulerMinute(
    nowMilliseconds,
    minimumLeadMilliseconds,
  );

  // At the selected minute the start is already one second inside the T-25
  // window. Minute modulo five is zero, leaving almost five minutes before a
  // Cloud Tasks identity bucket can roll over during duplicate observation.
  return {
    schedulerMilliseconds,
    scheduledStartAt: new Date(
      schedulerMilliseconds + AVAILABILITY_BOUNDARY_MILLISECONDS - 1_000,
    ),
  };
}

function assertDuplicateTaskBucketIsSafe(nowMilliseconds, expectedBucketMilliseconds) {
  const currentBucketMilliseconds =
    Math.floor(nowMilliseconds / TASK_BUCKET_MILLISECONDS) * TASK_BUCKET_MILLISECONDS;
  const remainingMilliseconds =
    currentBucketMilliseconds + TASK_BUCKET_MILLISECONDS - nowMilliseconds;

  assert.equal(
    currentBucketMilliseconds,
    expectedBucketMilliseconds,
    'The natural availability delivery slipped into a different five-minute task bucket.',
  );
  assert.ok(
    remainingMilliseconds >= TASK_BUCKET_DUPLICATE_SAFETY_MARGIN_MILLISECONDS,
    'The duplicate probe is too close to a five-minute task-identity rollover.',
  );
}

function assertNaturalBoundaryTimestamp(value, boundaryMilliseconds, label) {
  const observedMilliseconds = timestampMilliseconds(value);
  assert.ok(observedMilliseconds !== null, `${label} did not persist a server timestamp.`);
  assert.ok(
    observedMilliseconds >= boundaryMilliseconds - 2_000 &&
      observedMilliseconds <=
        boundaryMilliseconds + FF132_NATURAL_SCHEDULER_CORRELATION_MAX_MILLISECONDS,
    `${label} was not observed within the bounded natural-scheduler interval.`,
  );
  return Math.max(0, observedMilliseconds - boundaryMilliseconds);
}

function expectedAvailabilityTaskId(dailyKey, bucketMilliseconds) {
  return createHash('sha256')
    .update(`draft-availability:${dailyKey}:${bucketMilliseconds}`)
    .digest('hex')
    .slice(0, 40);
}

function deletedDraftReadinessFields(FieldValue) {
  return Object.fromEntries(
    DRAFT_READINESS_FIELDS.map((field) => [field, FieldValue.delete()]),
  );
}

export function assertFf132UtcWindow(nowMilliseconds, requiredThroughMilliseconds) {
  assert.equal(Number.isFinite(nowMilliseconds), true);
  assert.equal(Number.isFinite(requiredThroughMilliseconds), true);
  assert.equal(
    new Date(nowMilliseconds).toISOString().slice(0, 10),
    new Date(requiredThroughMilliseconds).toISOString().slice(0, 10),
    'FF1.32 evidence refuses to cross a UTC daily-task boundary.',
  );
}

function assertScheduledStoppedZero(draft, scheduledStartAt) {
  assert.equal(draft.status, 'scheduled', 'The evidence Draft must remain scheduled.');
  assert.equal(draft.clockStatus, 'stopped', 'The evidence Draft clock must remain stopped.');
  assert.equal(draft.startedAt ?? null, null, 'The evidence Draft must not acquire startedAt.');
  assert.equal(draft.completedAt ?? null, null, 'The evidence Draft must not complete.');
  assert.equal(draft.nextOverallPick, 1, 'The evidence Draft must remain at its first pick.');
  assert.deepEqual(draft.draftedAssetKeys ?? [], [], 'The evidence Draft must draft no assets.');
  assert.equal(
    timestampMilliseconds(draft.scheduledStartAt),
    scheduledStartAt.getTime(),
    'The evidence Draft schedule changed unexpectedly.',
  );
}

async function assertNoDraftPicks(draftRef) {
  const picks = await draftRef.collection('picks').limit(1).get();
  assert.equal(picks.empty, true, 'FF1.32 evidence refuses to continue after any Draft pick.');
  return picks.size;
}

export function assertStrictSchema2AvailabilityBaseline(data, requiredThroughMilliseconds) {
  assert.equal(data.status, 'success', 'Availability must begin in a successful state.');
  assert.equal(
    data.trigger,
    'draft-readiness-server',
    'Availability must come from the server-owned Draft readiness task.',
  );
  assert.equal(data.updatedBy, 'server:draft-readiness-injury-refresh');
  assert.equal(data.draftReadinessSourceSchemaVersion, 2);
  assert.equal(data.draftReadinessSourceComplete, true);
  assert.equal(typeof data.refreshAttemptId, 'string');
  assert.ok(data.refreshAttemptId.length > 0);
  assert.equal(data.draftReadinessSourceAttemptId, data.refreshAttemptId);
  assert.deepEqual(data.draftReadinessSourceIssues, []);
  assert.match(data.draftReadinessNhlRosterIdentityHash, SHA256_PATTERN);
  assert.equal(data.draftReadinessNhlTeamCount, 32);
  assert.ok(Number.isSafeInteger(data.draftReadinessEspnTeamCount));
  assert.ok(data.draftReadinessEspnTeamCount >= 0);
  assert.ok(Number.isSafeInteger(data.draftReadinessEspnTeamGroupCount));
  assert.equal(
    data.draftReadinessEspnTeamGroupCount,
    data.draftReadinessEspnTeamCount,
    'Every ESPN injury group must resolve to one unique NHL team.',
  );
  assert.equal(data.draftReadinessEspnMalformedTeamGroupCount, 0);
  assert.equal(data.draftReadinessEspnMalformedInjuryEntryCount, 0);
  assert.equal(data.draftReadinessEspnDuplicateTeamGroupCount, 0);
  assert.equal(data.draftReadinessAmbiguousIdentityCount, 0);
  assert.equal(data.draftReadinessMissingAliasTargetCount, 0);
  assert.equal(data.draftReadinessConsecutiveFailureCount, 0);
  assert.equal(data.draftReadinessRetryAfterAt ?? null, null);
  assert.ok(Number.isSafeInteger(data.draftReadinessEspnInjuryEntryCount));
  assert.ok(data.draftReadinessEspnInjuryEntryCount >= 0);
  assert.ok(Number.isSafeInteger(data.draftReadinessNameNotFoundAdvisoryCount));
  assert.ok(data.draftReadinessNameNotFoundAdvisoryCount >= 0);
  assert.equal(Array.isArray(data.records), true);
  assert.ok(data.records.length <= MAX_AVAILABILITY_RECORDS);
  assert.equal(data.syncedRecordCount, data.records.length);

  const lastSuccessfulMilliseconds = timestampMilliseconds(data.lastSuccessfulSyncAt);
  const observedMilliseconds = timestampMilliseconds(data.draftReadinessSourceObservedAt);
  assert.ok(lastSuccessfulMilliseconds !== null);
  assert.ok(observedMilliseconds !== null);
  assert.ok(observedMilliseconds <= Date.now() + 5_000);
  assert.ok(observedMilliseconds <= lastSuccessfulMilliseconds + 30_000);
  assert.equal(
    data.lastDailySyncKey,
    new Date(lastSuccessfulMilliseconds).toISOString().slice(0, 10),
  );
  assert.ok(lastSuccessfulMilliseconds <= Date.now() + 5_000);
  assert.ok(
    requiredThroughMilliseconds - lastSuccessfulMilliseconds <= 24 * 60 * 60 * 1000,
    'The strict availability baseline will expire before the evidence Draft start.',
  );

  return {
    attemptId: data.refreshAttemptId,
    recordsHash: contentHash(data.records),
    sourceHash: contentHash(data),
    sourceIdentityHash: data.draftReadinessNhlRosterIdentityHash,
    lastSuccessfulMilliseconds,
  };
}

export function assertFf132DraftInventory(entries, now = Date.now()) {
  assert.equal(Array.isArray(entries), true);
  assert.ok(entries.length <= MAX_DRAFT_INVENTORY, 'The staging Draft inventory is not bounded.');
  let fixtureSeen = false;

  for (const entry of entries) {
    if (entry.documentId !== 'current') {
      continue;
    }

    const leagueId = entry.leagueId ?? '';
    const draft = entry.draft ?? {};

    if (leagueId === D1N_FIXTURE_LEAGUE_ID) {
      fixtureSeen = true;
      continue;
    }

    assert.equal(
      ['scheduled', 'live'].includes(draft.status),
      false,
      'Another staging Draft could be touched by the full server automation scan.',
    );
  }

  assert.equal(fixtureSeen, true, 'The isolated D1N Draft fixture is missing.');
  return entries.length;
}

async function assertBoundedDraftInventory(firestore) {
  const snapshot = await firestore.collectionGroup('draft').limit(MAX_DRAFT_INVENTORY + 1).get();
  return assertFf132DraftInventory(
    snapshot.docs.map((document) => ({
      documentId: document.id,
      leagueId: document.ref.parent.parent?.id ?? '',
      draft: document.data() ?? {},
    })),
  );
}

export function assertFf132SyntheticDraftSafety(draft, minimumStartMilliseconds) {
  assert.equal(Number.isSafeInteger(minimumStartMilliseconds), true);
  assert.equal(draft.status, 'scheduled', 'The evidence Draft must remain scheduled.');
  assert.equal(draft.clockStatus, 'stopped', 'The evidence Draft clock must remain stopped.');
  assert.equal(draft.startedAt ?? null, null);
  assert.equal(draft.completedAt ?? null, null);
  assert.equal(draft.pickStartedAt ?? null, null);
  assert.equal(draft.nextOverallPick, 1);
  assert.deepEqual(draft.draftedAssetKeys ?? [], []);
  const scheduledStartMilliseconds = timestampMilliseconds(draft.scheduledStartAt);
  assert.ok(
    scheduledStartMilliseconds !== null &&
      scheduledStartMilliseconds >= minimumStartMilliseconds,
    'The evidence Draft is too close to its existing start for safe fixture ownership.',
  );
  return scheduledStartMilliseconds;
}

async function assertSyntheticFixtureSafety(firestore) {
  const leagueRef = firestore.doc(`leagues/${D1N_FIXTURE_LEAGUE_ID}`);
  const draftRef = firestore.doc(`leagues/${D1N_FIXTURE_LEAGUE_ID}/draft/current`);
  const [leagueSnapshot, draftSnapshot, overridesSnapshot] = await Promise.all([
    leagueRef.get(),
    draftRef.get(),
    leagueRef.collection('playerAvailability').limit(1).get(),
  ]);

  assert.ok(leagueSnapshot.exists, 'The isolated D1N league fixture is missing.');
  assert.ok(draftSnapshot.exists, 'The isolated D1N Draft fixture is missing.');
  assert.equal(leagueSnapshot.get('name'), 'D1N Capacity Fixture');
  assert.equal(leagueSnapshot.get('scoringRulesVersion'), 4);
  assert.equal(leagueSnapshot.get('teamCount'), 10);
  assert.equal(overridesSnapshot.empty, true, 'Fixture injury overrides would change Projection V11.');
  await assertNoDraftPicks(draftRef);

  const draft = draftSnapshot.data() ?? {};
  assertFf132SyntheticDraftSafety(
    draft,
    Date.now() + MINIMUM_FIXTURE_START_SAFETY_MILLISECONDS,
  );
  assert.equal(Array.isArray(draft.roundOneOrder), true);
  assert.equal(draft.roundOneOrder.length, 10);
  assert.equal(draft.roundOneOrder[0], leagueSnapshot.get('commissionerId'));

  return { draftRef, draftBaselineHash: contentHash(draft) };
}

export async function acquireFf132EvidenceLock(
  firestore,
  lockRef,
  Timestamp,
  runId,
  timeoutMilliseconds,
) {
  const now = Date.now();

  try {
    await firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(lockRef);

      if (snapshot.exists) {
        throw new Error('An FF1.32 evidence lock exists and requires diagnosis before another run.');
      }

      transaction.set(lockRef, {
        schemaVersion: 1,
        status: 'running',
        runId,
        startedAt: Timestamp.fromMillis(now),
        expiresAt: Timestamp.fromMillis(
          now + timeoutMilliseconds + LOCK_CLEANUP_RESERVE_MILLISECONDS,
        ),
      });
    });
    return {
      lockOwned: true,
      ownershipUncertain: false,
      acquisitionError: null,
    };
  } catch (acquisitionError) {
    try {
      const snapshot = await lockRef.get();
      return {
        lockOwned: snapshot.exists && snapshot.get('runId') === runId,
        ownershipUncertain: false,
        acquisitionError,
      };
    } catch {
      return {
        lockOwned: false,
        ownershipUncertain: true,
        acquisitionError,
      };
    }
  }
}

async function renewEvidenceLock(firestore, lockRef, Timestamp, runId, timeoutMilliseconds) {
  const now = Date.now();

  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(lockRef);
    assert.ok(snapshot.exists, 'The FF1.32 evidence lock disappeared.');
    assert.equal(snapshot.get('status'), 'running', 'The FF1.32 evidence lock is not runnable.');
    assert.equal(snapshot.get('runId'), runId, 'The FF1.32 evidence lock changed ownership.');
    transaction.set(
      lockRef,
      {
        renewedAt: Timestamp.fromMillis(now),
        expiresAt: Timestamp.fromMillis(
          now + timeoutMilliseconds + LOCK_CLEANUP_RESERVE_MILLISECONDS,
        ),
      },
      { merge: true },
    );
  });
}

async function markEvidenceLockCleanupRequired(firestore, lockRef, Timestamp, runId) {
  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(lockRef);

    if (!snapshot.exists || snapshot.get('runId') !== runId) {
      return;
    }

    transaction.set(
      lockRef,
      {
        status: 'cleanup-required',
        cleanupRequiredAt: Timestamp.fromMillis(Date.now()),
        expiresAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000),
      },
      { merge: true },
    );
  });
}

async function releaseEvidenceLock(firestore, lockRef, runId) {
  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(lockRef);

    assert.ok(snapshot.exists, 'The FF1.32 evidence lock disappeared before release.');
    assert.equal(snapshot.get('status'), 'running', 'The FF1.32 evidence lock is not releasable.');
    assert.equal(snapshot.get('runId'), runId, 'The FF1.32 evidence lock changed ownership.');
    transaction.delete(lockRef);
  });
}

export async function prepareFf132InitialEvidenceState({
  firestore,
  FieldValue,
  Timestamp,
  draftRef,
  availabilityRef,
  baseline,
  baselineAttestation,
  initialStartAt,
  leaseExpiresAt,
}) {
  await firestore.runTransaction(async (transaction) => {
    const [draftSnapshot, availabilitySnapshot] = await Promise.all([
      transaction.get(draftRef),
      transaction.get(availabilityRef),
    ]);
    const draft = draftSnapshot.data() ?? {};
    const availability = availabilitySnapshot.data() ?? {};

    assert.ok(draftSnapshot.exists && availabilitySnapshot.exists);
    assertFf132SyntheticDraftSafety(
      draft,
      Date.now() + MINIMUM_FIXTURE_START_SAFETY_MILLISECONDS,
    );
    assert.equal(contentHash(availability), baselineAttestation.sourceHash);

    transaction.set(
      draftRef,
      {
        ...deletedDraftReadinessFields(FieldValue),
        status: 'scheduled',
        scheduledStartAt: Timestamp.fromMillis(initialStartAt.getTime()),
        startedAt: null,
        completedAt: null,
        clockStatus: 'stopped',
        pickStartedAt: null,
        currentPickSeconds: draft.pickSeconds ?? 120,
        pausedRemainingSeconds: null,
        draftedAssetKeys: [],
        nextOverallPick: 1,
        lastPickId: null,
        clockUpdatedBy: 'ff132-staging-evidence',
        clockUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    transaction.set(
      availabilityRef,
      {
        status: 'running',
        leaseExpiresAt,
      },
      { merge: true },
    );
  });

  return {
    baseline,
    overlayLeaseMilliseconds: leaseExpiresAt.toMillis(),
  };
}

export function getFf132AvailabilityRestorePatch({
  current,
  baseline,
  baselineAttestation,
  overlayLeaseMilliseconds,
  deleteSentinel,
}) {
  if (contentHash(current) === baselineAttestation.sourceHash) {
    return null;
  }

  const ignored = new Set(['status', 'leaseExpiresAt']);
  assert.equal(current.status, 'running', 'Availability no longer has the runner-owned lease.');
  assert.equal(
    timestampMilliseconds(current.leaseExpiresAt),
    overlayLeaseMilliseconds,
    'Availability lease ownership changed during evidence.',
  );
  assert.equal(current.refreshAttemptId, baselineAttestation.attemptId);
  assert.equal(current.draftReadinessSourceAttemptId, baselineAttestation.attemptId);
  assert.equal(contentHash(current.records), baselineAttestation.recordsHash);
  assert.equal(
    contentHash(omitKeys(current, ignored)),
    contentHash(omitKeys(baseline, ignored)),
    'Availability changed outside the two runner-owned lease fields.',
  );

  return {
    status: baseline.status,
    leaseExpiresAt: Object.hasOwn(baseline, 'leaseExpiresAt')
      ? baseline.leaseExpiresAt
      : deleteSentinel,
  };
}

export function reconcileFf132FixtureOwnership({
  draft,
  draftBaselineHash,
  plannedScheduledStartMilliseconds,
  availability,
  availabilityBaseline,
  availabilityAttestation,
  overlayLeaseMilliseconds,
}) {
  assert.ok(
    plannedScheduledStartMilliseconds instanceof Set &&
      plannedScheduledStartMilliseconds.size > 0,
    'The evidence runner has no bounded schedule ownership set.',
  );
  const draftHash = contentHash(draft);
  let draftMutated = false;

  if (draftHash !== draftBaselineHash) {
    assert.equal(draft.status, 'scheduled', 'The evidence Draft is no longer safely scheduled.');
    assert.equal(draft.clockStatus, 'stopped', 'The evidence Draft clock is no longer stopped.');
    assert.equal(draft.startedAt ?? null, null);
    assert.equal(draft.completedAt ?? null, null);
    assert.equal(draft.nextOverallPick, 1);
    assert.deepEqual(draft.draftedAssetKeys ?? [], []);
    assert.match(
      String(draft.clockUpdatedBy ?? ''),
      /^ff132-staging-evidence(?:-|$)/,
      'The Draft changed without the evidence runner ownership marker.',
    );
    const scheduledStartMilliseconds = timestampMilliseconds(draft.scheduledStartAt);
    assert.equal(
      plannedScheduledStartMilliseconds.has(scheduledStartMilliseconds),
      true,
      'The evidence Draft moved to an unowned schedule.',
    );
    draftMutated = true;
  }

  let availabilityOverlayOwned = false;

  if (contentHash(availability) !== availabilityAttestation.sourceHash) {
    assert.notEqual(overlayLeaseMilliseconds, null);
    const patch = getFf132AvailabilityRestorePatch({
      current: availability,
      baseline: availabilityBaseline,
      baselineAttestation: availabilityAttestation,
      overlayLeaseMilliseconds,
      deleteSentinel: Symbol('ff132-reconcile-delete'),
    });
    assert.ok(patch, 'The availability state changed without a runner-owned overlay.');
    availabilityOverlayOwned = true;
  }

  return { draftMutated, availabilityOverlayOwned };
}

async function restoreAvailabilityWithCas({
  firestore,
  FieldValue,
  availabilityRef,
  baseline,
  baselineAttestation,
  overlayLeaseMilliseconds,
}) {
  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(availabilityRef);
    const current = snapshot.data() ?? {};
    const patch = getFf132AvailabilityRestorePatch({
      current,
      baseline,
      baselineAttestation,
      overlayLeaseMilliseconds,
      deleteSentinel: FieldValue.delete(),
    });

    if (patch) {
      transaction.set(availabilityRef, patch, { merge: true });
    }
  });

  const restored = (await availabilityRef.get()).data() ?? {};
  assert.equal(
    contentHash(restored),
    baselineAttestation.sourceHash,
    'Availability was not restored byte-for-byte at the document-data boundary.',
  );
}

async function assertMaintenanceCheckpoint({
  firestore,
  lockRef,
  Timestamp,
  runId,
  timeoutMilliseconds,
  draftRef,
}) {
  await renewEvidenceLock(firestore, lockRef, Timestamp, runId, timeoutMilliseconds);
  const inventoryCount = await assertBoundedDraftInventory(firestore);

  if (draftRef) {
    await assertNoDraftPicks(draftRef);
  }

  return inventoryCount;
}

async function rescheduleDraft(draftRef, FieldValue, Timestamp, scheduledStartAt) {
  const firestore = draftRef.firestore;

  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(draftRef);
    const draft = snapshot.data() ?? {};

    assert.ok(snapshot.exists);
    assert.equal(draft.status, 'scheduled');
    assert.equal(draft.clockStatus, 'stopped');
    assert.equal(draft.nextOverallPick, 1);
    assert.deepEqual(draft.draftedAssetKeys ?? [], []);

    transaction.set(
      draftRef,
      {
        ...deletedDraftReadinessFields(FieldValue),
        scheduledStartAt: Timestamp.fromMillis(scheduledStartAt.getTime()),
        clockUpdatedBy: 'ff132-staging-evidence-reschedule',
        clockUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
}

async function waitForQueueCount(queueName, expectedCount, timeoutMilliseconds) {
  return waitFor(
    `${queueName} queue count ${expectedCount}`,
    () => listFf132QueueTasks(queueName),
    (tasks) => tasks.length === expectedCount,
    timeoutMilliseconds,
  );
}

async function waitForDraftState(draftRef, predicate, timeoutMilliseconds, label) {
  const snapshot = await waitFor(
    label,
    () => draftRef.get(),
    (current) => predicate(current.data() ?? {}),
    timeoutMilliseconds,
  );
  return snapshot.data() ?? {};
}

export function buildFf132ProjectionRequestId(
  scheduledStartMilliseconds,
  availabilityRevision,
) {
  assert.equal(Number.isSafeInteger(scheduledStartMilliseconds), true);
  assert.match(availabilityRevision, SHA256_PATTERN);
  const baseRequestKey = `draft-readiness-${createHash('sha256')
    .update([
      D1N_FIXTURE_LEAGUE_ID,
      String(scheduledStartMilliseconds),
      availabilityRevision,
    ].join(':'))
    .digest('hex')
    .slice(0, 40)}`;
  const requestKey = `${baseRequestKey}-a1`;
  const identity = [D1N_FIXTURE_LEAGUE_ID, requestKey, '1', availabilityRevision].join(':');
  return `projection-draft-${createHash('sha256')
    .update(identity)
    .digest('hex')
    .slice(0, 32)}`;
}

export function assertFf132ProjectionRequest(
  request,
  expectedRequestId,
  availabilityRevision,
  {
    runStartedMilliseconds,
    projectionBoundaryMilliseconds,
    observedAtMilliseconds,
  },
) {
  for (const timestamp of [
    runStartedMilliseconds,
    projectionBoundaryMilliseconds,
    observedAtMilliseconds,
  ]) {
    assert.equal(Number.isSafeInteger(timestamp), true);
  }
  assert.ok(projectionBoundaryMilliseconds >= runStartedMilliseconds);
  assert.ok(observedAtMilliseconds >= projectionBoundaryMilliseconds);
  assert.equal(request.schemaVersion, 1);
  assert.equal(request.requestId, expectedRequestId);
  assert.equal(request.status, 'ready');
  assert.equal(request.leagueId, D1N_FIXTURE_LEAGUE_ID);
  assert.equal(request.requestedBy, SERVER_DRAFT_ACTOR);
  assert.equal(request.generationReason, 'pre-draft');
  assert.equal(request.targetCycleNumber, 1);
  assert.equal(request.teamCount, 10);
  assert.equal(request.requiredGamesPerCycle, 6);
  assert.equal(request.availabilityRevision, availabilityRevision);
  assert.match(request.payloadHash, SHA256_PATTERN);
  assert.equal(typeof request.snapshotId, 'string');
  assert.ok(request.snapshotId.length > 0);
  assert.match(request.snapshotContentHash, SHA256_PATTERN);
  const createdMilliseconds = timestampMilliseconds(request.createdAt);
  const startedMilliseconds = timestampMilliseconds(request.startedAt);
  const completedMilliseconds = timestampMilliseconds(request.completedAt);
  assert.ok(createdMilliseconds !== null);
  assert.ok(startedMilliseconds !== null);
  assert.ok(completedMilliseconds !== null);
  assert.ok(
    createdMilliseconds >=
      Math.max(runStartedMilliseconds - 5_000, projectionBoundaryMilliseconds - 2_000),
    'The Projection request predates the bounded natural T-20 interval.',
  );
  assert.ok(
    createdMilliseconds <=
      projectionBoundaryMilliseconds +
        FF132_NATURAL_SCHEDULER_CORRELATION_MAX_MILLISECONDS,
    'The Projection request was created outside the natural T-20 scheduler interval.',
  );
  assert.ok(createdMilliseconds <= startedMilliseconds);
  assert.ok(startedMilliseconds <= completedMilliseconds);
  assert.ok(
    completedMilliseconds <= observedAtMilliseconds + 5_000,
    'The Projection request contains a future completion timestamp.',
  );
  assert.ok(Number.isFinite(request.durationMilliseconds));
  assert.ok(request.durationMilliseconds >= 0);
  assert.ok(request.durationMilliseconds <= DEFAULT_TIMEOUT_MILLISECONDS);
  assert.ok(
    completedMilliseconds - startedMilliseconds >= request.durationMilliseconds - 1_000 &&
      completedMilliseconds - startedMilliseconds <= request.durationMilliseconds + 60_000,
    'The Projection request duration diverges from its server timestamps.',
  );
  return true;
}

async function assertProjectionSnapshot(firestore, request, availabilityAttestation) {
  const snapshotRef = firestore.doc(
    `leagues/${D1N_FIXTURE_LEAGUE_ID}/projectionSnapshots/${request.snapshotId}`,
  );
  const snapshot = await snapshotRef.get();
  assert.ok(snapshot.exists, 'The Projection V11 snapshot metadata is missing.');
  const metadata = snapshot.data() ?? {};

  assert.equal(metadata.snapshotId, request.snapshotId);
  assert.equal(metadata.activeSnapshotId, request.snapshotId);
  assert.equal(metadata.status, 'ready');
  assert.equal(metadata.projectionVersion, 11);
  assert.equal(metadata.scoringRulesVersion, 4);
  assert.equal(metadata.generationReason, 'pre-draft');
  assert.equal(metadata.generationRequestId, request.requestId);
  assert.equal(metadata.targetCycleNumber, 1);
  assert.equal(metadata.teamCount, 10);
  assert.equal(metadata.requiredGamesPerCycle, 6);
  assert.equal(metadata.availabilityRevision, request.availabilityRevision);
  assert.equal(metadata.availabilityRosterIdentityHash, availabilityAttestation.sourceIdentityHash);
  assert.equal(metadata.teamScheduleInputContractVersion, 1);
  assert.equal(metadata.teamScheduleInputCompleteness, 'complete');
  assert.equal(metadata.authoritySchemaVersion, 2);
  assert.equal(metadata.generatedByAuthority, 'server');
  assert.equal(metadata.catalogValidationStatus, 'validated');
  assert.match(metadata.catalogHash, SHA256_PATTERN);
  assert.equal(metadata.snapshotHashSchemaVersion, 2);
  assert.equal(metadata.snapshotHashAlgorithm, 'sha256');
  assert.equal(metadata.snapshotIntegrityStatus, 'verified');
  assert.equal(metadata.snapshotContentHash, request.snapshotContentHash);
  assert.equal(Array.isArray(metadata.snapshotChunkHashes), true);
  assert.ok(metadata.snapshotChunkHashes.length > 0);
  assert.equal(metadata.snapshotChunkHashes.every((hash) => SHA256_PATTERN.test(hash)), true);
  assert.ok(Number.isSafeInteger(metadata.assetCount) && metadata.assetCount > 0);
  assert.ok(Number.isSafeInteger(metadata.assetDocumentCount) && metadata.assetDocumentCount > 0);
  assert.ok(
    metadata.assetDocumentCount <= MAX_PROJECTION_SNAPSHOT_CHUNKS,
    'The Projection snapshot exceeds the reviewed evidence-read envelope.',
  );
  assert.ok(
    metadata.assetCount <=
      MAX_PROJECTION_SNAPSHOT_CHUNKS * PROJECTION_SNAPSHOT_ASSET_CHUNK_SIZE,
  );
  assert.equal(
    metadata.assetDocumentCount,
    Math.ceil(metadata.assetCount / PROJECTION_SNAPSHOT_ASSET_CHUNK_SIZE),
  );
  assert.equal(metadata.snapshotChunkHashes.length, metadata.assetDocumentCount);
  assert.equal(request.snapshotChunkCount, metadata.assetDocumentCount);
  assert.equal(metadata.canonicalAssetCount, metadata.assetCount);
  assert.equal(request.canonicalAssetCount, metadata.assetCount);

  const chunks = await snapshotRef.collection('assets').limit(metadata.assetDocumentCount + 1).get();
  assert.equal(chunks.size, metadata.assetDocumentCount);
  let assetCount = 0;

  for (const chunk of chunks.docs) {
    const data = chunk.data() ?? {};
    assert.equal(data.schemaVersion, 3);
    assert.equal(data.snapshotContentHash, metadata.snapshotContentHash);
    assert.match(data.chunkHash, SHA256_PATTERN);
    assert.equal(metadata.snapshotChunkHashes.includes(data.chunkHash), true);
    assert.equal(Array.isArray(data.assets), true);
    assert.ok(data.assets.length <= PROJECTION_SNAPSHOT_ASSET_CHUNK_SIZE);
    assert.equal(data.assetCount, data.assets.length);
    assetCount += data.assets.length;
  }

  assert.equal(assetCount, metadata.assetCount);
  return metadata;
}

async function assertOneOwnedProjectionRequest(firestore, requestId, runStartedAt) {
  const snapshot = await firestore
    .collection('projectionGenerationRequests')
    .where('leagueId', '==', D1N_FIXTURE_LEAGUE_ID)
    .limit(101)
    .get();
  assert.ok(snapshot.size <= 100, 'Fixture projection request history is not bounded.');

  const matching = snapshot.docs.filter((document) => {
    const data = document.data() ?? {};
    const createdAt = timestampMilliseconds(data.createdAt);
    return (
      data.generationReason === 'pre-draft' &&
      createdAt !== null &&
      createdAt >= runStartedAt - 5_000
    );
  });

  assert.equal(matching.length, 1, 'One schedule/revision must create exactly one request.');
  assert.equal(matching[0].id, requestId, 'The authoritative request identity diverged.');
  return matching.length;
}

async function resetDraftFirst(draftRef, FieldValue, Timestamp) {
  await assertNoDraftPicks(draftRef);
  const safeStartAt = new Date(Date.now() + SAFE_RESET_MILLISECONDS);
  const firestore = draftRef.firestore;

  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(draftRef);
    const draft = snapshot.data() ?? {};

    assert.ok(snapshot.exists);
    assert.equal(draft.status, 'scheduled', 'Cleanup refuses to rewind a started Draft.');
    assert.equal(draft.clockStatus, 'stopped');
    assert.equal(draft.nextOverallPick, 1);
    assert.deepEqual(draft.draftedAssetKeys ?? [], []);

    transaction.set(
      draftRef,
      {
        ...deletedDraftReadinessFields(FieldValue),
        status: 'scheduled',
        scheduledStartAt: Timestamp.fromMillis(safeStartAt.getTime()),
        startedAt: null,
        completedAt: null,
        clockStatus: 'stopped',
        pickStartedAt: null,
        currentPickSeconds: draft.pickSeconds ?? 120,
        pausedRemainingSeconds: null,
        draftedAssetKeys: [],
        nextOverallPick: 1,
        lastPickId: null,
        clockUpdatedBy: 'ff132-staging-evidence-cleanup',
        clockUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });

  return safeStartAt;
}

export async function runFf132CleanupStages({
  resetDraft,
  drainDraftClockQueue,
  awaitProjectionTerminal,
  restoreAvailability,
  drainAvailabilityQueue,
  drainProjectionQueue,
  verifyDraftInventory,
  markCleanupRequired,
  releaseLock,
}) {
  const failures = [];
  let draftResetFailed = false;

  if (typeof resetDraft === 'function') {
    try {
      await resetDraft();
    } catch {
      failures.push('reset-draft');
      draftResetFailed = true;
    }
  }

  if (typeof drainDraftClockQueue === 'function') {
    if (draftResetFailed) {
      failures.push('drain-draft-clock-queue-blocked');
    } else {
      try {
        await drainDraftClockQueue();
      } catch {
        failures.push('drain-draft-clock-queue');
      }
    }
  }

  for (const [name, operation] of [
    ['await-projection-terminal', awaitProjectionTerminal],
    ['drain-projection-queue', drainProjectionQueue],
  ]) {
    if (typeof operation === 'function') {
      try {
        await operation();
      } catch {
        failures.push(name);
      }
    }
  }

  if (typeof restoreAvailability === 'function') {
    if (draftResetFailed) {
      // Keeping the temporary unavailable state fails closed if the Draft
      // could not first be moved safely away from its start time.
      failures.push('restore-availability-blocked');
    } else {
      try {
        await restoreAvailability();
      } catch {
        failures.push('restore-availability');
      }
    }
  }

  for (const [name, operation] of [
    ['drain-availability-queue', drainAvailabilityQueue],
    ['verify-draft-inventory', verifyDraftInventory],
  ]) {
    if (typeof operation === 'function') {
      try {
        await operation();
      } catch {
        failures.push(name);
      }
    }
  }

  if (failures.length > 0) {
    try {
      await markCleanupRequired();
    } catch {
      failures.push('mark-cleanup-required');
    }

    return {
      cleanupComplete: false,
      lockReleased: false,
      failedStageCount: failures.length,
    };
  }

  try {
    await releaseLock();
  } catch {
    try {
      await markCleanupRequired();
    } catch {
      // The public boundary intentionally reports only aggregate cleanup state.
    }

    return {
      cleanupComplete: false,
      lockReleased: false,
      failedStageCount: 1,
    };
  }

  return {
    cleanupComplete: true,
    lockReleased: true,
    failedStageCount: 0,
  };
}

function publicBoundedNumber(value, maximum) {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= maximum
    ? value
    : null;
}

function publicExactInteger(value, expected) {
  return Number.isSafeInteger(value) && value === expected ? value : null;
}

export function buildPublicFf132Evidence(evidence) {
  return {
    environment: 'isolated-staging',
    deployedRuntimeRevision: GIT_REVISION_PATTERN.test(evidence.deployedRuntimeRevision ?? '')
      ? evidence.deployedRuntimeRevision
      : null,
    toolingRevision: GIT_REVISION_PATTERN.test(evidence.toolingRevision ?? '')
      ? evidence.toolingRevision
      : null,
    releaseManifestMatched: evidence.releaseManifestMatched === true,
    cleanPushedToolingDelta: evidence.cleanPushedToolingDelta === true,
    requiredStagingFunctionsActive: evidence.requiredStagingFunctionsActive === true,
    exactFunctionSourceMatched: evidence.exactFunctionSourceMatched === true,
    cloudRunRevisionMatched: evidence.cloudRunRevisionMatched === true,
    schedulerConfigurationMatched: evidence.schedulerConfigurationMatched === true,
    taskQueueConfigurationMatched: evidence.taskQueueConfigurationMatched === true,
    boundedDraftInventory: evidence.boundedDraftInventory === true,
    availabilityQueueInitiallyEmpty: evidence.availabilityQueueInitiallyEmpty === true,
    projectionQueueInitiallyEmpty: evidence.projectionQueueInitiallyEmpty === true,
    draftClockQueueInitiallyEmpty: evidence.draftClockQueueInitiallyEmpty === true,
    strictSchema2Baseline: evidence.strictSchema2Baseline === true,
    availabilityRecordsUnchanged: evidence.availabilityRecordsUnchanged === true,
    naturalAvailabilityBoundary: evidence.naturalAvailabilityBoundary === true,
    naturalAvailabilitySchedulerObserved:
      evidence.naturalAvailabilitySchedulerObserved === true,
    availabilityBoundaryLatencyMilliseconds: publicBoundedNumber(
      evidence.availabilityBoundaryLatencyMilliseconds,
      FF132_NATURAL_SCHEDULER_CORRELATION_MAX_MILLISECONDS,
    ),
    activeLeaseFirstDelivery: evidence.activeLeaseFirstDelivery === true,
    exactFirstTaskFailureObserved: evidence.exactFirstTaskFailureObserved === true,
    duplicateAvailabilityQueueConverged: evidence.duplicateAvailabilityQueueConverged === true,
    retryUsedCurrentBaseline: evidence.retryUsedCurrentBaseline === true,
    retryEvidenceScope: evidence.retryEvidenceScope === 'singleton-revision-correlated'
      ? evidence.retryEvidenceScope
      : 'unverified',
    availabilityRetryDelayMilliseconds: publicBoundedNumber(
      evidence.availabilityRetryDelayMilliseconds,
      MAXIMUM_TASK_RETRY_DELAY_MILLISECONDS,
    ),
    nearZeroStayedFailClosed: evidence.nearZeroStayedFailClosed === true,
    rescheduleRecovered: evidence.rescheduleRecovered === true,
    naturalProjectionBoundary: evidence.naturalProjectionBoundary === true,
    naturalProjectionSchedulerObserved:
      evidence.naturalProjectionSchedulerObserved === true,
    projectionBoundaryLatencyMilliseconds: publicBoundedNumber(
      evidence.projectionBoundaryLatencyMilliseconds,
      FF132_NATURAL_SCHEDULER_CORRELATION_MAX_MILLISECONDS,
    ),
    authoritativeProjectionRequestCount: publicExactInteger(
      evidence.authoritativeProjectionRequestCount,
      1,
    ),
    projectionVersion: publicExactInteger(evidence.projectionVersion, 11),
    scoringRulesVersion: publicExactInteger(evidence.scoringRulesVersion, 4),
    teamScheduleInputComplete: evidence.teamScheduleInputComplete === true,
    duplicateProjectionDeliveryConverged: evidence.duplicateProjectionDeliveryConverged === true,
    clockStayedStopped: evidence.clockStayedStopped === true,
    pickCount: publicExactInteger(evidence.pickCount, 0),
    projectionAuditRetained: evidence.projectionAuditRetained === true,
    draftClockQueueCleaned: evidence.draftClockQueueCleaned === true,
    cleanupComplete: evidence.cleanupComplete === true,
    lockReleased: evidence.lockReleased === true,
    safeResetDays: 7,
  };
}

export async function runFf132ServerOwnedDraftPreparationStagingEvidence(
  environment = process.env,
) {
  let checkpoint = assertCheckpoint('preflight');
  let app = null;
  let deleteApp = null;
  let FieldValue = null;
  let Timestamp = null;
  let firestore = null;
  const runId = randomUUID();
  const runStartedAt = Date.now();
  let deployedRevision = '';
  let timeoutMilliseconds = DEFAULT_TIMEOUT_MILLISECONDS;
  let gitState = null;
  let requiredFunctions = [];
  let schedulerFunction = null;
  let lockRef = null;
  let lockOwned = false;
  let lockWasAcquired = false;
  let lockOwnershipUncertain = false;
  let draftRef = null;
  let draftAutomationRef = null;
  let draftBaselineHash = '';
  let draftMutated = false;
  let safeResetAt = null;
  let availabilityRef = null;
  let availabilityBaseline = null;
  let availabilityAttestation = null;
  let overlayLeaseMilliseconds = null;
  let availabilityOverlayOwned = false;
  const plannedScheduledStartMilliseconds = new Set();
  const ownedDraftClockTaskIds = new Set();
  let requestId = '';
  let primaryError = null;
  let provisionalEvidence = null;
  let cleanupOutcome = {
    cleanupComplete: true,
    lockReleased: false,
    failedStageCount: 0,
  };

  try {
    ({ deployedRevision, timeoutMilliseconds } = assertFf132StagingSafety(environment));
    gitState = readCleanPushedToolingState(deployedRevision);
    await verifyFf132StagingManifest(deployedRevision);

    checkpoint = assertCheckpoint('runtime-provenance');
    requiredFunctions = inspectFf132StagingFunctionInventory();
    inspectFf132CloudRunDeployments(requiredFunctions);
    await verifyFf132DeployedFunctionSourceArchives(requiredFunctions, deployedRevision);
    schedulerFunction = requiredFunctions.find(
      (entry) => entry.name === SCHEDULER_EXPECTED_TARGET,
    );
    assert.ok(schedulerFunction, 'The verified scheduler Function is missing.');
    inspectFf132SchedulerJob(schedulerFunction);
    inspectFf132AvailabilityTaskQueue();
    inspectFf132ProjectionTaskQueue();
    inspectFf132DraftClockTaskQueue();
    assert.equal(listFf132QueueTasks(FF132_AVAILABILITY_TASK_QUEUE).length, 0);
    assert.equal(listFf132QueueTasks(FF132_PROJECTION_TASK_QUEUE).length, 0);
    assert.equal(listFf132QueueTasks(FF132_DRAFT_CLOCK_TASK_QUEUE).length, 0);

    const adminApp = requireFunctions('firebase-admin/app');
    const adminFirestore = requireFunctions('firebase-admin/firestore');
    deleteApp = adminApp.deleteApp;
    FieldValue = adminFirestore.FieldValue;
    Timestamp = adminFirestore.Timestamp;
    app = adminApp.initializeApp(
      {
        credential: adminApp.applicationDefault(),
        projectId: D1N_STAGING_PROJECT_ID,
      },
      `ff132-staging-evidence-${Date.now()}`,
    );
    assert.equal(app.options.projectId, D1N_STAGING_PROJECT_ID);
    firestore = adminFirestore.getFirestore(app);

    checkpoint = assertCheckpoint('fixture-safety');
    const draftInventoryCount = await assertBoundedDraftInventory(firestore);
    ({ draftRef, draftBaselineHash } = await assertSyntheticFixtureSafety(firestore));
    draftAutomationRef = firestore.doc('appData/draftAutomation');
    availabilityRef = firestore.doc('appData/playerAvailability');
    const initialPlan = buildNaturalT25Start(
      Date.now(),
      NATURAL_SCHEDULER_MINIMUM_INITIAL_LEAD_MILLISECONDS,
    );
    const initialStartAt = initialPlan.scheduledStartAt;
    plannedScheduledStartMilliseconds.add(initialStartAt.getTime());
    ownedDraftClockTaskIds.add(
      buildFf132ScheduledDraftStartTaskId(initialStartAt.getTime()),
    );
    assertFf132UtcWindow(
      Date.now(),
      Date.now() + EVIDENCE_UTC_HORIZON_MILLISECONDS,
    );
    const availabilitySnapshot = await availabilityRef.get();
    assert.ok(availabilitySnapshot.exists, 'The strict availability baseline is missing.');
    availabilityBaseline = availabilitySnapshot.data() ?? {};
    availabilityAttestation = assertStrictSchema2AvailabilityBaseline(
      availabilityBaseline,
      initialStartAt.getTime(),
    );
    const injuryAutomationRef = firestore.doc('appData/injuryAutomation');
    const injuryAutomationBefore = await injuryAutomationRef.get();
    const injuryBaselineRunMilliseconds =
      timestampMilliseconds(injuryAutomationBefore.get('lastRunAt')) ?? 0;
    const leaseExpiresAt = Timestamp.fromMillis(
      Date.now() + timeoutMilliseconds + LOCK_CLEANUP_RESERVE_MILLISECONDS,
    );

    assert.equal(listFf132QueueTasks(FF132_AVAILABILITY_TASK_QUEUE).length, 0);
    assert.equal(listFf132QueueTasks(FF132_PROJECTION_TASK_QUEUE).length, 0);
    assert.equal(listFf132QueueTasks(FF132_DRAFT_CLOCK_TASK_QUEUE).length, 0);
    lockRef = firestore.doc(FF132_EVIDENCE_LOCK_PATH);
    const lockAcquisition = await acquireFf132EvidenceLock(
      firestore,
      lockRef,
      Timestamp,
      runId,
      timeoutMilliseconds,
    );
    lockOwned = lockAcquisition.lockOwned;
    lockWasAcquired = lockAcquisition.lockOwned;
    lockOwnershipUncertain = lockAcquisition.ownershipUncertain;

    if (lockAcquisition.acquisitionError) {
      throw lockAcquisition.acquisitionError;
    }
    await assertMaintenanceCheckpoint({
      firestore,
      lockRef,
      Timestamp,
      runId,
      timeoutMilliseconds,
      draftRef,
    });

    checkpoint = assertCheckpoint('availability-boundary');
    overlayLeaseMilliseconds = leaseExpiresAt.toMillis();
    availabilityOverlayOwned = true;
    draftMutated = true;
    const prepared = await prepareFf132InitialEvidenceState({
      firestore,
      FieldValue,
      Timestamp,
      draftRef,
      availabilityRef,
      baseline: availabilityBaseline,
      baselineAttestation: availabilityAttestation,
      initialStartAt,
      leaseExpiresAt,
    });
    assert.equal(overlayLeaseMilliseconds, prepared.overlayLeaseMilliseconds);

    const schedulerBeforeAvailability = inspectFf132SchedulerJob(schedulerFunction);
    await waitUntilBeforeBoundary(initialStartAt, AVAILABILITY_BOUNDARY_MILLISECONDS);
    await assertMaintenanceCheckpoint({
      firestore,
      lockRef,
      Timestamp,
      runId,
      timeoutMilliseconds,
      draftRef,
    });
    assert.equal(listFf132QueueTasks(FF132_AVAILABILITY_TASK_QUEUE).length, 0);
    const beforeAvailabilityBoundary = (await draftRef.get()).data() ?? {};
    assertScheduledStoppedZero(beforeAvailabilityBoundary, initialStartAt);
    assert.equal(
      beforeAvailabilityBoundary.serverDraftReadinessStatus ?? null,
      null,
      'Availability preparation began before the natural T-25 boundary.',
    );
    assert.equal(beforeAvailabilityBoundary.serverDraftReadinessProjectionRequestId ?? null, null);
    await waitUntilBoundary(
      initialStartAt,
      AVAILABILITY_BOUNDARY_MILLISECONDS,
      'The T-25 availability boundary',
    );

    // The first delivery must come from the natural minute scheduler. Manual
    // runs below are duplicates only, proving convergence without substituting
    // the evidence runner for server ownership.
    const waitingDraft = await waitForDraftState(
      draftRef,
      (draft) => draft.serverDraftReadinessStatus === 'waiting-injury',
      Math.min(timeoutMilliseconds, NATURAL_SCHEDULER_MAX_OBSERVATION_MILLISECONDS),
      'The natural T-25 waiting-injury state',
    );
    assertScheduledStoppedZero(waitingDraft, initialStartAt);
    assert.equal(waitingDraft.serverDraftReadinessProjectionRequestId ?? null, null);
    const availabilityBoundaryMilliseconds =
      initialStartAt.getTime() - AVAILABILITY_BOUNDARY_MILLISECONDS;
    const availabilityBoundaryLatencyMilliseconds = assertNaturalBoundaryTimestamp(
      waitingDraft.serverDraftReadinessUpdatedAt,
      availabilityBoundaryMilliseconds,
      'Automatic availability preparation',
    );
    const schedulerAfterAvailability = inspectFf132SchedulerJob(schedulerFunction);
    assertFf132NaturalSchedulerAttempt(
      schedulerBeforeAvailability,
      schedulerAfterAvailability,
      initialPlan.schedulerMilliseconds,
    );
    const schedulerAvailabilityLogs = await waitFor(
      'The verified natural T-25 scheduler request log',
      () =>
        readFf132RequestLogs(
          schedulerFunction,
          'Google-Cloud-Scheduler',
          initialPlan.schedulerMilliseconds - 2_000,
          initialPlan.schedulerMilliseconds +
            FF132_NATURAL_SCHEDULER_CORRELATION_MAX_MILLISECONDS,
        ),
      (entries) => entries.some((entry) => Number(entry?.httpRequest?.status) === 200),
      NATURAL_SCHEDULER_MAX_OBSERVATION_MILLISECONDS,
    );
    assertFf132RequestLogs(schedulerAvailabilityLogs, {
      deployedFunction: schedulerFunction,
      userAgent: 'Google-Cloud-Scheduler',
      minimumTimestamp: initialPlan.schedulerMilliseconds - 2_000,
      maximumTimestamp:
        initialPlan.schedulerMilliseconds +
          FF132_NATURAL_SCHEDULER_CORRELATION_MAX_MILLISECONDS,
      expectedStatuses: [200],
    });

    const initialTaskBucketMilliseconds =
      Math.floor(initialPlan.schedulerMilliseconds / TASK_BUCKET_MILLISECONDS) *
      TASK_BUCKET_MILLISECONDS;
    assertDuplicateTaskBucketIsSafe(Date.now(), initialTaskBucketMilliseconds);
    const availabilityTaskId = expectedAvailabilityTaskId(
      new Date(initialPlan.schedulerMilliseconds).toISOString().slice(0, 10),
      initialTaskBucketMilliseconds,
    );
    await waitFor(
      'The deterministic availability task',
      () => listFf132QueueTasks(FF132_AVAILABILITY_TASK_QUEUE),
      (tasks) => tasks.length === 1 && queueTaskId(tasks[0]) === availabilityTaskId,
      timeoutMilliseconds,
    );

    const leaseEventSnapshot = await waitFor(
      'The active-lease availability delivery',
      () => injuryAutomationRef.get(),
      (snapshot) => {
        const data = snapshot.data() ?? {};
        const lastRunAt = timestampMilliseconds(data.lastRunAt) ?? 0;
        return data.lastRunResult === 'lease-active' && lastRunAt > injuryBaselineRunMilliseconds;
      },
      timeoutMilliseconds,
    );
    const leaseEventMilliseconds = timestampMilliseconds(leaseEventSnapshot.get('lastRunAt')) ?? 0;
    const firstFailedTask = await waitFor(
      'The first exact availability task failure',
      () => describeFf132QueueTask(FF132_AVAILABILITY_TASK_QUEUE, availabilityTaskId),
      (task) => task?.dispatchCount === 1 && task?.responseCount === 1,
      timeoutMilliseconds,
    );
    const firstAttempt = assertFf132FirstFailedTaskAttempt(
      firstFailedTask,
      availabilityTaskId,
      runStartedAt,
    );
    await runCorrelatedFf132DraftScheduler({
      schedulerFunction,
      draftAutomationRef,
      timeoutMilliseconds,
      expectedAvailabilityTaskBucketMilliseconds: initialTaskBucketMilliseconds,
    });
    await runCorrelatedFf132DraftScheduler({
      schedulerFunction,
      draftAutomationRef,
      timeoutMilliseconds,
      expectedAvailabilityTaskBucketMilliseconds: initialTaskBucketMilliseconds,
    });
    assertFf132SingleQueueTask(
      listFf132QueueTasks(FF132_AVAILABILITY_TASK_QUEUE),
      availabilityTaskId,
    );

    checkpoint = assertCheckpoint('availability-retry');
    await assertMaintenanceCheckpoint({
      firestore,
      lockRef,
      Timestamp,
      runId,
      timeoutMilliseconds,
      draftRef,
    });
    await restoreAvailabilityWithCas({
      firestore,
      FieldValue,
      availabilityRef,
      baseline: availabilityBaseline,
      baselineAttestation: availabilityAttestation,
      overlayLeaseMilliseconds,
    });
    availabilityOverlayOwned = false;

    const retryEventSnapshot = await waitFor(
      'The availability retry using the restored strict baseline',
      () => injuryAutomationRef.get(),
      (snapshot) => {
        const data = snapshot.data() ?? {};
        const lastRunAt = timestampMilliseconds(data.lastRunAt) ?? 0;
        return data.lastRunResult === 'daily-report-current' && lastRunAt > leaseEventMilliseconds;
      },
      timeoutMilliseconds,
    );
    const retryEventMilliseconds =
      timestampMilliseconds(retryEventSnapshot.get('lastRunAt')) ?? 0;
    await waitForQueueCount(FF132_AVAILABILITY_TASK_QUEUE, 0, timeoutMilliseconds);
    const availabilityTaskFunction = requiredFunctions.find(
      (entry) => entry.name === FF132_AVAILABILITY_TASK_QUEUE,
    );
    assert.ok(availabilityTaskFunction);
    const retryLogMaximum = retryEventMilliseconds + 10_000;
    const retryRequestLogs = await waitFor(
      'The correlated availability task retry logs',
      () =>
        readFf132RequestLogs(
          availabilityTaskFunction,
          'Google-Cloud-Tasks',
          firstAttempt.createMilliseconds - 1_000,
          retryLogMaximum,
        ),
      (entries) => entries.length >= 2,
      NATURAL_SCHEDULER_MAX_OBSERVATION_MILLISECONDS,
    );
    const retryRequestTimes = assertFf132RequestLogs(retryRequestLogs, {
      deployedFunction: availabilityTaskFunction,
      userAgent: 'Google-Cloud-Tasks',
      minimumTimestamp: firstAttempt.createMilliseconds - 1_000,
      maximumTimestamp: retryLogMaximum,
      expectedStatuses: [500, 200],
    });
    const availabilityRetryDelayMilliseconds = retryRequestTimes[1] - retryRequestTimes[0];
    assert.ok(
      availabilityRetryDelayMilliseconds >= MINIMUM_TASK_RETRY_DELAY_MILLISECONDS &&
        availabilityRetryDelayMilliseconds <= MAXIMUM_TASK_RETRY_DELAY_MILLISECONDS,
      'The correlated availability retry was outside its bounded backoff interval.',
    );
    const retryApplicationLogs = await waitFor(
      'The already-current availability completion log',
      () =>
        readFf132ApplicationLogs(
          availabilityTaskFunction,
          firstAttempt.createMilliseconds - 1_000,
          retryLogMaximum,
        ),
      (entries) =>
        entries.some((entry) =>
          String(entry?.jsonPayload?.message ?? entry?.textPayload ?? '').includes(
            'Automatic Draft availability preparation completed',
          ),
        ),
      NATURAL_SCHEDULER_MAX_OBSERVATION_MILLISECONDS,
    );
    assertFf132AlreadyCurrentCompletionLog(retryApplicationLogs, availabilityTaskFunction);
    const unchangedAvailability = (await availabilityRef.get()).data() ?? {};
    assert.equal(contentHash(unchangedAvailability), availabilityAttestation.sourceHash);
    assert.equal(contentHash(unchangedAvailability.records), availabilityAttestation.recordsHash);

    checkpoint = assertCheckpoint('near-zero');
    await assertMaintenanceCheckpoint({
      firestore,
      lockRef,
      Timestamp,
      runId,
      timeoutMilliseconds,
      draftRef,
    });
    assertDuplicateTaskBucketIsSafe(Date.now(), initialTaskBucketMilliseconds);
    const nearZeroStartAt = new Date(Date.now() - 1_000);
    plannedScheduledStartMilliseconds.add(nearZeroStartAt.getTime());
    ownedDraftClockTaskIds.add(
      buildFf132ScheduledDraftStartTaskId(nearZeroStartAt.getTime()),
    );
    const nearZeroLeaseExpiresAt = Timestamp.fromMillis(
      Date.now() + timeoutMilliseconds + LOCK_CLEANUP_RESERVE_MILLISECONDS,
    );
    overlayLeaseMilliseconds = nearZeroLeaseExpiresAt.toMillis();
    availabilityOverlayOwned = true;
    draftMutated = true;
    const nearZeroPrepared = await prepareFf132InitialEvidenceState({
      firestore,
      FieldValue,
      Timestamp,
      draftRef,
      availabilityRef,
      baseline: availabilityBaseline,
      baselineAttestation: availabilityAttestation,
      initialStartAt: nearZeroStartAt,
      leaseExpiresAt: nearZeroLeaseExpiresAt,
    });
    assert.equal(overlayLeaseMilliseconds, nearZeroPrepared.overlayLeaseMilliseconds);
    await runCorrelatedFf132DraftScheduler({
      schedulerFunction,
      draftAutomationRef,
      timeoutMilliseconds,
    });
    const nearZeroDraft = await waitForDraftState(
      draftRef,
      (draft) =>
        draft.serverDraftReadinessStatus === 'waiting-injury' &&
        timestampMilliseconds(draft.serverDraftReadinessScheduledStartAt) ===
          nearZeroStartAt.getTime(),
      timeoutMilliseconds,
      'The near-zero fail-closed state',
    );
    assertScheduledStoppedZero(nearZeroDraft, nearZeroStartAt);
    await assertNoDraftPicks(draftRef);
    assert.equal(listFf132QueueTasks(FF132_AVAILABILITY_TASK_QUEUE).length, 0);

    // Move the Draft safely away from zero while the unavailable-input lease
    // is still active. Restoring shared availability first would leave a
    // narrow scheduler race in which this past-due fixture could open.
    const reschedulePlan = buildNaturalT25Start(
      Date.now(),
      NATURAL_SCHEDULER_MINIMUM_RETRY_LEAD_MILLISECONDS,
    );
    const rescheduledStartAt = reschedulePlan.scheduledStartAt;
    plannedScheduledStartMilliseconds.add(rescheduledStartAt.getTime());
    ownedDraftClockTaskIds.add(
      buildFf132ScheduledDraftStartTaskId(rescheduledStartAt.getTime()),
    );
    assertFf132UtcWindow(Date.now(), rescheduledStartAt.getTime());
    assertStrictSchema2AvailabilityBaseline(
      availabilityBaseline,
      rescheduledStartAt.getTime(),
    );
    await rescheduleDraft(draftRef, FieldValue, Timestamp, rescheduledStartAt);
    assertScheduledStoppedZero((await draftRef.get()).data() ?? {}, rescheduledStartAt);
    await restoreAvailabilityWithCas({
      firestore,
      FieldValue,
      availabilityRef,
      baseline: availabilityBaseline,
      baselineAttestation: availabilityAttestation,
      overlayLeaseMilliseconds,
    });
    availabilityOverlayOwned = false;
    await assertMaintenanceCheckpoint({
      firestore,
      lockRef,
      Timestamp,
      runId,
      timeoutMilliseconds,
      draftRef,
    });

    const schedulerBeforeCurrentAvailability = inspectFf132SchedulerJob(schedulerFunction);
    await waitUntilBoundary(
      rescheduledStartAt,
      AVAILABILITY_BOUNDARY_MILLISECONDS,
      'The rescheduled T-25 availability boundary',
    );
    const schedulerAfterCurrentAvailability = await waitFor(
      'The natural rescheduled T-25 scheduler attempt',
      () => inspectFf132SchedulerJob(schedulerFunction),
      (state) => state.lastAttemptMilliseconds >= reschedulePlan.schedulerMilliseconds - 2_000,
      NATURAL_SCHEDULER_MAX_OBSERVATION_MILLISECONDS,
    );
    assertFf132NaturalSchedulerAttempt(
      schedulerBeforeCurrentAvailability,
      schedulerAfterCurrentAvailability,
      reschedulePlan.schedulerMilliseconds,
    );
    assert.equal(listFf132QueueTasks(FF132_AVAILABILITY_TASK_QUEUE).length, 0);
    const beforeProjectionBoundary = (await draftRef.get()).data() ?? {};
    assertScheduledStoppedZero(beforeProjectionBoundary, rescheduledStartAt);
    assert.equal(beforeProjectionBoundary.serverDraftReadinessProjectionRequestId ?? null, null);

    checkpoint = assertCheckpoint('projection-boundary');
    const schedulerBeforeProjection = inspectFf132SchedulerJob(schedulerFunction);
    await waitUntilBeforeBoundary(rescheduledStartAt, PROJECTION_BOUNDARY_MILLISECONDS);
    await assertMaintenanceCheckpoint({
      firestore,
      lockRef,
      Timestamp,
      runId,
      timeoutMilliseconds,
      draftRef,
    });
    const immediatelyBeforeProjectionBoundary = (await draftRef.get()).data() ?? {};
    assertScheduledStoppedZero(immediatelyBeforeProjectionBoundary, rescheduledStartAt);
    assert.equal(
      immediatelyBeforeProjectionBoundary.serverDraftReadinessProjectionRequestId ?? null,
      null,
      'Projection V11 was requested before the natural T-20 boundary.',
    );
    await waitUntilBoundary(
      rescheduledStartAt,
      PROJECTION_BOUNDARY_MILLISECONDS,
      'The T-20 Projection boundary',
    );

    const preparingDraft = await waitForDraftState(
      draftRef,
      (draft) =>
        typeof draft.serverDraftReadinessProjectionRequestId === 'string' ||
        draft.serverDraftReadinessStatus === 'error',
      Math.min(timeoutMilliseconds, NATURAL_SCHEDULER_MAX_OBSERVATION_MILLISECONDS),
      'The server-owned Projection V11 request',
    );
    assert.notEqual(preparingDraft.serverDraftReadinessStatus, 'error');
    assertScheduledStoppedZero(preparingDraft, rescheduledStartAt);
    assert.match(preparingDraft.serverDraftReadinessAvailabilityRevision, SHA256_PATTERN);
    assert.equal(preparingDraft.serverDraftReadinessAttemptCount, 1);
    requestId = preparingDraft.serverDraftReadinessProjectionRequestId;
    assert.equal(typeof requestId, 'string');
    assert.equal(
      requestId,
      buildFf132ProjectionRequestId(
        rescheduledStartAt.getTime(),
        preparingDraft.serverDraftReadinessAvailabilityRevision,
      ),
      'The server-owned attempt-one Projection request identity diverged.',
    );
    const projectionBoundaryMilliseconds =
      rescheduledStartAt.getTime() - PROJECTION_BOUNDARY_MILLISECONDS;
    const projectionBoundaryLatencyMilliseconds = assertNaturalBoundaryTimestamp(
      preparingDraft.serverDraftReadinessUpdatedAt,
      projectionBoundaryMilliseconds,
      'Automatic Projection preparation',
    );
    const expectedProjectionSchedulerMilliseconds = projectionBoundaryMilliseconds + 1_000;
    const schedulerAfterProjection = inspectFf132SchedulerJob(schedulerFunction);
    assertFf132NaturalSchedulerAttempt(
      schedulerBeforeProjection,
      schedulerAfterProjection,
      expectedProjectionSchedulerMilliseconds,
    );
    const schedulerProjectionLogs = await waitFor(
      'The verified natural T-20 scheduler request log',
      () =>
        readFf132RequestLogs(
          schedulerFunction,
          'Google-Cloud-Scheduler',
          expectedProjectionSchedulerMilliseconds - 2_000,
          expectedProjectionSchedulerMilliseconds +
            FF132_NATURAL_SCHEDULER_CORRELATION_MAX_MILLISECONDS,
        ),
      (entries) => entries.some((entry) => Number(entry?.httpRequest?.status) === 200),
      NATURAL_SCHEDULER_MAX_OBSERVATION_MILLISECONDS,
    );
    assertFf132RequestLogs(schedulerProjectionLogs, {
      deployedFunction: schedulerFunction,
      userAgent: 'Google-Cloud-Scheduler',
      minimumTimestamp: expectedProjectionSchedulerMilliseconds - 2_000,
      maximumTimestamp:
        expectedProjectionSchedulerMilliseconds +
          FF132_NATURAL_SCHEDULER_CORRELATION_MAX_MILLISECONDS,
      expectedStatuses: [200],
    });

    // Only after the natural request exists do explicit duplicate scheduler
    // deliveries verify idempotent convergence.
    await runCorrelatedFf132DraftScheduler({
      schedulerFunction,
      draftAutomationRef,
      timeoutMilliseconds,
    });
    await runCorrelatedFf132DraftScheduler({
      schedulerFunction,
      draftAutomationRef,
      timeoutMilliseconds,
    });
    const requestRef = firestore.doc(`projectionGenerationRequests/${requestId}`);
    const terminalRequestSnapshot = await waitFor(
      'The authoritative Projection V11 request',
      () => requestRef.get(),
      (snapshot) => ['ready', 'error'].includes(snapshot.get('status')),
      timeoutMilliseconds,
    );
    const request = terminalRequestSnapshot.data() ?? {};
    assertFf132ProjectionRequest(
      request,
      requestId,
      preparingDraft.serverDraftReadinessAvailabilityRevision,
      {
        runStartedMilliseconds: runStartedAt,
        projectionBoundaryMilliseconds,
        observedAtMilliseconds: Date.now(),
      },
    );
    const metadata = await assertProjectionSnapshot(firestore, request, availabilityAttestation);
    const requestCount = await assertOneOwnedProjectionRequest(firestore, requestId, runStartedAt);

    await runCorrelatedFf132DraftScheduler({
      schedulerFunction,
      draftAutomationRef,
      timeoutMilliseconds,
    });
    const readyDraft = await waitForDraftState(
      draftRef,
      (draft) =>
        draft.serverDraftReadinessStatus === 'ready' &&
        draft.serverDraftReadinessProjectionRequestId === requestId,
      timeoutMilliseconds,
      'The exact schedule-bound ready state',
    );
    assertScheduledStoppedZero(readyDraft, rescheduledStartAt);
    assert.equal(
      timestampMilliseconds(readyDraft.serverDraftReadinessScheduledStartAt),
      rescheduledStartAt.getTime(),
    );
    assert.equal(readyDraft.serverDraftReadinessAvailabilityRevision, request.availabilityRevision);
    assert.equal(readyDraft.serverDraftReadinessProjectionSnapshotId, request.snapshotId);
    assert.equal(readyDraft.serverDraftReadinessProjectionSnapshotHash, request.snapshotContentHash);
    assert.equal(readyDraft.serverDraftReadinessAttemptCount, 1);
    assert.ok(
      timestampMilliseconds(readyDraft.serverDraftReadinessUpdatedAt) < rescheduledStartAt.getTime(),
    );

    const stableIdentity = contentHash({
      requestId: readyDraft.serverDraftReadinessProjectionRequestId,
      snapshotId: readyDraft.serverDraftReadinessProjectionSnapshotId,
      snapshotHash: readyDraft.serverDraftReadinessProjectionSnapshotHash,
      availabilityRevision: readyDraft.serverDraftReadinessAvailabilityRevision,
      scheduledStartAt: readyDraft.serverDraftReadinessScheduledStartAt,
      attemptCount: readyDraft.serverDraftReadinessAttemptCount,
    });
    await runCorrelatedFf132DraftScheduler({
      schedulerFunction,
      draftAutomationRef,
      timeoutMilliseconds,
    });
    await runCorrelatedFf132DraftScheduler({
      schedulerFunction,
      draftAutomationRef,
      timeoutMilliseconds,
    });
    const duplicateDraft = (await draftRef.get()).data() ?? {};
    assertScheduledStoppedZero(duplicateDraft, rescheduledStartAt);
    assert.equal(
      contentHash({
        requestId: duplicateDraft.serverDraftReadinessProjectionRequestId,
        snapshotId: duplicateDraft.serverDraftReadinessProjectionSnapshotId,
        snapshotHash: duplicateDraft.serverDraftReadinessProjectionSnapshotHash,
        availabilityRevision: duplicateDraft.serverDraftReadinessAvailabilityRevision,
        scheduledStartAt: duplicateDraft.serverDraftReadinessScheduledStartAt,
        attemptCount: duplicateDraft.serverDraftReadinessAttemptCount,
      }),
      stableIdentity,
    );
    const pickCount = await assertNoDraftPicks(draftRef);
    checkpoint = assertCheckpoint('duplicate-convergence');
    await assertMaintenanceCheckpoint({
      firestore,
      lockRef,
      Timestamp,
      runId,
      timeoutMilliseconds,
      draftRef,
    });

    provisionalEvidence = {
      deployedRuntimeRevision: deployedRevision,
      toolingRevision: gitState.toolingRevision,
      releaseManifestMatched: true,
      cleanPushedToolingDelta:
        gitState.changedPathCount === ALLOWED_TOOLING_DELTA.length,
      requiredStagingFunctionsActive:
        requiredFunctions.length === FF132_REQUIRED_STAGING_FUNCTIONS.length,
      exactFunctionSourceMatched: true,
      cloudRunRevisionMatched: true,
      schedulerConfigurationMatched: true,
      taskQueueConfigurationMatched: true,
      boundedDraftInventory: draftInventoryCount <= MAX_DRAFT_INVENTORY,
      availabilityQueueInitiallyEmpty: true,
      projectionQueueInitiallyEmpty: true,
      draftClockQueueInitiallyEmpty: true,
      strictSchema2Baseline: true,
      availabilityRecordsUnchanged: true,
      naturalAvailabilityBoundary: true,
      naturalAvailabilitySchedulerObserved: true,
      availabilityBoundaryLatencyMilliseconds,
      activeLeaseFirstDelivery: true,
      exactFirstTaskFailureObserved: true,
      duplicateAvailabilityQueueConverged: true,
      retryUsedCurrentBaseline: true,
      retryEvidenceScope: 'singleton-revision-correlated',
      availabilityRetryDelayMilliseconds,
      nearZeroStayedFailClosed: true,
      rescheduleRecovered: readyDraft.serverDraftReadinessStatus === 'ready',
      naturalProjectionBoundary: true,
      naturalProjectionSchedulerObserved: true,
      projectionBoundaryLatencyMilliseconds,
      authoritativeProjectionRequestCount: requestCount,
      projectionVersion: metadata.projectionVersion,
      scoringRulesVersion: metadata.scoringRulesVersion,
      teamScheduleInputComplete: metadata.teamScheduleInputCompleteness === 'complete',
      duplicateProjectionDeliveryConverged: true,
      clockStayedStopped: duplicateDraft.clockStatus === 'stopped',
      pickCount,
      projectionAuditRetained: true,
    };
  } catch (error) {
    primaryError = error;
  } finally {
    if (app && firestore && lockOwned) {
      if (!primaryError) {
        checkpoint = assertCheckpoint('cleanup');
      }

      let ownershipReconciled = false;

      if (
        draftRef &&
        availabilityRef &&
        draftBaselineHash &&
        availabilityBaseline &&
        availabilityAttestation
      ) {
        for (let attempt = 0; attempt < 3 && !ownershipReconciled; attempt += 1) {
          try {
            const [draftSnapshot, availabilitySnapshot] = await Promise.all([
              draftRef.get(),
              availabilityRef.get(),
            ]);
            assert.ok(draftSnapshot.exists && availabilitySnapshot.exists);
            const draftData = draftSnapshot.data() ?? {};
            const ownership = reconcileFf132FixtureOwnership({
              draft: draftData,
              draftBaselineHash,
              plannedScheduledStartMilliseconds,
              availability: availabilitySnapshot.data() ?? {},
              availabilityBaseline,
              availabilityAttestation,
              overlayLeaseMilliseconds,
            });
            draftMutated = ownership.draftMutated;
            availabilityOverlayOwned = ownership.availabilityOverlayOwned;
            const observedRequestId =
              draftData.serverDraftReadinessProjectionRequestId ?? null;

            if (!requestId && observedRequestId !== null) {
              assert.match(observedRequestId, PROJECTION_REQUEST_ID_PATTERN);
              requestId = observedRequestId;
            }
            ownershipReconciled = true;
          } catch {
            if (attempt < 2) {
              await wait(POLL_INTERVAL_MILLISECONDS);
            }
          }
        }
      }

      if (!ownershipReconciled) {
        primaryError ??= new Error('The runner could not reconcile its exact staging ownership.');
        try {
          await markEvidenceLockCleanupRequired(firestore, lockRef, Timestamp, runId);
        } catch {
          // The public boundary retains cleanup-required without exposing identifiers.
        }
        cleanupOutcome = {
          cleanupComplete: false,
          lockReleased: false,
          failedStageCount: 1,
        };
      }

      if (ownershipReconciled) {
        cleanupOutcome = await runFf132CleanupStages({
          resetDraft: draftMutated
            ? async () => {
                safeResetAt = await resetDraftFirst(draftRef, FieldValue, Timestamp);
              }
            : undefined,
          drainDraftClockQueue: draftMutated
            ? async () => {
                await drainFf132OwnedClockQueueTasks(
                  ownedDraftClockTaskIds,
                  timeoutMilliseconds,
                );
                await runCorrelatedFf132DraftScheduler({
                  schedulerFunction,
                  draftAutomationRef,
                  timeoutMilliseconds,
                });
                const remaining = listFf132QueueTasks(FF132_DRAFT_CLOCK_TASK_QUEUE);
                assertFf132OwnedClockQueueTasks(remaining, ownedDraftClockTaskIds);
                assert.equal(remaining.length, 0);
              }
            : undefined,
          awaitProjectionTerminal: requestId
            ? async () => {
                const requestRef = firestore.doc(`projectionGenerationRequests/${requestId}`);
                await waitFor(
                  'The owned Projection request before cleanup',
                  () => requestRef.get(),
                  (snapshot) => ['ready', 'error'].includes(snapshot.get('status')),
                  timeoutMilliseconds,
                );
              }
            : undefined,
          drainProjectionQueue: async () => {
            await waitForQueueCount(FF132_PROJECTION_TASK_QUEUE, 0, timeoutMilliseconds);
          },
          restoreAvailability:
            availabilityOverlayOwned &&
            availabilityRef &&
            availabilityBaseline &&
            availabilityAttestation &&
            overlayLeaseMilliseconds !== null
              ? async () => {
                  await restoreAvailabilityWithCas({
                    firestore,
                    FieldValue,
                    availabilityRef,
                    baseline: availabilityBaseline,
                    baselineAttestation: availabilityAttestation,
                    overlayLeaseMilliseconds,
                  });
                  availabilityOverlayOwned = false;
                }
              : undefined,
          drainAvailabilityQueue: async () => {
            await waitForQueueCount(FF132_AVAILABILITY_TASK_QUEUE, 0, timeoutMilliseconds);
          },
          verifyDraftInventory: async () => {
            await assertBoundedDraftInventory(firestore);
            const { draftRef: verifiedDraftRef } = await assertSyntheticFixtureSafety(firestore);

            if (draftMutated) {
              const resetDraft = (await verifiedDraftRef.get()).data() ?? {};
              assert.ok(safeResetAt instanceof Date);
              assert.equal(
                timestampMilliseconds(resetDraft.scheduledStartAt),
                safeResetAt.getTime(),
                'The synthetic Draft did not retain the safe cleanup schedule.',
              );
            }

            if (availabilityBaseline && availabilityAttestation && !availabilityOverlayOwned) {
              const restoredAvailability = (await availabilityRef.get()).data() ?? {};
              assert.equal(
                contentHash(restoredAvailability),
                availabilityAttestation.sourceHash,
              );
            }
          },
          markCleanupRequired: async () => {
            await markEvidenceLockCleanupRequired(firestore, lockRef, Timestamp, runId);
          },
          releaseLock: async () => {
            await releaseEvidenceLock(firestore, lockRef, runId);
            lockOwned = false;
          },
        });
      }
    }

    if (app && deleteApp) {
      try {
        await deleteApp(app);
      } catch {
        primaryError ??= new Error('The local Admin SDK did not close cleanly.');
      }
    }
  }

  if (primaryError || !cleanupOutcome.cleanupComplete || !provisionalEvidence) {
    throw new Ff132PublicEvidenceError(
      checkpoint,
      lockOwnershipUncertain
        ? 'cleanup-required'
        : !lockWasAcquired
          ? 'not-required'
          : cleanupOutcome.cleanupComplete
            ? 'complete'
            : 'cleanup-required',
    );
  }

  return buildPublicFf132Evidence({
    ...provisionalEvidence,
    cleanupComplete: cleanupOutcome.cleanupComplete,
    lockReleased: cleanupOutcome.lockReleased,
    draftClockQueueCleaned: cleanupOutcome.cleanupComplete,
  });
}

export async function runFf132EvidenceCli({
  environment = process.env,
  runner = runFf132ServerOwnedDraftPreparationStagingEvidence,
  stdout = (line) => console.log(line),
  stderr = (line) => console.error(line),
} = {}) {
  try {
    const evidence = await runner(environment);
    stdout('FF1.32 server-owned Draft preparation staging evidence passed.');
    stdout(JSON.stringify(evidence, null, 2));
    stdout(
      'The Draft was reset first, the availability overlay was restored by compare-and-set, and all server-generated Projection audit state was retained.',
    );
    return 0;
  } catch (error) {
    const safeError = error instanceof Ff132PublicEvidenceError
      ? error
      : new Ff132PublicEvidenceError('preflight', 'not-required');
    stderr(JSON.stringify(safeError.toJSON()));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFf132EvidenceCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
