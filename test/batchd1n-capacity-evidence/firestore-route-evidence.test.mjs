import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { buildFirestoreRouteEnvelopes } from '../../src/app/core/observability/firestore-route-evidence.util.ts';
import {
  beginFirestoreRouteObservation,
  completeFirestoreRouteObservation,
  getFirestoreListenerSnapshot,
  isClientHealthMonitorEnabled,
  markFirestoreListenersReconnecting,
  markFirestoreRouteNavigationSettled,
  monitorFirestoreListener,
  resetFirestoreListenerMonitorForTests,
} from '../../src/app/core/observability/firestore-listener-monitor.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function emptyEvidence(overrides = {}) {
  return {
    listenersOpened: 0,
    retryListenersOpened: 0,
    listenersClosed: 0,
    navigationCleanupCount: 0,
    listenerErrorCount: 0,
    closedListenerLifetimeMilliseconds: 0,
    maxClosedListenerLifetimeMilliseconds: 0,
    snapshotCount: 0,
    cacheSnapshotCount: 0,
    serverSnapshotCount: 0,
    unknownSourceSnapshotCount: 0,
    firstSnapshotCount: 0,
    firstSnapshotDocumentCount: 0,
    unknownDocumentCountSnapshots: 0,
    firstSnapshotFromCacheCount: 0,
    firstSnapshotFromServerCount: 0,
    firstSnapshotUnknownSourceCount: 0,
    cacheToServerTransitionCount: 0,
    reconnectSnapshotCount: 0,
    hiddenSnapshotCount: 0,
    pendingWriteSnapshotCount: 0,
    pendingWriteSnapshotCountByLabel: {},
    ...overrides,
  };
}

