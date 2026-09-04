import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

import {
  buildD1nStagingHostingConfig,
  D1N_STAGING_HOSTING_CONFIG_PATH,
  D1N_STAGING_PROJECT_ID,
} from '../../scripts/capacity/prepare-d1n-staging-hosting.mjs';
import {
  assertD1nStagingSeedSafety,
  D1N_STAGING_SEED_ACKNOWLEDGEMENT,
} from '../../scripts/capacity/seed-d1n-staging-fixture.mjs';

const ROOT = new URL('../../', import.meta.url);
const read = (relativePath) => readFile(new URL(relativePath, ROOT), 'utf8');

async function readStagingJavaScriptArtifact() {
  const artifactDirectory = new URL('dist/fantasy-hockey/browser/', ROOT);
  const entries = await readdir(artifactDirectory, { withFileTypes: true, recursive: true });
  const sourceFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.js'));

  assert.ok(sourceFiles.length > 0, 'build:staging must create JavaScript artifacts');

  return (await Promise.all(sourceFiles.map((entry) => {
    const relativeParent = entry.parentPath.slice(
      new URL(artifactDirectory).pathname.length,
    );
    return read(`dist/fantasy-hockey/browser/${relativeParent}/${entry.name}`);
  }))).join('\n');
}

test('the compile-time staging build cannot select Production Firebase', async () => {
  const [angularSource, stagingFirebase, productionFirebase] = await Promise.all([
    read('angular.json'),
    read('src/environments/firebase-config.staging.ts'),
    read('src/environments/firebase-config.ts'),
  ]);
  const angular = JSON.parse(angularSource);
  const staging = angular.projects['fantasy-hockey'].architect.build.configurations.staging;
  const replacements = new Map(
    staging.fileReplacements.map((replacement) => [replacement.replace, replacement.with]),
  );

  assert.equal(
    replacements.get('src/environments/firebase-config.ts'),
    'src/environments/firebase-config.staging.ts',
  );
  assert.equal(
    replacements.get('src/environments/app-runtime.config.ts'),
    'src/environments/app-runtime.config.production.ts',
  );
  assert.equal(
    replacements.get('src/environments/app-check.config.ts'),
    'src/environments/app-check.config.staging.ts',
  );
  assert.match(stagingFirebase, new RegExp(`projectId: '${D1N_STAGING_PROJECT_ID}'`));
  assert.doesNotMatch(stagingFirebase, /nhl-fantasy-app-ab673/);
  assert.match(productionFirebase, /projectId: "nhl-fantasy-app-ab673"/);
  assert.doesNotMatch(productionFirebase, new RegExp(D1N_STAGING_PROJECT_ID));
});

test('staging App Check is isolated without changing Production monitor mode', async () => {
  const [stagingAppCheck, productionAppCheck] = await Promise.all([
    read('src/environments/app-check.config.staging.ts'),
    read('src/environments/app-check.config.ts'),
  ]);

  assert.match(stagingAppCheck, /enabled: false/);
  assert.match(stagingAppCheck, /localDebugTokenEnabled: false/);
  assert.doesNotMatch(stagingAppCheck, /6Lc_on8tAAAAAMcZ0UAtbBr9cpO5qJidjSIPOb5F/);
  assert.match(productionAppCheck, /enabled: true/);
  assert.match(productionAppCheck, /localDebugTokenEnabled: false/);
});

test('the compiled staging artifact contains only the staging Firebase connection tuple', async () => {
  const artifact = await readStagingJavaScriptArtifact();
  const productionProjectMatches = artifact.match(/nhl-fantasy-app-ab673/g) ?? [];

  assert.match(artifact, /rinkrat-staging-d1nc-2026\.firebaseapp\.com/);
  assert.match(artifact, /rinkrat-staging-d1nc-2026\.firebasestorage\.app/);
  assert.match(artifact, /817415114086/);
  assert.match(artifact, /1:817415114086:web:d8be39fcb0b05074b28ca7/);

  // The one retained Production project ID is an inert fail-closed comparison
  // in the season-launch evidence report. No other Production connection value
  // may survive the staging file replacement.
  assert.equal(productionProjectMatches.length, 1);
  assert.doesNotMatch(artifact, /nhl-fantasy-app-ab673\.firebaseapp\.com/);
  assert.doesNotMatch(artifact, /nhl-fantasy-app-ab673\.firebasestorage\.app/);
  assert.doesNotMatch(artifact, /721213878690/);
  assert.doesNotMatch(artifact, /1:721213878690:web:1c5ba29562b332f84e02fb/);
  assert.doesNotMatch(artifact, /G-063BT3987X/);
});

