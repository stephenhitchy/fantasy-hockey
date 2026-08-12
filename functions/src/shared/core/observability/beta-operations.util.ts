export const BETA_OPERATION_SHARD_COUNT = 16;
export const BETA_OPERATION_WINDOW_DAYS_DEFAULT = 14;
export const BETA_OPERATION_WINDOW_DAYS_MAXIMUM = 30;
export const BETA_OPERATION_DAILY_RETENTION_MILLISECONDS = 180 * 24 * 60 * 60 * 1_000;

export const BETA_DURATION_BUCKETS = [
  { key: 'lt1s', upperBoundMilliseconds: 1_000 },
  { key: 'lt2_5s', upperBoundMilliseconds: 2_500 },
  { key: 'lt5s', upperBoundMilliseconds: 5_000 },
  { key: 'lt10s', upperBoundMilliseconds: 10_000 },
  { key: 'lt20s', upperBoundMilliseconds: 20_000 },
  { key: 'lt45s', upperBoundMilliseconds: 45_000 },
  { key: 'lt90s', upperBoundMilliseconds: 90_000 },
  { key: 'lt180s', upperBoundMilliseconds: 180_000 },
  { key: 'gte180s', upperBoundMilliseconds: 300_000 },
] as const;

export type BetaDurationBucketKey = (typeof BETA_DURATION_BUCKETS)[number]['key'];

export interface BetaDurationAccumulator {
  total: number;
  successes: number;
  errors: number;
  uncertain: number;
  cancelled: number;
  skipped: number;
  durationSumMilliseconds: number;
  durationMaximumMilliseconds: number;
  durationBuckets: Record<string, number>;
}

export function emptyBetaDurationAccumulator(): BetaDurationAccumulator {
  return {
    total: 0,
    successes: 0,
    errors: 0,
    uncertain: 0,
    cancelled: 0,
    skipped: 0,
    durationSumMilliseconds: 0,
    durationMaximumMilliseconds: 0,
    durationBuckets: {},
  };
}

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function finiteCount(value: unknown): number {
  return Math.max(0, Math.trunc(finiteNonNegative(value)));
}

export function normalizeBetaDurationAccumulator(value: unknown): BetaDurationAccumulator {
  if (!value || typeof value !== 'object') {
    return emptyBetaDurationAccumulator();
  }

  const candidate = value as Partial<BetaDurationAccumulator>;
  const durationBuckets = candidate.durationBuckets && typeof candidate.durationBuckets === 'object'
    ? candidate.durationBuckets
    : {};

  return {
    total: finiteCount(candidate.total),
    successes: finiteCount(candidate.successes),
    errors: finiteCount(candidate.errors),
    uncertain: finiteCount(candidate.uncertain),
    cancelled: finiteCount(candidate.cancelled),
    skipped: finiteCount(candidate.skipped),
    durationSumMilliseconds: finiteNonNegative(candidate.durationSumMilliseconds),
    durationMaximumMilliseconds: finiteNonNegative(candidate.durationMaximumMilliseconds),
    durationBuckets: Object.fromEntries(
      BETA_DURATION_BUCKETS.map(({ key }) => [key, finiteCount(durationBuckets[key])]),
    ),
  };
}

export function betaDurationBucketKey(durationMilliseconds: number): BetaDurationBucketKey {
  const normalized = Math.max(0, Math.round(durationMilliseconds));
  return BETA_DURATION_BUCKETS.find(
    ({ key, upperBoundMilliseconds }) => key === 'gte180s' || normalized < upperBoundMilliseconds,
  )?.key ?? 'gte180s';
}

export function addBetaDurationSample(
  accumulator: BetaDurationAccumulator,
  durationMilliseconds: number,
  outcome: string,
): BetaDurationAccumulator {
  const next = normalizeBetaDurationAccumulator(accumulator);
  const duration = Math.max(0, Math.round(durationMilliseconds));
  const bucket = betaDurationBucketKey(duration);

  next.total += 1;
  next.durationSumMilliseconds += duration;
  next.durationMaximumMilliseconds = Math.max(next.durationMaximumMilliseconds, duration);
  next.durationBuckets[bucket] = (next.durationBuckets[bucket] ?? 0) + 1;

  switch (outcome) {
    case 'success':
      next.successes += 1;
      break;
    case 'error':
      next.errors += 1;
      break;
    case 'uncertain':
      next.uncertain += 1;
      break;
    case 'cancelled':
      next.cancelled += 1;
      break;
    case 'skipped':
      next.skipped += 1;
      break;
  }

  return next;
}

export function mergeBetaDurationAccumulators(
  first: BetaDurationAccumulator,
  second: BetaDurationAccumulator,
): BetaDurationAccumulator {
  const left = normalizeBetaDurationAccumulator(first);
  const right = normalizeBetaDurationAccumulator(second);

  return {
    total: left.total + right.total,
    successes: left.successes + right.successes,
    errors: left.errors + right.errors,
    uncertain: left.uncertain + right.uncertain,
    cancelled: left.cancelled + right.cancelled,
    skipped: left.skipped + right.skipped,
    durationSumMilliseconds: left.durationSumMilliseconds + right.durationSumMilliseconds,
    durationMaximumMilliseconds: Math.max(
      left.durationMaximumMilliseconds,
      right.durationMaximumMilliseconds,
    ),
    durationBuckets: Object.fromEntries(
      BETA_DURATION_BUCKETS.map(({ key }) => [
        key,
        (left.durationBuckets[key] ?? 0) + (right.durationBuckets[key] ?? 0),
      ]),
    ),
  };
}

export function betaHistogramPercentile(
  durationBuckets: Record<string, number>,
  total: number,
  percentile: number,
): number {
  if (total <= 0) {
    return 0;
  }

  const target = Math.max(1, Math.ceil(total * Math.min(1, Math.max(0, percentile))));
  let cumulative = 0;

  for (const bucket of BETA_DURATION_BUCKETS) {
    cumulative += finiteCount(durationBuckets[bucket.key]);

    if (cumulative >= target) {
      return bucket.upperBoundMilliseconds;
    }
  }

  return BETA_DURATION_BUCKETS[BETA_DURATION_BUCKETS.length - 1].upperBoundMilliseconds;
}

export function betaOperationsDateKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function betaOperationsDateKeys(windowDays: number, now: Date = new Date()): string[] {
  const days = Math.min(
    BETA_OPERATION_WINDOW_DAYS_MAXIMUM,
    Math.max(1, Math.trunc(windowDays)),
  );
  const keys: string[] = [];

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(now.getTime() - offset * 24 * 60 * 60 * 1_000);
    keys.push(betaOperationsDateKey(date));
  }

  return keys;
}

export function betaOperationsShardId(seed: string): string {
  let hash = 0;

  for (let index = 0; index < seed.length; index += 1) {
    hash = ((hash << 5) - hash + seed.charCodeAt(index)) | 0;
  }

  return Math.abs(hash % BETA_OPERATION_SHARD_COUNT).toString().padStart(2, '0');
}
