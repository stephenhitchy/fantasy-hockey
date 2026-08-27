import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import {
  buildLeagueAutomationCapacityRecommendation,
  decideLeagueAutomationWatchdogAction,
} from '../../functions/src/shared/core/live-scoring/league-automation-season-safety.util.ts';

const ROOT = new URL('../../', import.meta.url);
const read = (relativePath) => readFile(new URL(relativePath, ROOT), 'utf8');

async function sha256(relativePath) {
  return createHash('sha256').update(await read(relativePath)).digest('hex');
}

test('the watchdog requires two consecutive queue blockers before returning to Shadow', () => {
  const first = decideLeagueAutomationWatchdogAction({
    mode: 'canary',
    canonicalAuthorityConfigured: false,
    alertIds: ['dispatcher-stale'],
    previousQueueBlockingStreak: 0,
    previousCanonicalBlockingStreak: 0,
  });
  const second = decideLeagueAutomationWatchdogAction({
    mode: 'canary',
    canonicalAuthorityConfigured: false,
    alertIds: ['dispatcher-stale'],
    previousQueueBlockingStreak: first.queueBlockingStreak,
    previousCanonicalBlockingStreak: first.canonicalBlockingStreak,
  });

  assert.equal(first.action, 'none');
  assert.equal(first.status, 'warning');
  assert.equal(first.queueBlockingStreak, 1);
  assert.equal(second.action, 'return-to-shadow');
  assert.equal(second.status, 'shadow-fallback');
  assert.equal(second.queueBlockingStreak, 2);
});

test('a canonical-only blocker disables canonical authority without returning the queue to Shadow', () => {
  const first = decideLeagueAutomationWatchdogAction({
    mode: 'canary',
    canonicalAuthorityConfigured: true,
    alertIds: ['canonical-feed-stale'],
    previousQueueBlockingStreak: 0,
    previousCanonicalBlockingStreak: 0,
  });
  const second = decideLeagueAutomationWatchdogAction({
    mode: 'canary',
    canonicalAuthorityConfigured: true,
    alertIds: ['canonical-feed-stale'],
    previousQueueBlockingStreak: first.queueBlockingStreak,
    previousCanonicalBlockingStreak: first.canonicalBlockingStreak,
  });

  assert.equal(first.action, 'none');
  assert.equal(second.action, 'disable-canonical-authority');
  assert.deepEqual(second.queueBlockingAlertIds, []);
  assert.deepEqual(second.canonicalBlockingAlertIds, ['canonical-feed-stale']);
});

test('Shadow mode never performs another automatic fallback and resets warning streaks', () => {
  const result = decideLeagueAutomationWatchdogAction({
    mode: 'shadow',
    canonicalAuthorityConfigured: true,
    alertIds: ['dispatcher-stale', 'canonical-feed-stale'],
    previousQueueBlockingStreak: 9,
    previousCanonicalBlockingStreak: 9,
  });

  assert.equal(result.action, 'none');
  assert.equal(result.status, 'observing');
  assert.equal(result.queueBlockingStreak, 0);
  assert.equal(result.canonicalBlockingStreak, 0);
});

test('measured capacity uses p95 duration, four workers, and seventy percent headroom', () => {
  const result = buildLeagueAutomationCapacityRecommendation({
    queueTaskSampleCount: 120,
    queueTaskSuccessCount: 120,
    sampledDayCount: 4,
    averageDurationMilliseconds: 7_000,
    p95DurationMilliseconds: 10_000,
    maximumDurationMilliseconds: 70_000,
    workerCount: 4,
    refreshIntervalMilliseconds: 120_000,
    activeLeagueTarget: 25,
  });

  assert.equal(result.evidenceLevel, 'representative');
  assert.equal(result.safeAffectedLeagueCapacity, 33);
  assert.equal(result.recommendedWorkersFor25Leagues, 3);
  assert.equal(result.recommendedWorkersFor50Leagues, 6);
  assert.equal(result.primaryCapacityReady, true);
});

