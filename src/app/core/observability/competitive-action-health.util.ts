export type CompetitiveActionKind =
  | 'add-drop'
  | 'waiver-claim'
  | 'draft-pick'
  | 'historical-replay'
  | 'lineup-swap'
  | 'injured-reserve'
  | 'roster-drop';

export type CompetitiveActionOutcome =
  | 'success'
  | 'error'
  | 'uncertain'
  | 'cancelled';

export interface CompetitiveActionRecord {
  id: string;
  action: CompetitiveActionKind;
  outcome: CompetitiveActionOutcome;
  route: string;
  startedAt: string;
  finishedAt: string;
  durationMilliseconds: number;
  connectionType: string;
  online: boolean;
}

export interface ActiveCompetitiveActionRecord {
  id: string;
  action: CompetitiveActionKind;
  route: string;
  startedAtMilliseconds: number;
  connectionType: string;
  online: boolean;
}

export interface CompetitiveActionAggregate {
  action: CompetitiveActionKind;
  total: number;
  successes: number;
  errors: number;
  uncertain: number;
  averageDurationMilliseconds: number;
  slowestDurationMilliseconds: number;
}

export interface CompetitiveActionHealthSnapshot {
  completedCount: number;
  successCount: number;
  errorCount: number;
  uncertainCount: number;
  cancelledCount: number;
  activeCount: number;
  averageDurationMilliseconds: number;
  slowestDurationMilliseconds: number;
  slowActionCount: number;
  byAction: CompetitiveActionAggregate[];
  recent: CompetitiveActionRecord[];
  generatedAt: string;
}

const ACTION_KINDS = new Set<CompetitiveActionKind>([
  'add-drop',
  'waiver-claim',
  'draft-pick',
  'historical-replay',
  'lineup-swap',
  'injured-reserve',
  'roster-drop',
]);

const ACTION_OUTCOMES = new Set<CompetitiveActionOutcome>([
  'success',
  'error',
  'uncertain',
  'cancelled',
]);

export const COMPETITIVE_ACTION_SLOW_THRESHOLD_MILLISECONDS = 5_000;
export const COMPETITIVE_ACTION_MAX_RECORDS = 30;
export const COMPETITIVE_ACTION_MAX_AGE_MILLISECONDS = 12 * 60 * 60 * 1_000;

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function validIso(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function normalizeCompetitiveActionRecord(
  value: unknown,
  nowMilliseconds = Date.now(),
): CompetitiveActionRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<CompetitiveActionRecord>;
  const action = candidate.action;
  const outcome = candidate.outcome;
  const startedAt = validIso(candidate.startedAt);
  const finishedAt = validIso(candidate.finishedAt);
  const durationMilliseconds = finiteNonNegative(candidate.durationMilliseconds);

  if (
    typeof candidate.id !== 'string' ||
    !candidate.id.trim() ||
    !ACTION_KINDS.has(action as CompetitiveActionKind) ||
    !ACTION_OUTCOMES.has(outcome as CompetitiveActionOutcome) ||
    !startedAt ||
    !finishedAt ||
    durationMilliseconds === null
  ) {
    return null;
  }

  if (
    nowMilliseconds - Date.parse(finishedAt) >
    COMPETITIVE_ACTION_MAX_AGE_MILLISECONDS
  ) {
    return null;
  }

  return {
    id: candidate.id.slice(0, 80),
    action: action as CompetitiveActionKind,
    outcome: outcome as CompetitiveActionOutcome,
    route: typeof candidate.route === 'string' ? candidate.route.slice(0, 180) : '/',
    startedAt,
    finishedAt,
    durationMilliseconds: Math.round(durationMilliseconds),
    connectionType:
      typeof candidate.connectionType === 'string'
        ? candidate.connectionType.slice(0, 24)
        : 'unknown',
    online: candidate.online !== false,
  };
}

export function normalizeCompetitiveActionRecords(
  value: unknown,
  nowMilliseconds = Date.now(),
): CompetitiveActionRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((record) => normalizeCompetitiveActionRecord(record, nowMilliseconds))
    .filter((record): record is CompetitiveActionRecord => Boolean(record))
    .sort(
      (first, second) => Date.parse(second.finishedAt) - Date.parse(first.finishedAt),
    )
    .slice(0, COMPETITIVE_ACTION_MAX_RECORDS);
}

export function buildCompetitiveActionHealthSnapshot(
  records: CompetitiveActionRecord[],
  activeActions: ActiveCompetitiveActionRecord[] = [],
  nowMilliseconds = Date.now(),
): CompetitiveActionHealthSnapshot {
  const normalized = normalizeCompetitiveActionRecords(records, nowMilliseconds);
  const completedDurations = normalized.map((record) => record.durationMilliseconds);
  const totalDuration = completedDurations.reduce((sum, duration) => sum + duration, 0);
  const byAction = new Map<CompetitiveActionKind, CompetitiveActionRecord[]>();

  for (const record of normalized) {
    const actionRecords = byAction.get(record.action) ?? [];
    actionRecords.push(record);
    byAction.set(record.action, actionRecords);
  }

  const aggregates = [...byAction.entries()]
    .map(([action, actionRecords]): CompetitiveActionAggregate => {
      const actionDurations = actionRecords.map((record) => record.durationMilliseconds);
      const actionTotal = actionDurations.reduce((sum, duration) => sum + duration, 0);

      return {
        action,
        total: actionRecords.length,
        successes: actionRecords.filter((record) => record.outcome === 'success').length,
        errors: actionRecords.filter((record) => record.outcome === 'error').length,
        uncertain: actionRecords.filter((record) => record.outcome === 'uncertain').length,
        averageDurationMilliseconds: actionRecords.length
          ? Math.round(actionTotal / actionRecords.length)
          : 0,
        slowestDurationMilliseconds: actionDurations.length
          ? Math.max(...actionDurations)
          : 0,
      };
    })
    .sort((first, second) => second.total - first.total || first.action.localeCompare(second.action));

  return {
    completedCount: normalized.length,
    successCount: normalized.filter((record) => record.outcome === 'success').length,
    errorCount: normalized.filter((record) => record.outcome === 'error').length,
    uncertainCount: normalized.filter((record) => record.outcome === 'uncertain').length,
    cancelledCount: normalized.filter((record) => record.outcome === 'cancelled').length,
    activeCount: activeActions.length,
    averageDurationMilliseconds: normalized.length
      ? Math.round(totalDuration / normalized.length)
      : 0,
    slowestDurationMilliseconds: completedDurations.length
      ? Math.max(...completedDurations)
      : 0,
    slowActionCount: normalized.filter(
      (record) =>
        record.durationMilliseconds >= COMPETITIVE_ACTION_SLOW_THRESHOLD_MILLISECONDS,
    ).length,
    byAction: aggregates,
    recent: normalized.slice(0, 10),
    generatedAt: new Date(nowMilliseconds).toISOString(),
  };
}

export function getCompetitiveActionLabel(action: CompetitiveActionKind): string {
  switch (action) {
    case 'add-drop':
      return 'Add / drop';
    case 'waiver-claim':
      return 'Waiver claim';
    case 'draft-pick':
      return 'Draft pick';
    case 'historical-replay':
      return 'Replay advance';
    case 'lineup-swap':
      return 'Lineup swap';
    case 'injured-reserve':
      return 'Injured Reserve move';
    case 'roster-drop':
      return 'Roster drop';
  }
}
