export function getCycleGameStartIndex(
  cycleNumber: number,
  requiredGamesPerCycle: number
): number {
  return Math.max(0, (cycleNumber - 1) * requiredGamesPerCycle);
}

export function getCycleGameEndIndex(
  cycleNumber: number,
  requiredGamesPerCycle: number
): number {
  return cycleNumber * requiredGamesPerCycle;
}

export function selectCycleWindowGames<T>(
  schedule: T[],
  cycleNumber: number,
  requiredGamesPerCycle: number
): T[] {
  return schedule.slice(
    getCycleGameStartIndex(cycleNumber, requiredGamesPerCycle),
    getCycleGameEndIndex(cycleNumber, requiredGamesPerCycle)
  );
}
