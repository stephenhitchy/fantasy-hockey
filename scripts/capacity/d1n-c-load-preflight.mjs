#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  expectedPackageManagerVersion,
  inspectToolchain as evaluateToolchain,
  normalizeVersion,
} from '../release/toolchain-preflight.util.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const D1NC_STAGING_PROJECT_ID = 'rinkrat-staging-d1nc-2026';
export const D1NC_PRODUCTION_PROJECT_ID = 'nhl-fantasy-app-ab673';
export const D1NC_STAGING_URL = 'https://rinkrat-staging-d1nc-2026.web.app';
export const D1NC_STAGING_DATABASE_LOCATION = 'us-west4';
export const D1NC_RAMP_STAGES = Object.freeze([100, 500, 2_000, 5_000]);
export const D1NC_REQUIRED_FUNCTIONS = Object.freeze([
  'processDraftClockDeadline',
  'processLeagueAutomationTask',
]);
export const D1NC_REQUIRED_APIS = Object.freeze([
  'artifactregistry.googleapis.com',
  'cloudbuild.googleapis.com',
  'cloudfunctions.googleapis.com',
  'cloudtasks.googleapis.com',
  'firestore.googleapis.com',
  'logging.googleapis.com',
  'monitoring.googleapis.com',
  'run.googleapis.com',
]);
export const D1NC_REQUIRED_ROUTES = Object.freeze([
  'availablePlayers',
  'matchup',
  'draft',
  'leagueHome',
  'projection',
]);
export const D1NC_MIN_ROUTE_SAMPLES = 20;

export const D1NC_THRESHOLDS = Object.freeze({
  scoringTaskP95Milliseconds: 20_000,
  scoringTaskP99Milliseconds: 60_000,
  draftDeadlineDriftP95Milliseconds: 2_000,
  draftDeadlineDriftP99Milliseconds: 5_000,
  queueAgeP95Milliseconds: 60_000,
  queueAgeP99Milliseconds: 120_000,
  queueDrainMilliseconds: 120_000,
  retryRate: 0.01,
  recoveredContentionRate: 0.01,
  scoringMaximumConcurrency: 4,
  draftMaximumConcurrency: 10,
  incrementalCostUsdByStage: Object.freeze({
    100: 2,
    500: 5,
    2_000: 15,
    5_000: 25,
  }),
});

function requireCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegativeNumber(value) {
  const result = finiteNumber(value);
  return result !== null && result >= 0 ? result : null;
}

async function readText(relativePath) {
  return readFile(path.join(projectRoot, relativePath), 'utf8');
}

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

