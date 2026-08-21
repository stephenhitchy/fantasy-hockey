import type {
  PublicFairnessCheckStatus,
  PublicFairnessEvidenceType,
  PublicFairnessMetric,
  PublicFairnessReport,
} from './public-fairness-report.models';

export function isPublicFairnessReport(value: unknown): value is PublicFairnessReport {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<PublicFairnessReport>;

  return candidate.schemaVersion === 1
    && typeof candidate.reportId === 'string'
    && typeof candidate.releaseLabel === 'string'
    && candidate.scoringRulesVersion === 4
    && candidate.projectionVersion === 11
    && Array.isArray(candidate.headlineMetrics)
    && candidate.headlineMetrics.length >= 4
    && Array.isArray(candidate.positionProfiles)
    && candidate.positionProfiles.length === 5
    && Array.isArray(candidate.archetypeChecks)
    && Array.isArray(candidate.acceptanceRanges)
    && Array.isArray(candidate.protectedInvariants);
}

export function formatFairnessMetric(metric: PublicFairnessMetric): string {
  if (metric.unit === 'percent') {
    return `${metric.value.toFixed(metric.value % 1 === 0 ? 0 : 1)}%`;
  }

  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 0,
  }).format(metric.value);
}

export function fairnessEvidenceLabel(evidenceType: PublicFairnessEvidenceType): string {
  const labels: Record<PublicFairnessEvidenceType, string> = {
    'production-rule': 'Production rule',
    'historical-simulation': 'Historical simulation',
    'historical-fantasy-relevant-windows': 'Historical six-game windows',
    'production-v4-sensitivity-estimate': 'Scoring V4 model estimate',
    'v4-sensitivity-estimate': 'Scoring V4 simulation estimate',
  };

  return labels[evidenceType];
}

export function fairnessCheckStatusLabel(status: PublicFairnessCheckStatus): string {
  const labels: Record<PublicFairnessCheckStatus, string> = {
    pass: 'Passed',
    'pass-with-monitoring': 'Passed · monitor',
    monitor: 'Monitor',
    open: 'Open',
  };

  return labels[status];
}
