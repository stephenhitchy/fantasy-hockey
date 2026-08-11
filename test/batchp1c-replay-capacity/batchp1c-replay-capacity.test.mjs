import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
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
  ]);

  assert.equal(
    await hashTree('functions', exclusions),
    '2a1fb1e2cb40222f626de6b2abb39a0e58a9e4d6d7c2cb3897bd36313fcbbff8',
  );

  const [rules, engine, projection, firestoreRules, indexes] = await Promise.all([
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/scoring/scoring-engine.ts'),
    read('src/app/core/projection/projection-v11.util.ts'),
    read('firestore.rules'),
    read('firestore.indexes.json'),
  ]);

  assert.equal(createHash('sha256').update(rules).digest('hex'), 'd0ba8838c17737b00cdc5f0dea5e24ffb4e1af2154c2575baf28c3aa83de4901');
  assert.equal(createHash('sha256').update(engine).digest('hex'), 'f9cdb69372437c4cf4e70e678d98227d8777ccc13d37b7ef000ac71ba36d4e15');
  assert.equal(createHash('sha256').update(projection).digest('hex'), 'e6f3111b1feccc7107e857aa24c5317451c65a84a36c71f8158947636f20d80a');
  assert.equal(createHash('sha256').update(firestoreRules).digest('hex'), '30feadadcd17e001c22e09b05d36f981847dc756131cdc776246f1617090878a');
  assert.equal(createHash('sha256').update(indexes).digest('hex'), 'c18738f1fe9547da2c59fbcd6b3d725db8ea8ff1f190ca82cc0c1b27ebc0d8a0');
});

