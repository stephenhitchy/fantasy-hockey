import { randomUUID } from 'node:crypto';

import {
  DocumentData,
  FieldValue,
  Timestamp,
} from 'firebase-admin/firestore';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { db } from './shared/core/firebase';
import {
  advanceCompletedRegularSeasonAssetWindows,
  completeCycle,
  getActiveLeagueCycles,
  getCycleMatchupsOnce,
  getCycleRosterPicksOnce,
  reconcileRegularSeasonCycleMatchupCompletion,
  startCycleOne,
  startNextCycle,
  updateCycleMatchupScores,
} from './shared/core/cycle/cycle.service';
import {
  calculateCycleScoring,
  CycleScoringResult,
} from './shared/core/cycle/cycle-scoring.service';
import { syncCycleTeamWindows } from './shared/core/cycle/asset-cycle-window.service';
import { FantasyCycle } from './shared/core/cycle/cycle.models';
import { DraftableAsset, DraftPick, FantasyDraft } from './shared/core/draft/draft.models';
import { SharedCycleScoringSnapshot } from './shared/core/live-scoring/live-scoring.models';
import {
  getNhlTeamSeasonSchedule,
  getRegularSeasonGameLog,
  NhlTeamSeasonGame,
} from './shared/core/nhl/nhl-api.service';
import { getFantasyPlayoffs } from './shared/core/playoffs/playoff.service';
import {
  ensureNextPlayoffBankWindows,
  syncPlayoffWindowBankScores,
} from './shared/core/playoffs/playoff-window-bank.service';
import {
  CURRENT_SCORING_RULES_VERSION,
  defaultScoringRules,
  ScoringRules,
} from './shared/core/scoring/scoring-rules';
import {
  FantasyTeam,
  getLeagueTeams,
} from './shared/core/team/team.service';

const FUNCTION_REGION = 'us-central1';
const SERVER_WORKER_PREFIX = 'server:';
const SERVER_LEASE_MILLISECONDS = 9 * 60 * 1000;
const LIVE_REFRESH_INTERVAL_MILLISECONDS = 10 * 60 * 1000;
const NEAR_GAME_REFRESH_MAX_MILLISECONDS = 60 * 60 * 1000;
const IDLE_REFRESH_INTERVAL_MILLISECONDS = 6 * 60 * 60 * 1000;
const ERROR_RETRY_INTERVAL_MILLISECONDS = 5 * 60 * 1000;
const MAX_TRANSITION_PASSES = 3;
const MAX_PARALLEL_LEAGUES = 2;

const HISTORICAL_REPLAY_TARGET_SEASON = '20262027';
const HISTORICAL_REPLAY_SOURCE_SEASON = '20252026';
const HISTORICAL_REPLAY_TEAMS = [
  'ANA', 'BOS', 'BUF', 'CAR', 'CBJ', 'CGY', 'CHI', 'COL',
  'DAL', 'DET', 'EDM', 'FLA', 'LAK', 'MIN', 'MTL', 'NJD',
  'NSH', 'NYI', 'NYR', 'OTT', 'PHI', 'PIT', 'SEA', 'SJS',
  'STL', 'TBL', 'TOR', 'UTA', 'VAN', 'VGK', 'WPG', 'WSH',
] as const;


interface ServerLeague {
  id: string;
  commissionerId: string;
  scoringRules: ScoringRules;
  scoringRulesVersion: number;
}

interface PreviousScoringSnapshot {
  season: string;
  scoringFingerprint: string;
  scoringRulesFingerprint: string;
  result: CycleScoringResult;
  createdAt?: unknown;
}

interface LeagueAutomationResult {
  leagueId: string;
  status: 'success' | 'skipped';
  activeCycleNumbers: number[];
  publishedSnapshotCount: number;
  skippedSnapshotCount: number;
  cycleOneCreated: boolean;
  durationMilliseconds: number;
}

interface LeaseClaimResult {
  claimed: boolean;
  reason: string;
}

interface HistoricalReplayControl {
  enabled: boolean;
  status: 'inactive' | 'advancing' | 'ready' | 'error';
  targetSeason: string;
  sourceSeason: string;
  simulatedDate: string | null;
  seasonStartDate: string | null;
  daysAdvanced: number;
  lastReleasedGameCount: number;
  totalReleasedGameCount: number;
  message: string;
}

interface HistoricalReplayAssetMap {
  assetKey: string;
  assetType: 'skater' | 'team-goalie-unit';
  sourceSeason: string;
  sourceGameIds: number[];
  sourceGameDates: string[];
  sourceTeamAbbreviations: string[];
}

interface ReplayRunContext {
  control: HistoricalReplayControl;
  gamesByAssetKey: Record<string, NhlTeamSeasonGame[]>;
  snapshotSeason: string;
}


function getHistoricalReplayControlRef(leagueId: string) {
  return db.doc(`leagues/${leagueId}/historicalReplay/control`);
}

function getHistoricalReplayAssetRef(leagueId: string, assetKey: string) {
  return db.doc(`leagues/${leagueId}/historicalReplayAssets/${assetKey}`);
}

function normalizeReplayControl(value: DocumentData | undefined): HistoricalReplayControl {
  return {
    enabled: value?.['enabled'] === true,
    status:
      value?.['status'] === 'advancing' ||
      value?.['status'] === 'ready' ||
      value?.['status'] === 'error'
        ? value['status']
        : 'inactive',
    targetSeason:
      typeof value?.['targetSeason'] === 'string'
        ? value['targetSeason']
        : HISTORICAL_REPLAY_TARGET_SEASON,
    sourceSeason:
      typeof value?.['sourceSeason'] === 'string'
        ? value['sourceSeason']
        : HISTORICAL_REPLAY_SOURCE_SEASON,
    simulatedDate:
      typeof value?.['simulatedDate'] === 'string'
        ? value['simulatedDate']
        : null,
    seasonStartDate:
      typeof value?.['seasonStartDate'] === 'string'
        ? value['seasonStartDate']
        : null,
    daysAdvanced:
      typeof value?.['daysAdvanced'] === 'number'
        ? value['daysAdvanced']
        : 0,
    lastReleasedGameCount:
      typeof value?.['lastReleasedGameCount'] === 'number'
        ? value['lastReleasedGameCount']
        : 0,
    totalReleasedGameCount:
      typeof value?.['totalReleasedGameCount'] === 'number'
        ? value['totalReleasedGameCount']
        : 0,
    message: typeof value?.['message'] === 'string' ? value['message'] : '',
  };
}

