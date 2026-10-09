import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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

test('roster-move timing refreshes stable-id team identity and persists provenance', async () => {
  const text = await source('functions/src/roster-moves.ts');
  const identityApplication = section(
    text,
    'export function applyCurrentNhlTeamIdentity',
    'function getSkaterPlayerIds',
  );
  const callable = section(
    text,
    'async function executeImmediateRosterMove(',
    'export async function applyAutomaticQueuedInjuryReplacement(',
  );

  assert.match(callable, /loadCurrentNhlPlayerTeamIdentity\(\{/);
  assert.match(callable, /minimumGeneratedAtMilliseconds:\s*identityBoundaryMilliseconds/);
  assert.match(callable, /applyCurrentNhlTeamIdentity\(/);
  assert.match(callable, /currentTeamAbbreviationByPlayerId/);
  assert.match(
    callable,
    /const requiredIdentityPlayerIds = getSkaterPlayerIds\(\[\s*preflightActiveSlot\.asset,\s*preflightLegacyIrAsset,\s*addAsset,\s*preflightSelectedIncomingAsset,\s*\]\)/,
  );
  assert.match(callable, /requiredPlayerIds: requiredIdentityPlayerIds/);
  assert.doesNotMatch(callable, /getRosterSkaterIds/);
  assert.match(
    identityApplication,
    /teamLogoUrl:\s*`https:\/\/assets\.nhle\.com\/logos\/nhl\/svg\/\$\{currentTeamAbbreviation\}_light\.svg`/,
  );
  assert.match(identityApplication, /player:\s*\{\s*\.\.\.asset\.player,/);
  assert.match(text, /nhlPlayerTeamIdentityHash: rosterMoveIdentity\.identityHash/);
  assert.match(text, /nhlPlayerTeamIdentityGeneratedAt:/);
});

test('secure roster eligibility uses one fresh identity boundary for only the incoming skater', async () => {
  const [authority, moves] = await Promise.all([
    source('functions/src/roster-authority.ts'),
    source('functions/src/roster-moves.ts'),
  ]);
  const fairCycle = section(
    authority,
    'async function getFairEffectiveCycleNumber',
    'async function assertAssetIsFreeAgent',
  );
  const addAction = section(
    authority,
    'async function executeAddAction',
    'async function executeSimpleOwnerAction',
  );
  const simpleAction = section(
    authority,
    'async function executeSimpleOwnerAction',
    'async function placeWaiverClaim',
  );
  const callable = authority.slice(
    authority.indexOf('export const executeSecureRosterAction = onCall'),
  );
  const eligibility = section(
    moves,
    'export async function resolveRosterMoveAssetCycleEligibility',
    'export async function getEarliestEligibleCycleNumber',
  );

  assert.equal(
    callable.match(/const actionBoundaryMilliseconds = Date\.now\(\);/g)?.length,
    1,
  );
  assert.ok(
    callable.indexOf('const actionBoundaryMilliseconds = Date.now();') <
      callable.indexOf('return executeAddAction({'),
  );
  assert.match(
    fairCycle,
    /resolveRosterMoveAssetCycleEligibility\([\s\S]*?actionBoundaryMilliseconds,/,
  );
  assert.match(fairCycle, /asset: eligibility\.asset/);
  assert.match(
    fairCycle,
    /currentTeamAbbreviationByPlayerId:\s*eligibility\.currentTeamAbbreviationByPlayerId/,
  );
  assert.match(addAction, /getFairEffectiveCycleNumber\([\s\S]*?actionBoundaryMilliseconds,/);
  assert.match(addAction, /const asset = fairEffectiveCycle\.asset/);
  assert.match(addAction, /addedAsset: asset/);
  assert.equal(
    simpleAction.match(/getFairEffectiveCycleNumber\([\s\S]*?actionBoundaryMilliseconds,/g)?.length,
    2,
  );
  assert.equal(
    simpleAction.match(/applyCurrentNhlTeamIdentity\(/g)?.length,
    2,
  );
  assert.match(
    simpleAction,
    /asset: \{\s*\.\.\.authoritativeIrAsset,[\s\S]*?activatedAsset: authoritativeIrAsset/,
  );
  assert.match(
    simpleAction,
    /rosterAssetToDraftableAsset\(authoritativeBenchAsset\)/,
  );
  assert.match(
    simpleAction,
    /roster\.benchSlots\[benchIndex\] = \{[\s\S]*?asset: authoritativeBenchAsset/,
  );
  assert.match(eligibility, /requiredPlayerIds:\s*\[asset\.player\.id\]/);
  assert.match(
    eligibility,
    /minimumGeneratedAtMilliseconds:\s*minimumIdentityGeneratedAtMilliseconds/,
  );
  assert.match(eligibility, /asset: authoritativeAsset/);
});

test('puck-drop identity evidence forces one post-boundary refresh and playoff retry', async () => {
  const scoring = await source(
    'functions/src/shared/core/cycle/cycle-scoring.service.ts',
  );
  const automation = await source('functions/src/league-automation.ts');
  const playoffs = await source(
    'functions/src/shared/core/playoffs/playoff-window-bank.service.ts',
  );

  assert.match(scoring, /NhlPlayerTeamIdentityBoundaryRefreshRequiredError/);
  assert.match(scoring, /identityGeneratedAtMilliseconds < latestStartedGameBoundary/);
  assert.match(automation, /minimumGeneratedAtMilliseconds:\s*error\.minimumGeneratedAtMilliseconds/);
  assert.match(playoffs, /minimumGeneratedAtMilliseconds:\s*error\.minimumGeneratedAtMilliseconds/);
});

test('identity evidence timestamps the start of the provider observation, not its completion', async () => {
  const identity = await source(
    'functions/src/shared/core/nhl/nhl-player-team-identity.service.ts',
  );
  const refresh = section(
    identity,
    'async function completeRefresh',
    'async function recordRefreshFailure',
  );

  assert.ok(
    refresh.indexOf('const generatedAt = new Date().toISOString()') <
      refresh.indexOf('await getCurrentNhlDraftSkaters(true)'),
  );
  assert.match(refresh, /resolveNhlPlayerTeamConfirmedAt\(\{/);
  assert.match(identity, /allowRefreshing && data\['status'\] === 'refreshing'/);
});

test('trade final-appearance failures block publication instead of freezing a shortened window', async () => {
  const scoring = await source(
    'functions/src/shared/core/cycle/cycle-scoring.service.ts',
  );

  assert.match(scoring, /hasFinalDestinationGame/);
  assert.match(
    scoring,
    /Final appearance evidence is unavailable for traded skater/,
  );
  assert.match(scoring, /Scoring was left unchanged and will retry/);
});

test('aggregate scoring stores only compact stint identity, not cumulative lineage arrays', async () => {
  const scoring = await source(
    'functions/src/shared/core/cycle/cycle-scoring.service.ts',
  );
  const summaryBuilder = section(
    scoring,
    'const summary: CycleAssetScoreSummary = {',
    'assetScores[pick.asset.assetKey] = summary;',
  );

  assert.match(summaryBuilder, /playerWindowContinuityId/);
  assert.doesNotMatch(summaryBuilder, /playerWindowContinuity:/);
  assert.doesNotMatch(summaryBuilder, /priorAssignedGameIds/);
});

test('team-window publication uses transactionally checked assignment and stint CAS', async () => {
  const windows = await source(
    'functions/src/shared/core/cycle/asset-cycle-window.service.ts',
  );
  const sync = section(
    windows,
    'export async function syncCycleTeamWindows',
    'const completionFingerprint =',
  );

  assert.match(sync, /runTransaction\(db, async \(transaction\) =>/);
  assert.match(sync, /currentFingerprint !== pending\.expectedExistingFingerprint/);
  assert.match(sync, /savedPick\.asset\.assetKey !== pick\.asset\.assetKey/);
  assert.match(sync, /savedContinuityId !== expectedContinuityId/);
});

test('live scoring publishes only after durable windows and replaces the whole guarded result', async () => {
  const automation = await source('functions/src/league-automation.ts');
  const publication = section(
    automation,
    'async function publishCycleSnapshot',
    'function allCycleTeamsComplete',
  );
  const scoringLoop = section(
    automation,
    'for (const cycle of activeCycles)',
    'const refreshedActiveCycles =',
  );

  assert.match(publication, /return db\.runTransaction\(async \(transaction\) =>/);
  assert.match(publication, /transaction\.get\(cycleRosterPicksQuery\)/);
  assert.match(publication, /transaction\.get\(teamWindowsQuery\)/);
  assert.match(publication, /savedPick\.asset\.assetKey !== pick\.asset\.assetKey/);
  assert.match(publication, /savedWindow\.assetKey !== pick\.asset\.assetKey/);
  assert.match(publication, /savedPickContinuityId !== expectedContinuityId/);
  assert.match(publication, /savedWindowContinuityId !== expectedContinuityId/);
  assert.match(publication, /transaction\.set\(snapshotRef,/);
  assert.doesNotMatch(publication, /\{ merge: true \}/);
  assert.ok(
    scoringLoop.indexOf("'window-and-competition-persistence'") <
      scoringLoop.indexOf("'snapshot-publication'"),
  );
});

test('retry schedule discovery and fingerprints are scoped to the current asset stint', async () => {
  const scoring = await source(
    'functions/src/shared/core/cycle/cycle-scoring.service.ts',
  );
  const teamDiscovery = section(
    scoring,
    'function getUniqueDraftedTeams',
    'function getUniqueSkaterAssets',
  );
  const fingerprint = section(
    scoring,
    'function buildResultFingerprint',
    'function buildCurrentPickIdentityDigest',
  );

  assert.match(teamDiscovery, /getPreviousWindowSummary\(/);
  assert.match(teamDiscovery, /pick\.asset\.assetKey/);
  assert.match(teamDiscovery, /continuity\?\.continuityId/);
  assert.doesNotMatch(
    teamDiscovery,
    /Object\.values\(\s*input\.previousResult\?\.windowScores/,
  );
  assert.match(fingerprint, /summary\.assetKey/);
});

test('the first playoff bank activates ready queued moves atomically', async () => {
  const cycle = await source(
    'functions/src/shared/core/cycle/cycle.service.ts',
  );
  const snapshotBuilder = section(
    cycle,
    'async function buildCurrentRosterSnapshotPicks',
    'function writeCycleRosterPickSnapshots',
  );
  const cycleStart = section(
    cycle,
    'export async function startNextCycle',
    'function getCompletedWindowPickKeys',
  );

  assert.match(snapshotBuilder, /canActivatePendingMoveInCycle\(slot\.pendingMove, cycleNumber\)/);
  assert.match(snapshotBuilder, /activationKey: `move-\$\{slot\.pendingMove\.id\}`/);
  assert.match(snapshotBuilder, /activationPlansBySlotKey\[/);
  assert.match(cycleStart, /playoffActivationPlansBySlotKey/);
  assert.match(cycleStart, /activatePendingSlotMoveInRoster\(\{/);
  assert.match(cycleStart, /effectiveLabel: 'Playoff Window 1'/);
});

test('immediate playoff moves synchronize the bank and replace outgoing frozen ids', async () => {
  const [moves, playoffs] = await Promise.all([
    source('functions/src/roster-moves.ts'),
    source('functions/src/shared/core/playoffs/playoff-window-bank.service.ts'),
  ]);
  const callable = section(
    moves,
    'async function executeImmediateRosterMove(',
    'export async function applyAutomaticQueuedInjuryReplacement(',
  );
  const bankSync = section(
    playoffs,
    'export async function syncPlayoffWindowBankScores',
    'export function createInitialPlayoffBankPayloads',
  );

  assert.match(callable, /transaction\.get\(playoffBankRef\)/);
  assert.match(callable, /The playoff bank and active cycle assignment are out of sync/);
  assert.match(callable, /sourceNhlTargetGameIds: _outgoingSourceNhlTargetGameIds/);
  assert.match(callable, /incomingSourceNhlTargetGameIds/);
  assert.match(callable, /transaction\.set\(\s*playoffBankRef,/);
  assert.match(bankSync, /bankAuthorityFingerprint\(current\) !== expectedAuthorityFingerprint/);
  assert.match(bankSync, /bankFingerprint\(current\) !== expectedScoringFingerprint/);
  assert.match(bankSync, /does not match the active cycle picks/);
  assert.doesNotMatch(bankSync, /writeBatch\(/);
});
