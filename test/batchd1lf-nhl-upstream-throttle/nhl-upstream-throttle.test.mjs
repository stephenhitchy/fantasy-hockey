import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ROOT_PATH = new URL('../../', import.meta.url).pathname;
const THROTTLE_MODULE_PATH =
  `${ROOT_PATH}functions/lib/shared/core/nhl/nhl-upstream-throttle.util.js`;
const NHL_API_MODULE_PATH =
  `${ROOT_PATH}functions/lib/shared/core/nhl/nhl-api.service.js`;
const NHL_API_SOURCE = readFileSync(
  `${ROOT_PATH}functions/src/shared/core/nhl/nhl-api.service.ts`,
  'utf8',
);

test('healthy NHL requests do not wait when no rate limit was observed', async () => {
  const { NhlUpstreamThrottleGate } = await import(THROTTLE_MODULE_PATH);
  const waits = [];
  const gate = new NhlUpstreamThrottleGate({
    now: () => 1_000,
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
    requestSpacingMilliseconds: 250,
  });

  await gate.waitForPermit();

  assert.deepEqual(waits, []);
});

test('one 429 serializes concurrent retries behind the shared cooldown', async () => {
  const { NhlUpstreamThrottleGate } = await import(THROTTLE_MODULE_PATH);
  let nowMilliseconds = 10_000;
  const waits = [];
  const permitTimes = [];
  const gate = new NhlUpstreamThrottleGate({
    now: () => nowMilliseconds,
    wait: async (milliseconds) => {
      waits.push(milliseconds);
      nowMilliseconds += milliseconds;
    },
    requestSpacingMilliseconds: 250,
  });

  gate.observeRateLimit(1_000);

  await Promise.all(
    Array.from({ length: 4 }, async () => {
      await gate.waitForPermit();
      permitTimes.push(nowMilliseconds);
    }),
  );

  assert.deepEqual(waits, [1_000, 250, 250, 250]);
  assert.deepEqual(permitTimes, [11_000, 11_250, 11_500, 11_750]);
});

test('a later 429 extends the cooldown without releasing a retry burst', async () => {
  const { NhlUpstreamThrottleGate } = await import(THROTTLE_MODULE_PATH);
  let nowMilliseconds = 20_000;
  const waits = [];
  const gate = new NhlUpstreamThrottleGate({
    now: () => nowMilliseconds,
    wait: async (milliseconds) => {
      waits.push(milliseconds);
      nowMilliseconds += milliseconds;
    },
    requestSpacingMilliseconds: 300,
  });

  gate.observeRateLimit(500);
  await gate.waitForPermit();
  gate.observeRateLimit(1_200);
  await Promise.all([
    gate.waitForPermit(),
    gate.waitForPermit(),
  ]);

  assert.deepEqual(waits, [500, 1_200, 300]);
  assert.equal(nowMilliseconds, 22_000);
});

test('429 jitter is bounded and separates otherwise synchronized instances', async () => {
  const {
    addNhlRateLimitRetryJitter,
    NHL_RATE_LIMIT_RETRY_JITTER_MAX_MILLISECONDS,
  } = await import(THROTTLE_MODULE_PATH);

  assert.equal(addNhlRateLimitRetryJitter(1_500, () => 0), 1_500);
  assert.equal(addNhlRateLimitRetryJitter(1_500, () => 0.5), 1_875);
  assert.equal(
    addNhlRateLimitRetryJitter(1_500, () => 1),
    1_500 + NHL_RATE_LIMIT_RETRY_JITTER_MAX_MILLISECONDS,
  );
  assert.equal(addNhlRateLimitRetryJitter(1_500, () => Number.NaN), 1_500);
});

test('the NHL request path gates every attempt and gives critical schedules five bounded attempts', () => {
  assert.match(
    NHL_API_SOURCE,
    /await nhlUpstreamThrottleGate\.waitForPermit\(\);\s*response = await fetch\(url\);/,
  );
  assert.match(
    NHL_API_SOURCE,
    /if \(response\.status === 429\) \{\s*nhlUpstreamThrottleGate\.observeRateLimit\(retryDelayMilliseconds\);/,
  );
  assert.match(
    NHL_API_SOURCE,
    /if \(response\.status !== 429\) \{\s*await waitForApiRetry\(retryDelayMilliseconds\);/,
  );
  assert.match(
    NHL_API_SOURCE,
    /const retryDelayMilliseconds = response\.status === 429\s*\? addNhlRateLimitRetryJitter\(baseRetryDelayMilliseconds\)/,
  );
  assert.match(
    NHL_API_SOURCE,
    /const NHL_SCHEDULE_REQUEST_MAX_ATTEMPTS = 5;/,
  );
  assert.match(
    NHL_API_SOURCE,
    /'NHL season schedule request failed',\s*false,\s*NHL_SCHEDULE_REQUEST_MAX_ATTEMPTS/,
  );
});

test('a critical schedule exhausts five 429 attempts before failing closed', async (t) => {
  let requestCount = 0;

  t.mock.method(globalThis, 'fetch', async () => {
    requestCount += 1;
    return new Response(null, {
      status: 429,
      statusText: 'Too Many Requests',
    });
  });
  t.mock.method(globalThis, 'setTimeout', (callback) => {
    queueMicrotask(callback);
    return 0;
  });

  const nhlApi = await import(NHL_API_MODULE_PATH);

  await assert.rejects(
    nhlApi.getNhlTeamSeasonSchedule('TST', '20992000'),
    /429 Too Many Requests/,
  );
  assert.equal(requestCount, 5);
});

test('scheduled sweep failures identify the exact league without changing concurrency', async () => {
  const automationSource = readFileSync(
    `${ROOT_PATH}functions/src/league-automation.ts`,
    'utf8',
  );

  assert.match(
    automationSource,
    /console\.error\('A scheduled league automation run failed\.', \{\s*leagueId: leagueIds\[index\],\s*error: result\.reason/,
  );
  assert.match(
    automationSource,
    /const MAX_PARALLEL_LEAGUES = 2;/,
  );
});
