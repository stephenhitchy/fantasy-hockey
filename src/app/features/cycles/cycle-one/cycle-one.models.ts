import type { DraftableAsset, DraftPick, DraftPosition } from '../../../core/draft/draft.models';
import type { BenchRosterSlot } from '../../../core/team/roster.models';

export const CYCLE_PROJECTION_WINDOW_DAYS = 14;
export const NHL_SCHEDULE_BATCH_SIZE = 4;

export const PROJECTION_NEUTRAL_PERCENT = 0.1;
export const PROJECTION_NEUTRAL_POINTS = 10;

export type MatchupViewMode = 'teamA' | 'both' | 'teamB';

export interface MatchupPositionBreakdownRow {
  position: DraftPosition;
  label: string;
  actual: number;
  projected: number | null;
  delta: number | null;
}

export interface MatchupAssetPerformanceRow {
  asset: DraftableAsset;
  ownerId: string;
  teamName: string;
  actual: number;
  projected: number | null;
  delta: number | null;
  position: DraftPosition;
}

export interface MobileMatchupPlayerPair {
  position: DraftPosition;
  slotIndex: number;
  teamAPick: DraftPick | null;
  teamBPick: DraftPick | null;
}

export interface MobileMatchupPositionGroup {
  position: DraftPosition;
  label: string;
  rows: MobileMatchupPlayerPair[];
}

export interface MobileMatchupSection {
  key: 'forwards' | 'defense' | 'goalie';
  label: string;
  shortLabel: string;
  positions: DraftPosition[];
  rows: MobileMatchupPlayerPair[];
}

export interface MobileMatchupBenchRow {
  slotIndex: number;
  teamASlot: BenchRosterSlot;
  teamBSlot: BenchRosterSlot;
}

export interface CycleWindowGameMarker {
  index: number;
  gameId: number | null;
  gameDate: string | null;
  gameLabel: string;
  status: 'played' | 'missed' | 'upcoming' | 'unavailable';
  statusLabel: string;
  title: string;
}

export interface ScoreDeltaAnimation {
  id: number;
  delta: number;
  direction: 'gain' | 'loss';
  ownerId: string;
  presentation: 'my-team' | 'opponent';
}

export interface OwnerTeamIdentity {
  abbreviation: string;
  variantId: string;
}

export interface PendingScoreDelta {
  delta: number;
  rosterOrder: number;
  targetScore: number;
  ownerId: string;
}
