export interface TeamScheduleInputCompleteness {
  season: string;
  expectedTeamCount: number;
  loadedTeamCount: number;
  failedTeamCount: number;
  requireCompleteInput: boolean;
}

export const TEAM_SCHEDULE_INPUT_CONTRACT_VERSION = 1;

export function hasCompleteTeamScheduleInputAttestation(input: {
  teamScheduleInputContractVersion?: unknown;
  teamScheduleInputCompleteness?: unknown;
}): boolean {
  return (
    input.teamScheduleInputContractVersion ===
      TEAM_SCHEDULE_INPUT_CONTRACT_VERSION &&
    input.teamScheduleInputCompleteness === 'complete'
  );
}

export class IncompleteTeamScheduleInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncompleteTeamScheduleInputError';
  }
}

export function requiresCompleteTeamScheduleInputForGeneration(
  generationReason: string,
): boolean {
  return (
    generationReason === 'pre-draft' ||
    generationReason === 'draft-start-fallback'
  );
}

export function assertCompleteTeamScheduleInput(
  input: TeamScheduleInputCompleteness,
): void {
  if (!input.requireCompleteInput) {
    return;
  }

  const expectedTeamCount = Math.max(0, Math.trunc(input.expectedTeamCount));
  const loadedTeamCount = Math.max(0, Math.trunc(input.loadedTeamCount));
  const failedTeamCount = Math.max(0, Math.trunc(input.failedTeamCount));

  if (
    expectedTeamCount > 0 &&
    failedTeamCount === 0 &&
    loadedTeamCount === expectedTeamCount
  ) {
    return;
  }

  throw new IncompleteTeamScheduleInputError(
    `NHL team schedule projection input was incomplete for ${input.season} ` +
      `(${loadedTeamCount} of ${expectedTeamCount} team schedules available). ` +
      'The previous shared Projection V11 snapshot was preserved. Retry after the NHL data service recovers.',
  );
}
