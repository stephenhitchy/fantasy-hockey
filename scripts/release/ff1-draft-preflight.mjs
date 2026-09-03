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
} from './toolchain-preflight.util.mjs';
import {
  buildFirebaseFunctionsDeploymentAudit,
  collectExpectedFirebaseFunctionNames,
} from './firebase-functions-deployment-audit.util.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const criticalDraftFunctions = Object.freeze([
  'continueServerDraftAutomation',
  'executeDraftCommand',
  'initializeSeasonAfterDraft',
  'makeSecureDraftPick',
  'manageProjectionSnapshotIntegrity',
  'processAutoDraftQueueChange',
  'processDraftClockDeadline',
  'processProjectionGenerationTask',
  'publishLeagueDraftControlActivity',
  'publishLeagueDraftPickActivity',
  'reconcileDraftTurnAfterCommittedPick',
  'recoverStaleProjectionGenerationRequests',
  'repairDraftTurnHandoff',
  'requestProjectionSnapshotGeneration',
  'runScheduledDraftAutomation',
]);

export const requiredReadOnlyFunctions = Object.freeze([
  ...criticalDraftFunctions,
  'getFinalScoreReconciliationPage',
]);

export const allowedReviewPaths = Object.freeze(new Set([
  'README.md',
  'RINKRAT_COMPETITIVE_ROADMAP.txt',
  'docs/RINKRAT_CODEX_HANDOFF.md',
  'docs/RINKRAT_COMPETITIVE_ROADMAP.txt',
  'docs/RINKRAT_FF1_DRAFT_GATE_RUNBOOK.md',
  'package.json',
  'scripts/release/ff1-draft-preflight.mjs',
  'test/batchff1-draft-gate/ff1-draft-gate.test.mjs',
]));

export const allowedPackageScripts = Object.freeze(new Set([
  'ff1:draft:preflight',
  'preverify:batchff1',
  'test:batchff1:run',
  'verify:batchff1',
  'verify:batchff1:core',
]));

function requireCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readText(relativePath) {
  return readFile(path.join(projectRoot, relativePath), 'utf8');
}

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    cwd: projectRoot,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

function npmVersionFromUserAgent() {
  const match = String(process.env.npm_config_user_agent ?? '').match(/(?:^|\s)npm\/([^\s]+)/);
  return match?.[1] ?? '';
}

