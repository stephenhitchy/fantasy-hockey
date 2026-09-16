import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relativePath) => readFileSync(path.join(root, relativePath), 'utf8');

test('both real workers branch to the staging probe before normal competitive validation', () => {
  const scoring = read('functions/src/league-automation.ts');
  const draft = read('functions/src/draft-automation.ts');
  assert.ok(
    scoring.indexOf("processD1nLoadProbeIfPresent(payload, 'scoring')")
      < scoring.indexOf('const leagueId = resolveSafeFirestoreDocumentId', scoring.indexOf('export const processLeagueAutomationTask')),
  );
  assert.ok(
    draft.indexOf("processD1nLoadProbeIfPresent(payload, 'draft')")
      < draft.indexOf('const leagueId = resolveSafeFirestoreDocumentId', draft.indexOf('export const processDraftClockDeadline')),
  );
  assert.match(scoring, /maxConcurrentDispatches:\s*LEAGUE_AUTOMATION_QUEUE_MAX_CONCURRENT_DISPATCHES/);
  assert.match(scoring, /LEAGUE_AUTOMATION_QUEUE_MAX_CONCURRENT_DISPATCHES\s*=\s*4/);
  assert.match(draft, /maxConcurrentDispatches:\s*10/);
});

test('synthetic service writes are isolated and the runtime guard is exact', () => {
  const service = read('functions/src/d1n-load-probe.service.ts');
  const utility = read('functions/src/d1n-load-probe.util.ts');
  assert.match(utility, /D1NC_LOAD_STAGING_PROJECT_ID = 'rinkrat-staging-d1nc-2026'/);
  assert.match(utility, /disabled outside the isolated staging project/);
  assert.match(service, /resolveSafeFirestoreDocumentId\(\s*payload\.runId/);
  assert.match(service, /resolveSafeFirestoreDocumentId\(\s*payload\.operationId/);
  assert.match(service, /db\.doc\(`d1nLoadRuns\/\$\{runId\}`\)/);
  assert.doesNotMatch(service, /(?:collection|doc)\(['"`]leagues/);
  assert.doesNotMatch(service, /rosters|standings|playoffs|transactions|playerWindows/);
  assert.match(service, /transaction\.create\(resultRef/);
  assert.match(service, /duplicateDeliveryCount: FieldValue\.increment\(1\)/);
  assert.match(service, /if \(operationAuthorityValidated\)/);
  assert.match(service, /maxAttempts: 5/);
});

test('the generator refuses broad deployment and preserves external evidence requirements', () => {
  const harness = read('scripts/capacity/d1n-c-load-harness.mjs');
  const finalizer = read('scripts/capacity/finalize-d1n-c-load-evidence.mjs');
  assert.doesNotMatch(harness, /firebase\s+deploy|functions:delete|queues\s+update|queueMode\s*[:=]/);
  assert.doesNotMatch(harness, /nhl-fantasy-app-ab673/);
  assert.match(harness, /branch === 'main'/);
  assert.match(harness, /divergence === '0\/0'/);
  assert.match(harness, /FIRESTORE_EMULATOR_HOST/);
  assert.match(harness, /awaiting-external-usage-and-cost/);
  assert.match(harness, /D1N-C Cloud Billing export evidence path is required/);
  assert.doesNotMatch(harness, /requireCondition\(deviceEvidence && billingEvidence/);
  assert.match(harness, /'--experimental-strip-types'/);
  assert.match(harness, /serviceAccountId: taskServiceAccountId/);
  assert.match(harness, /serviceConfig\?\.serviceAccountEmail/);
  assert.match(harness, /physicalDeviceEvidenceStatus: deviceEvidence \? 'verified' : 'deferred'/);
  assert.match(
    read('scripts/capacity/d1n-c-load-preflight.mjs'),
    /verifyFf132DeployedFunctionSourceArchives\(staging\.exactFunctions, git\.commit\)/,
  );
  assert.match(finalizer, /cloud-monitoring/);
  assert.match(finalizer, /cloud-billing-export/);
  assert.match(finalizer, /ready-for-independent-review/);
});

test('the runbook defines acceptance, edge cases, tests, observability, exact resources, and rollback', () => {
  const runbook = read('docs/RINKRAT_SCALE_D1N_C_LOAD_HARNESS.md');
  for (const phrase of [
    'processLeagueAutomationTask',
    'processDraftClockDeadline',
    'legitimate zero',
    'Cloud Monitoring',
    'Cloud Billing export',
    'Stop immediately',
    'Cleanup and rollback',
    'No Production Function or Hosting deployment',
    'DRF-01–DRF-09',
    'LIFE-01–LIFE-08',
  ]) assert.match(runbook, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(runbook, /functions:processLeagueAutomationTask,functions:processDraftClockDeadline/);
  assert.doesNotMatch(runbook, /--only\s+functions\s*(?:\n|$)/);
});
