import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('verification email uses the RinkRat handler and carries only a valid invite continuation', async () => {
  const [emailSource, continuationSource, routes] = await Promise.all([
    read('functions/src/email-notifications.ts'),
    read('functions/src/shared/email/verification-continuation.util.ts'),
    read('src/app/app.routes.ts'),
  ]);

  assert.match(emailSource, /buildVerificationContinuationUrl/);
  assert.match(emailSource, /Verify Email & Join League/);
  assert.match(emailSource, /inviteCode: normalizedInviteCode/);
  assert.match(continuationSource, /mode !== 'verifyEmail'/);
  assert.match(continuationSource, /searchParams\.set\('oobCode', oobCode\)/);
  assert.doesNotMatch(continuationSource, /searchParams\.set\('link'/);
  assert.match(routes, /path: 'verify-email'[\s\S]*?VerifyEmail/);
});

test('the browser verifies first, removes the action code from history, and resumes secure joining', async () => {
  const source = await read('src/app/features/auth/verify-email/verify-email.ts');

  assert.match(source, /checkActionCode\(auth, this\.actionCode\)/);
  assert.match(source, /applyActionCode\(auth, this\.actionCode\)/);
  assert.match(source, /window\.history\.replaceState\(\{\}, '', '\/verify-email'\)/);
  assert.match(source, /user\.getIdToken\(true\)/);
  assert.match(source, /startPendingLeagueInvite/);
  assert.match(source, /navigateByUrl\(invitePath, \{ replaceUrl: true \}\)/);
  assert.doesNotMatch(source, /joinLeagueByInviteCode/);
});

test('real names remain private except through the membership-authorized league profile lookup', async () => {
  const [profileAuthority, lookup, publicProfileService] = await Promise.all([
    read('functions/src/manager-profile-authority.ts'),
    read('functions/src/index.ts'),
    read('src/app/core/user/user.service.ts'),
  ]);

  assert.match(profileAuthority, /firstName/);
  assert.match(profileAuthority, /lastName/);
  assert.match(lookup, /verifyLeagueMembership\(leagueId, request\.auth\.uid\)/);
  assert.match(lookup, /firstName: asString\(source\['firstName'\]\)/);
  assert.match(publicProfileService, /interface LeagueManagerProfile extends PublicUserProfile/);

  const publicWrite = publicProfileService.match(
    /function getPublicProfileWrite[\s\S]*?\n\}/,
  )?.[0] ?? '';
  assert.doesNotMatch(publicWrite, /firstName|lastName/);
});
