import { httpsCallable } from 'firebase/functions';
import { getDoc } from 'firebase/firestore';

import {
  getCycleTeamWindowsRef,
  normalizeFantasyTeamCycleWindows,
} from '../cycle/asset-cycle-window.service';
import {
  buildCycleSchedulePreview,
  getLeagueCycles,
  type CycleSchedulePreviewCycle,
} from '../cycle/cycle.service';
import type { FantasyCycle, FantasyTeamCycleWindows } from '../cycle/cycle.models';
import { getFantasyDraft } from '../draft/draft.service';
import type { FantasyDraft } from '../draft/draft.models';
import { functions } from '../firebase-functions';
import {
  getNhlTeamSeasonSchedule,
  type NhlTeamSeasonGame,
} from '../nhl/nhl-api.service';
import { getAnchoredRegularSeasonCycleCount } from '../playoffs/playoff-format';
import { getNhlSeasonForDate } from '../transactions/roster-move-eligibility.util';
import type { FantasyTeam } from './team.service';
import {
  type ClearFutureMatchupLineupPlanInput,
  type ClearFutureMatchupLineupPlanResult,
  type FutureMatchupLineupErrorDetails,
  type FutureMatchupLineupErrorReason,
  type FutureMatchupLineupPlanStatus,
  type FutureMatchupLineupPlanView,
  type FutureMatchupLineupSlotInput,
  type FutureMatchupLineupSlotResolution,
  type FutureMatchupLineupSlotView,
  type ManageFutureMatchupLineupsRequest,
  type ManageFutureMatchupLineupsResult,
  type SaveFutureMatchupLineupPlanInput,
} from './future-matchup-lineup.models';

const MAX_SCHEDULE_TEAMS = 32;
const PLAN_STATUSES = new Set<FutureMatchupLineupPlanStatus>([
  'planned',
  'partially-applied',
  'applied',
  'conflicted',
]);
const SLOT_RESOLUTIONS = new Set<FutureMatchupLineupSlotResolution>([
  'planned',
  'applied',
  'unchanged',
  'conflict',
]);
const ERROR_REASONS = new Set<FutureMatchupLineupErrorReason>([
  'revision-conflict',
  'pending-roster-move',
  'cycle-started',
  'cycle-state-invalid',
  'playoffs-not-supported',
  'historical-replay-active',
  'cross-cycle-asset-conflict',
  'lineup-plan-limit-exceeded',
  'plan-state-invalid',
  'target-pick-state-invalid',
  'invalid-lineup-slots',
  'lineup-mutation-state-invalid',
  'lineup-mutation-limit-exceeded',
  'roster-unavailable',
  'draft-incomplete',
  'season-schedule-unavailable',
  'request-id-reused',
  'roster-revision-conflict',
  'plan-not-found',
]);

export interface FutureMatchupLineupOptionContext {
  draft: FantasyDraft;
  cycles: FantasyCycle[];
  schedulePreview: CycleSchedulePreviewCycle[];
  nhlSeason: string;
}

export interface FutureMatchupNhlScheduleLoadResult {
  schedulesByTeam: Readonly<Record<string, NhlTeamSeasonGame[]>>;
  failedTeamAbbreviations: string[];
}

export class FutureMatchupLineupServiceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly details: FutureMatchupLineupErrorDetails,
    readonly causeValue: unknown,
  ) {
    super(message);
    this.name = 'FutureMatchupLineupServiceError';
  }
}

const manageFutureMatchupLineupsCallable = httpsCallable<
  ManageFutureMatchupLineupsRequest,
  ManageFutureMatchupLineupsResult
>(functions, 'manageFutureMatchupLineups', { timeout: 35_000 });

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`The future-lineup ${field} is missing.`);
  }

  return value.trim();
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`The future-lineup ${field} is invalid.`);
  }

  return value;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`The future-lineup ${field} is invalid.`);
  }

  return value;
}

function requireMilliseconds(value: unknown, field: string): number {
  return requireNonNegativeInteger(value, field);
}

function normalizeSlotInput(value: unknown): FutureMatchupLineupSlotInput {
  if (!isRecord(value)) {
    throw new Error('A future-lineup slot is malformed.');
  }

  const rosterSlotId = requireNonEmptyString(value['rosterSlotId'], 'roster slot');
  const rawAssetKey = value['assetKey'];

  if (rawAssetKey !== null && typeof rawAssetKey !== 'string') {
    throw new Error(`The future-lineup asset for ${rosterSlotId} is malformed.`);
  }

  const assetKey = typeof rawAssetKey === 'string' ? rawAssetKey.trim() : null;

  if (assetKey === '') {
    throw new Error(`The future-lineup asset for ${rosterSlotId} is malformed.`);
  }

  return { rosterSlotId, assetKey };
}

