import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  type DocumentData,
} from 'firebase/firestore';

import { db } from '../firebase';
import { monitorFirestoreListener } from '../observability/firestore-listener-monitor';
import {
  type LeagueActivity,
  type LeagueActivityAssetSummary,
  type LeagueActivityCategory,
  type LeagueActivityEventType,
} from './league-activity.models';

const LEAGUE_ACTIVITY_LIMIT = 40;
const CATEGORIES = new Set<LeagueActivityCategory>(['league', 'draft', 'roster']);
const EVENT_TYPES = new Set<LeagueActivityEventType>([
  'league-created',
  'member-joined',
  'league-presentation-updated',
  'draft-settings-saved',
  'draft-pick',
  'add-drop',
  'add-open-slot',
  'move-to-ir',
  'activate-from-ir',
  'drop-to-waivers',
  'waiver-award',
  'waiver-cleared',
  'slot-move-activated',
  'active-bench-swap-activated',
  'move-bench-to-ir',
  'activate-ir-to-bench',
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }

  const record = asRecord(value);
  const toDate = record['toDate'];

  if (typeof toDate === 'function') {
    try {
      const candidate = (toDate as (this: unknown) => unknown).call(value);
      return candidate instanceof Date && Number.isFinite(candidate.getTime())
        ? candidate
        : null;
    } catch {
      return null;
    }
  }

  const seconds = record['seconds'];
  const nanoseconds = record['nanoseconds'];

  if (
    typeof seconds === 'number' &&
    Number.isFinite(seconds) &&
    (nanoseconds === undefined || (typeof nanoseconds === 'number' && Number.isFinite(nanoseconds)))
  ) {
    const milliseconds = seconds * 1_000 + (typeof nanoseconds === 'number' ? nanoseconds / 1_000_000 : 0);
    const candidate = new Date(milliseconds);
    return Number.isFinite(candidate.getTime()) ? candidate : null;
  }

  return null;
}

function normalizeAsset(value: unknown): LeagueActivityAssetSummary | null {
  const source = asRecord(value);
  const name = asString(source['name']);

  if (!name) {
    return null;
  }

  const position = asString(source['position']).toUpperCase();
  const assetType = asString(source['assetType']);

  return {
    name,
    position: ['LW', 'C', 'RW', 'D', 'G'].includes(position)
      ? position as LeagueActivityAssetSummary['position']
      : null,
    assetType: assetType === 'skater' || assetType === 'team-goalie-unit'
      ? assetType
      : null,
  };
}

function normalizeLeagueActivity(id: string, value: DocumentData): LeagueActivity | null {
  const source = asRecord(value);
  const category = asString(source['category']) as LeagueActivityCategory;
  const eventType = asString(source['eventType']) as LeagueActivityEventType;

  if (!CATEGORIES.has(category) || !EVENT_TYPES.has(eventType)) {
    return null;
  }

  const selectionType = asString(source['selectionType']);

  return {
    id,
    schemaVersion: typeof source['schemaVersion'] === 'number' ? source['schemaVersion'] : 1,
    category,
    eventType,
    ownerId: asString(source['ownerId']) || null,
    primaryAsset: normalizeAsset(source['primaryAsset']),
    secondaryAsset: normalizeAsset(source['secondaryAsset']),
    overallPick: asPositiveInteger(source['overallPick']),
    round: asPositiveInteger(source['round']),
    selectionType: ['manual', 'queue', 'automatic'].includes(selectionType)
      ? selectionType as LeagueActivity['selectionType']
      : null,
    effectiveCycleNumber: asPositiveInteger(source['effectiveCycleNumber']),
    effectiveLabel: asString(source['effectiveLabel']) || null,
    occurredAt: asDate(source['occurredAt']),
  };
}

export function listenToLeagueActivity(
  leagueId: string,
  callback: (activity: LeagueActivity[]) => void,
  onError?: (error: Error) => void,
): () => void {
  const activityQuery = query(
    collection(db, 'leagues', leagueId, 'activity'),
    orderBy('occurredAt', 'desc'),
    limit(LEAGUE_ACTIVITY_LIMIT),
  );

  return monitorFirestoreListener('league:activity', () => onSnapshot(
    activityQuery,
    (snapshot) => {
      callback(
        snapshot.docs
          .map((document) => normalizeLeagueActivity(document.id, document.data()))
          .filter((activity): activity is LeagueActivity => activity !== null),
      );
    },
    (error) => {
      const normalizedError = error instanceof Error
        ? error
        : new Error('Unable to load League Wire.');

      if (onError) {
        onError(normalizedError);
        return;
      }

      console.error('Unable to load League Wire.', error);
    },
  ));
}
