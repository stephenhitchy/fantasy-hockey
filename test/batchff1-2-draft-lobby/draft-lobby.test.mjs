import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DRAFT_LOBBY_WINDOW_MILLISECONDS,
  getDraftLobbyOpenDate,
  getDraftLobbyState,
} from '../../src/app/core/draft/draft-lobby.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

test('Draft lobby opens at the inclusive one-hour boundary and ends at scheduled start', () => {
  const scheduledStart = new Date('2026-10-06T02:00:00.000Z');
  const baseInput = {
    draftStatus: 'scheduled',
    scheduledStart,
  };

  assert.equal(DRAFT_LOBBY_WINDOW_MILLISECONDS, 3_600_000);
  assert.equal(getDraftLobbyState({
    ...baseInput,
    now: new Date(scheduledStart.getTime() - DRAFT_LOBBY_WINDOW_MILLISECONDS - 1),
  }), 'waiting');
  assert.equal(getDraftLobbyState({
    ...baseInput,
    now: new Date(scheduledStart.getTime() - DRAFT_LOBBY_WINDOW_MILLISECONDS),
  }), 'open');
  assert.equal(getDraftLobbyState({
    ...baseInput,
    now: new Date(scheduledStart.getTime() - 1),
  }), 'open');
  assert.equal(getDraftLobbyState({
    ...baseInput,
    now: new Date(scheduledStart),
  }), 'started');
  assert.equal(getDraftLobbyState({
    ...baseInput,
    now: new Date(scheduledStart.getTime() + 1),
  }), 'started');
  assert.equal(
    getDraftLobbyOpenDate(scheduledStart)?.toISOString(),
    '2026-10-06T01:00:00.000Z',
  );
});

test('Draft lobby fails closed for invalid schedules and non-scheduled phases', () => {
  const scheduledStart = new Date('2026-10-06T02:00:00.000Z');
  const now = new Date('2026-10-06T01:30:00.000Z');

  for (const draftStatus of [null, 'setup', 'live', 'complete']) {
    assert.equal(getDraftLobbyState({ draftStatus, scheduledStart, now }), 'unavailable');
  }

  assert.equal(getDraftLobbyState({
    draftStatus: 'scheduled',
    scheduledStart: null,
    now,
  }), 'unavailable');
  assert.equal(getDraftLobbyState({
    draftStatus: 'scheduled',
    scheduledStart: new Date('invalid'),
    now,
  }), 'unavailable');
  assert.equal(getDraftLobbyState({
    draftStatus: 'scheduled',
    scheduledStart,
    now: new Date('invalid'),
  }), 'unavailable');
  assert.equal(getDraftLobbyOpenDate(null), null);
  assert.equal(getDraftLobbyOpenDate(new Date('invalid')), null);
});