async function run(command, args) {
  return execFileAsync(command, args, {
    cwd: projectRoot,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function parseArguments(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    requireCondition(argument.startsWith('--'), `Unexpected argument: ${argument}`);
    const raw = argument.slice(2);
    const separator = raw.indexOf('=');
    if (separator >= 0) {
      options.set(raw.slice(0, separator), raw.slice(separator + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      options.set(raw, next);
      index += 1;
    } else {
      options.set(raw, true);
    }
  }
  return options;
}

function optionString(options, key, fallback = '') {
  const value = options.get(key);
  return value === undefined || value === true ? fallback : String(value).trim();
}

function npmVersionFromUserAgent() {
  const match = String(process.env.npm_config_user_agent ?? '').match(/(?:^|\s)npm\/([^\s]+)/);
  return match?.[1] ?? '';
}

async function actualNpmVersion() {
  const userAgent = npmVersionFromUserAgent();
  if (userAgent) return normalizeVersion(userAgent);
  const result = await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version']);
  return normalizeVersion(result.stdout);
}

export function previousRampStage(stage) {
  const index = D1NC_RAMP_STAGES.indexOf(stage);
  return index > 0 ? D1NC_RAMP_STAGES[index - 1] : null;
}

export function buildD1ncAcknowledgement(stage) {
  return `inspect-d1n-c-stage-${stage}-in-${D1NC_STAGING_PROJECT_ID}`;
}

export function validateRampRequest({ projectId, stage, acknowledgement }) {
  const issues = [];
  if (projectId !== D1NC_STAGING_PROJECT_ID) {
    issues.push(`project must equal ${D1NC_STAGING_PROJECT_ID}`);
  }
  if (projectId === D1NC_PRODUCTION_PROJECT_ID) {
    issues.push('Production is never a D1N-C load target');
  }
  if (!D1NC_RAMP_STAGES.includes(stage)) {
    issues.push('stage must be exactly 100, 500, 2000, or 5000');
  } else if (acknowledgement !== buildD1ncAcknowledgement(stage)) {
    issues.push('acknowledgement does not match the exact project and stage');
  }
  return { issues, ready: issues.length === 0 };
}

export function validateStagingManifest(manifest, expectedRevision) {
  const issues = [];
  if (manifest?.schemaVersion !== 1) issues.push('unsupported manifest schema');
  if (manifest?.releaseLabel !== 'Release Candidate 65') issues.push('release label mismatch');
  if (manifest?.scoringRulesVersion !== 4) issues.push('Scoring V4 mismatch');
  if (manifest?.projectionVersion !== 11) issues.push('Projection V11 mismatch');
  if (!/^[0-9a-f]{40}$/i.test(String(manifest?.sourceRevision ?? ''))) {
    issues.push('manifest does not contain a full clean revision');
  } else if (expectedRevision && manifest.sourceRevision !== expectedRevision) {
    issues.push('staging manifest does not match reviewed main');
  }
  return { issues, ready: issues.length === 0 };
}

function deployedFunctionName(entry) {
  return String(entry?.name ?? entry?.id ?? '').split('/').at(-1);
}

export function validateStagingFunctions(entries) {
  const byName = new Map(entries.map((entry) => [deployedFunctionName(entry), entry]));
  const missing = D1NC_REQUIRED_FUNCTIONS.filter((name) => !byName.has(name));
  const inactive = D1NC_REQUIRED_FUNCTIONS.filter((name) => {
    const entry = byName.get(name);
    return entry && String(entry.state ?? entry.status ?? '').toUpperCase() !== 'ACTIVE';
  });
  const wrongRuntime = D1NC_REQUIRED_FUNCTIONS.filter((name) => {
    const entry = byName.get(name);
    const runtime = entry?.buildConfig?.runtime ?? entry?.runtime;
    return entry && runtime !== 'nodejs22';
  });
  return {
    missing,
    inactive,
    wrongRuntime,
    ready: missing.length === 0 && inactive.length === 0 && wrongRuntime.length === 0,
  };
}

function validateRouteEvidence(route, label) {
  const issues = [];
  const sampleCount = nonNegativeNumber(route?.sampleCount);
  const coldSampleCount = nonNegativeNumber(route?.coldSampleCount);
  const warmSampleCount = nonNegativeNumber(route?.warmSampleCount);
  const reconnectSampleCount = nonNegativeNumber(route?.reconnectSampleCount);
  if (sampleCount === null || sampleCount < D1NC_MIN_ROUTE_SAMPLES) {
    issues.push(`${label} requires at least ${D1NC_MIN_ROUTE_SAMPLES} samples`);
  }
  if (coldSampleCount === null || coldSampleCount < 1) {
    issues.push(`${label} requires a cold sample`);
  }
  if (warmSampleCount === null || warmSampleCount < 1) {
    issues.push(`${label} requires a warm sample`);
  }
  if (reconnectSampleCount === null || reconnectSampleCount < 1) {
    issues.push(`${label} requires a reconnect sample`);
  }
  if (
    sampleCount !== null
    && coldSampleCount !== null
    && warmSampleCount !== null
    && reconnectSampleCount !== null
    && coldSampleCount + warmSampleCount + reconnectSampleCount !== sampleCount
  ) {
    issues.push(`${label} sample profile counts do not equal the total`);
  }
  if (route?.listenerErrorCount !== 0) issues.push(`${label} has listener errors`);
  if (route?.unknownDocumentCount !== 0) issues.push(`${label} has unknown document counts`);
  if (route?.awaitingFirstSnapshotCount !== 0) issues.push(`${label} has awaiting snapshots`);
  if (route?.cleanupFinalListenerCount !== 0) issues.push(`${label} did not clean up to zero listeners`);
  if (route?.pendingWriteSnapshotCount !== 0) issues.push(`${label} has pending-write snapshots`);
  if (route?.horizontalOverflow !== false) issues.push(`${label} has horizontal overflow or missing evidence`);
  return issues;
}

export function validatePhysicalDeviceEvidence(evidence, expectedRevision) {
  const issues = [];
  if (evidence?.schemaVersion !== 1) issues.push('device evidence schema must equal 1');
  if (evidence?.projectId !== D1NC_STAGING_PROJECT_ID) issues.push('device evidence project mismatch');
  if (evidence?.sourceRevision !== expectedRevision) issues.push('device evidence revision mismatch');

  for (const [key, label] of [
    ['iphoneSafari', 'physical iPhone Safari'],
    ['androidChrome', 'physical Android Chrome'],
  ]) {
    const profile = evidence?.profiles?.[key];
    if (profile?.physical !== true) issues.push(`${label} is not marked physical`);
    if (nonNegativeNumber(profile?.reconnectSnapshotCount) === null || profile.reconnectSnapshotCount < 1) {
      issues.push(`${label} requires a reconnect snapshot`);
    }
    if (profile?.draftFocusPass !== true) issues.push(`${label} Draft focus did not pass`);
    if (profile?.zoom200Pass !== true) issues.push(`${label} 200% zoom did not pass`);
    for (const routeName of D1NC_REQUIRED_ROUTES) {
      issues.push(...validateRouteEvidence(profile?.routes?.[routeName], `${label} ${routeName}`));
    }
  }

  const multiTab = evidence?.profiles?.multiTab;
  if (nonNegativeNumber(multiTab?.tabCount) === null || multiTab.tabCount < 4) {
    issues.push('multi-tab evidence requires at least four tabs');
  }
  if (multiTab?.listenerErrorCount !== 0) issues.push('multi-tab evidence has listener errors');
  if (multiTab?.awaitingFirstSnapshotCount !== 0) issues.push('multi-tab evidence has awaiting snapshots');
  if (multiTab?.cleanupFinalListenerCount !== 0) issues.push('multi-tab evidence did not clean up to zero listeners');
  if (multiTab?.pendingWriteSnapshotCount !== 0) issues.push('multi-tab evidence has pending writes');

  return { issues, ready: issues.length === 0 };
}

function validUtcTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

export function validateBillingExportEvidence(evidence, expectedRevision) {
  const issues = [];
  if (evidence?.schemaVersion !== 1) issues.push('billing evidence schema must equal 1');
  if (evidence?.projectId !== D1NC_STAGING_PROJECT_ID) issues.push('billing evidence project mismatch');
  if (evidence?.sourceRevision !== expectedRevision) issues.push('billing evidence revision mismatch');
  if (evidence?.measurementSource !== 'cloud-billing-export') {
    issues.push('billing measurement source must be the Cloud Billing export');
  }
  if (evidence?.exportEnabled !== true) issues.push('Cloud Billing export is not enabled');
  if (evidence?.firstExportObserved !== true) issues.push('no settled staging export row was observed');
  if (evidence?.stagingProjectFilterVerified !== true) issues.push('staging-only project filtering was not verified');
  if (evidence?.budgetAlertActive !== true) issues.push('the staging budget alert is not active');
  if (evidence?.currency !== 'USD') issues.push('billing evidence currency must be USD');
  if (!validUtcTimestamp(evidence?.observedAt)) issues.push('billing evidence requires a UTC observation timestamp');
  return { issues, ready: issues.length === 0 };
}

function requiredMetric(record, key, label, issues) {
  const value = nonNegativeNumber(record?.[key]);
  if (value === null) issues.push(`${label} is missing`);
  return value;
}

function requiredPercentiles(record, label, issues) {
  const metrics = Object.fromEntries(
    ['p50', 'p95', 'p99', 'max'].map((key) => [key, requiredMetric(record, key, `${label} ${key}`, issues)]),
  );
  if (
    Object.values(metrics).every((value) => value !== null)
    && !(metrics.p50 <= metrics.p95 && metrics.p95 <= metrics.p99 && metrics.p99 <= metrics.max)
  ) {
    issues.push(`${label} percentiles are not monotonic`);
  }
  return metrics;
}

export function evaluateRampEvidence(evidence) {
  const issues = [];
  const stage = finiteNumber(evidence?.stage);
  if (evidence?.schemaVersion !== 1) issues.push('ramp evidence schema must equal 1');
  if (evidence?.projectId !== D1NC_STAGING_PROJECT_ID) issues.push('ramp project mismatch');
  if (!D1NC_RAMP_STAGES.includes(stage)) issues.push('ramp stage is unsupported');
  if (!/^[0-9a-f]{40}$/i.test(String(evidence?.sourceRevision ?? ''))) {
    issues.push('ramp evidence requires one full source revision');
  }

  const operations = evidence?.operations;
  const requested = requiredMetric(operations, 'requested', 'requested operation count', issues);
  const completed = requiredMetric(operations, 'completed', 'completed operation count', issues);
  const terminalErrors = requiredMetric(operations, 'terminalErrors', 'terminal error count', issues);
  const duplicates = requiredMetric(operations, 'duplicateCompetitiveResults', 'duplicate result count', issues);
  const retries = requiredMetric(operations, 'retries', 'retry count', issues);
  const recoveredContention = requiredMetric(operations, 'recoveredContention', 'recovered contention count', issues);
  if (stage !== null && requested !== stage) issues.push('requested operations do not equal the ramp stage');
  if (stage !== null && completed !== stage) issues.push('completed operations do not equal the ramp stage');
  if (terminalErrors !== 0) issues.push('terminal errors must remain zero');
  if (duplicates !== 0) issues.push('duplicate competitive results must remain zero');
  if (stage && retries !== null && retries / stage > D1NC_THRESHOLDS.retryRate) {
    issues.push('retry rate exceeds 1%');
  }
  if (stage && recoveredContention !== null && recoveredContention / stage > D1NC_THRESHOLDS.recoveredContentionRate) {
    issues.push('recovered contention rate exceeds 1%');
  }

  const scoringRequested = requiredMetric(operations?.scoring, 'requested', 'scoring requested count', issues);
  const scoringCompleted = requiredMetric(operations?.scoring, 'completed', 'scoring completed count', issues);
  const draftRequested = requiredMetric(operations?.draft, 'requested', 'Draft requested count', issues);
  const draftCompleted = requiredMetric(operations?.draft, 'completed', 'Draft completed count', issues);
  if (stage && scoringRequested !== stage / 2) issues.push('scoring workload must be half of the stage');
  if (stage && draftRequested !== stage / 2) issues.push('Draft workload must be half of the stage');
  if (scoringRequested !== scoringCompleted) issues.push('scoring workload did not fully complete');
  if (draftRequested !== draftCompleted) issues.push('Draft workload did not fully complete');

  const scoringLatency = requiredPercentiles(evidence?.latency?.scoringTaskMilliseconds, 'scoring latency', issues);
  const draftLatency = requiredPercentiles(evidence?.latency?.draftDeadlineDriftMilliseconds, 'Draft deadline drift', issues);
  const scoringP95 = scoringLatency.p95;
  const scoringP99 = scoringLatency.p99;
  const draftP95 = draftLatency.p95;
  const draftP99 = draftLatency.p99;
  if (scoringP95 !== null && scoringP95 > D1NC_THRESHOLDS.scoringTaskP95Milliseconds) {
    issues.push('scoring p95 exceeds 20 seconds');
  }
  if (scoringP99 !== null && scoringP99 > D1NC_THRESHOLDS.scoringTaskP99Milliseconds) {
    issues.push('scoring p99 exceeds 60 seconds');
  }
  if (draftP95 !== null && draftP95 > D1NC_THRESHOLDS.draftDeadlineDriftP95Milliseconds) {
    issues.push('Draft deadline drift p95 exceeds 2 seconds');
  }
  if (draftP99 !== null && draftP99 > D1NC_THRESHOLDS.draftDeadlineDriftP99Milliseconds) {
    issues.push('Draft deadline drift p99 exceeds 5 seconds');
  }

  const peakDepth = requiredMetric(evidence?.queue, 'peakDepth', 'peak queue depth', issues);
  const finalDepth = requiredMetric(evidence?.queue, 'finalDepth', 'final queue depth', issues);
  const queueAge = requiredPercentiles(evidence?.queue?.oldestAgeMilliseconds, 'queue age', issues);
  const queueAgeP95 = queueAge.p95;
  const queueAgeP99 = queueAge.p99;
  const drainMilliseconds = requiredMetric(evidence?.queue, 'drainMilliseconds', 'queue drain time', issues);
  if (peakDepth === 0) issues.push('peak queue depth must prove that work was enqueued');
  if (finalDepth !== 0) issues.push('queue backlog did not return to zero');
  if (queueAgeP95 !== null && queueAgeP95 > D1NC_THRESHOLDS.queueAgeP95Milliseconds) {
    issues.push('queue age p95 exceeds 60 seconds');
  }
  if (queueAgeP99 !== null && queueAgeP99 > D1NC_THRESHOLDS.queueAgeP99Milliseconds) {
    issues.push('queue age p99 exceeds 120 seconds');
  }
  if (drainMilliseconds !== null && drainMilliseconds > D1NC_THRESHOLDS.queueDrainMilliseconds) {
    issues.push('queue drain exceeded two minutes');
  }

  const scoringConcurrency = requiredMetric(evidence?.functions, 'maximumScoringConcurrency', 'maximum scoring concurrency', issues);
  const draftConcurrency = requiredMetric(evidence?.functions, 'maximumDraftConcurrency', 'maximum Draft concurrency', issues);
  requiredMetric(evidence?.functions, 'coldStarts', 'Function cold starts', issues);
  if (scoringConcurrency === 0) issues.push('scoring concurrency must prove worker execution');
  if (draftConcurrency === 0) issues.push('Draft concurrency must prove worker execution');
  if (scoringConcurrency !== null && scoringConcurrency > D1NC_THRESHOLDS.scoringMaximumConcurrency) {
    issues.push('scoring concurrency exceeded the protected limit of four');
  }
  if (draftConcurrency !== null && draftConcurrency > D1NC_THRESHOLDS.draftMaximumConcurrency) {
    issues.push('Draft concurrency exceeded the protected limit of ten');
  }

  const firestoreReads = requiredMetric(evidence?.firestore, 'reads', 'Firestore reads', issues);
  const firestoreWrites = requiredMetric(evidence?.firestore, 'writes', 'Firestore writes', issues);
  if (firestoreReads === 0) issues.push('Firestore reads must prove workload activity');
  if (firestoreWrites === 0) issues.push('Firestore writes must prove workload activity');
  const aborted = requiredMetric(evidence?.firestore, 'terminalAbortedOperations', 'terminal Firestore aborts', issues);
  if (aborted !== 0) issues.push('terminal Firestore aborts must remain zero');

  const cost = requiredMetric(evidence?.cost, 'incrementalUsd', 'incremental USD cost', issues);
  const costLimit = stage === null ? null : D1NC_THRESHOLDS.incrementalCostUsdByStage[stage];
  if (cost !== null && costLimit !== null && cost > costLimit) {
    issues.push(`incremental cost exceeds the stage ceiling of $${costLimit}`);
  }
  if (evidence?.cost?.measurementSource !== 'cloud-billing-export') {
    issues.push('cost must come from the Cloud Billing export, not an estimate');
  }
  if (evidence?.cost?.currency !== 'USD') issues.push('cost currency must be USD');
  if (evidence?.cost?.settled !== true) issues.push('cost evidence has not settled');
  for (const key of ['windowStart', 'windowEnd', 'settledAt']) {
    if (!validUtcTimestamp(evidence?.cost?.[key])) issues.push(`cost ${key} requires a UTC timestamp`);
  }
  if (
    validUtcTimestamp(evidence?.cost?.windowStart)
    && validUtcTimestamp(evidence?.cost?.windowEnd)
    && Date.parse(evidence.cost.windowStart) >= Date.parse(evidence.cost.windowEnd)
  ) {
    issues.push('cost window must end after it starts');
  }
  if (
    validUtcTimestamp(evidence?.cost?.windowEnd)
    && validUtcTimestamp(evidence?.cost?.settledAt)
    && Date.parse(evidence.cost.windowEnd) > Date.parse(evidence.cost.settledAt)
  ) {
    issues.push('cost cannot settle before the measurement window ends');
  }

  for (const invariant of [
    'scoringExactlyOnce',
    'draftExactlyOnce',
    'sixGameOwnershipStable',
    'gameSevenRolloverStable',
    'transactionsStable',
    'standingsStable',
    'playoffsStable',
  ]) {
    if (evidence?.invariants?.[invariant] !== true) issues.push(`${invariant} was not proven`);
  }

  return { issues, ready: issues.length === 0, stage };
}

async function inspectStaticSource() {
  const [packageJson, nvmrc, policy, scoringSource, draftSource, runbook] = await Promise.all([
    readJson('package.json'),
    readText('.nvmrc'),
    readJson('config/release-freeze/beta-freeze-policy.json'),
    readText('functions/src/league-automation.ts'),
    readText('functions/src/draft-automation.ts'),
    readText('docs/RINKRAT_SCALE_D1N_C_LOAD_PREFLIGHT.md'),
  ]);
  const expectedNode = normalizeVersion(nvmrc);
  const expectedNpm = expectedPackageManagerVersion(packageJson.packageManager);
  requireCondition(expectedNode === '22.23.1', 'D1N-C requires Node 22.23.1.');
  requireCondition(expectedNpm === '11.17.0', 'D1N-C requires npm 11.17.0.');
  requireCondition(policy.scoringRulesVersion === 4, 'Production Scoring V4 changed.');
  requireCondition(policy.projectionVersion === 11, 'Projection V11 changed.');
  requireCondition(policy.requiredGamesPerRosterSlot === 6, 'The six-game contract changed.');
  requireCondition(policy.queueMode === 'shadow', 'The Production queue mode changed.');
  requireCondition(policy.appCheckMode === 'monitor', 'The Production App Check mode changed.');
  requireCondition(/MAX_CONCURRENT_DISPATCHES = 4;/.test(scoringSource), 'Scoring concurrency changed from four.');
  requireCondition(/MAX_PENDING_TASKS = 24;/.test(scoringSource), 'Scoring pending-task limit changed from 24.');
  requireCondition(/DRAFT_AUTOMATION_SCAN_LIMIT = 250;/.test(draftSource), 'Draft recovery scan changed from 250.');
  requireCondition(/processDraftClockDeadline[\s\S]*maxConcurrentDispatches: 10,/.test(draftSource), 'Draft concurrency changed from ten.');
  requireCondition(runbook.includes('No Production Firebase project may be a load target.'), 'The Production refusal boundary is missing.');
  requireCondition(packageJson.scripts?.['verify:batchd1nc'], 'The D1N-C verification gate is missing.');
  return { packageJson, policy, expectedNode, expectedNpm };
}

async function inspectToolchain(source) {
  const result = evaluateToolchain({
    expectedNode: source.expectedNode,
    expectedNpm: source.expectedNpm,
    actualNode: process.version,
    actualNpm: await actualNpmVersion(),
  });
  requireCondition(result.ok, `The pinned toolchain is not active:\n- ${result.issues.join('\n- ')}`);
  return result.actual;
}

async function inspectGit() {
  const [{ stdout: commit }, { stdout: branch }, { stdout: status }, { stdout: divergence }] = await Promise.all([
    run('git', ['rev-parse', 'HEAD']),
    run('git', ['branch', '--show-current']),
    run('git', ['status', '--porcelain', '--untracked-files=normal']),
    run('git', ['rev-list', '--left-right', '--count', 'origin/main...HEAD']),
  ]);
  requireCondition(status.trim() === '', `The repository is not clean:\n${status.trim()}`);
  requireCondition(branch.trim() === 'main', `Run the full D1N-C preflight only from main; current branch is ${branch.trim() || 'detached'}.`);
  requireCondition(divergence.trim().replace(/\s+/g, '/') === '0/0', `main is not synchronized with origin/main (${divergence.trim()}).`);
  return { commit: commit.trim() };
}

async function fetchManifest(url, expectedRevision) {
  const response = await fetch(`${url.replace(/\/$/, '')}/release-manifest.json?d1nc=${Date.now()}`, {
    cache: 'no-store',
    redirect: 'follow',
  });
  requireCondition(response.ok, `Unable to read the staging manifest (${response.status}).`);
  const manifest = await response.json();
  const validation = validateStagingManifest(manifest, expectedRevision);
  requireCondition(validation.ready, `Staging manifest failed:\n- ${validation.issues.join('\n- ')}`);
  return manifest;
}

async function inspectStagingProject() {
  const [stagingProject, productionProject, billing, database, services, functions] = await Promise.all([
    run('gcloud', ['projects', 'describe', D1NC_STAGING_PROJECT_ID, '--format=json']),
    run('gcloud', ['projects', 'describe', D1NC_PRODUCTION_PROJECT_ID, '--format=json']),
    run('gcloud', ['billing', 'projects', 'describe', D1NC_STAGING_PROJECT_ID, '--format=json']),
    run('gcloud', ['firestore', 'databases', 'describe', `--project=${D1NC_STAGING_PROJECT_ID}`, '--database=(default)', '--format=json']),
    run('gcloud', ['services', 'list', '--enabled', `--project=${D1NC_STAGING_PROJECT_ID}`, '--format=json']),
    run('gcloud', ['functions', 'list', '--v2', '--regions=us-central1', `--project=${D1NC_STAGING_PROJECT_ID}`, '--format=json']),
  ]);
  const staging = JSON.parse(stagingProject.stdout || '{}');
  const production = JSON.parse(productionProject.stdout || '{}');
  requireCondition(staging.projectId === D1NC_STAGING_PROJECT_ID, 'gcloud returned the wrong staging project.');
  requireCondition(production.projectId === D1NC_PRODUCTION_PROJECT_ID, 'The Production comparison project is unavailable.');
  requireCondition(staging.projectNumber && staging.projectNumber !== production.projectNumber, 'Staging and Production project numbers must differ.');

  const billingInfo = JSON.parse(billing.stdout || '{}');
  requireCondition(billingInfo.billingEnabled === true, 'The D1N-C staging project is not billed.');
  const databaseInfo = JSON.parse(database.stdout || '{}');
  requireCondition(databaseInfo.locationId === D1NC_STAGING_DATABASE_LOCATION, `Staging Firestore must remain in ${D1NC_STAGING_DATABASE_LOCATION}.`);
  requireCondition(databaseInfo.type === 'FIRESTORE_NATIVE', 'Staging Firestore is not Native mode.');

  const enabledApis = new Set(JSON.parse(services.stdout || '[]').map((entry) => entry?.config?.name).filter(Boolean));
  const missingApis = D1NC_REQUIRED_APIS.filter((name) => !enabledApis.has(name));
  requireCondition(missingApis.length === 0, `Staging APIs are missing:\n- ${missingApis.join('\n- ')}`);

  const functionEntries = JSON.parse(functions.stdout || '[]');
  const functionValidation = validateStagingFunctions(functionEntries);
  requireCondition(functionValidation.ready, [
    'Required staging workers are not ready.',
    functionValidation.missing.length ? `Missing: ${functionValidation.missing.join(', ')}` : '',
    functionValidation.inactive.length ? `Not ACTIVE: ${functionValidation.inactive.join(', ')}` : '',
    functionValidation.wrongRuntime.length ? `Wrong runtime: ${functionValidation.wrongRuntime.join(', ')}` : '',
  ].filter(Boolean).join('\n'));
  return { functionValidation };
}

async function readEvidenceFile(filePath) {
  requireCondition(filePath, 'An evidence file path is required.');
  return JSON.parse(await readFile(path.resolve(projectRoot, filePath), 'utf8'));
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const source = await inspectStaticSource();
  console.log('D1N-C staging-load static source: PASS');
  console.log('Protected contracts: Scoring V4, Projection V11, six games, Game 7');
  console.log('Production modes: queue Shadow, App Check Monitor');

  if (options.has('source-only')) {
    console.log('Source-only mode performed no network, Firebase, Git mutation, or staging data operation.');
    return;
  }

  const stage = Number(optionString(options, 'stage'));
  const projectId = optionString(options, 'project');
  const acknowledgement = optionString(options, 'ack');
  const request = validateRampRequest({ projectId, stage, acknowledgement });
  requireCondition(request.ready, `D1N-C request refused:\n- ${request.issues.join('\n- ')}`);

  const [toolchain, git] = await Promise.all([inspectToolchain(source), inspectGit()]);
  const manifest = await fetchManifest(D1NC_STAGING_URL, git.commit);
  const deviceEvidence = await readEvidenceFile(optionString(options, 'device-evidence'));
  const deviceValidation = validatePhysicalDeviceEvidence(deviceEvidence, git.commit);
  requireCondition(deviceValidation.ready, `Physical-device evidence failed:\n- ${deviceValidation.issues.join('\n- ')}`);
  const billingEvidence = await readEvidenceFile(optionString(options, 'billing-export-evidence'));
  const billingValidation = validateBillingExportEvidence(billingEvidence, git.commit);
  requireCondition(billingValidation.ready, `Cloud Billing export evidence failed:\n- ${billingValidation.issues.join('\n- ')}`);

  const previousStage = previousRampStage(stage);
  if (previousStage !== null) {
    const previousEvidence = await readEvidenceFile(optionString(options, 'previous-evidence'));
    const previousValidation = evaluateRampEvidence(previousEvidence);
    requireCondition(previousValidation.ready && previousValidation.stage === previousStage, `Stage ${stage} requires a passing stage ${previousStage} evidence file.\n- ${previousValidation.issues.join('\n- ')}`);
    requireCondition(previousEvidence.sourceRevision === git.commit, 'Previous ramp evidence belongs to a different source revision.');
  }

  await inspectStagingProject();
  console.log('\nD1N-C staging-load preflight: PASS');
  console.log(`Toolchain: Node ${toolchain.node}, npm ${toolchain.npm}`);
  console.log(`Reviewed main and staging manifest: ${git.commit}`);
  console.log(`Staging project: ${D1NC_STAGING_PROJECT_ID}`);
  console.log(`Ramp stage authorized for harness execution: ${stage}`);
  console.log(`Required workers ACTIVE on Node 22: ${D1NC_REQUIRED_FUNCTIONS.length}/${D1NC_REQUIRED_FUNCTIONS.length}`);
  console.log('This preflight generated no traffic and modified no Firebase resource or document.');
  console.log('Production was not read except for project-number separation and was never a load target.');
  console.log(`Staging build: ${manifest.buildId}`);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