function normalizeSlotInputs(values: readonly unknown[]): FutureMatchupLineupSlotInput[] {
  const slots = values.map(normalizeSlotInput);
  const slotIds = new Set(slots.map((slot) => slot.rosterSlotId));

  if (slotIds.size !== slots.length) {
    throw new Error('The future-lineup plan contains a duplicate roster slot.');
  }

  return slots;
}

function normalizeSlotView(value: unknown): FutureMatchupLineupSlotView {
  const slot = normalizeSlotInput(value);

  if (!isRecord(value) || !SLOT_RESOLUTIONS.has(value['resolution'] as FutureMatchupLineupSlotResolution)) {
    throw new Error(`The future-lineup resolution for ${slot.rosterSlotId} is malformed.`);
  }

  const reason = typeof value['reason'] === 'string' && value['reason'].trim()
    ? value['reason'].trim()
    : undefined;
  const resolvedAtMs = value['resolvedAtMs'] === undefined
    ? undefined
    : requireMilliseconds(value['resolvedAtMs'], 'resolved timestamp');
  const rawResolvedAssetKey = value['resolvedAssetKey'];

  if (
    (value['resolution'] === 'planned' && rawResolvedAssetKey !== undefined) ||
    rawResolvedAssetKey !== undefined &&
    rawResolvedAssetKey !== null &&
    (typeof rawResolvedAssetKey !== 'string' || !rawResolvedAssetKey.trim())
  ) {
    throw new Error(`The resolved future-lineup asset for ${slot.rosterSlotId} is malformed.`);
  }
  const resolvedAssetKey = typeof rawResolvedAssetKey === 'string'
    ? rawResolvedAssetKey.trim()
    : rawResolvedAssetKey;

  return {
    ...slot,
    resolution: value['resolution'] as FutureMatchupLineupSlotResolution,
    ...(resolvedAssetKey === undefined ? {} : { resolvedAssetKey }),
    ...(reason ? { reason } : {}),
    ...(resolvedAtMs === undefined ? {} : { resolvedAtMs }),
  };
}

export function normalizeFutureMatchupLineupPlanView(value: unknown): FutureMatchupLineupPlanView {
  if (!isRecord(value) || !Array.isArray(value['slots'])) {
    throw new Error('The saved future-lineup plan is malformed.');
  }

  const status = value['status'] as FutureMatchupLineupPlanStatus;

  if (!PLAN_STATUSES.has(status)) {
    throw new Error('The saved future-lineup status is malformed.');
  }

  const slots = value['slots'].map(normalizeSlotView);
  const slotIds = new Set(slots.map((slot) => slot.rosterSlotId));

  if (slotIds.size !== slots.length) {
    throw new Error('The saved future-lineup plan contains a duplicate roster slot.');
  }

  return {
    ownerId: requireNonEmptyString(value['ownerId'], 'owner'),
    cycleNumber: requirePositiveInteger(value['cycleNumber'], 'matchup number'),
    revision: requirePositiveInteger(value['revision'], 'revision'),
    status,
    slots,
    materializedSlotCount: requireNonNegativeInteger(
      value['materializedSlotCount'],
      'materialized slot count',
    ),
    createdAtMs: requireMilliseconds(value['createdAtMs'], 'created timestamp'),
    updatedAtMs: requireMilliseconds(value['updatedAtMs'], 'updated timestamp'),
  };
}

function normalizeErrorCode(value: unknown): string {
  const code = typeof value === 'string' ? value : 'unknown';
  return code.startsWith('functions/') ? code.slice('functions/'.length) : code;
}

