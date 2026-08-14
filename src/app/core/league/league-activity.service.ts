import {
  collection,
  doc,
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
  type PinnedLeagueAnnouncement,
} from './league-activity.models';

const LEAGUE_ACTIVITY_LIMIT = 40;
const CATEGORIES = new Set<LeagueActivityCategory>([
  'league',
  'draft',
  'roster',
  'matchup',
  'commissioner',
  'announcement',
  'recap',
]);
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
  'matchup-result',
  'commissioner-availability-override-set',
  'commissioner-availability-override-cleared',
  'commissioner-draft-opened',
  'commissioner-draft-clock-paused',
  'commissioner-draft-clock-resumed',
  'commissioner-announcement',
  'matchup-round-recap',
]);

const AVAILABILITY_STATUSES = new Set<LeagueActivity['availabilityStatus']>([
  'active',
  'day-to-day',
  'out',
  'injured-reserve',
  'long-term-injured-reserve',
  'suspended',
  'personal-leave',
  'unknown',
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

function asBoundedScore(value: unknown): number | null {
  return typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= -100_000 &&
      value <= 100_000
    ? value
    : null;
}

function asBoundedStringArray(value: unknown, maximumItems = 24): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const values = value
    .map((item) => asString(item))
    .filter((item) => Boolean(item));

  return [...new Set(values)].slice(0, maximumItems);
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
  const matchupPhase = asString(source['matchupPhase']);
  const playoffBracketType = asString(source['playoffBracketType']);
  const availabilityStatus = asString(source['availabilityStatus']) as LeagueActivity['availabilityStatus'];
  const announcementTitle = asString(source['announcementTitle']);
  const announcementBody = typeof source['announcementBody'] === 'string'
    ? source['announcementBody'].trim()
    : '';

  if (
    eventType === 'commissioner-announcement' &&
    (!announcementTitle || !announcementBody)
  ) {
    return null;
  }

  const recapCycleNumber = asPositiveInteger(source['recapCycleNumber']);
  const recapMatchupCount = asPositiveInteger(source['recapMatchupCount']);
  const recapTopScoreOwnerIds = asBoundedStringArray(source['recapTopScoreOwnerIds']);
  const recapTopScore = asBoundedScore(source['recapTopScore']);
  const recapClosestTeamAOwnerId = asString(source['recapClosestTeamAOwnerId']) || null;
  const recapClosestTeamBOwnerId = asString(source['recapClosestTeamBOwnerId']) || null;
  const recapClosestWinnerOwnerId = asString(source['recapClosestWinnerOwnerId']) || null;
  const recapClosestMargin = asBoundedScore(source['recapClosestMargin']);
  const recapPreviousLeagueHighScore = asBoundedScore(source['recapPreviousLeagueHighScore']);
  const recapNewLeagueHighScore = source['recapNewLeagueHighScore'] === true;

  if (
    eventType === 'matchup-round-recap' &&
    (
      category !== 'recap' ||
      recapCycleNumber === null ||
      recapMatchupCount === null ||
      recapMatchupCount < 2 ||
      recapTopScoreOwnerIds.length === 0 ||
      recapTopScore === null ||
      !recapClosestTeamAOwnerId ||
      !recapClosestTeamBOwnerId ||
      recapClosestTeamAOwnerId === recapClosestTeamBOwnerId ||
      recapClosestMargin === null ||
      recapClosestMargin < 0 ||
      (recapClosestWinnerOwnerId !== null &&
        recapClosestWinnerOwnerId !== recapClosestTeamAOwnerId &&
        recapClosestWinnerOwnerId !== recapClosestTeamBOwnerId) ||
      (recapClosestMargin === 0 && recapClosestWinnerOwnerId !== null) ||
      (recapClosestMargin > 0 && recapClosestWinnerOwnerId === null) ||
      (recapNewLeagueHighScore &&
        (recapPreviousLeagueHighScore === null || recapTopScore <= recapPreviousLeagueHighScore))
    )
  ) {
    return null;
  }

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
    matchupPhase: matchupPhase === 'regular_season' || matchupPhase === 'playoffs'
      ? matchupPhase
      : null,
    matchupCycleNumber: asPositiveInteger(source['matchupCycleNumber']),
    teamAOwnerId: asString(source['teamAOwnerId']) || null,
    teamBOwnerId: asString(source['teamBOwnerId']) || null,
    teamAScore: asBoundedScore(source['teamAScore']),
    teamBScore: asBoundedScore(source['teamBScore']),
    winnerOwnerId: asString(source['winnerOwnerId']) || null,
    playoffBracketType: playoffBracketType === 'championship' || playoffBracketType === 'consolation'
      ? playoffBracketType
      : null,
    playoffRoundNumber: asPositiveInteger(source['playoffRoundNumber']),
    winnerPlace: asPositiveInteger(source['winnerPlace']),
    loserPlace: asPositiveInteger(source['loserPlace']),
    tieBrokenByHigherSeed: source['tieBrokenByHigherSeed'] === true,
    availabilityPlayerName: asString(source['availabilityPlayerName']) || null,
    availabilityStatus: AVAILABILITY_STATUSES.has(availabilityStatus)
      ? availabilityStatus
      : null,
    announcementTitle: announcementTitle || null,
    announcementBody: announcementBody || null,
    recapCycleNumber,
    recapMatchupCount,
    recapTopScoreOwnerIds,
    recapTopScore,
    recapClosestTeamAOwnerId,
    recapClosestTeamBOwnerId,
    recapClosestWinnerOwnerId,
    recapClosestMargin,
    recapNewLeagueHighScore,
    recapPreviousLeagueHighScore,
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


function normalizePinnedLeagueAnnouncement(
  value: DocumentData,
): PinnedLeagueAnnouncement | null {
  const source = asRecord(value);
  const ownerId = asString(source['ownerId']);
  const title = asString(source['announcementTitle']);
  const body = typeof source['announcementBody'] === 'string'
    ? source['announcementBody'].trim()
    : '';
  const activityId = asString(source['activityId']);

  return ownerId && title && body && activityId
    ? {
        ownerId,
        title,
        body,
        activityId,
        occurredAt: asDate(source['announcementOccurredAt']),
        pinnedAt: asDate(source['pinnedAt']),
      }
    : null;
}

export function listenToPinnedLeagueAnnouncement(
  leagueId: string,
  callback: (announcement: PinnedLeagueAnnouncement | null) => void,
  onError?: (error: Error) => void,
): () => void {
  const announcementReference = doc(
    db,
    'leagues',
    leagueId,
    'activity',
    'pinned-announcement',
  );

  return monitorFirestoreListener('league:pinned-announcement', () => onSnapshot(
    announcementReference,
    (snapshot) => {
      callback(snapshot.exists()
        ? normalizePinnedLeagueAnnouncement(snapshot.data())
        : null);
    },
    (error) => {
      const normalizedError = error instanceof Error
        ? error
        : new Error('Unable to load the pinned league announcement.');

      if (onError) {
        onError(normalizedError);
        return;
      }

      console.error('Unable to load the pinned league announcement.', error);
    },
  ));
}
