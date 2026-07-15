import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  writeBatch
} from 'firebase/firestore';

import {
  auth,
  db
} from '../firebase';

import {
  CycleScoringResult
} from '../cycle/cycle-scoring.service';

import {
  DraftPick,
  DraftPosition,
  DraftableAsset
} from '../draft/draft.models';

import {
  SHARED_PROJECTION_VERSION
} from './projection-snapshot.service';

export type ProjectionAccuracyOutcome =
  | 'under-projected'
  | 'over-projected'
  | 'on-target'
  | 'ungraded';

export interface ProjectionAccuracyAssetRecord {
  id: string;
  leagueId: string;
  cycleId: string;
  cycleNumber: number;
  ownerId: string;
  overallPick: number;

  assetKey: string;
  assetType: DraftableAsset['assetType'];
  assetName: string;
  position: DraftPosition;
  teamAbbreviation: string;

  projectionSnapshotId: string | null;
  projectionVersion: number | null;
  projectionVersionSource:
    | 'snapshot-metadata'
    | 'current-code-fallback'
    | 'unknown';

  /** Exact projection displayed on the cycle matchup page. */
  projectedCyclePoints: number | null;

  /** Unscaled shared next-cycle model output preserved for model diagnosis. */
  rawProjectedCyclePoints: number | null;

  healthyProjectedCyclePoints: number | null;
  expectedGamesAvailable: number | null;
  scheduledGamesInProjectionCycle: number | null;
  availabilityAdjustment: number | null;
  recentFormAdjustment: number | null;
  roleAdjustment: number | null;
  reliabilityRating: number | null;

  actualFantasyPoints: number;
  actualAppearances: number;
  completedTeamGames: number;
  scheduledTeamGames: number;

  signedError: number | null;
  absoluteError: number | null;
  percentageError: number | null;
  outcome: ProjectionAccuracyOutcome;

  generatedAt?: unknown;
}

export interface ProjectionAccuracyMetricGroup {
  key: string;
  label: string;
  assetCount: number;
  meanAbsoluteError: number;
  meanSignedError: number;
  medianAbsoluteError: number;
  within5Count: number;
  within5Percent: number;
  within10Count: number;
  within10Percent: number;
  within20Count: number;
  within20Percent: number;
  underProjectedCount: number;
  overProjectedCount: number;
  onTargetCount: number;
}

export interface ProjectionAccuracyCycleSummary {
  id: string;
  leagueId: string;
  cycleId: string;
  cycleNumber: number;
  status: 'ready';
  assetCount: number;
  gradedAssetCount: number;
  projectionVersions: number[];
  projectionSnapshotIds: string[];
  meanAbsoluteError: number;
  meanSignedError: number;
  medianAbsoluteError: number;
  within5Percent: number;
  within10Percent: number;
  within20Percent: number;
  generatedBy: string;
  generatedAt: string;
  completedAt?: unknown;
  updatedAt?: unknown;
}

export interface ProjectionAccuracyCycleHistory {
  summary: ProjectionAccuracyCycleSummary;
  assets: ProjectionAccuracyAssetRecord[];
}

export interface ProjectionAccuracyHistory {
  cycles: ProjectionAccuracyCycleHistory[];
  assets: ProjectionAccuracyAssetRecord[];
  summary: ProjectionAccuracyMetricGroup;
  byPosition: ProjectionAccuracyMetricGroup[];
  byVersion: ProjectionAccuracyMetricGroup[];
}

export interface SaveProjectionAccuracyInput {
  leagueId: string;
  cycleId: string;
  cycleNumber: number;
  picks: DraftPick[];
  scoring: CycleScoringResult;

  /**
   * This map should contain the exact projection displayed to managers for
   * each asset during the completed cycle.
   */
  displayedProjectionByAssetKey: Readonly<Record<string, number | null>>;
}

const MAX_HISTORY_CYCLES = 30;
const ON_TARGET_TOLERANCE = 1;

function getProjectionAccuracyCyclesRef(leagueId: string) {
  return collection(
    db,
    'leagues',
    leagueId,
    'projectionAccuracy'
  );
}

