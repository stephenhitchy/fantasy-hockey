import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import {
  buildCustomTeamIdentityVariantId,
  CUSTOM_TEAM_IDENTITY_VARIANT_ID,
  getContrastRatio,
  getCustomTeamIdentityLogoOptions,
  getPixelTeamTheme,
  getTeamIdentityVariants,
  NHL_PIXEL_TEAMS,
  parseCustomTeamIdentityVariantId,
  RINKRAT_NEUTRAL_ABBREVIATION,
  TEAM_IDENTITY_UNLOCK_DETAILS,
} from '../../src/app/shared/pixel-theme/pixel-theme.data.ts';
import {
  calculateTeamIdentityChallengeUnlocks,
  normalizeTeamIdentityUnlocks,
} from '../../functions/src/shared/core/user/team-identity-challenge.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

test('every NHL team receives Custom Identity as its sixth scheme', () => {
  assert.equal(NHL_PIXEL_TEAMS.length, 32);

  for (const team of NHL_PIXEL_TEAMS) {
    const variants = getTeamIdentityVariants(team.abbreviation);
    assert.equal(variants.length, 6, team.abbreviation);
    assert.equal(variants[5].variantId, CUSTOM_TEAM_IDENTITY_VARIANT_ID, team.abbreviation);
    assert.equal(variants[5].variantKind, 'custom', team.abbreviation);
    assert.equal(variants[5].unlockRequirement, 'identity-architect', team.abbreviation);
    for (const logoOption of getCustomTeamIdentityLogoOptions(team.abbreviation)) {
      assert.match(logoOption.variantId, /^[a-z0-9-]{1,40}$/, team.abbreviation);
    }
  }

  assert.equal(getTeamIdentityVariants(RINKRAT_NEUTRAL_ABBREVIATION).length, 1);
});

test('custom identities round-trip one team logo and three normalized colors', () => {
  const id = buildCustomTeamIdentityVariantId({
    logoVariantId: 'min-retro-script',
    primaryColor: '#123abc',
    secondaryColor: 'FEDCBA',
    tertiaryColor: '#00aa77',
  });

  assert.equal(id, 'custom-identity~min-retro-script~123ABC~FEDCBA~00AA77');
  assert.deepEqual(parseCustomTeamIdentityVariantId(id), {
    logoVariantId: 'min-retro-script',
    primaryColor: '#123ABC',
    secondaryColor: '#FEDCBA',
    tertiaryColor: '#00AA77',
  });
  assert.equal(parseCustomTeamIdentityVariantId('custom-identity~bad/id~FFFFFF~000000~FF0000'), null);
  assert.equal(parseCustomTeamIdentityVariantId('custom-identity~home~FFFFFF~000000'), null);
});

test('custom identity resolution uses only the selected club logo catalog', () => {
  const team = NHL_PIXEL_TEAMS.find((candidate) => candidate.abbreviation === 'MIN');
  assert.ok(team);
  const logoOptions = getCustomTeamIdentityLogoOptions('MIN');
  assert.ok(logoOptions.length >= 1);

  const chosenLogo = logoOptions.at(-1);
  assert.ok(chosenLogo);
  const id = buildCustomTeamIdentityVariantId({
    logoVariantId: chosenLogo.variantId,
    primaryColor: '#102030',
    secondaryColor: '#E0F0FF',
    tertiaryColor: '#C8102E',
  });
  const custom = getPixelTeamTheme('MIN', id);

  assert.equal(custom.variantKind, 'custom');
  assert.equal(custom.logoUrl, chosenLogo.logoUrl);
  assert.equal(custom.primaryColor, '#102030');
  assert.equal(custom.secondaryColor, '#E0F0FF');
  assert.equal(custom.tertiaryColor, '#C8102E');

  const unknownLogo = getPixelTeamTheme(
    'MIN',
    'custom-identity~not-a-minnesota-logo~102030~E0F0FF~C8102E',
  );
  assert.equal(unknownLogo.logoUrl, getTeamIdentityVariants('MIN')[0].logoUrl);

  const darkCustom = getPixelTeamTheme(
    'MIN',
    'custom-identity~current-home~000000~050505~101010',
  );
  assert.ok(getContrastRatio(darkCustom.accentColor, '#0D1520') >= 3);
});

test('Identity Architect is the permanent meta-challenge after all four foundations', () => {
  assert.equal(TEAM_IDENTITY_UNLOCK_DETAILS['identity-architect'].challengeTitle, 'Identity Architect');
  assert.match(
    TEAM_IDENTITY_UNLOCK_DETAILS['identity-architect'].rewardLabel,
    /Custom logo and three-color identity for every NHL team/,
  );

  assert.deepEqual(calculateTeamIdentityChallengeUnlocks({
    existingUnlocks: [],
    leagueCount: 1,
    commissionerLeagueCount: 0,
    opponentCount: 0,
  }), ['first-line-change']);

  assert.deepEqual(calculateTeamIdentityChallengeUnlocks({
    existingUnlocks: ['first-line-change'],
    leagueCount: 3,
    commissionerLeagueCount: 1,
    opponentCount: 10,
  }), [
    'first-line-change',
    'commissioner-mode',
    'league-explorer',
    'crowded-schedule',
    'identity-architect',
  ]);

  assert.deepEqual(normalizeTeamIdentityUnlocks([
    'identity-architect',
    'unknown',
    'first-line-change',
    'first-line-change',
  ]), ['first-line-change', 'identity-architect']);
});

