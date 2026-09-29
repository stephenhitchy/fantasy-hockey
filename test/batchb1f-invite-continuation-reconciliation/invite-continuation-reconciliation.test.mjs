import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  bindPendingLeagueInviteToAccount,
  clearPendingLeagueInvite,
  readPendingLeagueInvite,
  resolveLeagueInviteContinuationStep,
  startPendingLeagueInvite,
} from '../../src/app/core/league/invite-link-intent.service.ts';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test.afterEach(() => {
  clearPendingLeagueInvite();
});

test('the authoritative continuation depends only on verified email state', () => {
  assert.equal(
    resolveLeagueInviteContinuationStep({
      emailVerified: false,
    }),
    'email-verification',
  );
  assert.equal(
    resolveLeagueInviteContinuationStep({
      emailVerified: true,
    }),
    'join',
  );
});

test('a legacy local Training Camp hint remains inert for old saved intents', () => {
  startPendingLeagueInvite('ICE123', { requiresTrainingCamp: true });
  bindPendingLeagueInviteToAccount('new-user', { inviteCode: 'ICE123' });

  const intent = readPendingLeagueInvite('ICE123');
  assert.ok(intent);
  assert.equal(intent.requiresTrainingCamp, true);
  assert.equal(
    resolveLeagueInviteContinuationStep({
      emailVerified: true,
    }),
    'join',
  );
});

test('the invite component uses profile identity without treating tutorial state as a prerequisite', async () => {
  const component = await read('src/app/features/leagues/invite-link/invite-link.ts');

  assert.match(component, /const profile = await getUserProfile\(user\.uid\);/);
  assert.match(component, /resolveLeagueInviteContinuationStep\(\{[\s\S]*?emailVerified: user\.emailVerified/);
  assert.match(component, /joinLeague\(user, profile\?\.username \?\? ''\)/);
  assert.doesNotMatch(component, /hasResolvedTrainingCampOnboarding|continuationStep === 'training-camp'/);
});

test('verification refresh re-enters the reconciler before secure joining', async () => {
  const component = await read('src/app/features/leagues/invite-link/invite-link.ts');
  const refreshBlock = component.match(
    /async refreshVerificationStatus\([\s\S]*?\n  async retry\(\)/,
  )?.[0] ?? '';

  assert.match(refreshBlock, /await user\.getIdToken\(true\);/);
  assert.match(refreshBlock, /await this\.resumePendingInvite\(\);/);
  assert.doesNotMatch(refreshBlock, /await this\.joinLeague\(user\);/);
});

test('manager-facing copy explains that verification continues the saved invitation', async () => {
  const template = await read('src/app/features/leagues/invite-link/invite-link.html');

  assert.match(template, /Verify Email &amp; Join League/);
  assert.match(template, /finish automatically/);
  assert.doesNotMatch(template, /Training Camp|finish or exit Training Camp/);
});

test('the exact-build board records direct onboarding and reload recovery', async () => {
  const validation = await read('src/app/core/release/invite-beta-validation.util.ts');

  assert.match(validation, /INVITE_BETA_VALIDATION_SCHEMA_VERSION = 4/);
  assert.match(validation, /id: 'invite-link-training-first'/);
  assert.match(validation, /id: 'invite-link-email-held-during-training-camp'/);
  assert.match(validation, /id: 'invite-link-reload-recovery'/);
  assert.match(validation, /id: 'invite-link-finish-later'/);
  assert.match(validation, /without tutorial interruption/);
  assert.match(validation, /tutorial state remains incomplete and undeferred/);
});

test('current release controls use the B1G exact verification and freeze identity', async () => {
  const [runtime, productionRuntime, freezeSource, packageSource, readme, runbook] =
    await Promise.all([
      read('src/environments/app-runtime.config.ts'),
      read('src/environments/app-runtime.config.production.ts'),
      read('config/release-freeze/beta-freeze-policy.json'),
      read('package.json'),
      read('README.md'),
      read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
    ]);
  const freeze = JSON.parse(freezeSource);
  const packageJson = JSON.parse(packageSource);

  assert.match(runtime, /Release Candidate 65/);
  assert.match(productionRuntime, /Release Candidate 65/);
  assert.equal(freeze.releaseLabel, 'Release Candidate 65');
  assert.equal(freeze.verificationCommand, 'npm run verify:batchb1j');
  assert.equal(freeze.defaultTag, 'rinkrat-rc65-invite-beta');
  assert.match(packageJson.scripts['security:ci'], /verify:batch(?:b1j|d1j):core/);
  assert.match(readme, /Release Candidate 65 \/ Beta Batch B1J/);
  assert.match(runbook, /npm run verify:batchb1j/);
  assert.match(runbook, /rinkrat-rc65-invite-beta/);
  assert.match(await read('scripts/release/invite-beta-release.util.mjs'), /schemaVersion !== 4/);
  assert.match(await read('scripts/release/invite-beta-release.util.mjs'), /verificationCommand/);
});

test('the verification gate preserves invite privacy and competition-model versions', async () => {
  const [rules, scoring, projection] = await Promise.all([
    read('firestore.rules'),
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/projection/projection-snapshot.service.ts'),
  ]);

  assert.match(rules, /match \/leagueInvites\/\{inviteCode\}[\s\S]*?allow read, create, update, delete: if false;/);
  assert.match(rules, /'trainingCampDeferredVersion'/);
  assert.match(rules, /'trainingCampDeferredAt'/);
  assert.match(scoring, /CURRENT_SCORING_RULES_VERSION\s*=\s*4/);
  assert.match(projection, /SHARED_PROJECTION_VERSION\s*=\s*11/);
});