function getProjectionAccuracyCycleRef(
  leagueId: string,
  cycleId: string
) {
  return doc(
    db,
    'leagues',
    leagueId,
    'projectionAccuracy',
    cycleId
  );
}

function getProjectionAccuracyAssetsRef(
  leagueId: string,
  cycleId: string
) {
  return collection(
    db,
    'leagues',
    leagueId,
    'projectionAccuracy',
    cycleId,
    'assets'
  );
}

function getProjectionAccuracyAssetRef(
  leagueId: string,
  cycleId: string,
  recordId: string
) {
  return doc(
    getProjectionAccuracyAssetsRef(leagueId, cycleId),
    recordId
  );
}

function getCycleRef(
  leagueId: string,
  cycleId: string
) {
  return doc(
    db,
    'leagues',
    leagueId,
    'cycles',
    cycleId
  );
}

function getProjectionSnapshotRef(
  leagueId: string,
  snapshotId: string
) {
  return doc(
    db,
    'leagues',
    leagueId,
    'projectionSnapshots',
    snapshotId
  );
}

function round(value: number, digits: number = 1): number {
  return Number(value.toFixed(digits));
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : null;
}

function getAssetName(asset: DraftableAsset): string {
  return asset.assetType === 'skater'
    ? asset.player.fullName
    : asset.teamName;
}

function getAssetTeamAbbreviation(asset: DraftableAsset): string {
  return asset.assetType === 'skater'
    ? asset.player.nhlTeamAbbreviation
    : asset.teamAbbreviation;
}

function getRawCycleProjection(asset: DraftableAsset): number | null {
  return (
    toFiniteNumber(asset.availabilityAdjustedCyclePoints) ??
    toFiniteNumber(asset.projectedCyclePoints) ??
    toFiniteNumber(asset.floorAdjustedCyclePoints)
  );
}

function getAccuracyRecordId(pick: DraftPick): string {
  return pick.overallPick.toString().padStart(6, '0');
}

function getOutcome(
  signedError: number | null
): ProjectionAccuracyOutcome {
  if (signedError === null) {
    return 'ungraded';
  }

  if (Math.abs(signedError) <= ON_TARGET_TOLERANCE) {
    return 'on-target';
  }

  return signedError > 0
    ? 'under-projected'
    : 'over-projected';
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }

  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function buildMetricGroup(
  key: string,
  label: string,
  records: ProjectionAccuracyAssetRecord[]
): ProjectionAccuracyMetricGroup {
  const graded = records.filter(
    (record) =>
      typeof record.absoluteError === 'number' &&
      typeof record.signedError === 'number'
  );

  if (graded.length === 0) {
    return {
      key,
      label,
      assetCount: 0,
      meanAbsoluteError: 0,
      meanSignedError: 0,
      medianAbsoluteError: 0,
      within5Count: 0,
      within5Percent: 0,
      within10Count: 0,
      within10Percent: 0,
      within20Count: 0,
      within20Percent: 0,
      underProjectedCount: 0,
      overProjectedCount: 0,
      onTargetCount: 0
    };
  }

  const absoluteErrors = graded.map(
    (record) => record.absoluteError as number
  );

  const signedErrors = graded.map(
    (record) => record.signedError as number
  );

  const within5Count = absoluteErrors.filter(
    (error) => error <= 5
  ).length;

  const within10Count = absoluteErrors.filter(
    (error) => error <= 10
  ).length;

  const within20Count = absoluteErrors.filter(
    (error) => error <= 20
  ).length;

  const percent = (count: number) =>
    round(count / graded.length * 100, 1);

  return {
    key,
    label,
    assetCount: graded.length,
    meanAbsoluteError: round(
      absoluteErrors.reduce((sum, value) => sum + value, 0) /
        graded.length,
      2
    ),
    meanSignedError: round(
      signedErrors.reduce((sum, value) => sum + value, 0) /
        graded.length,
      2
    ),
    medianAbsoluteError: round(
      median(absoluteErrors),
      2
    ),
    within5Count,
    within5Percent: percent(within5Count),
    within10Count,
    within10Percent: percent(within10Count),
    within20Count,
    within20Percent: percent(within20Count),
    underProjectedCount: graded.filter(
      (record) => record.outcome === 'under-projected'
    ).length,
    overProjectedCount: graded.filter(
      (record) => record.outcome === 'over-projected'
    ).length,
    onTargetCount: graded.filter(
      (record) => record.outcome === 'on-target'
    ).length
  };
}

