import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  evaluatePasswordAgainstFallbackPolicy,
  formatMissingPasswordRequirements,
  passwordMeetsRegistrationPolicy,
} from '../../src/app/core/auth/auth-security.config.ts';
import {
  isSafeFirestoreDocumentId,
  normalizeFirestoreDocumentId,
} from '../../functions/src/shared/security/firestore-document-id-core.util.ts';
import {
  getNhlProxyRateLimitPolicy,
  isNhlProxyResolutionFailure,
  resolveNhlProxyRequest,
} from '../../functions/src/shared/security/nhl-proxy-security.util.ts';

async function read(relativePath) {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

const [
  passwordPolicyServiceSource,
  authComponentSource,
  authTemplateSource,
  authStylesSource,
  authBaselineSource,
  releaseModelsSource,
  releaseServiceSource,
  releaseTemplateSource,
  documentIdSource,
  documentIdCoreSource,
  functionsIndexSource,
  rosterAuthoritySource,
  rosterMovesSource,
  leagueAutomationSource,
  leagueLifecycleSource,
  projectionAuthoritySource,
  draftAuthoritySource,
  draftAutomationSource,
  appCheckSource,
  nhlApiClientSource,
  packageSource,
  readmeSource,
  documentationSource,
  roadmapRootSource,
  roadmapDocsSource,
  runtimeConfigSource,
  productionRuntimeConfigSource,
] = await Promise.all([
  read('src/app/core/auth/password-policy.service.ts'),
  read('src/app/features/auth/auth.ts'),
  read('src/app/features/auth/auth.html'),
  read('src/app/features/auth/auth.css'),
  read('functions/scripts/auth-security-baseline.cjs'),
  read('src/app/core/release/release-readiness.models.ts'),
  read('src/app/core/release/release-readiness.service.ts'),
  read('src/app/features/release/release-readiness/release-readiness.html'),
  read('functions/src/shared/security/firestore-document-id.util.ts'),
  read('functions/src/shared/security/firestore-document-id-core.util.ts'),
  read('functions/src/index.ts'),
  read('functions/src/roster-authority.ts'),
  read('functions/src/roster-moves.ts'),
  read('functions/src/league-automation.ts'),
  read('functions/src/league-lifecycle-authority.ts'),
  read('functions/src/projection-authority.ts'),
  read('functions/src/draft-authority.ts'),
  read('functions/src/draft-automation.ts'),
  read('src/app/core/firebase-app-check.ts'),
  read('src/app/core/nhl/nhl-api.service.ts'),
  read('package.json'),
  read('README.md'),
  read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
  read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
  read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
  read('src/environments/app-runtime.config.ts'),
  read('src/environments/app-runtime.config.production.ts'),
]);

test('registration requires the production capital, number, and special-character policy', () => {
  assert.equal(passwordMeetsRegistrationPolicy('abcdefghijkl'), false);
  assert.equal(passwordMeetsRegistrationPolicy('Abcdefghijkl'), false);
  assert.equal(passwordMeetsRegistrationPolicy('Abcdefghijk1'), false);
  assert.equal(passwordMeetsRegistrationPolicy('RinkRat2026!'), true);
  assert.equal(passwordMeetsRegistrationPolicy('RINKRAT2026!'), true, 'lowercase remains optional');

  const missing = evaluatePasswordAgainstFallbackPolicy('abcdefghijkl');
  assert.equal(missing.isValid, false);
  assert.match(formatMissingPasswordRequirements(missing), /capital letter/);
  assert.match(formatMissingPasswordRequirements(missing), /number/);
  assert.match(formatMissingPasswordRequirements(missing), /special character/);

  assert.match(authBaselineSource, /requireUppercase: true/);
  assert.match(authBaselineSource, /requireNumeric: true/);
  assert.match(authBaselineSource, /requireNonAlphanumeric: true/);
  assert.match(authBaselineSource, /requireLowercase: false/);
});

test('registration mirrors the live Firebase password policy and makes missing requirements obvious', () => {
  assert.match(passwordPolicyServiceSource, /validatePassword\(auth, password\)/);
  assert.match(passwordPolicyServiceSource, /PasswordValidationStatus/);
  assert.match(passwordPolicyServiceSource, /containsUppercaseLetter/);
  assert.match(passwordPolicyServiceSource, /containsNumericCharacter/);
  assert.match(passwordPolicyServiceSource, /containsNonAlphanumericCharacter/);
  assert.match(passwordPolicyServiceSource, /PASSWORD_POLICY_TIMEOUT_MILLISECONDS = 8_000/);
  assert.match(authTemplateSource, /Checking the live Firebase policy/);
  assert.match(authComponentSource, /Update your password before continuing/);
  assert.match(authTemplateSource, /Password requirements/);
  assert.match(authTemplateSource, /complete/);
  assert.match(authTemplateSource, /passwordRequirementsMetCount\(\)/);
  assert.match(authTemplateSource, /password-requirement-list/);
  assert.match(authComponentSource, /Complete Password Requirements/);
  assert.match(authStylesSource, /password-policy-card\.needs-attention/);
  assert.match(authStylesSource, /password-requirement\.missing/);
  assert.match(authStylesSource, /password-requirement\.met/);
});

test('Release Readiness reports every enforced password composition rule', () => {
  assert.match(releaseModelsSource, /passwordRequiresUppercase/);
  assert.match(releaseModelsSource, /passwordRequiresNumeric/);
  assert.match(releaseModelsSource, /passwordRequiresNonAlphanumeric/);
  assert.match(releaseServiceSource, /passwordRequiresUppercase/);
  assert.match(releaseServiceSource, /passwordRequiresNumeric/);
  assert.match(releaseServiceSource, /passwordRequiresNonAlphanumeric/);
  assert.match(releaseServiceSource, /capital required/);
  assert.match(releaseServiceSource, /number required/);
  assert.match(releaseServiceSource, /special character required/);
  assert.match(releaseTemplateSource, /Capital/);
  assert.match(releaseTemplateSource, /Number/);
  assert.match(releaseTemplateSource, /Special/);
});

test('shared Firestore document-ID validation rejects path confusion and reserved identifiers', () => {
  assert.equal(normalizeFirestoreDocumentId('  league_123  '), 'league_123');
  assert.equal(isSafeFirestoreDocumentId('league_123'), true);
  assert.equal(isSafeFirestoreDocumentId('league/child'), false);
  assert.equal(isSafeFirestoreDocumentId('.'), false);
  assert.equal(isSafeFirestoreDocumentId('..'), false);
  assert.equal(isSafeFirestoreDocumentId('__name__'), false);
  assert.equal(isSafeFirestoreDocumentId('line\nbreak'), false);
  assert.equal(isSafeFirestoreDocumentId('x'.repeat(257)), false);
  assert.match(documentIdCoreSource, /Buffer\.byteLength/);
  assert.match(documentIdCoreSource, /id\.includes\('\/'\)/);
  assert.match(documentIdSource, /reason: 'invalid-firestore-document-id'/);
  assert.match(documentIdSource, /requireFirestoreDocumentIds/);
});

test('user-controlled competitive path fragments use the shared validator', () => {
  for (const [label, source] of [
    ['draft authority', draftAuthoritySource],
    ['draft automation', draftAutomationSource],
    ['league lifecycle', leagueLifecycleSource],
    ['projection authority', projectionAuthoritySource],
    ['roster authority', rosterAuthoritySource],
    ['roster moves', rosterMovesSource],
    ['league automation', leagueAutomationSource],
    ['Functions index', functionsIndexSource],
  ]) {
    assert.match(
      source,
      /requireFirestoreDocumentId|requireServerFirestoreDocumentId|resolveSafeFirestoreDocumentId|isSafeFirestoreDocumentId|optionalFirestoreDocumentId|requireFirestoreDocumentIds/,
      `${label} must use the shared Firestore path validator`,
    );
  }

  assert.match(rosterAuthoritySource, /normalizedSecureRosterActionRequest/);
  assert.match(rosterMovesSource, /requireFirestoreDocumentId\([\s\S]*?input\.activeSlotId/);
  assert.match(leagueAutomationSource, /requestedLeagueId/);
  assert.match(functionsIndexSource, /getPublicManagerProfiles/);
});

test('NHL proxy accepts only exact routes and bounded canonical query parameters', () => {
  const valid = resolveNhlProxyRequest(
    '/stats/rest/en/skater/summary?isAggregate=false&isGame=true&start=0&limit=5000&sort=points&dir=desc&cayenneExp=seasonId%3D20252026%20and%20gameTypeId%3D2',
  );
  assert.equal(isNhlProxyResolutionFailure(valid), false);
  if (!isNhlProxyResolutionFailure(valid)) {
    assert.equal(valid.routeClass, 'stats');
    assert.match(valid.targetUrl, /isAggregate=false/);
    assert.match(valid.targetUrl, /limit=5000/);
  }

  const unknownParameter = resolveNhlProxyRequest(
    '/stats/rest/en/skater/summary?isAggregate=false&isGame=true&start=0&limit=5000&sort=points&dir=desc&cayenneExp=seasonId%3D20252026%20and%20gameTypeId%3D2&evil=1',
  );
  assert.equal(isNhlProxyResolutionFailure(unknownParameter), true);
  if (isNhlProxyResolutionFailure(unknownParameter)) {
    assert.equal(unknownParameter.status, 400);
  }

  const duplicateParameter = resolveNhlProxyRequest(
    '/stats/rest/en/skater/summary?isAggregate=false&isGame=true&start=0&start=1&limit=5000&sort=points&dir=desc&cayenneExp=seasonId%3D20252026%20and%20gameTypeId%3D2',
  );
  assert.equal(isNhlProxyResolutionFailure(duplicateParameter), true);

  const oversizedLimit = resolveNhlProxyRequest(
    '/stats/rest/en/skater/summary?isAggregate=false&isGame=true&start=0&limit=5001&sort=points&dir=desc&cayenneExp=seasonId%3D20252026%20and%20gameTypeId%3D2',
  );
  assert.equal(isNhlProxyResolutionFailure(oversizedLimit), true);

  const queryOnSchedule = resolveNhlProxyRequest('/v1/club-schedule-season/vgk/20252026?extra=1');
  assert.equal(isNhlProxyResolutionFailure(queryOnSchedule), true);

  const unknownRoute = resolveNhlProxyRequest('/v1/arbitrary/fetch');
  assert.equal(isNhlProxyResolutionFailure(unknownRoute), true);
  if (isNhlProxyResolutionFailure(unknownRoute)) {
    assert.equal(unknownRoute.status, 404);
  }
});

test('NHL proxy uses App Check-aware abuse limits, response caps, and security health reporting', () => {
  const verified = getNhlProxyRateLimitPolicy('stats', 'valid');
  const unverified = getNhlProxyRateLimitPolicy('stats', 'missing');
  assert.equal(verified.maximumRequestsPerMinute > unverified.maximumRequestsPerMinute, true);

  assert.match(functionsIndexSource, /getAppCheck\(\)\.verifyToken/);
  assert.match(functionsIndexSource, /NHL_PROXY_GLOBAL_REQUESTS_PER_MINUTE/);
  assert.match(functionsIndexSource, /consumeNhlProxyRateLimit/);
  assert.match(functionsIndexSource, /status\(429\)/);
  assert.match(functionsIndexSource, /NhlProxyResponseTooLargeError/);
  assert.match(functionsIndexSource, /appData\/nhlProxySecurity/);
  assert.match(functionsIndexSource, /X-RinkRat-App-Check/);
  assert.match(functionsIndexSource, /mode: 'app-check-monitor'/);

  assert.match(appCheckSource, /getRinkRatAppCheckToken/);
  assert.match(nhlApiClientSource, /X-Firebase-AppCheck/);
});

test('S3B remains an App Check monitor release rather than silently enforcing tokens', () => {
  assert.doesNotMatch(
    functionsIndexSource + leagueAutomationSource + leagueLifecycleSource + projectionAuthoritySource,
    /enforceAppCheck\s*:\s*true/,
  );
  assert.match(functionsIndexSource, /app-check-monitor/);
});

test('S3B release, documentation, roadmap, and verification commands remain synchronized', () => {
  const packageJson = JSON.parse(packageSource);

  assert.equal(
    packageJson.scripts['test:batchs3b:run'],
    'node --no-warnings --experimental-strip-types --test --test-concurrency=1 test/batchs3b-password-id-proxy-security/*.test.mjs',
  );
  assert.match(packageJson.scripts['verify:batchs3b'], /verify:batchs3a-2/);
  assert.match(packageJson.scripts['verify:batchs3b'], /test:batchs3b:run/);
  assert.match(packageJson.scripts['verify:batchs3b'], /validate:release-manifest/);
  assert.match(readmeSource, /Release Candidate \d+ \/ (?:Onboarding Batch B1A|Security Batch S3C|Security Batch S3D|Security Batch S3E|Security Batch S3F|Beta Operations Batch B1B|Data Quality Batch D1A|Data Quality Batch D1B|Social Batch C1A|Social Batch C1B|Social Batch C1C|Social Batch C1D|Social Batch C1E|Social Batch C1F|Social Batch C1G|Social Batch C1H|Social Batch C1I|Social Batch C1J|Social Batch C1K|Product Batch A1A|Product Batch A1B|Product Batch A1C|Product Batch A1E|Product Batch A1F|Product Batch A1H|Product Batch A1I|Mobile Batch N1B|Scoring Batch V4A|Operations Batch O1B|Operations Batch O1D)/);
  assert.match(readmeSource, /verify:batchs3b/);
  assert.match(documentationSource, /Security Batch S3B — Dynamic Password Policy, Document-ID Validation, and NHL Proxy Hardening/);
  assert.equal(roadmapRootSource, roadmapDocsSource);
  assert.match(roadmapRootSource, /Version 1\.\d+(?:\.\d+)?/);
  assert.match(roadmapRootSource, /# \[x\] S3\.11/);
  assert.match(roadmapRootSource, /# \[x\] S3\.13/);
  assert.match(roadmapRootSource, /\[~\] SEQ\.7/);
  const runtimeRelease = Number(runtimeConfigSource.match(/Release Candidate (\d+)/)?.[1] ?? 0);
  const productionRelease = Number(productionRuntimeConfigSource.match(/Release Candidate (\d+)/)?.[1] ?? 0);
  assert.ok(runtimeRelease >= 19);
  assert.ok(productionRelease >= 19);
});
