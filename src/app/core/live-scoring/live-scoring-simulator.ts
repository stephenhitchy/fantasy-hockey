import {
  LiveScoringSimulationCheck,
  LiveScoringSimulationResult,
  SharedLiveScoringControl
} from './live-scoring.models';
import {
  canClaimLiveScoringLease,
  getLiveScoringRefreshDelay,
  shouldPublishSharedScoringSnapshot
} from './live-scoring.service';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

function makeControl(
  overrides: Partial<SharedLiveScoringControl> = {}
): SharedLiveScoringControl {
  return {
    id: 'control',
    schemaVersion: 1,
    status: 'idle',
    holderUserId: null,
    holderClientId: null,
    leaseExpiresAt: null,
    nextRefreshAt: null,
    lastRefreshStartedAt: null,
    lastRefreshCompletedAt: null,
    refreshRequestedAt: null,
    activeCycleNumbers: [],
    lastError: '',
    lastRefreshReason: 'unknown',
    lastRefreshDurationMs: 0,
    lastPublishedSnapshotCount: 0,
    lastSkippedSnapshotWriteCount: 0,
    totalSuccessfulRefreshCount: 0,
    totalFailedRefreshCount: 0,
    totalPublishedSnapshotCount: 0,
    totalSkippedSnapshotWriteCount: 0,
    ...overrides
  };
}

function check(
  id: string,
  label: string,
  passed: boolean,
  expected: string,
  actual: string
): LiveScoringSimulationCheck {
  return { id, label, passed, expected, actual };
}

export function runLiveScoringDeterministicSimulator(): LiveScoringSimulationResult {
  const now = Date.parse('2026-10-15T18:00:00Z');
  const clientA = 'commissioner-tab-a';
  const clientB = 'commissioner-tab-b';
  const activeLease = makeControl({
    holderUserId: 'commissioner',
    holderClientId: clientA,
    leaseExpiresAt: new Date(now + 15 * MINUTE_MS).toISOString(),
    nextRefreshAt: new Date(now).toISOString()
  });
  const releasedLease = makeControl({
    holderUserId: null,
    holderClientId: null,
    leaseExpiresAt: new Date(now).toISOString(),
    nextRefreshAt: new Date(now).toISOString(),
    lastRefreshReason: 'handoff'
  });
  const checks: LiveScoringSimulationCheck[] = [];

  const emptyClaim = canClaimLiveScoringLease(null, clientA, now);
  checks.push(check(
    'empty-control-claim',
    'A commissioner tab can initialize an empty scoring lease.',
    emptyClaim,
    'claim allowed',
    emptyClaim ? 'claim allowed' : 'claim denied'
  ));

  const competingClaim = canClaimLiveScoringLease(activeLease, clientB, now);
  checks.push(check(
    'single-holder',
    'A second tab cannot claim while another tab has an active lease.',
    !competingClaim,
    'claim denied',
    competingClaim ? 'claim allowed' : 'claim denied'
  ));

  const ownerReclaim = canClaimLiveScoringLease(activeLease, clientA, now);
  checks.push(check(
    'same-holder',
    'The current lease holder can perform its due refresh.',
    ownerReclaim,
    'claim allowed',
    ownerReclaim ? 'claim allowed' : 'claim denied'
  ));

  const expiredClaim = canClaimLiveScoringLease(
    activeLease,
    clientB,
    now + 16 * MINUTE_MS
  );
  checks.push(check(
    'expired-handoff',
    'Another tab can take over after the lease expires.',
    expiredClaim,
    'claim allowed',
    expiredClaim ? 'claim allowed' : 'claim denied'
  ));

  const releasedClaim = canClaimLiveScoringLease(releasedLease, clientB, now);
  checks.push(check(
    'manual-handoff',
    'A released lease is immediately available to another tab.',
    releasedClaim,
    'claim allowed',
    releasedClaim ? 'claim allowed' : 'claim denied'
  ));

  const unchangedWrite = shouldPublishSharedScoringSnapshot(
    'rules::same-data',
    'rules::same-data'
  );
  checks.push(check(
    'unchanged-write-suppression',
    'An unchanged scoring fingerprint does not publish another snapshot.',
    !unchangedWrite,
    'write skipped',
    unchangedWrite ? 'write published' : 'write skipped'
  ));

  const changedWrite = shouldPublishSharedScoringSnapshot(
    'rules::old-data',
    'rules::new-data'
  );
  checks.push(check(
    'changed-write',
    'A changed scoring fingerprint publishes a new shared snapshot.',
    changedWrite,
    'write published',
    changedWrite ? 'write published' : 'write skipped'
  ));

  const liveDelay = getLiveScoringRefreshDelay(
    [{ hasLiveGames: true, nextScheduledGameStart: null }],
    false,
    now
  );
  checks.push(check(
    'live-refresh-cadence',
    'Live NHL games use the ten-minute refresh cadence.',
    liveDelay === 10 * MINUTE_MS,
    '10 minutes',
    `${liveDelay / MINUTE_MS} minutes`
  ));

  const rapidDelay = getLiveScoringRefreshDelay([], true, now);
  checks.push(check(
    'rapid-transition',
    'A completed window or matchup schedules a rapid follow-up pass.',
    rapidDelay === 7_500,
    '7.5 seconds',
    `${rapidDelay / 1000} seconds`
  ));

  const nearGameDelay = getLiveScoringRefreshDelay(
    [{
      hasLiveGames: false,
      nextScheduledGameStart: new Date(now + 30 * MINUTE_MS).toISOString()
    }],
    false,
    now
  );
  checks.push(check(
    'near-game-cadence',
    'An upcoming game refreshes shortly after its scheduled start.',
    nearGameDelay === 32 * MINUTE_MS,
    '32 minutes',
    `${nearGameDelay / MINUTE_MS} minutes`
  ));

  const idleDelay = getLiveScoringRefreshDelay([], false, now);
  checks.push(check(
    'idle-cadence',
    'A league with no active game signal uses the six-hour idle cadence.',
    idleDelay === 6 * HOUR_MS,
    '6 hours',
    `${idleDelay / HOUR_MS} hours`
  ));

  const passedCount = checks.filter((entry) => entry.passed).length;

  return {
    passed: passedCount === checks.length,
    passedCount,
    totalCount: checks.length,
    checks
  };
}
