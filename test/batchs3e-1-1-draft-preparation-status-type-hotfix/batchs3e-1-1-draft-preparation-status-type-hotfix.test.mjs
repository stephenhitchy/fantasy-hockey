import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../../', import.meta.url);
async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

test('scheduled Draft projection preparation narrows persisted statuses without reintroducing optional undefined', async () => {
  const source = await read('functions/src/draft-automation.ts');

  assert.match(
    source,
    /type DraftProjectionPreparationStatus = Exclude<[\s\S]*FantasyDraft\['projectionPreparationStatus'\],[\s\S]*null \| undefined[\s\S]*>;/,
  );
  assert.match(source, /function isDraftProjectionPreparationStatus\(/);
  assert.match(source, /value is DraftProjectionPreparationStatus/);
  assert.match(source, /let preparationStatus: DraftProjectionPreparationStatus \| null/);
  assert.match(source, /isDraftProjectionPreparationStatus\(observedStatus\)/);
  assert.match(source, /preparationStatus = observedStatus;/);
  assert.doesNotMatch(
    source,
    /observedStatus as FantasyDraft\['projectionPreparationStatus'\]/,
  );
});

test('the type hotfix keeps all four server preparation states and the safe null fallback', async () => {
  const source = await read('functions/src/draft-automation.ts');

  for (const status of ['ready', 'queued', 'processing', 'error']) {
    assert.match(source, new RegExp(`value === '${status}'`));
  }

  assert.match(
    source,
    /initialDraft\.projectionPreparationStatus \?\? null/,
  );
  assert.match(source, /const preparationFailed = preparationStatus === 'error'/);
  assert.match(source, /serverAutomationStatus: preparationFailed \? 'error' : 'waiting-projection'/);
});

test('S3E.1.1 verification inherits S3E.1 and preserves the current release, Scoring V3, Projection V11, and monitor mode', async () => {
  const [packageSource, readme, runtime, productionRuntime, configSource] = await Promise.all([
    read('package.json'),
    read('README.md'),
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('config/app-check-enforcement-readiness.json'),
  ]);
  const packageJson = JSON.parse(packageSource);
  const config = JSON.parse(configSource);

  assert.match(packageJson.scripts['verify:batchs3e-1-1:core'], /verify:batchs3e-1:core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batch(?:s3e-1-1|s3f|d1a|d1a-1|d1b|d1c|c1a|c1b|c1c|c1d|c1e|c1f|c1g):core/);
  assert.match(readme, /Security Batch S3E\.1\.1/);
  assert.match(readme, /Scoring V3/);
  assert.match(readme, /Projection V11/);
  assert.match(runtime, /Release Candidate 33/);
  assert.match(productionRuntime, /Release Candidate 33/);
  assert.equal(config.mode, 'monitor');
  assert.equal(config.automaticEnforcement, false);
});

test('S3E.1.1 documentation and permanent roadmap remain synchronized', async () => {
  const [roadmap, docsRoadmap, runbook] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_SECURITY_S3E_1_1_DRAFT_PREPARATION_TYPE_HOTFIX.md'),
  ]);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.\d+(?:\.\d+)?/);
  assert.match(roadmap, /# \[x\] LOG\.24/);
  assert.match(runbook, /undefined/i);
  assert.match(runbook, /type guard/i);
  assert.match(runbook, /runtime behavior is unchanged/i);
});
