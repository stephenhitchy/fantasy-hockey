import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  isRosterRemovalObserved,
  withRosterOperationTimeout,
} from '../../src/app/features/team/team-settings/roster-operation-confirmation.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

async function sha256(relativePath) {
  const value = await read(relativePath);
  return createHash('sha256').update(value).digest('hex');
}

test('live roster removal confirmation accepts active, bench, and IR slot changes', () => {
  const observation = {
    activeSlots: [{ slotId: 'G-1', assetKey: null }],
    benchSlots: [{ slotId: 'BENCH-2', assetKey: 'skater-22' }],
    irSlots: [{ slotId: 'IR-1', assetKey: null }],
  };

  assert.equal(isRosterRemovalObserved({
    sourceRosterArea: 'active',
    slotId: 'G-1',
    previousAssetKey: 'goalie-unit-WSH',
  }, observation), true);

  assert.equal(isRosterRemovalObserved({
    sourceRosterArea: 'bench',
    slotId: 'BENCH-2',
    previousAssetKey: 'skater-21',
  }, observation), true);

  assert.equal(isRosterRemovalObserved({
    sourceRosterArea: 'ir',
    slotId: 'IR-1',
    previousAssetKey: 'skater-9',
  }, observation), true);

  assert.equal(isRosterRemovalObserved({
    sourceRosterArea: 'bench',
    slotId: 'BENCH-2',
    previousAssetKey: 'skater-22',
  }, observation), false);
});

test('roster operation timeout unlocks a permanently pending browser request', async () => {
  await assert.rejects(
    withRosterOperationTimeout(new Promise(() => {}), 5, 'Roster request timed out.'),
    /Roster request timed out/,
  );

  assert.equal(
    await withRosterOperationTimeout(Promise.resolve('confirmed'), 100, 'should not time out'),
    'confirmed',
  );
});