async function getHistoricalReplayControl(
  leagueId: string,
): Promise<HistoricalReplayControl | null> {
  const snapshot = await getHistoricalReplayControlRef(leagueId).get();

  if (!snapshot.exists) {
    return null;
  }

  const control = normalizeReplayControl(snapshot.data());
  return control.enabled && control.simulatedDate ? control : null;
}

function addUtcDays(dateString: string, days: number): string {
  const date = new Date(`${dateString}T12:00:00Z`);

  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid replay date: ${dateString}`);
  }

  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getAssetTeamAbbreviation(asset: DraftableAsset): string {
  return asset.assetType === 'skater'
    ? asset.player.nhlTeamAbbreviation
    : asset.teamAbbreviation;
}

function normalizeReplayAssetMap(
  value: DocumentData | undefined,
): HistoricalReplayAssetMap | null {
  if (
    !value ||
    typeof value['assetKey'] !== 'string' ||
    !Array.isArray(value['sourceGameIds'])
  ) {
    return null;
  }

  const sourceGameIds = value['sourceGameIds'].filter(
    (entry: unknown): entry is number => typeof entry === 'number' && Number.isFinite(entry),
  );

  if (sourceGameIds.length === 0) {
    return null;
  }

  return {
    assetKey: value['assetKey'],
    assetType:
      value['assetType'] === 'team-goalie-unit'
        ? 'team-goalie-unit'
        : 'skater',
    sourceSeason:
      typeof value['sourceSeason'] === 'string'
        ? value['sourceSeason']
        : HISTORICAL_REPLAY_SOURCE_SEASON,
    sourceGameIds,
    sourceGameDates: Array.isArray(value['sourceGameDates'])
      ? value['sourceGameDates'].filter(
          (entry: unknown): entry is string => typeof entry === 'string',
        )
      : [],
    sourceTeamAbbreviations: Array.isArray(value['sourceTeamAbbreviations'])
      ? value['sourceTeamAbbreviations'].filter(
          (entry: unknown): entry is string => typeof entry === 'string',
        )
      : [],
  };
}

async function buildHistoricalSkaterTimeline(
  asset: DraftableAsset,
  sourceSeason: string,
): Promise<HistoricalReplayAssetMap> {
  if (asset.assetType !== 'skater') {
    throw new Error('A goalie unit cannot use the skater replay timeline builder.');
  }

  const gameLogResponse = await getRegularSeasonGameLog(
    asset.player.id,
    sourceSeason,
    true,
  );
  const gameLogs = [...(gameLogResponse.gameLog ?? [])].sort(
    (first, second) => first.gameDate.localeCompare(second.gameDate),
  );
  const historicalTeams = [
    ...new Set(
      gameLogs
        .map((game) => game.teamAbbrev?.toUpperCase())
        .filter((team): team is string => Boolean(team)),
    ),
  ];

  if (historicalTeams.length === 0) {
    historicalTeams.push(asset.player.nhlTeamAbbreviation.toUpperCase());
  }

  const schedules = new Map<string, NhlTeamSeasonGame[]>();

  for (const team of historicalTeams) {
    schedules.set(team, await getNhlTeamSeasonSchedule(team, sourceSeason));
  }

  const segments: Array<{ team: string; startDate: string | null }> = [];

  for (const game of gameLogs) {
    const team = game.teamAbbrev?.toUpperCase();

    if (!team || segments.at(-1)?.team === team) {
      continue;
    }

    segments.push({
      team,
      startDate: segments.length === 0 ? null : game.gameDate,
    });
  }

  if (segments.length === 0) {
    segments.push({
      team: historicalTeams[0],
      startDate: null,
    });
  }

  const timeline: NhlTeamSeasonGame[] = [];
  const seenGameIds = new Set<number>();

  segments.forEach((segment, index) => {
    const nextStartDate = segments[index + 1]?.startDate ?? null;
    const schedule = schedules.get(segment.team) ?? [];

    for (const game of schedule) {
      const afterSegmentStart = !segment.startDate || game.gameDate >= segment.startDate;
      const beforeNextSegment = !nextStartDate || game.gameDate < nextStartDate;

      if (afterSegmentStart && beforeNextSegment && !seenGameIds.has(game.id)) {
        seenGameIds.add(game.id);
        timeline.push(game);
      }
    }
  });

  timeline.sort((first, second) => first.gameDate.localeCompare(second.gameDate));

  // If transaction timing produces a short timeline, retain every historical
  // appearance as a deterministic fallback instead of inventing statistics.
  for (const log of gameLogs) {
    if (!seenGameIds.has(log.gameId)) {
      seenGameIds.add(log.gameId);
      timeline.push({
        id: log.gameId,
        gameDate: log.gameDate,
        gameType: 2,
        gameState: 'FINAL',
        homeTeam: { abbrev: log.homeRoadFlag === 'H' ? log.teamAbbrev : log.opponentAbbrev },
        awayTeam: { abbrev: log.homeRoadFlag === 'R' ? log.teamAbbrev : log.opponentAbbrev },
      });
    }
  }

  timeline.sort((first, second) => first.gameDate.localeCompare(second.gameDate));

  return {
    assetKey: asset.assetKey,
    assetType: 'skater',
    sourceSeason,
    sourceGameIds: timeline.map((game) => game.id).slice(0, 82),
    sourceGameDates: timeline.map((game) => game.gameDate).slice(0, 82),
    sourceTeamAbbreviations: timeline.map((game) => {
      const matchingLog = gameLogs.find((entry) => entry.gameId === game.id);
      return matchingLog?.teamAbbrev?.toUpperCase() ?? historicalTeams[0];
    }).slice(0, 82),
  };
}

async function buildHistoricalReplayAssetMap(
  leagueId: string,
  asset: DraftableAsset,
  sourceSeason: string,
): Promise<HistoricalReplayAssetMap> {
  const reference = getHistoricalReplayAssetRef(leagueId, asset.assetKey);
  const snapshot = await reference.get();
  const existing = normalizeReplayAssetMap(snapshot.data());

  if (existing?.sourceSeason === sourceSeason) {
    return existing;
  }

  let mapping: HistoricalReplayAssetMap;

  if (asset.assetType === 'team-goalie-unit') {
    const schedule = await getNhlTeamSeasonSchedule(
      asset.teamAbbreviation,
      sourceSeason,
    );

    mapping = {
      assetKey: asset.assetKey,
      assetType: 'team-goalie-unit',
      sourceSeason,
      sourceGameIds: schedule.map((game) => game.id),
      sourceGameDates: schedule.map((game) => game.gameDate),
      sourceTeamAbbreviations: schedule.map(() => asset.teamAbbreviation),
    };
  } else {
    mapping = await buildHistoricalSkaterTimeline(asset, sourceSeason);
  }

  await reference.set(
    {
      ...mapping,
      schemaVersion: 1,
      playerId: asset.assetType === 'skater' ? asset.player.id : null,
      currentTeamAbbreviation: getAssetTeamAbbreviation(asset),
      createdAt: snapshot.exists
        ? snapshot.data()?.['createdAt'] ?? FieldValue.serverTimestamp()
        : FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return mapping;
}

async function buildReplayGamesByAssetKey(
  leagueId: string,
  picks: DraftPick[],
  control: HistoricalReplayControl,
): Promise<Record<string, NhlTeamSeasonGame[]>> {
  const uniqueAssets = new Map<string, DraftableAsset>();

  for (const pick of picks) {
    uniqueAssets.set(pick.asset.assetKey, pick.asset);
  }

  const assets = [...uniqueAssets.values()];
  const targetTeams = [
    ...new Set(assets.map((asset) => getAssetTeamAbbreviation(asset).toUpperCase())),
  ];
  const targetSchedules = new Map<string, NhlTeamSeasonGame[]>();

  for (let index = 0; index < targetTeams.length; index += 6) {
    const batch = targetTeams.slice(index, index + 6);
    const schedules = await Promise.all(
      batch.map((team) => getNhlTeamSeasonSchedule(team, control.targetSeason)),
    );

    batch.forEach((team, batchIndex) => {
      targetSchedules.set(team, schedules[batchIndex]);
    });
  }

  const mappings = new Map<string, HistoricalReplayAssetMap>();

  for (let index = 0; index < assets.length; index += 6) {
    const batch = assets.slice(index, index + 6);
    const batchMappings = await Promise.all(
      batch.map((asset) =>
        buildHistoricalReplayAssetMap(leagueId, asset, control.sourceSeason),
      ),
    );

    batch.forEach((asset, batchIndex) => {
      mappings.set(asset.assetKey, batchMappings[batchIndex]);
    });
  }

  const result: Record<string, NhlTeamSeasonGame[]> = {};

  for (const asset of assets) {
    const targetTeam = getAssetTeamAbbreviation(asset).toUpperCase();
    const targetSchedule = targetSchedules.get(targetTeam) ?? [];
    const mapping = mappings.get(asset.assetKey);

    if (!mapping) {
      continue;
    }

    result[asset.assetKey] = targetSchedule
      .map((targetGame, index): NhlTeamSeasonGame | null => {
        const sourceGameId = mapping.sourceGameIds[index];

        if (!sourceGameId) {
          return null;
        }

        const released = targetGame.gameDate <= (control.simulatedDate ?? '0000-00-00');

        return {
          ...targetGame,
          id: sourceGameId,
          gameState: released ? 'FINAL' : 'FUT',
          homeTeam: {
            abbrev: targetGame.homeTeam.abbrev,
          },
          awayTeam: {
            abbrev: targetGame.awayTeam.abbrev,
          },
        };
      })
      .filter((game): game is NhlTeamSeasonGame => Boolean(game));
  }

  return result;
}

async function buildReplayRunContext(
  leagueId: string,
  picks: DraftPick[],
  control: HistoricalReplayControl,
): Promise<ReplayRunContext> {
  return {
    control,
    gamesByAssetKey: await buildReplayGamesByAssetKey(leagueId, picks, control),
    snapshotSeason: `replay-${control.targetSeason}-from-${control.sourceSeason}`,
  };
}

async function getHistoricalReplaySeasonStartDate(targetSeason: string): Promise<string> {
  let earliestDate = '';

  for (let index = 0; index < HISTORICAL_REPLAY_TEAMS.length; index += 4) {
    const batch = HISTORICAL_REPLAY_TEAMS.slice(index, index + 4);
    const schedules = await Promise.all(
      batch.map((team) => getNhlTeamSeasonSchedule(team, targetSeason)),
    );

    for (const schedule of schedules) {
      const firstDate = schedule[0]?.gameDate;

      if (firstDate && (!earliestDate || firstDate < earliestDate)) {
        earliestDate = firstDate;
      }
    }
  }

  if (!earliestDate) {
    throw new Error(`No regular-season NHL schedule was found for ${targetSeason}.`);
  }

  return earliestDate;
}

async function countNhlGamesOnReplayDate(
  date: string,
  targetSeason: string,
): Promise<number> {
  const gameIds = new Set<number>();

  for (let index = 0; index < HISTORICAL_REPLAY_TEAMS.length; index += 4) {
    const batch = HISTORICAL_REPLAY_TEAMS.slice(index, index + 4);
    const schedules = await Promise.all(
      batch.map((team) => getNhlTeamSeasonSchedule(team, targetSeason)),
    );

    for (const schedule of schedules) {
      for (const game of schedule) {
        if (game.gameDate === date) {
          gameIds.add(game.id);
        }
      }
    }
  }

  return gameIds.size;
}

function getControlRef(leagueId: string) {
  return db.doc(`leagues/${leagueId}/liveScoring/control`);
}

function getCycleSnapshotRef(leagueId: string, cycleNumber: number) {
  return db.doc(`leagues/${leagueId}/liveScoring/cycle-${cycleNumber}`);
}

function normalizeScoringRules(value: unknown, version: unknown): ScoringRules {
  const stored = value && typeof value === 'object'
    ? value as Partial<ScoringRules>
    : {};

  const normalized: ScoringRules = {
    ...defaultScoringRules,
    ...stored,
    forward: {
      ...defaultScoringRules.forward,
      ...(stored.forward ?? {}),
      goal: {
        ...defaultScoringRules.forward.goal,
        ...(stored.forward?.goal ?? {}),
      },
      primaryAssist: {
        ...defaultScoringRules.forward.primaryAssist,
        ...(stored.forward?.primaryAssist ?? {}),
      },
      secondaryAssist: {
        ...defaultScoringRules.forward.secondaryAssist,
        ...(stored.forward?.secondaryAssist ?? {}),
      },
    },
    defense: {
      ...defaultScoringRules.defense,
      ...(stored.defense ?? {}),
      goal: {
        ...defaultScoringRules.defense.goal,
        ...(stored.defense?.goal ?? {}),
      },
      primaryAssist: {
        ...defaultScoringRules.defense.primaryAssist,
        ...(stored.defense?.primaryAssist ?? {}),
      },
      secondaryAssist: {
        ...defaultScoringRules.defense.secondaryAssist,
        ...(stored.defense?.secondaryAssist ?? {}),
      },
    },
    goalieSavePercentageTiers:
      Array.isArray(stored.goalieSavePercentageTiers) &&
      stored.goalieSavePercentageTiers.length > 0
        ? stored.goalieSavePercentageTiers
        : defaultScoringRules.goalieSavePercentageTiers,
  };

  if (typeof version !== 'number' || version < CURRENT_SCORING_RULES_VERSION) {
    normalized.defense = {
      ...defaultScoringRules.defense,
      goal: { ...defaultScoringRules.defense.goal },
      primaryAssist: { ...defaultScoringRules.defense.primaryAssist },
      secondaryAssist: { ...defaultScoringRules.defense.secondaryAssist },
    };
    normalized.defenseToiBaseMultiplier = defaultScoringRules.defenseToiBaseMultiplier;
    normalized.defenseToiPlusMinusModifier = defaultScoringRules.defenseToiPlusMinusModifier;
    normalized.defenseToiFloor = defaultScoringRules.defenseToiFloor;
    normalized.defenseToiCeiling = defaultScoringRules.defenseToiCeiling;

    normalized.goalieGameBase = defaultScoringRules.goalieGameBase;
    normalized.goalieSave = defaultScoringRules.goalieSave;
    normalized.goalieWin = defaultScoringRules.goalieWin;
    normalized.goalieShutout = defaultScoringRules.goalieShutout;
    normalized.goalieSavePercentageBaseline =
      defaultScoringRules.goalieSavePercentageBaseline;
    normalized.goalieSavePercentageBasePoints =
      defaultScoringRules.goalieSavePercentageBasePoints;
    normalized.goalieSavePercentagePointsPerPercentagePoint =
      defaultScoringRules.goalieSavePercentagePointsPerPercentagePoint;
    normalized.goalieSavePercentageMinimum =
      defaultScoringRules.goalieSavePercentageMinimum;
    normalized.goalieSavePercentageMaximum =
      defaultScoringRules.goalieSavePercentageMaximum;
    normalized.goalieGameMaximum = defaultScoringRules.goalieGameMaximum;
  }

  return normalized;
}

async function getServerLeague(leagueId: string): Promise<ServerLeague | null> {
  const snapshot = await db.doc(`leagues/${leagueId}`).get();

  if (!snapshot.exists) {
    return null;
  }

  const data = snapshot.data() ?? {};

  return {
    id: leagueId,
    commissionerId:
      typeof data['commissionerId'] === 'string'
        ? data['commissionerId']
        : '',
    scoringRules: normalizeScoringRules(data['scoringRules'], data['scoringRulesVersion']),
    scoringRulesVersion:
      typeof data['scoringRulesVersion'] === 'number'
        ? data['scoringRulesVersion']
        : 0,
  };
}

function getNhlSeasonForDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const seasonStartYear = month >= 7 ? year : year - 1;

  return `${seasonStartYear}${seasonStartYear + 1}`;
}

function toMilliseconds(value: unknown): number {
  if (value instanceof Timestamp) {
    return value.toMillis();
  }

  if (
    value &&
    typeof value === 'object' &&
    'toMillis' in value &&
    typeof (value as { toMillis?: unknown }).toMillis === 'function'
  ) {
    return (value as { toMillis: () => number }).toMillis();
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

async function claimLeagueAutomationLease(
  leagueId: string,
  workerId: string,
  force: boolean,
): Promise<LeaseClaimResult> {
  const controlRef = getControlRef(leagueId);
  const now = Date.now();

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(controlRef);
    const data = snapshot.data() ?? {};
    const holderClientId =
      typeof data['holderClientId'] === 'string'
        ? data['holderClientId']
        : '';
    const leaseExpiresAt = toMilliseconds(data['leaseExpiresAt']);
    const nextRefreshAt = toMilliseconds(data['nextRefreshAt']);
    const currentStatus =
      typeof data['status'] === 'string'
        ? data['status']
        : '';
    const anotherServerWorkerOwnsLease =
      currentStatus === 'refreshing' &&
      holderClientId.startsWith(SERVER_WORKER_PREFIX) &&
      holderClientId !== workerId &&
      leaseExpiresAt > now;

    if (anotherServerWorkerOwnsLease) {
      return {
        claimed: false,
        reason: 'another-server-worker',
      };
    }

    if (!force && nextRefreshAt > now) {
      return {
        claimed: false,
        reason: 'not-due',
      };
    }

    transaction.set(
      controlRef,
      {
        id: 'control',
        schemaVersion: 2,
        automationMode: 'server',
        serverAutomationEnabled: true,
        status: 'refreshing',
        holderUserId: null,
        holderClientId: workerId,
        leaseExpiresAt: Timestamp.fromMillis(
          now + SERVER_LEASE_MILLISECONDS,
        ),
        lastRefreshStartedAt: FieldValue.serverTimestamp(),
        lastRefreshReason: 'scheduled',
        serverTrigger: force ? 'draft-complete' : 'scheduled',
        lastError: '',
        updatedAt: FieldValue.serverTimestamp(),
        ...(!snapshot.exists
          ? {
              nextRefreshAt: Timestamp.fromMillis(now),
              lastRefreshCompletedAt: null,
            }
          : {}),
      },
      { merge: true },
    );

    return {
      claimed: true,
      reason: 'claimed',
    };
  });
}

async function getPreviousScoringSnapshot(
  leagueId: string,
  cycleNumber: number,
): Promise<PreviousScoringSnapshot | null> {
  const snapshot = await getCycleSnapshotRef(leagueId, cycleNumber).get();

  if (!snapshot.exists) {
    return null;
  }

  const data = snapshot.data() ?? {};
  const result = data['result'] as CycleScoringResult | undefined;

  if (
    !result ||
    result.scoringSchemaVersion !== 2 ||
    typeof data['scoringFingerprint'] !== 'string'
  ) {
    return null;
  }

  return {
    season: typeof data['season'] === 'string' ? data['season'] : '',
    scoringFingerprint: data['scoringFingerprint'],
    scoringRulesFingerprint:
      typeof data['scoringRulesFingerprint'] === 'string'
        ? data['scoringRulesFingerprint']
        : '',
    result,
    createdAt: data['createdAt'],
  };
}

async function publishCycleSnapshot(
  leagueId: string,
  workerId: string,
  cycle: FantasyCycle,
  season: string,
  result: CycleScoringResult,
  scoringRulesFingerprint: string,
  previous: PreviousScoringSnapshot | null,
): Promise<boolean> {
  const scoringFingerprint =
    `${scoringRulesFingerprint}::${result.dataFingerprint}`;

  if (previous?.scoringFingerprint === scoringFingerprint) {
    return false;
  }

  const snapshot: SharedCycleScoringSnapshot = {
    id: `cycle-${cycle.cycleNumber}`,
    schemaVersion: 1,
    leagueId,
    cycleNumber: cycle.cycleNumber,
    season,
    scoringFingerprint,
    scoringRulesFingerprint,
    result,
    workerUserId: 'server',
    workerClientId: workerId,
  };

  await getCycleSnapshotRef(leagueId, cycle.cycleNumber).set(
    {
      ...snapshot,
      refreshedAt: FieldValue.serverTimestamp(),
      createdAt: previous?.createdAt ?? FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return true;
}

function allCycleTeamsComplete(result: CycleScoringResult): boolean {
  const values = Object.values(result.teamCycleComplete);
  return values.length > 0 && values.every(Boolean);
}

async function persistServerScoring(
  leagueId: string,
  teams: FantasyTeam[],
  cycle: FantasyCycle,
  picks: DraftPick[],
  result: CycleScoringResult,
  season: string,
  scoringRules: ScoringRules,
  replayGamesByAssetKey?: Record<string, NhlTeamSeasonGame[]>,
  gameLogSeason?: string,
): Promise<boolean> {
  const matchups = await getCycleMatchupsOnce(
    leagueId,
    cycle.cycleNumber,
  );

  await syncCycleTeamWindows(leagueId, cycle, picks, result);

  if (matchups.length > 0) {
    await updateCycleMatchupScores(
      leagueId,
      cycle.cycleNumber,
      matchups,
      result.teamScores,
    );
  }

  if (cycle.phase === 'regular_season') {
    const completion =
      await reconcileRegularSeasonCycleMatchupCompletion(
        leagueId,
        cycle.cycleNumber,
      );

    await advanceCompletedRegularSeasonAssetWindows(
      leagueId,
      teams,
      cycle,
      picks,
      result,
    );

    if (completion.cycleCompleted) {
      await startNextCycle(
        leagueId,
        teams,
        cycle.cycleNumber,
      ).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : '';

        if (
          !message.includes('already') &&
          !message.includes('does not have any playable matchups')
        ) {
          throw error;
        }
      });
    }

    return completion.cycleCompleted;
  }

  const playoffs = await getFantasyPlayoffs(leagueId);

  if (playoffs) {
    const banks = await syncPlayoffWindowBankScores({
      leagueId,
      playoffs,
      season,
      requiredGamesPerCycle:
        scoringRules.requiredGamesPerCycle ??
        defaultScoringRules.requiredGamesPerCycle,
      scoringRules,
      assignedPicks: picks,
      assignedScoring: result,
      replayGamesByAssetKey,
      gameLogSeason,
    });

    await ensureNextPlayoffBankWindows({
      leagueId,
      playoffs,
      banks,
    });
  }

  if (!allCycleTeamsComplete(result) || matchups.length === 0) {
    return false;
  }

  try {
    await completeCycle(
      leagueId,
      cycle.cycleNumber,
      matchups,
      result.teamScores,
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '';

    if (!message.includes('already been completed')) {
      throw error;
    }
  }

  await startNextCycle(
    leagueId,
    teams,
    cycle.cycleNumber,
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : '';

    if (
      !message.includes('already') &&
      !message.includes('playoffs have already been completed')
    ) {
      throw error;
    }
  });

  return true;
}

function getLiveScoringRefreshDelay(
  results: Array<Pick<CycleScoringResult, 'hasLiveGames' | 'nextScheduledGameStart'>>,
  transitionOccurred: boolean,
  nowMilliseconds = Date.now(),
): number {
  if (transitionOccurred || results.some((result) => result.hasLiveGames)) {
    return LIVE_REFRESH_INTERVAL_MILLISECONDS;
  }

  const nextStart = results
    .map((result) => result.nextScheduledGameStart)
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter(Number.isFinite)
    .sort((first, second) => first - second)[0];

  if (typeof nextStart === 'number') {
    const untilStart = nextStart - nowMilliseconds;

    if (untilStart <= 0) {
      return LIVE_REFRESH_INTERVAL_MILLISECONDS;
    }

    return Math.max(
      LIVE_REFRESH_INTERVAL_MILLISECONDS,
      Math.min(
        untilStart + 2 * 60 * 1000,
        NEAR_GAME_REFRESH_MAX_MILLISECONDS,
      ),
    );
  }

  return IDLE_REFRESH_INTERVAL_MILLISECONDS;
}

async function ensureCycleOneStarted(
  leagueId: string,
  teams?: FantasyTeam[],
): Promise<boolean> {
  const [draftSnapshot, cycleSnapshot] = await Promise.all([
    db.doc(`leagues/${leagueId}/draft/current`).get(),
    db.doc(`leagues/${leagueId}/cycles/cycle-1`).get(),
  ]);

  if (cycleSnapshot.exists || !draftSnapshot.exists) {
    return false;
  }

  const draft = draftSnapshot.data() as FantasyDraft;

  if (draft.status !== 'complete') {
    return false;
  }

  const leagueTeams = teams ?? await getLeagueTeams(leagueId);

  if (leagueTeams.length < 2) {
    throw new Error(
      'The draft completed, but at least two teams are required to create Cycle 1.',
    );
  }

  try {
    await startCycleOne(leagueId, leagueTeams);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '';

    if (!message.includes('already been started')) {
      throw error;
    }

    return false;
  }

  await db.doc(`leagues/${leagueId}/draft/current`).set(
    {
      cycleOneStartedAt: FieldValue.serverTimestamp(),
      cycleOneStartSource: 'server-draft-complete',
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return true;
}

async function runLeagueAutomation(
  leagueId: string,
  force: boolean,
  trigger: 'scheduled' | 'draft-complete' | 'historical-replay',
): Promise<LeagueAutomationResult> {
  const startedAt = Date.now();
  const workerId = `${SERVER_WORKER_PREFIX}${randomUUID()}`;
  const lease = await claimLeagueAutomationLease(
    leagueId,
    workerId,
    force,
  );

  if (!lease.claimed) {
    return {
      leagueId,
      status: 'skipped',
      activeCycleNumbers: [],
      publishedSnapshotCount: 0,
      skippedSnapshotCount: 0,
      cycleOneCreated: false,
      durationMilliseconds: Date.now() - startedAt,
    };
  }

  let publishedSnapshotCount = 0;
  let skippedSnapshotCount = 0;
  let cycleOneCreated = false;
  let activeCycleNumbers: number[] = [];
  let transitionOccurred = false;
  let replayControl: HistoricalReplayControl | null = null;
  const allResults: CycleScoringResult[] = [];

  try {
    const league = await getServerLeague(leagueId);

    if (!league) {
      throw new Error('League not found for server automation.');
    }

    const teams = await getLeagueTeams(leagueId);
    cycleOneCreated = await ensureCycleOneStarted(leagueId, teams);
    replayControl = await getHistoricalReplayControl(leagueId);
    const liveSeason = getNhlSeasonForDate(new Date());
    const dataSeason = replayControl?.sourceSeason ?? liveSeason;
    const snapshotSeason = replayControl
      ? `replay-${replayControl.targetSeason}-from-${replayControl.sourceSeason}`
      : liveSeason;
    const scoringRules = league.scoringRules;
    const requiredGamesPerCycle =
      scoringRules.requiredGamesPerCycle ??
      defaultScoringRules.requiredGamesPerCycle;
    const scoringRulesFingerprint = JSON.stringify(scoringRules);
    let previousCycleNumbers = new Set<number>();

    for (
      let pass = 0;
      pass < MAX_TRANSITION_PASSES;
      pass += 1
    ) {
      const activeCycles = await getActiveLeagueCycles(leagueId);
      activeCycleNumbers = activeCycles.map((cycle) => cycle.cycleNumber);
      const newCycleNumbers = activeCycleNumbers.filter(
        (cycleNumber) => !previousCycleNumbers.has(cycleNumber),
      );

      if (pass > 0 && newCycleNumbers.length === 0) {
        break;
      }

      previousCycleNumbers = new Set(activeCycleNumbers);
      let passTransitionOccurred = false;

      for (const cycle of activeCycles) {
        const picks = await getCycleRosterPicksOnce(
          leagueId,
          cycle.cycleNumber,
        );

        if (picks.length === 0) {
          continue;
        }

        const previous = await getPreviousScoringSnapshot(
          leagueId,
          cycle.cycleNumber,
        );
        const replayContext = replayControl
          ? await buildReplayRunContext(leagueId, picks, replayControl)
          : null;
        const result = await calculateCycleScoring({
          picks,
          cycleNumber: cycle.cycleNumber,
          season: dataSeason,
          requiredGamesPerCycle,
          scoringRules,
          expectedRosterSlotIdsByOwner:
            cycle.expectedRosterSlotIdsByOwner ?? {},
          previousResult:
            previous?.season === snapshotSeason &&
            previous.scoringRulesFingerprint === scoringRulesFingerprint
              ? previous.result
              : null,
          replayGamesByAssetKey: replayContext?.gamesByAssetKey,
          gameLogSeason: replayControl?.sourceSeason,
        });
        const published = await publishCycleSnapshot(
          leagueId,
          workerId,
          cycle,
          snapshotSeason,
          result,
          scoringRulesFingerprint,
          previous,
        );

        if (published) {
          publishedSnapshotCount += 1;
        } else {
          skippedSnapshotCount += 1;
        }

        allResults.push(result);

        const changedPeriod = await persistServerScoring(
          leagueId,
          teams,
          cycle,
          picks,
          result,
          dataSeason,
          scoringRules,
          replayContext?.gamesByAssetKey,
          replayControl?.sourceSeason,
        );

        passTransitionOccurred =
          passTransitionOccurred || changedPeriod;
      }

      const refreshedActiveCycles = await getActiveLeagueCycles(leagueId);
      const refreshedCycleNumbers = refreshedActiveCycles.map(
        (cycle) => cycle.cycleNumber,
      );
      const openedNewCycle = refreshedCycleNumbers.some(
        (cycleNumber) => !previousCycleNumbers.has(cycleNumber),
      );

      transitionOccurred =
        transitionOccurred ||
        passTransitionOccurred ||
        openedNewCycle;

      if (!passTransitionOccurred && !openedNewCycle) {
        activeCycleNumbers = refreshedCycleNumbers;
        break;
      }
    }

    const refreshDelay = getLiveScoringRefreshDelay(
      allResults,
      transitionOccurred,
    );

    await getControlRef(leagueId).set(
      {
        id: 'control',
        schemaVersion: 2,
        automationMode: replayControl ? 'historical-replay' : 'server',
        serverAutomationEnabled: true,
        historicalReplayEnabled: Boolean(replayControl),
        historicalReplayDate: replayControl?.simulatedDate ?? null,
        status: 'idle',
        holderUserId: null,
        holderClientId: '',
        leaseExpiresAt: Timestamp.fromMillis(Date.now()),
        nextRefreshAt: Timestamp.fromMillis(
          Date.now() + refreshDelay,
        ),
        lastRefreshCompletedAt: FieldValue.serverTimestamp(),
        lastRefreshReason: 'scheduled',
        serverTrigger: trigger,
        serverHeartbeatAt: FieldValue.serverTimestamp(),
        lastRefreshDurationMs: Math.max(0, Date.now() - startedAt),
        lastPublishedSnapshotCount: publishedSnapshotCount,
        lastSkippedSnapshotWriteCount: skippedSnapshotCount,
        totalSuccessfulRefreshCount: FieldValue.increment(1),
        totalPublishedSnapshotCount:
          FieldValue.increment(publishedSnapshotCount),
        totalSkippedSnapshotWriteCount:
          FieldValue.increment(skippedSnapshotCount),
        activeCycleNumbers,
        cycleOneCreatedInLastRun: cycleOneCreated,
        lastError: '',
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return {
      leagueId,
      status: 'success',
      activeCycleNumbers,
      publishedSnapshotCount,
      skippedSnapshotCount,
      cycleOneCreated,
      durationMilliseconds: Date.now() - startedAt,
    };
  } catch (error: unknown) {
    const message = error instanceof Error
      ? error.message
      : 'Server league automation failed.';

    await getControlRef(leagueId).set(
      {
        id: 'control',
        schemaVersion: 2,
        automationMode: replayControl ? 'historical-replay' : 'server',
        serverAutomationEnabled: true,
        historicalReplayEnabled: Boolean(replayControl),
        historicalReplayDate: replayControl?.simulatedDate ?? null,
        status: 'error',
        holderUserId: null,
        holderClientId: '',
        leaseExpiresAt: Timestamp.fromMillis(Date.now()),
        nextRefreshAt: Timestamp.fromMillis(
          Date.now() + ERROR_RETRY_INTERVAL_MILLISECONDS,
        ),
        lastRefreshReason: 'scheduled',
        serverTrigger: trigger,
        serverHeartbeatAt: FieldValue.serverTimestamp(),
        lastError: message.slice(0, 500),
        totalFailedRefreshCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    ).catch(() => undefined);

    throw error;
  }
}

async function getCompletedDraftLeagueIds(): Promise<string[]> {
  const leagueSnapshot = await db.collection('leagues').get();
  const leagueIds: string[] = [];
  const batchSize = 100;

  for (
    let index = 0;
    index < leagueSnapshot.docs.length;
    index += batchSize
  ) {
    const leagueDocuments = leagueSnapshot.docs.slice(
      index,
      index + batchSize,
    );
    const draftReferences = leagueDocuments.map((leagueDocument) =>
      leagueDocument.ref.collection('draft').doc('current')
    );
    const draftSnapshots = draftReferences.length > 0
      ? await db.getAll(...draftReferences)
      : [];

    draftSnapshots.forEach((draftSnapshot, draftIndex) => {
      if (
        draftSnapshot.exists &&
        draftSnapshot.data()?.['status'] === 'complete'
      ) {
        leagueIds.push(leagueDocuments[draftIndex].id);
      }
    });
  }

  return leagueIds.sort();
}

async function mapWithConcurrency<T>(
  values: string[],
  worker: (value: string) => Promise<T>,
): Promise<Array<PromiseSettledResult<T>>> {
  const results: Array<PromiseSettledResult<T>> = [];
  let nextIndex = 0;

  async function consume(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;

      try {
        const value = await worker(values[index]);
        results[index] = {
          status: 'fulfilled',
          value,
        };
      } catch (reason: unknown) {
        results[index] = {
          status: 'rejected',
          reason,
        };
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(MAX_PARALLEL_LEAGUES, values.length) },
      () => consume(),
    ),
  );

  return results;
}

export const runScheduledLeagueAutomation = onSchedule(
  {
    schedule: 'every 10 minutes',
    region: FUNCTION_REGION,
    timeoutSeconds: 540,
    memory: '1GiB',
    retryCount: 0,
  },
  async () => {
    const startedAt = Date.now();
    const leagueIds = await getCompletedDraftLeagueIds();
    const results = await mapWithConcurrency(
      leagueIds,
      (leagueId) => runLeagueAutomation(
        leagueId,
        false,
        'scheduled',
      ),
    );
    const successful = results.filter(
      (result) =>
        result.status === 'fulfilled' &&
        result.value.status === 'success',
    ).length;
    const skipped = results.filter(
      (result) =>
        result.status === 'fulfilled' &&
        result.value.status === 'skipped',
    ).length;
    const failed = results.filter(
      (result) => result.status === 'rejected',
    ).length;

    await db.doc('appData/leagueAutomation').set(
      {
        schemaVersion: 1,
        status: failed > 0 ? 'partial-error' : 'success',
        completedDraftLeagueCount: leagueIds.length,
        successfulLeagueCount: successful,
        skippedLeagueCount: skipped,
        failedLeagueCount: failed,
        durationMilliseconds: Date.now() - startedAt,
        lastRunAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('A scheduled league automation run failed.', result.reason);
      }
    }
  },
);

export const initializeSeasonAfterDraft = onDocumentWritten(
  {
    document: 'leagues/{leagueId}/draft/current',
    region: FUNCTION_REGION,
    timeoutSeconds: 540,
    memory: '1GiB',
    retry: false,
  },
  async (event) => {
    const beforeStatus = event.data?.before.exists
      ? (event.data.before.data() as DocumentData)['status']
      : null;
    const afterStatus = event.data?.after.exists
      ? (event.data.after.data() as DocumentData)['status']
      : null;

    if (afterStatus !== 'complete' || beforeStatus === 'complete') {
      return;
    }

    await runLeagueAutomation(
      event.params.leagueId,
      true,
      'draft-complete',
    );
  },
);

export const advanceHistoricalReplayDay = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 540,
    memory: '1GiB',
  },
  async (request) => {
    const userId = request.auth?.uid;
    const leagueId =
      request.data && typeof request.data.leagueId === 'string'
        ? request.data.leagueId.trim()
        : '';

    if (!userId) {
      throw new HttpsError('unauthenticated', 'You must be signed in to advance the replay.');
    }

    if (!leagueId) {
      throw new HttpsError('invalid-argument', 'A league id is required.');
    }

    const league = await getServerLeague(leagueId);

    if (!league) {
      throw new HttpsError('not-found', 'League not found.');
    }

    if (league.commissionerId !== userId) {
      throw new HttpsError(
        'permission-denied',
        'Only the league commissioner can advance historical replay time.',
      );
    }

    const draftSnapshot = await db.doc(`leagues/${leagueId}/draft/current`).get();

    if (!draftSnapshot.exists || draftSnapshot.data()?.['status'] !== 'complete') {
      throw new HttpsError(
        'failed-precondition',
        'Complete the draft before starting the historical season replay.',
      );
    }

    const controlRef = getHistoricalReplayControlRef(leagueId);
    const controlSnapshot = await controlRef.get();
    const previous = normalizeReplayControl(controlSnapshot.data());

    try {
      const seasonStartDate = previous.seasonStartDate ??
        await getHistoricalReplaySeasonStartDate(HISTORICAL_REPLAY_TARGET_SEASON);
      const currentDate = previous.enabled && previous.simulatedDate
        ? previous.simulatedDate
        : addUtcDays(seasonStartDate, -1);
      const nextDate = addUtcDays(currentDate, 1);
      const releasedGameCount = await countNhlGamesOnReplayDate(
        nextDate,
        HISTORICAL_REPLAY_TARGET_SEASON,
      );

      await Promise.all([
        controlRef.set(
          {
            schemaVersion: 1,
            enabled: true,
            status: 'advancing',
            targetSeason: HISTORICAL_REPLAY_TARGET_SEASON,
            sourceSeason: HISTORICAL_REPLAY_SOURCE_SEASON,
            seasonStartDate,
            simulatedDate: nextDate,
            daysAdvanced: previous.enabled ? previous.daysAdvanced + 1 : 1,
            lastReleasedGameCount: releasedGameCount,
            totalReleasedGameCount:
              (previous.enabled ? previous.totalReleasedGameCount : 0) + releasedGameCount,
            requestedBy: userId,
            lastAdvanceStartedAt: FieldValue.serverTimestamp(),
            message: `Processing the simulated NHL date ${nextDate}.`,
            lastError: '',
            createdAt: controlSnapshot.exists
              ? controlSnapshot.data()?.['createdAt'] ?? FieldValue.serverTimestamp()
              : FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        ),
        getControlRef(leagueId).set(
          {
            id: 'control',
            schemaVersion: 2,
            automationMode: 'historical-replay',
            serverAutomationEnabled: true,
            historicalReplayEnabled: true,
            historicalReplayDate: nextDate,
            nextRefreshAt: Timestamp.fromMillis(Date.now()),
            refreshRequestedAt: FieldValue.serverTimestamp(),
            lastRefreshReason: 'manual',
            lastError: '',
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        ),
      ]);

      const result = await runLeagueAutomation(
        leagueId,
        true,
        'historical-replay',
      );

      if (result.status === 'skipped') {
        throw new HttpsError(
          'aborted',
          'Another server scoring update is currently finishing. Wait a moment and press Advance One Day again.',
        );
      }

      const message = releasedGameCount > 0
        ? `${nextDate} processed. ${releasedGameCount} NHL ${releasedGameCount === 1 ? 'game was' : 'games were'} released into the replay ledger.`
        : `${nextDate} processed. No NHL games were scheduled, so individual player windows remained where they were.`;

      await controlRef.set(
        {
          status: 'ready',
          lastAdvanceCompletedAt: FieldValue.serverTimestamp(),
          lastActiveCycleNumbers: result.activeCycleNumbers,
          lastPublishedSnapshotCount: result.publishedSnapshotCount,
          message,
          lastError: '',
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      return {
        enabled: true,
        status: 'ready',
        simulatedDate: nextDate,
        seasonStartDate,
        targetSeason: HISTORICAL_REPLAY_TARGET_SEASON,
        sourceSeason: HISTORICAL_REPLAY_SOURCE_SEASON,
        daysAdvanced: previous.enabled ? previous.daysAdvanced + 1 : 1,
        releasedGameCount,
        activeCycleNumbers: result.activeCycleNumbers,
        message,
      };
    } catch (error: unknown) {
      const message = error instanceof Error
        ? error.message
        : 'Unable to advance the historical replay.';

      await controlRef.set(
        {
          enabled: true,
          status: 'error',
          message,
          lastError: message.slice(0, 500),
          lastAdvanceFailedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      ).catch(() => undefined);

      if (error instanceof HttpsError) {
        throw error;
      }

      throw new HttpsError('unavailable', message);
    }
  },
);
