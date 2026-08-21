import type { OperationsClientIdentity } from './operations-client-compatibility';

export type PrivateSeasonStatus =
  | 'planning'
  | 'rehearsal'
  | 'approved'
  | 'delayed'
  | 'live'
  | 'complete';

export type PrivateSeasonExperience =
  | 'hockey-expert'
  | 'casual-fan'
  | 'fantasy-beginner';

export type PrivateSeasonDevice = 'iphone' | 'android' | 'desktop';
export type PrivateSeasonTesterRole = 'commissioner' | 'manager';
export type PrivateSeasonGateOutcome = 'approved' | 'delayed';

export interface PrivateSeasonLeagueSlot {
  slotId: string;
  leagueId: string;
  label: string;
  expectedManagerCount: number;
  draftRehearsalComplete: boolean;
  active: boolean;
}

export interface PrivateSeasonTester {
  testerId: string;
  alias: string;
  leagueSlotIds: string[];
  role: PrivateSeasonTesterRole;
  experience: PrivateSeasonExperience;
  devices: PrivateSeasonDevice[];
  isFounder: boolean;
  contactConfirmed: boolean;
  consentConfirmed: boolean;
  accountReady: boolean;
  draftRehearsalComplete: boolean;
}

export interface PrivateSeasonSupportReadiness {
  primaryOwner: string;
  deputyAlias: string;
  supportChannelReady: boolean;
  knownIssuesReady: boolean;
  rollbackRehearsed: boolean;
  deputyConfirmed: boolean;
  coverageConfirmed: boolean;
}

export interface PrivateSeasonFreezeReadiness {
  featureFreezeConfirmed: boolean;
  approvedReleaseLabel: string;
  approvedBuildId: string;
  nonGoals: string[];
}

export interface PrivateSeasonGateDecision {
  decisionId: string;
  gate: 'private-season';
  outcome: PrivateSeasonGateOutcome;
  reason: string;
  planRevision: number;
  planHash: string;
  releaseLabel: string;
  buildId: string;
  recordedAt: string | null;
  recordedBy: string;
}

export interface PrivateSeasonPlan {
  schemaVersion: 1;
  seasonLabel: '2026-27';
  revision: number;
  status: PrivateSeasonStatus;
  leagueSlots: PrivateSeasonLeagueSlot[];
  testers: PrivateSeasonTester[];
  support: PrivateSeasonSupportReadiness;
  freeze: PrivateSeasonFreezeReadiness;
  latestDecision: PrivateSeasonGateDecision | null;
  updatedAt: string | null;
  updatedBy: string;
}

export interface PrivateSeasonLiveLeagueEvidence {
  slotId: string;
  leagueId: string;
  exists: boolean;
  name: string;
  teamCount: number;
  maxTeams: number;
  draftStatus: string;
  draftOrderCount: number;
  draftScheduled: boolean;
}

export interface PrivateSeasonBuildIdentity extends OperationsClientIdentity {}

export interface PrivateSeasonReadiness {
  status: 'blocked' | 'needs-attention' | 'ready';
  headline: string;
  blockers: string[];
  advisories: string[];
  leagueCount: number;
  testerCount: number;
  nonFounderCommissionerCount: number;
  experienceCoverage: Record<PrivateSeasonExperience, boolean>;
  deviceCoverage: Record<PrivateSeasonDevice, boolean>;
  liveLeagueEvidence: PrivateSeasonLiveLeagueEvidence[];
  exactBuildFrozen: boolean;
  currentDecisionValid: boolean;
  readyForApproval: boolean;
}

export interface PrivateSeasonPolicy {
  minimumLeagues: number;
  maximumLeagues: number;
  minimumManagersPerLeague: number;
  minimumTesters: number;
  maximumTesters: number;
  requiredExperiences: PrivateSeasonExperience[];
  requiredDevices: PrivateSeasonDevice[];
  requiresNonFounderCommissioner: true;
  decisionReasonMinimumLength: number;
  noContactDetails: true;
}

export interface PrivateSeasonControlCenterSnapshot {
  plan: PrivateSeasonPlan;
  readiness: PrivateSeasonReadiness;
  policy: PrivateSeasonPolicy;
  build: PrivateSeasonBuildIdentity;
}
