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
  /** Fantasy lifecycle cycle used for roster moves and matchup ownership. */
  sourceCycleNumber: number;
  /** NHL six-game schedule block used to score this banked window. */
  sourceNhlBlockNumber?: number;
  /** Exact all-club provider IDs frozen for this bank's NHL source block. */
  sourceNhlTargetGameIdsByTeam?: Record<string, number[]>;
  status: 'scheduled' | 'active' | 'complete';
  assignmentStatus: FantasyPlayoffWindowAssignmentStatus;
  assignedMatchupId: string | null;
  assignedRoundNumber: number | null;
  expectedRosterSlotIds: string[];
  /** Schema 1 requires every skater pick/window copy to carry one cursor. */
  playerWindowContinuitySchemaVersion?: number;
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
