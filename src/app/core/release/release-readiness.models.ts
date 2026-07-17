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
  projectionVersion: number;
  liveScoringSchemaVersion: number;
  playoffFormatVersion: number;
  cycleWindowSchemaVersion: number;
  matchupCompletionSchemaVersion: number;
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
