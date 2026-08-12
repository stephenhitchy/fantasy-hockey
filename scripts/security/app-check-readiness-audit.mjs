import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function read(relativePath) {
  return readFile(path.join(ROOT, relativePath), 'utf8');
}

const [configSource, serverSource, adminTemplate, mobileTemplate] = await Promise.all([
  read('config/app-check-enforcement-readiness.json'),
  read('functions/src/shared/security/app-check-enforcement-readiness.util.ts'),
  read('src/app/features/admin/admin-center/admin-center.html'),
  read('src/app/features/cycles/cycle-one/components/cycle-mobile-head-to-head/cycle-mobile-head-to-head.html'),
]);
const config = JSON.parse(configSource);
const failures = [];

if (config.schemaVersion !== 1) failures.push('schemaVersion must remain 1.');
if (config.mode !== 'monitor') failures.push('S3E must remain in App Check monitor mode.');
if (config.automaticEnforcement !== false) failures.push('automaticEnforcement must remain false.');
if (!Number.isInteger(config.minimumTotalSamples) || config.minimumTotalSamples < 25) failures.push('minimumTotalSamples must be a meaningful bounded gate.');
if (!Number.isInteger(config.minimumSamplesPerRequiredPlatform) || config.minimumSamplesPerRequiredPlatform < 1) failures.push('minimumSamplesPerRequiredPlatform must remain positive.');
if (typeof config.minimumValidPercent !== 'number' || config.minimumValidPercent < 99 || config.minimumValidPercent > 100) failures.push('minimumValidPercent must remain between 99 and 100.');
for (const key of ['requiredBrowsers', 'requiredDevices', 'requiredPlatforms', 'requiredActions', 'firstEnforcementScope']) {
  if (!Array.isArray(config[key]) || config[key].length === 0) failures.push(`${key} must remain populated.`);
}
if (!/buildAppCheckEnforcementReadiness/.test(serverSource)) failures.push('The shared readiness evaluator is missing.');
if (/enforceAppCheck\s*:\s*true/.test(serverSource)) failures.push('The readiness utility must not enable enforcement.');
if (!/Selected-callable enforcement gate/.test(adminTemplate)) failures.push('Admin Center is missing the enforcement-readiness panel.');
if (!/Monitor-only safety/.test(adminTemplate)) failures.push('Admin Center is missing the monitor-only warning.');
if (/getAssetStatusTooltip\(pick\.asset\)/.test(mobileTemplate)) failures.push('Mobile matchup cards must not render the full injury article.');
if (!/mobile-live-player-statusline-compact/.test(mobileTemplate)) failures.push('Mobile matchup cards are missing the compact injury status.');

if (failures.length) {
  console.error('App Check readiness audit failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`App Check readiness audit passed: monitor mode, ${config.minimumTotalSamples} exact-build samples, ${config.minimumValidPercent}% verification, and explicit browser/device/platform/action gates.`);
}
