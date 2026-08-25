import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  OPERATIONS_API_VERSION,
  assessOperationsClientCompatibility,
  normalizeOperationsClientIdentity,
} from '../../functions/src/shared/core/operations/operations-client-compatibility.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function identity(overrides = {}) {
  return normalizeOperationsClientIdentity({
    operationsApiVersion: 1,
    releaseLabel: 'Release Candidate 57',
    buildId: 'release-candidate-57-20260820T235959000Z-a1b2c3d4e5',
    scoringRulesVersion: 4,
    projectionVersion: 11,
    ...overrides,
  });
}

test('contract v1 accepts RC56, the original versionless RC56 client, and later compatible releases', () => {
  const rc56 = identity({
    releaseLabel: 'Release Candidate 56',
    buildId: 'release-candidate-56-20260820T235959000Z-a1b2c3d4e5',
  });
  const legacyRc56 = identity({
    operationsApiVersion: undefined,
    releaseLabel: 'Release Candidate 56',
    buildId: 'release-candidate-56-20260820T235959000Z-a1b2c3d4e5',
  });
  const rc57 = identity();
  const rc64 = identity({
    releaseLabel: 'Release Candidate 65',
    buildId: 'release-candidate-65-20260901T010203000Z-f0e1d2c3b4',
  });

  assert.equal(OPERATIONS_API_VERSION, 1);
  assert.equal(assessOperationsClientCompatibility(rc56).compatible, true);
  assert.equal(assessOperationsClientCompatibility(legacyRc56).compatible, true);
  assert.match(assessOperationsClientCompatibility(legacyRc56).message, /legacy RC56/);
  assert.equal(assessOperationsClientCompatibility(rc57).compatible, true);
  assert.equal(assessOperationsClientCompatibility(rc64).compatible, true);
});

test('pre-contract and versionless RC57-or-newer clients fail closed', () => {
  const oldRelease = assessOperationsClientCompatibility(identity({
    releaseLabel: 'Release Candidate 55',
    buildId: 'release-candidate-55-20260820T235959000Z-a1b2c3d4e5',
  }));
  const missingVersion = assessOperationsClientCompatibility(identity({
    operationsApiVersion: undefined,
  }));

  assert.equal(oldRelease.compatible, false);
  assert.match(oldRelease.message, /Release Candidate 56 or newer/);
  assert.equal(missingVersion.compatible, false);
  assert.match(missingVersion.message, /operations contract vunknown/);
});

test('contract changes and scoring or projection mismatches require a Function rollout', () => {
  const wrongContract = assessOperationsClientCompatibility(identity({ operationsApiVersion: 2 }));
  const wrongScoring = assessOperationsClientCompatibility(identity({ scoringRulesVersion: 5 }));
  const wrongProjection = assessOperationsClientCompatibility(identity({ projectionVersion: 12 }));

  assert.equal(wrongContract.compatible, false);
  assert.equal(wrongScoring.compatible, false);
  assert.equal(wrongProjection.compatible, false);
});

test('release label and build ID must identify the same Release Candidate', () => {
  const mismatch = assessOperationsClientCompatibility(identity({
    releaseLabel: 'Release Candidate 57',
    buildId: 'release-candidate-58-20260820T235959000Z-a1b2c3d4e5',
  }));
  const malformed = assessOperationsClientCompatibility(identity({ buildId: 'manual-build' }));

  assert.equal(mismatch.compatible, false);
  assert.equal(malformed.compatible, false);
});

test('local builds may inspect compatible operations but cannot write', () => {
  const local = identity({
    buildId: 'release-candidate-57-20260820T235959000Z-local',
  });

  assert.equal(assessOperationsClientCompatibility(local).compatible, true);
  const writeAssessment = assessOperationsClientCompatibility(local, {
    requireDeployableBuild: true,
  });
  assert.equal(writeAssessment.compatible, false);
  assert.match(writeAssessment.message, /deployed RinkRat site/);
});

