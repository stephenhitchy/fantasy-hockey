import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function read(relativePath) {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

const [
  portalSource,
  focusTrapSource,
  teamSettingsSource,
  teamSettingsTemplate,
  readinessSource,
  readinessPageSource,
  appCheckConfigSource,
  runtimeSource,
  runtimeProductionSource,
  packageSource,
  readmeSource,
  documentationSource,
  roadmapRootSource,
  roadmapDocsSource,
] = await Promise.all([
  read('src/app/shared/accessibility/viewport-overlay-portal.directive.ts'),
  read('src/app/shared/accessibility/dialog-focus-trap.directive.ts'),
  read('src/app/features/team/team-settings/team-settings.ts'),
  read('src/app/features/team/team-settings/team-settings.html'),
  read('src/app/core/release/release-readiness.service.ts'),
  read('src/app/features/release/release-readiness/release-readiness.ts'),
  read('src/environments/app-check.config.ts'),
  read('src/environments/app-runtime.config.ts'),
  read('src/environments/app-runtime.config.production.ts'),
  read('package.json'),
  read('README.md'),
  read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
  read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
  read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
]);

test('destroyed viewport overlays are removed instead of reinserted as frozen duplicate dialogs', () => {
  const destroyStart = portalSource.indexOf('ngOnDestroy(): void');
  assert.ok(destroyStart >= 0, 'Viewport overlay teardown must exist.');
  const destroySource = portalSource.slice(destroyStart);

  assert.match(destroySource, /this\.host\.remove\(\)/);
  assert.match(destroySource, /releaseViewportLock\(this\.host\)/);
  assert.match(destroySource, /cannot survive as a frozen DOM remnant/);
  assert.doesNotMatch(destroySource, /originalParent|originalNextSibling/);
  assert.doesNotMatch(destroySource, /insertBefore\(this\.host/);
});

test('focus restoration never jumps behind a replacement viewport overlay', () => {
  assert.match(portalSource, /export function hasActiveViewportOverlay\(\): boolean/);
  assert.match(focusTrapSource, /hasActiveViewportOverlay/);
  assert.match(focusTrapSource, /hasActiveViewportOverlay\(\)[\s\S]*restoreTarget\.focus/);
  assert.match(focusTrapSource, /restoreTarget\.isConnected/);
});

test('bench-to-active swaps dismiss once before the request and reject ghost reopen attempts', () => {
  const beginStart = teamSettingsSource.indexOf('beginBenchSwap(benchSlotId: string)');
  const confirmStart = teamSettingsSource.indexOf(
    'async confirmBenchSwap(event?: Event): Promise<void>',
  );
  const nextMethod = teamSettingsSource.indexOf('beginIrBenchActivation(', confirmStart);
  assert.ok(beginStart >= 0 && confirmStart >= 0 && nextMethod > confirmStart);

  const beginSource = teamSettingsSource.slice(beginStart, confirmStart);
  const confirmSource = teamSettingsSource.slice(confirmStart, nextMethod);

  assert.match(
    beginSource,
    /this\.isRosterOperationPending\(\)[\s\S]*Date\.now\(\) < this\.benchSwapReopenBlockedUntil/,
  );
  assert.match(teamSettingsSource, /private clearBenchSwapDialogState\(\): void/);
  assert.match(teamSettingsSource, /private waitForRosterOverlayDismissal\(\): Promise<void>/);
  assert.match(teamSettingsSource, /repairViewportOverlayLock/);

  assert.match(confirmSource, /event\?\.preventDefault\(\);[\s\S]*event\?\.stopPropagation\(\)/);
  assert.match(confirmSource, /this\.rosterMoveLoading\.set\(true\)/);
  assert.match(confirmSource, /this\.benchSwapReopenBlockedUntil = Date\.now\(\) \+ 1_500/);
  assert.match(
    confirmSource,
    /this\.clearBenchSwapDialogState\(\);[\s\S]*await this\.waitForRosterOverlayDismissal\(\);[\s\S]*queueActiveBenchSwap\(/,
  );

  const clearMatches = confirmSource.match(/this\.clearBenchSwapDialogState\(\);/g) ?? [];
  assert.ok(clearMatches.length >= 2, 'Dialog state must also clear during final cleanup.');
  assert.match(teamSettingsTemplate, /confirmBenchSwap\(\$event\)/);
});

test('Release Readiness gives exact password, projection, and Shadow-mode recovery guidance', () => {
  assert.match(readinessSource, /security:apply-auth-baseline command/);
  assert.match(readinessSource, /completed league still points at a pre-S2B projection/);
  assert.match(readinessSource, /completed Draft picks are not rewritten/);
  assert.match(readinessSource, /observation only; the legacy scorer remains authoritative/);
  assert.match(readinessPageSource, /snapshot\.projectionTargetCycleNumber/);
});

test('RC16 and later releases preserve the verified App Check monitor configuration', () => {
  assert.match(appCheckConfigSource, /enabled:\s*true/);
  assert.match(appCheckConfigSource, /recaptchaEnterpriseSiteKey:\s*'[A-Za-z0-9_-]{20,250}'/);
  assert.match(appCheckConfigSource, /tokenAutoRefreshEnabled:\s*true/);
  assert.match(appCheckConfigSource, /localDebugTokenEnabled:\s*false/);
  assert.match(runtimeSource, /Release Candidate \d+/);
  assert.match(runtimeProductionSource, /Release Candidate \d+/);
});

test('S3A.2 verification, documentation, release label, and permanent roadmap stay synchronized', () => {
  const packageJson = JSON.parse(packageSource);

  assert.equal(
    packageJson.scripts['test:batchs3a-2:run'],
    'node --no-warnings --experimental-strip-types --test --test-concurrency=1 test/batchs3a-2-roster-overlay-readiness/*.test.mjs',
  );
  assert.match(packageJson.scripts['verify:batchs3a-2'], /verify:batchs3a-1/);
  assert.match(packageJson.scripts['verify:batchs3a-2'], /test:batchs3a-2:run/);
  assert.match(packageJson.scripts['verify:batchs3a-2'], /validate:release-manifest/);
  assert.match(readmeSource, /Release Candidate \d+ \/ (?:Security S3A\.2|Security S3B(?:\.\d+)?|Onboarding Batch B1A|Security Batch S3C|Security Batch S3D|Security Batch S3E|Security Batch S3F|Beta Operations Batch B1B|Data Quality Batch D1A|Data Quality Batch D1B|Social Batch C1A|Social Batch C1B|Social Batch C1C|Social Batch C1D|Social Batch C1E|Social Batch C1F|Social Batch C1G|Social Batch C1H|Social Batch C1I|Social Batch C1J|Social Batch C1K|Product Batch A1A|Product Batch A1B|Product Batch A1C|Product Batch A1E|Product Batch A1F|Product Batch A1H|Product Batch A1I)/);
  assert.match(documentationSource, /Security Batch S3A\.2 — Roster Overlay Teardown and Readiness Recovery/);
  assert.equal(roadmapRootSource, roadmapDocsSource);
  assert.match(roadmapRootSource, /Version 1\.\d+(?:\.\d+)?/);
  assert.match(roadmapRootSource, /LOG\.11 .*Security Batch S3A\.2/);
  assert.match(roadmapRootSource, /# \[x\] S3\.1 Register the production web app in Firebase App Check/);
  assert.match(roadmapRootSource, /# \[x\] S3\.8 Verify Firebase Email Enumeration Protection/);
  assert.match(roadmapRootSource, /(?:# \[x\]|\[~\]) S3\.7 Raise the Firebase password minimum/);
});
