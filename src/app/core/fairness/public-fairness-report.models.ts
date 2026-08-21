export type PublicFairnessEvidenceType =
  | 'production-rule'
  | 'historical-simulation'
  | 'historical-fantasy-relevant-windows'
  | 'production-v4-sensitivity-estimate'
  | 'v4-sensitivity-estimate';

export type PublicFairnessCheckStatus = 'pass' | 'pass-with-monitoring' | 'monitor' | 'open';

export interface PublicFairnessMetric {
  id: string;
  label: string;
  value: number;
  unit: 'games' | 'matchups' | 'percent';
  evidenceType: PublicFairnessEvidenceType;
}

export interface PublicFairnessPositionProfile {
  position: 'C' | 'LW' | 'RW' | 'D' | 'G';
  label: string;
  role: string;
  meanSixGamePoints: number;
  coefficientOfVariation: number;
  p10: number;
  p90: number;
  hundredPlusPercent: number;
  evidenceType: PublicFairnessEvidenceType;
}

export interface PublicFairnessArchetypeCheck {
  id: string;
  label: string;
  status: PublicFairnessCheckStatus;
  finding: string;
}

export interface PublicFairnessAcceptanceRange {
  id: string;
  label: string;
  minimum: number;
  maximum: number;
  unit: 'percent';
  basis: string;
}

export interface PublicFairnessReport {
  schemaVersion: 1;
  reportVersion: number;
  reportId: string;
  publishedDate: string;
  title: string;
  subtitle: string;
  evidenceStatus: string;
  summary: string;
  releaseLabel: string;
  scoringRulesVersion: number;
  projectionVersion: number;
  evidenceFingerprint: string;
  downloads: {
    json: string;
    csv: string;
  };
  opportunityDesign: {
    scheduledGamesPerActiveSlot: number;
    seventhGameRollsOver: boolean;
    independentRosterSlotWindows: boolean;
    completedWindowsImmutable: boolean;
    serverAuthoritativeScoring: boolean;
    frozenWindowProjections: boolean;
    equalizes: string[];
    doesNotEqualize: string[];
  };
  methodology: {
    seasons: string[];
    playoffsIncluded: boolean;
    regularSeasonGames: number;
    skaterGameRecords: number;
    teamGoalieGameRecords: number;
    completeSkaterSixGameWindows: number;
    completeGoalieSixGameWindows: number;
    simulatedLeagues: number;
    simulatedMatchups: number;
    simulatedFirstRounds: number;
    windowRule: string;
    limitations: string[];
  };
  headlineMetrics: PublicFairnessMetric[];
  positionProfiles: PublicFairnessPositionProfile[];
  leagueSimulation: {
    projectedUnderdogWinPercent: number;
    closeMatchupPercentWithin25: number;
    blowoutPercentAtLeast150: number;
    topProjectedRosterTopFourPercent: number;
    bottomProjectedRosterTopFourPercent: number;
    interpretation: string;
  };
  archetypeChecks: PublicFairnessArchetypeCheck[];
  acceptanceRanges: PublicFairnessAcceptanceRange[];
  protectedInvariants: string[];
}