function getErrorDetails(value: unknown): FutureMatchupLineupErrorDetails {
  const details = isRecord(value) && isRecord(value['details']) ? value['details'] : {};
  const rawReason = details['reason'];
  const reason = ERROR_REASONS.has(rawReason as FutureMatchupLineupErrorReason)
    ? rawReason as FutureMatchupLineupErrorReason
    : 'unknown';
  const currentRevision = typeof details['currentRevision'] === 'number' &&
      Number.isSafeInteger(details['currentRevision']) && details['currentRevision'] >= 0
    ? details['currentRevision']
    : null;
  let plan: FutureMatchupLineupPlanView | null = null;

  if (details['plan'] !== null && details['plan'] !== undefined) {
    try {
      plan = normalizeFutureMatchupLineupPlanView(details['plan']);
    } catch {
      plan = null;
    }
  }

  const lockedSlotIds = Array.isArray(details['lockedSlotIds'])
    ? details['lockedSlotIds'].filter(
        (slotId): slotId is string => typeof slotId === 'string' && Boolean(slotId.trim()),
      )
    : [];
  const optionalString = (field: string): string | undefined =>
    typeof details[field] === 'string' && details[field].trim()
      ? details[field].trim()
      : undefined;
  const reservedCycleNumber = typeof details['reservedCycleNumber'] === 'number' &&
      Number.isSafeInteger(details['reservedCycleNumber']) &&
      details['reservedCycleNumber'] > 0
    ? details['reservedCycleNumber']
    : undefined;

  return {
    reason,
    currentRevision,
    plan,
    ...(lockedSlotIds.length > 0 ? { lockedSlotIds } : {}),
    ...(optionalString('assetKey') ? { assetKey: optionalString('assetKey') } : {}),
    ...(optionalString('requestedRosterSlotId')
      ? { requestedRosterSlotId: optionalString('requestedRosterSlotId') }
      : {}),
    ...(optionalString('reservedRosterSlotId')
      ? { reservedRosterSlotId: optionalString('reservedRosterSlotId') }
      : {}),
    ...(reservedCycleNumber === undefined ? {} : { reservedCycleNumber }),
  };
}

export function normalizeFutureMatchupLineupError(
  error: unknown,
): FutureMatchupLineupServiceError {
  if (error instanceof FutureMatchupLineupServiceError) {
    return error;
  }

  const record = isRecord(error) ? error : {};
  const code = normalizeErrorCode(record['code']);
  const details = getErrorDetails(error);
  const retryable = details.reason !== 'lineup-mutation-limit-exceeded' && new Set([
    'deadline-exceeded',
    'internal',
    'resource-exhausted',
    'unavailable',
    'unknown',
  ]).has(code);
  const message = error instanceof Error && error.message
    ? error.message
    : 'Unable to manage the future matchup lineup.';

  return new FutureMatchupLineupServiceError(
    message,
    code,
    retryable,
    details,
    error,
  );
}

export function isFutureMatchupLineupRevisionConflict(error: unknown): boolean {
  const normalized = normalizeFutureMatchupLineupError(error);
  return normalized.code === 'aborted' && normalized.details.reason === 'revision-conflict';
}

function normalizeLeagueId(leagueId: string): string {
  const normalized = leagueId.trim();

  if (!normalized) {
    throw new Error('A league is required to manage a future matchup lineup.');
  }

  return normalized;
}

function normalizeMutationInput(input: {
  leagueId: string;
  cycleNumber: number;
  expectedRevision: number;
  requestId: string;
}): Omit<SaveFutureMatchupLineupPlanInput, 'slots'> {
  return {
    leagueId: normalizeLeagueId(input.leagueId),
    cycleNumber: requirePositiveInteger(input.cycleNumber, 'matchup number'),
    expectedRevision: requireNonNegativeInteger(input.expectedRevision, 'expected revision'),
    requestId: requireNonEmptyString(input.requestId, 'request id'),
  };
}

