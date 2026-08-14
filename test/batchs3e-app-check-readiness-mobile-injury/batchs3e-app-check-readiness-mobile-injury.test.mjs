import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  APP_CHECK_READINESS_POLICY,
  buildAppCheckEnforcementReadiness,
} from '../../functions/src/shared/security/app-check-enforcement-readiness.util.ts';
import { getMobilePlayerAvailabilityStatus } from '../../src/app/features/cycles/cycle-one/mobile-player-status.util.ts';

const ROOT = new URL('../../', import.meta.url);
async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function evidence({
  buildId = 'build-23',
  browser = 'Chrome',
  platform = 'macOS',
  viewportCategory = 'desktop',
  action = 'draft-pick',
  status = 'valid',
  day = '2026-08-12',
  user = 'manager-day-1',
} = {}) {
  return {
    buildId,
    browser,
    platform,
    viewportCategory,
    kind: 'competitive-action',
    action,
    serverAppCheckStatus: status,
    dateKey: day,
    dailyUserHash: user,
  };
}

function readyEvidence() {
  const records = [];
  const browsers = ['Chrome', 'Safari', 'Mobile Safari'];
  const devices = ['desktop', 'phone'];
  const actions = ['draft-pick', 'add-drop', 'lineup-swap', 'injured-reserve', 'waiver-claim'];

  for (let index = 0; index < 60; index += 1) {
    records.push(evidence({
      browser: browsers[index % browsers.length],
      platform: index % 3 === 0 ? 'iOS' : index % 3 === 1 ? 'macOS' : 'Android',
      viewportCategory: devices[index % devices.length],
      action: actions[index % actions.length],
      day: `2026-08-${String(10 + (index % 3)).padStart(2, '0')}`,
      user: `manager-day-${index % 8}`,
    }));
  }

  return records;
}

test('App Check readiness is exact-build, evidence-backed, and never automatic', () => {
  const result = buildAppCheckEnforcementReadiness(readyEvidence(), 'build-23');

  assert.equal(result.status, 'ready');
  assert.equal(result.canaryEligible, true);
  assert.equal(result.automaticEnforcement, false);
  assert.equal(result.validPercent, 100);
  assert.equal(result.blockers.length, 0);
  assert.equal(result.browserCoverage.filter((item) => item.required).every((item) => item.verificationGatePassed), true);
  assert.equal(result.platformCoverage.filter((item) => item.required).every((item) => item.verificationGatePassed), true);
  assert.equal(result.actionCoverage.filter((item) => item.required).every((item) => item.verificationGatePassed), true);
  assert.equal(APP_CHECK_READINESS_POLICY.minimumValidPercent, 99);
});

test('older builds and missing tokens cannot make a new build enforcement-ready', () => {
  const records = readyEvidence();
  records.push(...readyEvidence().map((item) => ({ ...item, buildId: 'old-build' })));
  records[0] = { ...records[0], serverAppCheckStatus: 'missing' };

  const current = buildAppCheckEnforcementReadiness(records, 'build-23');
  const unknown = buildAppCheckEnforcementReadiness(records, 'new-build');

  assert.equal(current.canaryEligible, false);
  assert.equal(current.status, 'needs-attention');
  assert.equal(current.missingSamples, 1);
  assert.equal(unknown.status, 'collecting');
  assert.equal(unknown.totalSamples, 0);
});

test('mobile matchup injury status uses only a compact icon, short status, and return date', () => {
  const status = getMobilePlayerAvailabilityStatus({
    playerId: 1,
    playerName: 'Example Player',
    status: 'injured-reserve',
    label: 'Injured Reserve',
    shortLabel: 'IR',
    irEligible: true,
    note: 'This intentionally long article must never appear in the compact matchup row.',
    updatedAt: '2026-08-11T00:00:00.000Z',
    source: 'firestore',
    externalReturnDate: '2026-09-15',
  }, new Date('2026-08-12T00:00:00.000Z'));

  assert.deepEqual(status, {
    icon: '✚',
    shortLabel: 'IR',
    returnDateLabel: 'Return Sep 15',
    ariaLabel: 'Injured Reserve. Return Sep 15.',
  });
  assert.doesNotMatch(JSON.stringify(status), /long article/);
});

