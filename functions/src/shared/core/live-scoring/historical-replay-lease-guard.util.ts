export type HistoricalReplayLeaseTrigger =
  | 'scheduled'
  | 'queue-task'
  | 'draft-complete'
  | 'season-start'
  | 'historical-replay'
  | 'manual';

/**
 * Historical replay owns league scoring whenever its server control is
 * enabled. Even an incomplete or failed replay control must fail closed; only
 * the serialized replay worker may claim the scoring lease in that state.
 */
export function shouldPauseLeagueAutomationForHistoricalReplay(
  value: Record<string, unknown> | undefined,
  trigger: HistoricalReplayLeaseTrigger,
): boolean {
  return trigger !== 'historical-replay' && value?.['enabled'] === true;
}
