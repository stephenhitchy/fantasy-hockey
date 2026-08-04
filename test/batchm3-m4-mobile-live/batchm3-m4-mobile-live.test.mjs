import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  getDraftAutoPickExplanation,
  getDraftConnectionStatusDetail,
  getDraftConnectionStatusLabel,
  getLatestUndismissedAutoPick,
  resolveDraftRealtimeConnectionState,
} from '../../src/app/features/draft/draft-room/draft-mobile-resilience.util.ts';
import {
  getMobileGameMarkerExplanation,
  getMobileMatchupPerspective,
  getOwnerIdForMobileView,
  groupMobileMatchupPositions,
  resolveMobileMatchupView,
} from '../../src/app/features/cycles/cycle-one/cycle-mobile-matchup.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

async function sha256(relativePath) {
  const contents = await readFile(new URL(relativePath, ROOT));
  return createHash('sha256').update(contents).digest('hex');
}

async function listFiles(relativeDirectory) {
  const rootPath = fileURLToPath(new URL(relativeDirectory, ROOT));
  const result = [];

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === 'lib' || entry.name === 'node_modules') {
          continue;
        }
        await walk(fullPath);
      } else if (entry.isFile()) {
        result.push(path.relative(rootPath, fullPath).replaceAll(path.sep, '/'));
      }
    }
  }

  await walk(rootPath);
  return result;
}

async function directoryFingerprint(relativeDirectory) {
  const files = await listFiles(relativeDirectory);
  const digest = createHash('sha256');

  for (const file of files) {
    const fileContents = await readFile(new URL(`${relativeDirectory}${file}`, ROOT));
    digest.update(file);
    digest.update('\0');
    digest.update(createHash('sha256').update(fileContents).digest('hex'));
    digest.update('\n');
  }

  return digest.digest('hex');
}

function makePick(overrides = {}) {
  return {
    overallPick: 8,
    round: 1,
    pickInRound: 8,
    ownerId: 'owner-a',
    selectionType: 'queue',
    autoPickReason: 'timer-expired',
    asset: {
      assetType: 'skater',
      assetKey: 'skater-88',
      position: 'C',
      player: {
        id: 88,
        fullName: 'Test Center',
        position: 'C',
        nhlTeamAbbreviation: 'TST',
      },
    },
    ...overrides,
  };
}

const matchup = {
  teamAOwnerId: 'owner-a',
  teamBOwnerId: 'owner-b',
};

test('draft connection state blocks actions until every critical listener is server-confirmed', () => {
  const base = {
    online: true,
    confirmationStartedAt: 1_000,
    criticalServerSyncTimes: [1_050, 1_060, 1_070],
    listenerError: null,
    reconnectReason: null,
    now: 1_080,
  };

  assert.equal(resolveDraftRealtimeConnectionState(base), 'connected');
  assert.equal(
    resolveDraftRealtimeConnectionState({ ...base, online: false }),
    'offline',
  );
  assert.equal(
    resolveDraftRealtimeConnectionState({
      ...base,
      criticalServerSyncTimes: [null, null, null],
      reconnectReason: 'initial',
    }),
    'connecting',
  );
  assert.equal(
    resolveDraftRealtimeConnectionState({
      ...base,
      criticalServerSyncTimes: [1_050, null, 1_070],
      reconnectReason: 'manual',
    }),
    'reconnecting',
  );
  assert.equal(
    resolveDraftRealtimeConnectionState({
      ...base,
      confirmationStartedAt: 1_000,
      criticalServerSyncTimes: [900, 900, 900],
      reconnectReason: 'resume',
      now: 4_600,
    }),
    'stale',
  );

  assert.equal(getDraftConnectionStatusLabel('connected'), 'Connected');
  assert.match(getDraftConnectionStatusDetail('offline'), /actions are paused/i);
});

