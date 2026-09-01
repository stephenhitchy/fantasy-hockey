export type FirestoreListenerCloseReason = 'cleanup' | 'navigation-away';
export type FirestoreListenerStartReason = 'initial' | 'retry';
export type FirestoreListenerUnsubscribe = (reason?: FirestoreListenerCloseReason) => void;
export type FirestoreSnapshotSource = 'cache' | 'server' | 'unknown';

export interface FirestoreSnapshotLike {
  readonly size?: number;
  readonly metadata?: {
    readonly fromCache?: boolean;
    readonly hasPendingWrites?: boolean;
  };
  exists?: () => boolean;
}

export interface FirestoreSnapshotObservationContext {
  readonly reconnect?: boolean;
  readonly visibility?: 'visible' | 'hidden';
}

export interface FirestoreListenerObserver {
  next: (snapshot: FirestoreSnapshotLike, context?: FirestoreSnapshotObservationContext) => void;
  error: () => void;
}

export interface FirestoreListenerEvidence {
  listenersOpened: number;
  retryListenersOpened: number;
  listenersClosed: number;
  navigationCleanupCount: number;
  listenerErrorCount: number;
  closedListenerLifetimeMilliseconds: number;
  maxClosedListenerLifetimeMilliseconds: number;
  snapshotCount: number;
  cacheSnapshotCount: number;
  serverSnapshotCount: number;
  unknownSourceSnapshotCount: number;
  firstSnapshotCount: number;
  firstSnapshotDocumentCount: number;
  unknownDocumentCountSnapshots: number;
  firstSnapshotFromCacheCount: number;
  firstSnapshotFromServerCount: number;
  firstSnapshotUnknownSourceCount: number;
  cacheToServerTransitionCount: number;
  reconnectSnapshotCount: number;
  hiddenSnapshotCount: number;
  pendingWriteSnapshotCount: number;
}

export interface FirestoreListenerSnapshot {
  total: number;
  byLabel: Record<string, number>;
  longestActiveMilliseconds: number;
  evidence: FirestoreListenerEvidence;
}

export interface FirestoreRouteObservation extends FirestoreListenerEvidence {
  route: string;
  outcome: 'settled' | 'superseded' | 'cancelled';
  durationMilliseconds: number;
  listenerCountStart: number;
  listenerCountEnd: number;
  peakListenerCount: number;
  awaitingFirstSnapshotCount: number;
}

export interface FirestoreListenerMonitorOptions {
  readonly startReason?: FirestoreListenerStartReason;
}

interface ActiveListenerRecord {
  label: string;
  startedAt: number;
  firstSnapshotObserved: boolean;
  lastSnapshotSource: FirestoreSnapshotSource | null;
  lastReconnectGeneration: number;
  errorObserved: boolean;
}

interface MutableRouteObservation {
  token: number;
  route: string;
  startedAt: number;
  listenerCountStart: number;
  peakListenerCount: number;
  navigationInProgress: boolean;
  listenerIds: Set<number>;
  firstSnapshotListenerIds: Set<number>;
  evidence: FirestoreListenerEvidence;
}

const activeListeners = new Map<number, ActiveListenerRecord>();
let nextListenerId = 1;
let nextRouteObservationToken = 1;
let reconnectGeneration = 0;
let lastWarningAt = 0;
let activeRouteObservation: MutableRouteObservation | null = null;
let sessionEvidence = createEmptyEvidence();

function createEmptyEvidence(): FirestoreListenerEvidence {
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
  };
}

function isLocalHost(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const hostname = window.location.hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function hasExplicitDebugFlag(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    const parameters = new URLSearchParams(window.location.search);
    return (
      parameters.get('rinkratHealth') === '1' ||
      window.localStorage.getItem('rinkrat:client-health-monitor') === '1'
    );
  } catch {
    return false;
  }
}

function snapshotSource(snapshot: FirestoreSnapshotLike): FirestoreSnapshotSource {
  if (snapshot.metadata?.fromCache === true) {
    return 'cache';
  }

  if (snapshot.metadata?.fromCache === false) {
    return 'server';
  }

  return 'unknown';
}

function snapshotDocumentCount(snapshot: FirestoreSnapshotLike): number | null {
  if (typeof snapshot.size === 'number' && Number.isFinite(snapshot.size) && snapshot.size >= 0) {
    return Math.floor(snapshot.size);
  }

  if (typeof snapshot.exists === 'function') {
    try {
      return snapshot.exists() ? 1 : 0;
    } catch {
      return null;
    }
  }

  return null;
}

function snapshotVisibility(
  context: FirestoreSnapshotObservationContext | undefined,
): 'visible' | 'hidden' {
  if (context?.visibility) {
    return context.visibility;
  }

  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
    ? 'hidden'
    : 'visible';
}

function updateSessionAndRouteEvidence(update: (target: FirestoreListenerEvidence) => void): void {
  update(sessionEvidence);

  if (activeRouteObservation) {
    update(activeRouteObservation.evidence);
  }
}

