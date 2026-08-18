import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import {
  MAXIMUM_PASSWORD_LENGTH,
  MINIMUM_PASSWORD_LENGTH,
  RECENT_AUTHENTICATION_WINDOW_SECONDS,
  passwordMeetsRegistrationPolicy,
  passwordRequirementSummary,
} from '../../src/app/core/auth/auth-security.config.ts';

async function read(relativePath) {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

const [
  appCheckSource,
  appCheckConfigSource,
  appCheckConfigScriptSource,
  securityReadinessClientSource,
  securityAuthoritySource,
  authSecuritySource,
  recentAuthSource,
  authComponentSource,
  authTemplateSource,
  authStylesSource,
  adminStepUpSource,
  adminStepUpTemplateSource,
  adminCenterSource,
  adminCenterTemplateSource,
  releaseServiceSource,
  releaseModelsSource,
  releaseComponentSource,
  releaseTemplateSource,
  leagueDetailSource,
  leagueDetailTemplateSource,
  functionsIndexSource,
  leagueAutomationSource,
  leagueLifecycleSource,
  projectionAuthoritySource,
  authBaselineSource,
  packageSource,
  functionsPackageSource,
  readmeSource,
  documentationSource,
  setupGuideSource,
  roadmapRootSource,
  roadmapDocsSource,
  runtimeConfigSource,
  productionRuntimeConfigSource,
] = await Promise.all([
  read('src/app/core/firebase-app-check.ts'),
  read('src/environments/app-check.config.ts'),
  read('scripts/configure-app-check.mjs'),
  read('src/app/core/security/security-readiness.service.ts'),
  read('functions/src/security-authority.ts'),
  read('functions/src/shared/security/auth-security.util.ts'),
  read('src/app/core/auth/recent-auth.service.ts'),
  read('src/app/features/auth/auth.ts'),
  read('src/app/features/auth/auth.html'),
  read('src/app/features/auth/auth.css'),
  read('src/app/shared/admin-session-step-up/admin-session-step-up.ts'),
  read('src/app/shared/admin-session-step-up/admin-session-step-up.html'),
  read('src/app/features/admin/admin-center/admin-center.ts'),
  read('src/app/features/admin/admin-center/admin-center.html'),
  read('src/app/core/release/release-readiness.service.ts'),
  read('src/app/core/release/release-readiness.models.ts'),
  read('src/app/features/release/release-readiness/release-readiness.ts'),
  read('src/app/features/release/release-readiness/release-readiness.html'),
  read('src/app/features/leagues/league-detail/league-detail.ts'),
  read('src/app/features/leagues/league-detail/league-detail.html'),
  read('functions/src/index.ts'),
  read('functions/src/league-automation.ts'),
  read('functions/src/league-lifecycle-authority.ts'),
  read('functions/src/projection-authority.ts'),
  read('functions/scripts/auth-security-baseline.cjs'),
  read('package.json'),
  read('functions/package.json'),
  read('README.md'),
  read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
  read('docs/RINKRAT_SECURITY_S3A_SETUP.md'),
  read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
  read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
  read('src/environments/app-runtime.config.ts'),
  read('src/environments/app-runtime.config.production.ts'),
]);

test('registration password policy is 12 through 128 characters without breaking existing sign-in passwords', () => {
  assert.equal(MINIMUM_PASSWORD_LENGTH, 12);
  assert.equal(MAXIMUM_PASSWORD_LENGTH, 128);
  assert.equal(RECENT_AUTHENTICATION_WINDOW_SECONDS, 15 * 60);
  assert.equal(passwordMeetsRegistrationPolicy('x'.repeat(11)), false);
  assert.equal(passwordMeetsRegistrationPolicy('x'.repeat(12)), false);
  assert.equal(passwordMeetsRegistrationPolicy('RinkRat2026!'), true);
  assert.equal(passwordMeetsRegistrationPolicy(`R${'x'.repeat(125)}1!`), true);
  assert.equal(passwordMeetsRegistrationPolicy(`R${'x'.repeat(126)}1!`), false);
  assert.match(passwordRequirementSummary(), /12–128 characters/);
  assert.match(passwordRequirementSummary(), /capital letter, number, and special character/);
  assert.match(authComponentSource, /passwordMeetsRegistrationPolicy/);
  assert.match(authTemplateSource, /\[attr\.minlength\]="isRegistering\(\) \? 12 : null"/);
  assert.match(authTemplateSource, /\[attr\.maxlength\]="isRegistering\(\) \? 128 : null"/);
  assert.match(authTemplateSource, /passwordRequirementText/);
  assert.match(authStylesSource, /password-policy-hint/);
  assert.match(authTemplateSource, /Password requirements/);
  assert.match(authTemplateSource, /passwordRequirementsMetCount\(\)/);
  assert.match(authTemplateSource, /password-requirement-list/);
  assert.match(authComponentSource, /validateRegistrationPassword/);
  assert.doesNotMatch(authTemplateSource, /minlength="12"[\s\S]*?autocomplete="current-password"/);
});

test('authentication errors avoid account-enumeration disclosures in registration and recovery flows', () => {
  assert.match(authComponentSource, /If an account exists for that email, a password-reset link has been sent/);
  assert.match(authComponentSource, /The email or password is incorrect/);
  assert.doesNotMatch(authComponentSource, /An account already exists for that email/);
  assert.doesNotMatch(authComponentSource, /No account exists for that email/);
});

test('App Check initializes the reCAPTCHA Enterprise monitor client and verifies a bounded token', () => {
  assert.match(appCheckSource, /ReCaptchaEnterpriseProvider/);
  assert.match(appCheckSource, /initializeAppCheck/);
  assert.match(appCheckSource, /getToken\(initializedAppCheck, forceRefresh\)/);
  assert.match(appCheckSource, /20_000/);
  assert.match(appCheckSource, /status: 'valid'/);
  assert.match(appCheckSource, /listenToRinkRatAppCheckState/);
  assert.match(appCheckSource, /localDebugTokenEnabled/);
  assert.match(appCheckSource, /hostname === 'localhost'/);
  const enabledMatch = appCheckConfigSource.match(/enabled:\s*(true|false)/);
  const siteKeyMatch = appCheckConfigSource.match(/recaptchaEnterpriseSiteKey:\s*'([^']*)'/);
  const localDebugMatch = appCheckConfigSource.match(/localDebugTokenEnabled:\s*(true|false)/);

  assert.ok(enabledMatch, 'App Check config must declare enabled as a boolean.');
  assert.ok(siteKeyMatch, 'App Check config must declare the public Enterprise site key.');
  assert.ok(localDebugMatch, 'App Check config must declare local debug-token discovery explicitly.');

  const appCheckEnabled = enabledMatch[1] === 'true';
  const configuredSiteKey = siteKeyMatch[1];

  if (appCheckEnabled) {
    assert.match(
      configuredSiteKey,
      /^[A-Za-z0-9_-]{20,250}$/,
      'Enabled App Check must include a valid public reCAPTCHA Enterprise site key.',
    );
  } else {
    assert.equal(
      configuredSiteKey,
      '',
      'Disabled App Check should not retain a production site key in the client config.',
    );
  }

  assert.doesNotMatch(functionsIndexSource + leagueAutomationSource + leagueLifecycleSource + projectionAuthoritySource, /enforceAppCheck\s*:\s*true/);
});

