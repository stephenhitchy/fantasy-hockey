import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  isSafeFirestoreDocumentId,
  resolveSafeFirestoreDocumentId,
} from '../../functions/src/shared/security/firestore-document-id-core.util.ts';

async function read(relativePath) {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

const [
  coreSource,
  serverSource,
  policySource,
  inventorySource,
  auditSource,
  draftAutomationSource,
  leagueAutomationSource,
  projectionAuthoritySource,
  projectionSnapshotSource,
  projectionCatalogSource,
  draftAuthoritySource,
  emailSource,
  indexSource,
  packageSource,
  roadmapRootSource,
  roadmapDocsSource,
  readmeSource,
  runtimeSource,
  productionRuntimeSource,
] = await Promise.all([
  read('functions/src/shared/security/firestore-document-id-core.util.ts'),
  read('functions/src/shared/security/firestore-document-id.util.ts'),
  read('functions/src/shared/security/firestore-document-id-policies.ts'),
  read('config/firestore-document-id-boundaries.json'),
  read('scripts/security/firestore-id-boundary-audit.mjs'),
  read('functions/src/draft-automation.ts'),
  read('functions/src/league-automation.ts'),
  read('functions/src/projection-authority.ts'),
  read('functions/src/shared/core/projection/projection-snapshot.service.ts'),
  read('functions/src/shared/core/projection/projection-asset-catalog.service.ts'),
  read('functions/src/draft-authority.ts'),
  read('functions/src/email-notifications.ts'),
  read('functions/src/index.ts'),
  read('package.json'),
  read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
  read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
  read('README.md'),
  read('src/environments/app-runtime.config.ts'),
  read('src/environments/app-runtime.config.production.ts'),
]);

test('the shared resolver returns only normalized safe Firestore document IDs', () => {
  assert.equal(resolveSafeFirestoreDocumentId('  league_123  '), 'league_123');
  assert.equal(resolveSafeFirestoreDocumentId('league/child'), null);
  assert.equal(resolveSafeFirestoreDocumentId('__name__'), null);
  assert.equal(resolveSafeFirestoreDocumentId('line\nbreak'), null);
  assert.equal(resolveSafeFirestoreDocumentId('.'), null);
  assert.equal(resolveSafeFirestoreDocumentId('..'), null);
  assert.equal(resolveSafeFirestoreDocumentId('x'.repeat(257)), null);
  assert.equal(isSafeFirestoreDocumentId('goalie-unit-VGK'), true);
  assert.match(coreSource, /resolveSafeFirestoreDocumentId/);
  assert.match(serverSource, /requireServerFirestoreDocumentId/);
  assert.match(serverSource, /resolveSafeFirestoreDocumentId/);
});

test('semantic policies cover every identifier class used at a server path boundary', () => {
  for (const name of [
    'FIRESTORE_AUTH_USER_ID_OPTIONS',
    'FIRESTORE_LEAGUE_ID_OPTIONS',
    'FIRESTORE_REQUEST_ID_OPTIONS',
    'FIRESTORE_TASK_ID_OPTIONS',
    'FIRESTORE_DRAFT_PICK_ID_OPTIONS',
    'FIRESTORE_ROSTER_SLOT_ID_OPTIONS',
    'FIRESTORE_ASSET_KEY_OPTIONS',
    'FIRESTORE_SNAPSHOT_ID_OPTIONS',
    'FIRESTORE_CATALOG_ID_OPTIONS',
    'FIRESTORE_INVITE_CODE_OPTIONS',
    'FIRESTORE_PLAYER_ID_OPTIONS',
    'FIRESTORE_FEEDBACK_ID_OPTIONS',
    'FIRESTORE_FINGERPRINT_ID_OPTIONS',
  ]) {
    assert.match(policySource, new RegExp(`export const ${name}`));
  }

  const inventory = JSON.parse(inventorySource);
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.boundaries.length >= 13, true);
  assert.equal(Object.keys(inventory.policies).length, 13);
});

