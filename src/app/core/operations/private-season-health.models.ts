import type { PrivateSeasonBuildIdentity, PrivateSeasonStatus } from './private-season.models';

export type PrivateSeasonEngagementCategory =
  | 'league-home'
  | 'draft'
  | 'game-center'
  | 'roster'
  | 'standings'
  | 'other';

export type PrivateSeasonCommissionerIntent =
  | 'not-asked'
  | 'definitely'
  | 'probably'
  | 'unsure'
  | 'probably-not'
  | 'no';

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

export interface PrivateSeasonRetentionDefinition {
  observationStartsDay: number;
  dueDay: number;
  observationClosesDay: number;
  minimumManagers: number;
  managerRatio: number;
  note: string;
}

export interface PrivateSeasonHealthSnapshot {
  generatedAt: string;
  planRevision: number;
  planStatus: PrivateSeasonStatus;
  planReleaseLabel: string;
  planBuildId: string;
  build: PrivateSeasonBuildIdentity;
  thresholds: PrivateSeasonHealthThresholds;
  leagues: PrivateSeasonLeagueHealthEvidence[];
  weeklyRecords: PrivateSeasonWeeklyHealthRecord[];
  actions: PrivateSeasonActionEvidence;
  unresolvedIntegrityCount: number;
  summary: PrivateSeasonHealthSummary;
  retentionDefinition: PrivateSeasonRetentionDefinition;
}
