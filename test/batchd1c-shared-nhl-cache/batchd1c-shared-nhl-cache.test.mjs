import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  NHL_SHARED_CACHE_MAX_PAYLOAD_BYTES,
  getNhlSharedCacheDescriptor,
  getNhlSharedCacheRoutePolicy,
  normalizeNhlSharedCacheUrl,
  serializeNhlSharedCachePayload,
} from '../../functions/src/shared/core/nhl/nhl-shared-cache.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

test('shared NHL cache keys are deterministic after canonical query ordering', () => {
  const first = getNhlSharedCacheDescriptor(
    'https://api.nhle.com/stats/rest/en/skater/summary?sort=points&limit=50&start=0',
  );
  const second = getNhlSharedCacheDescriptor(
    'https://api.nhle.com/stats/rest/en/skater/summary?start=0&limit=50&sort=points',
  );

  assert.ok(first);
  assert.ok(second);
  assert.equal(first.cacheKey, second.cacheKey);
  assert.equal(first.routeClass, 'stats');
  assert.equal(first.canonicalPath, '/stats/rest/en/skater/summary');
  assert.match(first.cacheKey, /^[a-f0-9]{64}$/);
  assert.match(first.canonicalQueryHash, /^[a-f0-9]{64}$/);
});

test('only approved public NHL and ESPN data routes are eligible for shared observation', () => {
  const routes = new Map([
    ['https://api-web.nhle.com/v1/club-schedule-season/vgk/20262027', 'schedule'],
    ['https://api-web.nhle.com/v1/gamecenter/2026020001/boxscore', 'game-boxscore'],
    ['https://api-web.nhle.com/v1/gamecenter/2026020001/play-by-play', 'game-play-by-play'],
    ['https://api-web.nhle.com/v1/player/8478402/game-log/20262027/2', 'player-log'],
    ['https://api-web.nhle.com/v1/roster/vgk/current', 'roster'],
    ['https://api-web.nhle.com/v1/score/now', 'scoreboard'],
    ['https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries', 'injuries'],
  ]);

  for (const [url, expected] of routes) {
    assert.equal(getNhlSharedCacheDescriptor(url)?.routeClass, expected);
  }

  assert.equal(getNhlSharedCacheDescriptor('https://evil.example/v1/score/now'), null);
  assert.equal(getNhlSharedCacheDescriptor('https://api-web.nhle.com/v1/arbitrary'), null);
  assert.equal(normalizeNhlSharedCacheUrl('not a URL'), null);
});

test('payload serialization is stable, JSON-only, and bounded below the Firestore document ceiling', () => {
  const first = serializeNhlSharedCachePayload({ games: [{ id: 1, state: 'FINAL' }] });
  const second = serializeNhlSharedCachePayload('{"games":[{"id":1,"state":"FINAL"}]}');

  assert.ok(first);
  assert.ok(second);
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.bytes, second.bytes);
  assert.equal(serializeNhlSharedCachePayload('{not json'), null);
  assert.equal(NHL_SHARED_CACHE_MAX_PAYLOAD_BYTES, 700 * 1024);
  assert.equal(getNhlSharedCacheRoutePolicy('game-boxscore').retentionMilliseconds, 30 * 24 * 60 * 60 * 1000);
});