async function actualNpmVersion() {
  const userAgent = npmVersionFromUserAgent();
  if (userAgent) {
    return normalizeVersion(userAgent);
  }
  const result = await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version']);
  return normalizeVersion(result.stdout);
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

export function classifyReviewDelta(paths) {
  const uniquePaths = [...new Set(paths.map((entry) => String(entry).trim()).filter(Boolean))];
  const rejected = uniquePaths.filter((entry) => !allowedReviewPaths.has(entry));
  return {
    paths: uniquePaths,
    rejected,
    ready: rejected.length === 0,
  };
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function stripAllowedPackageScripts(packageJson) {
  const clone = structuredClone(packageJson);
  for (const script of allowedPackageScripts) {
    delete clone.scripts?.[script];
  }
  return clone;
}

export function packageChangeIsToolingOnly(basePackage, currentPackage) {
  return stableJson(stripAllowedPackageScripts(basePackage)) === stableJson(stripAllowedPackageScripts(currentPackage));
}

export function validateLiveManifest(manifest, policy) {
  const issues = [];
  if (manifest?.schemaVersion !== 1) issues.push('unsupported schema');
  if (manifest?.releaseLabel !== policy.releaseLabel) issues.push('release label mismatch');
  if (!/^[0-9a-f]{40}$/i.test(String(manifest?.sourceRevision ?? ''))) issues.push('missing clean full source revision');
  if (manifest?.scoringRulesVersion !== policy.scoringRulesVersion) issues.push('Scoring version mismatch');
  if (manifest?.projectionVersion !== policy.projectionVersion) issues.push('Projection version mismatch');
  return { ready: issues.length === 0, issues };
}

function deployedFunctionName(entry) {
  return String(entry?.name ?? entry?.id ?? '').split('/').at(-1);
}

export function validateRemoteFunctions(entries, required = requiredReadOnlyFunctions) {
  const byName = new Map(entries.map((entry) => [deployedFunctionName(entry), entry]));
  const missing = required.filter((name) => !byName.has(name));
  const inactive = required.filter((name) => {
    const entry = byName.get(name);
    return entry && String(entry.state ?? entry.status ?? '').toUpperCase() !== 'ACTIVE';
  });
  return { missing, inactive, ready: missing.length === 0 && inactive.length === 0 };
}

async function inspectStaticSource() {
  const [packageJson, nvmrc, policy, roadmapRoot, roadmapDocs, indexSource, runbook] = await Promise.all([
    readJson('package.json'),
    readText('.nvmrc'),
    readJson('config/release-freeze/beta-freeze-policy.json'),
    readText('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    readText('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    readText('functions/src/index.ts'),
    readText('docs/RINKRAT_FF1_DRAFT_GATE_RUNBOOK.md'),
  ]);

  const expectedNode = normalizeVersion(nvmrc);
  const expectedNpm = expectedPackageManagerVersion(packageJson.packageManager);
  requireCondition(expectedNode === '22.23.1', 'The FF1 gate requires Node 22.23.1.');
  requireCondition(expectedNpm === '11.17.0', 'The FF1 gate requires npm 11.17.0.');
  requireCondition(policy?.releaseLabel === 'Release Candidate 65', 'The season release label changed.');
  requireCondition(policy?.scoringRulesVersion === 4, 'Production Scoring V4 is not frozen.');
  requireCondition(policy?.projectionVersion === 11, 'Projection V11 is not frozen.');
  requireCondition(policy?.requiredGamesPerRosterSlot === 6, 'The six-game ownership contract changed.');
  requireCondition(policy?.queueMode === 'shadow', 'The scoring queue mode changed from Shadow.');
  requireCondition(policy?.appCheckMode === 'monitor', 'The App Check mode changed from Monitor.');
  requireCondition(roadmapRoot === roadmapDocs, 'The two competitive-roadmap copies differ.');
  requireCondition(packageJson.scripts?.['verify:batchd1m'], 'The inherited D1M release gate is missing.');
  requireCondition(packageJson.scripts?.['verify:batchff1'], 'The FF1 Draft gate is missing.');
  requireCondition(runbook.includes('Do not use a real family roster as the rehearsal.'), 'The disposable-roster safety boundary is missing.');
  requireCondition(runbook.includes('Never edit Production documents directly in Firestore.'), 'The no-direct-write safety boundary is missing.');
  for (const functionName of requiredReadOnlyFunctions) {
    requireCondition(indexSource.includes(functionName), `Required Function export ${functionName} is missing from source.`);
  }

  return {
    packageJson,
    policy,
    expectedNode,
    expectedNpm,
    expectedFunctionNames: collectExpectedFirebaseFunctionNames(indexSource),
  };
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
  requireCondition(branch.trim() === 'main', `Run the live FF1 preflight only from main; current branch is ${branch.trim() || 'detached'}.`);
  requireCondition(divergence.trim().replace(/\s+/g, '/') === '0/0', `main is not synchronized with origin/main (${divergence.trim()}).`);
  return { commit: commit.trim(), branch: branch.trim() };
}

async function fetchLiveManifest(policy, options) {
  const publicUrl = optionString(options, 'url', policy.publicUrl).replace(/\/$/, '');
  const response = await fetch(`${publicUrl}/release-manifest.json?ff1=${Date.now()}`, {
    cache: 'no-store',
    redirect: 'follow',
  });
  requireCondition(response.ok, `Unable to read the live release manifest (${response.status}).`);
  const manifest = await response.json();
  const validation = validateLiveManifest(manifest, policy);
  requireCondition(validation.ready, `The live manifest failed FF1 validation:\n- ${validation.issues.join('\n- ')}`);
  return manifest;
}

async function inspectReviewBoundary(liveRevision, headRevision, currentPackage) {
  await run('git', ['cat-file', '-e', `${liveRevision}^{commit}`]);
  try {
    await run('git', ['merge-base', '--is-ancestor', liveRevision, headRevision]);
  } catch {
    throw new Error('The live Hosting source is not an ancestor of the reviewed main commit.');
  }
  const { stdout: changedOutput } = await run('git', ['diff', '--name-only', `${liveRevision}...${headRevision}`]);
  const delta = classifyReviewDelta(changedOutput.split(/\r?\n/));
  requireCondition(delta.ready, `Runtime or unapproved release input differs from live Hosting:\n- ${delta.rejected.join('\n- ')}`);
  if (delta.paths.includes('package.json')) {
    const { stdout: basePackageOutput } = await run('git', ['show', `${liveRevision}:package.json`]);
    const basePackage = JSON.parse(basePackageOutput);
    requireCondition(packageChangeIsToolingOnly(basePackage, currentPackage), 'package.json changed beyond the five FF1 tooling scripts.');
  }
  return delta;
}

async function inspectProductionFunctions(policy, expectedFunctionNames) {
  const { stdout } = await run('gcloud', [
    'functions', 'list', '--v2', '--regions=us-central1',
    `--project=${policy.firebaseProjectId}`, '--format=json',
  ]);
  const entries = JSON.parse(stdout || '[]');
  const inventory = buildFirebaseFunctionsDeploymentAudit({
    expectedNames: expectedFunctionNames,
    remotePayload: entries,
    projectId: policy.firebaseProjectId,
    expectedRegion: 'us-central1',
  });
  requireCondition(inventory.ready, [
    'The local/deployed Production Function inventory differs.',
    inventory.missing.length ? `Missing: ${inventory.missing.join(', ')}` : '',
    inventory.unexpected.length ? `Unexpected: ${inventory.unexpected.join(', ')}` : '',
    inventory.regionMismatches.length ? `Wrong region: ${inventory.regionMismatches.map((entry) => entry.name ?? entry).join(', ')}` : '',
    inventory.duplicateRemoteNames.length ? `Duplicates: ${inventory.duplicateRemoteNames.join(', ')}` : '',
  ].filter(Boolean).join('\n'));
  const validation = validateRemoteFunctions(entries);
  requireCondition(validation.ready, [
    'Critical Production Function evidence is incomplete.',
    validation.missing.length ? `Missing: ${validation.missing.join(', ')}` : '',
    validation.inactive.length ? `Not ACTIVE: ${validation.inactive.join(', ')}` : '',
  ].filter(Boolean).join('\n'));
  return { validation, inventory };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const source = await inspectStaticSource();
  console.log('FF1 Draft gate static source: PASS');
  console.log(`Protected contracts: Scoring V${source.policy.scoringRulesVersion}, Projection V${source.policy.projectionVersion}, ${source.policy.requiredGamesPerRosterSlot} games`);
  console.log(`Modes: queue ${source.policy.queueMode}, App Check ${source.policy.appCheckMode}`);

  if (options.has('source-only')) {
    console.log('Source-only mode performed no network, Firebase, Git mutation, or Production data operation.');
    return;
  }

  const [toolchain, git] = await Promise.all([inspectToolchain(source), inspectGit()]);
  const manifest = await fetchLiveManifest(source.policy, options);
  const delta = await inspectReviewBoundary(manifest.sourceRevision, git.commit, source.packageJson);
  const functions = await inspectProductionFunctions(source.policy, source.expectedFunctionNames);

  console.log('\nFF1 Draft live preflight: PASS');
  console.log(`Toolchain: Node ${toolchain.node}, npm ${toolchain.npm}`);
  console.log(`Reviewed main: ${git.commit}`);
  console.log(`Live Hosting source: ${manifest.sourceRevision}`);
  console.log(`Live build: ${manifest.buildId}`);
  console.log(`Review-only files ahead of live: ${delta.paths.length}`);
  console.log(`Function inventory parity: ${functions.inventory.matchedCount}/${functions.inventory.expectedCount}`);
  console.log(`Critical ACTIVE Functions: ${requiredReadOnlyFunctions.length}/${requiredReadOnlyFunctions.length}`);
  console.log('This result authorizes evidence collection only. It does not authorize a real Draft.');
  console.log('No Firebase resource, account, league, Draft, roster, or competitive record was modified.');
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
