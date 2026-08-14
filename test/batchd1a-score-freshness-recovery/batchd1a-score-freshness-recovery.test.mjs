import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildLiveScoringFreshnessViewModel,
  formatLiveScoringCountdown,
  formatLiveScoringRelativeAge,
  liveScoringTimestampMilliseconds,
} from '../../src/app/core/live-scoring/live-scoring-freshness.util.ts';
import {
  normalizeBackupSchedule,
  scheduleMatches,
} from '../../scripts/security/firestore-backup-restore.util.mjs';

const ROOT = new URL('../../', import.meta.url);
async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function snapshot(overrides = {}) {
  return {
    id: 'cycle-1',
    schemaVersion: 1,
    leagueId: 'league-test',
    cycleNumber: 1,
    season: '20262027',
    scoringFingerprint: 'score-fingerprint',
    scoringRulesFingerprint: 'rules-fingerprint',
    workerUserId: 'server',
    workerClientId: 'server:scheduled',
    refreshedAt: '2026-08-12T20:05:00.000Z',
    result: {
      scoringSchemaVersion: 2,
      assetScores: {},
      windowScores: {},
      teamScores: {},
      teamGameCounts: {},
      teamCycleComplete: {},
      cycleHasScheduledGames: true,
      hasLiveGames: true,
      nextScheduledGameStart: null,
      refreshedAt: '2026-08-12T20:05:00.000Z',
      dataFingerprint: 'data-fingerprint',
    },
    ...overrides,
  };
}

function control(overrides = {}) {
  return {
    id: 'control',
    schemaVersion: 1,
    status: 'idle',
    holderUserId: null,
    holderClientId: null,
    activeCycleNumbers: [1],
    lastError: '',
    lastRefreshReason: 'scheduled',
    lastRefreshDurationMs: 800,
    lastPublishedSnapshotCount: 1,
    lastSkippedSnapshotWriteCount: 0,
    totalSuccessfulRefreshCount: 4,
    totalFailedRefreshCount: 0,
    totalPublishedSnapshotCount: 2,
    totalSkippedSnapshotWriteCount: 2,
    lastRefreshCompletedAt: '2026-08-12T20:08:00.000Z',
    nextRefreshAt: '2026-08-12T20:18:00.000Z',
    ...overrides,
  };
}

test('score freshness distinguishes server checks, changed snapshots, and the next check', () => {
  const now = Date.parse('2026-08-12T20:10:00.000Z');
  const view = buildLiveScoringFreshnessViewModel({
    control: control(),
    snapshot: snapshot(),
    cycleStatus: 'active',
    nowMilliseconds: now,
  });

  assert.equal(view.tone, 'fresh');
  assert.equal(view.statusLabel, 'Live');
  assert.equal(view.lastCheckedLabel, '2 min ago');
  assert.equal(view.lastChangedLabel, '5 min ago');
  assert.equal(view.nextCheckLabel, 'In 8 min');
  assert.match(view.explanation, /not an upstream NHL correction timestamp/i);
});

test('score freshness uses due, delayed, working, error, replay, and final states honestly', () => {
  const now = Date.parse('2026-08-12T20:40:00.000Z');
  const delayed = buildLiveScoringFreshnessViewModel({
    control: control({ nextRefreshAt: '2026-08-12T20:20:00.000Z' }),
    snapshot: snapshot(),
    cycleStatus: 'active',
    nowMilliseconds: now,
  });
  assert.equal(delayed.tone, 'delayed');
  assert.match(delayed.title, /may be delayed/i);

  const working = buildLiveScoringFreshnessViewModel({
    control: control({ status: 'refreshing' }),
    snapshot: snapshot(),
    cycleStatus: 'active',
    nowMilliseconds: now,
  });
  assert.equal(working.tone, 'working');

  const error = buildLiveScoringFreshnessViewModel({
    control: control({ status: 'error', lastError: 'Bounded test error.' }),
    snapshot: snapshot(),
    cycleStatus: 'active',
    nowMilliseconds: now,
  });
  assert.equal(error.tone, 'error');
  assert.equal(error.summary, 'Bounded test error.');

  const replay = buildLiveScoringFreshnessViewModel({
    control: control({ historicalReplayEnabled: true, automationMode: 'historical-replay' }),
    snapshot: snapshot(),
    cycleStatus: 'active',
    nowMilliseconds: Date.parse('2026-08-12T20:10:00.000Z'),
  });
  assert.equal(replay.statusLabel, 'Replay');

  const complete = buildLiveScoringFreshnessViewModel({
    control: control(),
    snapshot: snapshot(),
    cycleStatus: 'complete',
    nowMilliseconds: now,
  });
  assert.equal(complete.tone, 'complete');
  assert.equal(complete.nextCheckLabel, 'Complete');

  const completeDuringGlobalError = buildLiveScoringFreshnessViewModel({
    control: control({ status: 'error', lastError: 'A newer cycle needs attention.' }),
    snapshot: snapshot(),
    cycleStatus: 'complete',
    nowMilliseconds: now,
  });
  assert.equal(completeDuringGlobalError.tone, 'complete');
});

