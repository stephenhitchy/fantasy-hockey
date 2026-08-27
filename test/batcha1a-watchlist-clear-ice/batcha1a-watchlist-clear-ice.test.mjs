import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import {
  PLAYER_WATCHLIST_MAX_COUNT,
  normalizePlayerWatchlist,
  normalizePlayerWatchlistAssetKey,
  updatePlayerWatchlist,
} from '../../functions/src/shared/core/user/player-watchlist.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

test('watchlist asset keys are bounded and canonical', () => {
  assert.equal(normalizePlayerWatchlistAssetKey(' skater-8478402 '), 'skater-8478402');
  assert.equal(normalizePlayerWatchlistAssetKey('goalie-unit-VGK'), 'goalie-unit-VGK');
  assert.equal(normalizePlayerWatchlistAssetKey('x'), null);
  assert.equal(normalizePlayerWatchlistAssetKey('bad/key'), null);
  assert.equal(normalizePlayerWatchlistAssetKey('bad key'), null);
  assert.equal(normalizePlayerWatchlistAssetKey('a'.repeat(161)), null);
});

test('watchlist normalization stays unique, ordered, and capped at 100 assets', () => {
  const input = [
    'skater-1',
    'skater-1',
    'bad/key',
    ...Array.from({ length: 110 }, (_, index) => `skater-${index + 2}`),
  ];
  const normalized = normalizePlayerWatchlist(input);

  assert.equal(normalized.length, PLAYER_WATCHLIST_MAX_COUNT);
  assert.equal(normalized[0], 'skater-1');
  assert.equal(new Set(normalized).size, normalized.length);
});

test('watchlist transitions add, remove, retry idempotently, and reject overflow', () => {
  const added = updatePlayerWatchlist(['skater-1'], 'skater-2', true);
  assert.deepEqual(added, {
    assetKeys: ['skater-2', 'skater-1'],
    changed: true,
  });

  assert.deepEqual(updatePlayerWatchlist(added?.assetKeys, 'skater-2', true), {
    assetKeys: ['skater-2', 'skater-1'],
    changed: false,
  });

  assert.deepEqual(updatePlayerWatchlist(added?.assetKeys, 'skater-1', false), {
    assetKeys: ['skater-2'],
    changed: true,
  });

  const full = Array.from({ length: PLAYER_WATCHLIST_MAX_COUNT }, (_, index) => `skater-${index + 1}`);
  assert.equal(updatePlayerWatchlist(full, 'skater-new', true), null);
});

