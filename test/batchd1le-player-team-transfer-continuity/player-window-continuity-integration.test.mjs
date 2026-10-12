import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url);

async function source(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function section(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);

  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);

  return text.slice(start, end);
}

test('regular rollover advances only completed same-slot skater windows', async () => {
  const cycleSource = await source('functions/src/shared/core/cycle/cycle.service.ts');
  const seedLoader = section(
    cycleSource,
    'async function loadCompletedContinuitySeeds',
    'export async function startNextCycle',
  );
  const cycleStart = section(
    cycleSource,
    'export async function startNextCycle',
    'function getPendingMoveRequestedCycleNumber',
  );

  assert.match(seedLoader, /pick\.asset\.assetType !== 'skater'/);
  assert.match(
    seedLoader,
    /window\.status !== 'complete' \|\| window\.assetKey !== pick\.asset\.assetKey/,
  );
  assert.match(seedLoader, /advancePlayerWindowContinuity\(\{/);
  assert.match(seedLoader, /const currentInjurySegment = injuryReplacementWindow\?\.segments\.at\(-1\)/);
  assert.match(
    seedLoader,
    /completedScheduledGameIds:\s*currentInjurySegment\?\.scheduledGameIds \?\? window\.scheduledGameIds/,
  );
  assert.match(
    seedLoader,
    /completedScheduleTeamAbbreviation:\s*currentInjurySegment\?\.sourceTeamAbbreviation \?\?\s*window\.scheduleTeamAbbreviation/,
  );
  assert.match(cycleStart, /const continuityBySlotKey = await loadCompletedContinuitySeeds/);
  assert.match(cycleStart, /buildCurrentRosterSnapshotPicks\([\s\S]*?continuityBySlotKey/);
});

test('asynchronous regular rollover carries the current replacement segment and resets a queued replacement', async () => {
  const cycleSource = await source('functions/src/shared/core/cycle/cycle.service.ts');
  const rollover = section(
    cycleSource,
    'async function buildNextWindowSnapshotPicks',
    'export interface AdvanceCompletedWindowOptions',
  );

  assert.match(rollover, /const currentPickBySlotKey = new Map<string, DraftPick>/);
  assert.match(
    rollover,
    /const activationKey = slot\.pendingMove && pendingMoveReady\s*\? `move-\$\{slot\.pendingMove\.id\}`/,
  );
  assert.match(
    rollover,
    /const playerWindowContinuity = activationKey\s*\? createPlayerWindowContinuity\(\{[\s\S]*?activationKey,[\s\S]*?assignmentNotBefore: Date\.now\(\)/,
  );
  assert.match(
    rollover,
    /const previousCurrentInjurySegment =\s*previousInjuryReplacementWindow\?\.segments\.at\(-1\)/,
  );
  assert.match(
    rollover,
    /previousPick && previousSummary\s*\? advancePlayerWindowContinuity\(\{[\s\S]*?completedScheduledGameIds:\s*previousCurrentInjurySegment\?\.scheduledGameIds \?\?\s*previousSummary\.scheduledGameIds/,
  );
  assert.match(
    rollover,
    /completedScheduleTeamAbbreviation:\s*previousCurrentInjurySegment\?\.sourceTeamAbbreviation \?\?\s*previousSummary\.scheduleTeamAbbreviation/,
  );
  assert.match(
    rollover,
    /assignmentNotBefore: previousPick\.snapshottedAt/,
  );
  assert.match(rollover, /\.\.\.\(playerWindowContinuity \? \{ playerWindowContinuity \} : \{\}\)/);

  const reconciliation = section(
    cycleSource,
    'export async function reconcilePendingRosterMovesForRegularSeasonCycle',
    'export async function reconcileRegularSeasonCycleMatchupCompletion',
  );
  assert.match(reconciliation, /activationKey: `move-\$\{pendingMove\.id\}`/);
  assert.match(
    reconciliation,
    /playerWindowContinuity\s*\? \{ playerWindowContinuity \}\s*:\s*\{ playerWindowContinuity: null \}/,
  );
});

test('legacy immediate-move recovery requires exact audit, schedule, and untouched evidence', async () => {
  const cycleSource = await source('functions/src/shared/core/cycle/cycle.service.ts');
  const reconciliation = section(
    cycleSource,
    'export async function reconcilePendingRosterMovesForRegularSeasonCycle',
    'export async function reconcileRegularSeasonCycleMatchupCompletion',
  );

  assert.match(
    reconciliation,
    /where\('immediateUntouchedWindow', '==', true\)/,
  );
  assert.match(reconciliation, /matchingAudits\.length !== 1/);
  assert.match(reconciliation, /transaction\.get\(cycleRef\)/);
  assert.match(reconciliation, /savedCycle\.playerWindowContinuitySchemaVersion/);
  assert.match(reconciliation, /legacyImmediateMoveAuditMatches\(/);
  assert.match(reconciliation, /staleScheduleWasUnstartedAtAssignment\(/);
  assert.match(reconciliation, /legacyImmediateMoveWindowIsProvablyUntouched\(/);
  assert.match(reconciliation, /numberArraysAgree\(\s*persistedWindow\.scheduledGameIds/);
  assert.match(
    reconciliation,
    /snapshotSource: RECONCILED_IMMEDIATE_ROSTER_MOVE_SNAPSHOT_SOURCE/,
  );
  assert.match(reconciliation, /snapshottedAt: pick\.snapshottedAt/);
});

test('an immediate roster removal deletes its snapshot and an immediate incoming asset gets a fresh lineage', async () => {
  const rosterMoveSource = await source('functions/src/roster-moves.ts');
  const immediateMove = section(
    rosterMoveSource,
    'async function executeImmediateRosterMove(',
    'export async function applyAutomaticQueuedInjuryReplacement(',
  );

  assert.match(
    immediateMove,
    /const transactionRef = replaySubmissionId[\s\S]*?automaticReceiptIdentity\?\.transactionId \?\?[\s\S]*?createRosterActionTransactionId\(\{[\s\S]*?namespace: 'roster-add'/,
  );
  assert.match(immediateMove, /if \(removesActiveAssignment\)[\s\S]*?transaction\.delete\(rosterPickRef\)/);
  assert.match(
    immediateMove,
    /createPlayerWindowContinuity\(\{[\s\S]*?activationKey: `move-\$\{transactionRef\.id\}`/,
  );
  assert.match(immediateMove, /resetWindow\['playerWindowContinuity'\] =\s*playerWindowContinuity \?\? null/);
  assert.match(immediateMove, /playerWindowContinuity: playerWindowContinuity \?\? null/);
});

test('playoff banks require the preceding bank to complete, then carry the current replacement segment or reset', async () => {
  const playoffSource = await source(
    'functions/src/shared/core/playoffs/playoff-window-bank.service.ts',
  );
  const nextBank = section(
    playoffSource,
    'async function createNextPlayoffBankWindow',
    'const expectedRosterSlotIds = picks.map',
  );

  assert.match(
    nextBank,
    /windowNumber > 1 && \(!previousBank \|\| previousBank\.status !== 'complete'\)/,
  );
  assert.match(
    nextBank,
    /pendingMoveReady && slot\.pendingMove\s*\? createPlayerWindowContinuity\(\{[\s\S]*?activationKey: `move-\$\{slot\.pendingMove\.id\}`/,
  );
  assert.match(
    nextBank,
    /const currentInjurySegment =\s*previousInjuryReplacementWindow\?\.segments\.at\(-1\)/,
  );
  assert.match(
    nextBank,
    /previousPick && previousWindow\s*\? advancePlayerWindowContinuity\(\{[\s\S]*?previousContinuity,[\s\S]*?completedScheduledGameIds:\s*currentInjurySegment\?\.scheduledGameIds \?\?\s*previousWindow\.scheduledGameIds/,
  );
  assert.match(
    nextBank,
    /completedScheduleTeamAbbreviation:\s*currentInjurySegment\?\.sourceTeamAbbreviation \?\?\s*previousWindow\.scheduleTeamAbbreviation/,
  );
  assert.match(
    nextBank,
    /assignmentNotBefore: previousPick\.snapshottedAt/,
  );
  assert.match(
    nextBank,
    /playerWindowContinuitySchemaVersion !==[\s\S]*?PLAYER_WINDOW_CONTINUITY_SCHEMA_VERSION/,
  );
  assert.match(
    nextBank,
    /resolveConsistentPlayerWindowContinuity\(\{[\s\S]*?previousPick\.playerWindowContinuity,[\s\S]*?previousWindow\.playerWindowContinuity/,
  );
  assert.match(nextBank, /\.\.\.\(playerWindowContinuity \? \{ playerWindowContinuity \} : \{\}\)/);

  const bankWindowBuilder = section(
    playoffSource,
    'function buildSlotWindows',
    'function bankFingerprint',
  );
  assert.match(
    bankWindowBuilder,
    /resolveConsistentPlayerWindowContinuity\(\{[\s\S]*?summary\?\.playerWindowContinuity,[\s\S]*?previous\?\.playerWindowContinuity,[\s\S]*?pick\.playerWindowContinuity/,
  );
});

test('legacy cycles bootstrap every contiguous started window before live scoring', async () => {
  const [cycleSource, automationSource, serverModel, clientModel] = await Promise.all([
    source('functions/src/shared/core/cycle/cycle.service.ts'),
    source('functions/src/league-automation.ts'),
    source('functions/src/shared/core/cycle/cycle.models.ts'),
    source('src/app/core/cycle/cycle.models.ts'),
  ]);
  const bootstrap = section(
    cycleSource,
    'export async function ensureCyclePlayerWindowContinuity',
    'export async function getCycleMatchupsOnce',
  );

  assert.match(serverModel, /playerWindowContinuitySchemaVersion\?: number/);
  assert.match(clientModel, /playerWindowContinuitySchemaVersion\?: number/);
  assert.match(bootstrap, /reconstructLegacyPlayerWindowContinuity\(\{/);
  assert.match(bootstrap, /fantasyAssetWindowOwnershipStarted\(window\)/);
  assert.match(bootstrap, /updatedTeamWindowsByOwnerId/);
  assert.match(bootstrap, /playerWindowContinuity: rebuilt/);
  assert.match(bootstrap, /PLAYER_WINDOW_CONTINUITY_SCHEMA_VERSION/);
  assert.match(bootstrap, /requireCyclePlayerWindowContinuity\(savedCycle, savedPicks\)/);
  assert.match(
    automationSource,
    /ensureCyclePlayerWindowContinuity\([\s\S]*?leagueId,[\s\S]*?cycle,[\s\S]*?loadedPicks/,
  );

  const completedSeedLoader = section(
    cycleSource,
    'async function loadCompletedContinuitySeeds',
    'export async function startNextCycle',
  );
  assert.match(completedSeedLoader, /ensureCyclePlayerWindowContinuity\(/);
  assert.match(completedSeedLoader, /without its exact completed player window/);
  assert.match(completedSeedLoader, /resolveConsistentPlayerWindowContinuity\(\{/);
});