function registerListener(label: string, options: FirestoreListenerMonitorOptions): number {
  const normalizedLabel = label.trim() || 'unlabeled-listener';
  const listenerId = nextListenerId;
  nextListenerId += 1;

  activeListeners.set(listenerId, {
    label: normalizedLabel,
    startedAt: Date.now(),
    firstSnapshotObserved: false,
    lastSnapshotSource: null,
    lastReconnectGeneration: reconnectGeneration,
    errorObserved: false,
  });

  updateSessionAndRouteEvidence((evidence) => {
    evidence.listenersOpened += 1;

    if (options.startReason === 'retry') {
      evidence.retryListenersOpened += 1;
    }
  });

  if (activeRouteObservation) {
    activeRouteObservation.listenerIds.add(listenerId);
    activeRouteObservation.peakListenerCount = Math.max(
      activeRouteObservation.peakListenerCount,
      activeListeners.size,
    );
  }

  maybeWarnAboutListenerPressure();
  return listenerId;
}

function observeListenerSnapshot(
  listenerId: number,
  snapshot: FirestoreSnapshotLike,
  context?: FirestoreSnapshotObservationContext,
): void {
  const listener = activeListeners.get(listenerId);

  if (!listener) {
    return;
  }

  const source = snapshotSource(snapshot);
  const documentCount = snapshotDocumentCount(snapshot);
  const isFirstSnapshot = !listener.firstSnapshotObserved;
  const isReconnect =
    context?.reconnect === true || listener.lastReconnectGeneration < reconnectGeneration;
  const isCacheToServer = listener.lastSnapshotSource === 'cache' && source === 'server';

  updateSessionAndRouteEvidence((evidence) => {
    evidence.snapshotCount += 1;

    if (source === 'cache') evidence.cacheSnapshotCount += 1;
    if (source === 'server') evidence.serverSnapshotCount += 1;
    if (source === 'unknown') evidence.unknownSourceSnapshotCount += 1;

    if (isFirstSnapshot) {
      evidence.firstSnapshotCount += 1;

      if (documentCount === null) {
        evidence.unknownDocumentCountSnapshots += 1;
      } else {
        evidence.firstSnapshotDocumentCount += documentCount;
      }

      if (source === 'cache') evidence.firstSnapshotFromCacheCount += 1;
      if (source === 'server') evidence.firstSnapshotFromServerCount += 1;
      if (source === 'unknown') evidence.firstSnapshotUnknownSourceCount += 1;
    }

    if (isCacheToServer) evidence.cacheToServerTransitionCount += 1;
    if (isReconnect) evidence.reconnectSnapshotCount += 1;
    if (snapshotVisibility(context) === 'hidden') evidence.hiddenSnapshotCount += 1;
    if (snapshot.metadata?.hasPendingWrites === true) evidence.pendingWriteSnapshotCount += 1;
  });

  if (isFirstSnapshot && activeRouteObservation) {
    activeRouteObservation.firstSnapshotListenerIds.add(listenerId);
  }

  listener.firstSnapshotObserved = true;
  listener.lastSnapshotSource = source;
  listener.lastReconnectGeneration = reconnectGeneration;
}

function observeListenerError(listenerId: number): void {
  const listener = activeListeners.get(listenerId);

  if (!listener || listener.errorObserved) {
    return;
  }

  listener.errorObserved = true;
  updateSessionAndRouteEvidence((evidence) => {
    evidence.listenerErrorCount += 1;
  });
}

function createListenerObserver(listenerId: number): FirestoreListenerObserver {
  return {
    next: (snapshot, context) => observeListenerSnapshot(listenerId, snapshot, context),
    error: () => observeListenerError(listenerId),
  };
}

function createMonitoredUnsubscribe(
  listenerId: number,
  unsubscribe: () => void,
): FirestoreListenerUnsubscribe {
  let closed = false;

  return (reason: FirestoreListenerCloseReason = 'cleanup') => {
    if (closed) {
      return;
    }

    closed = true;
    const listener = activeListeners.get(listenerId);
    const listenerWasActive = activeListeners.delete(listenerId);

    if (listenerWasActive && listener) {
      const lifetimeMilliseconds = Math.max(0, Date.now() - listener.startedAt);
      updateSessionAndRouteEvidence((evidence) => {
        evidence.listenersClosed += 1;
        evidence.closedListenerLifetimeMilliseconds += lifetimeMilliseconds;
        evidence.maxClosedListenerLifetimeMilliseconds = Math.max(
          evidence.maxClosedListenerLifetimeMilliseconds,
          lifetimeMilliseconds,
        );

        if (reason === 'navigation-away' || activeRouteObservation?.navigationInProgress) {
          evidence.navigationCleanupCount += 1;
        }
      });
    }

    unsubscribe();
  };
}

export function isClientHealthMonitorEnabled(): boolean {
  return isLocalHost() || hasExplicitDebugFlag();
}

