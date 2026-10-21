import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  LEGACY_SWEEP_SKIP_OBSERVATION_REASONS,
  classifyLegacySweepSkipObservation,
  summarizeLegacySweepSkipObservations,
} from '../../functions/src/shared/core/live-scoring/legacy-sweep-skip-observation.util.ts';

const ROOT = new URL('../../', import.meta.url);
const STARTED_AT = Date.UTC(2026, 9, 21, 12, 0, 0);

test('only an existing not-due lease with a future saved refresh is eligible', () => {
  assert.deepEqual(classifyLegacySweepSkipObservation({
    outcome: 'skipped',
    skipReason: 'not-due',
    observationStartedAtMilliseconds: STARTED_AT,
    nextRefreshAtMilliseconds: STARTED_AT + 60_000,
  }), {
    eligible: true,
    reason: 'saved-refresh-not-due',
    deepScoringRan: false,
    noPublicationObserved: false,
  });

  assert.equal(classifyLegacySweepSkipObservation({
    outcome: 'skipped',
    skipReason: 'not-due',
    observationStartedAtMilliseconds: STARTED_AT,
  }).reason, 'refresh-proof-missing');

  assert.equal(classifyLegacySweepSkipObservation({
    outcome: 'skipped',
    skipReason: 'not-due',
    observationStartedAtMilliseconds: STARTED_AT,
    nextRefreshAtMilliseconds: STARTED_AT,
  }).reason, 'refresh-proof-stale');
});

test('a completed no-publication run fails open without pre-run NHL source proof', () => {
  assert.deepEqual(classifyLegacySweepSkipObservation({
    outcome: 'success',
    observationStartedAtMilliseconds: STARTED_AT,
    publishedSnapshotCount: 0,
    cycleOneCreated: false,
  }), {
    eligible: false,
    reason: 'deep-run-source-proof-required',
    deepScoringRan: true,
    noPublicationObserved: true,
  });
});

test('publication, transitions, replay, active workers, unknown skips, and failures remain ineligible', () => {
  const fixtures = [
    {
      input: {
        outcome: 'success',
        observationStartedAtMilliseconds: STARTED_AT,
        publishedSnapshotCount: 1,
      },
      reason: 'deep-run-published-or-transitioned',
    },
    {
      input: {
        outcome: 'success',
        observationStartedAtMilliseconds: STARTED_AT,
        publishedSnapshotCount: 0,
        cycleOneCreated: true,
      },
      reason: 'deep-run-published-or-transitioned',
    },
    {
      input: {
        outcome: 'success',
        observationStartedAtMilliseconds: STARTED_AT,
        publishedSnapshotCount: 0,
        transitionOccurred: true,
      },
      reason: 'deep-run-published-or-transitioned',
    },
    {
      input: {
        outcome: 'skipped',
        skipReason: 'historical-replay',
        observationStartedAtMilliseconds: STARTED_AT,
      },
      reason: 'historical-replay',
    },
    {
      input: {
        outcome: 'skipped',
        skipReason: 'another-server-worker',
        observationStartedAtMilliseconds: STARTED_AT,
      },
      reason: 'another-worker-active',
    },
    {
      input: {
        outcome: 'skipped',
        skipReason: 'unexpected-fixture',
        observationStartedAtMilliseconds: STARTED_AT,
      },
      reason: 'unrecognized-skip',
    },
    {
      input: {
        outcome: 'failed',
        observationStartedAtMilliseconds: STARTED_AT,
      },
      reason: 'run-failed',
    },
  ];

  for (const fixture of fixtures) {
    const observation = classifyLegacySweepSkipObservation(fixture.input);
    assert.equal(observation.eligible, false);
    assert.equal(observation.reason, fixture.reason);
  }
});

test('health evidence has fixed bounded reason keys and cannot enable enforcement', () => {
  const observations = [
    classifyLegacySweepSkipObservation({
      outcome: 'skipped',
      skipReason: 'not-due',
      observationStartedAtMilliseconds: STARTED_AT,
      nextRefreshAtMilliseconds: STARTED_AT + 1,
    }),
    classifyLegacySweepSkipObservation({
      outcome: 'success',
      observationStartedAtMilliseconds: STARTED_AT,
      publishedSnapshotCount: 0,
    }),
    classifyLegacySweepSkipObservation({
      outcome: 'failed',
      observationStartedAtMilliseconds: STARTED_AT,
    }),
  ];
  const summary = summarizeLegacySweepSkipObservations(observations);

  assert.equal(summary.schemaVersion, 1);
  assert.equal(summary.mode, 'observe-only');
  assert.equal(summary.enforcementEnabled, false);
  assert.equal(summary.analyzedLeagueCount, 3);
  assert.equal(summary.eligibleLeagueCount, 1);
  assert.equal(summary.ineligibleLeagueCount, 2);
  assert.equal(summary.deepScoringRunCount, 1);
  assert.equal(summary.deepScoringNoPublicationCount, 1);
  assert.equal(summary.failedRunCount, 1);
  assert.deepEqual(
    Object.keys(summary.reasonCounts),
    [...LEGACY_SWEEP_SKIP_OBSERVATION_REASONS],
  );
  assert.equal(summary.reasonCounts['saved-refresh-not-due'], 1);
  assert.equal(summary.reasonCounts['deep-run-source-proof-required'], 1);
  assert.equal(summary.reasonCounts['run-failed'], 1);
});

test('the scheduler still runs every selected league before it records observation evidence', async () => {
  const source = await readFile(
    new URL('functions/src/league-automation.ts', ROOT),
    'utf8',
  );
  const workerStart = source.indexOf('export const runScheduledLeagueAutomation');
  const workerEnd = source.indexOf(
    'async function getCompletedDraftLeagueIdsWithoutCycleOne',
    workerStart,
  );
  const worker = source.slice(workerStart, workerEnd);
  const runIndex = worker.indexOf('const results = await mapWithConcurrency');
  const observationIndex = worker.indexOf(
    'const skipObservation = summarizeLegacySweepSkipObservations',
  );

  assert.match(worker, /schedule:\s*'every 10 minutes'/);
  assert.ok(runIndex >= 0);
  assert.ok(observationIndex > runIndex);
  assert.match(
    worker,
    /mapWithConcurrency\(\s*leagueIds,\s*\(leagueId\) => runLeagueAutomation\(/,
  );
  assert.match(worker, /legacySkipObservation:\s*\{/);
  assert.match(worker, /transitionOccurred: result\.value\.transitionOccurred/);
  assert.match(worker, /Legacy scoring skip eligibility observation\./);
  assert.doesNotMatch(
    worker.slice(0, runIndex),
    /classifyLegacySweepSkipObservation|summarizeLegacySweepSkipObservations/,
  );
});
