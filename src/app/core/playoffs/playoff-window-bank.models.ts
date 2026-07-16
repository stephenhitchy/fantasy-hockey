import { DraftPick } from '../draft/draft.models';
import { FantasyAssetCycleWindow } from '../cycle/cycle.models';

export type FantasyPlayoffWindowAssignmentStatus =
  | 'unassigned'
  | 'assigned'
  | 'unused';

export interface FantasyPlayoffWindowBank {
  id: string;
  ownerId: string;
  windowNumber: number;
  sourceCycleNumber: number;
  status: 'scheduled' | 'active' | 'complete';
  assignmentStatus: FantasyPlayoffWindowAssignmentStatus;
  assignedMatchupId: string | null;
  assignedRoundNumber: number | null;
  expectedRosterSlotIds: string[];
  picks: DraftPick[];
  slotWindows: FantasyAssetCycleWindow[];
  teamScore: number;
  completedWindowCount: number;
  totalWindowCount: number;
  createdAt?: unknown;
  updatedAt?: unknown;
  completedAt?: unknown | null;
  assignedAt?: unknown | null;
}