test('auto-pick notices stay available until the manager dismisses the latest automatic pick', () => {
  const picks = [
    makePick({ overallPick: 4, selectionType: 'manual', autoPickReason: null }),
    makePick({ overallPick: 8 }),
    makePick({
      overallPick: 12,
      ownerId: 'owner-b',
      selectionType: 'automatic',
      autoPickReason: 'manager-auto-mode',
    }),
    makePick({
      overallPick: 19,
      selectionType: 'automatic',
      autoPickReason: 'manager-auto-mode',
    }),
  ];

  assert.equal(
    getLatestUndismissedAutoPick(picks, 'owner-a', 0)?.overallPick,
    19,
  );
  assert.equal(
    getLatestUndismissedAutoPick(picks, 'owner-a', 8)?.overallPick,
    19,
  );
  assert.equal(getLatestUndismissedAutoPick(picks, 'owner-a', 19), null);
});

test('auto-pick explanations distinguish queue selections from ranked legal fallbacks', () => {
  const queued = getDraftAutoPickExplanation(makePick(), 'Test Center');
  assert.equal(queued?.tone, 'warning');
  assert.match(queued?.title ?? '', /queue pick used/i);
  assert.match(queued?.detail ?? '', /first legal player/i);

  const automatic = getDraftAutoPickExplanation(
    makePick({
      overallPick: 19,
      selectionType: 'automatic',
      autoPickReason: 'manager-auto-mode',
    }),
    'Fallback Defenseman',
  );
  assert.equal(automatic?.tone, 'info');
  assert.match(automatic?.detail ?? '', /highest-ranked legal option/i);
  assert.equal(
    getDraftAutoPickExplanation(
      makePick({ selectionType: 'manual', autoPickReason: null }),
      'Manual Pick',
    ),
    null,
  );
});

test('mobile matchup views remain owner-relative for both sides', () => {
  assert.equal(resolveMobileMatchupView('my-team', 'owner-a', matchup), 'teamA');
  assert.equal(resolveMobileMatchupView('opponent', 'owner-a', matchup), 'teamB');
  assert.equal(resolveMobileMatchupView('my-team', 'owner-b', matchup), 'teamB');
  assert.equal(resolveMobileMatchupView('opponent', 'owner-b', matchup), 'teamA');
  assert.equal(resolveMobileMatchupView('head-to-head', 'owner-a', matchup), 'both');

  assert.equal(getMobileMatchupPerspective('teamB', 'owner-b', matchup), 'my-team');
  assert.equal(getMobileMatchupPerspective('teamA', 'owner-b', matchup), 'opponent');
  assert.equal(getMobileMatchupPerspective('both', 'owner-b', matchup), 'head-to-head');
  assert.equal(getOwnerIdForMobileView('teamA', matchup), 'owner-a');
  assert.equal(getOwnerIdForMobileView('teamB', matchup), 'owner-b');
  assert.equal(getOwnerIdForMobileView('both', matchup), null);
});

test('mobile lineup grouping creates readable forward, defense, and goalie sections', () => {
  const makeGroup = (position, count) => ({
    position,
    label: position,
    rows: Array.from({ length: count }, (_, slotIndex) => ({
      position,
      slotIndex,
      teamAPick: null,
      teamBPick: null,
    })),
  });

  const sections = groupMobileMatchupPositions([
    makeGroup('LW', 3),
    makeGroup('C', 3),
    makeGroup('RW', 3),
    makeGroup('D', 4),
    makeGroup('G', 1),
  ]);

  assert.deepEqual(sections.map((section) => section.key), [
    'forwards',
    'defense',
    'goalie',
  ]);
  assert.equal(sections[0].rows.length, 9);
  assert.equal(sections[1].rows.length, 4);
  assert.equal(sections[2].rows.length, 1);
});