test('the account-wide watchlist is server-owned and scoped only by authenticated manager identity', async () => {
  const [authority, index, client, deletion] = await Promise.all([
    read('functions/src/player-watchlist.ts'),
    read('functions/src/index.ts'),
    read('src/app/core/player/player-watchlist.service.ts'),
    read('functions/src/index.ts'),
  ]);

  assert.match(authority, /export const getPlayerWatchlist = onCall/);
  assert.match(authority, /export const setPlayerWatchlistEntry = onCall/);
  assert.match(authority, /requireAuthenticatedUserId\(request\.auth, actionLabel\)/);
  assert.match(authority, /requireVerifiedEmail\(request\.auth, actionLabel\)/);
  assert.match(authority, /managerWatchlists\/\$\{userId\}/);
  assert.doesNotMatch(authority, /ownerId\s*=\s*data\[/);
  assert.match(authority, /db\.runTransaction/);
  assert.match(index, /getPlayerWatchlist/);
  assert.match(index, /setPlayerWatchlistEntry/);
  assert.match(client, /httpsCallable/);
  assert.match(client, /getPlayerWatchlist/);
  assert.match(client, /setPlayerWatchlistEntry/);
  assert.doesNotMatch(client, /setDoc|deleteDoc|onSnapshot|collection\(/);
  assert.match(deletion, /managerWatchlists\/\$\{userId\}/);
  assert.match(deletion, /managerWatchlistSnapshot\.exists/);
});

test('the unified Add / Drop board exposes a compact watched filter and watch controls without another explanatory wall', async () => {
  const [component, template, styles] = await Promise.all([
    read('src/app/features/free-agents/free-agents.ts'),
    read('src/app/features/free-agents/free-agents.html'),
    read('src/app/features/free-agents/free-agents.css'),
  ]);

  assert.match(component, /void this\.loadWatchlist\(\)/);
  assert.match(component, /boardStatusFilter = signal<LeaguePlayerBoardStatusFilter>\('free-agent'\)/);
  assert.match(component, /setPlayerWatchlistEntry/);
  assert.match(component, /toggleAssetWatchlist/);
  assert.match(template, /value="watched">Watched/);
  assert.match(template, /Watching' : 'Watch'/);
  assert.match(template, /toggleAssetWatchlist\(row\.asset\)/);
  assert.doesNotMatch(template, /Only the most useful comparison numbers stay visible/);
  assert.match(styles, /unified-player-actions[\s\S]*?min-height:\s*var\(--rr-mobile-control-min-height\)/);
});

test('Draft Room watchlists remain independent from the private auto-draft queue', async () => {
  const [component, template, styles] = await Promise.all([
    read('src/app/features/draft/draft-room/draft-room.ts'),
    read('src/app/features/draft/draft-room/draft-room.html'),
    read('src/app/features/draft/draft-room/draft-room.css'),
  ]);

  assert.match(component, /void this\.loadWatchlist\(\)/);
  assert.match(component, /watchlistOnly = signal\(false\)/);
  assert.match(component, /toggleAssetWatchlist/);
  assert.match(component, /toggleAssetInQueue/);
  assert.match(template, /Watched \{\{ watchedAssetKeys\(\)\.size \}\}/);
  assert.match(template, /draft-watchlist-button/);
  assert.match(template, /\+ Queue/);
  assert.match(template, /Private list\. Auto-draft uses the first eligible queued player/);
  assert.doesNotMatch(template, /Two consecutive expired turns automatically switch auto-draft on until/);
  assert.match(styles, /draft-watchlist-filter,[\s\S]*?min-height:\s*44px/);
  assert.ok(Buffer.byteLength(styles, 'utf8') < 45_000);
});

test('Clear Ice removes repeated descriptions while retaining competitive and destructive guidance', async () => {
  const [dashboard, league, wire, freeAgents, draftSetup, team, account, audit] = await Promise.all([
    read('src/app/features/dashboard/dashboard.html'),
    read('src/app/features/leagues/league-detail/league-detail.html'),
    read('src/app/features/leagues/league-wire/league-wire.html'),
    read('src/app/features/free-agents/free-agents.html'),
    read('src/app/features/draft/draft-setup/draft-setup.html'),
    read('src/app/features/team/team-settings/team-settings.html'),
    read('src/app/features/account/account-settings/account-settings.html'),
    read('scripts/audit-product-copy-density.mjs'),
  ]);

  assert.doesNotMatch(dashboard, /Pick a league, manage your roster/);
  assert.doesNotMatch(league, /The top button follows the current phase/);
  assert.doesNotMatch(wire, /Commissioner announcements, Draft picks, commissioner controls/);
  assert.doesNotMatch(freeAgents, /Only the most useful comparison numbers/);
  assert.match(draftSetup, /Saving the draft order closes league entry/);
  assert.match(freeAgents, /exact six-game timeline/);
  assert.match(team, /Only players listed as Out, Injured Reserve, or Long-Term Injured Reserve/);
  assert.match(account, /cannot be undone/);
  assert.match(audit, /MAX_VISIBLE_TEXT_CHARACTERS = 42_000/);
  assert.match(audit, /const MANAGER_TEMPLATES = \[/);
});

test('A1A preserves scoring, Projection V11, Firestore Rules, indexes, and inactive safety controls', async () => {
  const [
    scoringRules,
    scoringEngine,
    projectionV11,
    firestoreRules,
    firestoreIndexes,
    freezeSource,
    appCheckSource,
    canarySource,
    cacheSource,
  ] = await Promise.all([
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/scoring/scoring-engine.ts'),
    read('src/app/core/projection/projection-v11.util.ts'),
    read('firestore.rules'),
    read('firestore.indexes.json'),
    read('config/release-freeze/beta-freeze-policy.json'),
    read('config/app-check-enforcement-readiness.json'),
    read('config/app-check-callable-canary.json'),
    read('config/nhl-shared-cache-policy.json'),
  ]);
  const freeze = JSON.parse(freezeSource);
  const appCheck = JSON.parse(appCheckSource);
  const canary = JSON.parse(canarySource);
  const cache = JSON.parse(cacheSource);

  assert.equal(createHash('sha256').update(scoringRules).digest('hex'), PROTECTED_SOURCE_HASHES.scoringRules);
  assert.equal(createHash('sha256').update(scoringEngine).digest('hex'), PROTECTED_SOURCE_HASHES.scoringEngine);
  assert.equal(createHash('sha256').update(projectionV11).digest('hex'), PROTECTED_SOURCE_HASHES.projectionV11);
  assert.equal(createHash('sha256').update(firestoreRules).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreRules);
  assert.equal(createHash('sha256').update(firestoreIndexes).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreIndexes);
  assert.equal(freeze.scoringRulesVersion, 4);
  assert.equal(freeze.projectionVersion, 11);
  assert.equal(freeze.requiredGamesPerRosterSlot, 6);
  assert.equal(freeze.queueMode, 'shadow');
  assert.equal(freeze.appCheckMode, 'monitor');
  assert.equal(appCheck.mode, 'monitor');
  assert.equal(canary.automaticPromotion, false);
  assert.equal(cache.mode, 'shadow');
  assert.equal(cache.authoritativeReadsEnabled, false);
});

test('A1A advances release operations to RC39 with one inherited verification gate', async () => {
  const [runtime, productionRuntime, freezeSource, packageSource, releaseScript] = await Promise.all([
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('config/release-freeze/beta-freeze-policy.json'),
    read('package.json'),
    read('scripts/release/invite-beta-release.mjs'),
  ]);
  const freeze = JSON.parse(freezeSource);
  const packageJson = JSON.parse(packageSource);

  assert.match(runtime, /Release Candidate 65/);
  assert.match(productionRuntime, /Release Candidate 65/);
  assert.equal(freeze.releaseLabel, 'Release Candidate 65');
  assert.equal(freeze.verificationCommand, 'npm run verify:batchb1j');
  assert.equal(freeze.defaultTag, 'rinkrat-rc65-invite-beta');
  assert.match(packageJson.scripts['verify:batcha1a:core'], /verify:batchc1l:core/);
  assert.match(packageJson.scripts['verify:batcha1a:core'], /audit:product-copy-density/);
  assert.match(packageJson.scripts['security:ci'], /verify:batch(?:b1j|d1j):core/);
  assert.match(releaseScript, /rinkrat-rc65-invite-beta/);
  assert.match((await read('functions/package.json')), /getPlayerWatchlist,setPlayerWatchlistEntry,deleteMyAccount/);
});

test('roadmap and documentation complete A1.5 and record the Clear Ice product pass', async () => {
  const [roadmap, docsRoadmap, docs, readme, releaseRunbook] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_PRODUCT_A1A_WATCHLIST_CLEAR_ICE.md'),
    read('README.md'),
    read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
  ]);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.54/);
  assert.match(roadmap, /# \[x\] A1\.5 Add watchlists independent of Draft queues/);
  assert.match(roadmap, /# \[x\] A1\.11/);
  assert.match(roadmap, /# \[x\] LOG\.48 2026-08-17/);
  assert.match(docs, /account-wide player watchlist/i);
  assert.match(docs, /Seventeen manager-facing templates/i);
  assert.match(docs, /Functions-first deployment/);
  assert.match(docs, /functions:getPlayerWatchlist,functions:setPlayerWatchlistEntry,functions:deleteMyAccount/);
  assert.match(readme, /Release Candidate 65 \/ Beta Batch B1J/);
  assert.match(readme, /RINKRAT_PRODUCT_A1A_WATCHLIST_CLEAR_ICE\.md/);
  assert.match(releaseRunbook, /npm run verify:batchb1j/);
  assert.match(releaseRunbook, /rinkrat-rc65-validation\.json/);
  assert.match(releaseRunbook, /rinkrat-rc65-invite-beta/);
});
