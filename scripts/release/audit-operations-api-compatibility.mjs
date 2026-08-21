import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

const [
  policySource,
  serverCompatibility,
  clientCompatibility,
  privateSeasonAuthority,
  privateSeasonHealth,
  privateSeasonResearch,
  serviceIncidentAuthority,
  privacyAuthority,
  privateSeasonUtility,
  privateSeasonService,
  privateSeasonHealthService,
  privateSeasonEngagementService,
  privateSeasonResearchService,
  serviceIncidentService,
  privacyService,
] = await Promise.all([
  read('config/operations-api-compatibility.json'),
  read('functions/src/shared/core/operations/operations-client-compatibility.util.ts'),
  read('src/app/core/operations/operations-client-compatibility.ts'),
  read('functions/src/private-season-authority.ts'),
  read('functions/src/private-season-health.ts'),
  read('functions/src/private-season-research.ts'),
  read('functions/src/service-incident-authority.ts'),
  read('functions/src/privacy-request-authority.ts'),
  read('functions/src/shared/core/operations/private-season.util.ts'),
  read('src/app/core/operations/private-season.service.ts'),
  read('src/app/core/operations/private-season-health.service.ts'),
  read('src/app/core/operations/private-season-engagement.service.ts'),
  read('src/app/core/operations/private-season-research.service.ts'),
  read('src/app/core/operations/service-incident.service.ts'),
  read('src/app/core/privacy/privacy-operations.service.ts'),
]);

const policy = JSON.parse(policySource);
assert.equal(policy.schemaVersion, 1);
assert.equal(policy.operationsApiVersion, 1);
assert.equal(policy.minimumReleaseCandidate, 56);
assert.equal(policy.legacyClientWithoutVersionReleaseCandidate, 56);
assert.equal(policy.scoringRulesVersion, 4);
assert.equal(policy.projectionVersion, 11);
assert.equal(policy.policy.browserOnlyReleaseRequiresOperationsFunctionRedeploy, false);
assert.equal(policy.policy.formalPrivateSeasonApprovalRemainsExactBuildBound, true);
assert.equal(policy.policy.localBuildWritesRemainBlocked, true);

for (const source of [serverCompatibility, clientCompatibility]) {
  assert.match(source, /OPERATIONS_API_VERSION\s*=\s*1/);
  assert.match(source, /OPERATIONS_MINIMUM_RELEASE_CANDIDATE\s*=\s*56/);
  assert.match(source, /OPERATIONS_SCORING_VERSION\s*=\s*4/);
  assert.match(source, /OPERATIONS_PROJECTION_VERSION\s*=\s*11/);
}

for (const source of [
  privateSeasonAuthority,
  privateSeasonHealth,
  privateSeasonResearch,
  serviceIncidentAuthority,
  privacyAuthority,
]) {
  assert.match(source, /normalizeOperationsClientIdentity/);
  assert.match(source, /assessOperationsClientCompatibility/);
  assert.doesNotMatch(source, /CURRENT_BUILD_ID_PATTERN/);
  assert.doesNotMatch(source, /releaseLabel\s*!==\s*[A-Z_]+RELEASE_LABEL/);
  assert.doesNotMatch(source, /accepts only the current RC\d+/i);
}

for (const source of [
  privateSeasonService,
  privateSeasonHealthService,
  privateSeasonEngagementService,
  privateSeasonResearchService,
  serviceIncidentService,
  privacyService,
]) {
  assert.match(source, /currentOperationsClientIdentity/);
  assert.doesNotMatch(source, /BUNDLED_RELEASE_MANIFEST\.releaseLabel/);
}

assert.match(
  privateSeasonUtility,
  /plan\.freeze\.approvedReleaseLabel\s*===\s*input\.build\.releaseLabel/,
);
assert.match(
  privateSeasonUtility,
  /plan\.freeze\.approvedBuildId\s*===\s*input\.build\.buildId/,
);
assert.match(serverCompatibility, /OPERATIONS_LEGACY_CLIENT_RELEASE_CANDIDATE\s*=\s*56/);
assert.match(serverCompatibility, /legacyRc56Client/);
assert.match(serverCompatibility, /requireDeployableBuild/);
assert.match(serverCompatibility, /!identity\.buildId\.endsWith\('-local'\)/);

console.log(
  '✓ Operational callables use compatibility contract v1; exact private-season approvals remain build-bound',
);
console.log(
  '✓ Browser-only releases do not require O1B–O1F Function redeployment while the operations contract stays unchanged',
);