export function getFirestoreListenerSnapshot(now: number = Date.now()): FirestoreListenerSnapshot {
  const byLabel: Record<string, number> = {};
  let longestActiveMilliseconds = 0;

  for (const listener of activeListeners.values()) {
    byLabel[listener.label] = (byLabel[listener.label] ?? 0) + 1;
    longestActiveMilliseconds = Math.max(
      longestActiveMilliseconds,
      Math.max(0, now - listener.startedAt),
    );
  }

  return {
    total: activeListeners.size,
    byLabel,
    longestActiveMilliseconds,
    evidence: { ...sessionEvidence },
  };
}

export function monitorFirestoreListener(
  label: string,
  subscribe: (observer: FirestoreListenerObserver) => () => void,
  options: FirestoreListenerMonitorOptions = {},
): FirestoreListenerUnsubscribe {
  const listenerId = registerListener(label, options);

  try {
    return createMonitoredUnsubscribe(listenerId, subscribe(createListenerObserver(listenerId)));
  } catch (error: unknown) {
    const listener = activeListeners.get(listenerId);
    activeListeners.delete(listenerId);
    const lifetimeMilliseconds = listener ? Math.max(0, Date.now() - listener.startedAt) : 0;
    updateSessionAndRouteEvidence((evidence) => {
      evidence.listenersClosed += 1;
      evidence.listenerErrorCount += 1;
      evidence.closedListenerLifetimeMilliseconds += lifetimeMilliseconds;
      evidence.maxClosedListenerLifetimeMilliseconds = Math.max(
        evidence.maxClosedListenerLifetimeMilliseconds,
        lifetimeMilliseconds,
      );
    });
    throw error;
  }
}

export function monitorFirestoreUnsubscribe(
  label: string,
  unsubscribe: () => void,
  options: FirestoreListenerMonitorOptions = {},
): FirestoreListenerUnsubscribe {
  const listenerId = registerListener(label, options);
  return createMonitoredUnsubscribe(listenerId, unsubscribe);
}

export function markFirestoreListenersReconnecting(): void {
  reconnectGeneration += 1;
}

export function beginFirestoreRouteObservation(route: string, now: number = Date.now()): number {
  const token = nextRouteObservationToken;
  nextRouteObservationToken += 1;
  const listenerIds = new Set(activeListeners.keys());
  const firstSnapshotListenerIds = new Set<number>();

  for (const [listenerId, listener] of activeListeners) {
    if (listener.firstSnapshotObserved) {
      firstSnapshotListenerIds.add(listenerId);
    }
  }

  activeRouteObservation = {
    token,
    route: route.trim().slice(0, 120) || '/',
    startedAt: now,
    listenerCountStart: activeListeners.size,
    peakListenerCount: activeListeners.size,
    navigationInProgress: true,
    listenerIds,
    firstSnapshotListenerIds,
    evidence: createEmptyEvidence(),
  };

  return token;
}

export function markFirestoreRouteNavigationSettled(token: number, route?: string): void {
  if (activeRouteObservation?.token === token) {
    if (route) {
      activeRouteObservation.route = route.trim().slice(0, 120) || '/';
    }

    activeRouteObservation.navigationInProgress = false;
  }
}

export function completeFirestoreRouteObservation(
  token: number,
  outcome: FirestoreRouteObservation['outcome'] = 'settled',
  now: number = Date.now(),
): FirestoreRouteObservation | null {
  if (activeRouteObservation?.token !== token) {
    return null;
  }

  const observation = activeRouteObservation;
  activeRouteObservation = null;

  return {
    route: observation.route,
    outcome,
    durationMilliseconds: Math.max(0, now - observation.startedAt),
    listenerCountStart: observation.listenerCountStart,
    listenerCountEnd: activeListeners.size,
    peakListenerCount: observation.peakListenerCount,
    awaitingFirstSnapshotCount: Math.max(
      0,
      observation.listenerIds.size - observation.firstSnapshotListenerIds.size,
    ),
    ...observation.evidence,
  };
}

function maybeWarnAboutListenerPressure(): void {
  if (!isClientHealthMonitorEnabled()) {
    return;
  }

  const now = Date.now();

  if (now - lastWarningAt < 10_000) {
    return;
  }

  const snapshot = getFirestoreListenerSnapshot(now);
  const repeatedLabel = Object.entries(snapshot.byLabel).find(([, count]) => count > 4);

  if (snapshot.total <= 32 && !repeatedLabel) {
    return;
  }

  lastWarningAt = now;
  console.warn('[RinkRat client health] Firestore listener pressure detected.', snapshot);
}

export function resetFirestoreListenerMonitorForTests(): void {
  activeListeners.clear();
  nextListenerId = 1;
  nextRouteObservationToken = 1;
  reconnectGeneration = 0;
  lastWarningAt = 0;
  activeRouteObservation = null;
  sessionEvidence = createEmptyEvidence();
}