test('challenge reconciliation is authenticated, bounded, and transactionally permanent', async () => {
  const source = await read('functions/src/team-identity-challenges.ts');

  assert.match(source, /export const reconcileTeamIdentityChallenges = onCall/);
  assert.match(source, /if \(!request\.auth\?\.uid\)/);
  assert.match(source, /collectionGroup\('members'\)/);
  assert.match(source, /where\('uid', '==', userId\)/);
  assert.match(source, /leagueRef\.parent\.id !== 'leagues'/);
  assert.match(source, /MAX_LEAGUES_PER_RECONCILIATION = 32/);
  assert.match(source, /db\.runTransaction/);
  assert.match(source, /calculateTeamIdentityChallengeUnlocks/);
  assert.match(source, /teamIdentityUnlocks: unlocks/);
  assert.doesNotMatch(source, /request\.data.*teamIdentityUnlocks/s);
});

test('custom profile saving trusts server unlocks and rejects neutral or unearned custom identities', async () => {
  const source = await read('functions/src/manager-profile-authority.ts');

  assert.match(source, /'identity-architect'/);
  assert.match(source, /value\.length > 5/);
  assert.match(source, /variantId\.startsWith\('custom-identity'\)/);
  assert.match(source, /\^custom-identity~/);
  assert.match(source, /favoriteTeamAbbreviation === 'RR'/);
  assert.match(source, /action === 'initialize' && requiresIdentityArchitectUnlock/);
  assert.match(source, /existingData\['teamIdentityUnlocks'\]/);
  assert.match(source, /Complete the Identity Architect challenge/);
});

test('browser challenge and team identity writes are locked while safe legacy profile creation remains possible', async () => {
  const [rules, rulesTest] = await Promise.all([
    read('firestore.rules'),
    read('test/firestore-rules/firestore.rules.test.mjs'),
  ]);

  assert.match(rules, /data\.teamIdentityUnlocks\.size\(\) <= 5/);
  assert.match(rules, /'identity-architect'/);
  const updateAllowlist = rules.match(/function validUserProfileUpdate\(\)[\s\S]*?allow create:/)?.[0] ?? '';
  assert.doesNotMatch(updateAllowlist, /'teamIdentityUnlocks'/);
  assert.doesNotMatch(updateAllowlist, /'favoriteTeamAbbreviation'/);
  assert.doesNotMatch(updateAllowlist, /'favoriteTeamVariantId'/);
  assert.match(rules, /request\.resource\.data\.favoriteTeamVariantId == 'current-home'/);
  assert.match(rules, /request\.resource\.data\.teamIdentityUnlocks\.size\(\) == 0/);
  assert.match(rules, /function publicProfileMatchesPrivateProfile\(\)/);
  assert.match(rules, /existsAfter\(privateProfilePath\)/);
  assert.match(rulesTest, /team identity challenge rewards are server-owned/);
  assert.match(rulesTest, /team identity is callable-owned/);
  assert.match(rulesTest, /Public-only team identity forgery/);
});

test('Account Settings provides one inline logo and three-color editor without an overlay', async () => {
  const [component, template, styles] = await Promise.all([
    read('src/app/features/account/account-settings/account-settings.ts'),
    read('src/app/features/account/account-settings/account-settings.html'),
    read('src/app/features/account/account-settings/account-settings.css'),
  ]);

  assert.match(component, /buildCustomTeamIdentityVariantId/);
  assert.match(component, /getCustomTeamIdentityLogoOptions/);
  assert.match(component, /saveCustomIdentity/);
  assert.match(component, /fragment === 'team-identity-customizer'/);
  assert.match(component, /destroyRef\.onDestroy[\s\S]*?previewPreferenceChanges/);
  assert.match(template, /id="team-identity-customizer"/);
  assert.match(template, /Identity Architect/);
  assert.match(template, /Choose a team logo/);
  assert.equal((template.match(/type="color"/g) ?? []).length, 3);
  assert.match(template, /Use Custom Identity/);
  assert.match(styles, /custom-logo-grid/);
  assert.match(styles, /custom-color-grid/);
  assert.doesNotMatch(template, /role="dialog"|viewport-overlay|action-sheet/i);
  const customStyles = styles.slice(styles.indexOf('#team-identity-customizer'));
  assert.doesNotMatch(customStyles, /position:\s*(?:fixed|sticky)|backdrop-filter/i);
});