test('an explicit client-health flag remains active only for the current page lifetime', () => {
  const originalWindow = globalThis.window;

  try {
    const localStorage = {
      getItem: () => null,
    };
    globalThis.window = {
      location: {
        hostname: 'rinkrat-staging-d1nc-2026.web.app',
        search: '?rinkratHealth=1',
      },
      localStorage,
    };
    resetFirestoreListenerMonitorForTests();

    assert.equal(isClientHealthMonitorEnabled(), true);

    globalThis.window.location.search = '';
    assert.equal(
      isClientHealthMonitorEnabled(),
      true,
      'SPA navigation keeps diagnostics available for cleanup evidence',
    );

    resetFirestoreListenerMonitorForTests();
    assert.equal(
      isClientHealthMonitorEnabled(),
      false,
      'a new page lifetime without an explicit flag does not inherit diagnostics',
    );
  } finally {
    resetFirestoreListenerMonitorForTests();

    if (originalWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
  }
});

test('listener evidence distinguishes empty, cached, server, reconnect, retry, hidden, error, and cleanup states', () => {
  resetFirestoreListenerMonitorForTests();
  const routeToken = beginFirestoreRouteObservation('/redirecting-route', 1_000);
  let listenerObserver = null;
  let unsubscribeCount = 0;

  const stop = monitorFirestoreListener(
    'team:list',
    (observer) => {
      listenerObserver = observer;
      return () => {
        unsubscribeCount += 1;
      };
    },
    { startReason: 'retry' },
  );

  assert.ok(listenerObserver);
  listenerObserver.next({
    size: 0,
    metadata: { fromCache: true, hasPendingWrites: true },
  });
  listenerObserver.next(
    { size: 4, metadata: { fromCache: false, hasPendingWrites: false } },
    { visibility: 'hidden' },
  );
  markFirestoreListenersReconnecting();
  listenerObserver.next({
    exists: () => true,
    metadata: { fromCache: false, hasPendingWrites: false },
  });
  listenerObserver.error();
  listenerObserver.error();
  markFirestoreRouteNavigationSettled(routeToken, '/leagues/:leagueId/players');
  stop('navigation-away');
  stop('navigation-away');

  const route = completeFirestoreRouteObservation(routeToken, 'settled', 4_000);
  assert.ok(route);
  assert.equal(route.route, '/leagues/:leagueId/players');
  assert.equal(route.durationMilliseconds, 3_000);
  assert.equal(route.listenerCountStart, 0);
  assert.equal(route.peakListenerCount, 1);
  assert.equal(route.listenerCountEnd, 0);
  assert.equal(route.listenersOpened, 1);
  assert.equal(route.retryListenersOpened, 1);
  assert.equal(route.listenersClosed, 1);
  assert.equal(route.navigationCleanupCount, 1);
  assert.equal(route.listenerErrorCount, 1);
  assert.ok(route.closedListenerLifetimeMilliseconds >= 0);
  assert.ok(route.maxClosedListenerLifetimeMilliseconds >= 0);
  assert.equal(route.snapshotCount, 3);
  assert.equal(route.cacheSnapshotCount, 1);
  assert.equal(route.serverSnapshotCount, 2);
  assert.equal(route.firstSnapshotCount, 1);
  assert.equal(
    route.firstSnapshotDocumentCount,
    0,
    'an observed empty query remains a legitimate zero',
  );
  assert.equal(route.unknownDocumentCountSnapshots, 0);
  assert.equal(route.firstSnapshotFromCacheCount, 1);
  assert.equal(route.cacheToServerTransitionCount, 1);
  assert.equal(route.reconnectSnapshotCount, 1);
  assert.equal(route.hiddenSnapshotCount, 1);
  assert.equal(route.pendingWriteSnapshotCount, 1);
  assert.deepEqual(route.pendingWriteSnapshotCountByLabel, { 'team:list': 1 });
  assert.equal(route.awaitingFirstSnapshotCount, 0);
  assert.equal(unsubscribeCount, 1);

  let unknownObserver = null;
  const stopUnknown = monitorFirestoreListener('projection:unknown', (observer) => {
    unknownObserver = observer;
    return () => undefined;
  });
  assert.ok(unknownObserver);
  unknownObserver.next({ metadata: { fromCache: false } });
  stopUnknown();

  const session = getFirestoreListenerSnapshot().evidence;
  assert.equal(session.firstSnapshotCount, 2);
  assert.equal(session.firstSnapshotDocumentCount, 0);
  assert.equal(session.unknownDocumentCountSnapshots, 1);
  assert.deepEqual(session.pendingWriteSnapshotCountByLabel, { 'team:list': 1 });
});

test('pending-write evidence remains bounded, label-only, and immutable after capture', () => {
  resetFirestoreListenerMonitorForTests();
  const routeToken = beginFirestoreRouteObservation('/leagues/:leagueId/players', 1_000);
  const stops = [];

  for (let index = 0; index < 40; index += 1) {
    let observer = null;
    const stop = monitorFirestoreListener(`fixture:listener-${index}`, (nextObserver) => {
      observer = nextObserver;
      return () => undefined;
    });
    observer.next({
      size: 1,
      metadata: { fromCache: true, hasPendingWrites: true },
    });
    stops.push(stop);
  }

  const route = completeFirestoreRouteObservation(routeToken, 'settled', 2_000);
  assert.ok(route);
  assert.equal(route.pendingWriteSnapshotCount, 40);
  assert.equal(Object.keys(route.pendingWriteSnapshotCountByLabel).length, 32);
  assert.equal(route.pendingWriteSnapshotCountByLabel['other-listener'], 9);
  assert.equal(
    Object.values(route.pendingWriteSnapshotCountByLabel).reduce((total, count) => total + count, 0),
    40,
  );

  let laterObserver = null;
  const stopLater = monitorFirestoreListener('fixture:later', (observer) => {
    laterObserver = observer;
    return () => undefined;
  });
  laterObserver.next({
    exists: () => true,
    metadata: { fromCache: false, hasPendingWrites: true },
  });

  assert.equal(
    route.pendingWriteSnapshotCountByLabel['fixture:later'],
    undefined,
    'completed route evidence is not mutated by a later pending-write snapshot',
  );

  const session = getFirestoreListenerSnapshot().evidence;
  session.pendingWriteSnapshotCountByLabel['fixture:listener-0'] = 999;
  assert.equal(
    getFirestoreListenerSnapshot().evidence.pendingWriteSnapshotCountByLabel['fixture:listener-0'],
    1,
    'debug snapshots do not expose the mutable session evidence object',
  );

  stopLater();
  stops.forEach((stop) => stop());
});

test('route focus follows a replaced lazy-route heading without stealing manager focus', async () => {
  const layout = await read('src/app/layouts/main-layout/main-layout.ts');
  const layoutSpec = await read('src/app/layouts/main-layout/main-layout.spec.ts');

  assert.match(layout, /new MutationObserver/);
  assert.match(layout, /repairReplacedRouteFocus/);
  assert.match(layout, /activeElement !== focusedElement/);
  assert.match(layout, /stopRouteFocusStabilityWatch/);
  assert.match(layoutSpec, /stable route heading when a loading heading is replaced/);
  assert.match(layoutSpec, /does not steal focus after a manager reaches a route control/);
});

test('route envelopes calculate bounded nearest-rank p50, p95, and max values', () => {
  const observations = [
    [8, 12],
    [10, 20],
    [14, 35],
    [11, 24],
    [20, 80],
  ].map(([peakListenerCount, firstSnapshotDocumentCount], index) => ({
    route: '/leagues/:leagueId/draft',
    outcome: 'settled',
    durationMilliseconds: 3_000,
    listenerCountStart: 2,
    listenerCountEnd: peakListenerCount,
    peakListenerCount,
    awaitingFirstSnapshotCount: index === 4 ? 2 : 0,
    ...emptyEvidence({
      firstSnapshotDocumentCount,
      maxClosedListenerLifetimeMilliseconds: peakListenerCount * 100,
      navigationCleanupCount: index === 0 ? 2 : 0,
      reconnectSnapshotCount: index === 1 ? 1 : 0,
    }),
  }));

  const [envelope] = buildFirestoreRouteEnvelopes(observations);
  assert.equal(envelope.route, '/leagues/:leagueId/draft');
  assert.equal(envelope.sampleCount, 5);
  assert.deepEqual(envelope.peakListeners, { p50: 11, p95: 20, max: 20 });
  assert.deepEqual(envelope.firstSnapshotDocuments, { p50: 24, p95: 80, max: 80 });
  assert.deepEqual(envelope.maxClosedListenerLifetimeMilliseconds, {
    p50: 1_100,
    p95: 2_000,
    max: 2_000,
  });
  assert.equal(envelope.maxAwaitingFirstSnapshots, 2);
  assert.equal(envelope.navigationCleanupCount, 2);
  assert.equal(envelope.reconnectSnapshotCount, 1);
  assert.equal(envelope.pendingWriteSnapshotCount, 0);
});

test('all browser snapshot streams emit bounded metadata-only evidence', async () => {
  const sourceFiles = [
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
    'src/app/core/projection/projection-snapshot.service.ts',
    'src/app/core/league/league-activity.service.ts',
  ];

  let snapshotCount = 0;

  for (const sourceFile of sourceFiles) {
    const source = await read(sourceFile);
    const streams = source.match(/(?<![A-Za-z0-9_])onSnapshot\(/g) ?? [];
    const observations = source.match(/listenerObserver\.next\(/g) ?? [];
    const errors = source.match(/listenerObserver\.error\(/g) ?? [];
    snapshotCount += streams.length;
    assert.equal(observations.length, streams.length, `${sourceFile} omits snapshot evidence.`);
    assert.equal(errors.length, streams.length, `${sourceFile} omits listener-error evidence.`);
  }

  assert.equal(snapshotCount, 25);

  const [
    monitorSource,
    performanceSource,
    healthSource,
    availabilitySource,
    routesSource,
  ] = await Promise.all([
    read('src/app/core/observability/firestore-listener-monitor.ts'),
    read('src/app/core/observability/client-performance-monitor.service.ts'),
    read('src/app/core/observability/client-health.service.ts'),
    read('src/app/core/player/player-availability.service.ts'),
    read('src/app/app.routes.ts'),
  ]);

  assert.doesNotMatch(monitorSource, /snapshot\.data\(|snapshot\.docs/);
  assert.match(monitorSource, /snapshot\.size/);
  assert.match(monitorSource, /snapshot\.exists/);
  assert.match(monitorSource, /metadata\?\.fromCache/);
  assert.match(performanceSource, /MAX_FIRESTORE_ROUTE_SAMPLES_PER_SESSION = 24/);
  assert.match(performanceSource, /FIRESTORE_ROUTE_SETTLE_MILLISECONDS = 5_000/);
  assert.match(performanceSource, /telemetry\.sanitizedRoute\(event\.url\)/);
  assert.match(performanceSource, /markFirestoreRouteNavigationSettled\(token, this\.latestRoute\)/);
  assert.match(performanceSource, /firestore_route_evidence/);
  assert.match(performanceSource, /pending_write_snapshot: observation\.pendingWriteSnapshotCount/);
  assert.doesNotMatch(performanceSource, /pending_write_snapshot_by_label/);
  assert.match(performanceSource, /Firestore route evidence\./);
  assert.match(healthSource, /markFirestoreListenersReconnecting\(\)/);
  assert.match(availabilitySource, /manualListenerRetryKey === listenerKey/);
  assert.match(availabilitySource, /manualListenerRetryKey = listenerKey/);

  for (const route of [
    "path: 'leagues/:leagueId/players'",
    "path: 'leagues/:leagueId/draft'",
    "path: 'leagues/:leagueId/projections'",
    "path: 'leagues/:leagueId/cycles/:cycleNumber/matchups/:matchupId'",
    "path: 'leagues/:leagueId'",
  ]) {
    assert.match(routesSource, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
