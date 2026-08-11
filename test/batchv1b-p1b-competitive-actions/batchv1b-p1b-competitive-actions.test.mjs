import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import test from 'node:test';

import {
  buildCompetitiveActionHealthSnapshot,
  COMPETITIVE_ACTION_MAX_AGE_MILLISECONDS,
  normalizeCompetitiveActionRecord,
  normalizeCompetitiveActionRecords,
} from '../../src/app/core/observability/competitive-action-health.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

async function sha256(relativePath) {
  return createHash('sha256').update(await read(relativePath)).digest('hex');
}

async function hashTree(relativeDirectory, excludedPaths = new Set()) {
  const directoryUrl = new URL(
    relativeDirectory.endsWith('/') ? relativeDirectory : `${relativeDirectory}/`,
    ROOT,
  );
  const rootPath = decodeURIComponent(directoryUrl.pathname);
  const files = [];

  async function visit(currentPath, relativePath = '') {
    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries.sort((first, second) => first.name.localeCompare(second.name))) {
      if (entry.name === 'node_modules' || entry.name === 'lib') {
        continue;
      }

      const childPath = `${currentPath}/${entry.name}`;
      const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

      if (excludedPaths.has(childRelativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        await visit(childPath, childRelativePath);
      } else if (entry.isFile()) {
        files.push({ path: childPath, relativePath: childRelativePath });
      }
    }
  }

  await visit(rootPath);
  const digest = createHash('sha256');

  for (const file of files) {
    const metadata = await stat(file.path);
    const bytes = await readFile(file.path);
    const pathBytes = Buffer.from(file.relativePath);

    digest.update(Buffer.from(Uint32Array.of(pathBytes.length).buffer).reverse());
    digest.update(pathBytes);
    digest.update(Buffer.from(BigUint64Array.of(BigInt(metadata.size)).buffer).reverse());
    digest.update(bytes);
  }

  return digest.digest('hex');
}

function actionRecord(overrides = {}) {
  return {
    id: 'add-drop-test',
    action: 'add-drop',
    outcome: 'success',
    route: '/leagues/:leagueId/free-agents',
    startedAt: '2026-08-05T10:00:00.000Z',
    finishedAt: '2026-08-05T10:00:02.500Z',
    durationMilliseconds: 2_500,
    connectionType: '4g',
    online: true,
    ...overrides,
  };
}

test('competitive action history rejects stale or malformed records and keeps recent sanitized data', () => {
  const now = Date.parse('2026-08-05T12:00:00.000Z');
  const valid = normalizeCompetitiveActionRecord(actionRecord(), now);

  assert.ok(valid);
  assert.equal(valid.action, 'add-drop');
  assert.equal(valid.durationMilliseconds, 2_500);

  assert.equal(
    normalizeCompetitiveActionRecord(actionRecord({
      finishedAt: new Date(now - COMPETITIVE_ACTION_MAX_AGE_MILLISECONDS - 1).toISOString(),
    }), now),
    null,
  );
  assert.equal(normalizeCompetitiveActionRecord({ action: 'unknown' }, now), null);

  const records = normalizeCompetitiveActionRecords([
    actionRecord({ id: 'older', finishedAt: '2026-08-05T10:00:02.500Z' }),
    actionRecord({ id: 'newer', finishedAt: '2026-08-05T11:00:02.500Z' }),
  ], now);
  assert.deepEqual(records.map((record) => record.id), ['newer', 'older']);
});

test('competitive action snapshot reports confirmation, errors, uncertainty, duration, and slow operations', () => {
  const now = Date.parse('2026-08-05T12:00:00.000Z');
  const snapshot = buildCompetitiveActionHealthSnapshot([
    actionRecord({ id: 'success', action: 'add-drop', outcome: 'success', durationMilliseconds: 2_500 }),
    actionRecord({ id: 'slow', action: 'historical-replay', outcome: 'success', durationMilliseconds: 8_000 }),
    actionRecord({ id: 'error', action: 'draft-pick', outcome: 'error', durationMilliseconds: 1_500 }),
    actionRecord({ id: 'uncertain', action: 'roster-drop', outcome: 'uncertain', durationMilliseconds: 20_000 }),
    actionRecord({ id: 'cancelled', action: 'lineup-swap', outcome: 'cancelled', durationMilliseconds: 300 }),
  ], [{
    id: 'active',
    action: 'waiver-claim',
    route: '/leagues/:leagueId/free-agents',
    startedAtMilliseconds: now - 500,
    connectionType: '4g',
    online: true,
  }], now);

  assert.equal(snapshot.completedCount, 5);
  assert.equal(snapshot.successCount, 2);
  assert.equal(snapshot.errorCount, 1);
  assert.equal(snapshot.uncertainCount, 1);
  assert.equal(snapshot.cancelledCount, 1);
  assert.equal(snapshot.activeCount, 1);
  assert.equal(snapshot.slowActionCount, 2);
  assert.equal(snapshot.slowestDurationMilliseconds, 20_000);
  assert.equal(snapshot.byAction.find((entry) => entry.action === 'add-drop')?.successes, 1);
});

