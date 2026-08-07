import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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

test('Release Readiness contains an inline platform-admin scoring queue control center', async () => {
  const [readinessTs, readinessHtml, componentTs, componentHtml, componentCss] = await Promise.all([
    read('src/app/features/release/release-readiness/release-readiness.ts'),
    read('src/app/features/release/release-readiness/release-readiness.html'),
    read('src/app/features/release/scoring-queue-control-center/scoring-queue-control-center.ts'),
    read('src/app/features/release/scoring-queue-control-center/scoring-queue-control-center.html'),
    read('src/app/features/release/scoring-queue-control-center/scoring-queue-control-center.css'),
  ]);

  assert.match(readinessTs, /import \{ ScoringQueueControlCenter \}/);
  assert.match(readinessTs, /imports:[^\]]*ScoringQueueControlCenter/);
  assert.match(readinessHtml, /<app-scoring-queue-control-center \[currentLeagueId\]="leagueId" \/>/);
  assert.match(componentTs, /selector: 'app-scoring-queue-control-center'/);
  assert.match(componentHtml, /Scoring Queue Control Center/);
  assert.match(componentHtml, /Choose safe test leagues/);
  assert.match(componentHtml, /Route Through Canary/);
  assert.match(componentHtml, /Internal Test/);
  assert.match(componentHtml, /Copy Current Rollback/);
  assert.match(componentHtml, /Run Canary Now/);
  assert.doesNotMatch(componentHtml, /app-action-sheet|modal-backdrop|dialog-backdrop/);
  assert.doesNotMatch(componentCss, /position:\s*fixed/);
});

test('server queue controls are platform-admin-only, revisioned, idempotent, and audited', async () => {
  const [automation, indexSource] = await Promise.all([
    read('functions/src/league-automation.ts'),
    read('functions/src/index.ts'),
  ]);

  for (const callable of [
    'getLeagueAutomationQueueControlCenter',
    'updateLeagueAutomationQueueConfig',
    'queueLeagueAutomationCanaryCheck',
  ]) {
    assert.match(automation, new RegExp(`export const ${callable} = onCall`));
    assert.match(indexSource, new RegExp(callable));
  }

  assert.match(automation, /requireLeagueAutomationPlatformAdmin/);
  assert.match(automation, /leagueAutomationConfigAudit\/\$\{auditId\}/);
  assert.match(automation, /expectedRevision/);
  assert.match(automation, /before\.revision !== expectedRevision/);
  assert.match(automation, /lastMutationId:\s*requestId/);
  assert.match(automation, /This exact queue configuration request was already applied/);
  assert.match(automation, /configuration changed in another tab/);
});

