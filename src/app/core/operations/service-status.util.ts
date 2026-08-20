import type {
  PublicServiceIncident,
  PublicServiceOverallStatus,
  PublicServiceStatusSnapshot,
  ServiceIncidentComponent,
  ServiceIncidentCompetitiveImpact,
  ServiceIncidentDataState,
  ServiceIncidentPublicUpdate,
  ServiceIncidentSeverity,
  ServiceIncidentStatus,
  ServiceIncidentUserAction,
} from './service-status.models';

export function emptyServiceIncidentDraft() {
  return {
    severity: 'p1' as const,
    status: 'investigating' as const,
    affectedComponents: [] as ServiceIncidentComponent[],
    competitiveImpact: 'unknown' as const,
    dataState: 'live' as const,
    dataMessage: '',
    userAction: 'continue' as const,
    publicTitle: '',
    publicSummary: '',
    publicGuidance: '',
    internalTitle: '',
    internalNotes: '',
    nextUpdateAt: null as string | null,
    publicResolution: '',
    postmortemRequired: true,
  };
}

export function serviceIncidentSeverityLabel(value: ServiceIncidentSeverity): string {
  const labels: Record<ServiceIncidentSeverity, string> = {
    p0: 'P0 · Competition integrity',
    p1: 'P1 · Blocked action',
    p2: 'P2 · Serious degradation',
    p3: 'P3 · Advisory',
  };
  return labels[value];
}

export function serviceIncidentStatusLabel(value: ServiceIncidentStatus): string {
  const labels: Record<ServiceIncidentStatus, string> = {
    investigating: 'Investigating',
    identified: 'Cause identified',
    monitoring: 'Monitoring recovery',
    resolved: 'Resolved',
  };
  return labels[value];
}

export function serviceIncidentComponentLabel(value: ServiceIncidentComponent): string {
  const labels: Record<ServiceIncidentComponent, string> = {
    accounts: 'Accounts',
    draft: 'Draft',
    'game-center': 'Game Center',
    scoring: 'Scoring',
    rosters: 'Rosters',
    waivers: 'Waivers',
    'projections-data': 'Projections & NHL data',
    pwa: 'Installed app / PWA',
    support: 'Support',
    other: 'Other',
  };
  return labels[value];
}


export function serviceIncidentCompetitiveImpactLabel(
  value: ServiceIncidentCompetitiveImpact,
): string {
  const labels: Record<ServiceIncidentCompetitiveImpact, string> = {
    unknown: 'Impact still being confirmed',
    none: 'No competitive impact identified',
    possible: 'Competitive impact is possible',
    confirmed: 'Competitive impact confirmed',
  };
  return labels[value];
}

export function serviceIncidentDataStateLabel(value: ServiceIncidentDataState): string {
  const labels: Record<ServiceIncidentDataState, string> = {
    live: 'Live authoritative data',
    delayed: 'Live data delayed',
    'stale-read-only': 'Saved or stale read-only presentation',
    unavailable: 'Live data unavailable',
  };
  return labels[value];
}

export function serviceIncidentUserActionLabel(value: ServiceIncidentUserAction): string {
  const labels: Record<ServiceIncidentUserAction, string> = {
    continue: 'Continue using RinkRat normally',
    'avoid-draft': 'Do not start or continue a Draft',
    'avoid-roster-actions': 'Pause roster actions',
    'avoid-waivers': 'Pause waiver actions',
    'read-only': 'Use RinkRat as read-only',
    'sign-out-retry': 'Sign out, then retry after reconnecting',
    other: 'Follow the incident guidance',
  };
  return labels[value];
}

export function serviceStatusLabel(value: PublicServiceOverallStatus): string {
  const labels: Record<PublicServiceOverallStatus, string> = {
    operational: 'Operational',
    'minor-issue': 'Minor issue',
    degraded: 'Degraded service',
    'major-incident': 'Major incident',
  };
  return labels[value];
}

export function highestPriorityBannerIncident(
  incidents: readonly PublicServiceIncident[],
): PublicServiceIncident | null {
  return incidents.find((incident) => incident.severity === 'p0')
    ?? incidents.find((incident) => incident.severity === 'p1')
    ?? null;
}

export function serviceIncidentResponseTarget(value: ServiceIncidentSeverity): string {
  const targets: Record<ServiceIncidentSeverity, string> = {
    p0: 'Acknowledge within 30 minutes during covered hours; update every 30–60 minutes.',
    p1: 'Acknowledge within 2 hours; provide a workaround or rollback the same day when possible.',
    p2: 'Triage within one business day and schedule by user impact.',
    p3: 'Batch with normal product work; do not destabilize the season.',
  };
  return targets[value];
}

const SERVICE_STATUS_SEVERITIES = new Set<ServiceIncidentSeverity>(['p0', 'p1', 'p2', 'p3']);
const SERVICE_STATUS_STATUSES = new Set<ServiceIncidentStatus>([
  'investigating',
  'identified',
  'monitoring',
  'resolved',
]);
const SERVICE_STATUS_COMPONENTS = new Set<ServiceIncidentComponent>([
  'accounts',
  'draft',
  'game-center',
  'scoring',
  'rosters',
  'waivers',
  'projections-data',
  'pwa',
  'support',
  'other',
]);
const SERVICE_STATUS_IMPACTS = new Set<ServiceIncidentCompetitiveImpact>([
  'unknown',
  'none',
  'possible',
  'confirmed',
]);
const SERVICE_STATUS_DATA_STATES = new Set<ServiceIncidentDataState>([
  'live',
  'delayed',
  'stale-read-only',
  'unavailable',
]);
const SERVICE_STATUS_USER_ACTIONS = new Set<ServiceIncidentUserAction>([
  'continue',
  'avoid-draft',
  'avoid-roster-actions',
  'avoid-waivers',
  'read-only',
  'sign-out-retry',
  'other',
]);
const SERVICE_STATUS_OVERALL_STATES = new Set<PublicServiceOverallStatus>([
  'operational',
  'minor-issue',
  'degraded',
  'major-incident',
]);

function statusRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function statusText(value: unknown, maximumLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maximumLength) : '';
}

function statusNullableText(value: unknown, maximumLength: number): string | null {
  const result = statusText(value, maximumLength);
  return result || null;
}

function normalizePublicUpdate(value: unknown): ServiceIncidentPublicUpdate | null {
  const source = statusRecord(value);
  const updateId = statusText(source['updateId'], 80);
  const message = statusText(source['message'], 800);
  const createdAt = statusText(source['createdAt'], 80);
  const updateStatus = source['status'];

  if (
    !updateId ||
    !message ||
    !createdAt ||
    !SERVICE_STATUS_STATUSES.has(updateStatus as ServiceIncidentStatus)
  ) {
    return null;
  }

  return {
    updateId,
    status: updateStatus as ServiceIncidentStatus,
    message,
    createdAt,
  };
}

function normalizePublicIncident(value: unknown): PublicServiceIncident | null {
  const source = statusRecord(value);
  const incidentId = statusText(source['incidentId'], 128);
  const title = statusText(source['title'], 140);
  const summary = statusText(source['summary'], 900);
  const incidentSeverity = source['severity'];
  const incidentStatus = source['status'];
  const impact = source['competitiveImpact'];
  const incidentDataState = source['dataState'];
  const incidentUserAction = source['userAction'];

  if (
    !incidentId ||
    !title ||
    !summary ||
    !SERVICE_STATUS_SEVERITIES.has(incidentSeverity as ServiceIncidentSeverity) ||
    !SERVICE_STATUS_STATUSES.has(incidentStatus as ServiceIncidentStatus) ||
    !SERVICE_STATUS_IMPACTS.has(impact as ServiceIncidentCompetitiveImpact) ||
    !SERVICE_STATUS_DATA_STATES.has(incidentDataState as ServiceIncidentDataState) ||
    !SERVICE_STATUS_USER_ACTIONS.has(incidentUserAction as ServiceIncidentUserAction)
  ) {
    return null;
  }

  const components = Array.isArray(source['affectedComponents'])
    ? [...new Set(source['affectedComponents'].filter((entry): entry is ServiceIncidentComponent =>
        SERVICE_STATUS_COMPONENTS.has(entry as ServiceIncidentComponent)))]
    : [];
  const updates = Array.isArray(source['publicUpdates'])
    ? source['publicUpdates']
        .map((entry) => normalizePublicUpdate(entry))
        .filter((entry): entry is ServiceIncidentPublicUpdate => Boolean(entry))
        .slice(0, 20)
    : [];

  return {
    incidentId,
    severity: incidentSeverity as ServiceIncidentSeverity,
    status: incidentStatus as ServiceIncidentStatus,
    affectedComponents: components,
    competitiveImpact: impact as ServiceIncidentCompetitiveImpact,
    dataState: incidentDataState as ServiceIncidentDataState,
    dataMessage: statusText(source['dataMessage'], 700),
    userAction: incidentUserAction as ServiceIncidentUserAction,
    title,
    summary,
    guidance: statusText(source['guidance'], 600),
    nextUpdateAt: statusNullableText(source['nextUpdateAt'], 80),
    publicResolution: statusText(source['publicResolution'], 1_000),
    publicUpdates: updates,
    startedAt: statusText(source['startedAt'], 80),
    resolvedAt: statusNullableText(source['resolvedAt'], 80),
    updatedAt: statusText(source['updatedAt'], 80),
  };
}

export function normalizePublicServiceStatusSnapshot(
  value: unknown,
): PublicServiceStatusSnapshot | null {
  const source = statusRecord(value);
  const overallStatus = source['overallStatus'];
  const generatedAt = statusText(source['generatedAt'], 80);
  const headline = statusText(source['headline'], 180);
  const detail = statusText(source['detail'], 500);

  if (
    !generatedAt ||
    !headline ||
    !detail ||
    !SERVICE_STATUS_OVERALL_STATES.has(overallStatus as PublicServiceOverallStatus) ||
    !Array.isArray(source['activeIncidents']) ||
    !Array.isArray(source['recentResolvedIncidents'])
  ) {
    return null;
  }

  return {
    generatedAt,
    overallStatus: overallStatus as PublicServiceOverallStatus,
    headline,
    detail,
    activeIncidents: source['activeIncidents']
      .map((entry) => normalizePublicIncident(entry))
      .filter((entry): entry is PublicServiceIncident => Boolean(entry))
      .slice(0, 12),
    recentResolvedIncidents: source['recentResolvedIncidents']
      .map((entry) => normalizePublicIncident(entry))
      .filter((entry): entry is PublicServiceIncident => Boolean(entry))
      .slice(0, 10),
  };
}
