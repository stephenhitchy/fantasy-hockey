export type ReleaseReadinessLevel = 'pass' | 'warning' | 'fail';

export interface ReleaseReadinessCheck {
  id: string;
  category: 'configuration' | 'league' | 'scoring' | 'projection' | 'injury' | 'playoffs';
  label: string;
  detail: string;
  level: ReleaseReadinessLevel;
  requiredForLiveLaunch: boolean;
}

export interface ReleaseVersionSummary {
  releaseLabel: string;
  scoringRulesVersion: number;
  leagueAuthoritySchemaVersion: number;
  projectionVersion: number;
  liveScoringSchemaVersion: number;
  playoffFormatVersion: number;
  cycleWindowSchemaVersion: number;
  matchupCompletionSchemaVersion: number;
  appCheckClientEnabled: boolean;
}


export interface ReleaseSecuritySummary {
  available: boolean;
  appCheckClientStatus: string;
  appCheckServerStatus: 'valid' | 'missing' | 'unavailable';
  appCheckAppId: string | null;
  passwordPolicyEnforcement: string;
  passwordMinimumLength: number | null;
  passwordMaximumLength: number | null;
  passwordRequiresLowercase: boolean;
  passwordRequiresUppercase: boolean;
  passwordRequiresNumeric: boolean;
  passwordRequiresNonAlphanumeric: boolean;
  emailEnumerationProtectionEnabled: boolean;
  emailVerified: boolean;
  recentAuthenticationReady: boolean;
  recentAuthenticationWindowSeconds: number;
  multiFactorState: string;
  retentionCleanupStatus: string;
  retentionCleanupLastCompletedAt: string | null;
  retentionCleanupDeletedCount: number;
  retentionCleanupFailureCount: number;
  cspReportReceivedCount: number;
  cspReportLastReceivedAt: string | null;
  hostingCspReportOnlyReady: boolean;
  hostingHstsReady: boolean;
  configurationError: string;
}

export interface ReleaseReadinessSnapshot {
  leagueId: string;
  generatedAt: string;
  overallStatus: 'ready' | 'testing' | 'attention';
  passedRequiredCount: number;
  totalRequiredCount: number;
  warningCount: number;
  checks: ReleaseReadinessCheck[];
  versions: ReleaseVersionSummary;
  security: ReleaseSecuritySummary;
  scoringMode: 'historical' | 'live';
  historicalDateIso: string | null;
  developerToolsEnabled: boolean;
  latestCycleNumber: number | null;
  activeCycleNumbers: number[];
  teamCount: number;
  maxTeams: number;
  draftStatus: string;
  projectionStatus: string;
  projectionTargetCycleNumber: number | null;
  lastInjurySyncAt: string | null;
  liveScoringStatus: string;
  lastLiveScoringSyncAt: string | null;
  playoffStatus: string;
}

export interface SeasonLifecycleSimulationCheck {
  id: string;
  stage: string;
  label: string;
  expected: string;
  actual: string;
  passed: boolean;
}

export interface SeasonLifecycleMilestone {
  order: number;
  label: string;
  status: 'passed' | 'failed';
  detail: string;
}

export interface SeasonLifecycleSimulationResult {
  passed: boolean;
  passedCount: number;
  totalCount: number;
  checks: SeasonLifecycleSimulationCheck[];
  milestones: SeasonLifecycleMilestone[];
  simulatedTeamCount: number;
  simulatedRegularSeasonCycleCount: number;
  simulatedRosterSlotsPerTeam: number;
  simulatedGamesPerWindow: number;
}
