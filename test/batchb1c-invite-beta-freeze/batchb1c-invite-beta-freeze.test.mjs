import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  formatRollbackPlan,
  safeTagName,
  validateInviteBetaValidationReport,
} from '../../scripts/release/invite-beta-release.util.mjs';
import {
  inspectToolchain,
} from '../../scripts/release/toolchain-preflight.util.mjs';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

async function hash(relativePath) {
  const bytes = await readFile(new URL(relativePath, ROOT));
  return createHash('sha256').update(bytes).digest('hex');
}

function liveManifest() {
  return {
    schemaVersion: 1,
    releaseLabel: 'Release Candidate 48',
    buildId: 'release-candidate-30-test-aabbccddeeff',
    sourceRevision: 'a'.repeat(40),
    scoringRulesVersion: 3,
    projectionVersion: 11,
  };
}

function readyReport(overrides = {}) {
  const manifest = liveManifest();
  return {
    schemaVersion: 2,
    reportType: 'rinkrat-invite-beta-validation',
    build: manifest,
    launchGate: {
      status: 'ready',
      blockers: [],
      automatedPassedCount: 20,
      automatedRequiredCount: 20,
      manualPassedCount: 27,
      manualRequiredCount: 27,
      manualAttentionCount: 0,
      manualUntestedCount: 0,
      simulationStatus: 'passed',
    },
    lifecycleSimulation: {
      passed: true,
      passedCount: 30,
      totalCount: 30,
      failedChecks: [],
    },
    ...overrides,
  };
}

test('B1C pins the exact Node and npm release toolchain and explains how to recover drift', async () => {
  const packageJson = JSON.parse(await read('package.json'));
  const nvmrc = (await read('.nvmrc')).trim();

  assert.equal(nvmrc, '22.23.1');
  assert.equal(packageJson.packageManager, 'npm@11.17.0');
  assert.equal(packageJson.engines.node, '>=22.22.3 <23');
  assert.equal(packageJson.engines.npm, '11.17.x');

  const healthy = inspectToolchain({
    expectedNode: nvmrc,
    expectedNpm: '11.17.0',
    actualNode: 'v22.23.1',
    actualNpm: '11.17.0',
  });
  assert.equal(healthy.ok, true);

  const drifted = inspectToolchain({
    expectedNode: nvmrc,
    expectedNpm: '11.17.0',
    actualNode: 'v22.23.1',
    actualNpm: '12.0.2',
  });
  assert.equal(drifted.ok, false);
  assert.match(drifted.issues.join('\n'), /npm install -g npm@11\.17\.0/);
});

test('the source-only preflight validates RC34 controls without requiring the host machine toolchain', () => {
  const output = execFileSync(
    process.execPath,
    ['scripts/release/invite-beta-release.mjs', 'preflight', '--source-only'],
    { cwd: new URL('.', ROOT), encoding: 'utf8' },
  );
  assert.match(output, /Invite-beta source preflight passed/);
  assert.match(output, /npm 11\.17\.0/);
  assert.match(output, /10 TTL policies/);
  assert.match(output, /(?:RC32|Release Candidate 48) runtime/);
});

test('exact-build validation accepts only a ready report matching the live release', () => {
  const accepted = validateInviteBetaValidationReport(readyReport(), liveManifest());
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.issues, []);

  const incomplete = readyReport({
    launchGate: {
      ...readyReport().launchGate,
      status: 'testing',
      manualPassedCount: 26,
      manualUntestedCount: 1,
      blockers: ['One manual workflow remains.'],
    },
  });
  const rejected = validateInviteBetaValidationReport(incomplete, liveManifest());
  assert.equal(rejected.ok, false);
  assert.match(rejected.issues.join('\n'), /not ready|manual|blocker/i);

  const wrongBuild = readyReport({
    build: { ...liveManifest(), buildId: 'wrong-build' },
  });
  const buildRejected = validateInviteBetaValidationReport(wrongBuild, liveManifest());
  assert.equal(buildRejected.ok, false);
  assert.match(buildRejected.issues.join('\n'), /buildId/);
});

