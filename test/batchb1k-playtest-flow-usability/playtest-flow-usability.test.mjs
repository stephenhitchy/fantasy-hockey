import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import {
  formatVerificationCooldown,
  getVerificationCooldownSeconds,
  getVerificationSendButtonLabel,
} from '../../src/app/core/notifications/verification-email-state.util.ts';

const ROOT = new URL('../../', import.meta.url);
const read = (relativePath) => readFile(new URL(relativePath, ROOT), 'utf8');
const sha256 = async (relativePath) => createHash('sha256')
  .update(await readFile(new URL(relativePath, ROOT)))
  .digest('hex');

test('verification labels and countdown distinguish the first send from resends', () => {
  assert.equal(
    getVerificationSendButtonLabel({
      sending: false,
      emailPreviouslySent: false,
      cooldownSeconds: 0,
    }),
    'Send verification email',
  );
  assert.equal(
    getVerificationSendButtonLabel({
      sending: false,
      emailPreviouslySent: true,
      cooldownSeconds: 0,
    }),
    'Send another verification email',
  );
  assert.equal(
    getVerificationSendButtonLabel({
      sending: false,
      emailPreviouslySent: true,
      cooldownSeconds: 102,
    }),
    'Send another in 1:42',
  );
  assert.equal(formatVerificationCooldown(9), '9s');
  assert.equal(getVerificationCooldownSeconds(11_500, 10_000), 2);
  assert.equal(getVerificationCooldownSeconds(9_999, 10_000), 0);
});

test('the backend marks an unresolved account ready but never auto-sends its first email', async () => {
  const source = await read('functions/src/email-notifications.ts');
  const createdTrigger = source.match(
    /export const sendWelcomeEmailOnProfileCreated[\s\S]*?\n\);\n\nexport const sendWelcomeEmailAfterTrainingCampResolved/,
  )?.[0] ?? '';
  const resolvedTrigger = source.match(
    /export const sendWelcomeEmailAfterTrainingCampResolved[\s\S]*?\n\);\n\nexport const sendInjuryEmailOnAvailabilityChange/,
  )?.[0] ?? '';

  assert.match(source, /welcomeEmailStatus: 'ready-for-manual-send'/);
  assert.match(source, /verificationEmailReadyAt: FieldValue\.serverTimestamp\(\)/);
  assert.match(createdTrigger, /markInitialAccountEmailReady\(userId, profile\)/);
  assert.match(resolvedTrigger, /markInitialAccountEmailReady\(userId, profile\)/);
  assert.doesNotMatch(createdTrigger, /sendVerificationEmail\(/);
  assert.doesNotMatch(resolvedTrigger, /sendVerificationEmail\(/);
});

test('the verification callable supports status, send, truthful cooldown, and first-send identity', async () => {
  const [source, client] = await Promise.all([
    read('functions/src/email-notifications.ts'),
    read('src/app/core/notifications/email-notification.service.ts'),
  ]);
  const callable = source.match(
    /export const resendVerificationEmail[\s\S]*?\n\);\n\nexport const sendWelcomeEmailOnProfileCreated/,
  )?.[0] ?? '';

  assert.match(client, /action: 'status' \| 'send'/);
  assert.match(client, /getVerificationEmailState/);
  assert.match(client, /requestVerificationEmail/);
  assert.match(callable, /action === 'status'/);
  assert.match(callable, /firstSend = !profileShowsEmailHistory/);
  assert.match(callable, /outcome: 'cooldown'/);
  assert.match(callable, /cooldownSecondsRemaining/);
  assert.match(callable, /nextAllowedAtMillis/);
  assert.match(source, /const VERIFICATION_COOLDOWN_SECONDS = 120/);
  assert.match(callable, /firstSend \? 'welcome-verification' : 'verification-resend'/);
});

test('Training Camp explains why six games are fair without adding another lesson', async () => {
  const [data, template] = await Promise.all([
    read('src/app/features/onboarding/training-camp/training-camp.data.ts'),
    read('src/app/features/onboarding/training-camp/training-camp.html'),
  ]);

  assert.match(data, /NHL teams play uneven schedules/);
  assert.match(data, /reduce schedule luck/);
  assert.match(data, /both managers’ chances more even/);
  assert.match(data, /instead of changing a lineup every day/);
  assert.match(data, /Games and points already earned stay protected/);
  assert.match(template, /Why RinkRat uses six games/);
  assert.match(template, /whyItMatters/);
});

