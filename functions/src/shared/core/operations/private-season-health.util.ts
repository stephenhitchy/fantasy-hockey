import { createHash } from 'node:crypto';

export const PRIVATE_SEASON_HEALTH_SCHEMA_VERSION = 1;
export const PRIVATE_SEASON_HEALTH_RELEASE_LABEL = 'Release Candidate 53';
export const PRIVATE_SEASON_HEALTH_SCORING_VERSION = 4;
export const PRIVATE_SEASON_HEALTH_PROJECTION_VERSION = 11;
export const PRIVATE_SEASON_HEALTH_WEEKLY_REASON_MINIMUM_LENGTH = 12;
export const PRIVATE_SEASON_HEALTH_RELIABILITY_MINIMUM_SAMPLES = 20;
export const PRIVATE_SEASON_HEALTH_RETENTION_MINIMUM_MANAGERS = 3;
export const PRIVATE_SEASON_HEALTH_RETENTION_MANAGER_RATIO = 0.5;
export const PRIVATE_SEASON_HEALTH_WEEKLY_RECORD_LIMIT = 12;
export const PRIVATE_SEASON_HEALTH_WEEKLY_NOTE_MAXIMUM_LENGTH = 400;
export const PRIVATE_SEASON_HEALTH_SUPPORT_MINUTES_MAXIMUM = 1_440;
export const PRIVATE_SEASON_HEALTH_FOUNDER_INTERVENTIONS_MAXIMUM = 99;
export const PRIVATE_SEASON_HEALTH_WEEKLY_COST_MAXIMUM = 10_000;

export const PRIVATE_SEASON_ENGAGEMENT_CATEGORIES = [
  'league-home',
  'draft',
  'game-center',
  'roster',
  'standings',
  'other',
] as const;

export const PRIVATE_SEASON_COMMISSIONER_INTENTS = [
  'not-asked',
  'definitely',
  'probably',
  'unsure',
  'probably-not',
  'no',
] as const;

export type PrivateSeasonEngagementCategory =
  typeof PRIVATE_SEASON_ENGAGEMENT_CATEGORIES[number];
export type PrivateSeasonCommissionerIntent =
  typeof PRIVATE_SEASON_COMMISSIONER_INTENTS[number];
export type PrivateSeasonMetricStatus =
  | 'green'
  | 'red'
  | 'collecting'
  | 'not-due'
  | 'informational';

export interface PrivateSeasonWeeklyLeagueHealth {
  slotId: string;
  leagueId: string;
  supportMinutes: number;
  founderInterventions: number;
  commissionerIntent: PrivateSeasonCommissionerIntent;
  note: string;
}

export interface PrivateSeasonWeeklyHealthRecord {
  schemaVersion: 1;
  weekEnding: string;
  revision: number;
  platformCostUsd: number;
  leagues: PrivateSeasonWeeklyLeagueHealth[];
  updatedAt: string | null;
  updatedBy: string;
}

export interface PrivateSeasonLeagueHealthEvidence {
  slotId: string;
  leagueId: string;
  label: string;
  expectedManagerCount: number;
  exists: boolean;
  teamCount: number;
  draftStatus: string;
  draftCompletedAt: string | null;
  firstMatchupViewedAt: string | null;
  firstRosterActionAt: string | null;
  activatedAt: string | null;
  latestEngagementAt: string | null;
  activeManagerCount7Days: number;
  fourWeekDue: boolean;
  fourWeekWindowClosed: boolean;
  fourWeekActiveManagerCount: number;
  fourWeekRequiredManagerCount: number;
  retainedAtFourWeeks: boolean;
}

export interface PrivateSeasonActionEvidence {
  buildId: string;
  total: number;
  successes: number;
  errors: number;
  uncertain: number;
  cancelled: number;
}

