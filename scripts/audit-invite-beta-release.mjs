#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);

async function read(path) {
  return readFile(new URL(path, ROOT), 'utf8');
}

function extractString(source, property) {
  return source.match(new RegExp(`${property}\\s*:\\s*['\"]([^'\"]+)['\"]`))?.[1] ?? '';
}

function extractBoolean(source, property) {
  return source.match(new RegExp(`${property}\\s*:\\s*(true|false)`))?.[1] === 'true';
}

const [
  packageSource,
  developmentRuntime,
  productionRuntime,
  appCheckConfig,
  routes,
  readinessTemplate,
  boardSource,
  boardTemplate,
  storeSource,
  firebaseSource,
  capacitySource,
  scaleBlueprint,
] = await Promise.all([
  read('package.json'),
  read('src/environments/app-runtime.config.ts'),
  read('src/environments/app-runtime.config.production.ts'),
  read('src/environments/app-check.config.ts'),
  read('src/app/app.routes.ts'),
  read('src/app/features/release/release-readiness/release-readiness.html'),
  read('src/app/features/release/invite-beta-validation/invite-beta-validation.ts'),
  read('src/app/features/release/invite-beta-validation/invite-beta-validation.html'),
  read('src/app/core/release/invite-beta-validation.store.ts'),
  read('firebase.json'),
  read('scripts/capacity/rinkrat-capacity-model.mjs'),
  read('docs/RINKRAT_HIGH_SCALE_AUTOMATION_BLUEPRINT.md'),
]);

const packageJson = JSON.parse(packageSource);
const firebaseJson = JSON.parse(firebaseSource);
const errors = [];
const warnings = [];
const developmentLabel = extractString(developmentRuntime, 'releaseLabel');
const productionLabel = extractString(productionRuntime, 'releaseLabel');

if (!developmentLabel || developmentLabel !== productionLabel) {
  errors.push('Development and production release labels must match.');
}

if (productionLabel !== 'Release Candidate 6') {
  errors.push(`Expected Release Candidate 6, found ${productionLabel || 'missing label'}.`);
}

if (extractString(productionRuntime, 'scoringMode') !== 'live') {
  errors.push('Production scoringMode must remain live.');
}

if (extractBoolean(productionRuntime, 'developerToolsEnabled')) {
  errors.push('Production developer tools must remain disabled.');
}

if (extractBoolean(productionRuntime, 'productionHistoricalScoringAllowed')) {
  errors.push('Production historical scoring must remain blocked.');
}

if (!/path:\s*'leagues\/:leagueId\/release-readiness'[\s\S]*platformAdminGuard/.test(routes)) {
  errors.push('Release Readiness must remain protected by the platform-admin guard.');
}

if (!readinessTemplate.includes('<app-invite-beta-validation')) {
  errors.push('Release Readiness does not mount the invite-beta validation board.');
}

if (!boardTemplate.includes('Invite Beta Validation Board')) {
  errors.push('Invite-beta board heading is missing.');
}

if (!boardTemplate.includes('Copy Validation Report')) {
  errors.push('Invite-beta report export control is missing.');
}

if (!boardTemplate.includes('RINKRAT_HIGH_SCALE_AUTOMATION_BLUEPRINT.md')) {
  errors.push('The validation board does not preserve the high-scale architecture note location.');
}

if (!boardSource.includes('calculateInviteBetaLaunchGate')) {
  errors.push('Invite-beta launch gate calculation is not wired into the component.');
}

if (!storeSource.includes('window.localStorage')) {
  errors.push('Build-specific local validation persistence is missing.');
}

if (/firebase\/firestore|from ['\"].*firebase/.test(storeSource)) {
  errors.push('Manual validation storage must not introduce Firestore writes.');
}

const manifestHeader = firebaseJson.hosting?.headers?.find(
  (entry) => entry.source === '/release-manifest.json',
);
if (!manifestHeader) {
  errors.push('release-manifest.json needs an explicit no-cache Hosting header.');
} else {
  const cacheValue = manifestHeader.headers?.find((header) => header.key === 'Cache-Control')?.value ?? '';
  if (!/no-store/i.test(cacheValue)) {
    errors.push('release-manifest.json must use no-store caching.');
  }
}

if (!packageJson.scripts?.['test:batchr1b-p1d:run']) {
  errors.push('The R1B-P1D focused test script is missing.');
}

if (!packageJson.scripts?.['verify:batchr1b-p1d']?.includes('verify:batchp1c')) {
  errors.push('Batch R1B-P1D verification must include the previous P1C chain.');
}

if (!capacitySource.includes('draftDeadlineTaskQueuePresent')) {
  errors.push('The capacity model does not recognize the existing exact draft task queue.');
}

for (const requiredText of [
  'functions/src/league-automation.ts',
  'processLeagueAutomationTask',
  'functions/src/draft-automation.ts',
  'functions/src/index.ts',
  'deterministic idempotency key',
  'shadow mode',
  'Rollback',
]) {
  if (!scaleBlueprint.includes(requiredText)) {
    errors.push(`High-scale blueprint is missing: ${requiredText}`);
  }
}

const appCheckEnabled = extractBoolean(appCheckConfig, 'enabled');
const appCheckSiteKey = extractString(appCheckConfig, 'recaptchaEnterpriseSiteKey');
if (!appCheckEnabled || !appCheckSiteKey) {
  warnings.push(
    'Firebase App Check monitoring is not configured yet. The Launch Gate will keep this visible until a public reCAPTCHA Enterprise site key is added.',
  );
}

if (errors.length) {
  console.error('Invite-beta release audit failed:');
  for (const error of errors) {
    console.error(`  ✗ ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log('Invite-beta release and high-scale handoff audit passed.');
}

for (const warning of warnings) {
  console.warn(`  ! ${warning}`);
}
