#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const baseline = JSON.parse(
  await readFile(path.join(projectRoot, 'config/firestore-ttl-baseline.json'), 'utf8'),
);
const operationsSource = await readFile(
  path.join(projectRoot, 'functions/src/security-operations.ts'),
  'utf8',
);
const leagueAutomationSource = await readFile(
  path.join(projectRoot, 'functions/src/league-automation.ts'),
  'utf8',
);
const indexSource = await readFile(
  path.join(projectRoot, 'functions/src/index.ts'),
  'utf8',
);
const projectionSource = await readFile(
  path.join(projectRoot, 'functions/src/projection-authority.ts'),
  'utf8',
);
const lifecycleSource = await readFile(
  path.join(projectRoot, 'functions/src/league-lifecycle-authority.ts'),
  'utf8',
);
const betaOperationsSource = await readFile(
  path.join(projectRoot, 'functions/src/beta-operations.ts'),
  'utf8',
);
const nhlSharedCacheSource = await readFile(
  path.join(projectRoot, 'functions/src/shared/core/nhl/nhl-shared-cache.service.ts'),
  'utf8',
);
const failures = [];

if (baseline.schemaVersion !== 1 || baseline.field !== 'expiresAt') {
  failures.push('The Firestore TTL baseline must use schemaVersion 1 and the expiresAt field.');
}

const policies = Array.isArray(baseline.policies) ? baseline.policies : [];
const expectedCollections = [
  'clientErrorReports',
  'feedbackReports',
  'projectionGenerationRequests',
  'leagueCreationRequests',
  'leagueJoinRequests',
  'cspViolationReports',
  'betaEvidenceEvents',
  'betaOperationsDaily',
  'nhlSharedDataCache',
  'leagueAutomationTasks',
];
const actualCollections = policies
  .map((entry) => String(entry.collectionGroup ?? ''))
  .filter(Boolean)
  .sort();

if (JSON.stringify(actualCollections) !== JSON.stringify([...expectedCollections].sort())) {
  failures.push(`TTL baseline collections differ from the approved set: ${actualCollections.join(', ')}`);
}

const sourceByCollection = new Map([
  ['clientErrorReports', indexSource],
  ['feedbackReports', indexSource],
  ['projectionGenerationRequests', projectionSource],
  ['leagueCreationRequests', lifecycleSource],
  ['leagueJoinRequests', lifecycleSource],
  ['cspViolationReports', operationsSource],
  ['betaEvidenceEvents', betaOperationsSource],
  ['betaOperationsDaily', leagueAutomationSource],
  ['nhlSharedDataCache', nhlSharedCacheSource],
  ['leagueAutomationTasks', leagueAutomationSource],
]);

for (const collection of expectedCollections) {
  const source = sourceByCollection.get(collection) ?? '';
  if (!source.includes(collection) || !source.includes('expiresAt')) {
    failures.push(`${collection} does not have a source-level expiresAt contract.`);
  }
}

for (const collection of expectedCollections.filter((name) => name !== 'leagueAutomationTasks')) {
  if (!operationsSource.includes(`collection: '${collection}'`)) {
    failures.push(`${collection} is not registered in cleanupExpiredSecurityData.`);
  }
}

for (const required of [
  'cleanupExpiredSecurityData',
  "schedule: '35 4 * * *'",
  "db.doc('appData/securityOperations')",
  'retentionCleanupStatus',
]) {
  if (!operationsSource.includes(required)) {
    failures.push(`Security retention worker is missing required contract: ${required}`);
  }
}

if (!leagueAutomationSource.includes('cleanupLeagueAutomationTaskHistory')) {
  failures.push('The dedicated leagueAutomationTasks cleanup owner is missing.');
}

if (failures.length > 0) {
  console.error('Security retention verification failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log(`Security retention verification passed (${policies.length} TTL policies plus scheduled cleanup fallback).`);
}
