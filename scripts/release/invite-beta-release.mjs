#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  formatRollbackPlan,
  safeTagName,
  sha256,
  tagSlug,
  validateInviteBetaValidationReport,
} from './invite-beta-release.util.mjs';
import {
  expectedPackageManagerVersion,
  inspectToolchain,
  normalizeVersion,
} from './toolchain-preflight.util.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputDirectory = path.join(projectRoot, '.beta-release');
const defaultTag = 'rinkrat-rc29-invite-beta';

function parseArguments(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith('--') ? args.shift() : 'preflight';
  const options = new Map();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('--')) {
      throw new Error(`Unexpected argument: ${argument}`);
    }

    const raw = argument.slice(2);
    const separatorIndex = raw.indexOf('=');
    if (separatorIndex >= 0) {
      options.set(raw.slice(0, separatorIndex), raw.slice(separatorIndex + 1));
      continue;
    }

    const next = args[index + 1];
    if (next && !next.startsWith('--')) {
      options.set(raw, next);
      index += 1;
    } else {
      options.set(raw, true);
    }
  }

  return { command, options };
}

function optionString(options, key, fallback = '') {
  const value = options.get(key);
  if (value === true || value === undefined) {
    return fallback;
  }
  return String(value).trim();
}

function optionEnabled(options, key) {
  const value = options.get(key);
  return value === true || value === 'true' || value === 'yes' || value === '1';
}

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
    maxBuffer: 12 * 1024 * 1024,
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

function hostingHeaderMap(firebaseJson) {
  const groups = Array.isArray(firebaseJson?.hosting?.headers) ? firebaseJson.hosting.headers : [];
  const globalHeaders = groups.find((entry) => entry?.source === '**')?.headers ?? [];
  return new Map(globalHeaders.map((entry) => [String(entry.key).toLowerCase(), String(entry.value)]));
}

function booleanFromSource(source, property) {
  const match = source.match(new RegExp(`${property}:\\s*(true|false)`));
  return match?.[1] === 'true';
}

