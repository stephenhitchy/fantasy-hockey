import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  bindPendingLeagueInviteToAccount,
  clearPendingLeagueInvite,
  readPendingLeagueInvite,
  resolveLeagueInviteContinuationStep,
  startPendingLeagueInvite,
} from '../../src/app/core/league/invite-link-intent.service.ts';
import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';

const ROOT = new URL('../../', import.meta.url);
const read = (relativePath) => readFile(new URL(relativePath, ROOT), 'utf8');
const sha256 = async (relativePath) => createHash('sha256')
  .update(await readFile(new URL(relativePath, ROOT)))
  .digest('hex');

test.afterEach(() => {
  clearPendingLeagueInvite();
});

test('invite continuation depends on verified email, never Training Camp state', () => {
  assert.equal(
    resolveLeagueInviteContinuationStep({ emailVerified: false }),
    'email-verification',
  );
  assert.equal(
    resolveLeagueInviteContinuationStep({ emailVerified: true }),
    'join',
  );

  startPendingLeagueInvite('ICE123');
  const bound = bindPendingLeagueInviteToAccount('ordinary-user', {
    inviteCode: 'ICE123',
  });
  assert.ok(bound);
  assert.equal(bound.requiresTrainingCamp, false);
  assert.equal(readPendingLeagueInvite('ICE123')?.accountUid, 'ordinary-user');
});

