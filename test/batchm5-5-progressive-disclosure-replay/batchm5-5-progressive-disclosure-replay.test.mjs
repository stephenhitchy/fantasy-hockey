import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { hashFunctionsRuntimeIntegrity } from '../shared/functions-runtime-integrity.mjs';
import {
  createHistoricalReplayAdvanceBaseline,
  evaluateHistoricalReplayAdvance,
} from '../../src/app/features/cycles/cycle-one/historical-replay-ui-state.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

async function sha256(relativePath) {
  return createHash('sha256').update(await read(relativePath)).digest('hex');
}

function control(overrides = {}) {
  return {
    status: 'ready',
    daysAdvanced: 4,
    simulatedDate: '2026-10-10',
    lastError: '',
    message: 'Previous day complete.',
    lastReleasedGameCount: 3,
    totalReleasedGameCount: 18,
    updatedAt: { seconds: 100, nanoseconds: 0 },
    ...overrides,
  };
}

test('an unchanged terminal replay snapshot does not prematurely unlock a new request', () => {
  const saved = control();
  const baseline = createHistoricalReplayAdvanceBaseline(saved);
  const evaluation = evaluateHistoricalReplayAdvance(baseline, saved, false);

  assert.deepEqual(evaluation, {
    state: 'pending',
    sawServerStart: false,
  });
});

test('the authoritative replay control unlocks after advancing then returning ready', () => {
  const baseline = createHistoricalReplayAdvanceBaseline(control());
  const started = evaluateHistoricalReplayAdvance(
    baseline,
    control({
      status: 'advancing',
      simulatedDate: '2026-10-11',
      daysAdvanced: 5,
      message: 'Processing 2026-10-11.',
      updatedAt: { seconds: 101, nanoseconds: 0 },
    }),
    false,
  );
  const finished = evaluateHistoricalReplayAdvance(
    baseline,
    control({
      status: 'ready',
      simulatedDate: '2026-10-11',
      daysAdvanced: 5,
      message: '2026-10-11 processed.',
      totalReleasedGameCount: 22,
      updatedAt: { seconds: 102, nanoseconds: 0 },
    }),
    started.sawServerStart,
  );

  assert.equal(started.state, 'pending');
  assert.equal(started.sawServerStart, true);
  assert.equal(finished.state, 'ready');
  assert.equal(finished.sawServerStart, true);
});

test('a same-date retry can settle from a newer Firestore update even if the advancing snapshot was missed', () => {
  const baseline = createHistoricalReplayAdvanceBaseline(
    control({
      status: 'error',
      lastError: 'Temporary lease collision.',
      message: 'Temporary lease collision.',
    }),
  );
  const finished = evaluateHistoricalReplayAdvance(
    baseline,
    control({
      status: 'ready',
      lastError: '',
      message: 'The same simulated date was retried successfully.',
      updatedAt: { seconds: 103, nanoseconds: 0 },
    }),
    false,
  );

  assert.equal(finished.state, 'ready');
});

test('a newly saved replay error releases the local request while preserving the server error', () => {
  const baseline = createHistoricalReplayAdvanceBaseline(control());
  const failed = evaluateHistoricalReplayAdvance(
    baseline,
    control({
      status: 'error',
      lastError: 'The scoring lease remained unavailable.',
      message: 'The scoring lease remained unavailable.',
      updatedAt: { seconds: 104, nanoseconds: 0 },
    }),
    true,
  );

  assert.equal(failed.state, 'error');
});

