import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  getCanonicalJoinStatus,
  getUnexpectedDocumentKeys,
  LEAGUE_AUDIT_SCHEMA_VERSION,
  LEAGUE_AUTHORITY_SCHEMA_VERSION,
  LEAGUE_DOCUMENT_KEYS,
  LEAGUE_DOCUMENT_SCHEMA_VERSION,
  LEAGUE_INVITE_DOCUMENT_KEYS,
  LEAGUE_MEMBER_DOCUMENT_KEYS,
  LEAGUE_TEAM_DOCUMENT_KEYS,
  normalizeBoundedInteger,
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
  readinessServiceSource,
  readinessComponentSource,
  readinessTemplateSource,
  packageSource,
  roadmapRootSource,
  roadmapDocsSource,
  documentationSource,
  readmeSource,
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
  read('src/app/core/release/release-readiness.service.ts'),
  read('src/app/features/release/release-readiness/release-readiness.ts'),
  read('src/app/features/release/release-readiness/release-readiness.html'),
  read('package.json'),
  read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
  read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
  read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
  read('README.md'),
  read('src/environments/app-runtime.config.ts'),
  read('src/environments/app-runtime.config.production.ts'),
  read('functions/src/shared/core/scoring/scoring-rules.ts'),
  read('functions/src/shared/core/projection/projection-v11.util.ts'),
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('authority v2 installs exact document schemas and pure canonical helpers', () => {
  assert.equal(LEAGUE_AUTHORITY_SCHEMA_VERSION, 2);
  assert.equal(LEAGUE_DOCUMENT_SCHEMA_VERSION, 1);
  assert.equal(LEAGUE_AUDIT_SCHEMA_VERSION, 1);
  assert.ok(LEAGUE_DOCUMENT_KEYS.includes('competitionSettingsLocked'));
  assert.ok(LEAGUE_INVITE_DOCUMENT_KEYS.includes('lockedReason'));
  assert.ok(LEAGUE_MEMBER_DOCUMENT_KEYS.includes('role'));
  assert.ok(LEAGUE_TEAM_DOCUMENT_KEYS.includes('waiverPriority'));

  assert.deepEqual(
    getUnexpectedDocumentKeys(
      { id: 'league', name: 'Test', hiddenBypass: true },
      ['id', 'name'],
    ),
    ['hiddenBypass'],
  );
  assert.equal(normalizeBoundedInteger(15, 6, 2, 12), 12);
  assert.equal(normalizeBoundedInteger('bad', 6, 2, 12), 6);
  assert.equal(getCanonicalJoinStatus({ teamCount: 6, maxTeams: 6, draftLocked: false }), 'full');
  assert.equal(getCanonicalJoinStatus({ teamCount: 2, maxTeams: 6, draftLocked: true }), 'locked');
  assert.equal(getCanonicalJoinStatus({ teamCount: 2, maxTeams: 6, draftLocked: false }), 'open');
  assert.match(authorityUtilSource, /LEAGUE_AUTHORITY_SCHEMA_VERSION = 2/);
});

