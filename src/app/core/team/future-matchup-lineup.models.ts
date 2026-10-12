export type FutureMatchupLineupPlanStatus =
  | 'planned'
  | 'partially-applied'
  | 'applied'
  | 'conflicted';

export type FutureMatchupLineupSlotResolution =
  | 'planned'
  | 'applied'
  | 'unchanged'
  | 'conflict';

export interface FutureMatchupLineupSlotInput {
  rosterSlotId: string;
  assetKey: string | null;
}

export interface FutureMatchupLineupSlotView extends FutureMatchupLineupSlotInput {
  resolution: FutureMatchupLineupSlotResolution;
  resolvedAssetKey?: string | null;
  reason?: string;
  resolvedAtMs?: number;
}

export interface FutureMatchupLineupPlanView {
  ownerId: string;
  cycleNumber: number;
  revision: number;
  status: FutureMatchupLineupPlanStatus;
  slots: FutureMatchupLineupSlotView[];
  materializedSlotCount: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ListFutureMatchupLineupPlansRequest {
  leagueId: string;
  operation: 'list';
}

export interface SaveFutureMatchupLineupPlanRequest {
  leagueId: string;
  operation: 'save';
  cycleNumber: number;
  expectedRevision: number;
  requestId: string;
  slots: FutureMatchupLineupSlotInput[];
}

export interface ClearFutureMatchupLineupPlanRequest {
  leagueId: string;
  operation: 'clear';
  cycleNumber: number;
  expectedRevision: number;
  requestId: string;
}

export type ManageFutureMatchupLineupsRequest =
  | ListFutureMatchupLineupPlansRequest
  | SaveFutureMatchupLineupPlanRequest
  | ClearFutureMatchupLineupPlanRequest;

export interface ListFutureMatchupLineupPlansResult {
  operation: 'list';
  plans: FutureMatchupLineupPlanView[];
}

export interface SaveFutureMatchupLineupPlanResult {
  operation: 'save';
  plan: FutureMatchupLineupPlanView;
}

export interface ClearFutureMatchupLineupPlanResult {
  operation: 'clear';
  plan: null;
  clearedCycleNumber: number;
  revision: number;
}

export type ManageFutureMatchupLineupsResult =
  | ListFutureMatchupLineupPlansResult
  | SaveFutureMatchupLineupPlanResult
  | ClearFutureMatchupLineupPlanResult;

export interface SaveFutureMatchupLineupPlanInput {
  leagueId: string;
  cycleNumber: number;
  expectedRevision: number;
  requestId: string;
  slots: FutureMatchupLineupSlotInput[];
}

export interface ClearFutureMatchupLineupPlanInput {
  leagueId: string;
  cycleNumber: number;
  expectedRevision: number;
  requestId: string;
}

export type FutureMatchupLineupErrorReason =
  | 'revision-conflict'
  | 'pending-roster-move'
  | 'cycle-started'
  | 'cycle-state-invalid'
  | 'playoffs-not-supported'
  | 'historical-replay-active'
  | 'cross-cycle-asset-conflict'
  | 'lineup-plan-limit-exceeded'
  | 'plan-state-invalid'
  | 'target-pick-state-invalid'
  | 'invalid-lineup-slots'
  | 'lineup-mutation-state-invalid'
  | 'lineup-mutation-limit-exceeded'
  | 'roster-unavailable'
  | 'draft-incomplete'
  | 'season-schedule-unavailable'
  | 'request-id-reused'
  | 'roster-revision-conflict'
  | 'plan-not-found'
  | 'unknown';

export interface FutureMatchupLineupErrorDetails {
  reason: FutureMatchupLineupErrorReason;
  currentRevision: number | null;
  plan: FutureMatchupLineupPlanView | null;
  lockedSlotIds?: string[];
  assetKey?: string;
  requestedRosterSlotId?: string;
  reservedRosterSlotId?: string;
  reservedCycleNumber?: number;
}
