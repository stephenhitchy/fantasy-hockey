import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import { db } from '../firebase';
import {
  NHL_SHARED_CACHE_MAX_PAYLOAD_BYTES,
  getNhlSharedCacheDescriptor,
  normalizeNhlSharedCacheUrl,
  serializeNhlSharedCachePayload,
  type NhlSharedCacheRouteClass,
  type NormalizedNhlSharedCacheRequest,
} from './nhl-shared-cache.util';

export const NHL_SHARED_CACHE_MODE = 'shadow' as const;
export const NHL_SHARED_CACHE_COLLECTION = 'nhlSharedDataCache';
export const NHL_SHARED_CACHE_HEALTH_PATH = 'appData/nhlSharedDataCacheHealth';
export const NHL_SHARED_CACHE_AUTHORITATIVE_READS_ENABLED = false;

const NHL_SHARED_CACHE_HEARTBEAT_MILLISECONDS = 15 * 60 * 1000;
const NHL_SHARED_CACHE_HEALTH_FLUSH_MILLISECONDS = 60 * 1000;
const NHL_SHARED_CACHE_MAX_IN_FLIGHT_OBSERVATIONS = 100;

export type NhlSharedCacheObservationSource =
  | 'functions-core'
  | 'public-proxy';

export type NhlSharedCacheObservationOutcome =
  | 'stored'
  | 'changed'
  | 'heartbeat'
  | 'unchanged-suppressed'
  | 'oversized-skipped'
  | 'invalid-json-skipped'
  | 'unsupported-route-skipped'
  | 'in-flight-suppressed'
  | 'queue-capacity-skipped'
  | 'error';

export interface NhlSharedCacheObservationInput {
  url: string;
  payload: unknown;
  source: NhlSharedCacheObservationSource;
}

interface NhlSharedCacheHealthCounters {
  observationCount: number;
  storedCount: number;
  changedCount: number;
  heartbeatCount: number;
  unchangedSuppressedCount: number;
  oversizedSkippedCount: number;
  invalidJsonSkippedCount: number;
  unsupportedRouteSkippedCount: number;
  inFlightSuppressedCount: number;
  queueCapacitySkippedCount: number;
  errorCount: number;
}

const pendingObservationKeys = new Set<string>();
let healthLastFlushAt = 0;
let healthLastEvent = 'startup';
let healthLastRouteClass: NhlSharedCacheRouteClass | null = null;
let healthLastCacheKeyPrefix: string | null = null;
let healthCounters = emptyHealthCounters();
let healthRouteCounters = new Map<NhlSharedCacheRouteClass, number>();

function emptyHealthCounters(): NhlSharedCacheHealthCounters {
  return {
    observationCount: 0,
    storedCount: 0,
    changedCount: 0,
    heartbeatCount: 0,
    unchangedSuppressedCount: 0,
    oversizedSkippedCount: 0,
    invalidJsonSkippedCount: 0,
    unsupportedRouteSkippedCount: 0,
    inFlightSuppressedCount: 0,
    queueCapacitySkippedCount: 0,
    errorCount: 0,
  };
}