export function createFutureMatchupLineupRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `future-lineup-${crypto.randomUUID()}`;
  }

  return `future-lineup-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
}

export async function listFutureMatchupLineupPlans(
  leagueId: string,
): Promise<FutureMatchupLineupPlanView[]> {
  try {
    const response = await manageFutureMatchupLineupsCallable({
      leagueId: normalizeLeagueId(leagueId),
      operation: 'list',
    });

    if (response.data.operation !== 'list' || !Array.isArray(response.data.plans)) {
      throw new Error('The future-lineup list response is malformed.');
    }

    return response.data.plans
      .map(normalizeFutureMatchupLineupPlanView)
      .sort((first, second) => first.cycleNumber - second.cycleNumber);
  } catch (error: unknown) {
    throw normalizeFutureMatchupLineupError(error);
  }
}

export async function saveFutureMatchupLineupPlan(
  input: SaveFutureMatchupLineupPlanInput,
): Promise<FutureMatchupLineupPlanView> {
  try {
    const normalized = normalizeMutationInput(input);
    const slots = normalizeSlotInputs(input.slots);

    if (slots.length === 0) {
      throw new Error('A future-lineup save must include every active roster slot.');
    }

    const response = await manageFutureMatchupLineupsCallable({
      ...normalized,
      operation: 'save',
      slots,
    });

    if (response.data.operation !== 'save') {
      throw new Error('The future-lineup save response is malformed.');
    }

    return normalizeFutureMatchupLineupPlanView(response.data.plan);
  } catch (error: unknown) {
    throw normalizeFutureMatchupLineupError(error);
  }
}

export async function clearFutureMatchupLineupPlan(
  input: ClearFutureMatchupLineupPlanInput,
): Promise<ClearFutureMatchupLineupPlanResult> {
  try {
    const normalized = normalizeMutationInput(input);
    const response = await manageFutureMatchupLineupsCallable({
      ...normalized,
      operation: 'clear',
    });

    if (
      response.data.operation !== 'clear' ||
      response.data.plan !== null ||
      !Number.isSafeInteger(response.data.clearedCycleNumber) ||
      !Number.isSafeInteger(response.data.revision)
    ) {
      throw new Error('The future-lineup clear response is malformed.');
    }

    return response.data;
  } catch (error: unknown) {
    throw normalizeFutureMatchupLineupError(error);
  }
}

/**
 * Loads the stable inputs used to offer every regular-season matchup without
 * adding a listener or reading each cycle's matchup collection individually.
 */
export async function loadFutureMatchupLineupOptionContext(
  leagueId: string,
  teams: readonly FantasyTeam[],
  now = new Date(),
): Promise<FutureMatchupLineupOptionContext> {
  const normalizedLeagueId = normalizeLeagueId(leagueId);
  const [draft, cycles] = await Promise.all([
    getFantasyDraft(normalizedLeagueId),
    getLeagueCycles(normalizedLeagueId),
  ]);

  if (!draft || draft.status !== 'complete') {
    throw new Error('Future matchup lineups are available after the Draft is complete.');
  }

  return {
    draft,
    cycles,
    schedulePreview: buildCycleSchedulePreview(
      [...teams],
      draft,
      getAnchoredRegularSeasonCycleCount(
        teams.length,
        draft.initialNhlBlockNumber ?? 1,
      ),
    ),
    nhlSeason: getNhlSeasonForDate(now),
  };
}

/** One selected cycle and one owner document; never a collection fan-out. */
export async function loadFutureMatchupOwnerWindows(
  leagueId: string,
  cycleNumber: number,
  ownerId: string,
): Promise<FantasyTeamCycleWindows | null> {
  const normalizedLeagueId = normalizeLeagueId(leagueId);
  const normalizedCycleNumber = requirePositiveInteger(cycleNumber, 'matchup number');
  const normalizedOwnerId = requireNonEmptyString(ownerId, 'owner');
  const snapshot = await getDoc(
    getCycleTeamWindowsRef(
      normalizedLeagueId,
      normalizedCycleNumber,
      normalizedOwnerId,
    ),
  );

  return snapshot.exists()
    ? normalizeFantasyTeamCycleWindows(
        normalizedOwnerId,
        normalizedCycleNumber,
        snapshot.data(),
      )
    : null;
}

/**
 * Reuses the NHL service's ten-minute request cache and in-flight coalescing.
 * Only distinct clubs represented in the selected lineup are requested.
 */
export async function loadFutureMatchupNhlSchedules(
  teamAbbreviations: readonly string[],
  season: string,
): Promise<FutureMatchupNhlScheduleLoadResult> {
  const teams = [...new Set(teamAbbreviations.map((team) => team.trim().toUpperCase()))]
    .filter(Boolean)
    .sort();

  if (
    teams.length > MAX_SCHEDULE_TEAMS ||
    teams.some((team) => !/^[A-Z0-9]{2,4}$/.test(team)) ||
    !/^\d{8}$/.test(season)
  ) {
    throw new Error('The future-lineup NHL schedule request is malformed.');
  }

  const results = await Promise.allSettled(
    teams.map(async (teamAbbreviation) => ({
      teamAbbreviation,
      schedule: await getNhlTeamSeasonSchedule(teamAbbreviation, season),
    })),
  );
  const schedulesByTeam: Record<string, NhlTeamSeasonGame[]> = {};
  const failedTeamAbbreviations: string[] = [];

  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      schedulesByTeam[result.value.teamAbbreviation] = result.value.schedule;
    } else {
      failedTeamAbbreviations.push(teams[index]);
    }
  }

  return { schedulesByTeam, failedTeamAbbreviations };
}