async function loadProjectionVersionsBySnapshotId(
  leagueId: string,
  snapshotIds: string[]
): Promise<Map<string, number>> {
  const uniqueSnapshotIds = [...new Set(snapshotIds.filter(Boolean))];
  const versions = new Map<string, number>();

  const results = await Promise.allSettled(
    uniqueSnapshotIds.map(async (snapshotId) => {
      const snapshot = await getDoc(
        getProjectionSnapshotRef(leagueId, snapshotId)
      );

      if (!snapshot.exists()) {
        return null;
      }

      const data = snapshot.data() as {
        projectionVersion?: unknown;
      };

      const projectionVersion = toFiniteNumber(
        data.projectionVersion
      );

      return projectionVersion === null
        ? null
        : {
            snapshotId,
            projectionVersion: Math.floor(projectionVersion)
          };
    })
  );

  for (const result of results) {
    if (
      result.status === 'fulfilled' &&
      result.value
    ) {
      versions.set(
        result.value.snapshotId,
        result.value.projectionVersion
      );
    }
  }

  return versions;
}

function buildAssetRecord(
  input: SaveProjectionAccuracyInput,
  pick: DraftPick,
  projectionVersionsBySnapshotId: ReadonlyMap<string, number>
): ProjectionAccuracyAssetRecord {
  const asset = pick.asset;
  const score = input.scoring.assetScores[asset.assetKey];
  const displayedProjection = toFiniteNumber(
    input.displayedProjectionByAssetKey[asset.assetKey]
  );

  const actualFantasyPoints = round(
    score?.currentScore ?? 0
  );

  const signedError = displayedProjection === null
    ? null
    : round(actualFantasyPoints - displayedProjection);

  const absoluteError = signedError === null
    ? null
    : round(Math.abs(signedError));

  const percentageError =
    signedError === null ||
    displayedProjection === null ||
    Math.abs(displayedProjection) < 1
      ? null
      : round(
          signedError / Math.abs(displayedProjection) * 100,
          2
        );

  const projectionSnapshotId =
    typeof asset.sharedProjectionSnapshotId === 'string' &&
    asset.sharedProjectionSnapshotId.trim()
      ? asset.sharedProjectionSnapshotId
      : null;

  const snapshotProjectionVersion = projectionSnapshotId
    ? projectionVersionsBySnapshotId.get(projectionSnapshotId) ?? null
    : null;

  const projectionVersion =
    snapshotProjectionVersion ??
    SHARED_PROJECTION_VERSION;

  const projectionVersionSource = snapshotProjectionVersion !== null
    ? 'snapshot-metadata' as const
    : projectionVersion !== null
      ? 'current-code-fallback' as const
      : 'unknown' as const;

  return {
    id: getAccuracyRecordId(pick),
    leagueId: input.leagueId,
    cycleId: input.cycleId,
    cycleNumber: input.cycleNumber,
    ownerId: pick.ownerId,
    overallPick: pick.overallPick,
    assetKey: asset.assetKey,
    assetType: asset.assetType,
    assetName: getAssetName(asset),
    position: asset.position,
    teamAbbreviation: getAssetTeamAbbreviation(asset),
    projectionSnapshotId,
    projectionVersion,
    projectionVersionSource,
    projectedCyclePoints: displayedProjection,
    rawProjectedCyclePoints: getRawCycleProjection(asset),
    healthyProjectedCyclePoints:
      toFiniteNumber(asset.healthyProjectedCyclePoints),
    expectedGamesAvailable:
      toFiniteNumber(asset.expectedGamesAvailable),
    scheduledGamesInProjectionCycle:
      toFiniteNumber(asset.scheduledGamesInProjectionCycle),
    availabilityAdjustment:
      toFiniteNumber(asset.availabilityAdjustment),
    recentFormAdjustment:
      toFiniteNumber(asset.recentFormAdjustment),
    roleAdjustment:
      toFiniteNumber(asset.roleAdjustment),
    reliabilityRating:
      toFiniteNumber(asset.reliabilityRating),
    actualFantasyPoints,
    actualAppearances:
      Math.max(0, Math.floor(score?.actualGamesPlayed ?? 0)),
    completedTeamGames:
      Math.max(0, Math.floor(score?.gamesPlayed ?? 0)),
    scheduledTeamGames:
      Math.max(0, Math.floor(score?.scheduledGames ?? 0)),
    signedError,
    absoluteError,
    percentageError,
    outcome: getOutcome(signedError)
  };
}