test('six-game explanations clearly distinguish appearances, misses, live games, and pending schedules', () => {
  const baseMarker = {
    index: 2,
    gameId: 222,
    gameDate: '2026-11-12',
    gameLabel: 'TST vs OPP',
    status: 'played',
    statusLabel: 'Played',
    title: 'Game 2',
  };

  const played = getMobileGameMarkerExplanation(baseMarker, 14.25, 'final');
  assert.match(played.heading, /player appeared/i);
  assert.equal(played.pointsLabel, '14.3 pts');

  const missed = getMobileGameMarkerExplanation(
    { ...baseMarker, status: 'missed' },
    0,
    'final',
  );
  assert.match(missed.heading, /no appearance/i);
  assert.match(missed.detail, /still uses one/i);
  assert.equal(missed.pointsLabel, '0.0 pts');

  const live = getMobileGameMarkerExplanation(
    { ...baseMarker, status: 'upcoming' },
    6.4,
    'live',
  );
  assert.match(live.heading, /is live/i);

  const scheduled = getMobileGameMarkerExplanation(
    { ...baseMarker, status: 'upcoming' },
    null,
    'scheduled',
  );
  assert.equal(scheduled.pointsLabel, 'Upcoming');

  const unavailable = getMobileGameMarkerExplanation(
    {
      ...baseMarker,
      gameId: null,
      gameDate: null,
      gameLabel: 'Schedule pending',
      status: 'unavailable',
    },
    null,
    null,
  );
  assert.match(unavailable.detail, /asynchronous window boundary/i);
});

test('draft listeners expose metadata, errors, and server-confirmed snapshot state', async () => {
  const service = await read('src/app/core/draft/draft.service.ts');

  assert.match(service, /export interface DraftRealtimeSnapshotState/);
  assert.equal((service.match(/includeMetadataChanges:\s*true/g) ?? []).length, 4);
  assert.match(service, /reportDraftSnapshotState\(snapshot\.metadata, onState\)/);
  assert.match(service, /Unable to load your draft queue/);
  assert.match(service, /Unable to load draft queues/);
});

