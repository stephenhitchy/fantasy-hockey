import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function read(relativePath) {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

const [
  configSource,
  bootstrapSource,
  s3aTestSource,
  configureScriptSource,
  packageSource,
  readmeSource,
  documentationSource,
  setupGuideSource,
  roadmapRootSource,
  roadmapDocsSource,
] = await Promise.all([
  read('src/environments/app-check.config.ts'),
  read('src/app/core/firebase-app-check.ts'),
  read('test/batchs3a-app-check-auth-hardening/batchs3a-app-check-auth-hardening.test.mjs'),
  read('scripts/configure-app-check.mjs'),
  read('package.json'),
  read('README.md'),
  read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
  read('docs/RINKRAT_SECURITY_S3A_SETUP.md'),
  read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
  read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
]);

function parseBoolean(propertyName) {
  const match = configSource.match(new RegExp(`${propertyName}:\\s*(true|false)`));
  assert.ok(match, `${propertyName} must be declared in App Check config.`);
  return match[1] === 'true';
}

function parseSiteKey() {
  const match = configSource.match(/recaptchaEnterpriseSiteKey:\s*'([^']*)'/);
  assert.ok(match, 'The public reCAPTCHA Enterprise site key must be declared.');
  return match[1];
}

test('configured App Check monitor mode is a valid verification state', () => {
  assert.equal(parseBoolean('enabled'), true);
  assert.match(parseSiteKey(), /^[A-Za-z0-9_-]{20,250}$/);
  assert.equal(parseBoolean('tokenAutoRefreshEnabled'), true);
  assert.equal(parseBoolean('localDebugTokenEnabled'), false);

  assert.match(bootstrapSource, /ReCaptchaEnterpriseProvider/);
  assert.match(bootstrapSource, /FIREBASE_APP_CHECK_CONFIG\.localDebugTokenEnabled/);
  assert.match(bootstrapSource, /isLocalDevelopmentHost\(\)/);
  assert.match(bootstrapSource, /hostname === 'localhost'/);
});

test('the original S3A test accepts both disabled templates and configured public keys', () => {
  assert.match(s3aTestSource, /const appCheckEnabled = enabledMatch\[1\] === 'true'/);
  assert.match(s3aTestSource, /Enabled App Check must include a valid public reCAPTCHA Enterprise site key/);
  assert.match(s3aTestSource, /Disabled App Check should not retain a production site key/);
  assert.doesNotMatch(s3aTestSource, /assert\.match\(appCheckConfigSource, \/enabled: false\//);
});

test('production configuration and localhost debug configuration remain separate', () => {
  assert.match(configureScriptSource, /const debugEnabled = args\.includes\('--local-debug'\)/);
  assert.match(configureScriptSource, /localDebugTokenEnabled:/);
  assert.match(setupGuideSource, /without `--local-debug`/);
  assert.match(setupGuideSource, /localDebugTokenEnabled: false/);
  assert.match(setupGuideSource, /registered debug token/);
});

test('S3A.1 verification, documentation, and permanent roadmap stay synchronized', () => {
  const packageJson = JSON.parse(packageSource);

  assert.equal(
    packageJson.scripts['test:batchs3a-1:run'],
    'node --no-warnings --experimental-strip-types --test --test-concurrency=1 test/batchs3a-1-configured-app-check/*.test.mjs',
  );
  assert.match(packageJson.scripts['verify:batchs3a-1'], /verify:batchs3a/);
  assert.match(packageJson.scripts['verify:batchs3a-1'], /test:batchs3a-1:run/);
  assert.match(packageJson.scripts['verify:batchs3a-1'], /validate:release-manifest/);
  assert.match(readmeSource, /Security S3A\.1/);
  assert.match(documentationSource, /Security Batch S3A\.1 — Configured App Check Verification Hotfix/);
  assert.equal(roadmapRootSource, roadmapDocsSource);
  assert.match(roadmapRootSource, /Version 1\.6\.1/);
  assert.match(roadmapRootSource, /LOG\.10 .*S3A\.1 configured-state verification hotfix/);
});
