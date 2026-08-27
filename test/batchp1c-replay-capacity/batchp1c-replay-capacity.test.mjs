import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import { fileURLToPath } from 'node:url';

import { buildCapacityReport } from '../../scripts/capacity/rinkrat-capacity-model.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');

async function read(relativePath) {
  return fs.readFile(path.join(root, relativePath), 'utf8');
}

async function hashTree(relativeDirectory, excludedPaths = new Set()) {
  const rootPath = path.join(root, relativeDirectory);
  const files = [];

  async function visit(currentPath, relativePath = '') {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries.sort((first, second) => first.name.localeCompare(second.name))) {
      if (entry.name === 'node_modules' || entry.name === 'lib') {
        continue;
      }

      const childPath = path.join(currentPath, entry.name);
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
    const metadata = await fs.stat(file.path);
    const bytes = await fs.readFile(file.path);
    const pathBytes = Buffer.from(file.relativePath);

    digest.update(Buffer.from(Uint32Array.of(pathBytes.length).buffer).reverse());
    digest.update(pathBytes);
    digest.update(Buffer.from(BigUint64Array.of(BigInt(metadata.size)).buffer).reverse());
    digest.update(bytes);
  }

  return digest.digest('hex');
}

test('replay callable no longer depends on a long browser transport deadline', async () => {
  const source = await read('src/app/core/replay/historical-replay.service.ts');

  assert.match(source, /QueueHistoricalReplayResult/);
  assert.match(source, /advanceHistoricalReplayDay'[\s\S]*timeout:\s*60_000/);
  assert.match(source, /Firestore remains the authoritative queued\/advancing\/ready signal/);
});

test('historical replay uses saved projections without blocking score advancement on a league-wide rebuild', async () => {
  const [bundleSource, cycleSource, automationSource] = await Promise.all([
    read('functions/src/shared/core/projection/window-projection.service.ts'),
    read('functions/src/shared/core/cycle/cycle.service.ts'),
    read('functions/src/league-automation.ts'),
  ]);

  assert.match(bundleSource, /WindowProjectionRefreshPolicy/);
  assert.match(bundleSource, /input\.refreshPolicy === 'saved-only'/);
  assert.match(bundleSource, /loadSharedProjectionSnapshot\(\s*input\.leagueId/);
  assert.match(bundleSource, /generateSharedProjectionSnapshot/);

  const savedOnlyIndex = bundleSource.indexOf("input.refreshPolicy === 'saved-only'");
  const generationIndex = bundleSource.indexOf('generateSharedProjectionSnapshot({');
  assert.ok(savedOnlyIndex >= 0 && generationIndex > savedOnlyIndex);

  assert.match(cycleSource, /projectionRefreshPolicy:\s*WindowProjectionRefreshPolicy/);
  assert.match(cycleSource, /options\.projectionRefreshPolicy \?\? 'refresh-if-needed'/);
  assert.match(automationSource, /replayControl\s*\? 'saved-only' as const\s*:\s*'refresh-if-needed' as const/);
  assert.match(automationSource, /persistServerScoring\([\s\S]*projectionRefreshPolicy/);
});

test('a browser transport deadline no longer turns a healthy replay worker into a false error', async () => {
  const source = await read('src/app/features/cycles/cycle-one/cycle-one.ts');

  assert.match(source, /control\?\.status === 'queued'[\s\S]*control\?\.status === 'advancing'/);
  assert.match(source, /browser response timed out, but the replay worker is still finishing safely/);
  assert.match(source, /listener unlocks at ready\/error/);
});

test('the 100K capacity model inspects real source limits and labels itself as an estimate', async () => {
  const report = await buildCapacityReport({
    users: 100_000,
    managersPerLeague: 10,
    scenario: 'balanced',
    format: 'json',
  });

  assert.equal(report.modelType, 'capacity-estimate-not-live-load-test');
  assert.equal(report.scenario.leagues, 10_000);
  assert.ok(report.estimates.concurrentFirestoreListeners >= 500_000);
  assert.ok(report.estimates.coldStartDocumentReads >= 1_000_000);
  assert.equal(report.architecture.draftDeadlineTaskQueuePresent, true);
  assert.equal(report.architecture.draftDeadlineTaskDeterministicIds, true);
  assert.equal(report.architecture.draftDeadlineTaskMaxConcurrentDispatches, 10);
  assert.equal(report.architecture.draftAutomationScanLimit, 250);
  assert.equal(report.architecture.leagueAutomationParallelism, 2);
  assert.equal(report.architecture.nhlProxyMaxInstances, 10);
  assert.ok(report.findings.some((finding) =>
    finding.severity === 'amber' && finding.area === 'Draft Deadline Task Queue'
  ));
  assert.ok(report.findings.some((finding) =>
    finding.severity === 'amber' && finding.area === 'Draft Recovery Sweeper'
  ));
  assert.ok(report.findings.some((finding) =>
    finding.severity === 'amber' && finding.area === 'League Scoring Queue Foundation'
  ));
  assert.ok(report.findings.some((finding) =>
    finding.severity === 'red' && finding.area === 'League Scoring Queue Cutover'
  ));
});

test('draft-night and game-night scenarios expose different peak traffic shapes', async () => {
  const [draftNight, gameNight] = await Promise.all([
    buildCapacityReport({
      users: 100_000,
      managersPerLeague: 10,
      scenario: 'draft-night',
      format: 'json',
    }),
    buildCapacityReport({
      users: 100_000,
      managersPerLeague: 10,
      scenario: 'game-night',
      format: 'json',
    }),
  ]);

  assert.ok(draftNight.estimates.draftPickRequestsPerSecond > 0);
  assert.equal(gameNight.estimates.draftPickRequestsPerSecond, 0);
  assert.ok(
    gameNight.estimates.concurrentFirestoreListeners >
      draftNight.estimates.concurrentFirestoreListeners,
  );
});

test('capacity documentation requires a separate staged project instead of production traffic', async () => {
  const documentation = await read('docs/RINKRAT_100K_CAPACITY_PLAN.md');

  assert.match(documentation, /Never point (?:a|the) large test at production/);
  assert.match(documentation, /100, 500, 2,000, and 5,000 concurrent clients/);
  assert.match(documentation, /idempotent per-league Cloud Tasks/);
  assert.match(documentation, /default 70-second deadline/);
});


test('P1C verification, deployment order, and consolidated documentation are present', async () => {
  const [packageSource, documentation] = await Promise.all([
    read('package.json'),
    read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.match(packageJson.scripts['test:batchp1c:run'], /batchp1c-replay-capacity/);
  assert.match(packageJson.scripts['verify:batchp1c'], /verify:batchr1a-1/);
  assert.match(packageJson.scripts['verify:batchp1c'], /capacity:100k/);
  assert.match(documentation, /^## Batch P1C — Replay Responsiveness and 100K Capacity Lab/m);
  assert.match(documentation, /functions:advanceHistoricalReplayDay/);
  assert.match(documentation, /No Firestore rules, indexes, or data migration are required/);
});

test('P1C replay paths remain isolated from later draft recovery changes inside the Functions tree', async () => {
  const exclusions = new Set([
    'src/index.ts',
    'src/league-lifecycle-authority.ts',
    'src/league-lifecycle-authority.util.ts',
    'src/league-automation.ts',
    'src/shared/core/cycle/cycle.service.ts',
    // D1D adds an exact-internal-Canary-only NHL freshness profile without changing replay.
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
        // A1D fixes replay player-data alignment and adds isolated private-note authority.
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
  ]);

  assert.equal(
    await hashTree('functions', exclusions),
    'ac1c74faa731629cedf0ea8a4362b4bdb59c802a01d0464589b217a7074ea759',
  );

  const [rules, engine, projection, firestoreRules, indexes] = await Promise.all([
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/scoring/scoring-engine.ts'),
    read('src/app/core/projection/projection-v11.util.ts'),
    read('firestore.rules'),
    read('firestore.indexes.json'),
  ]);

  assert.equal(createHash('sha256').update(rules).digest('hex'), '74107aa688b4a3825c52fe14003cd824485197fd3559822fab4134bff940e2da');
  assert.equal(createHash('sha256').update(engine).digest('hex'), '6f36cf76c72f8199c6a3891692844c9c830103ed618be50497b5270e259da3d3');
  assert.equal(createHash('sha256').update(projection).digest('hex'), 'e6f3111b1feccc7107e857aa24c5317451c65a84a36c71f8158947636f20d80a');
  assert.equal(createHash('sha256').update(firestoreRules).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreRules);
  assert.equal(createHash('sha256').update(indexes).digest('hex'), '62f09a69e4e487eb9bfa1935e874d32a07e8fa0cddba48205903d62e19261a13');
});

