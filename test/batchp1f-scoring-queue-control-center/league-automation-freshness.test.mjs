import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyLeagueAutomationFreshness,
  decideLeagueAutomationWatchdogAction,
  LEAGUE_AUTOMATION_STALE_DUE_MILLISECONDS,
} from '../../functions/src/shared/core/live-scoring/league-automation-season-safety.util.ts';

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

function classify(overrides = {}) {
  return classifyLeagueAutomationFreshness({
    nowMilliseconds: NOW,
    draftComplete: true,
    historicalReplayEnabled: false,
    scheduleExists: true,
    scoringEnabled: true,
    queueStatus: 'idle',
    nextScoringAtMilliseconds: NOW + 60_000,
    activeTaskLeaseExpiresAtMilliseconds: 0,
    consecutiveFailureCount: 0,
    lastError: '',
    ...overrides,
  });
}

test('completed-Draft leagues without a server schedule are critical', () => {
  const result = classify({ scheduleExists: false });

  assert.equal(result.status, 'missing-schedule');
  assert.equal(result.severity, 'critical');
});

test('a healthy active lease distinguishes recovery from an abandoned failure', () => {
  const recovering = classify({
    queueStatus: 'processing',
    activeTaskLeaseExpiresAtMilliseconds: NOW + 60_000,
    consecutiveFailureCount: 1,
    lastError: 'Previous attempt failed.',
  });
  const failing = classify({
    queueStatus: 'error',
    consecutiveFailureCount: 1,
    lastError: 'Latest attempt failed.',
  });

  assert.equal(recovering.status, 'recovering');
  assert.equal(recovering.severity, 'warning');
  assert.equal(failing.status, 'failing');
  assert.equal(failing.severity, 'critical');
});

test('the bounded 25-minute recovery window has an exact stale boundary', () => {
  const stillDue = classify({
    nextScoringAtMilliseconds:
      NOW - LEAGUE_AUTOMATION_STALE_DUE_MILLISECONDS + 1,
  });
  const stale = classify({
    nextScoringAtMilliseconds:
      NOW - LEAGUE_AUTOMATION_STALE_DUE_MILLISECONDS,
  });

  assert.equal(stillDue.status, 'due');
  assert.equal(stillDue.severity, 'info');
  assert.equal(stale.status, 'stale');
  assert.equal(stale.severity, 'critical');
});

test('an active lease takes precedence over a past-due schedule', () => {
  const result = classify({
    queueStatus: 'queued',
    nextScoringAtMilliseconds:
      NOW - LEAGUE_AUTOMATION_STALE_DUE_MILLISECONDS,
    activeTaskLeaseExpiresAtMilliseconds: NOW + 60_000,
  });

  assert.equal(result.status, 'active');
  assert.equal(result.severity, 'healthy');
});

test('enabled schedules with no next scoring time fail visibly', () => {
  const result = classify({ nextScoringAtMilliseconds: 0 });

  assert.equal(result.status, 'schedule-invalid');
  assert.equal(result.severity, 'critical');
});

test('expected non-live league states do not create false critical alerts', () => {
  assert.equal(classify({ draftComplete: false }).status, 'draft-incomplete');
  assert.equal(classify({ historicalReplayEnabled: true }).status, 'historical-replay');
  assert.equal(classify({ scoringEnabled: false }).status, 'paused');
  assert.equal(classify({ draftComplete: false }).severity, 'info');
  assert.equal(classify({ historicalReplayEnabled: true }).severity, 'info');
  assert.equal(classify({ scoringEnabled: false }).severity, 'info');
});

test('freshness failures block queue promotion after two strikes, not legacy visibility alerts', () => {
  const first = decideLeagueAutomationWatchdogAction({
    mode: 'canary',
    canonicalAuthorityConfigured: false,
    alertIds: ['stale-league-schedules', 'legacy-sweep-failures'],
    previousQueueBlockingStreak: 0,
    previousCanonicalBlockingStreak: 0,
  });
  const second = decideLeagueAutomationWatchdogAction({
    mode: 'canary',
    canonicalAuthorityConfigured: false,
    alertIds: ['stale-league-schedules', 'legacy-sweep-failures'],
    previousQueueBlockingStreak: first.queueBlockingStreak,
    previousCanonicalBlockingStreak: 0,
  });
  const visibilityOnly = decideLeagueAutomationWatchdogAction({
    mode: 'canary',
    canonicalAuthorityConfigured: false,
    alertIds: ['legacy-sweep-failures'],
    previousQueueBlockingStreak: 8,
    previousCanonicalBlockingStreak: 0,
  });

  assert.equal(first.action, 'none');
  assert.equal(second.action, 'return-to-shadow');
  assert.deepEqual(second.queueBlockingAlertIds, ['stale-league-schedules']);
  assert.equal(visibilityOnly.action, 'none');
  assert.equal(visibilityOnly.queueBlockingStreak, 0);
});