export interface PrivateSeasonHealthThresholds {
  unresolvedP0IntegrityDefectsMaximum: number;
  confirmedCoreActionReliabilityPercentMinimum: number;
  sixMemberLeagueDraftCompletionPercentMinimum: number;
  createdLeagueSixVerifiedMemberPercentMinimum: number;
  fourWeekLeagueRetentionPercentMinimum: number;
  medianSupportMinutesPerActiveLeagueWeekMaximum: number;
  nextSeasonCommissionerIntentPercentMinimum: number;
}

export interface PrivateSeasonHealthMetric {
  key:
    | 'integrity'
    | 'core-action-reliability'
    | 'league-filling'
    | 'draft-activation'
    | 'first-week-activation'
    | 'four-week-retention'
    | 'support-burden'
    | 'commissioner-intent'
    | 'weekly-cost';
  label: string;
  valueLabel: string;
  thresholdLabel: string;
  status: PrivateSeasonMetricStatus;
  detail: string;
  numerator: number | null;
  denominator: number | null;
  percent: number | null;
}

export interface PrivateSeasonHealthSummary {
  status: 'healthy' | 'needs-attention' | 'blocked' | 'collecting';
  headline: string;
  metrics: PrivateSeasonHealthMetric[];
  blockers: string[];
  advisories: string[];
  activeLeagueCount: number;
  activatedLeagueCount: number;
  retainedLeagueCount: number;
  costPerActivatedLeagueWeek: number | null;
  evidenceBuildId: string;
}

const ENGAGEMENT_CATEGORY_SET = new Set<string>(PRIVATE_SEASON_ENGAGEMENT_CATEGORIES);
const COMMISSIONER_INTENT_SET = new Set<string>(PRIVATE_SEASON_COMMISSIONER_INTENTS);
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SIMPLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, maximumLength: number): string {
  return typeof value === 'string'
    ? value
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maximumLength)
    : '';
}

function multiline(value: unknown, maximumLength: number): string {
  return typeof value === 'string'
    ? value
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      .trim()
      .slice(0, maximumLength)
    : '';
}

function integer(value: unknown, minimum: number, maximum: number, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.round(value)))
    : fallback;
}

