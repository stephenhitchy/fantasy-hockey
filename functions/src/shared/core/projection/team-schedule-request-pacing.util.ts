export const STRICT_TEAM_SCHEDULE_REQUEST_DELAY_MILLISECONDS = 3_000;
export const STRICT_TEAM_SCHEDULE_MAX_FAILURES_PER_ATTEMPT = 2;

type WaitImplementation = (milliseconds: number) => Promise<void>;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Draft-opening schedule input is intentionally slower than ordinary
 * projections. It stays below the NHL endpoint's observed burst envelope,
 * then leaves recovery to the existing request/readiness retry instead of
 * consuming the task deadline during a broad outage.
 */
export async function loadStrictTeamScheduleRequestsWithPacing<TInput, TResult>(
  inputs: readonly TInput[],
  load: (input: TInput) => Promise<TResult>,
  waitImplementation: WaitImplementation = wait,
): Promise<Array<PromiseSettledResult<TResult>>> {
  const results: Array<PromiseSettledResult<TResult>> = new Array(inputs.length);
  let failedRequestCount = 0;

  for (let index = 0; index < inputs.length; index += 1) {
    try {
      results[index] = {
        status: 'fulfilled',
        value: await load(inputs[index]),
      };
    } catch (reason: unknown) {
      failedRequestCount += 1;
      results[index] = { status: 'rejected', reason };

      if (failedRequestCount >= STRICT_TEAM_SCHEDULE_MAX_FAILURES_PER_ATTEMPT) {
        for (let skippedIndex = index + 1; skippedIndex < inputs.length; skippedIndex += 1) {
          results[skippedIndex] = {
            status: 'rejected',
            reason: new Error(
              'Strict Draft schedule input stopped after its bounded NHL failure budget.',
            ),
          };
        }
        break;
      }
    }

    if (index + 1 < inputs.length) {
      await waitImplementation(STRICT_TEAM_SCHEDULE_REQUEST_DELAY_MILLISECONDS);
    }
  }

  return results;
}
