#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  buildSeasonKitFiles,
  formatSeasonIncidentGuide,
  formatSeasonLaunchChecklist,
  formatSeasonRollbackPlan,
  functionSelector,
  safeTagName,
  sha256,
  validateSeasonFreezeEvidence,
} from './season-freeze.util.mjs';
import {
  expectedPackageManagerVersion,
  inspectToolchain,
  normalizeVersion,
} from './toolchain-preflight.util.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputRoot = path.join(projectRoot, '.season-release');

function parseArguments(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith('--')
    ? args.shift()
    : 'preflight';
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
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

function npmVersionFromUserAgent() {
  const match = String(process.env.npm_config_user_agent ?? '')
    .match(/(?:^|\s)npm\/([^\s]+)/);
  return match?.[1] ?? '';
}

async function actualNpmVersion() {
  const userAgent = npmVersionFromUserAgent();
  if (userAgent) {
    return normalizeVersion(userAgent);
  }

  const result = await run(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['--version'],
  );
  return normalizeVersion(result.stdout);
}

function hostingHeaderMap(firebaseJson) {
  const groups = Array.isArray(firebaseJson?.hosting?.headers)
    ? firebaseJson.hosting.headers
    : [];
  const globalHeaders = groups.find((entry) => entry?.source === '**')?.headers ?? [];
  return new Map(
    globalHeaders.map((entry) => [
      String(entry.key).toLowerCase(),
      String(entry.value),
    ]),
  );
}

function booleanFromSource(source, property) {
  const match = source.match(new RegExp(`${property}:\\s*(true|false)`));
  return match?.[1] === 'true';
}

function tagSlug(value) {
  return safeTagName(value).replace(/[^A-Za-z0-9._-]+/g, '-');
}

async function inspectStaticSource() {
  const [
    packageJson,
    nvmrc,
    policy,
    deploymentPolicy,
    firebaseJson,
    firebaseRc,
    ttlBaseline,
    appCheckSource,
    runtimeSource,
    productionRuntimeSource,
    roadmapRoot,
    roadmapDocs,
    queueControlSource,
    privateSeasonSource,
    indexSource,
  ] = await Promise.all([
    readJson('package.json'),
    readText('.nvmrc'),
    readJson('config/release-freeze/season-freeze-policy.json'),
    readJson('config/release-freeze/season-deployment-policy.json'),
    readJson('firebase.json'),
    readJson('.firebaserc'),
    readJson('config/firestore-ttl-baseline.json'),
    readText('src/environments/app-check.config.ts'),
    readText('src/environments/app-runtime.config.ts'),
    readText('src/environments/app-runtime.config.production.ts'),
    readText('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    readText('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    readText('src/app/features/release/scoring-queue-control-center/scoring-queue-control-center.ts'),
    readText('src/app/features/admin/private-season-center/private-season-center.ts'),
    readText('functions/src/index.ts'),
  ]);

  const expectedNode = normalizeVersion(nvmrc);
  const expectedNpm = expectedPackageManagerVersion(packageJson.packageManager);

  requireCondition(policy?.schemaVersion === 1, 'The season-freeze policy is invalid.');
  requireCondition(deploymentPolicy?.schemaVersion === 1, 'The season deployment policy is invalid.');
  requireCondition(expectedNode === policy.requiredNodeVersion, '.nvmrc does not match the season-freeze policy.');
  requireCondition(expectedNpm === policy.requiredNpmVersion, 'packageManager does not match the season-freeze policy.');
  requireCondition(packageJson.engines?.node === '>=22.22.3 <23', 'The approved Node engine range changed.');
  requireCondition(packageJson.engines?.npm === '11.17.x', 'The approved npm engine range changed.');
  requireCondition(roadmapRoot === roadmapDocs, 'The root and docs competitive roadmaps differ.');
  requireCondition(firebaseJson?.hosting?.target === policy.hostingTarget, 'firebase.json no longer uses the approved Hosting target.');

  const mappedSites = firebaseRc?.targets?.[policy.firebaseProjectId]
    ?.hosting?.[policy.hostingTarget] ?? [];
  requireCondition(
    mappedSites.includes(policy.hostingSite),
    'The approved Hosting target no longer maps to the expected site.',
  );

  const headers = hostingHeaderMap(firebaseJson);
  requireCondition(
    headers.get('strict-transport-security') === 'max-age=31536000',
    'The local HSTS baseline changed.',
  );
  requireCondition(
    headers.has('content-security-policy-report-only'),
    'The local CSP report-only header is missing.',
  );
  requireCondition(
    !headers.has('content-security-policy'),
    'CSP enforcement must remain off during the private-season freeze.',
  );
  requireCondition(booleanFromSource(appCheckSource, 'enabled'), 'The production App Check client is disabled.');
  requireCondition(!booleanFromSource(appCheckSource, 'localDebugTokenEnabled'), 'Production App Check debug-token discovery is enabled.');
  requireCondition(
    ttlBaseline?.policies?.length === policy.requiredTtlPolicyCount,
    'The source TTL baseline count does not match the season-freeze policy.',
  );
  requireCondition(runtimeSource.includes(`releaseLabel: '${policy.releaseLabel}'`), 'The development runtime release label changed.');
  requireCondition(productionRuntimeSource.includes(`releaseLabel: '${policy.releaseLabel}'`), 'The production runtime release label changed.');
  requireCondition(policy.verificationCommand === 'npm run verify:batchd1j', 'The D1J verification command changed unexpectedly.');
  requireCondition(packageJson.scripts?.['verify:batchd1j'], 'The D1J verification command is missing.');
  requireCondition(packageJson.scripts?.['season:freeze'], 'The private-season freeze command is missing.');
  requireCondition(queueControlSource.includes('copySeasonLaunchEvidence'), 'The scoring freeze-evidence export is missing.');
  requireCondition(privateSeasonSource.includes('copyFreezeEvidence'), 'The private-season freeze-evidence export is missing.');
  requireCondition(
    deploymentPolicy.firebaseProjectId === policy.firebaseProjectId &&
      deploymentPolicy.hostingTarget === policy.hostingTarget,
    'The season deployment policy does not match the freeze policy.',
  );

  for (const name of deploymentPolicy.affectedFunctions) {
    requireCondition(
      new RegExp(`\\b${name}\\b`).test(indexSource),
      `The deployment policy references missing Function ${name}.`,
    );
  }

  return {
    packageJson,
    policy,
    deploymentPolicy,
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
  const [{ stdout: commitOutput }, { stdout: branchOutput }, { stdout: statusOutput }] =
    await Promise.all([
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
        ':(exclude).season-release/**',
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
  const publicUrl = optionString(options, 'url', source.policy.publicUrl)
    .replace(/\/$/, '');
  const [manifestResponse, pageResponse] = await Promise.all([
    fetch(`${publicUrl}/release-manifest.json`, {
      cache: 'no-store',
      redirect: 'follow',
    }),
    fetch(`${publicUrl}/`, {
      method: 'HEAD',
      cache: 'no-store',
      redirect: 'follow',
    }),
  ]);

  requireCondition(manifestResponse.ok, `Unable to read the live release manifest (${manifestResponse.status}).`);
  requireCondition(pageResponse.ok, `Unable to inspect the live Hosting response (${pageResponse.status}).`);

  const manifest = await manifestResponse.json();
  const headers = {
    hsts: pageResponse.headers.get('strict-transport-security') ?? '',
    cspReportOnly:
      pageResponse.headers.get('content-security-policy-report-only') ?? '',
    enforcedCsp: pageResponse.headers.get('content-security-policy') ?? '',
  };

  requireCondition(manifest?.schemaVersion === 1, 'The live release manifest schema is unsupported.');
  requireCondition(manifest?.releaseLabel === source.policy.releaseLabel, `Expected ${source.policy.releaseLabel}; live release is ${manifest?.releaseLabel ?? 'unknown'}.`);
  requireCondition(manifest?.scoringRulesVersion === source.policy.scoringRulesVersion, 'The live release is not using the approved Scoring version.');
  requireCondition(manifest?.projectionVersion === source.policy.projectionVersion, 'The live release is not using the approved Projection version.');
  requireCondition(/^[0-9a-f]{40}$/i.test(String(manifest?.sourceRevision ?? '')), 'The live release manifest does not contain one clean source revision.');
  requireCondition(headers.hsts === 'max-age=31536000', 'The live HSTS header does not match the approved baseline.');
  requireCondition(Boolean(headers.cspReportOnly), 'The live CSP report-only header is missing.');
  requireCondition(!headers.enforcedCsp, 'Unexpected enforced CSP is active during the monitored private season.');

  return { publicUrl, manifest, headers };
}

async function inspectTtl(source) {
  const result = await run(process.execPath, [
    'scripts/security/firestore-ttl-baseline.mjs',
    `--project=${source.policy.firebaseProjectId}`,
  ]);
  requireCondition(
    result.stdout.includes(
      `TTL baseline passed: ${source.ttlPolicyCount}/${source.ttlPolicyCount}`,
    ),
    'The active Firestore TTL baseline could not be verified.',
  );
  return source.ttlPolicyCount;
}

async function ensureCommitAvailable(commit) {
  await run('git', ['cat-file', '-e', `${commit}^{commit}`]);
}

async function loadJsonEvidence(filePath, label) {
  requireCondition(filePath, `${label} requires an explicit file path.`);
  const absolutePath = path.resolve(projectRoot, filePath);
  const source = await readFile(absolutePath, 'utf8');
  let report;
  try {
    report = JSON.parse(source);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }

  return {
    path: absolutePath,
    source,
    report,
    sha256: sha256(source),
  };
}

async function fileSha256(relativePath) {
  return sha256(await readFile(path.join(projectRoot, relativePath)));
}

async function outputDirectoryForTag(tag) {
  const directory = path.join(outputRoot, tagSlug(tag));
  await mkdir(path.join(directory, 'evidence'), { recursive: true });
  return directory;
}

async function readFreezeRecord(options, source) {
  const tag = safeTagName(optionString(options, 'tag', source.policy.defaultTag));
  const directory = await outputDirectoryForTag(tag);
  const recordPath = path.join(directory, 'FREEZE_RECORD.json');
  return {
    tag,
    directory,
    recordPath,
    record: JSON.parse(await readFile(recordPath, 'utf8')),
  };
}

async function writeSeasonKit(record, source, evidenceFiles) {
  const directory = await outputDirectoryForTag(record.git.tag);
  const evidenceDirectory = path.join(directory, 'evidence');
  const recordPath = path.join(directory, 'FREEZE_RECORD.json');
  const rollbackPath = path.join(directory, 'ROLLBACK.md');
  const incidentPath = path.join(directory, 'INCIDENT_FIRST_15_MINUTES.md');
  const checklistPath = path.join(directory, 'SEASON_LAUNCH_CHECKLIST.md');
  const selectorPath = path.join(directory, 'FIREBASE_FUNCTION_SELECTOR.txt');

  const kitFiles = buildSeasonKitFiles(record, source.deploymentPolicy);

  await Promise.all([
    ...Object.entries(kitFiles).map(([fileName, content]) =>
      writeFile(path.join(directory, fileName), content, 'utf8'),
    ),
    ...evidenceFiles.map((evidence) =>
      writeFile(
        path.join(evidenceDirectory, evidence.fileName),
        evidence.source.endsWith('\n') ? evidence.source : `${evidence.source}\n`,
        'utf8',
      ),
    ),
  ]);

  return {
    directory,
    recordPath,
    rollbackPath,
    incidentPath,
    checklistPath,
    selectorPath,
  };
}

function requireFreezeAcknowledgements(options) {
  requireCondition(optionEnabled(options, 'ci-passed'), 'Freeze requires --ci-passed after the current GitHub Actions run succeeds.');
  requireCondition(optionEnabled(options, 'rollback-rehearsed'), 'Freeze requires --rollback-rehearsed after the frozen-source rollback is rehearsed.');
  requireCondition(optionEnabled(options, 'queue-shadow'), 'Freeze requires --queue-shadow after Release Readiness confirms Shadow and a drained queue.');
  requireCondition(optionEnabled(options, 'private-season-approved'), 'Freeze requires --private-season-approved after the formal exact-build go decision is recorded.');
  requireCondition(optionEnabled(options, 'preseason-certified'), 'Freeze requires --preseason-certified after the deterministic certification report passes.');
}

async function preflight(options) {
  const source = await inspectStaticSource();
  if (optionEnabled(options, 'source-only')) {
    console.log(
      `Private-season source preflight passed: ${source.policy.seasonLabel}, ` +
      `Node ${source.expectedNode}, npm ${source.expectedNpm}, ` +
      `${source.ttlPolicyCount} TTL policies, ${source.policy.releaseLabel}, ` +
      `${source.deploymentPolicy.affectedFunctions.length} targeted scoring Functions, ` +
      `Shadow freeze, App Check monitor, and CSP report-only.`,
    );
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
    `Private-season preflight passed: live ${live.manifest.releaseLabel} ` +
    `${live.manifest.buildId}, deployed source ` +
    `${live.manifest.sourceRevision.slice(0, 12)}, Node ${toolchain.node}, ` +
    `npm ${toolchain.npm}, ${ttlCount}/${ttlCount} TTL policies, ` +
    `Git tooling ${git.commit.slice(0, 12)} on ${git.branch}.`,
  );
  console.log(
    'Freeze remains locked until exact-build validation, scoring evidence, private-season approval evidence, preseason certification, CI, Shadow, and rollback rehearsal are supplied.',
  );
}

async function freeze(options) {
  requireCondition(
    process.env.RINKRAT_FREEZE_PRIVATE_SEASON === 'FREEZE',
    'Set RINKRAT_FREEZE_PRIVATE_SEASON=FREEZE to acknowledge that this records the production private-season baseline.',
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

  const validationFile = await loadJsonEvidence(
    optionString(options, 'validation-report'),
    'The exact-build validation report',
  );
  const scoringFile = await loadJsonEvidence(
    optionString(options, 'scoring-evidence'),
    'The scoring freeze evidence',
  );
  const privateSeasonFile = await loadJsonEvidence(
    optionString(options, 'private-season-evidence'),
    'The private-season freeze evidence',
  );
  const certificationFile = await loadJsonEvidence(
    optionString(options, 'preseason-certification'),
    'The preseason certification report',
  );

  const evidence = validateSeasonFreezeEvidence({
    validationReport: validationFile.report,
    scoringEvidence: scoringFile.report,
    privateSeasonEvidence: privateSeasonFile.report,
    preseasonCertification: certificationFile.report,
    liveManifest: live.manifest,
    policy: source.policy,
    nowMilliseconds: Date.now(),
  });

  requireCondition(
    evidence.ok,
    `The season freeze evidence is not ready:\n- ${evidence.issues.join('\n- ')}`,
  );

  const tag = safeTagName(
    optionString(options, 'tag', source.policy.defaultTag),
  );
  const hashPaths = [
    'package-lock.json',
    'functions/package-lock.json',
    'firebase.json',
    'firestore.rules',
    'firestore.indexes.json',
    'config/firestore-ttl-baseline.json',
    'config/release-freeze/season-freeze-policy.json',
    'config/release-freeze/season-deployment-policy.json',
    'RINKRAT_COMPETITIVE_ROADMAP.txt',
    'src/app/core/scoring/scoring-rules.ts',
    'functions/src/shared/core/scoring/scoring-rules.ts',
    'src/app/core/projection/projection-v11.util.ts',
    'functions/src/shared/core/projection/projection-v11.util.ts',
  ];
  const toolingHashes = Object.fromEntries(
    await Promise.all(
      hashPaths.map(async (relativePath) => [
        relativePath,
        await fileSha256(relativePath),
      ]),
    ),
  );

  const record = {
    schemaVersion: 1,
    recordType: 'rinkrat-private-season-freeze',
    recordedAt: new Date().toISOString(),
    status: 'ready-to-tag',
    seasonLabel: source.policy.seasonLabel,
    release: live.manifest,
    liveHeaders: live.headers,
    evidence: {
      validation: {
        fileName: 'release-readiness-validation.json',
        sha256: validationFile.sha256,
        ...evidence.validation,
      },
      scoring: {
        fileName: 'scoring-season-freeze-evidence.json',
        sha256: scoringFile.sha256,
        ...evidence.scoring,
      },
      privateSeason: {
        fileName: 'private-season-freeze-evidence.json',
        sha256: privateSeasonFile.sha256,
        ...evidence.privateSeason,
      },
      preseasonCertification: {
        fileName: 'preseason-scoring-certification.json',
        sha256: certificationFile.sha256,
        ...evidence.certification,
      },
      advisories: evidence.advisories,
    },
    verification: {
      command: source.policy.verificationCommand,
    },
    confirmations: {
      githubCiPassed: true,
      rollbackRehearsed: true,
      privateSeasonApproved: true,
      preseasonCertified: true,
      scoringQueueMode: source.policy.requiredQueueMode,
      canonicalAuthorityLeagueCount:
        source.policy.requiredCanonicalAuthorityLeagueCount,
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
      functionSelector: functionSelector(source.deploymentPolicy),
    },
    git: {
      tag,
      deployedSourceCommit: live.manifest.sourceRevision,
      toolingCommit: git.commit,
      toolingBranch: git.branch,
    },
    toolingHashes,
  };

  const paths = await writeSeasonKit(record, source, [
    {
      fileName: 'release-readiness-validation.json',
      source: validationFile.source,
    },
    {
      fileName: 'scoring-season-freeze-evidence.json',
      source: scoringFile.source,
    },
    {
      fileName: 'private-season-freeze-evidence.json',
      source: privateSeasonFile.source,
    },
    {
      fileName: 'preseason-scoring-certification.json',
      source: certificationFile.source,
    },
  ]);

  console.log(`Private-season freeze kit created: ${paths.directory}`);
  console.log(`Freeze record: ${paths.recordPath}`);
  console.log(`Rollback plan: ${paths.rollbackPath}`);
  console.log(`Incident guide: ${paths.incidentPath}`);
  console.log(`Launch checklist: ${paths.checklistPath}`);
  console.log('Review the kit, then create the annotated tag on the deployed source commit:');
  console.log(
    `git tag -a ${tag} ${live.manifest.sourceRevision} ` +
    `-m "RinkRat ${source.policy.seasonLabel} private-season baseline"`,
  );
  console.log(`git push origin ${tag}`);
  console.log(`npm run season:verify-tag -- --tag=${tag}`);
}

async function verifyTag(options) {
  const source = await inspectStaticSource();
  const { tag, record } = await readFreezeRecord(options, source);
  const result = await run('git', ['rev-list', '-n', '1', tag]);
  const tagCommit = result.stdout.trim();
  requireCondition(
    tagCommit === record.release.sourceRevision,
    `Tag ${tag} points to ${tagCommit || 'nothing'}, not the frozen deployed source ${record.release.sourceRevision}.`,
  );
  console.log(`Private-season tag verified: ${tag} -> ${tagCommit}.`);
}

async function verifyFreeze(options) {
  const source = await inspectStaticSource();
  await inspectRuntimeToolchain(source);
  const { tag, record } = await readFreezeRecord(options, source);
  const live = await fetchLiveRelease(source, options);
  requireCondition(
    live.manifest.buildId === record.release.buildId,
    'The live build ID no longer matches the frozen baseline.',
  );
  requireCondition(
    live.manifest.sourceRevision === record.release.sourceRevision,
    'The live source revision no longer matches the frozen baseline.',
  );
  await inspectTtl(source);
  await verifyTag(new Map([['tag', tag]]));
  console.log(
    `Private-season freeze verified: ${record.release.releaseLabel} ` +
    `${record.release.buildId} remains live and ${tag} points to ` +
    `${record.release.sourceRevision.slice(0, 12)}.`,
  );
}

async function refreshKit(options, fileName) {
  const source = await inspectStaticSource();
  const { directory, record } = await readFreezeRecord(options, source);
  const formats = {
    'ROLLBACK.md': formatSeasonRollbackPlan(record, source.deploymentPolicy),
    'INCIDENT_FIRST_15_MINUTES.md': formatSeasonIncidentGuide(
      record,
      source.deploymentPolicy,
    ),
    'SEASON_LAUNCH_CHECKLIST.md': formatSeasonLaunchChecklist(record),
  };
  const selected = fileName ? [fileName] : Object.keys(formats);
  for (const name of selected) {
    await writeFile(path.join(directory, name), formats[name], 'utf8');
    console.log(`Season kit file refreshed: ${path.join(directory, name)}`);
  }
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
    await refreshKit(options, 'ROLLBACK.md');
  } else if (command === 'incident-kit') {
    await refreshKit(options);
  } else {
    throw new Error(`Unknown private-season release command: ${command}`);
  }
} catch (error) {
  console.error(
    `Private-season release check failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
