import type { DraftStatus } from '../../../core/draft/draft.models';

export interface PreDraftCommissionerVisibilityInput {
  isCommissioner: boolean;
  draftStatus: DraftStatus | null | undefined;
  hasStartedCompetition: boolean;
}

/**
 * Capacity and membership controls stop being useful once drafting or fantasy
 * competition has begun. Keep them available throughout setup and scheduling,
 * including the safe postpone/reopen path, then remove them from League HQ.
 */
export function shouldShowPreDraftCommissionerManagement(
  input: PreDraftCommissionerVisibilityInput,
): boolean {
  return Boolean(
    input.isCommissioner &&
      !input.hasStartedCompetition &&
      input.draftStatus !== 'live' &&
      input.draftStatus !== 'complete',
  );
}