async function inspectStaticSource() {
  const [
    packageJson,
    nvmrc,
    policy,
    firebaseJson,
    firebaseRc,
    ttlBaseline,
    appCheckSource,
    runtimeSource,
    productionRuntimeSource,
    roadmapRoot,
    roadmapDocs,
  ] = await Promise.all([
    readJson('package.json'),
    readText('.nvmrc'),
    readJson('config/release-freeze/beta-freeze-policy.json'),
    readJson('firebase.json'),
    readJson('.firebaserc'),
    readJson('config/firestore-ttl-baseline.json'),
    readText('src/environments/app-check.config.ts'),
    readText('src/environments/app-runtime.config.ts'),
    readText('src/environments/app-runtime.config.production.ts'),
    readText('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    readText('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
  ]);

  const expectedNode = normalizeVersion(nvmrc);
  const expectedNpm = expectedPackageManagerVersion(packageJson.packageManager);
  requireCondition(policy?.schemaVersion === 1, 'The invite-beta freeze policy is invalid.');
  requireCondition(expectedNode === policy.requiredNodeVersion, 'The .nvmrc version does not match the release-freeze policy.');
  requireCondition(expectedNpm === policy.requiredNpmVersion, 'The packageManager npm version does not match the release-freeze policy.');
  requireCondition(packageJson.engines?.node === '>=22.22.3 <23', 'The approved Node engine range changed unexpectedly.');
  requireCondition(packageJson.engines?.npm === '11.17.x', 'The approved npm engine range changed unexpectedly.');
  requireCondition(roadmapRoot === roadmapDocs, 'The root and docs competitive-roadmap copies differ.');
  requireCondition(firebaseJson?.hosting?.target === policy.hostingTarget, 'firebase.json no longer uses the approved Hosting target.');
  const mappedSites = firebaseRc?.targets?.[policy.firebaseProjectId]?.hosting?.[policy.hostingTarget] ?? [];
  requireCondition(mappedSites.includes(policy.hostingSite), 'The approved Hosting target no longer maps to the expected site.');

  const headers = hostingHeaderMap(firebaseJson);
  requireCondition(headers.get('strict-transport-security') === 'max-age=31536000', 'The local HSTS baseline changed.');
  requireCondition(headers.has('content-security-policy-report-only'), 'The local CSP report-only header is missing.');
  requireCondition(!headers.has('content-security-policy'), 'CSP enforcement must remain off during this monitored invite-beta freeze.');
  requireCondition(booleanFromSource(appCheckSource, 'enabled'), 'The production App Check client is disabled.');
  requireCondition(!booleanFromSource(appCheckSource, 'localDebugTokenEnabled'), 'Production App Check debug-token discovery is enabled.');
  requireCondition(ttlBaseline?.policies?.length === policy.requiredTtlPolicyCount, 'The source TTL baseline count does not match the freeze policy.');
  requireCondition(runtimeSource.includes(`releaseLabel: '${policy.releaseLabel}'`), 'The development runtime release label changed.');
  requireCondition(productionRuntimeSource.includes(`releaseLabel: '${policy.releaseLabel}'`), 'The production runtime release label changed.');
  requireCondition(packageJson.scripts?.['verify:batchs3d'], 'The approved runtime verification command is missing.');
  requireCondition(packageJson.scripts?.['verify:batchb1c'], 'The B1C verification command is missing.');

  return {
    packageJson,
    policy,
    expectedNode,
    expectedNpm,
    ttlPolicyCount: ttlBaseline.policies.length,
  };
}

async function inspectRuntimeToolchain(source) {
  const result = inspectToolchain({
    expectedNode: source.expectedNode,
    expectedNpm: source.expectedNpm,
    actualNode: process.version,
    actualNpm: await actualNpmVersion(),
  });
  if (!result.ok) {
    throw new Error(`The pinned release toolchain is not active:\n- ${result.issues.join('\n- ')}`);
  }
  return result.actual;
}

async function inspectGit({ allowDirty = false } = {}) {
  const [{ stdout: commitOutput }, { stdout: branchOutput }, { stdout: statusOutput }] = await Promise.all([
    run('git', ['rev-parse', 'HEAD']),
    run('git', ['branch', '--show-current']),
    run('git', [
      'status',
      '--porcelain',
      '--untracked-files=normal',
      '--',
      '.',
      ':(exclude)public/release-manifest.json',
      ':(exclude)src/environments/generated-release-manifest.ts',
      ':(exclude).beta-release/**',
    ]),
  ]);

  const commit = commitOutput.trim();
  const status = statusOutput.trim();
  requireCondition(/^[0-9a-f]{40}$/i.test(commit), 'A full Git commit could not be resolved.');
  requireCondition(allowDirty || status.length === 0, `The Git working tree is not clean:\n${status}`);

  return {
    commit,
    branch: branchOutput.trim() || 'detached',
    clean: status.length === 0,
    status,
  };
}

async function fetchLiveRelease(source, options) {
  const publicUrl = optionString(options, 'url', source.policy.publicUrl).replace(/\/$/, '');
  const [manifestResponse, pageResponse] = await Promise.all([
    fetch(`${publicUrl}/release-manifest.json`, { cache: 'no-store', redirect: 'follow' }),
    fetch(`${publicUrl}/`, { method: 'HEAD', cache: 'no-store', redirect: 'follow' }),
  ]);

  requireCondition(manifestResponse.ok, `Unable to read the live release manifest (${manifestResponse.status}).`);
  requireCondition(pageResponse.ok, `Unable to inspect the live Hosting response (${pageResponse.status}).`);

  const manifest = await manifestResponse.json();
  const hsts = pageResponse.headers.get('strict-transport-security') ?? '';
  const cspReportOnly = pageResponse.headers.get('content-security-policy-report-only') ?? '';
  const enforcedCsp = pageResponse.headers.get('content-security-policy') ?? '';

  requireCondition(manifest?.schemaVersion === 1, 'The live release manifest schema is unsupported.');
  requireCondition(manifest?.releaseLabel === source.policy.releaseLabel, `Expected ${source.policy.releaseLabel}; live release is ${manifest?.releaseLabel ?? 'unknown'}.`);
  requireCondition(manifest?.scoringRulesVersion === source.policy.scoringRulesVersion, 'The live release is not using the approved Scoring version.');
  requireCondition(manifest?.projectionVersion === source.policy.projectionVersion, 'The live release is not using the approved Projection version.');
  requireCondition(/^[0-9a-f]{40}$/i.test(String(manifest?.sourceRevision ?? '')), 'The live manifest does not contain a clean 40-character source revision.');
  requireCondition(hsts === 'max-age=31536000', `Live HSTS does not match the approved baseline: ${hsts || 'missing'}.`);
  requireCondition(Boolean(cspReportOnly), 'Live CSP report-only is missing.');
  requireCondition(!enforcedCsp, 'Live CSP enforcement is already active; B1C expects monitored report-only mode.');

  return {
    publicUrl,
    manifest,
    headers: {
      strictTransportSecurity: hsts,
      contentSecurityPolicyReportOnly: true,
      contentSecurityPolicyEnforced: false,
    },
  };
}

async function inspectTtl(source) {
  const result = await run('node', [
    'scripts/security/firestore-ttl-baseline.mjs',
    `--project=${source.policy.firebaseProjectId}`,
  ]);
  const output = `${result.stdout}\n${result.stderr}`;
  const expected = `${source.policy.requiredTtlPolicyCount}/${source.policy.requiredTtlPolicyCount}`;
  requireCondition(output.includes(`TTL baseline passed: ${expected} expected policies are ACTIVE.`), `Production Firestore did not confirm ${expected} active TTL policies.`);
  return source.policy.requiredTtlPolicyCount;
}

async function ensureCommitAvailable(commit) {
  await run('git', ['cat-file', '-e', `${commit}^{commit}`]);
}

async function loadValidationReport(filePath, liveManifest) {
  requireCondition(filePath, 'Provide the copied Release Readiness JSON through --validation-report="/path/to/report.json".');
  const absolutePath = path.resolve(filePath);
  const source = await readFile(absolutePath, 'utf8');
  let report;
  try {
    report = JSON.parse(source);
  } catch {
    throw new Error('The validation report is not valid JSON. Copy the complete Release Readiness report into one .json file.');
  }

  const validation = validateInviteBetaValidationReport(report, liveManifest);
  requireCondition(validation.ok, `The exact-build validation report cannot freeze this release:\n- ${validation.issues.join('\n- ')}`);
  return {
    path: absolutePath,
    sha256: sha256(source),
    ...validation.summary,
  };
}

async function fileSha256(relativePath) {
  return sha256(await readFile(path.join(projectRoot, relativePath)));
}

async function freezeRecordPath(tag) {
  await mkdir(outputDirectory, { recursive: true });
  return path.join(outputDirectory, `${tagSlug(tag)}.json`);
}

async function readFreezeRecord(options) {
  const tag = safeTagName(optionString(options, 'tag', defaultTag));
  const recordPath = await freezeRecordPath(tag);
  return {
    tag,
    recordPath,
    record: JSON.parse(await readFile(recordPath, 'utf8')),
  };
}

async function writeRecordAndPlan(record) {
  const recordPath = await freezeRecordPath(record.git.tag);
  const planPath = path.join(outputDirectory, `${tagSlug(record.git.tag)}-ROLLBACK.md`);
  await Promise.all([
    writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8'),
    writeFile(planPath, formatRollbackPlan(record), 'utf8'),
  ]);
  return { recordPath, planPath };
}

function requireFreezeAcknowledgements(options) {
  requireCondition(optionEnabled(options, 'ci-passed'), 'Freeze requires --ci-passed after the current-release GitHub Actions verification succeeds.');
  requireCondition(optionEnabled(options, 'rollback-rehearsed'), 'Freeze requires --rollback-rehearsed after the rollback commands and queue-mode return path are rehearsed.');
  requireCondition(optionEnabled(options, 'queue-shadow'), 'Freeze requires --queue-shadow after Release Readiness confirms production queued scoring remains in Shadow.');
}

async function preflight(options) {
  const source = await inspectStaticSource();
  if (optionEnabled(options, 'source-only')) {
    console.log(`Invite-beta source preflight passed: Node ${source.expectedNode}, npm ${source.expectedNpm}, ${source.ttlPolicyCount} TTL policies, ${source.policy.releaseLabel} runtime, App Check monitor mode, CSP report-only, and Hosting target ${source.policy.hostingSite}.`);
    return;
  }

  const [toolchain, git, live, ttlCount] = await Promise.all([
    inspectRuntimeToolchain(source),
    inspectGit({ allowDirty: optionEnabled(options, 'allow-dirty') }),
    fetchLiveRelease(source, options),
    inspectTtl(source),
  ]);
  await ensureCommitAvailable(live.manifest.sourceRevision);

  console.log(
    `Invite-beta preflight passed: live ${live.manifest.releaseLabel} ${live.manifest.buildId}, ` +
    `deployed source ${live.manifest.sourceRevision.slice(0, 12)}, Node ${toolchain.node}, npm ${toolchain.npm}, ` +
    `${ttlCount}/${ttlCount} TTL policies, Git tooling ${git.commit.slice(0, 12)} on ${git.branch}.`,
  );
  console.log('The freeze remains locked until one copied exact-build validation report, CI confirmation, Shadow confirmation, and rollback rehearsal are supplied.');
}

async function freeze(options) {
  requireCondition(
    process.env.RINKRAT_FREEZE_INVITE_BETA === 'FREEZE',
    'Set RINKRAT_FREEZE_INVITE_BETA=FREEZE to acknowledge that this records a production invite-beta baseline.',
  );
  requireFreezeAcknowledgements(options);

  const source = await inspectStaticSource();
  const [toolchain, git, live, ttlCount] = await Promise.all([
    inspectRuntimeToolchain(source),
    inspectGit(),
    fetchLiveRelease(source, options),
    inspectTtl(source),
  ]);
  await ensureCommitAvailable(live.manifest.sourceRevision);
  const validation = await loadValidationReport(
    optionString(options, 'validation-report'),
    live.manifest,
  );
  const tag = safeTagName(optionString(options, 'tag', defaultTag));

  const hashPaths = [
    'package-lock.json',
    'functions/package-lock.json',
    'firebase.json',
    'firestore.rules',
    'firestore.indexes.json',
    'config/firestore-ttl-baseline.json',
    'config/release-freeze/beta-freeze-policy.json',
    'RINKRAT_COMPETITIVE_ROADMAP.txt',
  ];
  const toolingHashes = Object.fromEntries(
    await Promise.all(hashPaths.map(async (relativePath) => [relativePath, await fileSha256(relativePath)])),
  );

  const record = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    status: 'ready-to-tag',
    release: live.manifest,
    liveHeaders: live.headers,
    validation,
    confirmations: {
      githubCiPassed: true,
      rollbackRehearsed: true,
      scoringQueueMode: source.policy.queueMode,
      ttlPoliciesActive: ttlCount,
    },
    competitiveContract: {
      scoringRulesVersion: source.policy.scoringRulesVersion,
      projectionVersion: source.policy.projectionVersion,
      requiredGamesPerRosterSlot: source.policy.requiredGamesPerRosterSlot,
      appCheckMode: source.policy.appCheckMode,
      cspMode: source.policy.cspMode,
    },
    toolchain: {
      node: toolchain.node,
      npm: toolchain.npm,
      packageManager: source.packageJson.packageManager,
    },
    firebase: {
      projectId: source.policy.firebaseProjectId,
      hostingTarget: source.policy.hostingTarget,
      hostingSite: source.policy.hostingSite,
      publicUrl: live.publicUrl,
    },
    git: {
      tag,
      deployedSourceCommit: live.manifest.sourceRevision,
      toolingCommit: git.commit,
      toolingBranch: git.branch,
    },
    toolingHashes,
  };

  const paths = await writeRecordAndPlan(record);
  console.log(`Invite-beta freeze record created: ${paths.recordPath}`);
  console.log(`Rollback plan created: ${paths.planPath}`);
  console.log('Review both files, then create the annotated tag on the deployed source commit:');
  console.log(`git tag -a ${tag} ${live.manifest.sourceRevision} -m "RinkRat ${live.manifest.releaseLabel} invite beta baseline"`);
  console.log(`git push origin ${tag}`);
  console.log(`npm run beta:verify-tag -- --tag=${tag}`);
}

