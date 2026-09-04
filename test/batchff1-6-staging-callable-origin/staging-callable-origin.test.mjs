import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { TRUSTED_WEB_ORIGINS } from '../../functions/src/web-security.ts';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

function isTrusted(origin) {
  return TRUSTED_WEB_ORIGINS.some((allowed) =>
    typeof allowed === 'string' ? allowed === origin : allowed.test(origin),
  );
}

test('the exact production, staging, legacy, and local origins are trusted', () => {
  const accepted = [
    'https://rinkratfantasy.com',
    'https://www.rinkratfantasy.com',
    'https://cycle-puck.web.app',
    'https://cycle-puck.firebaseapp.com',
    'https://rinkrat-staging-d1nc-2026.web.app',
    'https://rinkrat-staging-d1nc-2026.firebaseapp.com',
    'http://localhost',
    'http://localhost:4200',
    'http://127.0.0.1',
    'http://127.0.0.1:5000',
  ];

  for (const origin of accepted) {
    assert.equal(isTrusted(origin), true, `${origin} should be trusted`);
  }
});

test('lookalike, preview, insecure, and unrelated Firebase origins remain denied', () => {
  const denied = [
    'http://rinkrat-staging-d1nc-2026.web.app',
    'https://rinkrat-staging-d1nc-2026.web.app.evil.example',
    'https://evil-rinkrat-staging-d1nc-2026.web.app',
    'https://rinkrat-staging-d1nc-2026--preview.web.app',
    'https://another-project.web.app',
    'https://another-project.firebaseapp.com',
    'https://rinkratfantasy.com.evil.example',
    'https://localhost:4200',
    'http://127.0.0.2:5000',
  ];

  for (const origin of denied) {
    assert.equal(isTrusted(origin), false, `${origin} should be denied`);
  }
});

test('the allowlist contains no wildcard or broad hosted-project expression', () => {
  for (const allowed of TRUSTED_WEB_ORIGINS) {
    if (typeof allowed === 'string') {
      assert.doesNotMatch(allowed, /\*/);
      continue;
    }

    assert.doesNotMatch(allowed.source, /web\\?\.app|firebaseapp/);
  }
});

test('Draft rehearsal callables retain authentication and the shared exact-origin policy', async () => {
  const [draftAuthority, projectionAuthority, teamIdentity] = await Promise.all([
    read('functions/src/draft-authority.ts'),
    read('functions/src/projection-authority.ts'),
    read('functions/src/team-identity-challenges.ts'),
  ]);

  for (const exportName of [
    'executeDraftCommand',
    'repairDraftTurnHandoff',
    'makeSecureDraftPick',
  ]) {
    const start = draftAuthority.indexOf(`export const ${exportName} = onCall(`);
    assert.notEqual(start, -1, `${exportName} should remain exported`);
    const callableSource = draftAuthority.slice(start, start + 1_500);
    assert.match(callableSource, /cors: TRUSTED_WEB_ORIGINS/);
    assert.match(callableSource, /requireAuthenticatedUserId\(request\.auth\)/);
    assert.doesNotMatch(callableSource, /cors:\s*true/);
  }

  const projectionStart = projectionAuthority.indexOf(
    'export const requestProjectionSnapshotGeneration = onCall(',
  );
  assert.notEqual(projectionStart, -1);
  const projectionCallable = projectionAuthority.slice(projectionStart, projectionStart + 2_000);
  assert.match(projectionCallable, /cors: TRUSTED_WEB_ORIGINS/);
  assert.match(projectionCallable, /request\.auth\?\.uid/);
  assert.doesNotMatch(projectionCallable, /cors:\s*true/);

  const identityStart = teamIdentity.indexOf(
    'export const reconcileTeamIdentityChallenges = onCall(',
  );
  assert.notEqual(identityStart, -1);
  const identityCallable = teamIdentity.slice(identityStart, identityStart + 1_500);
  assert.match(identityCallable, /cors: TRUSTED_WEB_ORIGINS/);
  assert.match(identityCallable, /request\.auth\?\.uid/);
  assert.doesNotMatch(identityCallable, /cors:\s*true/);
});

test('FF1.22 documents acceptance, edge cases, observability, deployment, and rollback', async () => {
  const [documentation, packageSource, roadmap, docsRoadmap] = await Promise.all([
    read('docs/RINKRAT_FF1_6_STAGING_CALLABLE_ORIGIN.md'),
    read('package.json'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.match(documentation, /Acceptance criteria/);
  assert.match(documentation, /Edge cases and stop conditions/);
  assert.match(documentation, /Observability/);
  assert.match(documentation, /Deployment resources/);
  assert.match(documentation, /Rollback/);
  assert.match(documentation, /Production Scoring V4/);
  assert.match(documentation, /Projection V11/);
  assert.match(packageJson.scripts['verify:batchff1-6:core'], /verify:batchff1-5:core/);
  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /FF1\.22 exact staging callable origin/);
});
