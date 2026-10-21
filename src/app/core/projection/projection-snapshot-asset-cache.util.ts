/**
 * Small tab-lifetime cache for immutable projection snapshot assets.
 *
 * The mutable snapshot pointer is deliberately not stored here. Callers must
 * resolve that pointer with their normal freshness policy, then use its exact
 * snapshot ID as the key. Failed loads are never retained, so a transient
 * Firestore error can be retried normally.
 */
export class ProjectionSnapshotAssetCache<T> {
  private readonly values = new Map<string, T>();
  private readonly inFlight = new Map<string, Promise<T>>();
  private readonly maxEntries: number;

  constructor(maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error('Projection snapshot asset cache size must be a positive integer.');
    }

    this.maxEntries = maxEntries;
  }

  getOrLoad(key: string, loader: () => Promise<T>): Promise<T> {
    if (this.values.has(key)) {
      const value = this.values.get(key) as T;

      // Map insertion order supplies the LRU order. Reading an entry promotes
      // it without copying the large immutable Projection V11 asset payload.
      this.values.delete(key);
      this.values.set(key, value);
      return Promise.resolve(value);
    }

    const activeLoad = this.inFlight.get(key);

    if (activeLoad) {
      return activeLoad;
    }

    let request: Promise<T>;
    request = Promise.resolve()
      .then(loader)
      .then((value) => {
        this.values.delete(key);
        this.values.set(key, value);

        while (this.values.size > this.maxEntries) {
          const oldestKey = this.values.keys().next().value as string | undefined;

          if (oldestKey === undefined) {
            break;
          }

          this.values.delete(oldestKey);
        }

        return value;
      })
      .finally(() => {
        if (this.inFlight.get(key) === request) {
          this.inFlight.delete(key);
        }
      });

    this.inFlight.set(key, request);
    return request;
  }

  delete(key: string): void {
    this.values.delete(key);
  }
}

export function assertCompleteProjectionSnapshotAssetPayload(
  expectedAssetCount: number,
  actualAssetCount: number,
): void {
  if (!Number.isInteger(expectedAssetCount) || expectedAssetCount < 1) {
    throw new Error(
      `The shared projection snapshot has an invalid asset count (${expectedAssetCount}).`,
    );
  }

  if (actualAssetCount !== expectedAssetCount) {
    throw new Error(
      `The shared projection snapshot is incomplete (${actualAssetCount} of ${expectedAssetCount} assets loaded).`,
    );
  }
}

/**
 * Detach consumers from the tab-lifetime cached value. Draftable assets are
 * plain Firestore data, so structured cloning preserves their data shape while
 * preventing an in-place route mutation from poisoning later cache readers.
 */
export function detachProjectionSnapshotForConsumer<T>(value: T): T {
  return structuredClone(value);
}
