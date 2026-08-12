import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { scanTextForSecrets } from '../../scripts/security/secret-scan.mjs';
import { auditHostingSecurityHeaders } from '../../scripts/security/security-header-audit.mjs';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

async function sha256(relativePath) {
  const content = await readFile(new URL(relativePath, ROOT));
  return createHash('sha256').update(content).digest('hex');
}

test('GitHub Actions performs clean installs, emulator verification, builds, and S3C security checks', async () => {
  const workflow = await read('.github/workflows/rinkrat-ci.yml');

  assert.match(workflow, /actions\/checkout@v6/);
  assert.match(workflow, /actions\/setup-node@v6/);
  assert.match(workflow, /node-version:\s*22\.23\.1/);
  assert.match(workflow, /actions\/setup-java@v5/);
  assert.match(workflow, /java-version:\s*'21'/);
  assert.match(workflow, /npm install --global firebase-tools@15\.24\.0/);
  assert.match(workflow, /run:\s*npm ci/);
  assert.match(workflow, /run:\s*npm --prefix functions ci/);
  assert.match(workflow, /run:\s*npm run security:ci/);
  assert.match(workflow, /actions\/upload-artifact@v7/);
  assert.match(workflow, /CI:\s*'true'/);
  assert.match(workflow, /include-hidden-files:\s*true/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.doesNotMatch(workflow, /firebase deploy|FIREBASE_TOKEN|GOOGLE_APPLICATION_CREDENTIALS/);
});


test('visible repository automation templates recover hidden macOS project files before verification', async () => {
  const [manifestSource, syncSource, workflowTemplate, dependabotTemplate, nvmrcTemplate, packageSource] = await Promise.all([
    read('config/repository-automation/manifest.json'),
    read('scripts/security/sync-repository-automation.mjs'),
    read('config/repository-automation/rinkrat-ci.yml'),
    read('config/repository-automation/dependabot.yml'),
    read('config/repository-automation/nvmrc.txt'),
    read('package.json'),
  ]);
  const manifest = JSON.parse(manifestSource);
  const packageJson = JSON.parse(packageSource);

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.automationVersion, 1);
  assert.equal(manifest.targets.length, 3);
  assert.match(syncSource, /upgradeRequired/);
  assert.ok(manifest.targets.some((entry) => entry.target === '.github/workflows/rinkrat-ci.yml'));
  assert.match(syncSource, /\/\.security-reports\//);
  assert.match(workflowTemplate, /npm run security:ci/);
  assert.match(dependabotTemplate, /package-ecosystem:\s*github-actions/);
  assert.equal(nvmrcTemplate.trim(), '22.23.1');
  assert.equal(
    packageJson.scripts['preverify:batchs3c'],
    'npm run security:sync-repository-automation',
  );
});

test('Dependabot covers root, Functions, and GitHub Actions with controlled major-version gates', async () => {
  const dependabot = await read('.github/dependabot.yml');

  assert.match(dependabot, /package-ecosystem:\s*npm[\s\S]*directory:\s*\/[\s\S]*interval:\s*weekly/);
  assert.match(dependabot, /package-ecosystem:\s*npm[\s\S]*directory:\s*\/functions/);
  assert.match(dependabot, /package-ecosystem:\s*github-actions/);
  assert.match(dependabot, /angular-runtime/);
  assert.match(dependabot, /firebase-browser/);
  assert.match(dependabot, /firebase-server/);
  assert.match(dependabot, /functions-production-minor-patch/);
  assert.match(dependabot, /development-minor-patch/);
  assert.match(dependabot, /version-update:semver-major/);
});

test('repository secret scanning rejects private credentials while allowing expected public browser identifiers', () => {
  const privateKeyHeader = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
  const privateKey = [privateKeyHeader, 'abc', '-----END PRIVATE KEY-----'].join('\n');
  assert.equal(scanTextForSecrets(privateKey, 'leaked.pem').length, 1);

  const serviceAccount = JSON.stringify({
    type: 'service_account',
    private_key: [privateKeyHeader, 'abc'].join('\\n'),
  });
  assert.ok(scanTextForSecrets(serviceAccount, 'service-account.json').length >= 1);

  const publicClientConfig = `apiKey: 'AIza-public-browser-key'; recaptchaEnterpriseSiteKey: '6Lc_public_site_key'`;
  assert.deepEqual(scanTextForSecrets(publicClientConfig, 'app-check.config.ts'), []);
});

test('production dependency audit covers browser and Functions lockfiles with strict CI behavior', async () => {
  const audit = await read('scripts/security/dependency-audit.mjs');
  const packageSource = JSON.parse(await read('package.json'));

  assert.match(audit, /Angular client/);
  assert.match(audit, /Cloud Functions/);
  assert.match(audit, /--omit=dev/);
  assert.match(audit, /high/);
  assert.match(audit, /critical/);
  assert.match(audit, /--strict/);
  assert.doesNotMatch(audit, /process\.env\.CI === 'true'/);
  assert.match(audit, /npm advisory data was unavailable/);
  assert.equal(
    packageSource.scripts['security:dependency-audit'],
    'node scripts/security/dependency-audit.mjs',
  );
  assert.match(packageSource.scripts['security:ci'], /security:dependency-audit:strict/);
  assert.match(packageSource.scripts['verify:batchs3c'], /security:dependency-audit(?!:strict)/);
});

test('Firebase Hosting uses non-blocking CSP, Trusted Types preparation, HSTS, and a same-origin report route', async () => {
  const firebaseConfig = JSON.parse(await read('firebase.json'));
  const findings = auditHostingSecurityHeaders(firebaseConfig);
  assert.deepEqual(findings, []);

  const globalHeaders = firebaseConfig.hosting.headers.find((entry) => entry.source === '**').headers;
  const names = new Set(globalHeaders.map((entry) => entry.key));
  assert.ok(names.has('Content-Security-Policy-Report-Only'));
  assert.ok(names.has('Strict-Transport-Security'));
  assert.ok(names.has('Cross-Origin-Opener-Policy'));
  assert.equal(names.has('Content-Security-Policy'), false);

  const csp = globalHeaders.find((entry) => entry.key === 'Content-Security-Policy-Report-Only').value;
  assert.match(csp, /trusted-types angular angular#bundler firebase-js-sdk/);
  assert.match(csp, /require-trusted-types-for 'script'/);
  assert.match(csp, /report-uri \/security\/csp-report/);
  assert.match(csp, /https:\/\/assets\.nhle\.com/);

  const reportRewrite = firebaseConfig.hosting.rewrites.find(
    (entry) => entry.source === '/security/csp-report',
  );
  assert.equal(reportRewrite.function.functionId, 'collectCspReport');
});

test('CSP report collection is bounded, host-limited, privacy-reduced, and retained temporarily', async () => {
  const source = await read('functions/src/security-operations.ts');
  const index = await read('src/index.html');

  assert.match(source, /CSP_REPORT_MAX_BYTES = 16 \* 1_024/);
  assert.match(source, /CSP_REPORT_REQUESTS_PER_WINDOW = 30/);
  assert.match(source, /CSP_REPORT_GLOBAL_REQUESTS_PER_WINDOW = 120/);
  assert.match(source, /isRinkRatDocumentUri/);
  assert.match(source, /replace\(\/\[\?#\]\.\*\$\//);
  assert.doesNotMatch(source, /userAgentHash/);
  assert.doesNotMatch(source, /requesterHash/);
  assert.match(source, /recordCspReportHealth/);
  assert.match(source, /cspReportReceivedCount: FieldValue\.increment/);
  assert.match(source, /redactReportPath/);
  assert.match(source, /assets\/:assetKey/);
  assert.doesNotMatch(source, /hostname === 'localhost'/);
  assert.doesNotMatch(source, /scriptSample/);
  assert.match(source, /CSP_REPORT_RETENTION_MILLISECONDS/);
  assert.match(source, /cspReportReceivedCount/);
  assert.match(source, /response\.status\(204\)\.end\(\)/);
  assert.doesNotMatch(index, /onload=/);
});

test('Firestore TTL baseline and scheduled cleanup cover every temporary security collection', async () => {
  const baseline = JSON.parse(await read('config/firestore-ttl-baseline.json'));
  const retentionPolicy = JSON.parse(await read('config/security-retention-policy.json'));
  const ttlScript = await read('scripts/security/firestore-ttl-baseline.mjs');
  const retentionAudit = await read('scripts/security/verify-retention.mjs');
  const cleanup = await read('functions/src/security-operations.ts');
  const groups = baseline.policies.map((policy) => policy.collectionGroup).sort();

  assert.deepEqual(groups, [
    'betaEvidenceEvents',
    'betaOperationsDaily',
    'clientErrorReports',
    'cspViolationReports',
    'feedbackReports',
    'leagueAutomationTasks',
    'leagueCreationRequests',
    'leagueJoinRequests',
    'projectionGenerationRequests',
  ]);
  assert.equal(baseline.field, 'expiresAt');
  assert.match(ttlScript, /RINKRAT_APPLY_TTL_SECURITY/);
  assert.match(ttlScript, /fields[\s\S]*ttls[\s\S]*list/);
  assert.match(ttlScript, /--enable-ttl/);
  assert.match(cleanup, /cleanupExpiredSecurityData/);
  assert.match(cleanup, /schedule: '35 4 \* \* \*'/);
  assert.match(cleanup, /retentionCleanupStatus/);
  assert.equal(retentionPolicy.defaultField, 'expiresAt');
  assert.equal(retentionPolicy.collections.length, 9);
  assert.match(retentionAudit, /cleanupExpiredSecurityData/);
  assert.match(retentionAudit, /cleanupLeagueAutomationTaskHistory/);
});

test('Release Readiness exposes browser-header and temporary-data retention health without blocking invite beta', async () => {
  const [authority, clientSecurity, readiness, models, template] = await Promise.all([
    read('functions/src/security-authority.ts'),
    read('src/app/core/security/security-readiness.service.ts'),
    read('src/app/core/release/release-readiness.service.ts'),
    read('src/app/core/release/release-readiness.models.ts'),
    read('src/app/features/release/release-readiness/release-readiness.html'),
  ]);

  assert.match(authority, /securityOperationsSnapshot/);
  assert.match(clientSecurity, /securityOperations:/);
  assert.match(readiness, /inspectHostingSecurityHeaders/);
  assert.match(readiness, /hosting-security-headers/);
  assert.match(readiness, /security-retention-cleanup/);
  assert.match(models, /hostingCspReportOnlyReady/);
  assert.match(models, /retentionCleanupStatus/);
  assert.match(template, /Browser hardening/);
  assert.match(template, /Data retention/);
});

test('S3C runbook, commands, release label, and permanent roadmap remain synchronized', async () => {
  const [packageSource, readme, docs, runbook, privacy, rootRoadmap, docsRoadmap, runtime, productionRuntime] = await Promise.all([
    read('package.json'),
    read('README.md'),
    read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
    read('docs/RINKRAT_SECURITY_S3C_RUNBOOK.md'),
    read('src/app/features/legal/privacy/privacy.html'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.match(packageJson.scripts['verify:batchs3c'], /verify:batchs3c:core/);
  assert.match(packageJson.scripts['verify:batchs3c'], /security:dependency-audit/);
  assert.match(packageJson.scripts['verify:batchs3c:core'], /verify:batchb1a/);
  assert.match(packageJson.scripts['verify:batchs3c:core'], /test:batchs3c:run/);
  assert.match(packageJson.scripts['verify:batchs3c:core'], /security:secret-scan/);
  assert.match(packageJson.scripts['verify:batchs3c:core'], /security:headers:inspect/);
  assert.match(packageJson.scripts['verify:batchs3c:core'], /security:verify-retention/);
  assert.match(readme, /Release Candidate 21 \/ Beta Operations Batch B1B/);
  assert.match(readme, /verify:batchs3c/);
  assert.match(docs, /Security Batch S3C — CI, Browser Hardening, and Retention/);
  assert.match(readme, /RINKRAT_SECURITY_S3C_RUNBOOK\.md/);
  assert.match(docs, /RINKRAT_SECURITY_S3C_RUNBOOK\.md/);
  assert.match(runbook, /Content-Security-Policy-Report-Only/);
  assert.match(runbook, /SEV-1/);
  assert.match(runbook, /Post-incident review template/);
  assert.match(runbook, /never stores script samples, raw IP addresses, requester hashes, or user-agent strings/i);
  assert.match(privacy, /Last updated: August 2026/);
  assert.match(privacy, /reCAPTCHA Enterprise assessment/);
  assert.match(privacy, /Content Security Policy reports/);
  assert.match(privacy, /Temporary technical records use defined expiration periods/);
  assert.equal(rootRoadmap, docsRoadmap);
  assert.match(rootRoadmap, /Version 1\.9/);
  assert.match(rootRoadmap, /# \[x\] S3\.16/);
  assert.match(rootRoadmap, /# \[x\] S3\.20/);
  assert.match(rootRoadmap, /# \[x\] S4\.2/);
  assert.match(rootRoadmap, /# \[x\] S4\.7/);
  assert.match(rootRoadmap, /# \[x\] S4\.8/);
  assert.match(rootRoadmap, /# \[x\] S4\.10/);
  assert.match(rootRoadmap, /# \[x\] LOG\.15/);
  assert.match(rootRoadmap, /# \[x\] LOG\.16/);
  assert.match(runtime, /Release Candidate 21/);
  assert.match(productionRuntime, /Release Candidate 21/);
});

test('S3C preserves Production Scoring V3, Projection V11, Firestore Rules, and indexes', async () => {
  const expected = JSON.parse(await read('test/batchs3c-ci-browser-retention/preserved-source-hashes.json'));

  assert.equal(await sha256('src/app/core/scoring/scoring-rules.ts'), expected.scoringRules);
  assert.equal(await sha256('src/app/core/scoring/scoring-engine.ts'), expected.scoringEngine);
  assert.equal(await sha256('src/app/core/projection/projection-v11.util.ts'), expected.projectionV11);
  assert.equal(await sha256('firestore.rules'), expected.firestoreRules);
  assert.equal(await sha256('firestore.indexes.json'), expected.firestoreIndexes);
});
