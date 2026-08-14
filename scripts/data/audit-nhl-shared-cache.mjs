#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const read = (relativePath) => readFile(path.join(root, relativePath), 'utf8');

const [
  policySource,
  cacheSource,
  cacheUtilSource,
  apiSource,
  functionsIndexSource,
  rosterMovesSource,
  ttlSource,
  retentionSource,
  cleanupSource,
] = await Promise.all([
  read('config/nhl-shared-cache-policy.json'),
  read('functions/src/shared/core/nhl/nhl-shared-cache.service.ts'),
  read('functions/src/shared/core/nhl/nhl-shared-cache.util.ts'),
  read('functions/src/shared/core/nhl/nhl-api.service.ts'),
  read('functions/src/index.ts'),
  read('functions/src/roster-moves.ts'),
  read('config/firestore-ttl-baseline.json'),
  read('config/security-retention-policy.json'),
  read('functions/src/security-operations.ts'),
]);

const policy = JSON.parse(policySource);
const ttl = JSON.parse(ttlSource);
const retention = JSON.parse(retentionSource);
const failures = [];
const requiredRouteClasses = [
  'schedule',
  'game-boxscore',
  'game-play-by-play',
  'player-log',
  'stats',
  'roster',
  'scoreboard',
  'injuries',
];

if (policy.schemaVersion !== 1) failures.push('The shared NHL cache policy must use schemaVersion 1.');
if (policy.mode !== 'shadow') failures.push('The initial shared NHL cache mode must remain shadow.');
if (policy.authoritativeReadsEnabled !== false) failures.push('Authoritative shared-cache reads must remain disabled in this batch.');
if (policy.cutoverRules?.automaticPromotion !== false) failures.push('Automatic shared-cache promotion must remain impossible.');
if (policy.maximumPayloadBytes !== 700 * 1024) failures.push('The Firestore payload ceiling must remain 700 KiB.');

for (const routeClass of requiredRouteClasses) {
  if (!policy.routePolicies?.[routeClass]) {
    failures.push(`The shared NHL cache policy is missing ${routeClass}.`);
  }
  if (!cacheUtilSource.includes(`'${routeClass}'`)) {
    failures.push(`The shared NHL cache implementation is missing ${routeClass}.`);
  }
}

for (const contract of [
  "NHL_SHARED_CACHE_MODE = 'shadow'",
  'NHL_SHARED_CACHE_AUTHORITATIVE_READS_ENABLED = false',
  'eligibleForAuthoritativeRead: false',
  'payloadHashValidationEnabled: true',
  'unchanged-suppressed',
  'oversized-skipped',
  'queue-capacity-skipped',
  'expiresAt:',
  'contentHash:',
  'canonicalQueryHash:',
  'runTransaction',
]) {
  if (!cacheSource.includes(contract)) failures.push(`The shared NHL cache source is missing: ${contract}`);
}

if (!apiSource.includes('queueNhlSharedCacheObservation')) {
  failures.push('Server-owned NHL fetches do not feed the shared Shadow cache.');
}
if (!apiSource.includes("source: 'functions-core'")) {
  failures.push('Server-owned NHL fetches do not identify their observation source.');
}
if (!functionsIndexSource.includes("source: 'public-proxy'")) {
  failures.push('The bounded public NHL proxy does not observe successful upstream payloads.');
}
if (!functionsIndexSource.includes('payload: upstreamBody')) {
  failures.push('The public proxy must observe the original upstream JSON rather than a compacted browser variant.');
}
if (!functionsIndexSource.includes('getApps().length === 0')) {
  failures.push('The main Functions entrypoint must preserve safe single-app initialization after importing the cache observer.');
}
if (!rosterMovesSource.includes('queueNhlSharedCacheObservation')) {
  failures.push('The direct roster-timing schedule fetch does not feed the shared Shadow cache.');
}
if (!ttl.policies.some((entry) => entry.collectionGroup === 'nhlSharedDataCache')) {
  failures.push('The shared NHL cache is missing its TTL field policy.');
}
if (!retention.collections.some((entry) => entry.collection === 'nhlSharedDataCache')) {
  failures.push('The shared NHL cache is missing its retention inventory entry.');
}
if (!cleanupSource.includes("collection: 'nhlSharedDataCache'")) {
  failures.push('The scheduled cleanup fallback does not include nhlSharedDataCache.');
}

if (failures.length > 0) {
  console.error('Shared NHL cache audit failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log(
    `Shared NHL cache audit passed: ${requiredRouteClasses.length} route classes, deterministic hashes, Shadow-only writes, bounded payloads, and TTL cleanup are present.`,
  );
}