test('canary selection validates exact live leagues and a manual run uses the Primary worker safely', async () => {
  const automation = await read('functions/src/league-automation.ts');

  assert.match(automation, /LEAGUE_AUTOMATION_CANARY_CONFIRMATION = 'ENABLE CANARY'/);
  assert.match(automation, /draftStatus !== 'complete'/);
  assert.match(automation, /Historical replay leagues use the separate serialized replay queue/);
  assert.match(automation, /server-owned scoring schedule has not been bootstrapped/);
  assert.match(automation, /config\.mode !== 'canary' \|\| !config\.canaryLeagueIds\.includes\(leagueId\)/);
  assert.match(automation, /confirmationText !== 'RUN CANARY'/);
  assert.match(automation, /reason: 'scheduled' \| 'recovery' \| 'canary-manual'/);
  assert.match(automation, /enqueueLeagueAutomationSchedule\([\s\S]*'canary-manual'/);
  assert.match(automation, /payload\.reason === 'canary-manual'/);
  assert.match(automation, /runLeagueAutomation\([\s\S]*payload\.leagueId,[\s\S]*payload\.reason === 'canary-manual',[\s\S]*'queue-task'/);
});

test('Primary promotion is gated, cannot jump from Shadow, and requires a separate production approval', async () => {
  const automation = await read('functions/src/league-automation.ts');

  assert.match(automation, /Promote from canary mode only\. Shadow cannot jump directly to primary/);
  assert.match(automation, /canary-mode-proven/);
  assert.match(automation, /queue-task-success/);
  assert.match(automation, /successfulTasksSinceCanary/);
  assert.match(automation, /canarySuccessBaseline/);
  assert.match(automation, /enteringOrChangingCanary/);
  assert.match(automation, /schedule-coverage/);
  assert.match(automation, /dispatcher-fresh/);
  assert.match(automation, /no-enqueue-failures/);
  assert.match(automation, /no-stale-recovery/);
  assert.match(automation, /queue-idle-for-cutover/);
  assert.match(automation, /known-environment/);
  assert.match(automation, /appData\/leagueAutomationPrimaryApproval/);
  assert.match(automation, /ENABLE PRIMARY IN STAGING/);
  assert.match(automation, /ENABLE PRIMARY IN PRODUCTION/);
  assert.match(automation, /transactionGates = buildLeagueAutomationPromotionGates/);
  assert.match(automation, /failedTransactionGates/);
});

test('Return to Shadow remains possible even when an old canary is no longer eligible', async () => {
  const [automation, componentTs, componentHtml] = await Promise.all([
    read('functions/src/league-automation.ts'),
    read('src/app/features/release/scoring-queue-control-center/scoring-queue-control-center.ts'),
    read('src/app/features/release/scoring-queue-control-center/scoring-queue-control-center.html'),
  ]);

  assert.match(automation, /if \(mode !== 'shadow'\) \{[\s\S]*validateLeagueAutomationAdminLeagueIds\(canaryLeagueIds, true\)/);
  assert.match(componentTs, /shadowRollbackArmed/);
  assert.match(componentTs, /Safe rollback to shadow mode/);
  assert.match(componentTs, /canaryLeagueIds: normalizeIds\(snapshot\.canaryLeagueIds\)/);
  assert.match(componentTs, /maxEnqueuePerRun: snapshot\.maxEnqueuePerRun/);
  assert.match(componentHtml, /Confirm Return to Shadow/);
  assert.match(componentHtml, /Return to Shadow/);
});

test('the client uses bounded callables and exposes exact league, health, audit, and rollout state', async () => {
  const [service, componentTs, componentHtml] = await Promise.all([
    read('src/app/core/admin/scoring-queue-control.service.ts'),
    read('src/app/features/release/scoring-queue-control-center/scoring-queue-control-center.ts'),
    read('src/app/features/release/scoring-queue-control-center/scoring-queue-control-center.html'),
  ]);

  assert.match(service, /getLeagueAutomationQueueControlCenter[\s\S]*timeout: 65_000/);
  assert.match(service, /updateLeagueAutomationQueueConfig[\s\S]*timeout: 65_000/);
  assert.match(service, /queueLeagueAutomationCanaryCheck[\s\S]*timeout: 65_000/);
  assert.match(service, /revision: number/);
  assert.match(service, /promotionGates/);
  assert.match(service, /audit:/);
  assert.match(componentTs, /filteredLeagues = computed/);
  assert.match(componentTs, /selectedInternalTestLeagueIds/);
  assert.match(componentTs, /requiredConfirmationPhrase/);
  assert.match(componentHtml, /Primary promotion gates/);
  assert.match(componentHtml, /Current canary proof/);
  assert.match(componentHtml, /Exact league routing/);
  assert.match(componentHtml, /Recent scoring-queue changes/);
});

test('configured and focus leagues remain visible even beyond the newest 200 results', async () => {
  const automation = await read('functions/src/league-automation.ts');

  assert.match(automation, /LEAGUE_AUTOMATION_ADMIN_LEAGUE_LIMIT = 200/);
  assert.match(automation, /explicitlyManagedLeagueIds/);
  assert.match(automation, /\.\.\.config\.canaryLeagueIds/);
  assert.match(automation, /\.\.\.config\.internalTestLeagueIds/);
  assert.match(automation, /missingManagedLeagueRefs/);
  assert.match(automation, /db\.getAll\(\.\.\.missingManagedLeagueRefs\)/);
});

test('P1F scripts, current release label, runbook, and deployment order are documented', async () => {
  const [packageSource, runtime, productionRuntime, documentation, blueprint, capacity, runbook, readme, functionsPackage] = await Promise.all([
    read('package.json'),
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
    read('docs/RINKRAT_HIGH_SCALE_AUTOMATION_BLUEPRINT.md'),
    read('docs/RINKRAT_100K_CAPACITY_PLAN.md'),
    read('docs/RINKRAT_SCORING_QUEUE_ROLLOUT_RUNBOOK.md'),
    read('README.md'),
    read('functions/package.json'),
  ]);
  const packageJson = JSON.parse(packageSource);
  const functionsJson = JSON.parse(functionsPackage);

  assert.match(packageJson.scripts['test:batchp1f:run'], /batchp1f-scoring-queue-control-center/);
  assert.match(packageJson.scripts['verify:batchp1f'], /verify:batchp1e/);
  assert.match(runtime, /^.*Release Candidate \d+.*$/m);
  assert.match(productionRuntime, /^.*Release Candidate \d+.*$/m);
  assert.match(documentation, /^## Batch P1F — Scoring Queue Control Center and Safe Canary Rollout/m);
  assert.match(blueprint, /Batch P1F control and rollout layer implemented/);
  assert.match(capacity, /P1F rollout-control update/);
  assert.match(runbook, /Production mode: Shadow/);
  assert.match(runbook, /ENABLE CANARY/);
  assert.match(runbook, /ENABLE PRIMARY IN STAGING/);
  assert.match(runbook, /ENABLE PRIMARY IN PRODUCTION/);
  assert.match(runbook, /Functions first|Deploy the server controls/);
  assert.match(readme, /RINKRAT_SCORING_QUEUE_ROLLOUT_RUNBOOK/);
  assert.match(readme, /verify:batchp1f/);
  assert.match(functionsJson.scripts.logs, /updateLeagueAutomationQueueConfig/);
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
    '3ad3e9c6601f8af35c4225eb2682a22d9fee6708317fb5dd68834a27bf1cd299',
  );
  assert.equal(
    await sha256('firestore.indexes.json'),
    'c18738f1fe9547da2c59fbcd6b3d725db8ea8ff1f190ca82cc0c1b27ebc0d8a0',
  );
});