async function verifyTag(options) {
  const { tag, record } = await readFreezeRecord(options);
  const result = await run('git', ['rev-list', '-n', '1', tag]);
  const tagCommit = result.stdout.trim();
  requireCondition(tagCommit === record.release.sourceRevision, `Tag ${tag} points to ${tagCommit || 'nothing'}, not the frozen deployed source ${record.release.sourceRevision}.`);
  console.log(`Invite-beta tag verified: ${tag} -> ${tagCommit}.`);
}

async function verifyFreeze(options) {
  const source = await inspectStaticSource();
  await inspectRuntimeToolchain(source);
  const { tag, record } = await readFreezeRecord(options);
  const live = await fetchLiveRelease(source, options);
  requireCondition(live.manifest.buildId === record.release.buildId, 'The live build ID no longer matches the frozen baseline.');
  requireCondition(live.manifest.sourceRevision === record.release.sourceRevision, 'The live source revision no longer matches the frozen baseline.');
  await inspectTtl(source);
  await verifyTag(new Map([['tag', tag]]));
  console.log(`Invite-beta freeze verified: ${record.release.releaseLabel} ${record.release.buildId} remains live and ${tag} points to ${record.release.sourceRevision.slice(0, 12)}.`);
}

async function rollbackPlan(options) {
  const { tag, record } = await readFreezeRecord(options);
  const planPath = path.join(outputDirectory, `${tagSlug(tag)}-ROLLBACK.md`);
  await writeFile(planPath, formatRollbackPlan(record), 'utf8');
  console.log(`Rollback plan refreshed: ${planPath}`);
}

const { command, options } = parseArguments(process.argv.slice(2));

try {
  if (command === 'preflight') {
    await preflight(options);
  } else if (command === 'freeze') {
    await freeze(options);
  } else if (command === 'verify-tag') {
    await verifyTag(options);
  } else if (command === 'verify-freeze') {
    await verifyFreeze(options);
  } else if (command === 'rollback-plan') {
    await rollbackPlan(options);
  } else {
    throw new Error(`Unknown invite-beta release command: ${command}`);
  }
} catch (error) {
  console.error(`Invite-beta release check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
