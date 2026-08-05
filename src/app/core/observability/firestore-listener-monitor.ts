export type FirestoreListenerUnsubscribe = () => void;

export interface FirestoreListenerSnapshot {
  total: number;
  byLabel: Record<string, number>;
  longestActiveMilliseconds: number;
}

interface ActiveListenerRecord {
  label: string;
  startedAt: number;
}

const activeListeners = new Map<number, ActiveListenerRecord>();
let nextListenerId = 1;
let lastWarningAt = 0;

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

export function isClientHealthMonitorEnabled(): boolean {
  return isLocalHost() || hasExplicitDebugFlag();
}

export function getFirestoreListenerSnapshot(
  now: number = Date.now(),
): FirestoreListenerSnapshot {
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
  };
}

export function monitorFirestoreListener(
  label: string,
  subscribe: () => FirestoreListenerUnsubscribe,
): FirestoreListenerUnsubscribe {
  const normalizedLabel = label.trim() || 'unlabeled-listener';
  const unsubscribe = subscribe();
  const listenerId = nextListenerId;
  nextListenerId += 1;

  activeListeners.set(listenerId, {
    label: normalizedLabel,
    startedAt: Date.now(),
  });

  maybeWarnAboutListenerPressure();

  let closed = false;

  return () => {
    if (closed) {
      return;
    }

    closed = true;
    activeListeners.delete(listenerId);
    unsubscribe();
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
  lastWarningAt = 0;
}