test('new challenge completions queue in a top-right nonblocking notification with a direct editor link', async () => {
  const [service, appSource, appTemplate, appStyles, createLeague, joinLeague] = await Promise.all([
    read('src/app/core/user/team-identity-challenge.service.ts'),
    read('src/app/app.ts'),
    read('src/app/app.html'),
    read('src/app/app.css'),
    read('src/app/features/leagues/create-league/create-league.ts'),
    read('src/app/features/leagues/join-league/join-league.ts'),
  ]);

  assert.match(service, /pendingCompletions/);
  assert.match(service, /REFRESH_THROTTLE_MILLISECONDS = 60_000/);
  assert.match(service, /COMPLETION_VISIBLE_MILLISECONDS = 10_000/);
  assert.match(service, /showNextCompletion/);
  assert.match(service, /refreshGeneration/);
  assert.match(service, /this\.refreshPromise === refreshPromise/);
  assert.match(appSource, /TeamIdentityChallengeService/);
  assert.match(appSource, /NavigationEnd/);
  assert.match(appSource, /addEventListener\('focus'/);
  assert.equal((appSource.match(/challengeService\.refresh\(/g) ?? []).length, 2);
  assert.match(createLeague, /challengeService\.refresh\(user\.uid, \{ force: true \}\)/);
  assert.match(joinLeague, /challengeService\.refresh\(user\.uid, \{ force: true \}\)/);
  assert.match(appTemplate, /Challenge complete/);
  assert.match(appTemplate, /routerLink="\/account\/settings"/);
  assert.match(appTemplate, /fragment="team-identity-customizer"/);
  assert.match(appTemplate, /Open Team Identity/);
  assert.match(appStyles, /\.challenge-completion-toast[\s\S]*?position:\s*fixed/);
  assert.match(appStyles, /right:\s*14px/);
  assert.doesNotMatch(appTemplate, /role="dialog"|backdrop/i);
});

test('C1K remains intact under RC38 while preserving frozen competitive sources and safety modes', async () => {
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

  assert.equal(createHash('sha256').update(scoringRules).digest('hex'), PROTECTED_SOURCE_HASHES.scoringRules);
  assert.equal(createHash('sha256').update(scoringEngine).digest('hex'), PROTECTED_SOURCE_HASHES.scoringEngine);
  assert.equal(createHash('sha256').update(projectionV11).digest('hex'), PROTECTED_SOURCE_HASHES.projectionV11);
  assert.equal(createHash('sha256').update(firestoreRules).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreRules);
  assert.equal(createHash('sha256').update(firestoreIndexes).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreIndexes);
  assert.match(runtime, /Release Candidate 43/);
  assert.match(productionRuntime, /Release Candidate 43/);
  assert.equal(freeze.releaseLabel, 'Release Candidate 43');
  assert.equal(freeze.verificationCommand, 'npm run verify:batcha1e');
  assert.equal(freeze.defaultTag, 'rinkrat-rc43-invite-beta');
  assert.equal(freeze.scoringRulesVersion, 3);
  assert.equal(freeze.projectionVersion, 11);
  assert.equal(freeze.requiredGamesPerRosterSlot, 6);
  assert.equal(freeze.queueMode, 'shadow');
  assert.equal(freeze.appCheckMode, 'monitor');
  assert.equal(appCheck.mode, 'monitor');
  assert.equal(canary.automaticPromotion, false);
  assert.equal(cache.mode, 'shadow');
  assert.equal(cache.authoritativeReadsEnabled, false);
  assert.match(packageJson.scripts['verify:batcha1a:core'], /verify:batchc1l:core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batcha1e:core/);
});

test('C1K documentation and permanent roadmap record the cosmetic-only release', async () => {
  const [roadmap, docsRoadmap, runbook, readme, releaseRunbook] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_SOCIAL_C1K_IDENTITY_ARCHITECT.md'),
    read('README.md'),
    read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
  ]);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.34/);
  assert.match(roadmap, /# \[x\] X1\.10/);
  assert.match(roadmap, /# \[x\] LOG\.46 2026-08-17/);
  assert.match(runbook, /sixth identity option/);
  assert.match(runbook, /reconcileTeamIdentityChallenges/);
  assert.match(runbook, /top-right notification/);
  assert.match(runbook, /No index, TTL, App Check, scoring queue, or NHL-cache deployment belongs to C1K/);
  assert.match(readme, /Release Candidate 43 \/ Product Batch A1E/);
  assert.match(readme, /RINKRAT_SOCIAL_C1K_IDENTITY_ARCHITECT\.md/);
  assert.match(releaseRunbook, /npm run verify:batcha1e/);
  assert.match(releaseRunbook, /rinkrat-rc43-validation\.json/);
  assert.match(releaseRunbook, /rinkrat-rc43-invite-beta/);
});
