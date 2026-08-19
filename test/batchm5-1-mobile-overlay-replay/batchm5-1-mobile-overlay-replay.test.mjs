import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  buildCycleAssetSnapshotGames,
  parseReplaySnapshotSeason,
  resolveCycleAssetDetailSeason,
  resolveCycleAssetScoreSummary,
} from '../../src/app/features/cycles/cycle-asset-detail/cycle-asset-detail-snapshot.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

async function sha256(relativePath) {
  const contents = await readFile(new URL(relativePath, ROOT));
  return createHash('sha256').update(contents).digest('hex');
}

async function listHtmlFiles(relativeDirectory) {
  const rootPath = fileURLToPath(new URL(relativeDirectory, ROOT));
  const result = [];

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.html')) {
        result.push(fullPath);
      }
    }
  }

  await walk(rootPath);
  return result;
}

function makeSummary(overrides = {}) {
  return {
    assetKey: 'skater-88',
    ownerId: 'owner-a',
    rosterSlotId: 'LW-1',
    windowId: 'owner-a__LW-1__cycle-2',
    currentScore: 18.4,
    gamesPlayed: 2,
    actualGamesPlayed: 1,
    scheduledGames: 6,
    gamesLeft: 4,
    scheduledGameIds: [101, 102, 103],
    scheduledGameDates: ['2026-10-10', '2026-10-12', '2026-10-15'],
    scheduledGameLabels: ['vs BOS', '@ NYR', 'vs BUF'],
    completedGameIds: [101],
    liveGameIds: [102],
    appearanceGameIds: [101],
    gameScores: { '101': 14.2, '102': 4.24 },
    gameStates: { '101': 'final', '102': 'live', '103': 'scheduled' },
    firstScheduledGameDate: '2026-10-10',
    lastScheduledGameDate: '2026-10-15',
    status: 'active',
    ...overrides,
  };
}

test('saved Game Center summaries resolve the exact immutable roster-slot window first', () => {
  const exact = makeSummary();
  const staleAssetSummary = makeSummary({ windowId: 'old-window', currentScore: 2 });
  const snapshot = {
    result: {
      windowScores: { [exact.windowId]: exact },
      assetScores: { [exact.assetKey]: staleAssetSummary },
    },
  };
  const pick = {
    cycleWindowId: exact.windowId,
    asset: { assetKey: exact.assetKey },
  };

  assert.equal(
    resolveCycleAssetScoreSummary(snapshot, pick, exact.assetKey),
    exact,
  );
  assert.equal(
    resolveCycleAssetScoreSummary(snapshot, null, exact.assetKey),
    staleAssetSummary,
  );
});

test('saved six-game rows preserve authoritative dates, states, appearances, and scores', () => {
  const rows = buildCycleAssetSnapshotGames(makeSummary());

  assert.deepEqual(rows, [
    {
      gameId: 101,
      gameDate: '2026-10-10',
      scheduleLabel: 'vs BOS',
      state: 'final',
      fantasyPoints: 14.2,
      counted: true,
      appeared: true,
    },
    {
      gameId: 102,
      gameDate: '2026-10-12',
      scheduleLabel: '@ NYR',
      state: 'live',
      fantasyPoints: 4.2,
      counted: false,
      appeared: false,
    },
    {
      gameId: 103,
      gameDate: '2026-10-15',
      scheduleLabel: 'vs BUF',
      state: 'scheduled',
      fantasyPoints: null,
      counted: false,
      appeared: false,
    },
  ]);
});

test('historical replay uses mapped source-season statistics instead of the simulated target season', () => {
  assert.deepEqual(parseReplaySnapshotSeason('replay-20262027-from-20252026'), {
    targetSeason: '20262027',
    sourceSeason: '20252026',
  });
  assert.equal(parseReplaySnapshotSeason('20262027'), null);
  assert.equal(
    resolveCycleAssetDetailSeason({
      snapshotSeason: 'replay-20262027-from-20252026',
      replaySourceSeason: null,
      fallbackSeason: '20262027',
    }),
    '20252026',
  );
  assert.equal(
    resolveCycleAssetDetailSeason({
      snapshotSeason: 'replay-20262027-from-20252026',
      replaySourceSeason: '20242025',
      fallbackSeason: '20262027',
    }),
    '20242025',
  );
});