test('the Functions observer is deterministic, deduplicated, best effort, and never authoritative in Shadow', async () => {
  const [source, api, functionsIndex, rosterMoves] = await Promise.all([
    read('functions/src/shared/core/nhl/nhl-shared-cache.service.ts'),
    read('functions/src/shared/core/nhl/nhl-api.service.ts'),
    read('functions/src/index.ts'),
    read('functions/src/roster-moves.ts'),
  ]);

  assert.match(source, /NHL_SHARED_CACHE_MODE = 'shadow'/);
  assert.match(source, /NHL_SHARED_CACHE_AUTHORITATIVE_READS_ENABLED = false/);
  assert.match(source, /eligibleForAuthoritativeRead: false/);
  assert.match(source, /db\.runTransaction/);
  assert.match(source, /unchanged-suppressed/);
  assert.match(source, /pendingObservationKeys/);
  assert.match(source, /NHL_SHARED_CACHE_MAX_IN_FLIGHT_OBSERVATIONS/);
  assert.match(source, /expiresAt: Timestamp\.fromMillis/);
  assert.match(source, /contentHash: serialized\.contentHash/);
  assert.match(source, /A cache write can never fail or delay|can never fail or delay/i);
  assert.match(api, /queueNhlSharedCacheObservation/);
  assert.match(api, /source: 'functions-core'/);
  assert.match(api, /return value/);
  assert.match(functionsIndex, /payload: upstreamBody[\s\S]*source: 'public-proxy'/);
  assert.match(functionsIndex, /queueNhlSharedCacheObservation\(\{[\s\S]*url,[\s\S]*source: 'functions-core'/);
  assert.match(functionsIndex, /getApps\(\)\.length === 0/);
  assert.match(rosterMoves, /club-schedule-season[\s\S]*queueNhlSharedCacheObservation/);
});

test('source-controlled policy forbids automatic cutover and documents every supported route', async () => {
  const policy = JSON.parse(await read('config/nhl-shared-cache-policy.json'));
  const routeClasses = Object.keys(policy.routePolicies).sort();

  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.mode, 'shadow');
  assert.equal(policy.authoritativeReadsEnabled, false);
  assert.equal(policy.maximumPayloadBytes, 700 * 1024);
  assert.equal(policy.cutoverRules.automaticPromotion, false);
  assert.equal(policy.cutoverRules.shadowWritesAreAuthoritative, false);
  assert.equal(policy.cutoverRules.requiresStagingBeforePrimary, true);
  assert.deepEqual(routeClasses, [
    'game-boxscore',
    'game-play-by-play',
    'injuries',
    'player-log',
    'roster',
    'schedule',
    'scoreboard',
    'stats',
  ]);
});

test('shared NHL cache data has TTL plus a scheduled cleanup fallback', async () => {
  const [ttlSource, retentionSource, cleanup, indexesSource] = await Promise.all([
    read('config/firestore-ttl-baseline.json'),
    read('config/security-retention-policy.json'),
    read('functions/src/security-operations.ts'),
    read('firestore.indexes.json'),
  ]);
  const ttl = JSON.parse(ttlSource);
  const retention = JSON.parse(retentionSource);
  const indexes = JSON.parse(indexesSource);

  assert.equal(ttl.policies.length, 10);
  assert.equal(retention.collections.length, 10);
  assert.ok(ttl.policies.some((entry) => entry.collectionGroup === 'nhlSharedDataCache'));
  assert.ok(retention.collections.some((entry) => entry.collection === 'nhlSharedDataCache'));
  assert.match(cleanup, /collection: 'nhlSharedDataCache'/);
  assert.ok(indexes.fieldOverrides.some(
    (entry) => entry.collectionGroup === 'nhlSharedDataCache' && entry.fieldPath === 'expiresAt' && entry.ttl === true,
  ));
});

test('D1C audit and retention controls remain synchronized under the later C1A client release', async () => {
  const [packageSource, freezeSource, runtime, productionRuntime] = await Promise.all([
    read('package.json'),
    read('config/release-freeze/beta-freeze-policy.json'),
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
  ]);
  const packageJson = JSON.parse(packageSource);
  const freeze = JSON.parse(freezeSource);

  assert.equal(packageJson.scripts['data:audit-nhl-shared-cache'], 'node scripts/data/audit-nhl-shared-cache.mjs');
  assert.equal(packageJson.scripts['data:inspect-nhl-shared-cache'], 'node functions/scripts/nhl-shared-cache-inspect.cjs');
  assert.match(packageJson.scripts['verify:batchd1c:core'], /verify:batchd1b:core/);
  assert.match(packageJson.scripts['verify:batchd1c:core'], /data:audit-nhl-shared-cache/);
  assert.match(packageJson.scripts['security:ci'], /verify:batchc1l:core/);
  assert.equal(freeze.requiredTtlPolicyCount, 10);
  assert.equal(freeze.verificationCommand, 'npm run verify:batchc1l');
  assert.equal(freeze.releaseLabel, 'Release Candidate 38');
  assert.match(runtime, /Release Candidate 38/);
  assert.match(productionRuntime, /Release Candidate 38/);

  const auditOutput = execFileSync(
    process.execPath,
    ['scripts/data/audit-nhl-shared-cache.mjs'],
    { cwd: new URL('.', ROOT), encoding: 'utf8' },
  );
  assert.match(auditOutput, /Shared NHL cache audit passed/);
});

test('D1C documentation and roadmap record a Shadow foundation rather than claiming capacity cutover', async () => {
  const [roadmap, docsRoadmap, runbook, readme, scoringRules, projectionSnapshot] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_DATA_D1C_SHARED_NHL_CACHE_SHADOW.md'),
    read('README.md'),
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/projection/projection-snapshot.service.ts'),
  ]);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.29/);
  assert.match(roadmap, /# \[x\] S3\.24/);
  assert.match(roadmap, /# \[x\] D1\.19/);
  assert.match(roadmap, /# \[x\] LOG\.29/);
  assert.match(roadmap, /\[~\] S3\.14/);
  assert.match(roadmap, /\[~\] D1\.8/);
  assert.match(runbook, /Shadow/i);
  assert.match(runbook, /not authoritative/i);
  assert.match(runbook, /oversized/i);
  assert.match(readme, /Data Infrastructure Batch D1C/);
  assert.match(scoringRules, /CURRENT_SCORING_RULES_VERSION\s*=\s*3/);
  assert.match(projectionSnapshot, /SHARED_PROJECTION_VERSION\s*=\s*11/);
});