test('mobile status has a bounded fallback when no return date is available', () => {
  const status = getMobilePlayerAvailabilityStatus({
    playerId: 2,
    playerName: 'Example Player',
    status: 'out',
    label: 'Out',
    shortLabel: 'Out',
    irEligible: true,
    note: 'Another long update.',
    updatedAt: '2026-08-11T00:00:00.000Z',
    source: 'firestore',
  });

  assert.equal(status?.returnDateLabel, 'Return TBD');
  assert.equal(status?.ariaLabel, 'Out. Return TBD.');
});

test('Admin Center shows exact-build browser, device, action, and platform gates', async () => {
  const [template, component, models, server, clientService] = await Promise.all([
    read('src/app/features/admin/admin-center/admin-center.html'),
    read('src/app/features/admin/admin-center/admin-center.ts'),
    read('src/app/core/beta-operations/beta-operations.models.ts'),
    read('functions/src/beta-operations.ts'),
    read('src/app/core/admin/platform-admin.service.ts'),
  ]);

  assert.match(template, /Selected-callable enforcement gate/);
  assert.match(template, /Required browsers/);
  assert.match(template, /Required device classes/);
  assert.match(template, /Required competitive actions/);
  assert.match(template, /Required platforms and observed others/);
  assert.match(template, /Monitor-only safety/);
  assert.match(component, /appCheckCoverageState/);
  assert.match(models, /AppCheckEnforcementReadiness/);
  assert.match(server, /platformFamily/);
  assert.match(server, /buildAppCheckEnforcementReadiness/);
  assert.match(clientService, /BUNDLED_RELEASE_MANIFEST\.buildId/);
});

test('mobile matchup template never renders the full injury note in its status line', async () => {
  const [template, component, presenter, css] = await Promise.all([
    read('src/app/features/cycles/cycle-one/components/cycle-mobile-head-to-head/cycle-mobile-head-to-head.html'),
    read('src/app/features/cycles/cycle-one/components/cycle-mobile-head-to-head/cycle-mobile-head-to-head.ts'),
    read('src/app/features/cycles/cycle-one/cycle-one.ts'),
    read('src/app/features/cycles/cycle-one/components/cycle-mobile-head-to-head/cycle-mobile-head-to-head.css'),
  ]);

  assert.match(template, /mobile-live-player-statusline-compact/);
  assert.match(template, /status\.returnDateLabel/);
  assert.doesNotMatch(template, /getAssetStatusTooltip\(pick\.asset\)/);
  assert.doesNotMatch(template, /getBenchAssetStatusTooltip\(asset\)/);
  assert.match(component, /getActiveCompactStatus/);
  assert.match(component, /getBenchCompactStatus/);
  assert.match(presenter, /getAssetMobileStatus/);
  assert.match(presenter, /getBenchAssetMobileStatus/);
  assert.match(css, /white-space:\s*nowrap/);
});

test('S3E remains monitor-only and preserves Scoring V3 and Projection V11', async () => {
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
  assert.match(runtime, /Release Candidate 31/);
  assert.match(productionRuntime, /Release Candidate 31/);
});

test('S3E verification, documentation, roadmap, and audit commands stay synchronized', async () => {
  const [packageSource, roadmap, docsRoadmap, readme, runbook, audit] = await Promise.all([
    read('package.json'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('README.md'),
    read('docs/RINKRAT_SECURITY_S3E_APP_CHECK_READINESS.md'),
    read('scripts/security/app-check-readiness-audit.mjs'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.\d+(?:\.\d+)?/);
  assert.match(roadmap, /# \[x\] S3\.22/);
  assert.match(roadmap, /# \[x\] B1\.25/);
  assert.match(packageJson.scripts['security:audit-app-check-readiness'], /app-check-readiness-audit/);
  assert.match(packageJson.scripts['test:batchs3e:run'], /batchs3e-app-check-readiness-mobile-injury/);
  assert.match(packageJson.scripts['verify:batchs3e:core'], /verify:batchs3d:core/);
  assert.match(readme, /Security Batch S3E/);
  assert.match(runbook, /selected-callable canary/i);
  assert.match(audit, /automaticEnforcement/);
});