test('Cloud Tasks and Firestore triggers resolve external IDs before path use', () => {
  assert.match(draftAutomationSource, /processDraftClockDeadline[\s\S]*resolveSafeFirestoreDocumentId/);
  assert.match(draftAutomationSource, /reconcileDraftTurnAfterCommittedPick[\s\S]*FIRESTORE_DRAFT_PICK_ID_OPTIONS/);
  assert.match(draftAutomationSource, /processAutoDraftQueueChange[\s\S]*FIRESTORE_AUTH_USER_ID_OPTIONS/);
  assert.match(leagueAutomationSource, /processLeagueAutomationTask[\s\S]*FIRESTORE_LEAGUE_ID_OPTIONS/);
  assert.match(leagueAutomationSource, /processHistoricalReplayAdvance[\s\S]*FIRESTORE_REQUEST_ID_OPTIONS/);
  assert.match(projectionAuthoritySource, /processProjectionGenerationTask[\s\S]*FIRESTORE_AUTH_USER_ID_OPTIONS/);
  assert.match(emailSource, /sendWelcomeEmailOnProfileCreated[\s\S]*resolveSafeFirestoreDocumentId/);
  assert.match(emailSource, /sendInjuryEmailOnAvailabilityChange[\s\S]*FIRESTORE_PLAYER_ID_OPTIONS/);

  for (const source of [draftAutomationSource, leagueAutomationSource, projectionAuthoritySource]) {
    assert.doesNotMatch(source, /db\.doc\(\s*`[^`]*\$\{\s*payload\./s);
  }
});

test('persisted Draft order, invite, projection snapshot, and catalog references are validated', () => {
  assert.match(draftAutomationSource, /currentOwnerId = resolveSafeFirestoreDocumentId/);
  assert.match(draftAutomationSource, /saved Draft order contains an invalid owner identifier/);
  assert.match(draftAuthoritySource, /FIRESTORE_INVITE_CODE_OPTIONS/);
  assert.match(draftAuthoritySource, /draft-order manager ID/);
  assert.match(projectionSnapshotSource, /function getPointerRef[\s\S]*requireServerFirestoreDocumentId/);
  assert.match(projectionSnapshotSource, /FIRESTORE_SNAPSHOT_ID_OPTIONS/);
  assert.match(projectionCatalogSource, /FIRESTORE_CATALOG_ID_OPTIONS/);
  assert.doesNotMatch(projectionSnapshotSource, /const normalizedSnapshotId = snapshotId\.trim\(\)/);
  assert.doesNotMatch(projectionCatalogSource, /const normalizedCatalogId = catalogId\.trim\(\)/);
});

test('callable feedback and platform-admin paths validate authenticated IDs before use', () => {
  const submitFeedbackStart = indexSource.indexOf('export const submitFeedback');
  const submitFeedbackEnd = indexSource.indexOf(
    'const ADMIN_FEEDBACK_STATUSES',
    submitFeedbackStart,
  );
  const submitFeedbackSource = indexSource.slice(submitFeedbackStart, submitFeedbackEnd);

  assert.ok(submitFeedbackStart >= 0);
  assert.ok(submitFeedbackEnd > submitFeedbackStart);
  assert.match(
    submitFeedbackSource,
    /const userId = resolveSafeFirestoreDocumentId\([\s\S]*FIRESTORE_AUTH_USER_ID_OPTIONS/,
  );
  assert.ok(
    submitFeedbackSource.indexOf('const userId = resolveSafeFirestoreDocumentId') <
      submitFeedbackSource.indexOf('await enforceUserSubmissionLimit'),
  );
  assert.match(submitFeedbackSource, /members\/\$\{userId\}/);
  assert.match(submitFeedbackSource, /teams\/\$\{userId\}/);
  assert.doesNotMatch(submitFeedbackSource, /members\/\$\{request\.auth\.uid\}/);
  assert.doesNotMatch(submitFeedbackSource, /teams\/\$\{request\.auth\.uid\}/);
  assert.match(
    indexSource,
    /const uid = requireFirestoreDocumentId\(\s*request\.auth\.uid,[\s\S]*FIRESTORE_AUTH_USER_ID_OPTIONS/,
  );
  assert.doesNotMatch(
    indexSource,
    /const uid = requireFirestoreDocumentId\(\s*userId,\s*'platform administrator ID'/,
  );
});

test('the static boundary audit blocks direct external identifier interpolation', () => {
  assert.match(auditSource, /unsafePathPattern/);
  assert.match(auditSource, /directEventAssignmentPattern/);
  assert.match(auditSource, /onTaskDispatched/);
  assert.match(auditSource, /event\.params/);
  assert.match(auditSource, /Firestore identifier boundary audit passed/);
});

test('S3D remains an App Check monitor release and preserves competitive models', () => {
  const combined = draftAutomationSource + leagueAutomationSource + projectionAuthoritySource + indexSource;
  assert.doesNotMatch(combined, /enforceAppCheck\s*:\s*true/);
  assert.match(readmeSource, /Scoring V3/);
  assert.match(readmeSource, /Projection V11/);
});

test('S3D scripts, roadmap copies, and RC22 runtime labels stay synchronized', () => {
  const packageJson = JSON.parse(packageSource);
  assert.equal(
    packageJson.scripts['security:audit-firestore-ids'],
    'node scripts/security/firestore-id-boundary-audit.mjs',
  );
  assert.match(packageJson.scripts['test:batchs3d:run'], /batchs3d-firestore-id-boundaries/);
  assert.match(packageJson.scripts['verify:batchs3d:core'], /verify:batchb1d:core/);
  assert.match(packageJson.scripts['verify:batchs3d:core'], /security:audit-firestore-ids/);
  assert.equal(roadmapRootSource, roadmapDocsSource);
  assert.match(roadmapRootSource, /Version 1\.12/);
  assert.match(roadmapRootSource, /# \[x\] S3\.12/);
  assert.match(roadmapRootSource, /# \[x\] S3\.21/);
  assert.match(readmeSource, /Security Batch S3D/);
  assert.match(runtimeSource, /Release Candidate 22/);
  assert.match(productionRuntimeSource, /Release Candidate 22/);
});