test('the unified transaction workbench presents the incoming decision before roster choices and optional timing detail', async () => {
  const template = await read('src/app/features/free-agents/free-agents.html');

  assert.ok(template.indexOf('transaction-incoming-row') < template.indexOf('transaction-roster-heading'));
  assert.match(template, /getMoveSummary\(\)/);
  assert.match(template, /getSelectedAssetCycleHeadline\(\)/);
  assert.match(template, /getSelectedAssetCycleDetail\(\)/);
  assert.match(template, /@for \(candidate of dropCandidates\(\)/);
  assert.match(template, /<details class="transaction-timing-details">/);
  assert.match(template, /getConfirmationTimingTitle\(\)/);
  assert.match(template, /getConfirmationTimingDetail\(\)/);
});

test('only one replacement comparison is expanded at a time and disclosure state resets between moves', async () => {
  const source = await read('src/app/features/free-agents/free-agents.ts');

  assert.match(source, /expandedCandidateSlotId = signal\(''\)/);
  assert.match(source, /slotId === candidate\.slotId \? '' : candidate\.slotId/);
  assert.match(source, /showFlexibleBenchOptions = signal\(false\)/);
  assert.match(source, /resetTransactionDisclosureState\(\)/);
  assert.match(source, /this\.incomingScheduleExpanded\.set\(false\)/);
  assert.match(source, /this\.incomingScoringExpanded\.set\(false\)/);
  assert.match(source, /this\.expandedCandidateSlotId\.set\(''\)/);
  assert.match(source, /this\.showFlexibleBenchOptions\.set\(false\)/);
  assert.match(source, /this\.startWindowScheduleExpanded\.set\(false\)/);
});

test('the final decision is compact and avoids repeating two full player cards', async () => {
  const template = await read('src/app/features/free-agents/free-agents.html');

  assert.match(template, /transaction-confirmation/);
  assert.match(template, /Selected move/);
  assert.match(template, /getMoveSummary\(\)/);
  assert.match(template, /getTopConfirmationDetail\(\)/);
  assert.match(template, /getConfirmButtonLabel\(\)/);
  assert.doesNotMatch(template, /class="transaction-player-pair"/);
  assert.doesNotMatch(template, /class="transaction-player-outgoing selected-final-player"/);
});

test('the replay button follows the Firestore control rather than waiting indefinitely for callable transport', async () => {
  const [source, template] = await Promise.all([
    read('src/app/features/cycles/cycle-one/cycle-one.ts'),
    read('src/app/features/cycles/cycle-one/cycle-one.html'),
  ]);

  assert.match(source, /createHistoricalReplayAdvanceBaseline/);
  assert.match(source, /reconcileReplayAdvanceFromControl\(control\)/);
  assert.match(source, /evaluateHistoricalReplayAdvance/);
  assert.match(source, /replayAdvanceGeneration/);
  assert.match(source, /isCurrentReplayAdvance\(generation\)/);
  assert.match(source, /cancelReplayAdvanceTracking\(\)/);
  assert.match(source, /this\.historicalReplayControl\(\)\?\.status === 'advancing'/);
  assert.match(template, /\[disabled\]="isHistoricalReplayAdvanceLocked\(\)"/);
  assert.match(template, /historical-replay-transport-note/);
});

test('other dense decision surfaces continue using progressive disclosure', async () => {
  const [gameFilm, freeAgents] = await Promise.all([
    read('src/app/features/cycles/cycle-asset-detail/cycle-asset-detail.html'),
    read('src/app/features/free-agents/free-agents.html'),
  ]);

  assert.match(gameFilm, /<details class="projection-metadata-card">/);
  assert.match(gameFilm, /<details class="breakdown-details">/);
  assert.match(freeAgents, /<details class="transaction-timing-details">/);
  assert.doesNotMatch(freeAgents, /role="dialog"|app-action-sheet|viewport-overlay/i);
});

test('M5.5 verification and documentation are available', async () => {
  const [packageJson, docs] = await Promise.all([
    read('package.json'),
    read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
  ]);

  assert.match(packageJson, /test:batchm5-5:run/);
  assert.match(packageJson, /verify:batchm5-5/);
  assert.match(docs, /Batch M5\.5 — Progressive Transaction Decisions and Replay Control Recovery/);
  assert.match(docs, /Hosting-only/);
});

test('competitive scoring, Projection V11, and Functions unrelated to later replay or draft recovery remain unchanged', async () => {
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
    '374217e5c5f20d2c9ca877a42c13f41eb501e2bb7a99b60206ceab1bbdd69fb9',
  );
});
