#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  D1NC_STAGING_PROJECT_ID,
  evaluateRampEvidence,
} from './d1n-c-load-preflight.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REVISION_PATTERN = /^[a-f0-9]{40}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
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
    requireCondition(next && !next.startsWith('--'), `${argument} requires a value.`);
    options.set(raw, next);
    index += 1;
  }
  return options;
}

function optionString(options, key) {
  const value = options.get(key);
  return value === undefined ? '' : String(value).trim();
}

async function readJson(filePath, label) {
  requireCondition(filePath, `${label} path is required.`);
  return JSON.parse(await readFile(path.resolve(projectRoot, filePath), 'utf8'));
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validateCommonEvidence(record, aggregate, label) {
  const issues = [];
  if (record?.schemaVersion !== 1) issues.push(`${label} schema must equal 1`);
  if (record?.projectId !== D1NC_STAGING_PROJECT_ID) issues.push(`${label} project mismatch`);
  if (!REVISION_PATTERN.test(String(record?.sourceRevision ?? ''))) {
    issues.push(`${label} source revision is invalid`);
  } else if (record.sourceRevision !== aggregate.sourceRevision) {
    issues.push(`${label} source revision mismatch`);
  }
  if (!FINGERPRINT_PATTERN.test(String(record?.runFingerprint ?? ''))) {
    issues.push(`${label} run fingerprint is invalid`);
  } else if (record.runFingerprint !== aggregate.runFingerprint) {
    issues.push(`${label} run fingerprint mismatch`);
  }
  if (!validTimestamp(record?.windowStart) || !validTimestamp(record?.windowEnd)) {
    issues.push(`${label} requires a valid measurement window`);
  } else if (Date.parse(record.windowStart) >= Date.parse(record.windowEnd)) {
    issues.push(`${label} measurement window is invalid`);
  }
  if (
    validTimestamp(record?.windowStart)
    && validTimestamp(aggregate?.cost?.windowStart)
    && Date.parse(record.windowStart) > Date.parse(aggregate.cost.windowStart)
  ) {
    issues.push(`${label} starts after the load run began`);
  }
  if (
    validTimestamp(record?.windowEnd)
    && validTimestamp(aggregate?.cost?.windowEnd)
    && Date.parse(record.windowEnd) < Date.parse(aggregate.cost.windowEnd)
  ) {
    issues.push(`${label} ends before the load run completed`);
  }
  return issues;
}

export function finalizeD1ncLoadEvidence(aggregate, usage, cost) {
  const issues = [];
  if (aggregate?.schemaVersion !== 1) issues.push('aggregate schema must equal 1');
  if (aggregate?.projectId !== D1NC_STAGING_PROJECT_ID) issues.push('aggregate project mismatch');
  if (aggregate?.evidenceStatus !== 'awaiting-external-usage-and-cost') {
    issues.push('aggregate evidence is not awaiting external measurements');
  }
  issues.push(...validateCommonEvidence(usage, aggregate, 'usage evidence'));
  issues.push(...validateCommonEvidence(cost, aggregate, 'cost evidence'));
  if (usage?.measurementSource !== 'cloud-monitoring') {
    issues.push('usage evidence must come from Cloud Monitoring');
  }
  if (!validTimestamp(usage?.observedAt)) {
    issues.push('usage evidence observation timestamp is invalid');
  } else if (
    validTimestamp(usage?.windowEnd)
    && Date.parse(usage.observedAt) < Date.parse(usage.windowEnd)
  ) {
    issues.push('usage evidence was observed before its measurement window ended');
  }
  for (const key of ['reads', 'writes', 'terminalAbortedOperations']) {
    if (!Number.isFinite(usage?.[key]) || usage[key] < 0) {
      issues.push(`usage evidence ${key} is invalid`);
    }
  }
  if (usage?.reads === 0 || usage?.writes === 0) {
    issues.push('usage evidence must show Firestore activity');
  }
  if (cost?.measurementSource !== 'cloud-billing-export') {
    issues.push('cost evidence must come from Cloud Billing export');
  }
  if (cost?.settled !== true) issues.push('cost evidence is not settled');
  if (cost?.currency !== 'USD') issues.push('cost evidence currency must be USD');
  if (!Number.isFinite(cost?.incrementalUsd) || cost.incrementalUsd < 0) {
    issues.push('incremental billed cost is invalid');
  }
  if (!validTimestamp(cost?.settledAt) || Date.parse(cost.settledAt) < Date.parse(cost?.windowEnd)) {
    issues.push('cost settlement timestamp is invalid');
  }
  requireCondition(issues.length === 0, `D1N-C evidence finalization refused:\n- ${issues.join('\n- ')}`);

  const finalEvidence = {
    ...aggregate,
    evidenceStatus: 'ready-for-independent-review',
    firestore: {
      measurementSource: 'cloud-monitoring',
      reads: usage.reads,
      writes: usage.writes,
      terminalAbortedOperations: usage.terminalAbortedOperations,
      windowStart: usage.windowStart,
      windowEnd: usage.windowEnd,
      observedAt: usage.observedAt,
    },
    cost: {
      measurementSource: 'cloud-billing-export',
      incrementalUsd: cost.incrementalUsd,
      currency: 'USD',
      settled: true,
      windowStart: cost.windowStart,
      windowEnd: cost.windowEnd,
      settledAt: cost.settledAt,
    },
  };
  const evaluation = evaluateRampEvidence(finalEvidence);
  requireCondition(
    evaluation.ready,
    `D1N-C stage ${aggregate.stage} failed its fixed gate:\n- ${evaluation.issues.join('\n- ')}`,
  );
  return finalEvidence;
}

function requirePrivateOutputPath(outputPath) {
  requireCondition(path.isAbsolute(outputPath), 'Final evidence output must be an absolute path.');
  const relative = path.relative(projectRoot, outputPath);
  requireCondition(
    relative.startsWith('..') && !path.isAbsolute(relative),
    'Final evidence output must stay outside the Git worktree.',
  );
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const aggregate = await readJson(optionString(options, 'aggregate'), 'Aggregate evidence');
  const usage = await readJson(optionString(options, 'usage'), 'Cloud Monitoring evidence');
  const cost = await readJson(optionString(options, 'cost'), 'Cloud Billing evidence');
  const outputPath = optionString(options, 'output');
  requirePrivateOutputPath(outputPath);
  const finalEvidence = finalizeD1ncLoadEvidence(aggregate, usage, cost);
  await writeFile(outputPath, `${JSON.stringify(finalEvidence, null, 2)}\n`, { flag: 'wx' });
  console.log(`D1N-C stage ${finalEvidence.stage} evidence passed every fixed gate.`);
  console.log(`Source revision: ${finalEvidence.sourceRevision}`);
  console.log(`Final aggregate evidence: ${outputPath}`);
  console.log('The result is ready for independent review; no Firebase resource was modified.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