function timestampMilliseconds(value: unknown): number | null {
  if (value instanceof Timestamp) {
    return value.toMillis();
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const toMillis = (value as Record<string, unknown>)['toMillis'];

  if (typeof toMillis !== 'function') {
    return null;
  }

  const milliseconds = toMillis.call(value);

  return typeof milliseconds === 'number' && Number.isFinite(milliseconds)
    ? milliseconds
    : null;
}

function recordHealth(
  outcome: NhlSharedCacheObservationOutcome,
  routeClass: NhlSharedCacheRouteClass | null,
  cacheKey: string | null,
): void {
  healthLastEvent = outcome;
  healthLastRouteClass = routeClass ?? healthLastRouteClass;
  healthLastCacheKeyPrefix = cacheKey?.slice(0, 12) ?? healthLastCacheKeyPrefix;
  healthCounters.observationCount += 1;

  switch (outcome) {
    case 'stored':
      healthCounters.storedCount += 1;
      break;
    case 'changed':
      healthCounters.changedCount += 1;
      break;
    case 'heartbeat':
      healthCounters.heartbeatCount += 1;
      break;
    case 'unchanged-suppressed':
      healthCounters.unchangedSuppressedCount += 1;
      break;
    case 'oversized-skipped':
      healthCounters.oversizedSkippedCount += 1;
      break;
    case 'invalid-json-skipped':
      healthCounters.invalidJsonSkippedCount += 1;
      break;
    case 'unsupported-route-skipped':
      healthCounters.unsupportedRouteSkippedCount += 1;
      break;
    case 'in-flight-suppressed':
      healthCounters.inFlightSuppressedCount += 1;
      break;
    case 'queue-capacity-skipped':
      healthCounters.queueCapacitySkippedCount += 1;
      break;
    case 'error':
      healthCounters.errorCount += 1;
      break;
  }

  if (routeClass) {
    healthRouteCounters.set(
      routeClass,
      (healthRouteCounters.get(routeClass) ?? 0) + 1,
    );
  }

  flushHealthIfDue();
}

function flushHealthIfDue(): void {
  const now = Date.now();

  if (now - healthLastFlushAt < NHL_SHARED_CACHE_HEALTH_FLUSH_MILLISECONDS) {
    return;
  }

  healthLastFlushAt = now;
  const counters = healthCounters;
  const routeCounters = healthRouteCounters;
  healthCounters = emptyHealthCounters();
  healthRouteCounters = new Map<NhlSharedCacheRouteClass, number>();

  const byRouteClass: Record<string, Record<string, unknown>> = {};

  for (const [routeClass, count] of routeCounters) {
    byRouteClass[routeClass] = {
      observationCount: FieldValue.increment(count),
    };
  }

  void db.doc(NHL_SHARED_CACHE_HEALTH_PATH).set(
    {
      schemaVersion: 1,
      mode: NHL_SHARED_CACHE_MODE,
      authoritativeReadsEnabled: NHL_SHARED_CACHE_AUTHORITATIVE_READS_ENABLED,
      deterministicKeysEnabled: true,
      payloadHashValidationEnabled: true,
      maximumPayloadBytes: NHL_SHARED_CACHE_MAX_PAYLOAD_BYTES,
      observationCount: FieldValue.increment(counters.observationCount),
      storedCount: FieldValue.increment(counters.storedCount),
      changedCount: FieldValue.increment(counters.changedCount),
      heartbeatCount: FieldValue.increment(counters.heartbeatCount),
      unchangedSuppressedCount: FieldValue.increment(
        counters.unchangedSuppressedCount,
      ),
      oversizedSkippedCount: FieldValue.increment(counters.oversizedSkippedCount),
      invalidJsonSkippedCount: FieldValue.increment(counters.invalidJsonSkippedCount),
      unsupportedRouteSkippedCount: FieldValue.increment(
        counters.unsupportedRouteSkippedCount,
      ),
      inFlightSuppressedCount: FieldValue.increment(
        counters.inFlightSuppressedCount,
      ),
      queueCapacitySkippedCount: FieldValue.increment(
        counters.queueCapacitySkippedCount,
      ),
      errorCount: FieldValue.increment(counters.errorCount),
      byRouteClass,
      lastEvent: healthLastEvent,
      lastRouteClass: healthLastRouteClass,
      lastCacheKeyPrefix: healthLastCacheKeyPrefix,
      lastObservedAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    },
    { merge: true },
  ).catch((error: unknown) => {
    console.warn('Unable to persist shared NHL cache health.', { error });
  });
}

async function observeNhlSharedCacheResponse(
  input: NhlSharedCacheObservationInput,
  normalized: NormalizedNhlSharedCacheRequest,
): Promise<NhlSharedCacheObservationOutcome> {
  const serialized = serializeNhlSharedCachePayload(input.payload);

  if (!serialized) {
    return 'invalid-json-skipped';
  }

  if (serialized.bytes > NHL_SHARED_CACHE_MAX_PAYLOAD_BYTES) {
    return 'oversized-skipped';
  }

  const now = Date.now();
  const nowTimestamp = Timestamp.fromMillis(now);
  const reference = db.collection(NHL_SHARED_CACHE_COLLECTION).doc(
    normalized.cacheKey,
  );

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const existing = snapshot.data() ?? {};
    const existingHash = typeof existing['contentHash'] === 'string'
      ? existing['contentHash']
      : '';
    const lastObservedAt = timestampMilliseconds(existing['lastObservedAt']);
    const samePayload = existingHash === serialized.contentHash;

    if (
      samePayload &&
      lastObservedAt !== null &&
      now - lastObservedAt < NHL_SHARED_CACHE_HEARTBEAT_MILLISECONDS
    ) {
      return 'unchanged-suppressed' as const;
    }

    const baseUpdate: Record<string, unknown> = {
      schemaVersion: 1,
      mode: NHL_SHARED_CACHE_MODE,
      authoritative: false,
      eligibleForAuthoritativeRead: false,
      cacheKey: normalized.cacheKey,
      routeClass: normalized.routeClass,
      canonicalPath: normalized.canonicalPath,
      canonicalQueryHash: normalized.canonicalQueryHash,
      source: input.source,
      contentHash: serialized.contentHash,
      payloadBytes: serialized.bytes,
      freshUntil: Timestamp.fromMillis(now + normalized.freshnessMilliseconds),
      expiresAt: Timestamp.fromMillis(now + normalized.retentionMilliseconds),
      lastObservedAt: nowTimestamp,
      observationCount: FieldValue.increment(1),
      updatedAt: nowTimestamp,
    };

    if (samePayload) {
      transaction.set(reference, baseUpdate, { merge: true });
      return 'heartbeat' as const;
    }

    transaction.set(
      reference,
      {
        ...baseUpdate,
        payloadJson: serialized.json,
        changeCount: FieldValue.increment(1),
        lastChangedAt: nowTimestamp,
        ...(snapshot.exists ? {} : { createdAt: nowTimestamp }),
      },
      { merge: true },
    );

    return snapshot.exists ? 'changed' as const : 'stored' as const;
  });
}