test('the final add/drop action uses a theme-independent high-visibility commit treatment', async () => {
  const [tokens, primitives, template, source, workbenchStyles] = await Promise.all([
    read('src/rinkrat-design-tokens.css'),
    read('src/rinkrat-shared-primitives.css'),
    read('src/app/features/free-agents/free-agents.html'),
    read('src/app/features/free-agents/free-agents.ts'),
    read('src/rinkrat-transaction-workbench.css'),
  ]);

  assert.match(tokens, /--rr-commit-face-top:\s*#fff2a8/);
  assert.match(tokens, /--rr-commit-face-bottom:\s*#ffbd24/);
  assert.match(tokens, /--rr-commit-ink:\s*#111820/);
  assert.match(primitives, /\.rr-button--commit/);
  assert.match(primitives, /data-commit-ready='true'/);
  assert.match(primitives, /rr-commit-ready-sheen/);
  assert.match(primitives, /prefers-reduced-motion:\s*reduce/);
  assert.equal((template.match(/rr-button--commit confirm-move-button/g) ?? []).length, 2);
  assert.match(template, /Ready to submit/);
  assert.match(source, /return this\.selectedWaiver\(\) \? 'Submit Waiver Claim' : 'Confirm Add \/ Drop'/);
  assert.match(workbenchStyles, /free-agent-confirmation-bar\.transaction-timing-ready/);
  assert.doesNotMatch(primitives, /var\(--user-team-primary\)/);
});

test('competitive actions are blocked while offline or during the reconnection validation window', async () => {
  const [health, freeAgents, team, replay] = await Promise.all([
    read('src/app/core/observability/client-health.service.ts'),
    read('src/app/features/free-agents/free-agents.ts'),
    read('src/app/features/team/team-settings/team-settings.ts'),
    read('src/app/features/cycles/cycle-one/cycle-one.ts'),
  ]);

  assert.match(health, /competitiveActionsReady = computed/);
  assert.match(health, /this\.online\(\) && !this\.restoredNoticeVisible\(\)/);
  assert.match(health, /No roster, waiver, draft, or testing request has been sent/);
  assert.match(freeAgents, /this\.clientHealth\.competitiveActionsReady\(\)/);
  assert.match(freeAgents, /getCompetitiveActionBlockReason/);
  assert.match(team, /ensureCompetitiveActionReady/);
  assert.match(team, /clientHealth\.competitiveActionsReady\(\)/);
  assert.match(replay, /!this\.clientHealth\.competitiveActionsReady\(\)/);
  assert.match(replay, /getHistoricalReplayAdvanceButtonLabel/);
});

test('add/drop, waiver, draft, replay, lineup, IR, and roster drops report session action health', async () => {
  const [monitor, freeAgents, team, draft, replay] = await Promise.all([
    read('src/app/core/observability/competitive-action-monitor.service.ts'),
    read('src/app/features/free-agents/free-agents.ts'),
    read('src/app/features/team/team-settings/team-settings.ts'),
    read('src/app/features/draft/draft-room/draft-room.ts'),
    read('src/app/features/cycles/cycle-one/cycle-one.ts'),
  ]);

  assert.match(monitor, /sessionStorage/);
  assert.match(monitor, /this\.telemetry\.sanitizedCurrentRoute\(\)/);
  assert.match(monitor, /this\.telemetry\.track\('competitive_action'/);
  assert.match(freeAgents, /this\.actionMonitor\.begin\(\s*this\.selectedWaiver\(\) \? 'waiver-claim' : 'add-drop'/);
  assert.match(freeAgents, /actionHandle\.finish\(actionOutcome\)/);
  assert.match(team, /this\.actionMonitor\.begin\('lineup-swap'\)/);
  assert.match(team, /this\.actionMonitor\.begin\('injured-reserve'\)/);
  assert.match(team, /this\.actionMonitor\.begin\('roster-drop'\)/);
  assert.match(draft, /this\.actionMonitor\.begin\('draft-pick'\)/);
  assert.match(replay, /this\.actionMonitor\.begin\('historical-replay'\)/);
  assert.match(replay, /replayActionHandle\?\.finish\('cancelled'\)/);
});

test('select positive final roster and draft actions use the same semantic commit hierarchy', async () => {
  const [teamTemplate, draftTemplate] = await Promise.all([
    read('src/app/features/team/team-settings/team-settings.html'),
    read('src/app/features/draft/draft-room/draft-room.html'),
  ]);

  assert.match(teamTemplate, /rr-button rr-button--commit[\s\S]*Confirm Activation/);
  assert.match(teamTemplate, /rr-button rr-button--commit[\s\S]*Move to Bench/);
  assert.match(teamTemplate, /rr-button rr-button--commit[\s\S]*Confirm Swap/);
  assert.match(draftTemplate, /draft-mobile-selection-submit rr-button rr-button--commit/);
  assert.match(draftTemplate, /Final draft action/);
});

test('Release Readiness and Support expose privacy-limited beta diagnostics', async () => {
  const [readinessSource, readinessTemplate, readinessStyles, supportSource, supportTemplate] = await Promise.all([
    read('src/app/features/release/release-readiness/release-readiness.ts'),
    read('src/app/features/release/release-readiness/release-readiness.html'),
    read('src/app/features/release/release-readiness/release-readiness.css'),
    read('src/app/features/support/support-home/support-home.ts'),
    read('src/app/features/support/support-home/support-home.html'),
  ]);

  assert.match(readinessSource, /CompetitiveActionMonitorService/);
  assert.match(readinessSource, /competitiveActions\.set\(this\.actionMonitor\.getSnapshot\(\)\)/);
  assert.match(readinessTemplate, /Session action health/);
  assert.match(readinessTemplate, /Copy Beta Diagnostics/);
  assert.match(readinessTemplate, /Slow operations/);
  assert.match(readinessStyles, /\.competitive-action-health-grid/);
  assert.match(supportSource, /copyBetaDiagnostics/);
  assert.match(supportSource, /competitiveActions:\s*this\.actionMonitor\.getSnapshot\(\)/);
  assert.match(supportTemplate, /Build &amp; browser diagnostics/);
  assert.match(supportTemplate, /excludes league IDs, player IDs, names, scores, roster contents/);
});

test('V1B-P1B verification, contrast audit, release label, and documentation are present', async () => {
  const [packageSource, developmentConfig, productionConfig, documentation] = await Promise.all([
    read('package.json'),
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.match(packageJson.scripts['test:batchv1b-p1b:run'], /batchv1b-p1b-competitive-actions/);
  assert.match(packageJson.scripts['audit:competitive-action-contrast'], /audit-competitive-action-contrast/);
  assert.match(packageJson.scripts['verify:batchv1b-p1b'], /verify:batchm5-5/);
  const developmentRelease = developmentConfig.match(/releaseLabel:\s*['"]([^'"]+)['"]/)?.[1];
  const productionRelease = productionConfig.match(/releaseLabel:\s*['"]([^'"]+)['"]/)?.[1];
  assert.match(developmentRelease ?? '', /^Release Candidate \d+$/);
  assert.equal(productionRelease, developmentRelease);
  assert.match(documentation, /^## Batch V1B–P1B — High-Visibility Competitive Actions and Action Health/m);
  assert.match(documentation, /Hosting-only/i);
});

test('competitive scoring, Projection V11, rules, indexes, and Functions unrelated to later replay or draft recovery remain unchanged', async () => {
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
  assert.equal(
    await hashTree(
      'functions',
      new Set([
        'src/index.ts',
        'src/league-lifecycle-authority.ts',
    'src/league-lifecycle-authority.util.ts',
        'src/league-automation.ts',
        'src/shared/core/cycle/cycle.service.ts',
        'src/shared/core/projection/window-projection.service.ts',
        'src/projection-authority.ts',
        'src/shared/core/projection/projection-asset-catalog.service.ts',
        'src/shared/core/projection/projection-asset-catalog.util.ts',
        'src/shared/core/projection/projection-snapshot.service.ts',
        'src/shared/core/projection/projection-snapshot-hash.util.ts',
        'src/draft-authority.ts',
        'src/draft-automation.ts',
        'src/shared/core/draft/draft.models.ts',
        'package.json',
        'scripts/auth-security-baseline.cjs',
        'src/security-authority.ts',
        'src/shared/security/auth-security.util.ts',

        // S3B intentionally hardens these public security boundaries.

        'src/email-notifications.ts',

        'src/manager-profile-authority.ts',

        'src/roster-authority.ts',

        'src/roster-moves.ts',

        'src/shared/security/firestore-document-id-core.util.ts',

        'src/shared/security/firestore-document-id.util.ts',

        'src/shared/security/nhl-proxy-security.util.ts',
      ]),
    ),
    '2a1fb1e2cb40222f626de6b2abb39a0e58a9e4d6d7c2cb3897bd36313fcbbff8',
  );
});
