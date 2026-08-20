export const SERVICE_INCIDENT_SCHEMA_VERSION = 1 as const;
export const SERVICE_INCIDENT_RELEASE_LABEL = 'Release Candidate 55';
export const SERVICE_INCIDENT_SCORING_VERSION = 4;
export const SERVICE_INCIDENT_PROJECTION_VERSION = 11;
export const SERVICE_INCIDENT_PUBLIC_UPDATE_LIMIT = 20;
export const SERVICE_INCIDENT_ACTIVE_LIMIT = 12;
export const SERVICE_INCIDENT_RESOLVED_LIMIT = 10;
export const SERVICE_INCIDENT_AUDIT_REASON_MINIMUM_LENGTH = 12;

export type ServiceIncidentSeverity = 'p0' | 'p1' | 'p2' | 'p3';
export type ServiceIncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';
export type ServiceIncidentComponent =
  | 'accounts'
  | 'draft'
  | 'game-center'
  | 'scoring'
  | 'rosters'
  | 'waivers'
  | 'projections-data'
  | 'pwa'
  | 'support'
  | 'other';
export type ServiceIncidentCompetitiveImpact = 'unknown' | 'none' | 'possible' | 'confirmed';
export type ServiceIncidentDataState = 'live' | 'delayed' | 'stale-read-only' | 'unavailable';
export type ServiceIncidentUserAction =
  | 'continue'
  | 'avoid-draft'
  | 'avoid-roster-actions'
  | 'avoid-waivers'
  | 'read-only'
  | 'sign-out-retry'
  | 'other';
export type PublicServiceOverallStatus =
  | 'operational'
  | 'minor-issue'
  | 'degraded'
  | 'major-incident';

export interface ServiceIncidentPublicUpdate {
  updateId: string;
  status: ServiceIncidentStatus;
  message: string;
  createdAt: string;
}

export interface ServiceStatusBuildIdentity {
  releaseLabel: string;
  buildId: string;
  scoringRulesVersion: number;
  projectionVersion: number;
}

export interface ServiceIncidentDraft {
  severity: ServiceIncidentSeverity;
  status: ServiceIncidentStatus;
  affectedComponents: ServiceIncidentComponent[];
  competitiveImpact: ServiceIncidentCompetitiveImpact;
  dataState: ServiceIncidentDataState;
  dataMessage: string;
  userAction: ServiceIncidentUserAction;
  publicTitle: string;
  publicSummary: string;
  publicGuidance: string;
  internalTitle: string;
  internalNotes: string;
  nextUpdateAt: string | null;
  publicResolution: string;
  postmortemRequired: boolean;
}