test('Primary remains locked when live queue evidence is sparse or p95 is too slow', () => {
  const sparse = buildLeagueAutomationCapacityRecommendation({
    queueTaskSampleCount: 10,
    queueTaskSuccessCount: 10,
    sampledDayCount: 1,
    averageDurationMilliseconds: 7_000,
    p95DurationMilliseconds: 10_000,
    maximumDurationMilliseconds: 70_000,
    workerCount: 4,
    refreshIntervalMilliseconds: 120_000,
    activeLeagueTarget: 25,
  });
  const slow = buildLeagueAutomationCapacityRecommendation({
    queueTaskSampleCount: 120,
    queueTaskSuccessCount: 118,
    sampledDayCount: 4,
    averageDurationMilliseconds: 18_000,
    p95DurationMilliseconds: 45_000,
    maximumDurationMilliseconds: 90_000,
    workerCount: 4,
    refreshIntervalMilliseconds: 120_000,
    activeLeagueTarget: 25,
  });

  assert.equal(sparse.evidenceLevel, 'insufficient');
  assert.equal(sparse.primaryCapacityReady, false);
  assert.equal(slow.p95WithinPrimaryTarget, false);
  assert.equal(slow.primaryCapacityReady, false);
});

test('Primary capacity requires a 99.5 percent non-error queue reliability rate', () => {
  const result = buildLeagueAutomationCapacityRecommendation({
    queueTaskSampleCount: 200,
    queueTaskSuccessCount: 198,
    queueTaskErrorCount: 2,
    queueTaskSkippedCount: 0,
    sampledDayCount: 4,
    averageDurationMilliseconds: 7_000,
    p95DurationMilliseconds: 10_000,
    maximumDurationMilliseconds: 70_000,
    workerCount: 4,
    refreshIntervalMilliseconds: 120_000,
    activeLeagueTarget: 25,
  });

  assert.equal(result.queueTaskReliabilityRate, 0.99);
  assert.equal(result.reliabilityWithinPrimaryTarget, false);
  assert.equal(result.primaryCapacityReady, false);
});

test('expected skipped no-op tasks count as reliable but never as duration samples', () => {
  const result = buildLeagueAutomationCapacityRecommendation({
    queueTaskSampleCount: 200,
    queueTaskSuccessCount: 190,
    queueTaskErrorCount: 0,
    queueTaskSkippedCount: 10,
    sampledDayCount: 4,
    averageDurationMilliseconds: 7_000,
    p95DurationMilliseconds: 10_000,
    maximumDurationMilliseconds: 70_000,
    workerCount: 4,
    refreshIntervalMilliseconds: 120_000,
    activeLeagueTarget: 25,
  });

  assert.equal(result.queueTaskReliabilityRate, 1);
  assert.equal(result.reliabilityWithinPrimaryTarget, true);
  assert.equal(result.queueTaskSuccessCount, 190);
});

test('server watchdog and capacity refresh are scheduled, audited, and fail toward proven scoring', async () => {
  const source = await read('functions/src/league-automation.ts');

  assert.match(source, /monitorLeagueAutomationSeasonSafety = onSchedule/);
  assert.match(source, /schedule: '\* \* \* \* \*'/);
  assert.match(source, /refreshLeagueAutomationCapacityEvidence = onSchedule/);
  assert.match(source, /schedule: 'every 60 minutes'/);
  assert.match(source, /LEAGUE_AUTOMATION_WATCHDOG_REQUIRED_BLOCKING_STREAK/);
  assert.match(source, /season-watchdog-returned-to-shadow/);
  assert.match(source, /season-watchdog-canonical-fallback/);
  assert.match(source, /server:season-safety-watchdog/);
  assert.match(source, /mode: modeAfter/);
  assert.match(source, /canonicalAuthorityLeagueIds: canonicalAuthorityLeagueIdsAfter/);
  assert.match(source, /circuitState: 'open'/);
  assert.match(source, /season-watchdog-returned-to-shadow/);
  assert.match(source, /primaryApprovalRef/);
  assert.match(source, /disabledReason: 'season-watchdog-returned-to-shadow'/);
});

