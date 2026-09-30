#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import {
  BROWSER_FIRESTORE_REACHABILITY_PROFILE,
  collectBlockingAdvisories,
  evaluateDependencyAuditPolicy,
} from './dependency-audit-policy.mjs';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const reportDirectory = path.join(projectRoot, '.security-reports');
const strict = process.argv.includes('--strict');
const reportOnly = process.argv.includes('--report-only');
const exceptionConfigPath = path.join(
  projectRoot,
  'config/security/dependency-advisory-exceptions.json',
);

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function sourceContainsAnyMarker(directory, markers) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (await sourceContainsAnyMarker(entryPath, markers)) return true;
      continue;
    }
    if (!entry.isFile() || !/\.(?:js|mjs|cjs|ts)$/.test(entry.name)) continue;
    const source = await readFile(entryPath, 'utf8');
    if (markers.some((marker) => source.includes(marker))) return true;
  }
  return false;
}

async function collectReachabilityEvidence() {
  const [angular, firebase, firestorePackage] = await Promise.all([
    readJson(path.join(projectRoot, 'angular.json')),
    readJson(path.join(projectRoot, 'firebase.json')),
    readJson(path.join(projectRoot, 'node_modules/@firebase/firestore/package.json')),
  ]);
  const angularProject = Object.values(angular?.projects ?? {})[0] ?? {};
  const architect = angularProject?.architect ?? {};
  const build = architect?.build ?? {};
  const buildOptions = build?.options ?? {};
  const hosting = Array.isArray(firebase?.hosting) ? firebase.hosting[0] : firebase?.hosting;
  const rewrites = Array.isArray(hosting?.rewrites) ? hosting.rewrites : [];
  const browserExport = firestorePackage?.exports?.['.']?.browser?.import;
  const nodeExport = firestorePackage?.exports?.['.']?.node?.import;
  const firestorePackageDirectory = path.join(projectRoot, 'node_modules/@firebase/firestore');
  const browserExportSource = typeof browserExport === 'string'
    ? await readFile(path.resolve(firestorePackageDirectory, browserExport), 'utf8')
    : '';
  const grpcServerMarkers = [
    '@grpc/grpc-js',
    'getAuthContext',
    'requireClientCertificate',
    'grpc-js-xds',
    'DownstreamTlsContext',
  ];

  return {
    [BROWSER_FIRESTORE_REACHABILITY_PROFILE]: {
      angularUsesBrowserApplicationBuilder:
        build?.builder === '@angular/build:application'
        && typeof buildOptions?.browser === 'string'
        && buildOptions.browser.length > 0,
      angularHasNoServerTarget: !Object.keys(architect).some((target) => (
        /^(?:server|ssr|prerender)$/i.test(target)
      )),
      angularHasNoServerBuildOptions:
        buildOptions.server === undefined
        && buildOptions.ssr === undefined
        && buildOptions.prerender === undefined,
      firebaseHostsStaticBrowserOutput:
        hosting?.public === 'dist/fantasy-hockey/browser'
        && rewrites.some((rewrite) => rewrite?.source === '**' && rewrite?.destination === '/index.html'),
      firestoreUsesSeparateBrowserExport:
        typeof browserExport === 'string'
        && typeof nodeExport === 'string'
        && browserExport !== nodeExport,
      firestoreBrowserExportExcludesGrpcServerApis:
        browserExportSource.length > 0
        && !grpcServerMarkers.some((marker) => browserExportSource.includes(marker)),
      applicationSourceExcludesGrpcServerApis: !(await sourceContainsAnyMarker(
        path.join(projectRoot, 'src'),
        grpcServerMarkers,
      )),
    },
  };
}

function runAudit(label, cwd) {
  const result = spawnSync(
    'npm',
    ['audit', '--omit=dev', '--json'],
    {
      cwd,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        npm_config_fund: 'false',
        npm_config_audit_level: 'none',
      },
    },
  );

  const output = result.stdout?.trim() || result.stderr?.trim() || '';
  let parsed = null;

  try {
    parsed = output ? JSON.parse(output) : null;
  } catch {
    parsed = null;
  }

  const vulnerabilities = parsed?.metadata?.vulnerabilities ?? null;
  const unavailable = !parsed || !vulnerabilities;
  const high = Number(vulnerabilities?.high ?? 0);
  const critical = Number(vulnerabilities?.critical ?? 0);
  const moderate = Number(vulnerabilities?.moderate ?? 0);
  const low = Number(vulnerabilities?.low ?? 0);
  const total = Number(vulnerabilities?.total ?? high + critical + moderate + low);

  return {
    label,
    cwd: path.relative(projectRoot, cwd) || '.',
    commandExitCode: result.status,
    unavailable,
    vulnerabilities: { low, moderate, high, critical, total },
    raw: parsed,
    diagnostic: unavailable
      ? output.slice(0, 2_000)
      : '',
  };
}

const reports = [
  runAudit('Angular client', projectRoot),
  runAudit('Cloud Functions', path.join(projectRoot, 'functions')),
];

let policy;
try {
  const [exceptionConfig, rootLock, reachabilityEvidence] = await Promise.all([
    readJson(exceptionConfigPath),
    readJson(path.join(projectRoot, 'package-lock.json')),
    collectReachabilityEvidence(),
  ]);
  policy = evaluateDependencyAuditPolicy({
    reports,
    exceptionConfig,
    rootLock,
    reachabilityEvidence,
  });
} catch (error) {
  const rawBlockers = collectBlockingAdvisories(reports);
  policy = {
    rawBlockers,
    blockers: rawBlockers,
    appliedExceptions: [],
    exceptionErrors: [{
      id: 'dependency-advisory-policy-load',
      errors: [error instanceof Error ? error.message : String(error)],
    }],
  };
}

await mkdir(reportDirectory, { recursive: true });
await writeFile(
  path.join(reportDirectory, 'dependency-audit.json'),
  `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    strict,
    reportOnly,
    reports,
    policy,
  }, null, 2)}\n`,
  'utf8',
);

let failed = false;

for (const report of reports) {
  if (report.unavailable) {
    const message = `${report.label}: npm advisory data was unavailable.`;
    if (strict && !reportOnly) {
      console.error(message);
      failed = true;
    } else {
      console.warn(`${message} The local audit is advisory; CI uses strict mode.`);
    }
    continue;
  }

  const { low, moderate, high, critical, total } = report.vulnerabilities;
  console.log(
    `${report.label}: ${total} production vulnerability finding(s) ` +
    `(critical ${critical}, high ${high}, moderate ${moderate}, low ${low}).`,
  );
}

for (const exception of policy.appliedExceptions) {
  console.warn(
    `${exception.surface.label}: approved exception ${exception.id} applies only to `
    + `${exception.ghsa} in ${exception.package}; expires ${exception.expiresAt}.`,
  );
}

for (const exceptionError of policy.exceptionErrors) {
  console.error(
    `Dependency advisory exception ${exceptionError.id} was rejected: `
    + exceptionError.errors.join('; '),
  );
}

for (const blocker of policy.blockers) {
  console.error(
    `${blocker.surface.label}: unexcepted ${blocker.severity} advisory `
    + `${blocker.ghsa || blocker.source} affects ${blocker.affectedPackages.join(', ')}.`,
  );
}

if (!reportOnly && (policy.blockers.length > 0 || policy.exceptionErrors.length > 0)) {
  failed = true;
}

if (failed) {
  console.error('Dependency security audit failed. Review .security-reports/dependency-audit.json.');
  process.exitCode = 1;
} else {
  console.log('Dependency security audit passed at the high/critical production threshold.');
}