test('Draft Room has focused phone views, stale-state protection, queue reasons, and a confirmed-pick shield', async () => {
  const [template, source, styles, routes, guard] = await Promise.all([
    read('src/app/features/draft/draft-room/draft-room.html'),
    read('src/app/features/draft/draft-room/draft-room.ts'),
    read('src/app/features/draft/draft-room/draft-room.css'),
    read('src/app/app.routes.ts'),
    read('src/app/core/guards/pending-draft-action.guard.ts'),
  ]);

  for (const required of [
    'draft-mobile-command-bar',
    'draft-mobile-tabs',
    "setMobilePanel('players')",
    "setMobilePanel('queue')",
    "setMobilePanel('roster')",
    'draft-mobile-selection-bar',
    'draft-pick-submission-shield',
    'Retry Connection',
    'queue-row-unavailable',
    'getQueueEntryStatusLabel',
  ]) {
    assert.match(template, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(source, /@HostListener\('window:beforeunload'/);
  assert.match(source, /confirmPendingPickIfObserved/);
  assert.match(source, /pick\.asset\.assetKey === pending\.assetKey/);
  assert.match(source, /visibilitychange/);
  assert.match(source, /navigator\.onLine/);
  assert.match(source, /rinkrat:draft-auto-pick-dismissed/);
  assert.match(source, /updateAutoPickNotice\(picks\)/);
  assert.match(routes, /canDeactivate:\s*\[pendingDraftActionGuard\]/);
  assert.match(guard, /component\.canLeaveDraftRoom\(\)/);
  assert.match(styles, /position:\s*sticky/);
  assert.match(styles, /min-height:\s*(?:44px|var\(--rr-mobile-control-min-height\))/);
  assert.ok(Buffer.byteLength(styles) < 45_000, 'Draft Room component CSS exceeds 45 kB raw.');
});

test('Game Center phone view uses perspective tabs, grouped accordions, compact six-game rows, and an accessible detail sheet', async () => {
  const [template, source, styles] = await Promise.all([
    read('src/app/features/cycles/cycle-one/components/cycle-mobile-head-to-head/cycle-mobile-head-to-head.html'),
    read('src/app/features/cycles/cycle-one/components/cycle-mobile-head-to-head/cycle-mobile-head-to-head.ts'),
    read('src/app/features/cycles/cycle-one/components/cycle-mobile-head-to-head/cycle-mobile-head-to-head.css'),
  ]);

  for (const required of [
    'mobile-matchup-mode-selector',
    "setPerspective('my-team')",
    "setPerspective('head-to-head')",
    "setPerspective('opponent')",
    'mobile-live-position-section',
    'mobile-window-markers',
    'mobile-live-bench-section',
    'Why each game counts',
    'mobile-asset-sheet-backdrop',
    'appDialogFocusTrap',
    'dialogEscape',
    'Open full scoring breakdown',
  ]) {
    assert.match(template, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(template, /<details class="mobile-live-position-section" open>/);
  assert.match(template, /<details class="mobile-live-position-section mobile-live-bench-section">/);
  assert.doesNotMatch(
    template,
    /<details class="mobile-live-position-section mobile-live-bench-section" open>/,
  );
  assert.match(source, /groupMobileMatchupPositions/);
  assert.match(source, /getMobileGameMarkerExplanation/);
  assert.match(source, /openBenchDetail\([\s\S]*ownerId:\s*string \| null/);
  assert.match(styles, /@media \(max-width:\s*780px\)/);
  assert.match(styles, /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(styles, /max-height:\s*min\(90dvh/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.ok(Buffer.byteLength(styles) < 45_000, 'Mobile Game Center component CSS exceeds 45 kB raw.');
});

test('M3-M4 changes do not alter scoring, Projection V11, Firestore rules, indexes, or Cloud Functions', async () => {
  const expectedHashes = new Map([
    ['src/app/core/scoring/scoring-rules.ts', 'd0ba8838c17737b00cdc5f0dea5e24ffb4e1af2154c2575baf28c3aa83de4901'],
    ['src/app/core/scoring/scoring-engine.ts', 'f9cdb69372437c4cf4e70e678d98227d8777ccc13d37b7ef000ac71ba36d4e15'],
    ['src/app/core/projection/projection-v11.util.ts', 'e6f3111b1feccc7107e857aa24c5317451c65a84a36c71f8158947636f20d80a'],
    ['src/app/core/draft/draft-player-pool.service.ts', 'b5ddafa0e2898550c9ac69ab3a491477b362633278213e63f2aab29fcad4c6fe'],
    ['functions/src/shared/core/scoring/scoring-rules.ts', 'd0ba8838c17737b00cdc5f0dea5e24ffb4e1af2154c2575baf28c3aa83de4901'],
    ['functions/src/shared/core/scoring/scoring-engine.ts', 'f9cdb69372437c4cf4e70e678d98227d8777ccc13d37b7ef000ac71ba36d4e15'],
    ['functions/src/shared/core/projection/projection-v11.util.ts', 'e6f3111b1feccc7107e857aa24c5317451c65a84a36c71f8158947636f20d80a'],
    ['functions/src/shared/core/draft/draft-player-pool.service.ts', 'b5ddafa0e2898550c9ac69ab3a491477b362633278213e63f2aab29fcad4c6fe'],
    ['firestore.rules', 'a37d7c47e9ffcb6a4549e5ad078a918b812619c014fcf01373025bacfa9c1a8c'],
    ['firestore.indexes.json', 'c18738f1fe9547da2c59fbcd6b3d725db8ea8ff1f190ca82cc0c1b27ebc0d8a0'],
  ]);

  for (const [file, expectedHash] of expectedHashes) {
    assert.equal(await sha256(file), expectedHash, `${file} changed unexpectedly.`);
  }

  assert.equal(
    await directoryFingerprint('functions/'),
    'b41d608a05e712fdcf977fe95aa28c89c8a3d139affc2706bb30fa7ac6f2bda7',
    'Cloud Functions source/package tree changed unexpectedly.',
  );
});

test('new files are present and non-empty', async () => {
  for (const file of [
    'src/app/core/guards/pending-draft-action.guard.ts',
    'src/app/features/draft/draft-room/draft-mobile-resilience.util.ts',
    'src/app/features/cycles/cycle-one/cycle-mobile-matchup.util.ts',
    'src/app/features/cycles/cycle-one/components/cycle-mobile-head-to-head/cycle-mobile-head-to-head.css',
  ]) {
    const info = await stat(new URL(file, ROOT));
    assert.ok(info.size > 100, `${file} is unexpectedly empty.`);
  }
});