test('timestamp helpers handle Firestore-like values and bounded relative labels', () => {
  assert.equal(
    liveScoringTimestampMilliseconds({ seconds: 10, nanoseconds: 500_000_000 }),
    10_500,
  );
  assert.equal(formatLiveScoringRelativeAge(1_000, 11_000), 'Just now');
  assert.equal(formatLiveScoringRelativeAge(1_000, 121_000), '2 min ago');
  assert.equal(formatLiveScoringCountdown(61_000, 1_000), 'In 1 min');
  assert.equal(formatLiveScoringCountdown(7_201_000, 1_000), 'In 2 hrs');
  assert.equal(formatLiveScoringCountdown(1_000, 61_000), '1 min overdue');
});

test('detailed and overview matchup pages both expose the compact score timing component', async () => {
  const [bannerTs, bannerHtml, overviewTs, overviewHtml, componentHtml, componentCss] = await Promise.all([
    read('src/app/features/cycles/cycle-one/components/cycle-status-banners/cycle-status-banners.ts'),
    read('src/app/features/cycles/cycle-one/components/cycle-status-banners/cycle-status-banners.html'),
    read('src/app/features/cycles/matchup-overview/cycle-matchup-overview.ts'),
    read('src/app/features/cycles/matchup-overview/cycle-matchup-overview.html'),
    read('src/app/shared/live-score-freshness/live-score-freshness.html'),
    read('src/app/shared/live-score-freshness/live-score-freshness.css'),
  ]);

  assert.match(bannerTs, /LiveScoreFreshness/);
  assert.match(bannerHtml, /app-live-score-freshness/);
  assert.match(bannerHtml, /shared-scoring-status-card rr-notice rr-notice--info/);
  assert.match(overviewTs, /listenToSharedLiveScoringControl/);
  assert.match(overviewHtml, /app-live-score-freshness/);
  assert.match(componentHtml, /Last checked/);
  assert.match(componentHtml, /Last score change/);
  assert.match(componentHtml, /Next check/);
  assert.match(componentHtml, /How score timing works/);
  assert.match(componentHtml, /rr-visually-hidden/);
  assert.match(componentHtml, /aria-live="polite"/);
  assert.doesNotMatch(componentHtml, /role="status"/);
  assert.match(componentCss, /@media \(max-width: 560px\)/);
  assert.match(componentCss, /grid-column: 1 \/ -1/);
  assert.match(componentCss, /prefers-reduced-motion/);
});

test('weekly backup inspection accepts the current gcloud weeklyRecurrence.day shape', () => {
  const schedule = normalizeBackupSchedule({
    name: 'projects/p/databases/(default)/backupSchedules/weekly-id',
    retention: '7257600s',
    weeklyRecurrence: { day: 'SUNDAY' },
  });

  assert.equal(schedule.recurrence, 'weekly');
  assert.equal(schedule.dayOfWeek, 'SUN');
  assert.equal(
    scheduleMatches(schedule, {
      recurrence: 'weekly',
      dayOfWeek: 'SUN',
      retention: '12w',
    }),
    true,
  );
});

test('D1A remains intact under RC30 while preserving Scoring V3 and Projection V11', async () => {
  const [runtime, productionRuntime, scoringRules, projectionSnapshot, roadmap, runbook, packageJson] = await Promise.all([
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/projection/projection-snapshot.service.ts'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_DATA_D1A_SCORE_FRESHNESS.md'),
    read('package.json').then(JSON.parse),
  ]);

  assert.match(runtime, /Release Candidate 30/);
  assert.match(productionRuntime, /Release Candidate 30/);
  assert.match(scoringRules, /CURRENT_SCORING_RULES_VERSION\s*=\s*3/);
  assert.match(projectionSnapshot, /SHARED_PROJECTION_VERSION\s*=\s*11/);
  assert.match(roadmap, /Version 1\.\d+(?:\.\d+)?/);
  assert.match(roadmap, /D1\.16 .*visible score-freshness indicator/i);
  assert.match(roadmap, /S4\.13 .*Completed 2026-08-12/i);
  assert.match(runbook, /Last checked/);
  assert.match(runbook, /157d0b876c350148ea5ff65d17471f74ed3637c9d13a127b4183bf1eba494a75/);
  assert.match(packageJson.scripts['verify:batchd1a:core'], /verify:batch(?:s3f|d1a|d1a-1):core/);
});