/**
 * Best-effort Shadow observation only. The existing NHL request remains
 * authoritative, and a cache write can never fail or delay scoring, Draft,
 * roster timing, or any browser response.
 */
export function queueNhlSharedCacheObservation(
  input: NhlSharedCacheObservationInput,
): void {
  const normalized = normalizeNhlSharedCacheUrl(input.url);

  if (!normalized) {
    recordHealth('unsupported-route-skipped', null, null);
    return;
  }

  if (pendingObservationKeys.has(normalized.cacheKey)) {
    recordHealth(
      'in-flight-suppressed',
      normalized.routeClass,
      normalized.cacheKey,
    );
    return;
  }

  if (pendingObservationKeys.size >= NHL_SHARED_CACHE_MAX_IN_FLIGHT_OBSERVATIONS) {
    recordHealth(
      'queue-capacity-skipped',
      normalized.routeClass,
      normalized.cacheKey,
    );
    return;
  }

  pendingObservationKeys.add(normalized.cacheKey);

  void observeNhlSharedCacheResponse(input, normalized)
    .then((outcome) => {
      recordHealth(outcome, normalized.routeClass, normalized.cacheKey);
    })
    .catch((error: unknown) => {
      recordHealth('error', normalized.routeClass, normalized.cacheKey);
      console.warn('Shared NHL cache Shadow observation failed.', {
        routeClass: normalized.routeClass,
        cacheKeyPrefix: normalized.cacheKey.slice(0, 12),
        error,
      });
    })
    .finally(() => {
      pendingObservationKeys.delete(normalized.cacheKey);
    });
}

export { getNhlSharedCacheDescriptor };
