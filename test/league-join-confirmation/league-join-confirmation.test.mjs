import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('manual-code and share-link joins announce only after server-confirmed membership', async () => {
  const [manualJoin, inviteJoin] = await Promise.all([
    read('src/app/features/leagues/join-league/join-league.ts'),
    read('src/app/features/leagues/invite-link/invite-link.ts'),
  ]);

  for (const source of [manualJoin, inviteJoin]) {
    const authorityIndex = source.indexOf('await joinLeagueByInviteCode(');
    const confirmationIndex = source.indexOf('this.joinConfirmation.confirm(leagueId);');
    const navigationIndex = source.indexOf("this.router.navigate(['/leagues', leagueId])");

    assert.ok(authorityIndex >= 0, 'The existing secure join must remain the authority.');
    assert.ok(confirmationIndex > authorityIndex, 'Confirmation must follow the secure join response.');
    assert.ok(navigationIndex > confirmationIndex, 'Confirmation must survive navigation into League HQ.');
  }
});

test('the confirmation is clear, persistent, dismissible, and useful after navigation failure', async () => {
  const [template, service, app] = await Promise.all([
    read('src/app/app.html'),
    read('src/app/core/league/league-join-confirmation.service.ts'),
    read('src/app/app.ts'),
  ]);
  const confirmationStart = template.indexOf('@if (joinConfirmation.current(); as confirmation)');
  const confirmationEnd = template.indexOf('<router-outlet', confirmationStart);
  const confirmationTemplate = template.slice(confirmationStart, confirmationEnd);

  assert.ok(confirmationStart >= 0 && confirmationEnd > confirmationStart);
  assert.match(confirmationTemplate, /role="status"[\s\S]*?aria-live="polite"[\s\S]*?aria-atomic="true"/);
  assert.match(confirmationTemplate, /Membership confirmed/);
  assert.match(confirmationTemplate, /You're in!/);
  assert.match(confirmationTemplate, /Your team is ready\. Welcome to the league\./);
  assert.match(confirmationTemplate, /Open League HQ/);
  assert.match(confirmationTemplate, /aria-label="Dismiss league join confirmation"/);
  assert.doesNotMatch(
    confirmationTemplate.match(/<a[\s\S]*?Open League HQ[\s\S]*?<\/a>/)?.[0] ?? '',
    /joinConfirmation\.dismiss/,
    'The recovery link must not discard confirmation before navigation succeeds.',
  );
  assert.match(service, /readonly current = this\.confirmation\.asReadonly\(\)/);
  assert.doesNotMatch(service, /localStorage|sessionStorage|Firestore|telemetry/i);
  assert.match(app, /if \(!user\) \{[\s\S]*?joinConfirmation\.dismiss\(\)/);
});

test('join confirmation motion is bounded and removed for reduced-motion users', async () => {
  const css = await read('src/app/app.css');

  assert.match(css, /\.league-join-confirmation-toast[\s\S]*?animation: league-join-toast-enter 220ms ease-out/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.league-join-confirmation-toast[\s\S]*?animation: none/);
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*?bottom: calc\(82px \+ env\(safe-area-inset-bottom\)\)/);
});
