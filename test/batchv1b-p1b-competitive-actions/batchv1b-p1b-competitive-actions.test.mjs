import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { hashFunctionsRuntimeIntegrity } from '../shared/functions-runtime-integrity.mjs';
import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';

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
    read('src/app/features/free-agents/free-agents.css'),
  ]);

  assert.match(tokens, /--rr-commit-face-top:\s*#fff2a8/);
  assert.match(tokens, /--rr-commit-face-bottom:\s*#ffbd24/);
  assert.match(tokens, /--rr-commit-ink:\s*#111820/);
  assert.match(primitives, /\.rr-button--commit/);
  assert.match(primitives, /data-commit-ready='true'/);
  assert.match(primitives, /rr-commit-ready-sheen/);
  assert.match(primitives, /prefers-reduced-motion:\s*reduce/);
  assert.equal((template.match(/rr-button--commit/g) ?? []).length, 1);
  assert.match(template, /Selected move/);
  assert.match(template, /getConfirmButtonLabel\(\)/);
  assert.match(source, /return this\.selectedWaiver\(\) \? 'Submit Waiver Claim' : 'Confirm Add \/ Drop'/);
  assert.match(workbenchStyles, /transaction-confirmation-actions/);
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
  assert.equal(
    await hashFunctionsRuntimeIntegrity({
      excludedPaths: new Set([
        'src/index.ts',
        'src/league-lifecycle-authority.ts',
    'src/league-lifecycle-authority.util.ts',
        'src/league-automation.ts',
        // D1D intentionally changes only the measured near-live scoring path.
        'src/shared/core/cycle/cycle-scoring.service.ts',
        'src/shared/core/nhl/nhl-api.service.ts',
        'src/shared/core/live-scoring/live-scoring-cadence.util.ts',
        // D1F adds isolated canonical facts and affected-league routing.
        'src/nhl-canonical-impact-feed.ts',
        'src/shared/core/nhl/nhl-canonical-facts.util.ts',
        // D1G adds isolated direct-versus-canonical shadow scoring parity.
        'src/shared/core/nhl/nhl-canonical-scoring-parity.util.ts',
        // D1H adds an isolated same-task authority decision and circuit-breaker helper.
        'src/shared/core/nhl/nhl-canonical-scoring-authority.util.ts',
        // D1I adds isolated automatic fallback and measured-capacity decisions.
        'src/shared/core/live-scoring/league-automation-season-safety.util.ts',
        // D1F.2 adds isolated queue-version helpers and scoring phase instrumentation.
        'src/shared/core/live-scoring/canonical-request-completion.util.ts',
        'src/shared/core/nhl/nhl-canonical-impact-routing.util.ts',
        'src/shared/core/observability/scoring-phase-timing.util.ts',
        'src/shared/core/cycle/cycle.service.ts',
        'src/shared/core/projection/window-projection.service.ts',
        'src/projection-authority.ts',
        'src/shared/core/projection/projection-asset-catalog.service.ts',
        'src/shared/core/projection/projection-asset-catalog.util.ts',
        'src/shared/core/projection/projection-snapshot.service.ts',
        'src/shared/core/projection/projection-snapshot-hash.util.ts',
        'src/draft-authority.ts',
        'src/draft-automation.ts',
        // FF1.19 adds isolated scheduled-Draft readiness evidence decisions.
        'src/draft-readiness.util.ts',
        'src/shared/core/draft/draft.models.ts',
        'package.json',
        'scripts/auth-security-baseline.cjs',
        'src/security-authority.ts',
        'src/security-operations.ts',
        'src/shared/security/auth-security.util.ts',

        // S3B intentionally hardens these public security boundaries.

        'src/email-notifications.ts',

        'src/manager-profile-authority.ts',

        'src/roster-authority.ts',

        'src/roster-moves.ts',

        'src/shared/core/replay/roster-move-replay-context.util.ts',

        'src/shared/security/firestore-document-id-core.util.ts',

        'src/shared/security/firestore-document-id.util.ts',
        'src/shared/security/firestore-document-id-policies.ts',

        'src/shared/security/nhl-proxy-security.util.ts',
        // S3E adds isolated monitor-only App Check readiness aggregation.
        'src/shared/security/app-check-enforcement-readiness.util.ts',
        // S3F adds guarded exact-league selected-callable App Check canary controls.
        'src/app-check-canary-authority.ts',
        'src/shared/security/app-check-callable-canary.util.ts',
        // B1B adds isolated beta evidence and aggregate operations helpers.
        'src/beta-operations.ts',
        'src/shared/core/observability/beta-operations.util.ts',
        // D1B adds isolated shared injury identity diagnostics.
        'src/shared/core/player/injury-match-quality.util.ts',
        'src/shared/core/player/injury-player-aliases.ts',
        'src/shared/core/player/player-availability.models.ts',
        // C1A adds isolated server-sanitized League Wire projections.
        'src/league-activity.ts',
        'src/shared/core/league/league-activity.util.ts',
        'src/shared/core/league/league-activity-reaction.util.ts',
        'scripts/league-matchup-activity-inspect.cjs',
        // C1B adds guarded additive migration and inspection commands.
        'scripts/transaction-privacy-backfill.cjs',
        'scripts/transaction-privacy-inspect.cjs',
        // C1K adds isolated cosmetic challenge reconciliation authority.
        'src/team-identity-challenges.ts',
        'src/shared/core/user/team-identity-challenge.util.ts',
        // A1A adds isolated account-wide watchlist authority.
        'src/player-watchlist.ts',
        'src/shared/core/user/player-watchlist.util.ts',
        // A1D adds isolated replay alignment and private player-note authority.
        'src/shared/core/draft/historical-replay-player-data.util.ts',
        'src/player-note.ts',
        'src/shared/core/user/player-note.util.ts',
        // O1B adds isolated platform-admin tester-season planning authority.
        'src/private-season-authority.ts',
        'src/shared/core/operations/private-season.util.ts',
        // O1C adds isolated private-season health and engagement authority.
        'src/private-season-health.ts',
        'src/shared/core/operations/private-season-health.util.ts',
        // O1D adds isolated incident/status authority.
        'src/service-incident-authority.ts',
        'src/shared/core/operations/service-incident.util.ts',
        // O1E adds isolated tester-research authority.
        'src/private-season-research.ts',
        'src/shared/core/operations/private-season-research.util.ts',
        // O1F adds isolated privacy-request and export authority.
        'src/privacy-request-authority.ts',
        'src/shared/core/privacy/privacy-request.util.ts',
        // O1G adds isolated versioned compatibility for operational callables.
        'src/shared/core/operations/operations-client-compatibility.util.ts',
        // D1L explicitly changes these additional final-input and durable-outbox paths.
        'src/shared/core/cycle/asset-cycle-window.service.ts',
        'src/shared/core/cycle/cycle.models.ts',
        'src/shared/core/nhl/nhl-canonical-publication-outbox.service.ts',
        'src/shared/core/nhl/nhl-final-input-completeness.util.ts',
        'src/shared/core/playoffs/playoff-window-bank.service.ts',
        // D1M adds an isolated, detect-only final-score reconciliation classifier.
        'src/shared/core/nhl/final-score-reconciliation.util.ts',
      ]),
    }),
    'e3476c70892afa6add7bd60266889282e880c62f407ebc9361ace624901858ed',
  );
});
