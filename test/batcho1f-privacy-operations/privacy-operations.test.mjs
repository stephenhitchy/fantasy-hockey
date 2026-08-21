import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import {
  PRIVACY_EXPORT_AUDIT_RETENTION_DAYS,
  PRIVACY_EXPORT_MAXIMUM_BYTES,
  PRIVACY_EXPORTS_PER_DAY,
  PRIVACY_REQUEST_RETENTION_DAYS,
  PRIVACY_REQUEST_RESPONSE_TARGET_DAYS,
  PRIVACY_RETENTION_CATALOG,
  buildPrivacyRequestPublicRecord,
  canTransitionPrivacyRequest,
  privacyExportFileName,
  privacyOwnerReference,
} from '../../functions/src/shared/core/privacy/privacy-request.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

test('privacy request states permit deliberate follow-up and terminal closure only', () => {
  assert.equal(canTransitionPrivacyRequest('submitted', 'in-review'), true);
  assert.equal(canTransitionPrivacyRequest('submitted', 'waiting-for-manager'), true);
  assert.equal(canTransitionPrivacyRequest('waiting-for-manager', 'in-review'), true);
  assert.equal(canTransitionPrivacyRequest('completed', 'in-review'), false);
  assert.equal(canTransitionPrivacyRequest('cancelled', 'submitted'), false);
});

test('privacy owner references and export filenames are deterministic without exposing unsafe input', () => {
  const first = privacyOwnerReference('user-secret-id');
  const again = privacyOwnerReference('user-secret-id');
  assert.equal(first, again);
  assert.match(first, /^[a-f0-9]{20}$/);
  assert.doesNotMatch(first, /user-secret-id/);
  assert.equal(
    privacyExportFileName(' Stephen / Manager ', '2026-08-20'),
    'rinkrat-stephen-manager-data-2026-08-20.json',
  );
});

test('manager-visible request records remain bounded and exclude administrator-only fields', () => {
  const record = buildPrivacyRequestPublicRecord({
    requestId: 'request-a',
    requestType: 'privacy-question',
    subject: 'Question about retention',
    details: 'Please explain how long my diagnostic records remain available.',
    status: 'waiting-for-manager',
    publicResponse: 'Please confirm whether you mean client diagnostics or support feedback.',
    adminNotes: 'This must never be returned to the manager.',
    ownerId: 'secret-owner-id',
    revision: 2,
    timeline: [{
      kind: 'administrator-response',
      message: 'Please confirm whether you mean client diagnostics or support feedback.',
      status: 'waiting-for-manager',
      occurredAt: '2026-08-20T12:00:00Z',
    }],
  });

  assert.equal(record?.requestId, 'request-a');
  assert.equal(record?.status, 'waiting-for-manager');
  assert.equal('adminNotes' in (record ?? {}), false);
  assert.equal('ownerId' in (record ?? {}), false);
});

test('source-controlled privacy policy matches the server retention and export bounds', async () => {
  const policy = JSON.parse(await read('config/privacy-operations-policy.json'));
  assert.equal(policy.releaseLabel, 'Release Candidate 58');
  assert.equal(policy.requestRetentionDays, PRIVACY_REQUEST_RETENTION_DAYS);
  assert.equal(policy.exportAuditRetentionDays, PRIVACY_EXPORT_AUDIT_RETENTION_DAYS);
  assert.equal(policy.responseTargetDays, PRIVACY_REQUEST_RESPONSE_TARGET_DAYS);
  assert.equal(policy.maximumExportsPerDay, PRIVACY_EXPORTS_PER_DAY);
  assert.equal(policy.maximumExportBytes, PRIVACY_EXPORT_MAXIMUM_BYTES);
  assert.equal(policy.responseTargetIsLegalDeadline, false);
  assert.equal(PRIVACY_RETENTION_CATALOG.length >= 8, true);
});

test('server privacy authority requires verified recent authentication and a compatible deployed operations client for protected actions', async () => {
  const source = await read('functions/src/privacy-request-authority.ts');
  assert.match(source, /assessOperationsClientCompatibility/);
  assert.match(source, /normalizeOperationsClientIdentity/);
  assert.doesNotMatch(source, /CURRENT_BUILD_ID_PATTERN/);
  assert.match(source, /requireVerifiedRecentAuthentication/);
  assert.match(source, /requireVerifiedEmail/);
  assert.match(source, /buildIdentity\(input\['build'\], true\)/);
  assert.match(source, /requireDeployableBuild/);
  assert.match(source, /PRIVACY_EXPORTS_PER_DAY/);
  assert.match(source, /PRIVACY_REQUEST_DAILY_LIMIT/);
});

