import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildFirebaseFunctionDeploySelectors,
  buildFirebaseFunctionsDeploymentAudit,
  collectExpectedFirebaseFunctionNames,
  normalizeRemoteFirebaseFunction,
} from '../../scripts/release/firebase-functions-deployment-audit.util.mjs';

const ROOT = new URL('../../', import.meta.url);
const read = (relativePath) => readFile(new URL(relativePath, ROOT), 'utf8');

test('D1J focused tests self-repair generated ignore rules before running', async () => {
  const packageJson = JSON.parse(await read('package.json'));
  assert.match(
    packageJson.scripts['pretest:batchd1j:run'],
    /security:sync-repository-automation/,
  );
  assert.match(await read('.gitignore'), /\/\.season-release\//);
});

test('the local Functions inventory is derived from the one authoritative index', async () => {
  const names = collectExpectedFirebaseFunctionNames(
    await read('functions/src/index.ts'),
  );
  assert.equal(names.length, 105);
  assert.ok(names.includes('pollCanonicalNhlImpactFeed'));
  assert.ok(names.includes('sendInjuryEmailsOnGlobalAvailabilityChange'));
  assert.ok(names.includes('refreshLeagueAutomationCapacityEvidence'));
  assert.ok(names.includes('unpinLeagueAnnouncement'));
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
});

test('remote Function identities normalize across Firebase CLI response shapes', () => {
  assert.deepEqual(
    normalizeRemoteFirebaseFunction({
      id: 'exampleCallable',
      region: 'us-central1',
      platform: 'gcfv2',
    }),
    { name: 'exampleCallable', region: 'us-central1', platform: 'gcfv2' },
  );
  assert.deepEqual(
    normalizeRemoteFirebaseFunction({
      name: 'projects/example/locations/us-central1/functions/exampleTrigger',
    }),
    { name: 'exampleTrigger', region: 'us-central1', platform: null },
  );
});

test('a perfect local/deployed inventory is ready', () => {
  const expectedNames = ['alpha', 'beta'];
  const report = buildFirebaseFunctionsDeploymentAudit({
    expectedNames,
    projectId: 'project-id',
    remotePayload: {
      result: [
        { id: 'beta', region: 'us-central1' },
        { id: 'alpha', region: 'us-central1' },
      ],
    },
  });
  assert.equal(report.ready, true);
  assert.equal(report.matchedCount, 2);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.unexpected, []);
});

test('missing, unexpected, duplicate, and wrong-region Functions block readiness', () => {
  const report = buildFirebaseFunctionsDeploymentAudit({
    expectedNames: ['alpha', 'beta'],
    projectId: 'project-id',
    remotePayload: {
      result: [
        { id: 'alpha', region: 'us-west1' },
        { id: 'alpha', region: 'us-central1' },
        { id: 'obsolete', region: 'us-central1' },
        { id: 'ext-provider-helper', region: 'us-central1' },
      ],
    },
  });
  assert.equal(report.ready, false);
  assert.deepEqual(report.missing, ['beta']);
  assert.deepEqual(report.unexpected, ['obsolete']);
  assert.deepEqual(report.duplicateRemoteNames, ['alpha']);
  assert.deepEqual(report.ignoredRemoteFunctions, ['ext-provider-helper']);
  assert.deepEqual(report.regionMismatches, [
    {
      name: 'alpha',
      expectedRegion: 'us-central1',
      deployedRegion: 'us-west1',
    },
  ]);
});

test('quota-safe reconciliation selectors stay in small explicit batches', () => {
  const names = Array.from({ length: 23 }, (_, index) => `function${String(index + 1).padStart(2, '0')}`);
  const selectors = buildFirebaseFunctionDeploySelectors(names, 10);
  assert.equal(selectors.length, 3);
  assert.equal(selectors[0].split(',').length, 10);
  assert.equal(selectors[1].split(',').length, 10);
  assert.equal(selectors[2].split(',').length, 3);
  assert.ok(selectors.every((selector) => selector.split(',').every((item) => item.startsWith('functions:'))));
});

test('the deployment audit is read-only and never deletes or deploys by itself', async () => {
  const source = await read('scripts/release/firebase-functions-deployment-audit.mjs');
  assert.equal((source.match(/execFileSync\(/g) ?? []).length, 2);
  assert.match(source, /runRemoteList/);
  assert.match(source, /provider === 'gcloud'/);
  assert.match(source, /'gcloud'[\s\S]*?'functions'[\s\S]*?'list'/);
  assert.match(source, /'firebase'[\s\S]*?'functions:list'/);
  assert.doesNotMatch(source, /execFileSync\([\s\S]{0,260}['"]deploy['"]/);
  assert.doesNotMatch(source, /functions:delete/);
  assert.doesNotMatch(source, /firebase deploy --only firestore/);
});

test('D1J.1 scripts expose a local audit and a non-executing reconciliation plan', async () => {
  const packageJson = JSON.parse(await read('package.json'));
  assert.match(packageJson.scripts['firebase:audit-functions'], /deployment-audit\.mjs/);
  assert.match(packageJson.scripts['firebase:plan-function-reconcile'], /plan-all-only/);
  assert.match(packageJson.scripts['verify:batchd1j1:core'], /test:batchd1j1:run/);
});
