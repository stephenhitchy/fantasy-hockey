import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  loadStrictTeamScheduleRequestsWithPacing,
  STRICT_TEAM_SCHEDULE_MAX_FAILURES_PER_ATTEMPT,
  STRICT_TEAM_SCHEDULE_REQUEST_DELAY_MILLISECONDS,
} from '../../functions/src/shared/core/projection/team-schedule-request-pacing.util.ts';

const ROOT = new URL('../../', import.meta.url);
const read = (relativePath) => readFile(new URL(relativePath, ROOT), 'utf8');

test('strict Draft schedule requests are sequentially paced below the observed burst', async () => {
  const waits = [];
  let active = 0;
  let maximumActive = 0;
  const inputs = Array.from({ length: 32 }, (_, index) => `team-${index + 1}`);

  const results = await loadStrictTeamScheduleRequestsWithPacing(
    inputs,
    async (team) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return `${team}-schedule`;
    },
    async (milliseconds) => {
      waits.push(milliseconds);
    },
  );

  assert.equal(maximumActive, 1);
  assert.equal(results.length, 32);
  assert.equal(results.every((result) => result.status === 'fulfilled'), true);
  assert.equal(waits.length, 31);
  assert.equal(
    waits.every(
      (milliseconds) => milliseconds === STRICT_TEAM_SCHEDULE_REQUEST_DELAY_MILLISECONDS,
    ),
    true,
  );
});

test('one rejected club remains explicit while every request stays paced and single-attempt', async () => {
  const waits = [];
  const calls = [];
  const attempts = new Map();

  const results = await loadStrictTeamScheduleRequestsWithPacing(
    ['ANA', 'BOS', 'BUF', 'CAR'],
    async (team) => {
      calls.push(team);
      const attempt = (attempts.get(team) ?? 0) + 1;
      attempts.set(team, attempt);

      if (team === 'BOS') {
        throw new Error('429 Too Many Requests');
      }

      return `${team}-schedule`;
    },
    async (milliseconds) => {
      waits.push(milliseconds);
    },
  );

  assert.deepEqual(calls, ['ANA', 'BOS', 'BUF', 'CAR']);
  assert.deepEqual(waits, [
    STRICT_TEAM_SCHEDULE_REQUEST_DELAY_MILLISECONDS,
    STRICT_TEAM_SCHEDULE_REQUEST_DELAY_MILLISECONDS,
    STRICT_TEAM_SCHEDULE_REQUEST_DELAY_MILLISECONDS,
  ]);
  assert.deepEqual(
    results.map((result) => result.status),
    ['fulfilled', 'rejected', 'fulfilled', 'fulfilled'],
  );
  assert.equal(attempts.get('ANA'), 1);
  assert.equal(attempts.get('BUF'), 1);
  assert.equal(attempts.get('BOS'), 1);
  assert.equal(attempts.get('CAR'), 1);
});

test('the bounded failure budget stops a broad outage before the Projection deadline', async () => {
  const waits = [];
  const attempts = new Map();
  const inputs = Array.from(
    { length: STRICT_TEAM_SCHEDULE_MAX_FAILURES_PER_ATTEMPT + 3 },
    (_, index) => `team-${index + 1}`,
  );

  const results = await loadStrictTeamScheduleRequestsWithPacing(
    inputs,
    async (team) => {
      attempts.set(team, (attempts.get(team) ?? 0) + 1);
      throw new Error('NHL unavailable');
    },
    async (milliseconds) => {
      waits.push(milliseconds);
    },
  );

  assert.equal(results.every((result) => result.status === 'rejected'), true);
  assert.equal([...attempts.values()].every((attemptCount) => attemptCount === 1), true);
  assert.equal(attempts.size, STRICT_TEAM_SCHEDULE_MAX_FAILURES_PER_ATTEMPT);
  assert.equal(waits.length, STRICT_TEAM_SCHEDULE_MAX_FAILURES_PER_ATTEMPT - 1);
  assert.match(results.at(-1).reason.message, /bounded NHL failure budget/);
});

test('pacing is limited to strict Draft input while tolerant projections keep bounded batches', async () => {
  const source = await read('functions/src/shared/core/draft/draft-player-pool.service.ts');
  const loaderStart = source.indexOf('async function loadTeamProjectionSchedules(');
  const loaderEnd = source.indexOf('function getTargetCycleGames(', loaderStart);
  const loader = source.slice(loaderStart, loaderEnd);

  assert.match(
    loader,
    /if \(requireCompleteInput\) \{[\s\S]*loadStrictTeamScheduleRequestsWithPacing/,
  );
  assert.match(loader, /else \{[\s\S]*Promise\.allSettled/);
  assert.match(loader, /failedTeamCount \+= 1/);
  assert.ok(loader.indexOf('assertCompleteTeamScheduleInput') < loader.lastIndexOf('return schedules'));
});

test('FF1.28 changes no Projection task concurrency or competitive formula', async () => {
  const [authority, pacing, scoringRules, projection] = await Promise.all([
    read('functions/src/projection-authority.ts'),
    read('functions/src/shared/core/projection/team-schedule-request-pacing.util.ts'),
    read('functions/src/shared/core/scoring/scoring-rules.ts'),
    read('functions/src/shared/core/projection/projection-v11.util.ts'),
  ]);

  assert.match(authority, /const PROJECTION_TASK_MAX_CONCURRENT_DISPATCHES = 2/);
  assert.doesNotMatch(pacing, /firebase|firestore|taskQueue|Projection V11 formula/i);
  assert.match(scoringRules, /CURRENT_SCORING_RULES_VERSION\s*=\s*4/);
  assert.match(projection, /PROJECTION_MODEL_VERSION\s*=\s*11/);
});

test('FF1.28 documents acceptance, staging, observability, and narrow rollback', async () => {
  const [documentation, packageSource, roadmap, docsRoadmap, handoff] = await Promise.all([
    read('docs/RINKRAT_FF1_12_NHL_SCHEDULE_RECOVERY.md'),
    read('package.json'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_CODEX_HANDOFF.md'),
  ]);
  const packageJson = JSON.parse(packageSource);

  for (const heading of [
    'Architecture recommendation',
    'Implemented behavior',
    'Acceptance criteria',
    'Edge cases',
    'Tests',
    'Deployment resources',
    'Observability',
    'Rollback',
    'Protected contracts',
  ]) {
    assert.match(documentation, new RegExp(`## ${heading}`, 'i'));
  }

  assert.match(documentation, /24 of 32/);
  assert.match(documentation, /three-second/);
  assert.match(documentation, /two terminal team failures/);
  assert.match(documentation, /functions:processProjectionGenerationTask/);
  assert.equal(
    packageJson.scripts['verify:batchff1-12:core'],
    'npm run verify:batchff1-11:core && npm run test:batchff1-12:run && npm run validate:release-manifest',
  );
  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /FF1\.28 paced strict NHL schedule recovery/);
  assert.match(handoff, /npm run verify:batchff1-12/);
});
