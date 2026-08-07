import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function read(relativePath) {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

const [
  authoritySource,
  clientSource,
  rulesSource,
  indexSource,
  packageSource,
  roadmapSource,
  scoringRulesSource,
  projectionV11Source,
  leagueLogoDataSource,
  profileIconDataSource,
  runtimeConfigSource,
  productionRuntimeConfigSource,
  documentationSource,
] = await Promise.all([
  read('functions/src/league-lifecycle-authority.ts'),
  read('src/app/core/league/league.service.ts'),
  read('firestore.rules'),
  read('functions/src/index.ts'),
  read('package.json'),
  read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
  read('functions/src/shared/core/scoring/scoring-rules.ts'),
  read('functions/src/shared/core/projection/projection-v11.util.ts'),
  read('src/app/shared/league-logo/league-logo.data.ts'),
  read('src/app/shared/profile-icon/profile-icon.data.ts'),
  read('src/environments/app-runtime.config.ts'),
  read('src/environments/app-runtime.config.production.ts'),
  read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('league creation is one authenticated server-owned transaction', () => {
  assert.match(authoritySource, /export const createLeagueSecure = onCall/);
  assert.match(authoritySource, /requireAuthenticatedUserId\(request\.auth(?:,\s*'create a league')?\)/);
  assert.match(authoritySource, /db\.runTransaction/);

  for (const requiredWrite of [
    /transaction\.create\(leagueRef/,
    /transaction\.create\(inviteRef/,
    /transaction\.create\(memberRef/,
    /transaction\.create\(\s*teamRef/,
    /transaction\.create\(rosterRef/,
    /transaction\.create\(auditRef/,
    /transaction\.create\(requestRef/,
  ]) {
    assert.match(authoritySource, requiredWrite);
  }
});

test('the server freezes the production competition contract at creation', () => {
  assert.match(authoritySource, /scoringRules: defaultScoringRules/);
  assert.match(authoritySource, /scoringRulesVersion: CURRENT_SCORING_RULES_VERSION/);
  assert.match(authoritySource, /matchupFormat: 'cycle_matchup'/);
  assert.match(authoritySource, /competitionSettingsLocked: true/);
  assert.match(authoritySource, /authoritySchemaVersion: LEAGUE_AUTHORITY_SCHEMA_VERSION/);
  assert.match(authoritySource, /createdByAuthority: 'createLeagueSecure'/);
});

test('creation retries are idempotent and reject payload substitution', () => {
  assert.match(authoritySource, /createPayloadHash/);
  assert.match(authoritySource, /createRequestDocumentId/);
  assert.match(authoritySource, /requestSnapshot\.exists/);
  assert.match(authoritySource, /idempotentReplay: true/);
  assert.match(authoritySource, /payloadHash/);
  assert.match(authoritySource, /This request was already used with different league settings/);
  assert.match(authoritySource, /MAX_INVITE_CODE_ATTEMPTS/);
  assert.match(authoritySource, /InviteCodeCollisionError/);
});

test('the browser uses the secure callable and keeps one request identity across retries', () => {
  const createStart = clientSource.indexOf('export async function createLeague(');
  const createEnd = clientSource.indexOf('export async function getMyLeagues()', createStart);
  const createSection = clientSource.slice(createStart, createEnd);

  assert.ok(createStart >= 0 && createEnd > createStart);
  assert.match(createSection, /'createLeagueSecure'/);
  assert.match(createSection, /timeout: 50_000/);
  assert.match(createSection, /requestId: pending\.requestId/);
  assert.doesNotMatch(createSection, /writeBatch\(|batch\.set\(|setDoc\(/);
  assert.match(clientSource, /PENDING_LEAGUE_CREATION_STORAGE_KEY/);
  assert.match(clientSource, /existing\?\.fingerprint === fingerprint/);
  assert.match(clientSource, /inMemoryPendingLeagueCreation/);
});

test('Firestore denies browser league creation and routes presentation changes through audited authority', () => {
  assert.match(
    rulesSource,
    /match \/leagues\/\{leagueId\}[\s\S]*?allow create: if false;/,
  );
  assert.match(
    rulesSource,
    /match \/leagues\/\{leagueId\}[\s\S]*?allow update: if false;/,
  );
  assert.match(authoritySource, /export const updateLeagueCosmeticsSecure = onCall/);
  assert.match(authoritySource, /action: 'league-presentation-updated'/);
  assert.match(authoritySource, /previousValues/);
  assert.match(authoritySource, /newValues: nextValues/);
});

test('league lifecycle audit records are member-readable and browser-immutable', () => {
  assert.match(authoritySource, /audit\/league-created/);
  assert.match(authoritySource, /authority: 'cloud-function'/);
  assert.match(
    rulesSource,
    /match \/audit\/\{auditId\}[\s\S]*?allow read: if isLeagueMember\(leagueId\);[\s\S]*?allow create, update, delete: if false;/,
  );
});

test('the callable is exported and the S1A verification command is installed', () => {
  assert.match(indexSource, /export \{[\s\S]*?createLeagueSecure[\s\S]*?joinLeagueSecure[\s\S]*?\} from '\.\/league-lifecycle-authority';/);
  const packageJson = JSON.parse(packageSource);
  assert.equal(
    packageJson.scripts['test:batchs1a:run'],
    'node --no-warnings --experimental-strip-types --test --test-concurrency=1 test/batchs1a-league-authority/*.test.mjs',
  );
  assert.match(packageJson.scripts['verify:batchs1a'], /verify:batchr1f/);
  assert.match(packageJson.scripts['verify:batchs1a'], /test:batchs1a:run/);
});

test('the permanent roadmap records S1A without deleting completed work', () => {
  assert.match(roadmapSource, /# \[x\] S1\.1 .*Completed 2026-08-07 in Security Batch S1A/);
  assert.match(roadmapSource, /# \[x\] S1\.2 .*Completed 2026-08-07 in Security Batch S1A/);
  assert.match(roadmapSource, /# \[x\] S1\.3 .*Completed 2026-08-07 in Security Batch S1A/);
  assert.match(roadmapSource, /# \[x\] SEQ\.1 Security Batch S1A/);
  assert.match(roadmapSource, /(?:\[ \]|# \[x\]) SEQ\.2 Security Batch S1B/);
});


test('server allowlists remain synchronized with the browser league and profile identity catalogs', () => {
  for (const match of leagueLogoDataSource.matchAll(/'([a-z0-9-]+)'/g)) {
    const value = match[1];
    if (value.startsWith('assets') || value === 'league') {
      continue;
    }
    assert.match(authoritySource, new RegExp(`'${value}'`));
  }

  const profileIdBlock = profileIconDataSource.match(
    /export const PROFILE_ICON_IDS = \[([\s\S]*?)\] as const;/,
  )?.[1] ?? '';
  for (const match of profileIdBlock.matchAll(/'([a-z0-9-]+)'/g)) {
    assert.match(authoritySource, new RegExp(`'${match[1]}'`));
  }
});

test('current documentation continues recording the secure S1A deployment and rollback order', () => {
  assert.match(runtimeConfigSource, /releaseLabel: 'Release Candidate 12'/);
  assert.match(productionRuntimeConfigSource, /releaseLabel: 'Release Candidate 12'/);
  assert.match(documentationSource, /Batch S1A — Server-Authoritative League Creation/);
  assert.match(documentationSource, /Functions → Hosting → Firestore Rules/);
  assert.match(documentationSource, /Firestore Rules → Hosting/);
});

test('Production Scoring V3 and Projection V11 remain unchanged from RC9', () => {
  assert.equal(
    sha256(scoringRulesSource),
    'd0ba8838c17737b00cdc5f0dea5e24ffb4e1af2154c2575baf28c3aa83de4901',
  );
  assert.equal(
    sha256(projectionV11Source),
    'e6f3111b1feccc7107e857aa24c5317451c65a84a36c71f8158947636f20d80a',
  );
});
