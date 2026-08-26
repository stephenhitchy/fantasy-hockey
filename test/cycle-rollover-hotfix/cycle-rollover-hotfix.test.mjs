import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const compatSource = await readFile(
  new URL('../../functions/src/shared/core/firebase-admin-compat.ts', import.meta.url),
  'utf8',
);
const cycleSource = await readFile(
  new URL('../../functions/src/shared/core/cycle/cycle.service.ts', import.meta.url),
  'utf8',
);
const scoringSource = await readFile(
  new URL('../../functions/src/shared/core/cycle/cycle-scoring.service.ts', import.meta.url),
  'utf8',
);
const automationSource = await readFile(
  new URL('../../functions/src/league-automation.ts', import.meta.url),
  'utf8',
);

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);

  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test('Admin Firestore compatibility supports auto-ID documents from collection references', () => {
  const docHelper = section(
    compatSource,
    'export function doc(',
    'export function collection(',
  );

  assert.match(docHelper, /pathSegments\.length === 0/);
  assert.match(docHelper, /return parent\.doc\(\)/);
  assert.match(docHelper, /zero or one id/);
});

test('regular-season rollover opens from completed slots without a league-wide completion gate', () => {
  const rollover = section(
    cycleSource,
    'export async function advanceCompletedRegularSeasonAssetWindows(',
    'export interface PendingRosterMoveReconciliationResult',
  );

  assert.match(rollover, /getCompletedWindowPickKeys\(currentPicks, scoring\)/);
  assert.match(rollover, /buildNextWindowSnapshotPicks\(/);
  assert.match(rollover, /if \(nextPicks\.length === 0\)/);
  assert.match(rollover, /overlapsPreviousCycle: true/);
  assert.doesNotMatch(rollover, /allCycleTeamsComplete|teamCycleComplete.*every/);
});

test('queued moves activate in the same transaction that assigns the next slot window', () => {
  const rollover = section(
    cycleSource,
    'export async function advanceCompletedRegularSeasonAssetWindows(',
    'export interface PendingRosterMoveReconciliationResult',
  );

  assert.match(rollover, /savedSlot\.pendingMove/);
  assert.match(rollover, /snapshotSource: activationPlan \? 'queued-slot-move' : 'slot-window-advance'/);
  assert.match(rollover, /transaction\.set\(doc\(getTransactionsRef\(leagueId\)\)/);
  assert.match(rollover, /pendingMove: null/);
});

test('active regular-season periods self-heal queued moves that an older manual opener skipped', () => {
  const recovery = section(
    cycleSource,
    'export async function reconcilePendingRosterMovesForRegularSeasonCycle(',
    '/**\n * Reconciles regular-season matchup completion',
  );

  assert.match(recovery, /cycle\.phase !== 'regular_season' \|\| cycle\.status !== 'active'/);
  assert.match(recovery, /pickBySlotId\.get\(slot\.slotId\)/);
  assert.match(recovery, /canActivatePendingMoveInCycle\(pendingMove, cycle\.cycleNumber\)/);
  assert.match(recovery, /wasPendingMoveQueuedBeforeCycleSnapshot\(pendingMove, pick\)/);
  assert.match(recovery, /snapshotSource: 'queued-slot-move-reconciled'/);
  assert.match(recovery, /pendingMove: null/);
  assert.match(recovery, /Process one roster at a time/);
});


test('recovery cannot activate a move in the current snapshot that predates the queue', () => {
  const timingGuard = section(
    cycleSource,
    'function wasPendingMoveQueuedBeforeCycleSnapshot(',
    'export interface PendingRosterMoveReconciliationResult',
  );

  assert.match(timingGuard, /Date\.parse\(pendingMove\.queuedAt\)/);
  assert.match(timingGuard, /getStoredTimestampMilliseconds\(pick\.snapshottedAt\)/);
  assert.match(timingGuard, /snapshottedAtMilliseconds >= queuedAtMilliseconds/);
});

test('server scoring repairs ready queued moves before loading picks for scoring', () => {
  const loop = section(
    automationSource,
    '      for (const cycle of activeCycles) {',
    "      const refreshedActiveCycles = await phaseTimer.measure(",
  );
  const reconcileIndex = loop.indexOf('reconcilePendingRosterMovesForRegularSeasonCycle');
  const picksIndex = loop.indexOf('getCycleRosterPicksOnce');

  assert.notEqual(reconcileIndex, -1);
  assert.notEqual(picksIndex, -1);
  assert.ok(reconcileIndex < picksIndex, 'Queued moves must be repaired before scoring picks load.');
  assert.match(automationSource, /'post-transition-cycle-refresh'[\s\S]*getActiveLeagueCycles\(leagueId\)/);
});

test('manual next-period recovery also reconciles queued moves before returning', () => {
  const callable = section(
    automationSource,
    'export const openNextCompetitionPeriod = onCall(',
    '/**\n * Clears a stale browser-era lease',
  );
  const startIndex = callable.indexOf('const nextCycle = await startNextCycle(');
  const reconcileIndex = callable.indexOf('await reconcilePendingRosterMovesForRegularSeasonCycle(');
  const returnIndex = callable.indexOf("status: 'opened'");

  assert.notEqual(startIndex, -1);
  assert.notEqual(reconcileIndex, -1);
  assert.notEqual(returnIndex, -1);
  assert.ok(startIndex < reconcileIndex && reconcileIndex < returnIndex);
});

test('a repaired slot never reuses finalized scores from the outgoing player', () => {
  const previousSummary = section(
    scoringSource,
    'function getPreviousWindowSummary(',
    'function getNextScheduledStart(',
  );

  assert.match(previousSummary, /previousWindow\?\.assetKey === assetKey/);
  assert.match(previousSummary, /return previousResult\?\.assetScores\?\.\[assetKey\]/);
});

test('historical replay retries the failed simulated date instead of skipping ahead', () => {
  const retryDateHelper = section(
    automationSource,
    'function getReplayRequestRetryDate(',
    'function isHistoricalReplayRequestStale(',
  );
  const replayWorker = section(
    automationSource,
    'async function performHistoricalReplayAdvance(',
    'export const advanceHistoricalReplayDay = onCall(',
  );

  assert.match(retryDateHelper, /lastFailedSimulatedDate/);
  assert.match(replayWorker, /retrySimulatedDate/);
  assert.match(replayWorker, /const retryFailedDate = Boolean/);
  assert.match(replayWorker, /Retrying the simulated NHL date/);
  assert.match(replayWorker, /lastFailedSimulatedDate: attemptedDate/);
  assert.match(replayWorker, /daysAdvanced: nextDaysAdvanced/);
});
