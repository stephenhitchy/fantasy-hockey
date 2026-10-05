export function clampDashboardLeagueRailIndex(index: number, count: number): number {
  if (!Number.isFinite(index) || count <= 0) {
    return 0;
  }

  return Math.min(Math.max(Math.trunc(index), 0), count - 1);
}

export function getDashboardLeagueRailIndex(
  scrollLeft: number,
  cardOffsets: readonly number[],
): number {
  if (cardOffsets.length === 0 || !Number.isFinite(scrollLeft)) {
    return 0;
  }

  let closestIndex = 0;
  let closestDistance = Number.POSITIVE_INFINITY;

  cardOffsets.forEach((offset, index) => {
    const distance = Math.abs(scrollLeft - offset);

    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
  });

  return closestIndex;
}