test('immediate export includes account-linked categories while excluding secrets and server-held package copies', async () => {
  const source = await read('functions/src/privacy-request-authority.ts');
  assert.match(source, /authentication:/);
  assert.match(source, /privateProfile:/);
  assert.match(source, /publicProfile:/);
  assert.match(source, /leagueMemberships/);
  assert.match(source, /feedbackReports/);
  assert.match(source, /clientDiagnostics/);
  assert.match(source, /technicalContext/);
  assert.match(source, /stack:/);
  assert.match(source, /privateSeason/);
  assert.match(source, /privacyRequests/);
  assert.match(source, /privacyExports/);
  assert.match(source, /Authentication tokens, passwords, secrets/);
  assert.match(source, /packageHash/);
  assert.doesNotMatch(source, /exportPackage:\s*json|packageJson:\s*json|storedJson:\s*json/);
});

test('manager and administrator privacy routes are separate, linked, inline, and mobile-safe', async () => {
  const [routes, managerHtml, managerCss, adminHtml, adminCss, footer, support, account, adminCenter] = await Promise.all([
    read('src/app/app.routes.ts'),
    read('src/app/features/account/privacy-center/privacy-center.html'),
    read('src/app/features/account/privacy-center/privacy-center.css'),
    read('src/app/features/admin/privacy-requests/privacy-requests.html'),
    read('src/app/features/admin/privacy-requests/privacy-requests.css'),
    read('src/app/layouts/main-layout/main-layout.html'),
    read('src/app/features/support/support-home/support-home.html'),
    read('src/app/features/account/account-settings/account-settings.html'),
    read('src/app/features/admin/admin-center/admin-center.html'),
  ]);
  assert.match(routes, /path: 'privacy-center'/);
  assert.match(routes, /path: 'admin\/privacy-requests'[\s\S]*platformAdminGuard/);
  assert.match(managerHtml, /Download My RinkRat Data/);
  assert.match(managerHtml, /Submit a Privacy Request/);
  assert.match(adminHtml, /Privacy Request Operations/);
  assert.match(adminHtml, /Private operations note/);
  assert.match(footer, /Privacy Center/);
  assert.match(support, /Open Privacy Center/);
  assert.match(account, /routerLink="\/privacy-center"/);
  assert.match(adminCenter, /Privacy Requests/);
  assert.doesNotMatch(managerHtml + adminHtml, /role="dialog"|viewport-overlay|action-sheet/i);
  assert.doesNotMatch(managerCss + adminCss, /position:\s*(?:fixed|sticky)/);
  assert.match(managerCss + adminCss, /min-height:\s*44px/);
});

test('account deletion pseudonymizes privacy parent records, immutable manager changes, and export audits', async () => {
  const [authority, indexSource] = await Promise.all([
    read('functions/src/privacy-request-authority.ts'),
    read('functions/src/index.ts'),
  ]);
  assert.match(authority, /pseudonymizePrivacyOperationsForDeletedAccount/);
  assert.match(authority, /subject: '\[removed after account deletion\]'/);
  assert.match(authority, /collection\('changes'\)[\s\S]*where\('actorId', '==', safeUserId\)/);
  assert.match(authority, /actorId: FieldValue\.delete\(\)/);
  assert.match(authority, /ownerId: FieldValue\.delete\(\)/);
  assert.match(authority, /while \(true\)[\s\S]*privacyExportAudits/);
  assert.match(indexSource, /pseudonymizePrivacyOperationsForDeletedAccount\(userId\)/);
});

