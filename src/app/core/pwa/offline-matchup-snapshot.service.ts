import { Injectable } from '@angular/core';

import {
  type OfflineMatchupSnapshotContext,
  type RinkRatOfflineMatchupSnapshot,
} from './offline-matchup-snapshot.models';
import {
  createOfflineMatchupSnapshotStorageKey,
  isOfflineMatchupSnapshotFresh,
  normalizeOfflineMatchupSnapshot,
  OFFLINE_MATCHUP_SNAPSHOT_MAX_PER_ACCOUNT,
  offlineMatchupSnapshotContentEquals,
  selectOfflineMatchupSnapshot,
} from './offline-matchup-snapshot.util';

const DATABASE_NAME = 'rinkrat-offline-matchups';
const DATABASE_VERSION = 1;
const STORE_NAME = 'snapshots';

interface StoredOfflineMatchupSnapshot extends RinkRatOfflineMatchupSnapshot {
  storageKey: string;
}

let databasePromise: Promise<IDBDatabase | null> | null = null;

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }

  databasePromise ??= new Promise((resolve) => {
    let request: IDBOpenDBRequest;

    try {
      request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    } catch {
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'storageKey' });
        store.createIndex('accountId', 'accountId', { unique: false });
        store.createIndex('savedAt', 'savedAt', { unique: false });
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });

  return databasePromise;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

function transactionFinished(transaction: IDBTransaction): Promise<boolean> {
  return new Promise((resolve) => {
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => resolve(false);
    transaction.onabort = () => resolve(false);
  });
}

async function getAllStoredSnapshots(): Promise<StoredOfflineMatchupSnapshot[]> {
  const database = await openDatabase();

  if (!database) {
    return [];
  }

  try {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const result = await requestValue(transaction.objectStore(STORE_NAME).getAll());
    return Array.isArray(result) ? result as StoredOfflineMatchupSnapshot[] : [];
  } catch {
    return [];
  }
}

async function deleteStorageKeys(storageKeys: readonly string[]): Promise<void> {
  if (!storageKeys.length) {
    return;
  }

  const database = await openDatabase();

  if (!database) {
    return;
  }

  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    for (const storageKey of storageKeys) {
      store.delete(storageKey);
    }

    await transactionFinished(transaction);
  } catch {
    // Saved matchup data is optional and must never interrupt the live app.
  }
}

async function pruneAccountSnapshots(accountId: string): Promise<void> {
  const snapshots = await getAllStoredSnapshots();
  const deleteKeys = new Set<string>();
  const valid = snapshots
    .filter((snapshot) => snapshot.accountId === accountId)
    .filter((snapshot) => {
      const normalized = normalizeOfflineMatchupSnapshot(snapshot);
      const keep = Boolean(normalized && isOfflineMatchupSnapshotFresh(normalized));

      if (!keep) {
        deleteKeys.add(snapshot.storageKey);
      }

      return keep;
    })
    .sort((left, right) => right.savedAt.localeCompare(left.savedAt));

  for (const snapshot of valid.slice(OFFLINE_MATCHUP_SNAPSHOT_MAX_PER_ACCOUNT)) {
    deleteKeys.add(snapshot.storageKey);
  }

  await deleteStorageKeys([...deleteKeys]);
}

export async function clearOfflineMatchupSnapshotsForAccount(accountId: string): Promise<void> {
  const normalizedAccountId = accountId.trim();

  if (!normalizedAccountId) {
    return;
  }

  const snapshots = await getAllStoredSnapshots();
  await deleteStorageKeys(
    snapshots
      .filter((snapshot) => snapshot.accountId === normalizedAccountId)
      .map((snapshot) => snapshot.storageKey),
  );
}

@Injectable({ providedIn: 'root' })
export class OfflineMatchupSnapshotService {
  async save(value: RinkRatOfflineMatchupSnapshot): Promise<boolean> {
    const snapshot = normalizeOfflineMatchupSnapshot(value, {
      accountId: value.accountId,
      leagueId: value.leagueId,
      cycleNumber: value.cycleNumber,
      matchupId: value.matchupId,
    });

    if (!snapshot) {
      return false;
    }

    const database = await openDatabase();

    if (!database) {
      return false;
    }

    const storageKey = createOfflineMatchupSnapshotStorageKey({
      accountId: snapshot.accountId,
      leagueId: snapshot.leagueId,
      cycleNumber: snapshot.cycleNumber,
      matchupId: snapshot.matchupId,
    });

    try {
      const readTransaction = database.transaction(STORE_NAME, 'readonly');
      const existingValue = await requestValue(
        readTransaction.objectStore(STORE_NAME).get(storageKey),
      );
      const existing = normalizeOfflineMatchupSnapshot(existingValue);

      if (
        existing &&
        offlineMatchupSnapshotContentEquals(existing, snapshot) &&
        Date.now() - Date.parse(existing.savedAt) < 5 * 60 * 1_000
      ) {
        return true;
      }

      const stored: StoredOfflineMatchupSnapshot = { ...snapshot, storageKey };
      const writeTransaction = database.transaction(STORE_NAME, 'readwrite');
      writeTransaction.objectStore(STORE_NAME).put(stored);
      const saved = await transactionFinished(writeTransaction);

      if (saved) {
        void pruneAccountSnapshots(snapshot.accountId);
      }

      return saved;
    } catch {
      return false;
    }
  }

  async load(context: OfflineMatchupSnapshotContext): Promise<RinkRatOfflineMatchupSnapshot | null> {
    const snapshots = await getAllStoredSnapshots();
    const selected = selectOfflineMatchupSnapshot(snapshots, context);

    if (!selected) {
      return null;
    }

    void pruneAccountSnapshots(context.accountId.trim());
    return selected;
  }
}
