import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import { fileURLToPath } from 'node:url';

import { buildCapacityReport } from '../../scripts/capacity/rinkrat-capacity-model.mjs';

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

test('live league scoring receives a deterministic per-league Cloud Tasks foundation', async () => {
  const automation = await read('functions/src/league-automation.ts');

  assert.match(automation, /interface LeagueAutomationTaskPayload/);
  assert.match(automation, /function buildLeagueAutomationTaskId/);
  assert.match(automation, /payload\.expectedDueAtMilliseconds/);
  assert.match(automation, /getFunctions\(\)\.taskQueue<LeagueAutomationTaskPayload>[\s\S]*processLeagueAutomationTask/);
  assert.match(automation, /export const processLeagueAutomationTask = onTaskDispatched/);
  assert.match(automation, /maxConcurrentDispatches:\s*LEAGUE_AUTOMATION_QUEUE_MAX_CONCURRENT_DISPATCHES/);
  assert.match(automation, /retryConfig:[\s\S]*maxAttempts:\s*5[\s\S]*minBackoffSeconds:\s*30/);
  assert.match(automation, /id:\s*taskId/);
  assert.match(automation, /task-already-exists/);
});

test('queue dispatch is due-time based, bounded, and defaults to non-publishing shadow mode', async () => {
  const automation = await read('functions/src/league-automation.ts');

  assert.match(automation, /LEAGUE_AUTOMATION_QUEUE_DEFAULT_MODE = 'shadow'/);
  assert.match(automation, /export const dispatchDueLeagueAutomation = onSchedule/);
  assert.match(automation, /schedule:\s*'\* \* \* \* \*'/);
  assert.match(automation, /collection\('leagueAutomationSchedules'\)[\s\S]*where\('nextScoringAt', '<='/);
  assert.match(automation, /config\.mode === 'shadow'[\s\S]*\? \[\]/);
  assert.match(automation, /Math\.min\(config\.maxEnqueuePerRun, availablePendingSlots\)/);
  assert.match(automation, /LEAGUE_AUTOMATION_QUEUE_MAX_PENDING_TASKS/);
  assert.match(automation, /countActiveLeagueAutomationTasks/);
  assert.match(automation, /where\(\s*'activeTaskLeaseExpiresAt',\s*'>'/);
  assert.match(automation, /queueActivePendingTaskCount/);
  assert.match(automation, /queueSampleActivePendingTaskCount/);
  assert.match(automation, /getLeagueAutomationDispatchSchedules[\s\S]*config\.mode === 'canary'[\s\S]*db\.getAll/);
  assert.match(automation, /queueDueScheduleSampleCount/);
  assert.match(automation, /queueOldestDueAgeMilliseconds/);
});

test('per-league schedules are bootstrapped and updated after success, error, pause, and retry', async () => {
  const automation = await read('functions/src/league-automation.ts');

  assert.match(automation, /export const bootstrapLeagueAutomationSchedules = onSchedule/);
  assert.match(automation, /bootstrap-repair/);
  assert.match(automation, /queueScheduleCoverageRepairedCount/);
  assert.match(automation, /recordLeagueAutomationSuccess/);
  assert.match(automation, /recordLeagueAutomationFailure/);
  assert.match(automation, /recordLeagueAutomationPaused/);
  assert.match(automation, /nextScoringAt:\s*Timestamp\.fromMillis\(nextRefreshAtMilliseconds\)/);
  assert.match(automation, /consecutiveFailureCount:\s*FieldValue\.increment\(1\)/);
  assert.match(automation, /queueScheduleCoverageCount/);
  assert.match(automation, /shard:\s*getLeagueAutomationShard\(leagueId\)/);
});

test('at-least-once task delivery cannot double-publish a league run', async () => {
  const automation = await read('functions/src/league-automation.ts');

  assert.match(automation, /activeTaskId !== taskId/);
  assert.match(automation, /expectedDueAt !== Math\.trunc\(payload\.expectedDueAtMilliseconds\)/);
  assert.match(automation, /runLeagueAutomation\([\s\S]*payload\.leagueId,[\s\S]*payload\.reason === 'canary-manual' \|\|[\s\S]*Boolean\(payloadCanonicalSourceVersion\),[\s\S]*'queue-task'/);
  assert.match(automation, /claimLeagueAutomationLease/);
  assert.match(automation, /result\.skipReason === 'another-server-worker'/);
  assert.match(automation, /league-automation-lease-busy/);
  assert.match(automation, /lastQueueTaskId:\s*taskId/);
});

test('stale queue work is recovered and bounded task history is cleaned up', async () => {
  const automation = await read('functions/src/league-automation.ts');

  assert.match(automation, /export const recoverStaleLeagueAutomationQueue = onSchedule/);
  assert.match(automation, /activeTaskLeaseExpiresAt/);
  assert.match(automation, /stale-task-recovered/);
  assert.match(automation, /nextScoringAt:\s*Timestamp\.fromMillis\(now\)/);
  assert.match(automation, /export const cleanupLeagueAutomationTaskHistory = onSchedule/);
  assert.match(automation, /LEAGUE_AUTOMATION_TASK_HISTORY_RETENTION_MILLISECONDS/);
  assert.match(automation, /collection\('leagueAutomationTasks'\)[\s\S]*where\('expiresAt', '<='/);
});

test('legacy scoring remains primary in shadow mode and becomes recovery-only after an intentional cutover', async () => {
  const automation = await read('functions/src/league-automation.ts');

  assert.match(automation, /async function getLegacySweepLeagueIds/);
  assert.match(automation, /config\.mode === 'primary'/);
  assert.match(automation, /LEAGUE_AUTOMATION_RECOVERY_STALE_MILLISECONDS/);
  assert.match(automation, /config\.mode !== 'canary'/);
  assert.match(automation, /primary-except-canary/);
  assert.match(automation, /stale-league-recovery/);
  assert.match(automation, /primary-shadow-baseline/);
});

test('Release Readiness reports queue mode, coverage, backlog age, and recovery state', async () => {
  const readiness = await read('src/app/core/release/release-readiness.service.ts');

  assert.match(readiness, /league-scoring-queue-foundation/);
  assert.match(readiness, /Queued league scoring foundation is observing only/);
  assert.match(readiness, /queueScheduleCoverageCount/);
  assert.match(readiness, /queueOldestDueAgeMilliseconds/);
  assert.match(readiness, /queueSelectedForEnqueueCount/);
  assert.match(readiness, /queueActivePendingTaskCount/);
  assert.match(readiness, /queueFailedEnqueueCount/);
  assert.match(readiness, /queueLastRecoveryCount/);
  assert.match(readiness, /requiredForLiveLaunch[\s\S]*/);
});

test('the capacity model recognizes the foundation but keeps large-scale cutover red', async () => {
  const report = await buildCapacityReport({
    users: 100_000,
    managersPerLeague: 10,
    scenario: 'balanced',
    format: 'json',
  });

  assert.equal(report.architecture.leagueAutomationTaskQueuePresent, true);
  assert.equal(report.architecture.leagueAutomationDispatcherPresent, true);
  assert.equal(report.architecture.leagueAutomationTaskDeterministicIds, true);
  assert.equal(report.architecture.leagueAutomationTaskMaxPendingTasks, 24);
  assert.equal(report.architecture.leagueAutomationQueueDefaultMode, 'shadow');
  assert.ok(report.findings.some((finding) =>
    finding.area === 'League Scoring Queue Foundation' && finding.severity === 'amber'
  ));
  assert.ok(report.findings.some((finding) =>
    finding.area === 'League Scoring Queue Cutover' && finding.severity === 'red'
  ));
});

test('P1E scripts, exports, documentation, and safe deployment order are recorded', async () => {
  const [packageSource, indexSource, documentation, blueprint, readme, runtime, productionRuntime] = await Promise.all([
    read('package.json'),
    read('functions/src/index.ts'),
    read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
    read('docs/RINKRAT_HIGH_SCALE_AUTOMATION_BLUEPRINT.md'),
    read('README.md'),
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.match(packageJson.scripts['test:batchp1e:run'], /batchp1e-league-automation-queue/);
  assert.match(packageJson.scripts['verify:batchp1e'], /verify:batchr1e/);
  assert.match(indexSource, /bootstrapLeagueAutomationSchedules/);
  assert.match(indexSource, /dispatchDueLeagueAutomation/);
  assert.match(indexSource, /processLeagueAutomationTask/);
  assert.match(indexSource, /recoverStaleLeagueAutomationQueue/);
  assert.match(indexSource, /cleanupLeagueAutomationTaskHistory/);
  assert.match(documentation, /^## Batch P1E — Live League Scoring Queue Foundation/m);
  assert.match(documentation, /shadow mode/);
  assert.match(documentation, /Functions first/);
  assert.match(blueprint, /P1E foundation implemented/);
  assert.match(readme, /verify:batchp1(?:e|f)/);
  assert.match(runtime, /^.*Release Candidate \d+.*$/m);
  assert.match(productionRuntime, /^.*Release Candidate \d+.*$/m);
});

test('competitive scoring, Projection V11, Firestore rules, and indexes remain unchanged', async () => {
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
