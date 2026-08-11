import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createHistoricalReplayAdvanceBaseline,
  evaluateHistoricalReplayAdvance,
} from '../../src/app/features/cycles/cycle-one/historical-replay-ui-state.util.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');

async function read(relativePath) {
  return fs.readFile(path.join(root, relativePath), 'utf8');
}

async function sha256(relativePath) {
  return createHash('sha256')
    .update(await fs.readFile(path.join(root, relativePath)))
    .digest('hex');
}

test('historical replay requests are admitted quickly and dispatched through one shared task queue', async () => {
  const [automation, client] = await Promise.all([
    read('functions/src/league-automation.ts'),
    read('src/app/core/replay/historical-replay.service.ts'),
  ]);

  assert.match(automation, /getFunctions\(\)\.taskQueue<HistoricalReplayAdvanceTaskPayload>\([\s\S]*processHistoricalReplayAdvance/);
  assert.match(automation, /export const advanceHistoricalReplayDay = onCall\([\s\S]*timeoutSeconds:\s*60/);
  assert.match(automation, /export const processHistoricalReplayAdvance = onTaskDispatched/);
  assert.match(automation, /export const recoverStaleHistoricalReplayQueue = onSchedule/);
  assert.match(automation, /maxConcurrentDispatches:\s*1/);
  assert.match(automation, /dispatchDeadlineSeconds:\s*HISTORICAL_REPLAY_TASK_DISPATCH_DEADLINE_SECONDS/);
  assert.match(client, /QueueHistoricalReplayResult/);
  assert.match(client, /timeout:\s*60_000/);
  assert.doesNotMatch(client, /timeout:\s*600_000/);
});

test('replay queue submissions are idempotent and exact to league, manager, and request', async () => {
  const automation = await read('functions/src/league-automation.ts');

  assert.match(automation, /normalizeHistoricalReplayRequestId/);
  assert.match(automation, /buildHistoricalReplayTaskId/);
  assert.match(automation, /historicalReplayRequests\/\$\{requestId\}/);
  assert.match(automation, /activeRequestId/);
  assert.match(automation, /task-already-exists/);
  assert.match(automation, /This league already has a replay day queued or processing/);
  assert.match(automation, /requestData\['leagueId'\] !== payload\.leagueId/);
  assert.match(automation, /requestData\['requestedBy'\] !== payload\.requestedBy/);
});

test('a failed simulated date remains the retry date after the request enters queued status', async () => {
  const automation = await read('functions/src/league-automation.ts');

  assert.match(automation, /function getReplayRequestRetryDate/);
  assert.match(automation, /retrySimulatedDate/);
  assert.match(automation, /retryFailedDate && previous\.simulatedDate[\s\S]*addUtcDays\(previous\.simulatedDate, -1\)/);
  assert.match(automation, /lastFailedSimulatedDate:\s*attemptedDate/);
  assert.match(automation, /The simulated date was not skipped/);
  assert.match(automation, /stale-queue-request/);
  assert.match(automation, /lastFailedSimulatedDate:\s*simulatedDate/);
});

test('queued replay state remains locked until Firestore reaches ready or error', () => {
  const baseline = createHistoricalReplayAdvanceBaseline({
    status: 'ready',
    daysAdvanced: 12,
    simulatedDate: '2026-10-20',
    lastError: '',
    message: 'Prior day ready.',
    lastReleasedGameCount: 4,
    totalReleasedGameCount: 28,
    updatedAt: 100,
  });

  const queued = evaluateHistoricalReplayAdvance(
    baseline,
    {
      status: 'queued',
      daysAdvanced: 12,
      simulatedDate: '2026-10-20',
      lastError: '',
      message: 'Queued safely.',
      lastReleasedGameCount: 4,
      totalReleasedGameCount: 28,
      updatedAt: 200,
    },
    false,
  );
  assert.deepEqual(queued, { state: 'pending', sawServerStart: true });

  const completed = evaluateHistoricalReplayAdvance(
    baseline,
    {
      status: 'ready',
      daysAdvanced: 13,
      simulatedDate: '2026-10-21',
      lastError: '',
      message: 'Processed.',
      lastReleasedGameCount: 6,
      totalReleasedGameCount: 34,
      updatedAt: 300,
    },
    queued.sawServerStart,
  );
  assert.deepEqual(completed, { state: 'ready', sawServerStart: true });
});

test('Game Center clearly explains queued multi-league replay behavior', async () => {
  const [component, template, service] = await Promise.all([
    read('src/app/features/cycles/cycle-one/cycle-one.ts'),
    read('src/app/features/cycles/cycle-one/cycle-one.html'),
    read('src/app/core/replay/historical-replay.service.ts'),
  ]);

  assert.match(service, /'inactive' \| 'queued' \| 'advancing' \| 'ready' \| 'error'/);
  assert.match(component, /Queued for Replay…/);
  assert.match(component, /Waiting for shared replay worker/);
  assert.match(component, /process historical replay leagues one at a time/);
  assert.match(template, /You may queue several test leagues/);
  assert.match(template, /cannot compete for shared scoring and NHL-data resources/);
});

test('roster decisions remain blocked while the league replay is queued', async () => {
  const [freeAgents, replayContext] = await Promise.all([
    read('src/app/features/free-agents/free-agents.ts'),
    read('src/app/core/transactions/roster-move-replay-context.util.ts'),
  ]);

  assert.match(freeAgents, /resolveRosterMoveReplayContext/);
  assert.match(replayContext, /control\.status === 'queued' \|\| control\.status === 'advancing'/);
  assert.match(replayContext, /Historical replay is queued for this league/);
});

test('invite beta validation includes simultaneous test-league queue coverage', async () => {
  const validation = await read('src/app/core/release/invite-beta-validation.util.ts');

  assert.match(validation, /id:\s*'multi-league-replay-queue'/);
  assert.match(validation, /two or three completed test leagues/);
  assert.match(validation, /shared worker handles them one at a time/);
  assert.match(validation, /required:\s*true/);
});

test('R1E scripts, documentation, and Functions-first deployment are recorded', async () => {
  const [packageSource, documentation, indexSource] = await Promise.all([
    read('package.json'),
    read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
    read('functions/src/index.ts'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.match(packageJson.scripts['test:batchr1e:run'], /batchr1e-multi-league-replay/);
  assert.match(packageJson.scripts['verify:batchr1e'], /verify:batchr1d/);
  assert.match(documentation, /^## Batch R1E — Multi-League Historical Replay Queue/m);
  assert.match(documentation, /functions:advanceHistoricalReplayDay,functions:processHistoricalReplayAdvance,functions:recoverStaleHistoricalReplayQueue/);
  assert.match(documentation, /Functions first/);
  assert.match(indexSource, /processHistoricalReplayAdvance/);
});

test('competitive scoring, Projection V11, Firestore rules, and indexes remain unchanged', async () => {
  assert.equal(
    await sha256('src/app/core/scoring/scoring-rules.ts'),
    'd0ba8838c17737b00cdc5f0dea5e24ffb4e1af2154c2575baf28c3aa83de4901',
  );
  assert.equal(
    await sha256('src/app/core/scoring/scoring-engine.ts'),
    'f9cdb69372437c4cf4e70e678d98227d8777ccc13d37b7ef000ac71ba36d4e15',
  );
  assert.equal(
    await sha256('src/app/core/projection/projection-v11.util.ts'),
    'e6f3111b1feccc7107e857aa24c5317451c65a84a36c71f8158947636f20d80a',
  );
  assert.equal(
    await sha256('firestore.rules'),
    '30feadadcd17e001c22e09b05d36f981847dc756131cdc776246f1617090878a',
  );
  assert.equal(
    await sha256('firestore.indexes.json'),
    'c18738f1fe9547da2c59fbcd6b3d725db8ea8ff1f190ca82cc0c1b27ebc0d8a0',
  );
});
