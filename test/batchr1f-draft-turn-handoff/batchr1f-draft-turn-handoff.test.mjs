import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import { fileURLToPath } from 'node:url';

import {
  assessDraftTurnHandoff,
  getDraftOwnerAtOverall,
  getLastContiguousDraftPick,
} from '../../src/app/features/draft/draft-room/draft-turn-handoff.util.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');

async function read(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

async function sha256(relativePath) {
  return createHash('sha256')
    .update(await readFile(path.join(root, relativePath)))
    .digest('hex');
}

function draft(overrides = {}) {
  return {
    schemaVersion: 3,
    status: 'live',
    format: 'snake',
    totalRounds: 2,
    rosterRequirements: { LW: 1, C: 1, RW: 1, D: 1, G: 1 },
    benchSlots: 1,
    roundOneOrder: ['owner-a', 'owner-b', 'owner-c'],
    nextOverallPick: 1,
    draftedAssetKeys: [],
    scheduledStartAt: null,
    pickSeconds: 60,
    clockStatus: 'running',
    pickStartedAt: new Date('2026-09-20T19:00:00.000Z'),
    currentPickSeconds: 60,
    pausedRemainingSeconds: null,
    ...overrides,
  };
}

function pick(overallPick) {
  return { overallPick };
}

test('contiguous committed picks advance only to the first real gap', () => {
  assert.equal(getLastContiguousDraftPick([pick(1), pick(2), pick(3)], 6), 3);
  assert.equal(getLastContiguousDraftPick([pick(1), pick(3), pick(4)], 6), 1);
  assert.equal(getLastContiguousDraftPick([pick(2), pick(3)], 6), 0);
});

test('snake ownership resolves the exact next manager across round boundaries', () => {
  const value = draft();

  assert.equal(getDraftOwnerAtOverall(value, 1), 'owner-a');
  assert.equal(getDraftOwnerAtOverall(value, 3), 'owner-c');
  assert.equal(getDraftOwnerAtOverall(value, 4), 'owner-c');
  assert.equal(getDraftOwnerAtOverall(value, 6), 'owner-a');
  assert.equal(getDraftOwnerAtOverall(value, 7), null);
});

test('a committed queue pick visible before the draft document is classified as picks-ahead', () => {
  const assessment = assessDraftTurnHandoff(
    draft({ nextOverallPick: 1 }),
    [pick(1)],
    ['owner-a', 'owner-b', 'owner-c'],
  );

  assert.equal(assessment.status, 'picks-ahead');
  assert.equal(assessment.expectedNextOverallPick, 2);
  assert.equal(assessment.currentOwnerId, 'owner-b');
  assert.equal(assessment.requiresServerRepair, true);
  assert.match(assessment.message, /Pick #1 is saved/);
});

test('a missing next clock is detected without treating the first commissioner start as broken', () => {
  const firstPickWaiting = assessDraftTurnHandoff(
    draft({ nextOverallPick: 1, clockStatus: 'stopped', pickStartedAt: null }),
    [],
    ['owner-a', 'owner-b', 'owner-c'],
  );
  assert.equal(firstPickWaiting.status, 'healthy');

  const nextPickStopped = assessDraftTurnHandoff(
    draft({ nextOverallPick: 2, clockStatus: 'stopped', pickStartedAt: null }),
    [pick(1)],
    ['owner-a', 'owner-b', 'owner-c'],
  );
  assert.equal(nextPickStopped.status, 'clock-missing');
  assert.equal(nextPickStopped.requiresServerRepair, true);
});

test('a draft document ahead of the ordered query waits for picks instead of rolling the server backward', () => {
  const assessment = assessDraftTurnHandoff(
    draft({ nextOverallPick: 3 }),
    [pick(1)],
    ['owner-a', 'owner-b', 'owner-c'],
  );

  assert.equal(assessment.status, 'draft-ahead');
  assert.equal(assessment.requiresServerRepair, false);
  assert.match(assessment.message, /pick list finished refreshing/);
});

test('server authority repairs committed-pick handoff and independently guarantees the next deadline task', async () => {
  const [automation, authority, indexSource] = await Promise.all([
    read('functions/src/draft-automation.ts'),
    read('functions/src/draft-authority.ts'),
    read('functions/src/index.ts'),
  ]);

  assert.match(automation, /export async function repairDraftTurnFromCommittedPicks/);
  assert.match(automation, /expectedNextOverallPick = draft\.nextOverallPick/);
  assert.match(automation, /Draft pick \$\{pickId\} is malformed/);
  assert.match(automation, /status: draftComplete \? 'complete' : 'live'/);
  assert.match(automation, /pickStartedAt: draftComplete[\s\S]*FieldValue\.serverTimestamp|const timestamp = FieldValue\.serverTimestamp/);
  assert.match(automation, /export async function ensureCurrentDraftClockTask/);
  assert.match(automation, /export const reconcileDraftTurnAfterCommittedPick = onDocumentWritten/);
  assert.match(automation, /document: 'leagues\/\{leagueId\}\/draft\/current\/picks\/\{pickId\}'/);
  assert.match(automation, /retry: true/);
  assert.match(automation, /await ensureCurrentDraftClockTask\(leagueId\)/);

  assert.match(authority, /export const repairDraftTurnHandoff = onCall/);
  assert.match(authority, /You must be an active league member/);
  assert.match(authority, /repairDraftTurnFromCommittedPicks/);
  assert.match(indexSource, /repairDraftTurnHandoff/);
  assert.match(indexSource, /reconcileDraftTurnAfterCommittedPick/);
});

test('Draft Room repairs a delayed handoff and does not let a private queue listener freeze manual picks', async () => {
  const [room, template, styles, globalStyles, clientAuthority] = await Promise.all([
    read('src/app/features/draft/draft-room/draft-room.ts'),
    read('src/app/features/draft/draft-room/draft-room.html'),
    read('src/app/features/draft/draft-room/draft-room.css'),
    read('src/styles.css'),
    read('src/app/core/draft/draft-authority.service.ts'),
  ]);

  assert.match(room, /draftBoardConnectionState = computed/);
  assert.match(room, /criticalServerSyncTimes: \[[\s\S]*draftServerSyncAt\(\)[\s\S]*picksServerSyncAt\(\)[\s\S]*\]/);
  assert.match(room, /canUseDraftBoardActions/);
  assert.match(room, /canUseDraftQueueActions/);
  assert.match(room, /slow private queue[\s\S]*cannot freeze the next manager's turn/i);
  assert.match(room, /scheduleDraftTurnHandoffCheck/);
  assert.match(room, /reconcileDraftTurnHandoff/);
  assert.match(room, /getFantasyDraftFromServer\(this\.leagueId\)/);
  assert.match(room, /repairDraftTurnHandoff\(this\.leagueId\)/);
  assert.match(room, /Opening Next Pick/);

  assert.match(template, /draft-turn-handoff-notice/);
  assert.match(template, /Retry Turn Sync/);
  assert.match(template, /canUseDraftQueueActions\(\)/);
  assert.ok(Buffer.byteLength(styles) < 48_000, 'Draft Room component CSS remains below the 48 kB raw safety ceiling.');
  assert.match(globalStyles, /Batch R1F/);
  assert.match(globalStyles, /draft-turn-handoff-progress/);
  assert.match(clientAuthority, /'repairDraftTurnHandoff'[\s\S]*timeout:\s*30_000/);
});

test('R1F scripts remain installed while the current release preserves competitive scoring and projections', async () => {
  const [packageSource, runtime, productionRuntime, documentation, readme] = await Promise.all([
    read('package.json'),
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
    read('README.md'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.match(packageJson.scripts['test:batchr1f:run'], /batchr1f-draft-turn-handoff/);
  assert.match(packageJson.scripts['verify:batchr1f'], /verify:batchp1f-1/);
  assert.match(runtime, /^.*Release Candidate \d+.*$/m);
  assert.match(productionRuntime, /^.*Release Candidate \d+.*$/m);
  assert.match(documentation, /^## Batch R1F — Draft Queue Turn Handoff Recovery/m);
  assert.match(readme, /verify:batchr1f/);

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
    await sha256('firestore.rules'),
    PROTECTED_SOURCE_HASHES.firestoreRules,
  );
  assert.equal(
    await sha256('firestore.indexes.json'),
    '62f09a69e4e487eb9bfa1935e874d32a07e8fa0cddba48205903d62e19261a13',
  );
});
