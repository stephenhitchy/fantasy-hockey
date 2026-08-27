import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  canRegisterRinkRatServiceWorker,
  isRinkRatStandaloneDisplay,
  resolveRinkRatPwaInstallState,
} from '../../src/app/core/pwa/rinkrat-pwa.util.ts';
import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('PWA registration and install states stay explicit and production-gated', () => {
  assert.equal(canRegisterRinkRatServiceWorker({
    developerToolsEnabled: false,
    secureContext: true,
    serviceWorkerSupported: true,
  }), true);
  assert.equal(canRegisterRinkRatServiceWorker({
    developerToolsEnabled: true,
    secureContext: true,
    serviceWorkerSupported: true,
  }), false);
  assert.equal(canRegisterRinkRatServiceWorker({
    developerToolsEnabled: false,
    secureContext: false,
    serviceWorkerSupported: true,
  }), false);
  assert.equal(canRegisterRinkRatServiceWorker({
    developerToolsEnabled: false,
    secureContext: true,
    serviceWorkerSupported: false,
  }), false);

  assert.equal(isRinkRatStandaloneDisplay({
    displayModeStandalone: true,
    navigatorStandalone: false,
  }), true);
  assert.equal(isRinkRatStandaloneDisplay({
    displayModeStandalone: false,
    navigatorStandalone: true,
  }), true);
  assert.equal(isRinkRatStandaloneDisplay({
    displayModeStandalone: false,
    navigatorStandalone: false,
  }), false);

  assert.equal(resolveRinkRatPwaInstallState({
    installed: true,
    installPromptAvailable: true,
    serviceWorkerSupported: true,
  }), 'installed');
  assert.equal(resolveRinkRatPwaInstallState({
    installed: false,
    installPromptAvailable: true,
    serviceWorkerSupported: true,
  }), 'installable');
  assert.equal(resolveRinkRatPwaInstallState({
    installed: false,
    installPromptAvailable: false,
    serviceWorkerSupported: true,
  }), 'manual');
  assert.equal(resolveRinkRatPwaInstallState({
    installed: false,
    installPromptAvailable: false,
    serviceWorkerSupported: false,
  }), 'unsupported');
});

test('the web manifest contains the bounded standalone RinkRat install contract', async () => {
  const manifest = JSON.parse(await read('public/site.webmanifest'));

  assert.equal(manifest.id, '/');
  assert.equal(manifest.name, 'RinkRat Fantasy');
  assert.equal(manifest.short_name, 'RinkRat');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.match(manifest.start_url, /^\/dashboard\?/);
  assert.equal(manifest.prefer_related_applications, false);
  assert.deepEqual(
    manifest.icons.map((icon) => icon.sizes),
    ['192x192', '512x512'],
  );
  assert.deepEqual(
    manifest.shortcuts.map((shortcut) => shortcut.name),
    ['Dashboard', 'Account Settings'],
  );
});

