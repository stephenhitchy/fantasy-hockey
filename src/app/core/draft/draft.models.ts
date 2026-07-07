export type DraftStatus =
  | 'setup'
  | 'scheduled'
  | 'live'
  | 'complete';

export type DraftPosition = 'LW' | 'C' | 'RW' | 'D' | 'G';

export interface DraftRosterRequirements {
  LW: number;
  C: number;
  RW: number;
  D: number;
  G: number;
}

export interface FantasyDraft {
  schemaVersion: number;
  status: DraftStatus;
  format: 'snake';
  totalRounds: number;
  rosterRequirements: DraftRosterRequirements;
  roundOneOrder: string[];

  scheduledStartAt: unknown | null;

  createdAt?: unknown;
  updatedAt?: unknown;
  startedAt?: unknown;
}

export interface DraftPickPreview {
  overallPick: number;
  round: number;
  pickInRound: number;
  ownerId: string;
}