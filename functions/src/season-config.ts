import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import { db } from './shared/core/firebase';

export const DEFAULT_SEASON_ID = '20262027';
export const DEFAULT_SEASON_START_ISO = '2026-09-29T21:00:00.000Z';

export interface SeasonAutomationConfig {
  enabled: boolean;
  seasonId: string;
  seasonStartAt: Date;
  source: 'saved' | 'default';
  status: string;
  pendingLeagueCount: number;
  lastRunAt: Date | null;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Timestamp) {
    return value.toDate();
  }

  if (
    value &&
    typeof value === 'object' &&
    'toDate' in value &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  ) {
    const date = (value as { toDate: () => Date }).toDate();
    return Number.isFinite(date.getTime()) ? date : null;
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  return null;
}

export async function getSeasonAutomationConfig(): Promise<SeasonAutomationConfig> {
  const reference = db.doc('appData/seasonAutomation');
  const snapshot = await reference.get();
  const data = snapshot.exists ? snapshot.data() : undefined;
  const savedStart = toDate(data?.['seasonStartAt']);
  const defaultStart = new Date(DEFAULT_SEASON_START_ISO);
  const config: SeasonAutomationConfig = {
    enabled: data?.['enabled'] !== false,
    seasonId:
      typeof data?.['seasonId'] === 'string' && data['seasonId']
        ? data['seasonId']
        : DEFAULT_SEASON_ID,
    seasonStartAt: savedStart ?? defaultStart,
    source: savedStart ? 'saved' : 'default',
    status: typeof data?.['status'] === 'string' ? data['status'] : '',
    pendingLeagueCount:
      typeof data?.['pendingLeagueCount'] === 'number' &&
      Number.isFinite(data['pendingLeagueCount'])
        ? Math.max(0, Math.trunc(data['pendingLeagueCount']))
        : 0,
    lastRunAt: toDate(data?.['lastRunAt']),
  };

  const needsDefaultPersistence =
    !snapshot.exists ||
    !savedStart ||
    typeof data?.['seasonId'] !== 'string' ||
    typeof data?.['enabled'] !== 'boolean' ||
    data?.['timeZone'] !== 'America/Los_Angeles';

  if (needsDefaultPersistence) {
    await reference.set(
      {
        schemaVersion: 1,
        enabled: config.enabled,
        seasonId: config.seasonId,
        seasonStartAt: Timestamp.fromDate(config.seasonStartAt),
        seasonStartIso: config.seasonStartAt.toISOString(),
        timeZone: 'America/Los_Angeles',
        configuredBy: config.source,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  return config;
}

export function hasSeasonStarted(
  config: SeasonAutomationConfig,
  now = new Date(),
): boolean {
  return !config.enabled || now.getTime() >= config.seasonStartAt.getTime();
}