function money(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Number(Math.min(PRIVATE_SEASON_HEALTH_WEEKLY_COST_MAXIMUM, Math.max(0, value)).toFixed(2))
    : 0;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function percent(numerator: number, denominator: number): number {
  return denominator > 0
    ? Number(((numerator / denominator) * 100).toFixed(1))
    : 0;
}

function median(values: readonly number[]): number | null {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);

  if (sorted.length === 0) {
    return null;
  }

  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle] ?? null
    : Number((((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2).toFixed(1));
}

function latestWeeklyRecordForLeague(
  records: readonly PrivateSeasonWeeklyHealthRecord[],
  leagueId: string,
): PrivateSeasonWeeklyLeagueHealth | null {
  for (const weekly of [...records].sort((left, right) => right.weekEnding.localeCompare(left.weekEnding))) {
    const found = weekly.leagues.find((entry) => entry.leagueId === leagueId);
    if (found) {
      return found;
    }
  }

  return null;
}

export function normalizePrivateSeasonEngagementCategory(
  value: unknown,
): PrivateSeasonEngagementCategory | null {
  const candidate = text(value, 30);
  return ENGAGEMENT_CATEGORY_SET.has(candidate)
    ? candidate as PrivateSeasonEngagementCategory
    : null;
}

export function normalizePrivateSeasonCommissionerIntent(
  value: unknown,
): PrivateSeasonCommissionerIntent {
  const candidate = text(value, 30);
  return COMMISSIONER_INTENT_SET.has(candidate)
    ? candidate as PrivateSeasonCommissionerIntent
    : 'not-asked';
}

export function normalizePrivateSeasonWeekEnding(value: unknown): string | null {
  const candidate = text(value, 10);

  if (!DATE_KEY_PATTERN.test(candidate)) {
    return null;
  }

  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate
    ? candidate
    : null;
}

export function privateSeasonManagerHash(userId: string, leagueId: string): string {
  return createHash('sha256')
    .update(`rinkrat-private-season-2026-27:${leagueId}:${userId}`)
    .digest('hex')
    .slice(0, 32);
}

export function privateSeasonManagerDayId(managerHash: string, dateKey: string): string {
  return createHash('sha256')
    .update(`rinkrat-private-season-manager-day:${managerHash}:${dateKey}`)
    .digest('hex')
    .slice(0, 40);
}

export function privateSeasonRetentionManagerRequirement(managerCount: number): number {
  return Math.max(
    PRIVATE_SEASON_HEALTH_RETENTION_MINIMUM_MANAGERS,
    Math.ceil(Math.max(0, managerCount) * PRIVATE_SEASON_HEALTH_RETENTION_MANAGER_RATIO),
  );
}

export function normalizePrivateSeasonWeeklyHealthRecord(
  value: unknown,
  activeSlots: readonly { slotId: string; leagueId: string }[],
): PrivateSeasonWeeklyHealthRecord | null {
  const source = record(value);
  const weekEnding = normalizePrivateSeasonWeekEnding(source['weekEnding']);

  if (!weekEnding) {
    return null;
  }

  const allowedBySlot = new Map(
    activeSlots
      .filter((slot) => SIMPLE_ID_PATTERN.test(slot.slotId) && SIMPLE_ID_PATTERN.test(slot.leagueId))
      .map((slot) => [slot.slotId, slot.leagueId] as const),
  );
  const sourceLeagues = Array.isArray(source['leagues']) ? source['leagues'] : [];
  const seen = new Set<string>();
  const leagues: PrivateSeasonWeeklyLeagueHealth[] = [];

  for (const raw of sourceLeagues) {
    const entry = record(raw);
    const slotId = text(entry['slotId'], 128);
    const expectedLeagueId = allowedBySlot.get(slotId);

    if (!expectedLeagueId || seen.has(slotId)) {
      continue;
    }

    seen.add(slotId);
    leagues.push({
      slotId,
      leagueId: expectedLeagueId,
      supportMinutes: integer(
        entry['supportMinutes'],
        0,
        PRIVATE_SEASON_HEALTH_SUPPORT_MINUTES_MAXIMUM,
      ),
      founderInterventions: integer(
        entry['founderInterventions'],
        0,
        PRIVATE_SEASON_HEALTH_FOUNDER_INTERVENTIONS_MAXIMUM,
      ),
      commissionerIntent: normalizePrivateSeasonCommissionerIntent(
        entry['commissionerIntent'],
      ),
      note: multiline(entry['note'], PRIVATE_SEASON_HEALTH_WEEKLY_NOTE_MAXIMUM_LENGTH),
    });
  }

  for (const [slotId, leagueId] of allowedBySlot.entries()) {
    if (!seen.has(slotId)) {
      leagues.push({
        slotId,
        leagueId,
        supportMinutes: 0,
        founderInterventions: 0,
        commissionerIntent: 'not-asked',
        note: '',
      });
    }
  }

  return {
    schemaVersion: 1,
    weekEnding,
    revision: integer(source['revision'], 0, 1_000_000),
    platformCostUsd: money(source['platformCostUsd']),
    leagues,
    updatedAt: isoOrNull(source['updatedAt']),
    updatedBy: text(source['updatedBy'], 128),
  };
}

export function privateSeasonWeeklyHealthHashInput(
  value: PrivateSeasonWeeklyHealthRecord,
): Record<string, unknown> {
  return {
    schemaVersion: value.schemaVersion,
    weekEnding: value.weekEnding,
    revision: value.revision,
    platformCostUsd: value.platformCostUsd,
    leagues: [...value.leagues]
      .map((entry) => ({
        slotId: entry.slotId,
        leagueId: entry.leagueId,
        supportMinutes: entry.supportMinutes,
        founderInterventions: entry.founderInterventions,
        commissionerIntent: entry.commissionerIntent,
        note: entry.note,
      }))
      .sort((left, right) => left.slotId.localeCompare(right.slotId)),
  };
}

export function buildPrivateSeasonHealthSummary(input: {
  leagues: readonly PrivateSeasonLeagueHealthEvidence[];
  weeklyRecords: readonly PrivateSeasonWeeklyHealthRecord[];
  actions: PrivateSeasonActionEvidence;
  unresolvedIntegrityCount: number;
  thresholds: PrivateSeasonHealthThresholds;
}): PrivateSeasonHealthSummary {
  const activeLeagues = input.leagues.filter((league) => league.leagueId);
  const filledLeagues = activeLeagues.filter((league) => league.exists && league.teamCount >= 6);
  const draftedEligible = filledLeagues;
  const draftedLeagues = draftedEligible.filter((league) => league.draftStatus === 'complete');
  const activatedLeagues = draftedLeagues.filter((league) => Boolean(league.activatedAt));
  const firstWeekActivatedLeagues = activatedLeagues.filter((league) =>
    Boolean(league.firstRosterActionAt));
  const fourWeekEligible = activeLeagues.filter((league) => league.fourWeekDue);
  const retainedLeagues = fourWeekEligible.filter((league) => league.retainedAtFourWeeks);
  const confirmedActionTotal = Math.max(
    0,
    input.actions.successes + input.actions.errors + input.actions.uncertain,
  );
  const actionReliability = confirmedActionTotal > 0
    ? percent(input.actions.successes, confirmedActionTotal)
    : 0;
  const recentWeekly = [...input.weeklyRecords]
    .sort((left, right) => right.weekEnding.localeCompare(left.weekEnding))
    .slice(0, 4);
  const supportSamples = recentWeekly.flatMap((weekly) =>
    weekly.leagues
      .filter((entry) => activeLeagues.some((league) => league.leagueId === entry.leagueId))
      .map((entry) => entry.supportMinutes),
  );
  const medianSupport = median(supportSamples);
  const intentEntries = activeLeagues
    .map((league) => latestWeeklyRecordForLeague(input.weeklyRecords, league.leagueId))
    .filter((entry): entry is PrivateSeasonWeeklyLeagueHealth =>
      Boolean(entry) && entry?.commissionerIntent !== 'not-asked');
  const positiveIntent = intentEntries.filter((entry) =>
    entry.commissionerIntent === 'definitely' || entry.commissionerIntent === 'probably').length;
  const intentPercent = intentEntries.length > 0 ? percent(positiveIntent, intentEntries.length) : 0;
  const latestWeekly = [...input.weeklyRecords]
    .sort((left, right) => right.weekEnding.localeCompare(left.weekEnding))[0] ?? null;
  const costPerActivatedLeagueWeek = latestWeekly && activatedLeagues.length > 0
    ? Number((latestWeekly.platformCostUsd / activatedLeagues.length).toFixed(2))
    : null;

  const metrics: PrivateSeasonHealthMetric[] = [
    {
      key: 'integrity',
      label: 'Competition integrity',
      valueLabel: `${input.unresolvedIntegrityCount} unresolved P0`,
      thresholdLabel: `≤ ${input.thresholds.unresolvedP0IntegrityDefectsMaximum}`,
      status: input.unresolvedIntegrityCount <= input.thresholds.unresolvedP0IntegrityDefectsMaximum
        ? 'green'
        : 'red',
      detail: input.unresolvedIntegrityCount === 0
        ? 'No unresolved competition-integrity report is currently open.'
        : 'Stop risky releases and acquisition until every integrity report is resolved or deliberately scoped.',
      numerator: input.unresolvedIntegrityCount,
      denominator: null,
      percent: null,
    },
    {
      key: 'core-action-reliability',
      label: 'Core action reliability',
      valueLabel: confirmedActionTotal > 0 ? `${actionReliability.toFixed(1)}%` : 'No samples',
      thresholdLabel: `≥ ${input.thresholds.confirmedCoreActionReliabilityPercentMinimum}%`,
      status: confirmedActionTotal < PRIVATE_SEASON_HEALTH_RELIABILITY_MINIMUM_SAMPLES
        ? 'collecting'
        : actionReliability >= input.thresholds.confirmedCoreActionReliabilityPercentMinimum
          ? 'green'
          : 'red',
      detail: confirmedActionTotal < PRIVATE_SEASON_HEALTH_RELIABILITY_MINIMUM_SAMPLES
        ? `Collect at least ${PRIVATE_SEASON_HEALTH_RELIABILITY_MINIMUM_SAMPLES} confirmed exact-build actions before treating reliability as green.`
        : `${input.actions.errors} errors and ${input.actions.uncertain} uncertain outcomes in the exact-build evidence window.`,
      numerator: input.actions.successes,
      denominator: confirmedActionTotal,
      percent: confirmedActionTotal > 0 ? actionReliability : null,
    },
    {
      key: 'league-filling',
      label: 'League filling',
      valueLabel: activeLeagues.length > 0
        ? `${filledLeagues.length} / ${activeLeagues.length}`
        : 'No leagues',
      thresholdLabel: `≥ ${input.thresholds.createdLeagueSixVerifiedMemberPercentMinimum}%`,
      status: activeLeagues.length === 0
        ? 'collecting'
        : percent(filledLeagues.length, activeLeagues.length) >=
          input.thresholds.createdLeagueSixVerifiedMemberPercentMinimum
          ? 'green'
          : 'red',
      detail: 'A filled league has at least six verified managers in the tracked production league.',
      numerator: filledLeagues.length,
      denominator: activeLeagues.length,
      percent: activeLeagues.length > 0 ? percent(filledLeagues.length, activeLeagues.length) : null,
    },
    {
      key: 'draft-activation',
      label: 'Draft activation',
      valueLabel: draftedEligible.length > 0
        ? `${draftedLeagues.length} / ${draftedEligible.length}`
        : 'Not due',
      thresholdLabel: `≥ ${input.thresholds.sixMemberLeagueDraftCompletionPercentMinimum}%`,
      status: draftedEligible.length === 0
        ? 'not-due'
        : percent(draftedLeagues.length, draftedEligible.length) >=
          input.thresholds.sixMemberLeagueDraftCompletionPercentMinimum
          ? 'green'
          : 'red',
      detail: 'Only leagues that reached six managers are included in this denominator.',
      numerator: draftedLeagues.length,
      denominator: draftedEligible.length,
      percent: draftedEligible.length > 0 ? percent(draftedLeagues.length, draftedEligible.length) : null,
    },
    {
      key: 'first-week-activation',
      label: 'First-week activation',
      valueLabel: activatedLeagues.length > 0
        ? `${firstWeekActivatedLeagues.length} / ${activatedLeagues.length}`
        : 'Not due',
      thresholdLabel: 'Evidence metric',
      status: activatedLeagues.length === 0
        ? 'not-due'
        : 'informational',
      detail: 'Counts activated leagues with at least one authoritative roster or waiver action.',
      numerator: firstWeekActivatedLeagues.length,
      denominator: activatedLeagues.length,
      percent: activatedLeagues.length > 0
        ? percent(firstWeekActivatedLeagues.length, activatedLeagues.length)
        : null,
    },
    {
      key: 'four-week-retention',
      label: 'Four-week retention',
      valueLabel: fourWeekEligible.length > 0
        ? `${retainedLeagues.length} / ${fourWeekEligible.length}`
        : 'Not due',
      thresholdLabel: `≥ ${input.thresholds.fourWeekLeagueRetentionPercentMinimum}%`,
      status: fourWeekEligible.length === 0
        ? 'not-due'
        : fourWeekEligible.some((league) => !league.fourWeekWindowClosed && !league.retainedAtFourWeeks)
          ? 'collecting'
          : percent(retainedLeagues.length, fourWeekEligible.length) >=
            input.thresholds.fourWeekLeagueRetentionPercentMinimum
            ? 'green'
            : 'red',
      detail: 'The initial operational definition requires at least half the league, with a minimum of three managers, to return during the Week 4 observation window.',
      numerator: retainedLeagues.length,
      denominator: fourWeekEligible.length,
      percent: fourWeekEligible.length > 0
        ? percent(retainedLeagues.length, fourWeekEligible.length)
        : null,
    },
    {
      key: 'support-burden',
      label: 'Support burden',
      valueLabel: medianSupport === null ? 'No weekly logs' : `${medianSupport} min`,
      thresholdLabel: `< ${input.thresholds.medianSupportMinutesPerActiveLeagueWeekMaximum} min`,
      status: medianSupport === null
        ? 'collecting'
        : medianSupport < input.thresholds.medianSupportMinutesPerActiveLeagueWeekMaximum
          ? 'green'
          : 'red',
      detail: `Median across ${supportSamples.length} league-week support entries from the latest four weekly records.`,
      numerator: medianSupport,
      denominator: null,
      percent: null,
    },
    {
      key: 'commissioner-intent',
      label: 'Commissioner return intent',
      valueLabel: intentEntries.length > 0 ? `${intentPercent.toFixed(1)}%` : 'Not asked',
      thresholdLabel: `≥ ${input.thresholds.nextSeasonCommissionerIntentPercentMinimum}%`,
      status: intentEntries.length === 0
        ? 'collecting'
        : intentPercent >= input.thresholds.nextSeasonCommissionerIntentPercentMinimum
          ? 'green'
          : 'red',
      detail: 'Positive intent includes Definitely and Probably from the latest recorded answer for each league.',
      numerator: positiveIntent,
      denominator: intentEntries.length,
      percent: intentEntries.length > 0 ? intentPercent : null,
    },
    {
      key: 'weekly-cost',
      label: 'Cost per activated league',
      valueLabel: costPerActivatedLeagueWeek === null
        ? 'No cost log'
        : `$${costPerActivatedLeagueWeek.toFixed(2)}`,
      thresholdLabel: 'Informational',
      status: costPerActivatedLeagueWeek === null ? 'collecting' : 'informational',
      detail: 'Uses the latest manually entered platform cost divided by activated tracked leagues.',
      numerator: costPerActivatedLeagueWeek,
      denominator: activatedLeagues.length,
      percent: null,
    },
  ];

  const redMetrics = metrics.filter((metric) => metric.status === 'red');
  const collectingMetrics = metrics.filter((metric) => metric.status === 'collecting');
  const blockers = redMetrics.map((metric) => `${metric.label}: ${metric.valueLabel}`);
  const advisories = collectingMetrics.map((metric) => `${metric.label}: evidence still collecting.`);
  const integrityRed = metrics.find((metric) => metric.key === 'integrity')?.status === 'red';
  const overallStatus: PrivateSeasonHealthSummary['status'] = integrityRed
    ? 'blocked'
    : redMetrics.length > 0
      ? 'needs-attention'
      : collectingMetrics.length > 0
        ? 'collecting'
        : 'healthy';

  return {
    status: overallStatus,
    headline: overallStatus === 'blocked'
      ? 'Stop-the-line integrity issue'
      : overallStatus === 'needs-attention'
        ? 'One or more tester-season metrics need attention'
        : overallStatus === 'collecting'
          ? 'Tester-season evidence is still collecting'
          : 'Current tester-season evidence is healthy',
    metrics,
    blockers,
    advisories,
    activeLeagueCount: activeLeagues.length,
    activatedLeagueCount: activatedLeagues.length,
    retainedLeagueCount: retainedLeagues.length,
    costPerActivatedLeagueWeek,
    evidenceBuildId: input.actions.buildId,
  };
}
