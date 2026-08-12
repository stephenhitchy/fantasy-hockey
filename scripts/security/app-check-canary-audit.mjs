import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const read = async (relativePath) => readFile(path.join(root, relativePath), 'utf8');

const [
  configSource,
  utilitySource,
  authoritySource,
  indexSource,
  adminTemplate,
  adminComponent,
  adminService,
  draftAuthority,
  rosterAuthority,
  rosterMoves,
  leagueAutomation,
  projectionAuthority,
] = await Promise.all([
  read('config/app-check-callable-canary.json'),
  read('functions/src/shared/security/app-check-callable-canary.util.ts'),
  read('functions/src/app-check-canary-authority.ts'),
  read('functions/src/index.ts'),
  read('src/app/features/admin/admin-center/admin-center.html'),
  read('src/app/features/admin/admin-center/admin-center.ts'),
  read('src/app/core/admin/platform-admin.service.ts'),
  read('functions/src/draft-authority.ts'),
  read('functions/src/roster-authority.ts'),
  read('functions/src/roster-moves.ts'),
  read('functions/src/league-automation.ts'),
  read('functions/src/projection-authority.ts'),
]);

const config = JSON.parse(configSource);
const failures = [];
const expectedCallables = [
  'requestProjectionSnapshotGeneration',
  'advanceHistoricalReplayDay',
  'makeSecureDraftPick',
  'applyImmediateRosterMove',
  'executeSecureRosterAction',
];

if (config.defaultMode !== 'monitor') {
  failures.push('The source-controlled App Check callable canary must default to monitor mode.');
}
if (config.automaticPromotion !== false) {
  failures.push('Automatic App Check canary promotion must remain disabled.');
}
if (config.emergencyMonitorRollbackRequiresAppCheck !== false) {
  failures.push('Emergency rollback to monitor mode must not depend on a working App Check token.');
}
if (config.maximumCanaryLeagues !== 5) {
  failures.push('The first App Check canary must remain bounded to five exact leagues.');
}
if (config.leagueEligibility !== 'internal-test-only') {
  failures.push('The first App Check canary must be limited to leagues marked Internal Test.');
}

const configuredCallables = config.candidateCallables?.map((item) => item.name) ?? [];
for (const callableName of expectedCallables) {
  if (!configuredCallables.includes(callableName)) {
    failures.push(`The canary config is missing ${callableName}.`);
  }
}

const combinedServer = [
  utilitySource,
  authoritySource,
  indexSource,
  draftAuthority,
  rosterAuthority,
  rosterMoves,
  leagueAutomation,
  projectionAuthority,
].join('\n');

if (/enforceAppCheck\s*:\s*true/.test(combinedServer)) {
  failures.push('S3F must not enable Firebase-wide callable App Check enforcement.');
}
if (!/mode:\s*'monitor'/.test(utilitySource)) {
  failures.push('The default server control is not monitor mode.');
}
if (!/app-check-callable-canary-returned-to-monitor/.test(authoritySource)) {
  failures.push('The server is missing the audited monitor rollback path.');
}
if (!/request\.app\?\.appId/.test(authoritySource)) {
  failures.push('Canary activation does not verify the administrator App Check context.');
}
if (!/if \(mode === 'canary'\)/.test(authoritySource)) {
  failures.push('The canary-only evidence and App Check activation gate is missing.');
}
if (!/appData\/leagueAutomationQueueConfig/.test(authoritySource) ||
    !/Internal Test in the Scoring Queue Control Center/.test(authoritySource)) {
  failures.push('Canary activation is not restricted to leagues explicitly marked Internal Test.');
}
if (!/let approvedBuildId: string \| null = null/.test(authoritySource) ||
    !/let approvedAppId: string \| null = null/.test(authoritySource)) {
  failures.push('Monitor rollback does not clear the active build and App Check approval.');
}
if (!/getAppCheckCallableCanaryControl/.test(indexSource) ||
    !/updateAppCheckCallableCanaryControl/.test(indexSource)) {
  failures.push('The App Check canary administration callables are not exported.');
}

const guardedModules = new Map([
  ['makeSecureDraftPick', draftAuthority],
  ['executeSecureRosterAction', rosterAuthority],
  ['applyImmediateRosterMove', rosterMoves],
  ['advanceHistoricalReplayDay', leagueAutomation],
  ['requestProjectionSnapshotGeneration', projectionAuthority],
]);
for (const [callableName, source] of guardedModules) {
  const pattern = new RegExp(`enforceAppCheckCallableCanaryForLeague\\([\\s\\S]{0,220}'${callableName}'`);
  if (!pattern.test(source)) {
    failures.push(`${callableName} is not guarded by the shared exact-league canary helper.`);
  }
}

if (!/Only leagues already marked Internal/.test(adminTemplate) ||
    !/league\.isInternalTest/.test(adminTemplate)) {
  failures.push('Admin Center does not clearly restrict canary selection to Internal Test leagues.');
}
if (!/Exact-league App Check canary/.test(adminTemplate)) {
  failures.push('Admin Center is missing the exact-league App Check canary control.');
}
if (!/startAppCheckCanary/.test(adminComponent) ||
    !/returnAppCheckCanaryToMonitor/.test(adminComponent)) {
  failures.push('Admin Center is missing deliberate canary start or monitor rollback handlers.');
}
if (!/loadAppCheckCanaryControl/.test(adminService) ||
    !/updateAppCheckCanaryControl/.test(adminService)) {
  failures.push('The platform-admin client is missing App Check canary service calls.');
}

if (failures.length) {
  console.error('App Check selected-callable canary audit failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`App Check selected-callable canary audit passed: ${expectedCallables.length} guarded callables, exact Internal Test league routing, manual activation, and emergency monitor rollback.`);
}
