import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import test from 'node:test';

import {
  compareReleaseManifests,
  normalizeReleaseManifest,
  shortBuildIdentifier,
} from '../../src/app/core/release/release-manifest.util.ts';

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

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    releaseLabel: 'Release Candidate 5',
    buildId: 'release-candidate-5-20260805T180000000Z-abc1234567',
    builtAt: '2026-08-05T18:00:00.000Z',
    sourceRevision: 'abc1234567890',
    packageVersion: '0.0.0',
    scoringRulesVersion: 3,
    projectionVersion: 11,
    ...overrides,
  };
}

test('release manifests are normalized strictly before they can affect a live client', () => {
  const normalized = normalizeReleaseManifest(manifest());

  assert.ok(normalized);
  assert.equal(normalized.releaseLabel, 'Release Candidate 5');
  assert.equal(normalized.builtAt, '2026-08-05T18:00:00.000Z');
  assert.equal(normalized.scoringRulesVersion, 3);
  assert.equal(normalized.projectionVersion, 11);

  assert.equal(normalizeReleaseManifest(null), null);
  assert.equal(normalizeReleaseManifest(manifest({ schemaVersion: 2 })), null);
  assert.equal(normalizeReleaseManifest(manifest({ buildId: '' })), null);
  assert.equal(normalizeReleaseManifest(manifest({ builtAt: 'not-a-date' })), null);
  assert.equal(normalizeReleaseManifest(manifest({ scoringRulesVersion: 0 })), null);
  assert.equal(normalizeReleaseManifest(manifest({ projectionVersion: 11.5 })), null);
});

test('release comparison distinguishes current, newer, rollback, and ambiguous deployments', () => {
  const bundled = manifest();

  assert.equal(compareReleaseManifests(bundled, null), 'same');
  assert.equal(compareReleaseManifests(bundled, manifest()), 'same');
  assert.equal(
    compareReleaseManifests(
      bundled,
      manifest({ buildId: 'newer-build', builtAt: '2026-08-05T19:00:00.000Z' }),
    ),
    'newer',
  );
  assert.equal(
    compareReleaseManifests(
      bundled,
      manifest({ buildId: 'rollback-build', builtAt: '2026-08-05T17:00:00.000Z' }),
    ),
    'rollback',
  );
  assert.equal(
    compareReleaseManifests(
      bundled,
      manifest({ buildId: 'parallel-build', builtAt: bundled.builtAt }),
    ),
    'different',
  );
  assert.equal(shortBuildIdentifier(bundled), 'abc1234567');
  assert.equal(
    shortBuildIdentifier(manifest({ sourceRevision: 'unversioned', buildId: 'local-build-id' })),
    'l-build-id',
  );
  assert.equal(
    shortBuildIdentifier(manifest({
      sourceRevision: 'unversioned',
      buildId: 'release-candidate-5-20260805T181106689Z-local',
    })),
    '181106689',
  );
});