test('league, invite, member, and team browser boundaries use strict server-owned schemas', () => {
  assert.match(rulesSource, /match \/leagues\/\{leagueId\}[\s\S]*?allow update: if false;/);
  assert.match(rulesSource, /function validMemberDocumentShape\(leagueId, memberId\)/);
  assert.match(rulesSource, /function validTeamDocumentShape\(teamId\)/);
  assert.match(rulesSource, /data\.keys\(\)\.hasOnly\(\[[\s\S]*?'schemaVersion'[\s\S]*?'accountDeletedAt'/);
  assert.match(rulesSource, /affectedKeys\(\)[\s\S]*?hasOnly\(\['username', 'profileIconId', 'updatedAt'\]/);
  assert.match(rulesSource, /affectedKeys\(\)[\s\S]*?hasOnly\(\['teamName', 'managerName', 'profileIconId', 'logo', 'updatedAt'\]/);
  assert.match(rulesSource, /data\.logo\.size\(\) <= 240/);
  assert.match(rulesSource, /allow delete: if false;/);
});

test('commissioner presentation changes are idempotent, audited, and server-authoritative', () => {
  assert.match(authoritySource, /export const updateLeagueCosmeticsSecure = onCall/);
  assert.match(authoritySource, /requireVerifiedEmail\(request\.auth, 'update league presentation'\)/);
  assert.match(authoritySource, /requireOnlyInputKeys\([\s\S]*?'League presentation update'/);
  assert.match(authoritySource, /createCosmeticsPayloadHash/);
  assert.match(authoritySource, /action: 'league-presentation-updated'/);
  assert.match(authoritySource, /previousValues/);
  assert.match(authoritySource, /newValues: nextValues/);
  assert.match(authoritySource, /reason: input\.reason/);
  assert.match(clientSource, /export async function updateLeaguePresentation/);
  assert.match(clientSource, /'updateLeagueCosmeticsSecure'/);
  assert.match(clientSource, /timeout: 50_000/);
});

test('Draft settings and invite lock changes create immutable audit records', () => {
  assert.match(draftAuthoritySource, /draftSettingsAuditId/);
  assert.match(draftAuthoritySource, /action: 'draft-settings-saved'/);
  assert.match(draftAuthoritySource, /previousValues: existingDraft/);
  assert.match(draftAuthoritySource, /newValues: \{/);
  assert.match(draftAuthoritySource, /action: 'invite-locked'/);
  assert.match(draftAuthoritySource, /release: 'Security Batch S1C'/);
  assert.match(rulesSource, /match \/audit\/\{auditId\}[\s\S]*?allow create, update, delete: if false;/);
});

test('platform-admin migration canonicalizes authority and repairs missing owner records without touching competition history', () => {
  assert.match(authoritySource, /export const migrateLeagueAuthoritySchema = onCall/);
  assert.match(authoritySource, /adminSnapshot\.data\(\)\?\.\['enabled'\] !== true/);
  assert.match(authoritySource, /buildCanonicalLeagueDocument/);
  assert.match(authoritySource, /buildCanonicalInviteDocument/);
  assert.match(authoritySource, /buildCanonicalMemberDocument/);
  assert.match(authoritySource, /buildCanonicalTeamDocument/);
  assert.match(authoritySource, /getUnexpectedDocumentKeys/);
  assert.match(authoritySource, /transaction\.set\(leagueRef, canonicalLeague\)/);
  assert.match(authoritySource, /transaction\.set\(inviteRef, canonicalInvite\)/);
  assert.match(authoritySource, /repairedMemberCount/);
  assert.match(authoritySource, /repairedTeamCount/);
  assert.match(authoritySource, /repairedRosterCount/);
  assert.match(authoritySource, /createEmptyFantasyRoster\(\)/);
  assert.match(authoritySource, /action: 'league-authority-migrated'/);
  assert.doesNotMatch(authoritySource, /recursiveDelete\(/);
});

test('adversarial emulator coverage rejects modified commissioners, hidden fields, oversized identities, and role escalation', () => {
  for (const expectedTest of [
    /commissioners cannot update league presentation directly from the browser/,
    /commissioners cannot change scoring or the six-game competition contract/,
    /commissioners cannot change ownership, capacity, invite identity, or hidden fields/,
    /members cannot escalate role, inject hidden fields, or edit another member/,
    /member identity updates reject oversized names and unsupported icons/,
    /commissioners cannot edit another manager team identity directly/,
    /team identity updates reject hidden fields, oversized values, and owner changes/,
    /a signed-in invitee cannot create membership or team documents directly/,
  ]) {
    assert.match(rulesTestSource, expectedTest);
  }
});

test('Release Readiness exposes the authority-v2 gate and guarded migration control', () => {
  assert.match(readinessServiceSource, /CURRENT_LEAGUE_AUTHORITY_SCHEMA_VERSION = 2/);
  assert.match(readinessServiceSource, /'league-authority-schema'/);
  assert.match(readinessServiceSource, /competitionSettingsLocked === true/);
  assert.match(readinessComponentSource, /migrateLeagueAuthority\(\)/);
  assert.match(readinessComponentSource, /migrateLeagueAuthoritySchema\(this\.leagueId\)/);
  assert.match(readinessTemplateSource, /Verify &amp; Migrate Authority/);
  assert.match(readinessTemplateSource, /League authority/);
});

test('S1C callables, logs, and verification scripts are installed', () => {
  assert.match(functionsIndexSource, /migrateLeagueAuthoritySchema/);
  assert.match(functionsIndexSource, /updateLeagueCosmeticsSecure/);
  assert.match(functionsPackageSource, /migrateLeagueAuthoritySchema/);
  assert.match(functionsPackageSource, /updateLeagueCosmeticsSecure/);

  const packageJson = JSON.parse(packageSource);
  assert.equal(
    packageJson.scripts['test:batchs1c:run'],
    'node --no-warnings --experimental-strip-types --test --test-concurrency=1 test/batchs1c-league-schema-audit-migration/*.test.mjs',
  );
  assert.match(packageJson.scripts['verify:batchs1c'], /verify:batchs1b/);
  assert.match(packageJson.scripts['verify:batchs1c'], /test:batchs1c:run/);
  assert.match(packageJson.scripts['verify:batchs1c'], /validate:release-manifest/);
});

test('the permanent roadmap preserves S1C completion and remains synchronized in later versions', () => {
  assert.equal(roadmapRootSource, roadmapDocsSource);
  assert.match(roadmapRootSource, /Version 1\.\d+(?:\.\d+)?/);
  assert.match(roadmapRootSource, /# \[x\] S1\.8 .*Security Batch S1C/);
  assert.match(roadmapRootSource, /# \[x\] S1\.9 .*Security Batch S1C/);
  assert.match(roadmapRootSource, /# \[x\] S1\.10 .*Security Batch S1C/);
  assert.match(roadmapRootSource, /# \[x\] S1\.11 .*Security Batch S1C/);
  assert.match(roadmapRootSource, /# \[x\] S1\.12 .*Security Batch S1C/);
  assert.match(roadmapRootSource, /# \[x\] SEQ\.3 Security Batch S1C/);
  assert.match(roadmapRootSource, /# \[x\] NEXT\.2 Security Batch S2/);
  assert.match(roadmapRootSource, /\[~\] NEXT\.3 Security Batch S3/);
});

test('RC12 documentation records migration, deployment, rollback, and the remaining App Check gate', () => {
  assert.match(runtimeConfigSource, /releaseLabel: 'Release Candidate \d+'/g);
  assert.match(productionRuntimeConfigSource, /releaseLabel: 'Release Candidate \d+'/g);
  assert.match(documentationSource, /Batch S1C — Strict League Schemas/);
  assert.match(documentationSource, /Functions → Hosting → Migrate active leagues → Firestore Rules/);
  assert.match(documentationSource, /App Check/);
  assert.match(documentationSource, /Firestore Rules → Hosting/);
  assert.match(readmeSource, /verify:batchs1c/);
  assert.match(readmeSource, /Release Candidate \d+/);
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