test('the service worker handles only same-origin GET shell and stable assets', async () => {
  const source = await read('public/rinkrat-sw.js');

  assert.match(source, /request\.method !== 'GET'/);
  assert.match(source, /url\.origin !== self\.location\.origin/);
  assert.match(source, /request\.mode === 'navigate'/);
  assert.match(source, /networkFirstNavigation/);
  assert.match(source, /cacheFirstAsset/);
  assert.match(source, /precacheBuiltShellAssets/);
  assert.match(source, /extractBuiltShellAssetUrls/);
  assert.match(source, /\\.\(\?:js\|css\)\$/);
  assert.match(source, /RINKRAT_CACHE_VERSION = 'rc55-v1'/);
  assert.doesNotMatch(source, /addEventListener\(['"]sync['"]/);
  assert.doesNotMatch(source, /background\s*sync/i);
  assert.doesNotMatch(source, /indexedDB|postMessage\([^)]*transaction|queue.*(?:write|mutation)/i);
});

test('release identity, service-worker code, proxy routes, and security routes remain network-only', async () => {
  const source = await read('public/rinkrat-sw.js');

  assert.match(source, /'\/release-manifest\.json'/);
  assert.match(source, /'\/rinkrat-sw\.js'/);
  assert.match(source, /'\/site\.webmanifest'/);
  assert.match(source, /'\/v1\/'/);
  assert.match(source, /'\/stats\/'/);
  assert.match(source, /'\/espn\/'/);
  assert.match(source, /'\/security\/'/);
  assert.match(source, /isNetworkOnlyPath\(url\.pathname\)/);
});

test('navigation falls back honestly without claiming offline competitive data is current', async () => {
  const [worker, offlinePage, roadmap] = await Promise.all([
    read('public/rinkrat-sw.js'),
    read('public/offline.html'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
  ]);

  assert.match(worker, /shellCache\.match\('\/index\.html'\)/);
  assert.match(worker, /shellCache\.match\('\/offline\.html'\)/);
  assert.match(offlinePage, /RinkRat is offline/);
  assert.match(offlinePage, /No Draft, roster, waiver, commissioner, or testing action was queued/);
  assert.match(roadmap, /# \[x\] N1\.3 Add clearly labeled stale read-only matchup access when offline/);
});

test('the browser install service defers the native prompt and registers with update-safe options', async () => {
  const service = await read('src/app/core/pwa/rinkrat-pwa.service.ts');

  assert.match(service, /beforeinstallprompt/);
  assert.match(service, /event\.preventDefault\(\)/);
  assert.match(service, /deferredInstallPrompt/);
  assert.match(service, /await prompt\.prompt\(\)/);
  assert.match(service, /canRegisterRinkRatServiceWorker/);
  assert.match(service, /developerToolsEnabled: APP_RUNTIME_CONFIG\.developerToolsEnabled/);
  assert.match(service, /navigator\.serviceWorker\.register\(SERVICE_WORKER_PATH/);
  assert.match(service, /updateViaCache: 'none'/);
  assert.doesNotMatch(service, /\.prompt\(\).*start\(\)/s);
});

test('a waiting worker activates only through the existing manager-approved release reload', async () => {
  const [pwaService, app, releaseService, worker] = await Promise.all([
    read('src/app/core/pwa/rinkrat-pwa.service.ts'),
    read('src/app/app.ts'),
    read('src/app/core/release/release-update.service.ts'),
    read('public/rinkrat-sw.js'),
  ]);

  assert.match(app, /releaseUpdate\.requestReload\(\(\) => this\.pwa\.reloadWithLatestWorker\(\)\)/);
  assert.match(releaseService, /requestReload\(reloadAction:/);
  assert.match(pwaService, /waitingWorker\.postMessage\(\{ type: 'SKIP_WAITING' \}\)/);
  assert.match(pwaService, /controllerchange/);
  assert.match(worker, /event\.data\?\.type === 'SKIP_WAITING'/);
  const installHandler = worker.slice(
    worker.indexOf("self.addEventListener('install'"),
    worker.indexOf("self.addEventListener('activate'"),
  );
  assert.doesNotMatch(installHandler, /skipWaiting/);
});

test('install controls stay optional, inline, account-owned, and mobile-safe', async () => {
  const [accountTemplate, accountStyles, navbarTemplate, navbarComponent] = await Promise.all([
    read('src/app/features/account/account-settings/account-settings.html'),
    read('src/app/features/account/account-settings/account-settings.css'),
    read('src/app/shared/navbar/navbar.html'),
    read('src/app/shared/navbar/navbar.ts'),
  ]);

  assert.match(accountTemplate, /@if \(pwa\.showInstallCard\(\)\)/);
  assert.match(accountTemplate, /Install RinkRat/);
  assert.match(accountTemplate, /pwa\.installState\(\)/);
  assert.match(accountTemplate, /pwa\.canInstall\(\)/);
  assert.match(accountTemplate, /Add to Home Screen/);
  assert.doesNotMatch(navbarTemplate, /Install RinkRat|pwa\.canInstall/);
  assert.doesNotMatch(navbarComponent, /RinkRatPwaService|\bpwa\b/);

  const accountBlock = accountStyles.slice(accountStyles.indexOf('.account-install-card'));
  assert.doesNotMatch(accountBlock, /position:\s*(?:fixed|sticky)/);
  assert.doesNotMatch(accountTemplate, /role="dialog"|backdrop|bottom-sheet/i);
});

test('the existing connection guard still blocks every competitive submission while offline', async () => {
  const health = await read('src/app/core/observability/client-health.service.ts');

  assert.match(health, /Draft, roster, waiver, and commissioner actions will not submit until the connection returns/);
  assert.match(health, /Reconnect to the internet before submitting a competitive action/);
  assert.match(health, /No roster, waiver, draft, or testing request has been sent/);
  assert.match(health, /this\.online\(\) && !this\.restoredNoticeVisible\(\)/);
});

test('Hosting prevents stale worker and manifest delivery and N1A stays Hosting-only', async () => {
  const [firebaseSource, runbook] = await Promise.all([
    read('firebase.json'),
    read('docs/RINKRAT_MOBILE_N1A_PWA_FOUNDATION.md'),
  ]);
  const firebaseConfig = JSON.parse(firebaseSource);
  const headers = firebaseConfig.hosting.headers;
  const workerHeaders = headers.find((entry) => entry.source === '/rinkrat-sw.js');
  const manifestHeaders = headers.find((entry) => entry.source === '/site.webmanifest');

  assert.deepEqual(workerHeaders?.headers, [
    { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
    { key: 'Service-Worker-Allowed', value: '/' },
  ]);
  assert.deepEqual(manifestHeaders?.headers, [
    { key: 'Cache-Control', value: 'no-cache, must-revalidate' },
  ]);
  assert.match(runbook, /--only hosting:app/);
  assert.doesNotMatch(runbook, /--only functions|--only firestore:rules|--only firestore:indexes/);
});

test('the N1A foundation remains intact under RC49 and preserves competitive models, Rules, indexes, and safety modes', async () => {
  const [
    scoringRules,
    scoringEngine,
    projectionV11,
    firestoreRules,
    firestoreIndexes,
    runtime,
    productionRuntime,
    freezeSource,
    appCheckSource,
    canarySource,
    cacheSource,
    packageSource,
  ] = await Promise.all([
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/scoring/scoring-engine.ts'),
    read('src/app/core/projection/projection-v11.util.ts'),
    read('firestore.rules'),
    read('firestore.indexes.json'),
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('config/release-freeze/beta-freeze-policy.json'),
    read('config/app-check-enforcement-readiness.json'),
    read('config/app-check-callable-canary.json'),
    read('config/nhl-shared-cache-policy.json'),
    read('package.json'),
  ]);
  const freeze = JSON.parse(freezeSource);
  const appCheck = JSON.parse(appCheckSource);
  const canary = JSON.parse(canarySource);
  const cache = JSON.parse(cacheSource);
  const packageJson = JSON.parse(packageSource);

  assert.equal(sha256(scoringRules), PROTECTED_SOURCE_HASHES.scoringRules);
  assert.equal(sha256(scoringEngine), PROTECTED_SOURCE_HASHES.scoringEngine);
  assert.equal(sha256(projectionV11), PROTECTED_SOURCE_HASHES.projectionV11);
  assert.equal(sha256(firestoreRules), PROTECTED_SOURCE_HASHES.firestoreRules);
  assert.equal(sha256(firestoreIndexes), PROTECTED_SOURCE_HASHES.firestoreIndexes);
  assert.match(runtime, /Release Candidate 65/);
  assert.match(productionRuntime, /Release Candidate 65/);
  assert.equal(freeze.releaseLabel, 'Release Candidate 65');
  assert.equal(freeze.verificationCommand, 'npm run verify:batchb1j');
  assert.equal(freeze.scoringRulesVersion, 4);
  assert.equal(freeze.projectionVersion, 11);
  assert.equal(freeze.requiredGamesPerRosterSlot, 6);
  assert.equal(freeze.queueMode, 'shadow');
  assert.equal(freeze.appCheckMode, 'monitor');
  assert.equal(appCheck.mode, 'monitor');
  assert.equal(canary.automaticPromotion, false);
  assert.equal(cache.mode, 'shadow');
  assert.equal(cache.authoritativeReadsEnabled, false);
  assert.match(packageJson.scripts['verify:batchn1a:core'], /verify:batcha1i:core/);
  assert.match(packageJson.scripts['verify:batchn1b:core'], /verify:batchn1a:core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batch(?:b1j|d1j):core/);
});

test('documentation and roadmap record the bounded PWA foundation and site-first proof', async () => {
  const [roadmap, docsRoadmap, runbook, readme, releaseRunbook] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_MOBILE_N1A_PWA_FOUNDATION.md'),
    read('README.md'),
    read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
  ]);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.54/);
  assert.match(roadmap, /# \[x\] N1\.1/);
  assert.match(roadmap, /# \[x\] N1\.2/);
  assert.match(roadmap, /# \[x\] N1\.3/);
  assert.match(roadmap, /# \[x\] N1\.4/);
  assert.match(roadmap, /# \[x\] LOG\.57/);
  assert.match(roadmap, /# \[x\] LOG\.58/);
  assert.match(runbook, /Mobile Batch N1A/);
  assert.match(runbook, /no Background Sync listener/i);
  assert.match(runbook, /Site-first proof/);
  assert.match(readme, /Release Candidate 65 \/ Beta Batch B1J/);
  assert.match(readme, /RINKRAT_MOBILE_N1A_PWA_FOUNDATION\.md/);
  assert.match(releaseRunbook, /npm run verify:batchb1j/);
  assert.match(releaseRunbook, /rinkrat-rc65-validation\.json/);
  assert.match(releaseRunbook, /rinkrat-rc65-invite-beta/);
});