test('goalie and player drops close the modal and accept the authoritative roster listener as confirmation', async () => {
  const [source, template] = await Promise.all([
    read('src/app/features/team/team-settings/team-settings.ts'),
    read('src/app/features/team/team-settings/team-settings.html'),
  ]);

  assert.match(source, /const expectation: RosterRemovalExpectation/);
  assert.match(source, /this\.rosterDropSource\.set\(null\)[\s\S]*dropRosterAssetToWaivers/);
  assert.match(source, /awaitRosterRemovalConfirmation/);
  assert.match(source, /20_000/);
  assert.match(source, /live-roster confirmation/i);
  assert.match(source, /Check My Team before retrying/);
  assert.match(template, /roster-operation-status-dock/);
  assert.doesNotMatch(template, /roster-action-shield" appViewportOverlayPortal/);
});

test('the unified add/drop workbench introduces the incoming player first and provides readable roster rows', async () => {
  const [source, template, styles] = await Promise.all([
    read('src/app/features/free-agents/free-agents.ts'),
    read('src/app/features/free-agents/free-agents.html'),
    read('src/app/features/free-agents/free-agents.css'),
  ]);

  assert.ok(template.indexOf('transaction-incoming-row') < template.indexOf('transaction-roster-list'));
  assert.match(template, /@for \(candidate of dropCandidates\(\)/);
  assert.match(template, /getCandidateMatchupNumberLabel\(candidate\)/);
  assert.match(template, /getCandidateActivationLabel\(candidate\)/);
  assert.match(template, /getDropCandidateActionLabel\(candidate\)/);
  assert.match(template, /\['\/leagues', leagueId, 'players', outgoing\.assetKey\]/);
  assert.match(source, /candidate\.rosterArea === 'active' \|\| candidate\.asset\.position === incoming\.position/);
  assert.doesNotMatch(source, /scrollReplacementRail/);
  assert.match(styles, /\.transaction-roster-list[\s\S]*display:\s*grid/);
  assert.match(styles, /\.transaction-roster-row/);
});

test('add drop submission releases the action sheet before waiting and uses a compact non-blurred status dock', async () => {
  const [source, template, styles] = await Promise.all([
    read('src/app/features/free-agents/free-agents.ts'),
    read('src/app/features/free-agents/free-agents.html'),
    read('src/rinkrat-transaction-workbench.css'),
  ]);

  assert.match(source, /this\.flowStep\.set\('player-pool'\)[\s\S]*await this\.loadSelectedAssetEligibility/);
  assert.match(source, /reopenComparison/);
  assert.match(source, /awaitRosterActionConfirmation/);
  assert.match(template, /roster-operation-status-dock/);
  assert.doesNotMatch(template, /appViewportOverlayPortal/);
  assert.match(styles, /\.roster-operation-status-dock[\s\S]*position:\s*fixed/);
  assert.doesNotMatch(styles, /\.roster-operation-status-dock[\s\S]*backdrop-filter/);
});

test('player game detail is redesigned around a six-game tape, score versus projection, and game film', async () => {
  const [source, template, styles] = await Promise.all([
    read('src/app/features/cycles/cycle-asset-detail/cycle-asset-detail.ts'),
    read('src/app/features/cycles/cycle-asset-detail/cycle-asset-detail.html'),
    read('src/app/features/cycles/cycle-asset-detail/cycle-asset-detail.css'),
  ]);

  assert.match(template, /Matchup \{\{ cycleNumber \}\} · Game Film/);
  assert.match(template, /The Six-Game Tape/);
  assert.match(template, /Current[\s\S]*Frozen projection/);
  assert.match(template, /Biggest point contributors/);
  assert.match(template, /Full point formula/);
  assert.match(template, /Projection and data details/);
  assert.match(source, /readonly projectionDelta = computed/);
  assert.match(source, /readonly bestGame = computed/);
  assert.match(source, /getGameExplanation/);
  assert.match(source, /getTopBreakdownLines/);
  assert.match(styles, /\.film-hero-rink/);
  assert.match(styles, /\.game-tape-grid/);
  assert.match(styles, /\.game-film-row/);
});

test('historical replay is isolated from scheduled scoring, retries briefly, and blocks duplicate client submissions', async () => {
  const [functionSource, clientSource, template] = await Promise.all([
    read('functions/src/league-automation.ts'),
    read('src/app/features/cycles/cycle-one/cycle-one.ts'),
    read('src/app/features/cycles/cycle-one/cycle-one.html'),
  ]);

  assert.match(
    functionSource,
    /HISTORICAL_REPLAY_LEASE_RETRY_DELAYS_MILLISECONDS = \[0, 500, 1_250, 2_250\]/,
  );
  assert.match(functionSource, /runHistoricalReplayAutomationWithRetry/);
  assert.match(functionSource, /for \(const retryDelay of HISTORICAL_REPLAY_LEASE_RETRY_DELAYS_MILLISECONDS\)/);
  assert.match(functionSource, /\(trigger === 'scheduled' \|\| trigger === 'queue-task'\)[\s\S]*await getHistoricalReplayControl\(leagueId\)/);
  assert.doesNotMatch(functionSource, /collectionGroup\('historicalReplay'\)/);
  assert.match(functionSource, /The simulated date was not skipped/);
  assert.match(clientSource, /historicalReplayControl\(\)\?\.status === 'advancing'/);
  assert.match(template, /\[disabled\]="isHistoricalReplayAdvanceLocked\(\)"/);
});

test('production scoring and Projection V11 remain unchanged', async () => {
  assert.equal(
    await sha256('src/app/core/scoring/scoring-rules.ts'),
    '74107aa688b4a3825c52fe14003cd824485197fd3559822fab4134bff940e2da',
  );
  assert.equal(
    await sha256('src/app/core/scoring/scoring-engine.ts'),
    '6f36cf76c72f8199c6a3891692844c9c830103ed618be50497b5270e259da3d3',
  );
  assert.equal(
    await sha256('src/app/core/projection/projection-v11.util.ts'),
    'e6f3111b1feccc7107e857aa24c5317451c65a84a36c71f8158947636f20d80a',
  );
  assert.equal(
    await sha256('functions/src/shared/core/projection/projection-v11.util.ts'),
    'e6f3111b1feccc7107e857aa24c5317451c65a84a36c71f8158947636f20d80a',
  );
});