export interface ServiceIncidentAdminRecord extends ServiceIncidentDraft {
  schemaVersion: 1;
  incidentId: string;
  revision: number;
  publicUpdates: ServiceIncidentPublicUpdate[];
  startedAt: string;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface PublicServiceIncident {
  incidentId: string;
  severity: ServiceIncidentSeverity;
  status: ServiceIncidentStatus;
  affectedComponents: ServiceIncidentComponent[];
  competitiveImpact: ServiceIncidentCompetitiveImpact;
  dataState: ServiceIncidentDataState;
  dataMessage: string;
  userAction: ServiceIncidentUserAction;
  title: string;
  summary: string;
  guidance: string;
  nextUpdateAt: string | null;
  publicResolution: string;
  publicUpdates: ServiceIncidentPublicUpdate[];
  startedAt: string;
  resolvedAt: string | null;
  updatedAt: string;
}

export interface PublicServiceStatusSnapshot {
  generatedAt: string;
  overallStatus: PublicServiceOverallStatus;
  headline: string;
  detail: string;
  activeIncidents: PublicServiceIncident[];
  recentResolvedIncidents: PublicServiceIncident[];
}

export interface ServiceIncidentOperationsSnapshot {
  generatedAt: string;
  build: ServiceStatusBuildIdentity;
  incidents: ServiceIncidentAdminRecord[];
  publicStatus: PublicServiceStatusSnapshot;
}

const SEVERITIES = new Set<ServiceIncidentSeverity>(['p0', 'p1', 'p2', 'p3']);
const STATUSES = new Set<ServiceIncidentStatus>([
  'investigating',
  'identified',
  'monitoring',
  'resolved',
]);
const COMPONENTS = new Set<ServiceIncidentComponent>([
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
const DATA_STATES = new Set<ServiceIncidentDataState>([
  'live',
  'delayed',
  'stale-read-only',
  'unavailable',
]);
const IMPACTS = new Set<ServiceIncidentCompetitiveImpact>([
  'unknown',
  'none',
  'possible',
  'confirmed',
]);
const USER_ACTIONS = new Set<ServiceIncidentUserAction>([
  'continue',
  'avoid-draft',
  'avoid-roster-actions',
  'avoid-waivers',
  'read-only',
  'sign-out-retry',
  'other',
]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, maximumLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maximumLength) : '';
}

function nullableIso(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function iso(value: unknown, fallback = new Date(0).toISOString()): string {
  return nullableIso(value) ?? fallback;
}

function severity(value: unknown): ServiceIncidentSeverity {
  return SEVERITIES.has(value as ServiceIncidentSeverity)
    ? value as ServiceIncidentSeverity
    : 'p2';
}

function status(value: unknown): ServiceIncidentStatus {
  return STATUSES.has(value as ServiceIncidentStatus)
    ? value as ServiceIncidentStatus
    : 'investigating';
}

function competitiveImpact(value: unknown): ServiceIncidentCompetitiveImpact {
  return IMPACTS.has(value as ServiceIncidentCompetitiveImpact)
    ? value as ServiceIncidentCompetitiveImpact
    : 'unknown';
}

function dataState(value: unknown): ServiceIncidentDataState {
  return DATA_STATES.has(value as ServiceIncidentDataState)
    ? value as ServiceIncidentDataState
    : 'live';
}

function userAction(value: unknown): ServiceIncidentUserAction {
  return USER_ACTIONS.has(value as ServiceIncidentUserAction)
    ? value as ServiceIncidentUserAction
    : 'continue';
}

function affectedComponents(value: unknown): ServiceIncidentComponent[] {
  const entries = Array.isArray(value) ? value : [];
  return [...new Set(entries.filter((entry): entry is ServiceIncidentComponent =>
    COMPONENTS.has(entry as ServiceIncidentComponent)))]
    .slice(0, COMPONENTS.size)
    .sort();
}

function publicUpdates(value: unknown): ServiceIncidentPublicUpdate[] {
  const entries = Array.isArray(value) ? value : [];
  return entries
    .map((entry): ServiceIncidentPublicUpdate | null => {
      const source = record(entry);
      const updateId = text(source['updateId'], 80);
      const message = text(source['message'], 800);
      const createdAt = nullableIso(source['createdAt']);

      if (!updateId || !message || !createdAt) {
        return null;
      }

      return {
        updateId,
        status: status(source['status']),
        message,
        createdAt,
      };
    })
    .filter((entry): entry is ServiceIncidentPublicUpdate => Boolean(entry))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, SERVICE_INCIDENT_PUBLIC_UPDATE_LIMIT);
}

export function emptyServiceIncidentDraft(): ServiceIncidentDraft {
  return {
    severity: 'p1',
    status: 'investigating',
    affectedComponents: [],
    competitiveImpact: 'unknown',
    dataState: 'live',
    dataMessage: '',
    userAction: 'continue',
    publicTitle: '',
    publicSummary: '',
    publicGuidance: '',
    internalTitle: '',
    internalNotes: '',
    nextUpdateAt: null,
    publicResolution: '',
    postmortemRequired: true,
  };
}

export function normalizeServiceIncidentDraft(value: unknown): ServiceIncidentDraft {
  const source = record(value);
  const normalizedSeverity = severity(source['severity']);
  const normalizedStatus = status(source['status']);
  const normalizedDataState = dataState(source['dataState']);

  return {
    severity: normalizedSeverity,
    status: normalizedStatus,
    affectedComponents: affectedComponents(source['affectedComponents']),
    competitiveImpact: competitiveImpact(source['competitiveImpact']),
    dataState: normalizedDataState,
    dataMessage: normalizedDataState === 'live' ? '' : text(source['dataMessage'], 700),
    userAction: userAction(source['userAction']),
    publicTitle: text(source['publicTitle'], 140),
    publicSummary: text(source['publicSummary'], 900),
    publicGuidance: text(source['publicGuidance'], 600),
    internalTitle: text(source['internalTitle'], 180),
    internalNotes: text(source['internalNotes'], 4_000),
    nextUpdateAt: normalizedStatus === 'resolved' ? null : nullableIso(source['nextUpdateAt']),
    publicResolution: text(source['publicResolution'], 1_000),
    postmortemRequired: normalizedSeverity === 'p0' || source['postmortemRequired'] === true,
  };
}

export function normalizeServiceIncidentAdminRecord(
  incidentId: string,
  value: unknown,
): ServiceIncidentAdminRecord {
  const source = record(value);
  const draft = normalizeServiceIncidentDraft(source);
  const createdAt = iso(source['createdAt']);
  const updatedAt = iso(source['updatedAt'], createdAt);
  const startedAt = iso(source['startedAt'], createdAt);

  return {
    schemaVersion: SERVICE_INCIDENT_SCHEMA_VERSION,
    incidentId,
    revision: typeof source['revision'] === 'number' && Number.isInteger(source['revision'])
      ? Math.max(0, source['revision'])
      : 0,
    ...draft,
    publicUpdates: publicUpdates(source['publicUpdates']),
    startedAt,
    resolvedAt: draft.status === 'resolved'
      ? nullableIso(source['resolvedAt']) ?? updatedAt
      : null,
    createdAt,
    updatedAt,
    updatedBy: text(source['updatedBy'], 128),
  };
}

export function publicServiceIncident(
  value: ServiceIncidentAdminRecord,
): PublicServiceIncident {
  return {
    incidentId: value.incidentId,
    severity: value.severity,
    status: value.status,
    affectedComponents: [...value.affectedComponents],
    competitiveImpact: value.competitiveImpact,
    dataState: value.dataState,
    dataMessage: value.dataMessage,
    userAction: value.userAction,
    title: value.publicTitle,
    summary: value.publicSummary,
    guidance: value.publicGuidance,
    nextUpdateAt: value.nextUpdateAt,
    publicResolution: value.publicResolution,
    publicUpdates: [...value.publicUpdates],
    startedAt: value.startedAt,
    resolvedAt: value.resolvedAt,
    updatedAt: value.updatedAt,
  };
}

const SEVERITY_ORDER: Record<ServiceIncidentSeverity, number> = {
  p0: 0,
  p1: 1,
  p2: 2,
  p3: 3,
};

export function sortServiceIncidents<T extends { severity: ServiceIncidentSeverity; updatedAt: string }>(
  incidents: readonly T[],
): T[] {
  return [...incidents].sort((left, right) => {
    const severityDifference = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
    if (severityDifference !== 0) {
      return severityDifference;
    }
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
}

export function buildPublicServiceStatusSnapshot(
  incidents: readonly PublicServiceIncident[],
  generatedAt = new Date().toISOString(),
): PublicServiceStatusSnapshot {
  const activeIncidents = sortServiceIncidents(
    incidents.filter((incident) => incident.status !== 'resolved'),
  ).slice(0, SERVICE_INCIDENT_ACTIVE_LIMIT);
  const recentResolvedIncidents = [...incidents]
    .filter((incident) => incident.status === 'resolved')
    .sort((left, right) => Date.parse(right.resolvedAt ?? right.updatedAt) -
      Date.parse(left.resolvedAt ?? left.updatedAt))
    .slice(0, SERVICE_INCIDENT_RESOLVED_LIMIT);

  const activeSeverities = new Set(activeIncidents.map((incident) => incident.severity));
  const overallStatus: PublicServiceOverallStatus = activeSeverities.has('p0')
    ? 'major-incident'
    : activeSeverities.has('p1')
      ? 'degraded'
      : activeIncidents.length > 0
        ? 'minor-issue'
        : 'operational';

  const headline = overallStatus === 'major-incident'
    ? 'Major service incident'
    : overallStatus === 'degraded'
      ? 'Some RinkRat services are degraded'
      : overallStatus === 'minor-issue'
        ? 'Minor service issue'
        : 'All monitored RinkRat systems are operational';
  const detail = activeIncidents.length === 0
    ? 'No active public incident is currently posted.'
    : `${activeIncidents.length} active incident${activeIncidents.length === 1 ? '' : 's'} currently posted.`;

  return {
    generatedAt,
    overallStatus,
    headline,
    detail,
    activeIncidents,
    recentResolvedIncidents,
  };
}

export function serviceIncidentResponseTarget(severityValue: ServiceIncidentSeverity): string {
  const targets: Record<ServiceIncidentSeverity, string> = {
    p0: 'Acknowledge within 30 minutes during covered hours; update every 30–60 minutes.',
    p1: 'Acknowledge within 2 hours; provide a workaround or rollback the same day when possible.',
    p2: 'Triage within one business day and schedule by user impact.',
    p3: 'Batch with normal product work; do not destabilize the season.',
  };

  return targets[severityValue];
}
