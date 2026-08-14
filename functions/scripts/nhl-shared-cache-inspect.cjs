#!/usr/bin/env node

const process = require('node:process');
const { applicationDefault, getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

const projectArgument = process.argv.find((value) => value.startsWith('--project='));
const projectId = (
  projectArgument?.slice('--project='.length) ||
  process.env.GCLOUD_PROJECT ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCP_PROJECT ||
  ''
).trim();

if (!projectId) {
  console.error('Provide --project=YOUR_FIREBASE_PROJECT_ID before inspecting the shared NHL cache.');
  process.exit(1);
}

if (getApps().length === 0) {
  initializeApp({ credential: applicationDefault(), projectId });
}

function dateLabel(value) {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value && typeof value.toDate === 'function') return value.toDate().toISOString();
  return 'Not recorded';
}

function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

async function main() {
  const db = getFirestore();
  const [healthSnapshot, cacheSnapshot] = await Promise.all([
    db.doc('appData/nhlSharedDataCacheHealth').get(),
    db.collection('nhlSharedDataCache').orderBy('lastObservedAt', 'desc').limit(200).get(),
  ]);
  const health = healthSnapshot.data() || {};
  const routeCounts = new Map();
  let totalBytes = 0;
  let authoritativeCount = 0;
  let expiredCount = 0;
  const now = Date.now();

  for (const document of cacheSnapshot.docs) {
    const data = document.data();
    const routeClass = typeof data.routeClass === 'string' ? data.routeClass : 'unknown';
    routeCounts.set(routeClass, (routeCounts.get(routeClass) || 0) + 1);
    totalBytes += numberValue(data.payloadBytes);
    authoritativeCount += data.eligibleForAuthoritativeRead === true ? 1 : 0;
    const expiresAt = data.expiresAt;
    const expiresMs = expiresAt instanceof Timestamp
      ? expiresAt.toMillis()
      : typeof expiresAt?.toMillis === 'function'
        ? expiresAt.toMillis()
        : Number.POSITIVE_INFINITY;
    expiredCount += expiresMs <= now ? 1 : 0;
  }

  console.log(`Shared NHL data cache for ${projectId}:`);
  console.log(`- Mode: ${health.mode || 'shadow (no health record yet)'}`);
  console.log(`- Authoritative reads: ${health.authoritativeReadsEnabled === true ? 'ENABLED' : 'DISABLED'}`);
  console.log(`- Sampled cache entries: ${cacheSnapshot.size}/200`);
  console.log(`- Sampled payload bytes: ${totalBytes}`);
  console.log(`- Entries incorrectly marked authoritative: ${authoritativeCount}`);
  console.log(`- Sampled entries awaiting TTL deletion: ${expiredCount}`);
  console.log(`- Last event: ${health.lastEvent || 'Not recorded'}`);
  console.log(`- Last observed: ${dateLabel(health.lastObservedAt)}`);
  console.log(`- Observations: ${numberValue(health.observationCount)}`);
  console.log(`- Stored: ${numberValue(health.storedCount)}`);
  console.log(`- Changed: ${numberValue(health.changedCount)}`);
  console.log(`- Unchanged suppressed: ${numberValue(health.unchangedSuppressedCount)}`);
  console.log(`- Oversized skipped: ${numberValue(health.oversizedSkippedCount)}`);
  console.log(`- Errors: ${numberValue(health.errorCount)}`);
  console.log('- Sampled route coverage:');

  if (routeCounts.size === 0) {
    console.log('  No shared entries have been observed yet. Run a projection, score refresh, or historical replay after deployment.');
  } else {
    for (const [routeClass, count] of [...routeCounts.entries()].sort()) {
      console.log(`  ${routeClass}: ${count}`);
    }
  }

  if (authoritativeCount > 0) {
    throw new Error('Shadow safety failed: one or more cache entries are marked authoritative.');
  }

  console.log('\nInspection only. No NHL cache, league, score, or production setting was changed.');
}

main().catch((error) => {
  console.error('Shared NHL cache inspection failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
