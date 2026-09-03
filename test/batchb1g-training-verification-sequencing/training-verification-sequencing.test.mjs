import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  resolveLeagueInviteContinuationStep,
} from '../../src/app/core/league/invite-link-intent.service.ts';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('invite continuation always resolves Training Camp before email verification', () => {
  assert.equal(
    resolveLeagueInviteContinuationStep({
      trainingCampResolved: false,
      emailVerified: false,
    }),
    'training-camp',
  );
  assert.equal(
    resolveLeagueInviteContinuationStep({
      trainingCampResolved: false,
      emailVerified: true,
    }),
    'training-camp',
  );
  assert.equal(
    resolveLeagueInviteContinuationStep({
      trainingCampResolved: true,
      emailVerified: false,
    }),
    'email-verification',
  );
  assert.equal(
    resolveLeagueInviteContinuationStep({
      trainingCampResolved: true,
      emailVerified: true,
    }),
    'join',
  );
});

test('completion and Finish Later remain separate authoritative profile outcomes', async () => {
  const service = await read('src/app/core/onboarding/training-camp.service.ts');

  assert.match(service, /hasCompletedTrainingCamp/);
  assert.match(service, /hasDeferredTrainingCamp/);
  assert.match(
    service,
    /hasResolvedTrainingCampOnboarding[\s\S]*?hasCompletedTrainingCamp\(profile\) \|\| hasDeferredTrainingCamp\(profile\)/,
  );
  assert.match(
    service,
    /completeTrainingCamp[\s\S]*?trainingCampVersion:[\s\S]*?trainingCampDeferredVersion: deleteField\(\)/,
  );
  assert.match(
    service,
    /deferTrainingCamp[\s\S]*?trainingCampDeferredVersion: CURRENT_TRAINING_CAMP_VERSION/,
  );
  assert.doesNotMatch(
    service.match(/export async function deferTrainingCamp[\s\S]*?\n\}/)?.[0] ?? '',
    /trainingCampVersion:/,
  );
});

test('Training Camp completion and explicit exit both unlock a manual first verification send', async () => {
  const [component, template] = await Promise.all([
    read('src/app/features/onboarding/training-camp/training-camp.ts'),
    read('src/app/features/onboarding/training-camp/training-camp.html'),
  ]);

  assert.match(component, /completeTrainingCamp\(this\.userId\)[\s\S]*?continueAfterTrainingCamp\(\)/);
  assert.match(component, /deferTrainingCamp\(this\.userId\)[\s\S]*?continueAfterTrainingCamp\(\)/);
  assert.match(component, /training_camp_deferred/);
  assert.match(component, /markPendingLeagueInviteTrainingCampComplete/);
  assert.match(component, /getVerificationEmailState/);
  assert.match(component, /verificationSendButtonLabel/);
  assert.match(component, /return 'Finish Later'/);
  assert.doesNotMatch(component, /RinkRat is sending the verification email now/);
  assert.doesNotMatch(template, /Finish Later &amp; Verify/);
  assert.match(template, /I Verified — Continue/);
  assert.match(template, /verificationSendButtonLabel\(\)/);
  assert.match(template, /Click to send the first verification email/);
});

test('the invite page reads completed-or-deferred profile state before joining', async () => {
  const [component, template] = await Promise.all([
    read('src/app/features/leagues/invite-link/invite-link.ts'),
    read('src/app/features/leagues/invite-link/invite-link.html'),
  ]);

  assert.match(component, /hasResolvedTrainingCampOnboarding/);
  assert.match(component, /const trainingCampResolved = hasResolvedTrainingCampOnboarding\(profile\);/);
  assert.match(component, /resolveLeagueInviteContinuationStep\(\{[\s\S]*?trainingCampResolved/);
  assert.match(template, /choose Finish Later/);
  assert.match(template, /send the first verification email yourself/);
  assert.match(template, /verificationSendButtonLabel\(\)/);
});

test('the profile-created trigger holds email during Training Camp and only marks manual send ready afterward', async () => {
  const source = await read('functions/src/email-notifications.ts');
  const createdTrigger = source.match(
    /export const sendWelcomeEmailOnProfileCreated[\s\S]*?\n\);\n\nexport const sendWelcomeEmailAfterTrainingCampResolved/,
  )?.[0] ?? '';

  assert.match(createdTrigger, /const currentSnapshot = await db\.doc\(`users\/\$\{userId\}`\)\.get\(\);/);
  assert.match(createdTrigger, /welcomeEmailStatus: 'waiting-for-training-camp'/);
  assert.match(createdTrigger, /hasReleasedOnboardingVerification\(profile\)/);
  assert.match(createdTrigger, /markInitialAccountEmailReady\(userId, profile\)/);
  assert.match(source, /export const sendWelcomeEmailAfterTrainingCampResolved = onDocumentWritten/);
  assert.match(
    source,
    /sendWelcomeEmailAfterTrainingCampResolved[\s\S]*?!hasReleasedOnboardingVerification\(profile\)[\s\S]*?markInitialAccountEmailReady\(userId, profile\)/,
  );
  assert.match(source, /welcomeEmailStatus: 'ready-for-manual-send'/);
  assert.match(source, /verificationEmailReadyAt: FieldValue\.serverTimestamp\(\)/);
});

test('the Training Camp email trigger narrows optional Firestore profile data before use', async () => {
  const source = await read('functions/src/email-notifications.ts');
  const writtenTrigger = source.match(
    /export const sendWelcomeEmailAfterTrainingCampResolved[\s\S]*?\n\);\n\nexport const sendInjuryEmailOnAvailabilityChange/,
  )?.[0] ?? '';

  assert.match(writtenTrigger, /const profile = snapshot\.data\(\);/);
  assert.match(
    writtenTrigger,
    /if \(!profile\) \{[\s\S]*?return;[\s\S]*?\}/,
    'DocumentSnapshot.data() is optional in the Firebase type contract and must be narrowed before helper calls',
  );
  assert.match(writtenTrigger, /hasOnboardingEmailHistory\(profile\)/);
  assert.match(writtenTrigger, /hasReleasedOnboardingVerification\(profile\)/);
  assert.match(writtenTrigger, /markInitialAccountEmailReady\(userId, profile\)/);
});