test('generated staging Hosting config is site-pinned and has no Function rewrites', async () => {
  const sourceConfig = JSON.parse(await read('firebase.json'));
  const generated = buildD1nStagingHostingConfig(sourceConfig);

  assert.equal(generated.hosting.site, D1N_STAGING_PROJECT_ID);
  assert.equal('target' in generated.hosting, false);
  assert.deepEqual(generated.hosting.rewrites, [
    { source: '**', destination: '/index.html' },
  ]);
  assert.deepEqual(generated.hosting.headers, sourceConfig.hosting.headers);
  assert.equal(generated.hosting.public, sourceConfig.hosting.public);
  assert.deepEqual(generated.hosting.predeploy, [
    'npm --prefix "$PROJECT_DIR" run release:verify-clean-deploy-source',
    'npm --prefix "$PROJECT_DIR" run build:staging',
    'npm --prefix "$PROJECT_DIR" run release:verify-clean-deploy-source',
  ]);
  assert.equal('functions' in generated, false);
  assert.equal('firestore' in generated, false);
});

test('staging scripts prepare evidence but never deploy or select Production', async () => {
  const [packageSource, generatorSource, seedSource, gitignore] = await Promise.all([
    read('package.json'),
    read('scripts/capacity/prepare-d1n-staging-hosting.mjs'),
    read('scripts/capacity/seed-d1n-staging-fixture.mjs'),
    read('.gitignore'),
  ]);
  const scripts = JSON.parse(packageSource).scripts;

  assert.equal(scripts['build:staging'], 'ng build --configuration staging');
  assert.equal(
    scripts['staging:d1n:prepare-hosting'],
    'node scripts/capacity/prepare-d1n-staging-hosting.mjs',
  );
  assert.doesNotMatch(scripts['staging:d1n:prepare-hosting'], /firebase\s+deploy/);
  assert.equal(
    scripts['staging:d1n:seed'],
    'node scripts/capacity/seed-d1n-staging-fixture.mjs',
  );
  assert.doesNotMatch(generatorSource, /nhl-fantasy-app-ab673/);
  assert.doesNotMatch(seedSource, /nhl-fantasy-app-ab673/);
  assert.doesNotMatch(seedSource, /firebase\s+deploy/);
  assert.match(gitignore, new RegExp(`/${D1N_STAGING_HOSTING_CONFIG_PATH.replace('.', '\\.')}`));
});

test('staging fixture writes require exact project, acknowledgement, and secret password', () => {
  const validEnvironment = {
    D1N_STAGING_PROJECT_ID,
    D1N_STAGING_ACK: D1N_STAGING_SEED_ACKNOWLEDGEMENT,
    D1N_STAGING_FIXTURE_PASSWORD: 'D1N-Staging-Secret-2026!',
    D1N_FIXTURE_DRAFT_STATUS: 'scheduled',
    D1N_FIXTURE_DRAFT_START_OFFSET_MINUTES: '45',
  };

  assert.deepEqual(assertD1nStagingSeedSafety(validEnvironment), {
    password: validEnvironment.D1N_STAGING_FIXTURE_PASSWORD,
    draftStatus: 'scheduled',
    draftStartOffsetMinutes: 45,
  });
  assert.throws(
    () => assertD1nStagingSeedSafety({ ...validEnvironment, D1N_STAGING_PROJECT_ID: 'wrong' }),
    /must equal/,
  );
  assert.throws(
    () => assertD1nStagingSeedSafety({ ...validEnvironment, D1N_STAGING_ACK: 'wrong' }),
    /does not authorize/,
  );
  assert.throws(
    () => assertD1nStagingSeedSafety({
      ...validEnvironment,
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    }),
    /refuses every Emulator Suite environment/,
  );
  assert.throws(
    () => assertD1nStagingSeedSafety({
      ...validEnvironment,
      D1N_STAGING_FIXTURE_PASSWORD: 'too-short',
    }),
    /20–128 characters/,
  );
  assert.throws(
    () => assertD1nStagingSeedSafety({
      ...validEnvironment,
      D1N_FIXTURE_DRAFT_START_OFFSET_MINUTES: '0',
    }),
    /must be an integer from 1 to 10080/,
  );
});
