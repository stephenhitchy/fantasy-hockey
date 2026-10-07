function hasPattern(value, pattern) {
  return typeof value === 'string' && pattern.test(value);
}

export function evaluateProtectedLiveScoringRuntimeContract(input = {}) {
  const blockers = [];
  const requirePattern = (label, value, pattern) => {
    if (!hasPattern(value, pattern)) {
      blockers.push(label);
    }
  };

  requirePattern(
    'Ordinary NHL requests must retain their bounded three-attempt policy.',
    input.nhlApi,
    /DEFAULT_API_REQUEST_MAX_ATTEMPTS\s*=\s*3\b/,
  );
  requirePattern(
    'Critical NHL schedule requests must retain five bounded attempts.',
    input.nhlApi,
    /NHL_SCHEDULE_REQUEST_MAX_ATTEMPTS\s*=\s*5\b/,
  );
  requirePattern(
    'Every NHL request attempt must pass through the adaptive throttle gate.',
    input.nhlApi,
    /await nhlUpstreamThrottleGate\.waitForPermit\(\);\s*response = await fetch\(url\);/,
  );
  requirePattern(
    'HTTP 429 retries must retain bounded cross-instance jitter.',
    input.nhlApi,
    /response\.status === 429\s*\? addNhlRateLimitRetryJitter\(baseRetryDelayMilliseconds\)/,
  );
  requirePattern(
    'HTTP 429 responses must extend the adaptive throttle boundary.',
    input.nhlApi,
    /nhlUpstreamThrottleGate\.observeRateLimit\(retryDelayMilliseconds\)/,
  );
  requirePattern(
    'Season-schedule reads must use the protected schedule-attempt policy.',
    input.nhlApi,
    /'NHL season schedule request failed',\s*false,\s*NHL_SCHEDULE_REQUEST_MAX_ATTEMPTS/,
  );
  requirePattern(
    'The NHL retry gate must retain 750-millisecond queued-request spacing.',
    input.nhlThrottle,
    /DEFAULT_REQUEST_SPACING_MILLISECONDS\s*=\s*750\b/,
  );
  requirePattern(
    'Cross-instance NHL retry jitter must remain bounded at 750 milliseconds.',
    input.nhlThrottle,
    /NHL_RATE_LIMIT_RETRY_JITTER_MAX_MILLISECONDS\s*=\s*750\b/,
  );
  requirePattern(
    'The NHL retry gate must serialize queued retry permits.',
    input.nhlThrottle,
    /private permitTail:\s*Promise<void>\s*=\s*Promise\.resolve\(\)/,
  );
  requirePattern(
    'Legacy scoring must retain the measured two-league concurrency limit.',
    input.leagueAutomation,
    /MAX_PARALLEL_LEAGUES\s*=\s*2\b/,
  );
  requirePattern(
    'A failed league must remain eligible for the bounded five-minute retry.',
    input.leagueAutomation,
    /ERROR_RETRY_INTERVAL_MILLISECONDS\s*=\s*5\s*\*\s*60\s*\*\s*1000/,
  );
  requirePattern(
    'Scheduled scoring failures must identify the exact affected league.',
    input.leagueAutomation,
    /console\.error\('A scheduled league automation run failed\.',\s*\{\s*leagueId:\s*leagueIds\[index\],\s*error:\s*result\.reason/,
  );

  return {
    schemaVersion: 1,
    ready: blockers.length === 0,
    blockers,
  };
}