test('registration requests exactly one coordinated first email and preserves send failure recovery', async () => {
  const source = await read('src/app/features/auth/auth.ts');
  const registrationSend = source.match(
    /private async initiateRegistrationVerificationEmail[\s\S]*?\n  private async submitPasswordReset/,
  )?.[0] ?? '';

  assert.match(source, /await this\.initiateRegistrationVerificationEmail\(pendingInvite\?\.inviteCode\)/);
  assert.equal((registrationSend.match(/requestVerificationEmail\(/g) ?? []).length, 1);
  assert.match(registrationSend, /result\.outcome === 'sent'/);
  assert.match(registrationSend, /result\.outcome === 'cooldown'/);
  assert.match(registrationSend, /Profile created, but the verification email could not be sent/);
  assert.match(source, /buildLeagueInvitePath\(pendingInvite\.inviteCode\)/);
  assert.match(source, /if \(this\.isRegistering\(\)\) \{[\s\S]*?navigate\(\['\/dashboard'\]\)/);
  assert.doesNotMatch(source, /navigate\(\['\/training-camp'\]/);
});

test('the sender is tutorial-independent, rate-limited, idempotent, and truthful', async () => {
  const source = await read('functions/src/email-notifications.ts');
  const callable = source.match(
    /export const resendVerificationEmail[\s\S]*?\n\);\n\nexport const sendWelcomeEmailOnProfileCreated/,
  )?.[0] ?? '';
  const createdTrigger = source.match(
    /export const sendWelcomeEmailOnProfileCreated[\s\S]*?\n\);\n\n\/\/ Keep the deployed function name/,
  )?.[0] ?? '';
  const reconciliationTrigger = source.match(
    /export const sendWelcomeEmailAfterTrainingCampResolved[\s\S]*?\n\);\n\nexport const sendInjuryEmailOnAvailabilityChange/,
  )?.[0] ?? '';

  assert.match(callable, /eligible: true/);
  assert.match(callable, /claimRateLimitWithState/);
  assert.match(callable, /outcome: 'cooldown'/);
  assert.match(callable, /releaseRateLimit\(rateLimitKey\)/);
  assert.match(callable, /firstSend \? 'welcome-verification' : 'verification-resend'/);
  assert.doesNotMatch(callable, /trainingCamp|Finish Training Camp|onboardingResolved/);
  assert.match(source, /idempotencyKey: `welcome-verification-\$\{userId\}`/);
  assert.match(source, /return db\.runTransaction/);
  assert.doesNotMatch(createdTrigger, /sendVerificationEmail\(/);
  assert.doesNotMatch(reconciliationTrigger, /sendVerificationEmail\(/);
  assert.doesNotMatch(createdTrigger, /waiting-for-training-camp|trainingCampVersion/);
  assert.doesNotMatch(reconciliationTrigger, /trainingCampDeferredVersion|trainingCampVersion/);
});

test('the invite page refreshes verified auth state and resumes only the secure saved join', async () => {
  const [source, template, leagueService] = await Promise.all([
    read('src/app/features/leagues/invite-link/invite-link.ts'),
    read('src/app/features/leagues/invite-link/invite-link.html'),
    read('src/app/core/league/league.service.ts'),
  ]);

  assert.doesNotMatch(source, /hasResolvedTrainingCampOnboarding|continueTrainingCamp|stage\.set\('training-camp'\)/);
  assert.doesNotMatch(template, /Training Camp comes first|finish or exit Training Camp/);
  assert.match(source, /await user\.reload\(\)/);
  assert.match(source, /await user\.getIdToken\(true\)/);
  assert.match(source, /state\.alreadyVerified[\s\S]*?refreshVerificationStatus\(true\)/);
  assert.match(source, /joinLeagueByInviteCode\(this\.inviteCode\(\), username\)/);
  assert.match(source, /accountMatch === 'mismatch'/);
  assert.match(source, /clearPendingLeagueInvite[\s\S]*?isTerminalJoinFailure/);
  assert.match(leagueService, /functions, 'joinLeagueSecure'/);
});

test('verification callbacks preserve same- and other-browser continuation without becoming authentication', async () => {
  const source = await read('src/app/features/auth/verify-email/verify-email.ts');

  assert.match(source, /checkActionCode\(auth, this\.actionCode\)/);
  assert.match(source, /applyActionCode\(auth, this\.actionCode\)/);
  assert.match(source, /verificationEmailMatchesSession/);
  assert.match(source, /stage\.set\('account-mismatch'\)/);
  assert.match(source, /startPendingLeagueInvite\(inviteCode/);
  assert.match(source, /user\.getIdToken\(true\)/);
  assert.match(source, /navigateByUrl\(invitePath, \{ replaceUrl: true \}\)/);
  assert.doesNotMatch(source, /joinLeagueByInviteCode/);
});

test('Training Camp remains voluntary and cannot release verification or membership', async () => {
  const [component, service, settings, settingsTemplate, guard, validation] = await Promise.all([
    read('src/app/features/onboarding/training-camp/training-camp.ts'),
    read('src/app/core/onboarding/training-camp.service.ts'),
    read('src/app/features/account/account-settings/account-settings.ts'),
    read('src/app/features/account/account-settings/account-settings.html'),
    read('src/app/core/guards/auth.guard.ts'),
    read('src/app/core/release/invite-beta-validation.util.ts'),
  ]);

  assert.doesNotMatch(component, /requestVerificationEmail|getVerificationEmailState/);
  assert.match(component, /continuationRequested[\s\S]*?navigateByUrl\(invitePath, \{ replaceUrl: true \}\)/);
  assert.match(service, /completeTrainingCamp/);
  assert.match(service, /deferTrainingCamp/);
  assert.doesNotMatch(service, /email verification|hasResolvedTrainingCampOnboarding/);
  assert.match(settings, /verificationEmailEligible\.set\(true\)/);
  assert.doesNotMatch(settingsTemplate, /Finish Training Camp or choose Finish Later/);
  assert.doesNotMatch(guard, /trainingCamp|Training Camp/);
  assert.match(validation, /without tutorial interruption/);
  assert.match(validation, /tutorial state remains incomplete and undeferred/);
});

test('ordinary users retain server-authorized idempotent joins and specific terminal outcomes', async () => {
  const [authority, invite] = await Promise.all([
    read('functions/src/league-lifecycle-authority.ts'),
    read('src/app/features/leagues/invite-link/invite-link.ts'),
  ]);
  const joinStart = authority.indexOf('export const joinLeagueSecure');
  const joinEnd = authority.indexOf('function createMemberRemovalAuditId', joinStart);
  const joinCallable = authority.slice(joinStart, joinEnd);

  assert.ok(joinStart >= 0 && joinEnd > joinStart);

  assert.match(joinCallable, /requireAuthenticatedUserId/);
  assert.match(joinCallable, /requireVerifiedEmail/);
  assert.doesNotMatch(joinCallable, /platformAdmin|isAdmin|adminClaim/);
  assert.match(joinCallable, /const alreadyMember = memberSnapshot\.exists \|\| teamSnapshot\.exists/);
  assert.match(joinCallable, /invite has expired/);
  assert.match(joinCallable, /invite is no longer active/);
  assert.match(joinCallable, /Draft membership cutoff has passed/);
  assert.match(joinCallable, /This league is full/);
  assert.match(invite, /no league was found|invite has expired|invite is no longer active|league entry closed|league is full/i);
});

test('email configuration remains the existing Resend secret and approved app origin', async () => {
  const [emailSource, continuation] = await Promise.all([
    read('functions/src/email-notifications.ts'),
    read('functions/src/shared/email/verification-continuation.util.ts'),
  ]);

  assert.match(emailSource, /defineSecret\('RESEND_API_KEY'\)/);
  assert.match(emailSource, /EMAIL_FROM_ADDRESS/);
  assert.match(emailSource, /APP_BASE_URL/);
  assert.match(continuation, /\/verify-email/);
  assert.match(continuation, /normalizeVerificationInviteCode/);
});

test('the repair has one inherited gate and a targeted no-delete deployment handoff', async () => {
  const [packageSource, handoff] = await Promise.all([
    read('package.json'),
    read('docs/RINKRAT_PRODUCT_B1V_ONBOARDING_REPAIR.md'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.match(packageJson.scripts['verify:batchb1v:core'], /verify:batchb1u:core/);
  assert.match(packageJson.scripts['verify:batchb1v'], /toolchain:verify/);
  assert.match(handoff, /functions:resendVerificationEmail/);
  assert.match(handoff, /functions:sendWelcomeEmailOnProfileCreated/);
  assert.match(handoff, /functions:sendWelcomeEmailAfterTrainingCampResolved/);
  assert.match(handoff, /hosting:app/);
  assert.match(handoff, /Deploy Functions before Hosting/);
  assert.match(handoff, /No Rules, indexes, TTL, queue-mode/);
});

test('the focused repair leaves competitive contracts and Firebase policy unchanged', async () => {
  assert.equal(
    await sha256('src/app/core/scoring/scoring-rules.ts'),
    PROTECTED_SOURCE_HASHES.scoringRules,
  );
  assert.equal(
    await sha256('src/app/core/scoring/scoring-engine.ts'),
    PROTECTED_SOURCE_HASHES.scoringEngine,
  );
  assert.equal(
    await sha256('src/app/core/projection/projection-v11.util.ts'),
    PROTECTED_SOURCE_HASHES.projectionV11,
  );
  assert.equal(
    await sha256('firestore.rules'),
    PROTECTED_SOURCE_HASHES.firestoreRules,
  );
});