export async function saveProjectionAccuracyForCycle(
  input: SaveProjectionAccuracyInput
): Promise<ProjectionAccuracyCycleHistory> {
  const user = auth.currentUser;

  if (!user) {
    throw new Error(
      'You must be logged in to save projection accuracy.'
    );
  }

  const leagueId = input.leagueId.trim();
  const cycleId = input.cycleId.trim();

  if (!leagueId || !cycleId) {
    throw new Error(
      'League and cycle information are required to save projection accuracy.'
    );
  }

  if (input.picks.length === 0) {
    throw new Error(
      'No cycle roster assets were available for projection accuracy.'
    );
  }

  const snapshotIds = input.picks
    .map((pick) => pick.asset.sharedProjectionSnapshotId ?? '')
    .filter((snapshotId): snapshotId is string => Boolean(snapshotId));

  const projectionVersionsBySnapshotId =
    await loadProjectionVersionsBySnapshotId(
      leagueId,
      snapshotIds
    );

  const records = input.picks.map((pick) =>
    buildAssetRecord(
      input,
      pick,
      projectionVersionsBySnapshotId
    )
  );

  const overall = buildMetricGroup(
    'all',
    'All Assets',
    records
  );

  const projectionVersions = [
    ...new Set(
      records
        .map((record) => record.projectionVersion)
        .filter((value): value is number =>
          typeof value === 'number'
        )
    )
  ].sort((a, b) => a - b);

  const projectionSnapshotIds = [
    ...new Set(
      records
        .map((record) => record.projectionSnapshotId)
        .filter((value): value is string => Boolean(value))
    )
  ].sort();

  const generatedAt = new Date().toISOString();

  const summary: ProjectionAccuracyCycleSummary = {
    id: cycleId,
    leagueId,
    cycleId,
    cycleNumber: Math.max(1, Math.floor(input.cycleNumber)),
    status: 'ready',
    assetCount: records.length,
    gradedAssetCount: overall.assetCount,
    projectionVersions,
    projectionSnapshotIds,
    meanAbsoluteError: overall.meanAbsoluteError,
    meanSignedError: overall.meanSignedError,
    medianAbsoluteError: overall.medianAbsoluteError,
    within5Percent: overall.within5Percent,
    within10Percent: overall.within10Percent,
    within20Percent: overall.within20Percent,
    generatedBy: user.uid,
    generatedAt
  };

  const batch = writeBatch(db);

  batch.set(
    getProjectionAccuracyCycleRef(leagueId, cycleId),
    {
      ...summary,
      completedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }
  );

  for (const record of records) {
    batch.set(
      getProjectionAccuracyAssetRef(
        leagueId,
        cycleId,
        record.id
      ),
      {
        ...record,
        generatedAt: serverTimestamp()
      }
    );
  }

  batch.set(
    getCycleRef(leagueId, cycleId),
    {
      projectionAccuracyStatus: 'complete',
      projectionAccuracyAssetCount: records.length,
      projectionAccuracyProjectionVersions:
        projectionVersions,
      projectionAccuracyUpdatedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    },
    { merge: true }
  );

  await batch.commit();

  return {
    summary,
    assets: records
  };
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (
    value &&
    typeof value === 'object' &&
    'toDate' in value &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  ) {
    return (
      value as { toDate: () => Date }
    ).toDate().toISOString();
  }

  return '';
}