test('scheduled lobby exposes rankings, order, roster, and private queue without live controls', async () => {
  const [component, template, resilienceUtility] = await Promise.all([
    read('src/app/features/draft/draft-room/draft-room.ts'),
    read('src/app/features/draft/draft-room/draft-room.html'),
    read('src/app/features/draft/draft-room/draft-mobile-resilience.util.ts'),
  ]);

  assert.match(template, /draft\(\)\?\.status === 'scheduled'[\s\S]*?!isDraftLobbyOpen\(\)/);
  assert.match(template, /class="draft-lobby-banner[\s\S]*?Draft Lobby Open/);
  assert.match(template, /Queue-Only Preview/);
  assert.match(template, /id="draft-lobby-title"/);
  assert.doesNotMatch(
    template,
    /class="draft-lobby-start"[^>]*(?:role="status"|aria-live)/,
    'the one-second countdown must not become a repeating screen-reader live announcement',
  );
  assert.match(template, /class="draft-pick-track-card/);
  assert.match(template, /class="player-pool-panel/);
  assert.match(template, /class="sidebar-card queue-card/);
  assert.match(template, /class="sidebar-card roster-card/);
  assert.match(template, /Lobby · Queue Only/);

  const liveControls = template.match(
    /@if \(draft\(\)\?\.status === 'live'\) \{\s*@if \(shouldShowDraftHandoffNotice\(\)\)[\s\S]*?class="draft-mobile-command-bar"[\s\S]*?\n\s*\}\s*\n\s*<nav class="draft-mobile-tabs"/,
  );
  assert.ok(liveControls, 'live clock and command controls must remain inside a live-only block');
  assert.match(template, /@if \(draft\(\)\?\.status === 'live' && isMyTurn\(\)\)/);
  assert.match(
    template,
    /@if \(draft\(\)\?\.status === 'live' && isMyTurn\(\) \? selectedAsset\(\) : null/,
  );
  assert.match(component, /draft\.status !== 'live'/);
  assert.match(component, /draft\.clockStatus !== 'running'/);
  assert.match(component, /this\.isDraftLobbyOpen\(\) \? 'lobby' : 'live'/);
  assert.match(
    resilienceUtility,
    /private queue is live\. Picks and the draft clock remain locked until the scheduled start/,
  );
});

test('lobby queue writes remain bounded to the existing private queue path', async () => {
  const [component, draftService, rules] = await Promise.all([
    read('src/app/features/draft/draft-room/draft-room.ts'),
    read('src/app/core/draft/draft.service.ts'),
    read('firestore.rules'),
  ]);

  assert.match(component, /draft\?\.status === 'live' \|\| this\.isDraftLobbyOpen\(\)/);
  assert.match(component, /draft\?\.status !== 'live' \|\| this\.draftTurnHandoff\(\)\.status === 'healthy'/);
  assert.match(component, /private ensureRealtimeActionReady\(scope: 'board' \| 'queue'/);
  assert.match(component, /draftIsLive && this\.draftTurnHandoff\(\)\.status !== 'healthy'/);
  assert.match(component, /async toggleMyAutoDraft\(\)[\s\S]*?this\.draft\(\)\?\.status !== 'live'/);
  assert.match(component, /saveDraftQueue\(this\.leagueId, this\.userId, assetKeys/);
  assert.match(draftService, /export async function saveDraftQueue/);
  assert.match(rules, /match \/draft\/{draftId\}[\s\S]*?match \/queues\/{ownerId}/);
  assert.match(rules, /ownerId == currentUserId\(\)/);
  assert.match(rules, /data\.assetKeys\.size\(\) <= 100/);
  assert.match(rules, /data\.assetKeys\.toSet\(\)\.size\(\)[\s\S]*?data\.assetKeys\.size\(\)/);
});

test('League HQ sends every scheduled participant to the schedule or lobby, including commissioners', async () => {
  const [component, template] = await Promise.all([
    read('src/app/features/leagues/league-detail/league-detail.ts'),
    read('src/app/features/leagues/league-detail/league-detail.html'),
  ]);

  assert.match(component, /readonly isDraftLobbyOpen = computed/);
  assert.match(component, /return 'Draft Lobby Open'/);
  assert.match(component, /read-only Draft lobby opens one hour before/);
  assert.match(template, /@else if \(draft\(\)\?\.status === 'scheduled'\)/);
  assert.match(template, /isDraftLobbyOpen\(\) \? 'Enter Draft Lobby' : 'View Draft Schedule'/);
  assert.match(template, /\['\/leagues', leagueId, 'draft'\]/);
});

test('lobby presentation remains responsive, theme-token based, and adds no important overrides', async () => {
  const styles = await read('src/app/features/draft/draft-room/draft-room.css');
  const lobbyStyles = styles.slice(
    styles.indexOf('.draft-lobby-open-copy'),
    styles.indexOf('.complete-card'),
  );

  assert.match(lobbyStyles, /grid-template-columns: minmax\(0, 1\.35fr\) minmax\(220px, 0\.75fr\)/);
  assert.match(lobbyStyles, /var\(--surface-1\)/);
  assert.match(lobbyStyles, /var\(--surface-2\)/);
  assert.match(lobbyStyles, /var\(--text-primary\)/);
  assert.match(lobbyStyles, /var\(--text-secondary\)/);
  assert.match(lobbyStyles, /var\(--border-strong\)/);
  assert.doesNotMatch(lobbyStyles, /!important/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.draft-lobby-banner \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(styles, /\.turn-clock-summary\.lobby-countdown strong[\s\S]*?font-size: 15px/);
});

test('FF1.18 roadmap and release boundary documentation stay synchronized', async () => {
  const [rootRoadmap, docsRoadmap, implementationDoc] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_FF1_2_DRAFT_LOBBY.md'),
  ]);

  assert.equal(rootRoadmap, docsRoadmap);
  assert.match(rootRoadmap, /\[~\] FF1\.18/);
  assert.match(rootRoadmap, /\[~\] FF1\.19/);
  assert.match(implementationDoc, /hosting:app/);
  assert.match(implementationDoc, /No Functions, Rules, indexes, TTL, App Check, queue, or worker/);
  assert.match(implementationDoc, /Production Scoring V4/);
  assert.match(implementationDoc, /Projection V11/);
});