test('App Check configuration script enables, locally debugs, and disables only the public client config', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rinkrat-app-check-'));

  try {
    await mkdir(path.join(root, 'scripts'), { recursive: true });
    await mkdir(path.join(root, 'src', 'environments'), { recursive: true });
    await copyFile(
      new URL('../../scripts/configure-app-check.mjs', import.meta.url),
      path.join(root, 'scripts', 'configure-app-check.mjs'),
    );
    await writeFile(
      path.join(root, 'src', 'environments', 'app-check.config.ts'),
      appCheckConfigSource,
    );

    const validSiteKey = '6Lexample_public_enterprise_site_key_123456789';
    const enable = spawnSync(
      process.execPath,
      [path.join(root, 'scripts', 'configure-app-check.mjs'), `--site-key=${validSiteKey}`, '--local-debug'],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(enable.status, 0, enable.stderr || enable.stdout);

    const enabledSource = await readFile(
      path.join(root, 'src', 'environments', 'app-check.config.ts'),
      'utf8',
    );
    assert.match(enabledSource, /enabled: true/);
    assert.match(enabledSource, new RegExp(`recaptchaEnterpriseSiteKey: '${validSiteKey}'`));
    assert.match(enabledSource, /localDebugTokenEnabled: true/);

    const disable = spawnSync(
      process.execPath,
      [path.join(root, 'scripts', 'configure-app-check.mjs'), '--disable'],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(disable.status, 0, disable.stderr || disable.stdout);

    const disabledSource = await readFile(
      path.join(root, 'src', 'environments', 'app-check.config.ts'),
      'utf8',
    );
    assert.match(disabledSource, /enabled: false/);
    assert.match(disabledSource, /recaptchaEnterpriseSiteKey: ''/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  assert.match(appCheckConfigScriptSource, /public reCAPTCHA Enterprise site key/i);
  assert.doesNotMatch(appCheckConfigScriptSource, /privateKey|serviceAccount|client_secret/i);
});

test('security readiness verifies both the browser token and the server-received App Check context', () => {
  assert.match(securityReadinessClientSource, /verifyRinkRatAppCheckToken\(false\)/);
  assert.match(securityReadinessClientSource, /getSecurityControlReadiness/);
  assert.match(securityReadinessClientSource, /timeout: 35_000/);
  assert.match(securityAuthoritySource, /request\.app \? 'valid' : 'missing'/);
  assert.match(securityAuthoritySource, /request\.app\?\.appId/);
  assert.match(securityAuthoritySource, /projectConfigManager\(\)\.getProjectConfig\(\)/);
  assert.match(securityAuthoritySource, /requirePlatformAdministrator\(request\.auth\)/);
  assert.match(securityAuthoritySource, /platformAdmins\/\$\{userId\}/);
  assert.match(securityAuthoritySource, /PROJECT_CONFIG_CACHE_MILLISECONDS = 5 \* 60 \* 1_000/);
  assert.match(securityAuthoritySource, /configuration could not be inspected/);
  assert.doesNotMatch(securityAuthoritySource, /error\.message\.slice\(/);
  assert.match(securityAuthoritySource, /passwordPolicyConfig/);
  assert.match(securityAuthoritySource, /emailPrivacyConfig/);
  assert.match(securityAuthoritySource, /multiFactorConfig/);
  assert.match(functionsIndexSource, /export \{ getSecurityControlReadiness \} from '\.\/security-authority'/);
});

test('Firebase Authentication baseline is inspectable and mutations require explicit operator confirmation', () => {
  assert.match(authBaselineSource, /applicationDefault\(\)/);
  assert.match(authBaselineSource, /projectConfigManager\(\)/);
  assert.match(authBaselineSource, /RINKRAT_APPLY_AUTH_SECURITY !== 'APPLY'/);
  assert.match(authBaselineSource, /enforcementState: 'ENFORCE'/);
  assert.match(authBaselineSource, /minimumLength: 12/);
  assert.match(authBaselineSource, /minLength: RINKRAT_AUTH_POLICY\.minimumLength/);
  assert.match(authBaselineSource, /maximumLength: 128/);
  assert.match(authBaselineSource, /maxLength: RINKRAT_AUTH_POLICY\.maximumLength/);
  assert.match(authBaselineSource, /forceUpgradeOnSignin: false/);
  assert.match(authBaselineSource, /enableImprovedEmailPrivacy: true/);
  assert.match(authBaselineSource, /Inspection only\. No Firebase Authentication settings were changed/);
  assert.match(functionsPackageSource, /security:inspect-auth/);
  assert.match(functionsPackageSource, /security:apply-auth-baseline/);
});

test('recent authentication uses the ID-token auth_time claim and a 15-minute server-enforced window', () => {
  assert.match(authSecuritySource, /RECENT_AUTHENTICATION_WINDOW_SECONDS = 15 \* 60/);
  assert.match(authSecuritySource, /auth\?\.token\?\.\['auth_time'\]/);
  assert.match(authSecuritySource, /reason: 'recent-authentication-required'/);
  assert.match(authSecuritySource, /requireVerifiedRecentAuthentication/);
  assert.match(recentAuthSource, /EmailAuthProvider\.credential/);
  assert.match(recentAuthSource, /reauthenticateWithCredential/);
  assert.match(recentAuthSource, /user\.getIdToken\(true\)/);
  assert.match(recentAuthSource, /getIdTokenResult/);
  assert.match(recentAuthSource, /RECENT_AUTHENTICATION_WINDOW_SECONDS/);
});

test('high-impact platform, replay, projection, migration, deletion, and review mutations require recent authentication', () => {
  assert.match(leagueAutomationSource, /change the live scoring queue rollout/);
  assert.match(leagueAutomationSource, /run a live scoring canary check/);
  assert.match(leagueAutomationSource, /advance a historical replay league/);
  assert.equal((leagueAutomationSource.match(/requireVerifiedRecentAuthentication\(/g) ?? []).length >= 3, true);
  assert.match(leagueLifecycleSource, /migrate this league to the current authority schema/);
  assert.match(projectionAuthoritySource, /verify or restore a Draft projection snapshot/);
  assert.match(functionsIndexSource, /permanently delete this league/);
  assert.match(functionsIndexSource, /permanently delete your account/);
  assert.match(functionsIndexSource, /force a shared injury refresh/);
  assert.match(functionsIndexSource, /change a feedback review/);
  assert.match(functionsIndexSource, /change an error review/);
});

test('administrator password step-up is inline, accessible, and integrated without another blocking overlay', () => {
  assert.match(adminStepUpSource, /RecentAuthService/);
  assert.match(adminStepUpSource, /reauthenticate\(this\.password\)/);
  assert.match(adminStepUpSource, /15 minutes/);
  assert.match(adminStepUpTemplateSource, /autocomplete="current-password"/);
  assert.match(adminStepUpTemplateSource, /Unlock Protected Actions/);
  assert.match(adminStepUpTemplateSource, /role="status"/);
  assert.doesNotMatch(adminStepUpTemplateSource, /backdrop|overlay|position:\s*fixed/i);
  assert.match(adminCenterSource, /AdminSessionStepUp/);
  assert.match(adminCenterTemplateSource, /<app-admin-session-step-up/);
  assert.match(releaseComponentSource, /AdminSessionStepUp/);
  assert.match(releaseTemplateSource, /<app-admin-session-step-up/);
});

test('league deletion locally refreshes the secure session before the server deletion request', () => {
  assert.match(leagueDetailSource, /deleteLeaguePasswordDraft/);
  assert.match(leagueDetailSource, /reauthenticateCurrentUserWithPassword\(this\.deleteLeaguePasswordDraft\)/);
  assert.match(leagueDetailTemplateSource, /id="delete-league-password-confirmation"/);
  assert.match(leagueDetailTemplateSource, /autocomplete="current-password"/);
  assert.match(leagueDetailTemplateSource, /\[disabled\]="!canDeleteLeague\(\)"/);
});

test('Release Readiness reports App Check, password, email privacy, session age, and MFA separately', () => {
  assert.match(releaseModelsSource, /export interface ReleaseSecuritySummary/);
  assert.match(releaseModelsSource, /appCheckServerStatus/);
  assert.match(releaseModelsSource, /passwordPolicyEnforcement/);
  assert.match(releaseModelsSource, /emailEnumerationProtectionEnabled/);
  assert.match(releaseModelsSource, /recentAuthenticationReady/);
  assert.match(releaseModelsSource, /multiFactorState/);
  assert.match(releaseServiceSource, /Firebase App Check monitor client is verified end to end/);
  assert.match(releaseServiceSource, /Firebase Authentication password policy is enforced/);
  assert.match(releaseServiceSource, /Email-enumeration protection is enabled/);
  assert.match(releaseServiceSource, /Protected administrator session is unlocked/);
  assert.match(releaseTemplateSource, /<span>App Check<\/span>/);
  assert.match(releaseTemplateSource, /current\.security\.appCheckClientStatus/);
  assert.match(releaseTemplateSource, /current\.security\.passwordPolicyEnforcement/);
  assert.match(releaseTemplateSource, /current\.security\.emailEnumerationProtectionEnabled/);
  assert.match(releaseTemplateSource, /current\.security\.recentAuthenticationReady/);
});

test('S3A remains monitor-only and documents the deliberate activation and enforcement sequence', () => {
  assert.match(setupGuideSource, /monitor mode/i);
  assert.match(setupGuideSource, /Do not enable App Check enforcement/i);
  assert.match(setupGuideSource, /security:configure-app-check/);
  assert.match(setupGuideSource, /security:inspect-auth/);
  assert.match(setupGuideSource, /security:apply-auth-baseline/);
  assert.match(setupGuideSource, /S3A does not set `enforceAppCheck: true`/);
  assert.match(documentationSource, /Security Batch S3A — App Check Monitor Mode and Authentication Hardening/);
  assert.match(readmeSource, /Release Candidate \d+ \/ (?:Security S3[AB](?:\.\d+)?|Onboarding Batch B1A|Security Batch S3C|Security Batch S3D|Security Batch S3E|Security Batch S3F|Beta Operations Batch B1B|Data Quality Batch D1A|Data Quality Batch D1B|Social Batch C1A|Social Batch C1B|Social Batch C1C|Social Batch C1D|Social Batch C1E|Social Batch C1F|Social Batch C1G|Social Batch C1H|Social Batch C1I|Social Batch C1J|Social Batch C1K|Product Batch A1A|Product Batch A1B|Product Batch A1C|Product Batch A1D)/);
});

test('S3A verification, release manifest, permanent roadmap, and package commands stay synchronized', () => {
  const packageJson = JSON.parse(packageSource);
  const functionsPackageJson = JSON.parse(functionsPackageSource);

  assert.equal(
    packageJson.scripts['test:batchs3a:run'],
    'node --no-warnings --experimental-strip-types --test --test-concurrency=1 test/batchs3a-app-check-auth-hardening/*.test.mjs',
  );
  assert.match(packageJson.scripts['verify:batchs3a'], /verify:batchs2b-1/);
  assert.match(packageJson.scripts['verify:batchs3a'], /test:batchs3a:run/);
  assert.match(packageJson.scripts['verify:batchs3a'], /validate:release-manifest/);
  assert.match(packageJson.scripts['security:configure-app-check'], /configure-app-check/);
  assert.match(packageJson.scripts['security:inspect-auth'], /auth-security-baseline/);
  assert.match(functionsPackageJson.scripts.logs, /getSecurityControlReadiness/);
  assert.equal(roadmapRootSource, roadmapDocsSource);
  assert.match(roadmapRootSource, /Version 1\.\d+(?:\.\d+)?/);
  assert.match(roadmapRootSource, /LOG\.9 .*Security Batch S3A/);
  assert.match(runtimeConfigSource, /Release Candidate \d+/);
  assert.match(productionRuntimeConfigSource, /Release Candidate \d+/);
});
