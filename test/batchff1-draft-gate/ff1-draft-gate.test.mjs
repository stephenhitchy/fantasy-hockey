import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  allowedPackageScripts,
  classifyReviewDelta,
  criticalDraftFunctions,
  packageChangeIsToolingOnly,
  requiredReadOnlyFunctions,
  validateLiveManifest,
  validateRemoteFunctions,
} from '../../scripts/release/ff1-draft-preflight.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relativePath) => readFileSync(path.join(root, relativePath), 'utf8');

test('source-only preflight passes without live access or repository mutation', () => {
  const output = execFileSync(process.execPath, ['scripts/release/ff1-draft-preflight.mjs', '--source-only'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.match(output, /static source: PASS/);
  assert.match(output, /performed no network, Firebase, Git mutation, or Production data operation/);
});

test('review delta permits only the FF1 documentation, test, and tooling slice', () => {
  assert.equal(classifyReviewDelta([
    'docs/RINKRAT_FF1_DRAFT_GATE_RUNBOOK.md',
    'scripts/release/ff1-draft-preflight.mjs',
    'test/batchff1-draft-gate/ff1-draft-gate.test.mjs',
    'package.json',
  ]).ready, true);
  const runtime = classifyReviewDelta(['src/app/app.ts', 'functions/src/index.ts', 'firebase.json']);
  assert.equal(runtime.ready, false);
  assert.deepEqual(runtime.rejected, ['src/app/app.ts', 'functions/src/index.ts', 'firebase.json']);
});

test('package boundary allows only the five FF1 scripts', () => {
  const base = { name: 'rinkrat', scripts: { build: 'ng build' }, dependencies: { firebase: '12' } };
  const tooling = structuredClone(base);
  for (const name of allowedPackageScripts) tooling.scripts[name] = `node ${name}`;
  assert.equal(packageChangeIsToolingOnly(base, tooling), true);

  const dependencyChange = structuredClone(tooling);
  dependencyChange.dependencies.firebase = '13';
  assert.equal(packageChangeIsToolingOnly(base, dependencyChange), false);
});

test('live manifest validation freezes RC65, Scoring V4, and Projection V11', () => {
  const policy = { releaseLabel: 'Release Candidate 65', scoringRulesVersion: 4, projectionVersion: 11 };
  const valid = {
    schemaVersion: 1,
    releaseLabel: policy.releaseLabel,
    sourceRevision: 'a'.repeat(40),
    scoringRulesVersion: 4,
    projectionVersion: 11,
  };
  assert.equal(validateLiveManifest(valid, policy).ready, true);
  assert.equal(validateLiveManifest({ ...valid, projectionVersion: 12 }, policy).ready, false);
  assert.equal(validateLiveManifest({ ...valid, sourceRevision: 'dirty' }, policy).ready, false);
});

test('critical Draft and D1M Functions must all be ACTIVE', () => {
  assert.ok(criticalDraftFunctions.length >= 15);
  assert.ok(criticalDraftFunctions.includes('manageProjectionSnapshotIntegrity'));
  assert.ok(criticalDraftFunctions.includes('requestProjectionSnapshotGeneration'));
  assert.ok(requiredReadOnlyFunctions.includes('getFinalScoreReconciliationPage'));
  const active = requiredReadOnlyFunctions.map((name) => ({ name: `projects/p/locations/us-central1/functions/${name}`, state: 'ACTIVE' }));
  assert.equal(validateRemoteFunctions(active).ready, true);
  assert.equal(validateRemoteFunctions(active.slice(1)).ready, false);
  assert.equal(validateRemoteFunctions(active.map((entry, index) => index === 0 ? { ...entry, state: 'FAILED' } : entry)).ready, false);
});

test('runbook keeps Draft approval separate and covers protected lifecycle edges', () => {
  const runbook = read('docs/RINKRAT_FF1_DRAFT_GATE_RUNBOOK.md');
  for (const id of [
    'DRF-01', 'DRF-09', 'LIFE-01', 'LIFE-08', 'OPS-01', 'OPS-03',
  ]) assert.match(runbook, new RegExp(id));
  for (const contract of [
    'Projection V11', 'six-game ownership', 'Game 7', 'exactly once',
    'physical iPhone Safari', 'Android Chrome', 'Never edit Production documents directly in Firestore',
  ]) assert.match(runbook, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(runbook, /real\s+Drafts remain blocked/i);
  assert.match(runbook, /requires no Firebase deployment/);
});

test('preflight implementation contains no deployment or competitive-write command', () => {
  const source = read('scripts/release/ff1-draft-preflight.mjs');
  assert.doesNotMatch(source, /firebase\s+deploy|functions:delete|firestore\s+(?:set|delete|write)|gcloud\s+functions\s+deploy/);
  assert.match(source, /'functions', 'list', '--v2'/);
});

test('roadmap copies remain byte-identical', () => {
  assert.equal(read('RINKRAT_COMPETITIVE_ROADMAP.txt'), read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'));
});
