export type BetaFeedbackCategory =
  | 'competition-integrity'
  | 'blocked-action'
  | 'serious-usability'
  | 'cosmetic'
  | 'feature-idea'
  | 'account-privacy'
  | 'other';

export type BetaTriageSeverity =
  | 'integrity'
  | 'blocker'
  | 'serious'
  | 'cosmetic'
  | 'idea';

export type BetaFeedbackStatus =
  | 'new'
  | 'investigating'
  | 'confirmed'
  | 'fix-next-release'
  | 'resolved'
  | 'not-reproducible'
  | 'deferred';

export type BetaKnownIssueStatus =
  | 'investigating'
  | 'fix-prepared'
  | 'monitoring'
  | 'resolved';

export type BetaViewportCategory =
  | 'small-phone'
  | 'phone'
  | 'tablet'
  | 'desktop'
  | 'unknown';

export type BetaOperationMetricKind = 'competitive-action' | 'route-ready';

export interface BetaRecentActionContext {
  action: string;
  outcome: string;
  durationMilliseconds: number;
  finishedAt: string;
}

export interface BetaFeedbackTechnicalContext {
  releaseLabel: string;
  buildId: string;
  route: string;
  viewportCategory: BetaViewportCategory;
  online: boolean;
  connectionType: string;
  saveData: boolean;
  appCheckClientStatus: string;
  listenerCount: number;
  recentAction: BetaRecentActionContext | null;
}

export interface PublicBetaKnownIssue {
  issueId: string;
  title: string;
  summary: string;
  status: BetaKnownIssueStatus;
  severity: BetaTriageSeverity;
  affectedRelease: string;
  resolutionRelease: string;
  updatedAt: string | null;
  resolvedAt: string | null;
}

export interface PublicBetaKnownIssuesResponse {
  generatedAt: string;
  issues: PublicBetaKnownIssue[];
}

export interface BetaOperationMetricRequest {
  sampleId: string;
  kind: BetaOperationMetricKind;
  releaseLabel: string;
  buildId: string;
  route: string;
  viewportCategory: BetaViewportCategory;
  connectionType: string;
  online: boolean;
  appCheckClientStatus: string;
  action?: string;
  outcome?: string;
  durationMilliseconds: number;
  listenerCount?: number;
}

export interface BetaOperationMetricResponse {
  accepted: boolean;
}

export interface BetaActionOverview {
  action: string;
  total: number;
  successes: number;
  errors: number;
  uncertain: number;
  cancelled: number;
  averageDurationMilliseconds: number;
  p95DurationMilliseconds: number;
  maximumDurationMilliseconds: number;
  successRatePercent: number;
}

export interface BetaRouteOverview {
  route: string;
  total: number;
  averageReadyMilliseconds: number;
  p95ReadyMilliseconds: number;
  maximumReadyMilliseconds: number;
  averageListenerCount: number;
  maximumListenerCount: number;
}

export interface BetaDurationOverview {
  total: number;
  successes: number;
  errors: number;
  uncertain: number;
  cancelled: number;
  skipped: number;
  averageDurationMilliseconds: number;
  p95DurationMilliseconds: number;
  maximumDurationMilliseconds: number;
}

export interface BetaServerScoringOverview extends BetaDurationOverview {
  byTrigger: Array<BetaDurationOverview & { trigger: string }>;
}

export interface BetaQueueOverview {
  mode: string;
  scheduleCount: number;
  overdueScheduleCount: number;
  activeTaskCount: number;
  maxPendingTasks: number;
  dispatcherStatus: string;
  dispatcherLastRunAt: string | null;
  legacyStatus: string;
  legacyLastRunAt: string | null;
  failedLeagueCount: number;
}

export interface BetaDraftAutomationOverview {
  status: string;
  lastRunAt: string | null;
  durationMilliseconds: number;
  failedDraftCount: number;
}

export interface BetaKnownIssueSummary {
  total: number;
  investigating: number;
  fixPrepared: number;
  monitoring: number;
  resolved: number;
}

export type AppCheckReadinessStatus = 'collecting' | 'needs-attention' | 'ready';

export interface AppCheckCoverageBucket {
  name: string;
  required: boolean;
  total: number;
  valid: number;
  missing: number;
  validPercent: number;
  minimumSamples: number;
  sampleGatePassed: boolean;
  verificationGatePassed: boolean;
}

export interface AppCheckEnforcementReadiness {
  status: AppCheckReadinessStatus;
  headline: string;
  detail: string;
  exactBuildId: string;
  totalSamples: number;
  validSamples: number;
  missingSamples: number;
  validPercent: number;
  observedDayCount: number;
  managerDayCount: number;
  minimumTotalSamples: number;
  minimumObservedDays: number;
  minimumManagerDays: number;
  minimumValidPercent: number;
  browserCoverage: AppCheckCoverageBucket[];
  deviceCoverage: AppCheckCoverageBucket[];
  platformCoverage: AppCheckCoverageBucket[];
  actionCoverage: AppCheckCoverageBucket[];
  blockers: string[];
  advisories: string[];
  canaryEligible: boolean;
  automaticEnforcement: false;
}

export interface BetaOperationsOverview {
  generatedAt: string;
  windowDays: number;
  dateFrom: string;
  dateTo: string;
  clientSampleCount: number;
  clientSampleLimitReached: boolean;
  actionSampleCount: number;
  routeSampleCount: number;
  uniqueDailyUserCount: number;
  appCheckValidCount: number;
  appCheckMissingCount: number;
  appCheckReadiness: AppCheckEnforcementReadiness;
  actions: BetaActionOverview[];
  routes: BetaRouteOverview[];
  browsers: Array<{ name: string; count: number }>;
  devices: Array<{ name: string; count: number }>;
  builds: Array<{ name: string; count: number }>;
  serverScoring: BetaServerScoringOverview;
  scoringFreshnessAvailable: boolean;
  scoringFreshnessMessage: string;
  queue: BetaQueueOverview;
  draftAutomation: BetaDraftAutomationOverview;
  knownIssues: PublicBetaKnownIssue[];
  knownIssueSummary: BetaKnownIssueSummary;
}

export interface BetaFeedbackTriageUpdate {
  feedbackId: string;
  status: BetaFeedbackStatus;
  severity: BetaTriageSeverity;
  owner: string;
  duplicateOf: string;
  resolutionRelease: string;
  adminNotes: string;
  publishKnownIssue: boolean;
  knownIssueStatus: BetaKnownIssueStatus;
  publicTitle: string;
  publicSummary: string;
}
