#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildFirebaseFunctionDeploySelectors,
  buildFirebaseFunctionsDeploymentAudit,
  collectExpectedFirebaseFunctionNames,
} from './firebase-functions-deployment-audit.util.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArguments(argv) {
  const options = new Map();
  for (const argument of argv) {
    if (!argument.startsWith('--')) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const equalsIndex = argument.indexOf('=');
    if (equalsIndex === -1) {
      options.set(argument.slice(2), true);
    } else {
      options.set(argument.slice(2, equalsIndex), argument.slice(equalsIndex + 1));
    }
  }
  return options;
}

async function resolveProjectId(options) {
  const explicit = options.get('project');
  if (typeof explicit === 'string' && explicit.trim()) {
    return explicit.trim();
  }

  const firebaseRc = JSON.parse(
    await readFile(path.join(projectRoot, '.firebaserc'), 'utf8'),
  );
  const projects = firebaseRc?.projects && typeof firebaseRc.projects === 'object'
    ? Object.values(firebaseRc.projects).filter(
        (value) => typeof value === 'string' && value.trim().length > 0,
      )
    : [];
  const projectId = typeof firebaseRc?.projects?.default === 'string'
    ? firebaseRc.projects.default
    : [...new Set(projects)].length === 1
      ? [...new Set(projects)][0]
      : null;
  if (typeof projectId !== 'string' || !projectId.trim()) {
    throw new Error('Pass --project=<firebase-project-id>; .firebaserc does not resolve one unambiguous project.');
  }
  return projectId.trim();
}

function extractJson(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    }
    throw new Error('Firebase CLI did not return readable JSON. Run firebase functions:list manually.');
  }
}

function printList(label, values) {
  console.log(`${label}: ${values.length}`);
  for (const value of values) {
    console.log(`  - ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
}

function runRemoteList(provider, projectId, expectedRegion) {
  if (provider === 'gcloud') {
    return extractJson(execFileSync(
      'gcloud',
      [
        'functions',
        'list',
        '--v2',
        `--regions=${expectedRegion}`,
        `--project=${projectId}`,
        '--format=json',
      ],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ));
  }

  return extractJson(execFileSync(
    'firebase',
    ['functions:list', '--project', projectId, '--json'],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const projectId = await resolveProjectId(options);
  const source = await readFile(
    path.join(projectRoot, 'functions/src/index.ts'),
    'utf8',
  );
  const expectedNames = collectExpectedFirebaseFunctionNames(source);
  const batchSize = Number.parseInt(String(options.get('batch-size') ?? '10'), 10);

  if (options.has('plan-all-only')) {
    console.log(`Expected local Firebase Functions: ${expectedNames.length}`);
    const selectors = buildFirebaseFunctionDeploySelectors(expectedNames, batchSize);
    selectors.forEach((selector, index) => {
      console.log(`Batch ${index + 1}/${selectors.length}:`);
      console.log(`firebase deploy --only "${selector}" --project ${projectId}`);
    });
    return;
  }

  const expectedRegion = String(options.get('expected-region') ?? 'us-central1');
  let remotePayload;
  let listingProvider = 'fixture';
  const remoteJsonPath = options.get('remote-json');
  if (typeof remoteJsonPath === 'string' && remoteJsonPath.trim()) {
    remotePayload = JSON.parse(await readFile(path.resolve(remoteJsonPath), 'utf8'));
  } else {
    const requestedProvider = String(options.get('provider') ?? 'auto');
    if (!['auto', 'firebase', 'gcloud'].includes(requestedProvider)) {
      throw new Error('--provider must be auto, firebase, or gcloud.');
    }

    const providers = requestedProvider === 'auto'
      ? ['gcloud', 'firebase']
      : [requestedProvider];
    const errors = [];

    for (const provider of providers) {
      try {
        remotePayload = runRemoteList(provider, projectId, expectedRegion);
        listingProvider = provider;
        break;
      } catch (error) {
        const stderr = error?.stderr?.toString?.().trim();
        errors.push(`${provider}: ${stderr || (error instanceof Error ? error.message : String(error))}`);
      }
    }

    if (!remotePayload) {
      throw new Error(`Unable to list deployed Functions.\n${errors.join('\n')}`);
    }
  }

  const report = buildFirebaseFunctionsDeploymentAudit({
    expectedNames,
    remotePayload,
    projectId,
    expectedRegion,
  });
  report.listingProvider = listingProvider;
  report.possibleFirebaseListTruncation =
    listingProvider === 'firebase' &&
    report.expectedCount >= 100 &&
    report.deployedCount < report.expectedCount;

  console.log('RinkRat Firebase Functions deployment audit');
  console.log(`Project: ${projectId}`);
  console.log(`Listing provider: ${report.listingProvider}`);
  console.log(`Expected local exports: ${report.expectedCount}`);
  console.log(`Deployed project functions: ${report.deployedCount}`);
  console.log(`Matched functions: ${report.matchedCount}`);
  printList('Missing functions', report.missing);
  printList('Unexpected deployed functions', report.unexpected);
  printList('Region mismatches', report.regionMismatches);
  printList('Duplicate deployed names', report.duplicateRemoteNames);
  printList('Ignored extension functions', report.ignoredRemoteFunctions);

  if (report.possibleFirebaseListTruncation) {
    console.log('\nWarning: the Firebase CLI listing may be incomplete for a 100+ Function project.');
    console.log(`Confirm with: gcloud functions list --v2 --regions=${expectedRegion} --project=${projectId} --format=json`);
  }

  if (report.missing.length > 0) {
    console.log('\nQuota-safe selectors for missing Functions:');
    buildFirebaseFunctionDeploySelectors(report.missing, batchSize)
      .forEach((selector, index) => {
        console.log(`  Batch ${index + 1}: firebase deploy --only "${selector}" --project ${projectId}`);
      });
  }

  const reportPath = options.get('write-report');
  if (typeof reportPath === 'string' && reportPath.trim()) {
    const absolutePath = path.resolve(reportPath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`\nSaved report: ${absolutePath}`);
  }

  console.log(`\nResult: ${report.ready ? 'READY — local and deployed Function inventories match.' : 'ATTENTION — review the differences above.'}`);
  if (!report.ready) {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