test('privacy request and export metadata are registered for scheduled cleanup without adding TTL field overrides', async () => {
  const [operations, policy, baseline, verifier] = await Promise.all([
    read('functions/src/security-operations.ts'),
    read('config/security-retention-policy.json'),
    read('config/firestore-ttl-baseline.json'),
    read('scripts/security/verify-retention.mjs'),
  ]);
  const retention = JSON.parse(policy);
  const ttl = JSON.parse(baseline);
  assert.match(operations, /collection: 'privacyRequestOperations'/);
  assert.match(operations, /collection: 'privacyExportAudits'/);
  assert.match(operations, /collectionName === 'privacyRequestOperations'[\s\S]*recursiveDelete/);
  assert.equal(retention.collections.some((entry) => entry.collection === 'privacyRequestOperations' && entry.retentionDays === 730), true);
  assert.equal(retention.collections.some((entry) => entry.collection === 'privacyExportAudits' && entry.retentionDays === 365), true);
  assert.equal(ttl.policies.length, 10);
  assert.match(verifier, /scheduledCleanupOnlyCollections/);
});

test('O1F stays server-authoritative and preserves scoring, Projection V11, Rules, indexes, and Shadow modes', async () => {
  const [scoringRules, scoringEngine, projectionV11, firestoreRules, firestoreIndexes, freezeSource, runtime, productionRuntime, indexSource] = await Promise.all([
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/scoring/scoring-engine.ts'),
    read('src/app/core/projection/projection-v11.util.ts'),
    read('firestore.rules'),
    read('firestore.indexes.json'),
    read('config/release-freeze/beta-freeze-policy.json'),
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('functions/src/index.ts'),
  ]);
  const freeze = JSON.parse(freezeSource);
  assert.equal(createHash('sha256').update(scoringRules).digest('hex'), PROTECTED_SOURCE_HASHES.scoringRules);
  assert.equal(createHash('sha256').update(scoringEngine).digest('hex'), PROTECTED_SOURCE_HASHES.scoringEngine);
  assert.equal(createHash('sha256').update(projectionV11).digest('hex'), PROTECTED_SOURCE_HASHES.projectionV11);
  assert.equal(createHash('sha256').update(firestoreRules).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreRules);
  assert.equal(createHash('sha256').update(firestoreIndexes).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreIndexes);
  assert.match(runtime, /Release Candidate 58/);
  assert.match(productionRuntime, /Release Candidate 58/);
  assert.equal(freeze.scoringRulesVersion, 4);
  assert.equal(freeze.projectionVersion, 11);
  assert.equal(freeze.queueMode, 'shadow');
  assert.equal(freeze.appCheckMode, 'monitor');
  assert.equal(freeze.verificationCommand, 'npm run verify:batcho1h');
  assert.equal(freeze.defaultTag, 'rinkrat-rc58-invite-beta');
  assert.match(indexSource, /getMyPrivacyCenter/);
  assert.match(indexSource, /updatePrivacyRequestOperation/);
});

test('public Privacy notice exposes the operational workflow without claiming legal review is complete', async () => {
  const page = await read('src/app/features/legal/privacy/privacy.html');
  assert.match(page, /Private-beta operational notice/);
  assert.match(page, /routerLink="\/privacy-center"/);
  assert.match(page, /Privacy-request operations are kept for up to 730 days/);
  assert.match(page, /not a substitute for jurisdiction-specific legal review/);
});

test('roadmap and documentation complete O1.24 while keeping attorney-reviewed policy work open', async () => {
  const [roadmap, docsRoadmap, readme, runbook, releaseRunbook, packageSource] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('README.md'),
    read('docs/RINKRAT_OPERATIONS_O1F_PRIVACY_CENTER.md'),
    read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
    read('package.json'),
  ]);
  const packageJson = JSON.parse(packageSource);
  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.49/);
  assert.match(roadmap, /\[~\] O1\.7 Publish reviewed Terms/);
  assert.match(roadmap, /# \[x\] O1\.24 Add a verified privacy-request operations log/);
  assert.match(roadmap, /LOG\.70 2026-08-20 — Completed Operations Batch O1F/);
  assert.match(readme, /Release Candidate 58 \/ Operations Batch O1H/);
  assert.match(readme, /npm run verify:batcho1h/);
  assert.match(runbook, /Targeted Functions first, then Hosting/);
  assert.match(releaseRunbook, /rinkrat-rc58-validation\.json/);
  assert.match(releaseRunbook, /rinkrat-rc58-invite-beta/);
  assert.match(packageJson.scripts['security:ci'], /verify:batcho1h:core/);
});