test('all O1B–O1F browser services send one shared operations identity', async () => {
  const files = await Promise.all([
    read('src/app/core/operations/private-season.service.ts'),
    read('src/app/core/operations/private-season-health.service.ts'),
    read('src/app/core/operations/private-season-engagement.service.ts'),
    read('src/app/core/operations/private-season-research.service.ts'),
    read('src/app/core/operations/service-incident.service.ts'),
    read('src/app/core/privacy/privacy-operations.service.ts'),
  ]);

  for (const source of files) {
    assert.match(source, /currentOperationsClientIdentity/);
    assert.doesNotMatch(source, /BUNDLED_RELEASE_MANIFEST\.releaseLabel/);
  }
});

test('server authorities no longer hard-code one Release Candidate', async () => {
  const files = await Promise.all([
    read('functions/src/private-season-authority.ts'),
    read('functions/src/private-season-health.ts'),
    read('functions/src/private-season-research.ts'),
    read('functions/src/service-incident-authority.ts'),
    read('functions/src/privacy-request-authority.ts'),
  ]);

  for (const source of files) {
    assert.match(source, /assessOperationsClientCompatibility/);
    assert.doesNotMatch(source, /CURRENT_BUILD_ID_PATTERN/);
    assert.doesNotMatch(source, /release-candidate-5[6-9]-/);
  }
});

test('formal private-season approval remains tied to the exact release and build', async () => {
  const source = await read('functions/src/shared/core/operations/private-season.util.ts');
  assert.match(source, /approvedReleaseLabel === input\.build\.releaseLabel/);
  assert.match(source, /approvedBuildId === input\.build\.buildId/);
  assert.match(source, /currentDecisionValid/);
});

test('source-controlled deployment policy distinguishes browser-only and contract changes', async () => {
  const policy = JSON.parse(await read('config/operations-api-compatibility.json'));
  assert.equal(policy.operationsApiVersion, 1);
  assert.equal(policy.legacyClientWithoutVersionReleaseCandidate, 56);
  assert.equal(policy.policy.browserOnlyReleaseRequiresOperationsFunctionRedeploy, false);
  assert.equal(policy.policy.operationsApiVersionChangeRequiresRedeploy, true);
  assert.equal(policy.policy.scoringOrProjectionVersionChangeRequiresRedeploy, true);
  assert.equal(policy.policy.operationsRequestOrResponseSchemaChangeRequiresAffectedFunctionRedeploy, true);
  assert.equal(policy.policy.formalPrivateSeasonApprovalRemainsExactBuildBound, true);
  assert.ok(policy.maintainedFunctionGroups.privacy.includes('getMyPrivacyExport'));
});

test('O1G keeps operational compatibility separate from competitive authority', async () => {
  const [compatibility, scoringRules, projection, firestoreRules, firestoreIndexes] = await Promise.all([
    read('functions/src/shared/core/operations/operations-client-compatibility.util.ts'),
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/projection/projection-v11.util.ts'),
    read('firestore.rules'),
    read('firestore.indexes.json'),
  ]);

  assert.doesNotMatch(compatibility, /scoreGame|calculateSkater|calculateGoalie|transaction|waiver/);
  assert.match(scoringRules, /CURRENT_SCORING_RULES_VERSION\s*=\s*4/);
  assert.match(projection, /PROJECTION_MODEL_VERSION\s*=\s*11/);
  assert.ok(firestoreRules.length > 0);
  assert.ok(JSON.parse(firestoreIndexes).indexes.length >= 0);
});

test('O1G release records and verification include the compatibility audit', async () => {
  const [roadmap, docsRoadmap, readme, packageSource, runtime, productionRuntime] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('README.md'),
    read('package.json'),
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.54/);
  assert.match(roadmap, /LOG\.71 2026-08-20 — Completed Operations Batch O1G/);
  assert.match(readme, /Release Candidate 65 \/ Beta Batch B1J/);
  assert.match(runtime, /Release Candidate 65/);
  assert.match(productionRuntime, /Release Candidate 65/);
  assert.match(packageJson.scripts['verify:batcho1g:core'], /operations:audit-compatibility/);
  assert.match(packageJson.scripts['security:ci'], /verify:batchb1j:core/);
});