test('the verification callable separates status from send and reports cooldown truthfully', async () => {
  const source = await read('functions/src/email-notifications.ts');
  const callable = source.match(
    /export const resendVerificationEmail[\s\S]*?\n\);\n\nexport const sendWelcomeEmailOnProfileCreated/,
  )?.[0] ?? '';

  assert.match(callable, /action = asString\(asRecord\(request\.data\)\['action'\]\)/);
  assert.match(callable, /action === 'status'/);
  assert.match(callable, /action === 'send'/);
  assert.match(callable, /onboardingResolved/);
  assert.match(callable, /Finish Training Camp or choose Finish Later before requesting email verification/);
  assert.match(callable, /'welcome-verification'/);
  assert.match(callable, /claimRateLimitWithState/);
  assert.match(callable, /outcome: 'cooldown'/);
  assert.match(callable, /cooldownSecondsRemaining/);
  assert.match(callable, /nextAllowedAtMillis/);
  assert.match(callable, /releaseRateLimit/);
  assert.match(source, /idempotencyKey: `welcome-verification-\$\{userId\}`/);
  assert.match(source, /idempotencyKey: `welcome-verified-\$\{userId\}`/);
  assert.match(source, /invalid_idempotent_request/i);
  assert.match(source, /isPreviouslyAcceptedIdempotentDelivery/);
  assert.match(source, /welcomeEmailDeferredAt: FieldValue\.delete\(\)/);
});

test('Firestore permits the private deferral fields without exposing server email state', async () => {
  const rules = await read('firestore.rules');
  const profileUpdateBlock = rules.match(
    /function validUserProfileUpdate\(\)[\s\S]*?\n      \}/,
  )?.[0] ?? '';

  assert.match(rules, /trainingCampDeferredVersion/);
  assert.match(rules, /trainingCampDeferredAt/);
  assert.match(profileUpdateBlock, /'trainingCampDeferredVersion'/);
  assert.match(profileUpdateBlock, /'trainingCampDeferredAt'/);
  assert.doesNotMatch(profileUpdateBlock, /welcomeEmailStatus/);
  assert.doesNotMatch(profileUpdateBlock, /welcomeEmailSentAt/);
  assert.match(rules, /match \/leagueInvites\/\{inviteCode\}[\s\S]*?allow read, create, update, delete: if false;/);
});

test('Release Readiness requires no-early-email and Finish Later evidence', async () => {
  const [validation, releaseUtil] = await Promise.all([
    read('src/app/core/release/invite-beta-validation.util.ts'),
    read('scripts/release/invite-beta-release.util.mjs'),
  ]);

  assert.match(validation, /INVITE_BETA_VALIDATION_SCHEMA_VERSION = 4/);
  assert.match(validation, /id: 'invite-link-email-held-during-training-camp'/);
  assert.match(validation, /id: 'invite-link-training-first'/);
  assert.match(validation, /id: 'invite-link-finish-later'/);
  assert.match(validation, /id: 'invite-link-reload-recovery'/);
  assert.match(releaseUtil, /schemaVersion !== 4/);
});

test('RC64 and B1I are the exact release, CI, freeze, and deployment identity', async () => {
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
  assert.match(packageJson.scripts['verify:batchb1g:core'], /verify:batchb1f:core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batch(?:b1j|d1j):core/);
  assert.match(readme, /Release Candidate 65 \/ Beta Batch B1J/);
  assert.match(runbook, /firebase deploy --only hosting:app/);
  assert.match(runbook, /RC62 Rules and Functions remain required/);
});

test('roadmap and permanent documentation record the B1G sequencing decision', async () => {
  const [rootRoadmap, docsRoadmap, projectDocumentation, batchDocumentation] =
    await Promise.all([
      read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
      read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
      read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
      read('docs/RINKRAT_BETA_B1G_TRAINING_FIRST_VERIFICATION.md'),
    ]);

  assert.equal(rootRoadmap, docsRoadmap);
  assert.match(rootRoadmap, /^RINKRAT COMPETITIVE ROADMAP\nVersion 1\.54\.\d+/);
  assert.match(rootRoadmap, /B1\.33 Delay the first account verification email/);
  assert.match(rootRoadmap, /LOG\.78 2026-08-21/);
  assert.match(projectDocumentation, /Beta Batch B1G — Training-First Email Verification/);
  assert.match(batchDocumentation, /Closing a browser tab without pressing the exit action/);
});

test('protected scoring and projection contracts remain unchanged', async () => {
  const [scoring, projection, freezeSource] = await Promise.all([
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/projection/projection-snapshot.service.ts'),
    read('config/release-freeze/beta-freeze-policy.json'),
  ]);
  const freeze = JSON.parse(freezeSource);

  assert.match(scoring, /CURRENT_SCORING_RULES_VERSION\s*=\s*4/);
  assert.match(projection, /SHARED_PROJECTION_VERSION\s*=\s*11/);
  assert.equal(freeze.queueMode, 'shadow');
  assert.equal(freeze.appCheckMode, 'monitor');
  assert.equal(freeze.requiredGamesPerRosterSlot, 6);
});
