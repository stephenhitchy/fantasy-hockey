import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  getEffectiveActiveLeagueCount,
  getOccupiedLeagueOwnerIds,
  isDraftJoinLocked,
  LEAGUE_CREATION_WINDOW_MILLISECONDS,
  LEAGUE_JOIN_DAILY_WINDOW_MILLISECONDS,
  LEAGUE_JOIN_SHORT_WINDOW_MILLISECONDS,
  MAX_ACTIVE_LEAGUES_PER_USER,
  MAX_JOIN_ATTEMPTS_PER_10_MINUTES,
  MAX_JOIN_ATTEMPTS_PER_24_HOURS,
  MAX_LEAGUE_CREATIONS_PER_24_HOURS,
  normalizeRollingWindow,
} from '../../functions/src/league-lifecycle-authority.util.ts';

async function read(relativePath) {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

const [
  authoritySource,
  authorityUtilSource,
  draftAuthoritySource,
  functionsIndexSource,
  functionsPackageSource,
  clientSource,
  rulesSource,
  rulesTestSource,
  onboardingTestSource,
  packageSource,
  documentationCleanupTestSource,
  consolidateDocsSource,
  roadmapSource,
  documentationSource,
  createTemplateSource,
  joinTemplateSource,
  draftSetupTemplateSource,
  runtimeConfigSource,
  productionRuntimeConfigSource,
  scoringRulesSource,
  projectionV11Source,
] = await Promise.all([
  read('functions/src/league-lifecycle-authority.ts'),
  read('functions/src/league-lifecycle-authority.util.ts'),
  read('functions/src/draft-authority.ts'),
  read('functions/src/index.ts'),
  read('functions/package.json'),
  read('src/app/core/league/league.service.ts'),
  read('firestore.rules'),
  read('test/firestore-rules/firestore.rules.test.mjs'),
  read('test/league-onboarding/league-service-contract.test.mjs'),
  read('package.json'),
  read('test/documentation/documentation-cleanup.test.mjs'),
  read('scripts/consolidate-project-docs.mjs'),
  read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
  read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
  read('src/app/features/leagues/create-league/create-league.html'),
  read('src/app/features/leagues/join-league/join-league.html'),
  read('src/app/features/draft/draft-setup/draft-setup.html'),
  read('src/environments/app-runtime.config.ts'),
  read('src/environments/app-runtime.config.production.ts'),
  read('functions/src/shared/core/scoring/scoring-rules.ts'),
  read('functions/src/shared/core/projection/projection-v11.util.ts'),
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing section start: ${startMarker}`);
  assert.ok(end > start, `Missing section end: ${endMarker}`);
  return source.slice(start, end);
}

test('league joining is one verified-email server transaction with exact idempotency', () => {
  assert.match(authoritySource, /export const joinLeagueSecure = onCall/);
  assert.match(authoritySource, /requireAuthenticatedUserId\(request\.auth, 'join a league'\)/);
  assert.match(authoritySource, /requireVerifiedEmail\(request\.auth, 'join a league'\)/);
  assert.match(authoritySource, /createJoinPayloadHash/);
  assert.match(authoritySource, /createJoinRequestDocumentId/);
  assert.match(authoritySource, /reserveJoinAttempt/);
  assert.match(authoritySource, /readCompletedJoinRequest/);
  assert.match(authoritySource, /idempotentReplay: true/);
  assert.match(authoritySource, /transaction\.create\(memberRef/);
  assert.match(authoritySource, /transaction\.create\(\s*teamRef/);
  assert.match(authoritySource, /transaction\.create\(rosterRef/);
  assert.match(authoritySource, /action: 'member-joined'/);
  assert.match(authoritySource, /one reused request ID cannot become/);
  assert.match(authoritySource, /attemptCount: priorAttemptCount \+ 1/);
});

test('the atomic join validates invite identity, expiry, capacity, draft lock, and membership quota', () => {
  const joinSection = section(
    authoritySource,
    'export const joinLeagueSecure = onCall',
    'export async function releaseActiveLeagueQuotaForUsers',
  );

  for (const requiredCheck of [
    /inviteData\['active'\] !== true/,
    /expiresAtMilliseconds/,
    /asString\(leagueData\['inviteCode'\]\) !== input\.inviteCode/,
    /isDraftJoinLocked\(draftSnapshot\.data\(\)\)/,
    /currentTeamCount >= maxTeams/,
    /quotaState\.activeLeagueCount >= MAX_ACTIVE_LEAGUES_PER_USER/,
    /teamCount: resultingTeamCount/,
    /joinStatus: leagueIsFull \? 'full' : 'open'/,
  ]) {
    assert.match(joinSection, requiredCheck);
  }

  assert.match(joinSection, /transaction\.get\(membersQuery\)/);
  assert.match(joinSection, /transaction\.get\(teamsQuery\)/);
  assert.match(joinSection, /getOccupiedLeagueOwnerIds/);
});

test('quota helpers reset rolling windows safely and deduplicate league owners', () => {
  assert.equal(MAX_ACTIVE_LEAGUES_PER_USER, 20);
  assert.equal(MAX_LEAGUE_CREATIONS_PER_24_HOURS, 8);
  assert.equal(MAX_JOIN_ATTEMPTS_PER_10_MINUTES, 20);
  assert.equal(MAX_JOIN_ATTEMPTS_PER_24_HOURS, 100);
  assert.equal(LEAGUE_CREATION_WINDOW_MILLISECONDS, 86_400_000);
  assert.equal(LEAGUE_JOIN_SHORT_WINDOW_MILLISECONDS, 600_000);
  assert.equal(LEAGUE_JOIN_DAILY_WINDOW_MILLISECONDS, 86_400_000);

  const fresh = normalizeRollingWindow(
    { startedAtMilliseconds: null, count: 99 },
    1_000_000,
    60_000,
  );
  assert.deepEqual(fresh, {
    startedAtMilliseconds: 1_000_000,
    count: 0,
    reset: true,
  });

  const active = normalizeRollingWindow(
    { startedAtMilliseconds: 990_000, count: 4 },
    1_000_000,
    60_000,
  );
  assert.deepEqual(active, {
    startedAtMilliseconds: 990_000,
    count: 4,
    reset: false,
  });

  assert.equal(getEffectiveActiveLeagueCount(3, 5), 5);
  assert.equal(getEffectiveActiveLeagueCount(8, 5), 8);
  assert.deepEqual(
    getOccupiedLeagueOwnerIds(
      ['z-user', 'a-user', 'a-user', ''],
      ['b-user', 'z-user', '  c-user  '],
    ),
    ['a-user', 'b-user', 'c-user', 'z-user'],
  );
});

test('draft lock detection treats every saved or active draft state as closed to new members', () => {
  assert.equal(isDraftJoinLocked(null), false);
  assert.equal(isDraftJoinLocked({ status: 'setup', roundOneOrder: [], nextOverallPick: 1 }), false);
  assert.equal(isDraftJoinLocked({ status: 'scheduled' }), true);
  assert.equal(isDraftJoinLocked({ status: 'live' }), true);
  assert.equal(isDraftJoinLocked({ status: 'complete' }), true);
  assert.equal(isDraftJoinLocked({ status: 'setup', roundOneOrder: ['owner-a'] }), true);
  assert.equal(isDraftJoinLocked({ status: 'setup', draftedAssetKeys: ['player:1'] }), true);
  assert.equal(isDraftJoinLocked({ status: 'setup', nextOverallPick: 2 }), true);
  assert.match(authorityUtilSource, /roundOneOrder\.length > 0/);
});

test('saving draft settings atomically freezes the team set and deactivates the invite', () => {
  const saveSection = section(
    draftAuthoritySource,
    'async function saveDraftSettings(',
    'async function activateScheduledDraft(',
  );

  assert.match(saveSection, /transaction\.get\(teamsQuery\)/);
  assert.match(saveSection, /The draft order must contain every current league team exactly once/);
  assert.match(saveSection, /joinStatus: 'locked'/);
  assert.match(saveSection, /joinLockedReason: 'draft-order-saved'/);
  assert.match(saveSection, /active: false/);
  assert.match(saveSection, /lockedReason: 'draft-order-saved'/);
  assert.match(saveSection, /invite-locked-draft-setup/);
  assert.match(saveSection, /League entry is now closed/);
});

test('the browser uses the secure join callable and never recreates member, team, roster, or invite documents', () => {
  const joinSection = section(
    clientSource,
    'export async function joinLeagueByInviteCode(',
    'export async function ensureLeagueProfileIcon(',
  );

  assert.match(joinSection, /requireFreshVerifiedEmail\('join a league'\)/);
  assert.match(joinSection, /'joinLeagueSecure'/);
  assert.match(joinSection, /timeout: 60_000/);
  assert.match(joinSection, /requestId: pending\.requestId/);
  assert.match(joinSection, /profileIconId: pending\.profileIconId/);
  assert.doesNotMatch(joinSection, /writeBatch\(|batch\.set\(|setDoc\(|getDoc\(/);
  assert.match(clientSource, /PENDING_LEAGUE_JOIN_STORAGE_KEY/);
  assert.match(clientSource, /existing\?\.fingerprint === fingerprint/);
  assert.match(clientSource, /inMemoryPendingLeagueJoin/);
  assert.match(onboardingTestSource, /joinLeagueSecure/);
});

test('browser rules deny invite reads and direct league membership or team creation', () => {
  assert.match(
    rulesSource,
    /match \/leagueInvites\/\{inviteCode\}[\s\S]*?allow read, create, update, delete: if false;/,
  );
  assert.match(
    rulesSource,
    /match \/members\/\{memberId\}[\s\S]*?allow create: if false;/,
  );
  assert.match(
    rulesSource,
    /match \/teams\/\{teamId\}[\s\S]*?allow create: if false;/,
  );
  assert.match(rulesTestSource, /invite documents are server-only and cannot be read or changed from the browser/);
  assert.match(rulesTestSource, /a signed-in invitee cannot create membership or team documents directly/);
});

test('account and league deletion maintain lifecycle accounting and request cleanup', () => {
  assert.match(functionsIndexSource, /releaseLeagueLifecycleCounts/);
  assert.match(functionsIndexSource, /await releaseLeagueLifecycleCounts\(leagueOwnerIds\)/);
  assert.match(functionsIndexSource, /'leagueCreationRequests'/);
  assert.match(functionsIndexSource, /'leagueJoinRequests'/);
  assert.match(functionsIndexSource, /leagueLifecycleState\/\$\{userId\}/);
  assert.match(functionsPackageSource, /joinLeagueSecure/);
});

test('roadmap files are permanent project artifacts and are excluded from documentation cleanup and consolidation', () => {
  assert.match(documentationCleanupTestSource, /RINKRAT_COMPETITIVE_ROADMAP/);
  assert.match(documentationCleanupTestSource, /docs[\\/]RINKRAT_COMPETITIVE_ROADMAP\.txt/);
  assert.match(consolidateDocsSource, /RINKRAT_COMPETITIVE_ROADMAP/);
  assert.match(documentationSource, /docs\/RINKRAT_COMPETITIVE_ROADMAP\.txt/);
});

test('roadmap and release documentation record S1B without deleting completed work', () => {
  assert.match(roadmapSource, /Version 1\.(?:[2-9]|1[0-9])(?:\.\d+)?/);
  assert.match(roadmapSource, /# \[x\] S1\.4 .*Completed 2026-08-07 in Security Batch S1B/);
  assert.match(roadmapSource, /# \[x\] S1\.5 .*Completed 2026-08-07 in Security Batch S1B/);
  assert.match(roadmapSource, /\[~\] S1\.6 Add verified-email requirements/);
  assert.match(roadmapSource, /# \[x\] S1\.7 .*Completed 2026-08-07 in Security Batch S1B/);
  assert.match(roadmapSource, /# \[x\] SEQ\.2 Security Batch S1B/);
  assert.match(roadmapSource, /(?:\[ \]|# \[x\]) SEQ\.3 Security Batch S1C/);
  assert.match(documentationSource, /Batch S1B — Atomic League Joining/);
  assert.match(documentationSource, /Functions → Hosting → Firestore Rules/);
  assert.match(runtimeConfigSource, /releaseLabel: 'Release Candidate \d+'/g);
  assert.match(productionRuntimeConfigSource, /releaseLabel: 'Release Candidate \d+'/g);
});

test('create and join pages explain verification and the draft setup explains the entry lock', () => {
  assert.match(createTemplateSource, /verified email/i);
  assert.match(joinTemplateSource, /verified email/i);
  assert.match(joinTemplateSource, /Entry must still be open/i);
  assert.match(draftSetupTemplateSource, /closes league entry/i);
});

test('S1B verification scripts are installed and the secure callable is exported', () => {
  const packageJson = JSON.parse(packageSource);
  assert.equal(
    packageJson.scripts['test:batchs1b:run'],
    'node --no-warnings --experimental-strip-types --test --test-concurrency=1 test/batchs1b-atomic-league-joining/*.test.mjs',
  );
  assert.match(packageJson.scripts['verify:batchs1b'], /verify:batchs1a/);
  assert.match(packageJson.scripts['verify:batchs1b'], /test:batchs1b:run/);
  assert.match(packageJson.scripts['verify:batchs1b'], /validate:release-manifest/);
  assert.match(functionsIndexSource, /export \{[\s\S]*?createLeagueSecure[\s\S]*?joinLeagueSecure[\s\S]*?\} from '\.\/league-lifecycle-authority';/);
});

test('Production Scoring V3 and Projection V11 remain byte-for-byte unchanged', () => {
  assert.equal(
    sha256(scoringRulesSource),
    'd0ba8838c17737b00cdc5f0dea5e24ffb4e1af2154c2575baf28c3aa83de4901',
  );
  assert.equal(
    sha256(projectionV11Source),
    'e6f3111b1feccc7107e857aa24c5317451c65a84a36c71f8158947636f20d80a',
  );
});