test('player detail listens to the same scoring snapshot and replay control as Game Center', async () => {
  const [source, template] = await Promise.all([
    read('src/app/features/cycles/cycle-asset-detail/cycle-asset-detail.ts'),
    read('src/app/features/cycles/cycle-asset-detail/cycle-asset-detail.html'),
  ]);

  assert.match(source, /listenToSharedCycleScoring/);
  assert.match(source, /listenToHistoricalReplayControl/);
  assert.match(source, /snapshot\?\.scoringFingerprint/);
  assert.match(source, /scoreSummary\.gameStates/);
  assert.match(source, /scoreSummary\.gameScores/);
  assert.match(source, /getRegularSeasonGameLog\(asset\.player\.id, season\)/);
  assert.match(source, /Saved Game Center score/);
  assert.match(template, /Historical Replay Source/);
  assert.match(template, /Game \{\{ row\.cycleGameNumber \}\}/);
  assert.doesNotMatch(template, /NHL Team Game\s*\{\{ row\.teamGameNumber/);
});

test('viewport overlays are portaled to document.body and restore the exact scroll position', async () => {
  const source = await read('src/app/shared/accessibility/viewport-overlay-portal.directive.ts');

  assert.match(source, /document\.body\.appendChild\(this\.host\)/);
  assert.match(source, /body\.style\.position = 'fixed'/);
  assert.match(source, /body\.style\.top = `\$\{-lockedScrollY\}px`/);
  assert.match(source, /this\.host\.remove\(\)/);
  assert.doesNotMatch(source, /originalParent|originalNextSibling|insertBefore\(this\.host/);
  assert.match(source, /window\.scrollTo\(scrollX, scrollY\)/);
  assert.match(source, /activeViewportOverlays = new Set<HTMLElement>/);
  assert.match(source, /repairViewportOverlayLock/);
});

test('all recently added modal-style interfaces use the shared viewport portal', async () => {
  const files = {
    actionSheet: await read('src/app/shared/action-sheet/action-sheet.html'),
    gameCenter: await read('src/app/features/cycles/cycle-one/components/cycle-mobile-head-to-head/cycle-mobile-head-to-head.html'),
    league: await read('src/app/features/leagues/league-detail/league-detail.html'),
    draft: await read('src/app/features/draft/draft-room/draft-room.html'),
    draftSetup: await read('src/app/features/draft/draft-setup/draft-setup.html'),
    freeAgents: await read('src/app/features/free-agents/free-agents.html'),
    team: await read('src/app/features/team/team-settings/team-settings.html'),
  };

  assert.match(files.actionSheet, /rr-action-sheet-backdrop[\s\S]*appViewportOverlayPortal/);
  assert.doesNotMatch(files.gameCenter, /mobile-asset-sheet-backdrop|appViewportOverlayPortal/);
  assert.match(files.league, /draft-live-overlay[\s\S]*appViewportOverlayPortal/);
  assert.match(files.draft, /draft-pick-sync-dock/);
  assert.doesNotMatch(files.draft, /draft-pick-submission-shield|appViewportOverlayPortal/);
  assert.match(files.draftSetup, /draft-save-status-dock/);
  assert.doesNotMatch(files.draftSetup, /draft-save-lock|appViewportOverlayPortal/);
  assert.match(files.freeAgents, /roster-operation-status-dock/);
  assert.doesNotMatch(files.freeAgents, /roster-operation-status-dock[\s\S]*appViewportOverlayPortal/);
  assert.ok((files.team.match(/appViewportOverlayPortal/g) ?? []).length >= 4);
});

test('shared mobile sheets open inside the current visual viewport while Game Center rows navigate directly', async () => {
  const [actionCss, gameTemplate, gameCss, tokens] = await Promise.all([
    read('src/app/shared/action-sheet/action-sheet.css'),
    read('src/app/features/cycles/cycle-one/components/cycle-mobile-head-to-head/cycle-mobile-head-to-head.html'),
    read('src/app/features/cycles/cycle-one/components/cycle-mobile-head-to-head/cycle-mobile-head-to-head.css'),
    read('src/rinkrat-design-tokens.css'),
  ]);

  assert.match(actionCss, /position:\s*fixed/);
  assert.match(actionCss, /z-index:\s*var\(--rr-z-viewport-overlay/);
  assert.match(actionCss, /max-height:\s*min\(94dvh/);
  assert.match(actionCss, /-webkit-overflow-scrolling:\s*touch/);
  assert.doesNotMatch(gameTemplate, /mobile-asset-sheet-backdrop/);
  assert.doesNotMatch(gameCss, /mobile-asset-sheet/);
  assert.match(tokens, /--rr-z-viewport-overlay:\s*2000/);
});

test('Draft Room keeps only the compact command bar and selected-player action sticky on phones', async () => {
  const [template, styles] = await Promise.all([
    read('src/app/features/draft/draft-room/draft-room.html'),
    read('src/app/features/draft/draft-room/draft-room.css'),
  ]);

  assert.match(template, /draft-mobile-command-owner/);
  assert.match(template, /draft-mobile-command-clock/);
  assert.match(styles, /\.draft-mobile-command-bar\s*\{[\s\S]*?position:\s*sticky[\s\S]*?min-height:\s*62px/);
  assert.match(styles, /\.draft-mobile-tabs\s*\{[\s\S]*?position:\s*static/);
  assert.match(styles, /\.pool-controls\s*\{[\s\S]*?position:\s*static/);
  assert.match(styles, /\.draft-mobile-selection-bar\s*\{[\s\S]*?position:\s*fixed/);
  assert.doesNotMatch(styles, /\.pool-controls\s*\{[^}]*position:\s*sticky/s);
});

test('every Back to League control uses the shared graphic return treatment', async () => {
  const files = await listHtmlFiles('src/app/');
  let count = 0;

  for (const file of files) {
    const html = await readFile(file, 'utf8');

    if (!html.includes('Back to League')) {
      continue;
    }

    const controls = html.match(/<a\b[^>]*>[\s\S]*?Back to League[\s\S]*?<\/a>/g) ?? [];
    assert.ok(controls.length > 0, `${file} should expose a Back to League anchor`);

    for (const control of controls) {
      assert.match(control, /class="[^"]*league-return-link/);
      count += 1;
    }
  }

  assert.ok(count >= 14, 'expected the shared return control across league-owned pages');

  const [styles, graphic] = await Promise.all([
    read('src/styles.css'),
    read('public/assets/ui/back-to-league-rink.svg'),
  ]);
  assert.match(styles, /\.league-return-link::before/);
  assert.match(styles, /back-to-league-rink\.svg/);
  assert.match(graphic, /left-pointing return arrow/i);
});

test('other high-traffic return controls share the same visible graphic style', async () => {
  const [freeAgents, matchup, playoff, detail] = await Promise.all([
    read('src/app/features/free-agents/free-agents.html'),
    read('src/app/features/cycles/matchup-overview/cycle-matchup-overview.html'),
    read('src/app/features/playoffs/playoff-window-simulator/playoff-window-simulator.html'),
    read('src/app/features/cycles/cycle-asset-detail/cycle-asset-detail.html'),
  ]);

  for (const source of [freeAgents, matchup, playoff, detail]) {
    assert.match(source, /class="league-return-link"/);
    assert.doesNotMatch(source, /←\s*Back/);
  }
});

test('the overlay hotfix still preserves production scoring while replay orchestration includes the later lease-retry safeguard', async () => {
  assert.equal(
    await sha256('src/app/core/scoring/scoring-rules.ts'),
    '74107aa688b4a3825c52fe14003cd824485197fd3559822fab4134bff940e2da',
  );
  assert.equal(
    await sha256('src/app/core/scoring/scoring-engine.ts'),
    '6f36cf76c72f8199c6a3891692844c9c830103ed618be50497b5270e259da3d3',
  );
  const automation = await read('functions/src/league-automation.ts');
  assert.match(automation, /runHistoricalReplayAutomationWithRetry/);
  assert.match(automation, /The simulated date was not skipped/);
});