test('the generated public and bundled manifests agree with runtime model versions', async () => {
  const [manifestSource, generatedSource, developmentConfig, productionConfig, scoring, projection] =
    await Promise.all([
      read('public/release-manifest.json'),
      read('src/environments/generated-release-manifest.ts'),
      read('src/environments/app-runtime.config.ts'),
      read('src/environments/app-runtime.config.production.ts'),
      read('src/app/core/scoring/scoring-rules.ts'),
      read('src/app/core/projection/projection-snapshot.service.ts'),
    ]);
  const deployed = JSON.parse(manifestSource);

  const escapedReleaseLabel = deployed.releaseLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(deployed.releaseLabel, /^Release Candidate \d+$/);
  assert.match(developmentConfig, new RegExp(`releaseLabel:\\s*['"]${escapedReleaseLabel}['"]`));
  assert.match(productionConfig, new RegExp(`releaseLabel:\\s*['"]${escapedReleaseLabel}['"]`));
  assert.match(scoring, new RegExp(`CURRENT_SCORING_RULES_VERSION\\s*=\\s*${deployed.scoringRulesVersion}`));
  assert.match(projection, new RegExp(`SHARED_PROJECTION_VERSION\\s*=\\s*${deployed.projectionVersion}`));
  assert.match(generatedSource, /import type \{ ReleaseManifest \}/);
  assert.match(generatedSource, new RegExp(deployed.buildId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(Number.isFinite(Date.parse(deployed.builtAt)));
  assert.ok(deployed.buildId.length >= 12);
});

test('the release service checks safely on startup, interval, reconnect, and foreground return', async () => {
  const source = await read('src/app/core/release/release-update.service.ts');

  assert.match(source, /INITIAL_RELEASE_CHECK_DELAY_MILLISECONDS\s*=\s*4_000/);
  assert.match(source, /RELEASE_CHECK_INTERVAL_MILLISECONDS\s*=\s*2 \* 60 \* 1_000/);
  assert.match(source, /addEventListener\('online', this\.handleOnline\)/);
  assert.match(source, /addEventListener\('visibilitychange', this\.handleVisibilityChange\)/);
  assert.match(source, /cache:\s*'no-store'/);
  assert.match(source, /rinkratReleaseCheck/);
  assert.match(source, /credentials:\s*'same-origin'/);
  assert.match(source, /release_update_available/);
  assert.match(source, /release_update_reload_requested/);
  assert.match(source, /release_update_applied/);
  assert.match(source, /window\.location\.reload\(\)/);
  assert.match(source, /APPLIED_UPDATE_MAX_AGE_MILLISECONDS/);
});

test('a compact global banner waits for active actions and never uses a fuzzy blocking backdrop', async () => {
  const [source, template, styles, monitor] = await Promise.all([
    read('src/app/app.ts'),
    read('src/app/app.html'),
    read('src/app/app.css'),
    read('src/app/core/observability/competitive-action-monitor.service.ts'),
  ]);

  assert.match(source, /releaseUpdate\.start\(\)/);
  assert.match(source, /this\.actionMonitor\.activeCount\(\) > 0/);
  assert.match(source, /consumeAppliedUpdateNotice/);
  assert.match(template, /release-update-banner/);
  assert.match(source, /RELEASE_FORCE_RELOAD_DELAY_MILLISECONDS = 60_000/);
  assert.match(source, /'Reload Anyway'/);
  assert.match(source, /'Finishing action…'/);
  assert.match(source, /return 'Reload RinkRat'/);
  assert.match(template, /getReleaseBuildTransition\(\)/);
  assert.match(source, /shortBuildIdentifier/);
  assert.doesNotMatch(template, /backdrop/i);
  assert.match(styles, /position:\s*fixed/);
  assert.match(styles, /safe-area-inset-top/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.match(monitor, /readonly activeCount = signal\(0\)/);
  assert.match(monitor, /this\.activeCount\.set\(this\.activeActions\.size\)/);
});

test('stale tabs block protected roster, waiver, draft, lineup, IR, and replay actions', async () => {
  const [health, freeAgents, teamSource, teamTemplate, draft, replay] = await Promise.all([
    read('src/app/core/observability/client-health.service.ts'),
    read('src/app/features/free-agents/free-agents.ts'),
    read('src/app/features/team/team-settings/team-settings.ts'),
    read('src/app/features/team/team-settings/team-settings.html'),
    read('src/app/features/draft/draft-room/draft-room.ts'),
    read('src/app/features/cycles/cycle-one/cycle-one.ts'),
  ]);

  assert.match(health, /competitiveActionNeedsReload = computed/);
  assert.match(health, /!this\.competitiveActionNeedsReload\(\)/);
  assert.match(health, /A different RinkRat build is now live/);
  assert.match(freeAgents, /competitiveActionNeedsReload\(\)[\s\S]*Reload RinkRat/);
  assert.match(teamSource, /getCompetitiveActionButtonBlockLabel/);
  assert.match(teamTemplate, /getCompetitiveActionButtonBlockLabel\(\)/);
  assert.match(draft, /!this\.releaseUpdate\.updateAvailable\(\)/);
  assert.match(draft, /Reload this tab before changing the queue, clock, Auto-Draft, or making another pick/);
  assert.match(draft, /this\.actionMonitor\.begin\('draft-queue'\)/);
  assert.match(draft, /this\.actionMonitor\.begin\('draft-auto'\)/);
  assert.match(draft, /this\.actionMonitor\.begin\('draft-clock'\)/);
  assert.match(replay, /competitiveActionNeedsReload\(\)[\s\S]*Reload RinkRat/);
});

test('Support and Release Readiness expose privacy-limited build fingerprints and safe reload controls', async () => {
  const [supportSource, supportTemplate, readinessSource, readinessTemplate] = await Promise.all([
    read('src/app/features/support/support-home/support-home.ts'),
    read('src/app/features/support/support-home/support-home.html'),
    read('src/app/features/release/release-readiness/release-readiness.ts'),
    read('src/app/features/release/release-readiness/release-readiness.html'),
  ]);

  assert.match(supportSource, /BUNDLED_RELEASE_MANIFEST/);
  assert.match(supportSource, /releaseDeployment:\s*this\.releaseUpdate\.getSnapshot\(\)|releaseDeployment:\s*this\.releaseUpdate\.getSnapshot/);
  assert.match(supportTemplate, /This tab/);
  assert.match(supportTemplate, /Deployed/);
  assert.match(supportTemplate, /Check for Update/);
  assert.match(supportTemplate, /Reload RinkRat/);
  assert.match(readinessSource, /checkForReleaseUpdate/);
  assert.match(readinessSource, /reloadForReleaseUpdate/);
  assert.match(readinessTemplate, /Client build freshness/);
  assert.match(readinessTemplate, /Scoring V/);
  assert.match(readinessTemplate, /Projection V/);
  assert.match(readinessTemplate, /Check Deployed Build/);
  assert.match(readinessTemplate, /Finishing Current Action/);
  assert.match(readinessTemplate, /Reload Deployed Build/);
  assert.match(supportSource, /getDeploymentStatusLabel/);
});

test('Firebase Hosting and project scripts generate a no-cache manifest before each build', async () => {
  const [firebaseSource, packageSource, generator, validator, gitignore] = await Promise.all([
    read('firebase.json'),
    read('package.json'),
    read('scripts/generate-release-manifest.mjs'),
    read('scripts/validate-release-manifest.mjs'),
    read('.gitignore'),
  ]);
  const firebase = JSON.parse(firebaseSource);
  const packageJson = JSON.parse(packageSource);
  const header = firebase.hosting.headers.find((entry) => entry.source === '/release-manifest.json');

  assert.ok(header);
  assert.ok(header.headers.some((item) =>
    item.key === 'Cache-Control' && /no-cache.*no-store.*must-revalidate/.test(item.value)));
  assert.match(packageJson.scripts.prebuild, /generate:release-manifest/);
  assert.match(packageJson.scripts.prestart, /generate:release-manifest/);
  assert.match(packageJson.scripts.prewatch, /generate:release-manifest/);
  assert.match(packageJson.scripts.pretest, /generate:release-manifest/);
  assert.match(packageJson.scripts['pretest:batchr1a:run'], /generate:release-manifest/);
  assert.match(packageJson.scripts['verify:batchr1a'], /validate:release-manifest/);
  assert.match(packageJson.scripts['test:batchr1a:run'], /batchr1a-release-safety/);
  assert.match(generator, /public\/release-manifest\.json/);
  assert.match(generator, /generated-release-manifest\.ts/);
  assert.match(generator, /:\(exclude\)public\/release-manifest\.json/);
  assert.match(generator, /:\(exclude\)src\/environments\/generated-release-manifest\.ts/);
  assert.match(gitignore, /\/public\/release-manifest\.json/);
  assert.match(gitignore, /\/src\/environments\/generated-release-manifest\.ts/);
  assert.match(validator, /release-manifest\.json must use a no-store cache policy/);
});

test('R1A documentation records deployment order, rollback behavior, and protected action safety', async () => {
  const documentation = await read('docs/RINKRAT_PROJECT_DOCUMENTATION.md');

  assert.match(documentation, /^## Batch R1A — Safe Updates and Release Preflight/m);
  assert.match(documentation, /Release Candidate 5/);
  assert.match(documentation, /release-manifest\.json/);
  assert.match(documentation, /stale tab/i);
  assert.match(documentation, /action already in progress|protected competitive action/i);
  assert.match(documentation, /Hosting-only/i);
  assert.match(documentation, /rollback/i);
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
    'a37d7c47e9ffcb6a4549e5ad078a918b812619c014fcf01373025bacfa9c1a8c',
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
        'src/league-automation.ts',
        'src/shared/core/cycle/cycle.service.ts',
        'src/shared/core/projection/window-projection.service.ts',
        'src/draft-authority.ts',
        'src/draft-automation.ts',
        'src/shared/core/draft/draft.models.ts',
      ]),
    ),
    '8abd041f045f31ea1a51a484f74ec7b7a2f5ca40364e33360a0455d2623d12c2',
  );
});