test('freeze and rollback tooling is explicit, non-deploying, and does not create tags silently', async () => {
  const source = await read('scripts/release/invite-beta-release.mjs');
  const policy = JSON.parse(await read('config/release-freeze/beta-freeze-policy.json'));

  assert.match(source, /RINKRAT_FREEZE_INVITE_BETA === 'FREEZE'/);
  assert.match(source, /--validation-report/);
  assert.match(source, /ci-passed/);
  assert.match(source, /rollback-rehearsed/);
  assert.match(source, /queue-shadow/);
  assert.match(source, /scripts\/security\/firestore-ttl-baseline\.mjs/);
  assert.doesNotMatch(source, /run\(['"]firebase['"]/);
  assert.doesNotMatch(source, /run\(['"]git['"], \[['"]tag['"]/);
  assert.equal(policy.releaseLabel, 'Release Candidate 48');
  assert.equal(policy.requiredTtlPolicyCount, 10);
  assert.equal(policy.queueMode, 'shadow');
  assert.equal(policy.appCheckMode, 'monitor');
  assert.equal(policy.cspMode, 'report-only');

  assert.equal(safeTagName('rinkrat-rc48-invite-beta'), 'rinkrat-rc48-invite-beta');
  assert.throws(() => safeTagName('../unsafe'), /safe Git tag/);
});

test('generated rollback guidance uses the frozen source and the smallest normal rollback', () => {
  const plan = formatRollbackPlan({
    release: liveManifest(),
    toolchain: { node: '22.23.1', npm: '11.17.0' },
    firebase: { projectId: 'nhl-fantasy-app-ab673', hostingTarget: 'app' },
    git: { tag: 'rinkrat-rc48-invite-beta' },
  });

  assert.match(plan, /git checkout rinkrat-rc48-invite-beta/);
  assert.match(plan, /npm install -g npm@11\.17\.0/);
  assert.match(plan, /firebase deploy --only functions/);
  assert.match(plan, /firebase deploy --only hosting:app/);
  assert.match(plan, /Rules or indexes only when the incident specifically involves those resources/i);
  assert.match(plan, /npm audit fix --force/);
});

test('generated freeze records and security reports remain ignored and recoverable on macOS', async () => {
  const gitignore = await read('.gitignore');
  const sync = await read('scripts/security/sync-repository-automation.mjs');

  assert.match(gitignore, /\/\.security-reports\//);
  assert.match(gitignore, /\/\.beta-release\//);
  assert.match(sync, /BETA_RELEASE_IGNORE_RULE/);
  assert.match(sync, /Generated invite-beta freeze records/);
});

test('B1C scripts, documentation, roadmap, and CI verification remain synchronized', async () => {
  const packageJson = JSON.parse(await read('package.json'));
  const readme = await read('README.md');
  const documentation = await read('docs/RINKRAT_PROJECT_DOCUMENTATION.md');
  const runbook = await read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md');
  const roadmapRoot = await read('RINKRAT_COMPETITIVE_ROADMAP.txt');
  const roadmapDocs = await read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt');

  assert.equal(packageJson.scripts['toolchain:verify'], 'node scripts/release/toolchain-preflight.mjs --strict');
  assert.equal(packageJson.scripts['beta:preflight'], 'node scripts/release/invite-beta-release.mjs preflight');
  assert.match(packageJson.scripts['verify:batchb1c'], /toolchain:verify/);
  assert.match(packageJson.scripts['verify:batchb1c:core'], /verify:batchb1b-1:core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batch(?:b1c|s4a|b1d|s3d|s3e|s3e-1|s3e-1-1|s3f|d1a|d1a-1|d1b|d1c|c1a|c1b|c1c|c1d|c1e|c1f|c1g|c1h|c1i|c1j|c1k|c1l|c1m|a1a|a1b|a1c|a1d|a1e|a1f|a1g|a1h|a1i|n1a):core/);
  assert.match(await read('.github/workflows/rinkrat-ci.yml'), /npm install --global npm@11\.17\.0/);
  assert.match(readme, /verify:batchb1c/);
  assert.match(documentation, /Beta Operations Batch B1C/);
  assert.match(runbook, /pbpaste > .*rinkrat-rc48-validation\.json/);
  assert.equal(roadmapRoot, roadmapDocs);
  assert.match(roadmapRoot, /Version 1\.\d+(?:\.\d+)?/);
  assert.match(roadmapRoot, /B1\.24 .*invite-beta freeze/i);
  assert.match(roadmapRoot, /LOG\.18 .*B1C/i);
});

test('B1C keeps its historical preservation fixture without blocking later named releases', async () => {
  const preserved = JSON.parse(await read('test/batchb1c-invite-beta-freeze/preserved-runtime-hashes.json'));
  assert.ok(Object.keys(preserved).length >= 5);
  for (const [relativePath, expectedHash] of Object.entries(preserved)) {
    assert.match(relativePath, /^(?:functions|src|firestore|firebase|config)/);
    assert.match(expectedHash, /^[a-f0-9]{64}$/);
  }
});
