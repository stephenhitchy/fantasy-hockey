import type { OperationsClientIdentity } from './operations-client-compatibility';

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

export interface ServiceStatusBuildIdentity extends OperationsClientIdentity {}

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

export interface ServiceStatusState {
  snapshot: PublicServiceStatusSnapshot | null;
  stale: boolean;
  source: 'live' | 'cache' | 'none';
  loadedAt: string | null;
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

export interface ServiceIncidentOperationsSnapshot {
  generatedAt: string;
  build: ServiceStatusBuildIdentity;
  incidents: ServiceIncidentAdminRecord[];
  publicStatus: PublicServiceStatusSnapshot;
}