function normalizeCycleSummary(
  id: string,
  data: Record<string, unknown>
): ProjectionAccuracyCycleSummary | null {
  const cycleNumber = toFiniteNumber(data['cycleNumber']);

  if (
    data['status'] !== 'ready' ||
    cycleNumber === null
  ) {
    return null;
  }

  const projectionVersions = Array.isArray(data['projectionVersions'])
    ? data['projectionVersions'].filter(
        (value): value is number =>
          typeof value === 'number'
      )
    : [];

  const projectionSnapshotIds = Array.isArray(
    data['projectionSnapshotIds']
  )
    ? data['projectionSnapshotIds'].filter(
        (value): value is string =>
          typeof value === 'string'
      )
    : [];

  return {
    id,
    leagueId:
      typeof data['leagueId'] === 'string'
        ? data['leagueId']
        : '',
    cycleId:
      typeof data['cycleId'] === 'string'
        ? data['cycleId']
        : id,
    cycleNumber: Math.floor(cycleNumber),
    status: 'ready',
    assetCount:
      Math.floor(toFiniteNumber(data['assetCount']) ?? 0),
    gradedAssetCount:
      Math.floor(toFiniteNumber(data['gradedAssetCount']) ?? 0),
    projectionVersions,
    projectionSnapshotIds,
    meanAbsoluteError:
      toFiniteNumber(data['meanAbsoluteError']) ?? 0,
    meanSignedError:
      toFiniteNumber(data['meanSignedError']) ?? 0,
    medianAbsoluteError:
      toFiniteNumber(data['medianAbsoluteError']) ?? 0,
    within5Percent:
      toFiniteNumber(data['within5Percent']) ?? 0,
    within10Percent:
      toFiniteNumber(data['within10Percent']) ?? 0,
    within20Percent:
      toFiniteNumber(data['within20Percent']) ?? 0,
    generatedBy:
      typeof data['generatedBy'] === 'string'
        ? data['generatedBy']
        : '',
    generatedAt:
      typeof data['generatedAt'] === 'string'
        ? data['generatedAt']
        : normalizeTimestamp(data['updatedAt']),
    completedAt: data['completedAt'],
    updatedAt: data['updatedAt']
  };
}

function normalizeAssetRecord(
  id: string,
  data: Record<string, unknown>
): ProjectionAccuracyAssetRecord | null {
  const position = data['position'];
  const assetType = data['assetType'];

  if (
    !['LW', 'C', 'RW', 'D', 'G'].includes(
      String(position)
    ) ||
    !['skater', 'team-goalie-unit'].includes(
      String(assetType)
    )
  ) {
    return null;
  }

  const signedError = toFiniteNumber(data['signedError']);

  return {
    id,
    leagueId:
      typeof data['leagueId'] === 'string'
        ? data['leagueId']
        : '',
    cycleId:
      typeof data['cycleId'] === 'string'
        ? data['cycleId']
        : '',
    cycleNumber:
      Math.floor(toFiniteNumber(data['cycleNumber']) ?? 0),
    ownerId:
      typeof data['ownerId'] === 'string'
        ? data['ownerId']
        : '',
    overallPick:
      Math.floor(toFiniteNumber(data['overallPick']) ?? 0),
    assetKey:
      typeof data['assetKey'] === 'string'
        ? data['assetKey']
        : '',
    assetType:
      assetType as DraftableAsset['assetType'],
    assetName:
      typeof data['assetName'] === 'string'
        ? data['assetName']
        : 'Unknown Asset',
    position: position as DraftPosition,
    teamAbbreviation:
      typeof data['teamAbbreviation'] === 'string'
        ? data['teamAbbreviation']
        : '',
    projectionSnapshotId:
      typeof data['projectionSnapshotId'] === 'string'
        ? data['projectionSnapshotId']
        : null,
    projectionVersion:
      toFiniteNumber(data['projectionVersion']),
    projectionVersionSource:
      data['projectionVersionSource'] === 'snapshot-metadata' ||
      data['projectionVersionSource'] === 'current-code-fallback'
        ? data['projectionVersionSource']
        : 'unknown',
    projectedCyclePoints:
      toFiniteNumber(data['projectedCyclePoints']),
    rawProjectedCyclePoints:
      toFiniteNumber(data['rawProjectedCyclePoints']),
    healthyProjectedCyclePoints:
      toFiniteNumber(data['healthyProjectedCyclePoints']),
    expectedGamesAvailable:
      toFiniteNumber(data['expectedGamesAvailable']),
    scheduledGamesInProjectionCycle:
      toFiniteNumber(data['scheduledGamesInProjectionCycle']),
    availabilityAdjustment:
      toFiniteNumber(data['availabilityAdjustment']),
    recentFormAdjustment:
      toFiniteNumber(data['recentFormAdjustment']),
    roleAdjustment:
      toFiniteNumber(data['roleAdjustment']),
    reliabilityRating:
      toFiniteNumber(data['reliabilityRating']),
    actualFantasyPoints:
      toFiniteNumber(data['actualFantasyPoints']) ?? 0,
    actualAppearances:
      Math.floor(toFiniteNumber(data['actualAppearances']) ?? 0),
    completedTeamGames:
      Math.floor(toFiniteNumber(data['completedTeamGames']) ?? 0),
    scheduledTeamGames:
      Math.floor(toFiniteNumber(data['scheduledTeamGames']) ?? 0),
    signedError,
    absoluteError:
      toFiniteNumber(data['absoluteError']),
    percentageError:
      toFiniteNumber(data['percentageError']),
    outcome:
      data['outcome'] === 'under-projected' ||
      data['outcome'] === 'over-projected' ||
      data['outcome'] === 'on-target'
        ? data['outcome']
        : getOutcome(signedError),
    generatedAt: data['generatedAt']
  };
}