test('global Primary requires healthy watchdog evidence and measured queue capacity', async () => {
  const source = await read('functions/src/league-automation.ts');

  assert.match(source, /id: 'season-safety-watchdog'/);
  assert.match(source, /id: 'measured-queue-capacity'/);
  assert.match(source, /capacity-evidence-stale/);
  assert.match(source, /capacity-success-rate-low/);
  assert.match(source, /capacity-refresh-failed/);
  assert.match(source, /consecutiveFailureCount/);
  assert.match(source, /serverScoringSuccessfulByTrigger/);
  assert.match(source, /primaryCapacityReady/);
  assert.match(source, /queueTaskSampleCount/);
  assert.match(source, /safeAffectedLeagueCapacity/);
  assert.match(source, /CAPACITY_PRIMARY_MAX_P95_MILLISECONDS/);
  assert.match(source, /transaction\.get\(watchdogRef\)/);
  assert.match(source, /transaction\.get\(capacityRef\)/);
  assert.match(source, /transactionParitySnapshots/);
  assert.match(source, /summarizeCanonicalScoringParityCohort/);
});

test('the control center explains automatic fallback and measured capacity without auto-tuning workers', async () => {
  const [service, component, template] = await Promise.all([
    read('src/app/core/admin/scoring-queue-control.service.ts'),
    read('src/app/features/release/scoring-queue-control-center/scoring-queue-control-center.ts'),
    read('src/app/features/release/scoring-queue-control-center/scoring-queue-control-center.html'),
  ]);

  assert.match(service, /seasonSafetyWatchdog/);
  assert.match(service, /capacityEvidence/);
  assert.match(component, /getWatchdogLabel/);
  assert.match(component, /getCapacityEvidenceLabel/);
  assert.match(component, /formatPercentage/);
  assert.match(template, /capacity-evidence-error/);
  assert.match(template, /Automatic safety fallback/);
  assert.match(template, /Measured scoring capacity/);
  assert.match(template, /two consecutive unsafe checks/i);
  assert.match(template, /never changes worker limits automatically/i);
  assert.match(template, /Non-error reliability/);
});

test('D1I preserves scoring, Projection V11, Rules, and indexes', async () => {
  const protectedPaths = [
    ['src/app/core/scoring/scoring-rules.ts', 'scoringRules'],
    ['functions/src/shared/core/scoring/scoring-rules.ts', 'scoringRules'],
    ['src/app/core/scoring/scoring-engine.ts', 'scoringEngine'],
    ['functions/src/shared/core/scoring/scoring-engine.ts', 'scoringEngine'],
    ['src/app/core/projection/projection-v11.util.ts', 'projectionV11'],
    ['functions/src/shared/core/projection/projection-v11.util.ts', 'projectionV11'],
    ['firestore.rules', 'firestoreRules'],
    ['firestore.indexes.json', 'firestoreIndexes'],
  ];

  for (const [relativePath, hashKey] of protectedPaths) {
    assert.equal(await sha256(relativePath), PROTECTED_SOURCE_HASHES[hashKey]);
  }
});

test('D1I scripts, documentation, and synchronized roadmaps are present', async () => {
  const [packageJson, readme, docs, rootRoadmap, docsRoadmap] = await Promise.all([
    read('package.json'),
    read('README.md'),
    read('docs/RINKRAT_DATA_D1I_SEASON_LAUNCH_GUARDRAILS.md'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
  ]);
  const scripts = JSON.parse(packageJson).scripts;

  assert.match(
    scripts['test:batchd1i:run'],
    /batchd1i-season-launch-guardrails/,
  );
  assert.match(scripts['verify:batchd1i:core'], /verify:batchd1h:core/);
  assert.match(readme, /RINKRAT_DATA_D1I_SEASON_LAUNCH_GUARDRAILS/);
  assert.match(docs, /automatic season fallback/i);
  assert.match(rootRoadmap, /Version 1\.54\.7/);
  assert.equal(rootRoadmap, docsRoadmap);
});
