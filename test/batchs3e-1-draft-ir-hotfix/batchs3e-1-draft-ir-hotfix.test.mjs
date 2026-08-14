import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../../', import.meta.url);
async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

test('Draft scheduling queues verified Projection V11 preparation instead of awaiting the full ranking job', async () => {
  const [setup, projectionService, draftService] = await Promise.all([
    read('src/app/features/draft/draft-setup/draft-setup.ts'),
    read('src/app/core/projection/projection-snapshot.service.ts'),
    read('src/app/core/draft/draft.service.ts'),
  ]);

  assert.match(setup, /queueSharedProjectionSnapshotGeneration/);
  assert.match(setup, /createSharedProjectionGenerationRequestId/);
  assert.match(setup, /settleOperationWithin\([\s\S]*queueSharedProjectionSnapshotGeneration[\s\S]*12_000/);
  assert.doesNotMatch(setup, /generateSharedProjectionSnapshot\(/);
  assert.match(setup, /projectionPreparationRequestId/);
  assert.match(setup, /The verified Projection V\$\{SHARED_PROJECTION_VERSION\} board is building in the background/);
  assert.match(projectionService, /export async function queueSharedProjectionSnapshotGeneration/);
  assert.match(draftService, /projectionPreparationRequestId/);
  assert.match(draftService, /benchSlotId,\s*\n\s*\}\);/);
});

test('Draft authority validates a ready pointer or matching queued request without loading every projection asset', async () => {
  const source = await read('functions/src/draft-authority.ts');

  assert.match(source, /resolveDraftProjectionPreparation/);
  assert.match(source, /projectionGenerationRequests\/\$\{requestId\}/);
  assert.match(source, /projectionPreparationStatus:\s*projectionPreparation\.status/);
  assert.match(source, /serverAutomationStatus:[\s\S]*waiting-projection/);
  assert.doesNotMatch(source, /loadSharedProjectionSnapshot\(/);
  assert.match(source, /League entry is now closed/);
});

test('Scheduled Draft automation waits safely for Projection V11 and never opens on an unverified board', async () => {
  const source = await read('functions/src/draft-automation.ts');

  assert.match(source, /if \(!projection\) \{/);
  assert.match(source, /serverAutomationStatus:\s*preparationFailed \? 'error' : 'waiting-projection'/);
  assert.match(source, /The scheduled start time arrived while Projection V\$\{SHARED_PROJECTION_VERSION\} was still building/);
  assert.match(source, /projectionPreparationStatus:\s*'ready'/);
  assert.match(source, /return false;/);
});

test('IR activation UI preserves the displaced starter and requires an explicit bench drop only when needed', async () => {
  const [component, template, css] = await Promise.all([
    read('src/app/features/team/team-settings/team-settings.ts'),
    read('src/app/features/team/team-settings/team-settings.html'),
    read('src/app/features/team/team-settings/team-settings.css'),
  ]);

  assert.match(component, /irActivationBenchSlotId = signal\(''\)/);
  assert.match(component, /getIrActivationBenchTargets/);
  assert.match(component, /chooseDefaultIrActivationBenchSlot/);
  assert.match(component, /if \(targetSlot\.asset && !benchSlot\)/);
  assert.match(component, /benchSlotId:\s*benchSlot\?\.slotId \?\? null/);
  assert.match(template, /Moves to Bench/);
  assert.match(template, /Where should \{\{ getRosterAssetName\(displacedStarter\) \}\} go\?/);
  assert.match(template, /Nobody Dropped/);
  assert.doesNotMatch(template, /the current player will be placed on waivers/i);
  assert.match(css, /\.ir-activation-bench-step/);
  assert.match(css, /\.ir-bench-move-label/);
});

test('Immediate IR activation moves the displaced active asset to the selected bench slot and waives only its prior occupant', async () => {
  const source = await read('functions/src/roster-moves.ts');

  assert.match(source, /preflightIrBenchSlotId/);
  assert.match(source, /Every usable bench spot is full\. Choose the bench player or goalie unit to place on waivers/);
  assert.match(source, /droppedAsset = selectedBenchSlot\.asset/);
  assert.match(source, /asset:\s*\{ \.\.\.outgoingAsset, rosterStatus: 'benched' \}/);
  assert.match(source, /benchSlotIdForTransaction = selectedBenchSlot\.slotId/);
  assert.match(source, /moveType === 'activate-ir-active'[\s\S]*\? outgoingAsset/);
  assert.match(source, /buildWaiverPayload\(droppedAsset, ownerId, context\.cycleNumber\)/);
});

test('Started-window IR activation uses the same bench-preservation contract on the secure authority path', async () => {
  const source = await read('functions/src/roster-authority.ts');

  assert.match(source, /preflightIrActiveAssetKey/);
  assert.match(source, /preflightIrBenchSlotId/);
  assert.match(source, /droppedAsset = benchSlot\.asset/);
  assert.match(source, /asset:\s*\{ \.\.\.displacedActiveAsset, rosterStatus: 'benched' \}/);
  assert.match(source, /movedAsset:\s*displacedActiveAsset \?\? null/);
  assert.match(source, /benchSlotId:\s*benchSlotIdForTransaction/);
  assert.match(source, /nobody was dropped/i);
});

test('S3E.1 stays monitor-only and preserves Scoring V3, Projection V11, Shadow, and RC28', async () => {
  const [configSource, functionsSource, readme, runtime, productionRuntime] = await Promise.all([
    read('config/app-check-enforcement-readiness.json'),
    read('functions/src/beta-operations.ts'),
    read('README.md'),
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
  ]);
  const config = JSON.parse(configSource);

  assert.equal(config.mode, 'monitor');
  assert.equal(config.automaticEnforcement, false);
  assert.doesNotMatch(functionsSource, /enforceAppCheck\s*:\s*true/);
  assert.match(readme, /Scoring V3/);
  assert.match(readme, /Projection V11/);
  assert.match(readme, /Shadow/);
  assert.match(runtime, /Release Candidate 28/);
  assert.match(productionRuntime, /Release Candidate 28/);
});

test('S3E.1 verification, runbook, and permanent roadmap stay synchronized', async () => {
  const [packageSource, roadmap, docsRoadmap, readme, runbook] = await Promise.all([
    read('package.json'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('README.md'),
    read('docs/RINKRAT_SECURITY_S3E_1_DRAFT_IR_HOTFIX.md'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.\d+(?:\.\d+)?/);
  assert.match(roadmap, /# \[x\] B1\.26/);
  assert.match(roadmap, /# \[x\] B1\.27/);
  assert.match(roadmap, /# \[x\] LOG\.23/);
  assert.match(packageJson.scripts['test:batchs3e-1:run'], /batchs3e-1-draft-ir-hotfix/);
  assert.match(packageJson.scripts['verify:batchs3e-1:core'], /verify:batchs3e:core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batch(?:s3e-1-1|s3f|d1a|d1a-1|d1b|d1c|c1a|c1b):core/);
  assert.match(readme, /Security Batch S3E\.1/);
  assert.match(runbook, /Draft scheduling/i);
  assert.match(runbook, /displaced starter/i);
});