export async function loadProjectionAccuracyHistory(
  leagueId: string
): Promise<ProjectionAccuracyHistory> {
  const cyclesQuery = query(
    getProjectionAccuracyCyclesRef(leagueId),
    orderBy('cycleNumber', 'desc'),
    limit(MAX_HISTORY_CYCLES)
  );

  const cycleSnapshot = await getDocs(cyclesQuery);

  const summaries = cycleSnapshot.docs
    .map((cycleDocument) =>
      normalizeCycleSummary(
        cycleDocument.id,
        cycleDocument.data() as Record<string, unknown>
      )
    )
    .filter(
      (
        summary
      ): summary is ProjectionAccuracyCycleSummary =>
        summary !== null
    );

  const cycleHistories = await Promise.all(
    summaries.map(async (summary) => {
      const assetSnapshot = await getDocs(
        getProjectionAccuracyAssetsRef(
          leagueId,
          summary.cycleId
        )
      );

      const assets = assetSnapshot.docs
        .map((assetDocument) =>
          normalizeAssetRecord(
            assetDocument.id,
            assetDocument.data() as Record<string, unknown>
          )
        )
        .filter(
          (
            record
          ): record is ProjectionAccuracyAssetRecord =>
            record !== null
        )
        .sort((first, second) =>
          (second.absoluteError ?? -1) -
            (first.absoluteError ?? -1) ||
          first.assetName.localeCompare(second.assetName)
        );

      return {
        summary,
        assets
      };
    })
  );

  const assets = cycleHistories.flatMap(
    (cycle) => cycle.assets
  );

  const positions: DraftPosition[] = [
    'LW',
    'C',
    'RW',
    'D',
    'G'
  ];

  const byPosition = positions
    .map((position) =>
      buildMetricGroup(
        position,
        position === 'G' ? 'Goalie Units' : position,
        assets.filter((record) => record.position === position)
      )
    )
    .filter((group) => group.assetCount > 0);

  const versions = [
    ...new Set(
      assets
        .map((record) => record.projectionVersion)
        .filter((value): value is number =>
          typeof value === 'number'
        )
    )
  ].sort((a, b) => b - a);

  const byVersion = versions.map((version) =>
    buildMetricGroup(
      String(version),
      `Version ${version}`,
      assets.filter(
        (record) => record.projectionVersion === version
      )
    )
  );

  return {
    cycles: cycleHistories.sort(
      (first, second) =>
        second.summary.cycleNumber -
        first.summary.cycleNumber
    ),
    assets,
    summary: buildMetricGroup(
      'all',
      'All Assets',
      assets
    ),
    byPosition,
    byVersion
  };
}
