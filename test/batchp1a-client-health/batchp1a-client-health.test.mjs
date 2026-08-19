import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';

import {
  buildClientVitalsParameters,
  classifyClientViewport,
  estimateInpFromInteractions,
} from '../../src/app/core/observability/client-performance.util.ts';
import {
  getFirestoreListenerSnapshot,
  monitorFirestoreListener,
  resetFirestoreListenerMonitorForTests,
} from '../../src/app/core/observability/firestore-listener-monitor.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

async function sha256(relativePath) {
  return createHash('sha256').update(await read(relativePath)).digest('hex');
}

test('mobile Game Center rows navigate directly to the full Game Film route', async () => {
  const [source, template, styles] = await Promise.all([
    read('src/app/features/cycles/cycle-one/components/cycle-mobile-head-to-head/cycle-mobile-head-to-head.ts'),
    read('src/app/features/cycles/cycle-one/components/cycle-mobile-head-to-head/cycle-mobile-head-to-head.html'),
    read('src/app/features/cycles/cycle-one/components/cycle-mobile-head-to-head/cycle-mobile-head-to-head.css'),
  ]);

  assert.match(source, /openActiveDetail\(pick: DraftPick\)[\s\S]*openAssetDetail\(pick\.asset\)/);
  assert.match(source, /openBenchDetail\([\s\S]*openBenchAssetDetail\(asset\)/);
  assert.doesNotMatch(source, /selectedDetail|DialogFocusTrapDirective|ViewportOverlayPortalDirective/);
  assert.doesNotMatch(template, /mobile-asset-sheet|Open full scoring breakdown|Why each game counts/);
  assert.doesNotMatch(styles, /mobile-asset-sheet/);
  assert.match(template, /\(click\)="openActiveDetail\(pick\)"/);
});

test('client health metrics use stable viewport and interaction calculations', () => {
  assert.equal(classifyClientViewport(320), 'phone');
  assert.equal(classifyClientViewport(780), 'phone');
  assert.equal(classifyClientViewport(900), 'tablet');
  assert.equal(classifyClientViewport(1440), 'desktop');

  const interactions = new Map([
    [1, 80],
    [2, 140],
    [3, 220],
    [4, 95],
  ]);
  assert.equal(estimateInpFromInteractions(interactions), 220);
  assert.equal(estimateInpFromInteractions(new Map()), null);

  const payload = buildClientVitalsParameters({
    firstContentfulPaintMilliseconds: 812.4,
    largestContentfulPaintMilliseconds: 1_483.6,
    cumulativeLayoutShift: 0.0874,
    interactionToNextPaintMilliseconds: 184.2,
    longTaskCount: 3,
    longestTaskMilliseconds: 92.8,
    latestRouteReadyMilliseconds: 240.2,
    slowestRouteReadyMilliseconds: 701.8,
  }, 390, '4g', false, true);

  assert.deepEqual(payload, {
    viewport: 'phone',
    online: true,
    connection_type: '4g',
    save_data: false,
    fcp_ms: 812,
    lcp_ms: 1484,
    cls_milli: 87,
    inp_ms: 184,
    long_task_count: 3,
    longest_task_ms: 93,
    latest_route_ms: 240,
    slowest_route_ms: 702,
  });
});

test('Firestore listener monitor counts labels and unsubscribes exactly once', () => {
  resetFirestoreListenerMonitorForTests();
  let firstUnsubscribeCount = 0;
  let secondUnsubscribeCount = 0;

  const stopFirst = monitorFirestoreListener('cycle:matchups', () => () => {
    firstUnsubscribeCount += 1;
  });
  const stopSecond = monitorFirestoreListener('cycle:matchups', () => () => {
    secondUnsubscribeCount += 1;
  });

  assert.equal(getFirestoreListenerSnapshot().total, 2);
  assert.equal(getFirestoreListenerSnapshot().byLabel['cycle:matchups'], 2);

  stopFirst();
  stopFirst();
  assert.equal(firstUnsubscribeCount, 1);
  assert.equal(getFirestoreListenerSnapshot().total, 1);

  stopSecond();
  assert.equal(secondUnsubscribeCount, 1);
  assert.equal(getFirestoreListenerSnapshot().total, 0);
});

test('all core Firestore streams register with the development listener monitor', async () => {
  const files = [
    'src/app/core/team/team.service.ts',
    'src/app/core/team/roster.service.ts',
    'src/app/core/replay/historical-replay.service.ts',
    'src/app/core/player/player-availability-sync.service.ts',
    'src/app/core/player/player-availability.service.ts',
    'src/app/core/draft/draft.service.ts',
    'src/app/core/cycle/asset-cycle-window.service.ts',
    'src/app/core/cycle/cycle.service.ts',
    'src/app/core/live-scoring/live-scoring.service.ts',
    'src/app/core/playoffs/playoff.service.ts',
  ];

  let monitoredCount = 0;

  for (const file of files) {
    const source = await read(file);
    const monitors = source.match(/monitorFirestoreListener\('/g) ?? [];
    const snapshots = source.match(/(?<![A-Za-z0-9_])onSnapshot\(/g) ?? [];
    monitoredCount += monitors.length;
    assert.equal(monitors.length, snapshots.length, `${file} has an unmonitored onSnapshot stream.`);
  }

  assert.equal(monitoredCount, 21);

  const [globalAvailability, manualAvailability] = await Promise.all([
    read('src/app/core/player/player-availability-sync.service.ts'),
    read('src/app/core/player/player-availability.service.ts'),
  ]);
  assert.match(globalAvailability, /const stopFailedListener = stopGlobalListener;[\s\S]*stopFailedListener\?\.\(\)/);
  assert.match(manualAvailability, /const stopFailedListener = stopDatabaseListener;[\s\S]*stopFailedListener\?\.\(\)/);
});

test('global connection safety and performance telemetry are active without blocking page content', async () => {
  const [layoutSource, layoutTemplate, layoutStyles, appSource, performanceSource] = await Promise.all([
    read('src/app/layouts/main-layout/main-layout.ts'),
    read('src/app/layouts/main-layout/main-layout.html'),
    read('src/app/layouts/main-layout/main-layout.css'),
    read('src/app/app.ts'),
    read('src/app/core/observability/client-performance-monitor.service.ts'),
  ]);

  assert.match(layoutSource, /ClientHealthService/);
  assert.match(layoutTemplate, /clientHealth\.connectionNotice\(\)/);
  assert.match(layoutTemplate, /Scores may be stale|notice\.detail/);
  assert.match(layoutTemplate, /global-team-ribbon-paused/);
  assert.match(layoutStyles, /bottom:\s*calc\(86px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(layoutStyles, /animation-play-state:\s*paused/);
  assert.match(appSource, /performanceMonitor\.start\(router\)/);
  assert.match(performanceSource, /largest-contentful-paint/);
  assert.match(performanceSource, /layout-shift/);
  assert.match(performanceSource, /client_vitals/);
  assert.match(performanceSource, /route_ready/);
  assert.match(performanceSource, /__RINKRAT_CLIENT_HEALTH__/);
});

test('release readiness exposes a browser-only client health report', async () => {
  const [source, template, styles] = await Promise.all([
    read('src/app/features/release/release-readiness/release-readiness.ts'),
    read('src/app/features/release/release-readiness/release-readiness.html'),
    read('src/app/features/release/release-readiness/release-readiness.css'),
  ]);

  assert.match(source, /ClientPerformanceMonitorService/);
  assert.match(source, /copyClientHealthReport/);
  assert.match(source, /setInterval\(\(\) => this\.refreshClientHealth\(\), 2_500\)/);
  assert.match(template, /Client health and performance/);
  assert.match(template, /Active listeners/);
  assert.match(template, /Largest paint/);
  assert.match(template, /Interaction latency/);
  assert.match(template, /View active Firestore listener groups/);
  assert.match(styles, /\.client-health-grid/);
  assert.match(styles, /grid-template-columns:\s*repeat\(3/);
});

test('P1A foundations continue to preserve competitive scoring, projections, rules, and indexes', async () => {
  const expectedHashes = new Map([
    ['src/app/core/scoring/scoring-rules.ts', '74107aa688b4a3825c52fe14003cd824485197fd3559822fab4134bff940e2da'],
    ['src/app/core/scoring/scoring-engine.ts', '6f36cf76c72f8199c6a3891692844c9c830103ed618be50497b5270e259da3d3'],
    ['src/app/core/projection/projection-v11.util.ts', 'e6f3111b1feccc7107e857aa24c5317451c65a84a36c71f8158947636f20d80a'],
    ['firestore.rules', PROTECTED_SOURCE_HASHES.firestoreRules],
    ['firestore.indexes.json', '62f09a69e4e487eb9bfa1935e874d32a07e8fa0cddba48205903d62e19261a13'],
  ]);

  for (const [file, expected] of expectedHashes) {
    assert.equal(await sha256(file), expected, `${file} changed unexpectedly.`);
  }
});

test('P1A verification and consolidated documentation remain available', async () => {
  const [packageSource, documentation] = await Promise.all([
    read('package.json'),
    read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.equal(
    packageJson.scripts['test:batchp1a:run'],
    'node --no-warnings --experimental-strip-types --test --test-concurrency=1 test/batchp1a-client-health/*.test.mjs',
  );
  assert.match(packageJson.scripts['verify:batchp1a'], /verify:batchm5-3/);
  assert.match(packageJson.scripts['verify:batchp1a'], /test:batchp1a:run/);
  assert.match(documentation, /^## Batch P1A — Direct Mobile Game Film and Client Health/m);
  assert.match(documentation, /Hosting-only|changes only the browser application/i);
  assert.match(documentation, /window\.__RINKRAT_CLIENT_HEALTH__\.print\(\)/);
});