test('desktop and mobile global navigation expose cleanup-aware sign out', async () => {
  const [source, template] = await Promise.all([
    read('src/app/shared/navbar/navbar.ts'),
    read('src/app/shared/navbar/navbar.html'),
  ]);

  assert.match(source, /logoutUser/);
  assert.match(source, /await logoutUser\(\)/);
  assert.match(source, /navigate\(\['\/'\], \{ replaceUrl: true \}\)/);
  assert.match(source, /signingOut = signal\(false\)/);
  assert.equal((template.match(/\(click\)="signOut\(\)"/g) ?? []).length, 2);
  assert.match(template, /mobile-logout-button/);
  assert.match(template, /Signing out\.\.\./);
});

test('one listener-free league navigation component is present on every destination it names', async () => {
  const [component, template, ...pages] = await Promise.all([
    read('src/app/shared/league-quick-navigation/league-quick-navigation.ts'),
    read('src/app/shared/league-quick-navigation/league-quick-navigation.html'),
    read('src/app/features/leagues/league-detail/league-detail.html'),
    read('src/app/features/free-agents/free-agents.html'),
    read('src/app/features/team/team-settings/team-settings.html'),
    read('src/app/features/cycles/cycle-one/components/cycle-page-header/cycle-page-header.html'),
    read('src/app/features/cycles/matchup-overview/cycle-matchup-overview.html'),
    read('src/app/features/cycles/schedule-preview/cycle-schedule-preview.html'),
    read('src/app/features/leagues/league-standings/league-standings.html'),
  ]);

  assert.match(component, /LeagueNavigationDestination/);
  assert.match(component, /currentDestination/);
  assert.doesNotMatch(component, /Firestore|listenTo|onSnapshot/);
  for (const label of [
    'League HQ',
    'Add / Drop Player',
    'My Team',
    'Current Matchup',
    'All Current Matchups',
    'Full Schedule',
    'League Standings',
  ]) {
    assert.match(template, new RegExp(label.replace('/', '\\/')));
  }
  assert.equal(pages.filter((page) => page.includes('<app-league-quick-navigation')).length, 7);
});

test('Release Readiness now tests the manual first-send path', async () => {
  const validation = await read('src/app/core/release/invite-beta-validation.util.ts');

  assert.match(validation, /press Send verification email/);
  assert.match(validation, /No verification email arrives[^;]*before the manager presses Send verification email/);
  assert.doesNotMatch(validation, /Finish Later & Verify|newly released verification email/);
});

test('B1K changes no protected scoring, projection formula, or Firestore Rules', async () => {
  assert.equal(await sha256('src/app/core/scoring/scoring-rules.ts'), PROTECTED_SOURCE_HASHES.scoringRules);
  assert.equal(await sha256('src/app/core/scoring/scoring-engine.ts'), PROTECTED_SOURCE_HASHES.scoringEngine);
  assert.equal(await sha256('src/app/core/projection/projection-v11.util.ts'), PROTECTED_SOURCE_HASHES.projectionV11);
  assert.equal(await sha256('firestore.rules'), PROTECTED_SOURCE_HASHES.firestoreRules);
});

test('the B1K candidate is documented and exposes one inherited verification gate', async () => {
  const [packageSource, rootRoadmap, docsRoadmap, releaseNotes, runtime] = await Promise.all([
    read('package.json'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/releases/RC66_B1K_PLAYTEST_FLOW_USABILITY_CANDIDATE.md'),
    read('src/environments/app-runtime.config.ts'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.equal(rootRoadmap, docsRoadmap);
  assert.match(rootRoadmap, /B1\.43 Complete the observed-playtest flow correction/);
  assert.match(rootRoadmap, /LOG\.84 2026-08-25/);
  assert.match(releaseNotes, /has not been deployed, frozen, tagged, or promoted/i);
  assert.match(packageJson.scripts['verify:batchb1k:core'], /verify:batchb1j:core/);
  assert.match(packageJson.scripts['verify:batchb1k'], /toolchain:verify/);
  assert.match(runtime, /Release Candidate 65/);
});
