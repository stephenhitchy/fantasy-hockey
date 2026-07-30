# RinkRat Batch 5 Test Checklist

## Scope

Batch 5 makes account profiles private, creates display-safe public manager profiles, and moves the shared ESPN injury report completely behind Cloud Function authority.

Do not deploy when any automated test or build fails.

## 1. Automated verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm ci
npm --prefix functions ci
npm run verify:batch5
```

Expected results:

- 44 Firestore rules tests pass
- 7 draft-authority tests pass
- 2 league-onboarding tests pass
- 4 competition-authority tests pass
- 7 profile/injury authority tests pass
- Angular production build completes
- Functions TypeScript build completes

There are 64 named tests in total.

## 2. Commit checkpoint

The Firebase hosting cache is generated and should not be committed.

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey

git restore .firebase/hosting.ZGlzdC9mYW50YXN5LWhvY2tleS9icm93c2Vy.cache 2>/dev/null || true
git status
git add .
git commit -m "Secure injury refreshes and split public manager profiles"
git push
git rev-parse --short HEAD
```

Save the displayed commit hash for rollback.

## 3. Safe deployment order

### Step A — Functions

```bash
firebase deploy --only functions:refreshGlobalPlayerAvailabilityScheduled,functions:refreshDailyPlayerAvailability,functions:getPublicManagerProfiles,functions:deleteMyAccount -m "Batch 5 injury and profile authority"
```

### Step B — Firestore rules

```bash
firebase deploy --only firestore:rules -m "Batch 5 profile privacy and injury authority rules"
```

### Step C — Hosting

```bash
firebase deploy --only hosting:app -m "Batch 5 private profiles and server injury refresh"
```

After hosting finishes, hard-refresh with **Command + Shift + R**, then sign out and sign back in once.

## 4. Existing-account profile test

Use an account created before Batch 5.

1. Sign in.
2. Confirm Dashboard, Account Settings, My Team, League HQ, and Game Center load.
3. In Firestore, open:

   ```text
   publicProfiles/{yourUid}
   ```

4. Confirm the document exists after login or after opening Game Center.
5. Confirm it contains only:

   ```text
   uid
   username
   favoriteTeamAbbreviation
   favoriteTeamVariantId
   updatedAt
   ```

6. Confirm it does **not** contain email, injuryEmailEnabled, reducedMotion, backgroundTheme, unlocks, or onboarding fields.

Expected: existing accounts work normally and receive a safe public-profile copy without a manual migration.

## 5. Account-settings synchronization test

1. Change the account username.
2. Change the favorite NHL team or logo variant.
3. Save Account Settings.
4. Confirm the page reports success and reloads with the new values.
5. In Firestore, confirm:
   - `users/{uid}` contains the complete private settings.
   - `publicProfiles/{uid}` contains the new username and favorite-team fields only.
6. Change a private-only preference such as reduced motion, background theme, or injury email.
7. Confirm that private preference changes under `users/{uid}` but does not appear in `publicProfiles/{uid}`.

Expected: public and private display identity remains synchronized while private preferences stay private.

## 6. Opponent identity and theme test

Use a league with at least two managers, preferably one containing an older account.

1. Sign in as Manager A and open Game Center.
2. Confirm Manager B's username, favorite-team colors, and logo styling appear normally.
3. Sign in as Manager B and repeat against Manager A.
4. Check the browser console for red errors or `permission-denied` messages.
5. Confirm a missing legacy `publicProfiles/{opponentUid}` document is automatically created after Game Center loads.

Expected: matchup identity works without either browser reading the opponent's private `/users` document.

## 7. Shared injury refresh test — commissioner

1. Sign in as a league commissioner.
2. Open the injury-management or commissioner injury area.
3. Run the normal refresh action.
4. Confirm the page shows either:
   - a successful refreshed report,
   - an already-current message,
   - or a clear in-progress/cooldown message.
5. Confirm no browser `permission-denied` error occurs.
6. Inspect:

   ```text
   appData/playerAvailability
   ```

7. Confirm:
   - `updatedBy` is a server label, not your Firebase UID.
   - `refreshLeagueId` is absent.
   - `status`, timestamps, counts, message, and records look valid.
   - the prior report remains available if ESPN returns an error or suspiciously sparse feed.

Expected: the commissioner requests the action, but only the server writes the shared report.

## 8. Shared injury refresh test — ordinary manager

1. Sign in as an ordinary league manager.
2. Open the league and draft/game pages that normally trigger the daily injury check.
3. Confirm those pages load without errors.
4. Confirm the shared injury report remains readable.
5. Confirm commissioner-only force-refresh controls are not available.

Expected: normal daily/draft checks remain functional, but an ordinary manager cannot force a refresh.

## 9. Manual override regression test

This test concerns league-specific commissioner overrides, not the shared ESPN report.

1. As commissioner, set one disposable player's manual availability override.
2. Confirm the override appears where expected and IR eligibility behaves correctly.
3. As an ordinary manager, confirm the same override cannot be edited.
4. Remove the disposable override afterward.

Expected: commissioner overrides still work and remain separate from the global server report.

## 10. New-account registration test

Use a disposable email/account.

1. Register a new account.
2. Confirm registration completes and the account can sign in.
3. Confirm both documents exist:

   ```text
   users/{newUid}
   publicProfiles/{newUid}
   ```

4. Confirm the private document contains email and account preferences.
5. Confirm the public document contains only the five safe fields.
6. Create or join a disposable league and confirm normal onboarding works.

Expected: public-profile creation cannot prevent the private account from being created. A transient public-profile failure is repaired after login.

## 11. Account deletion test

Use only the disposable account from the prior test.

1. Delete the account through the normal account-deletion workflow.
2. Confirm authentication is removed.
3. Confirm `users/{uid}` is gone.
4. Confirm `publicProfiles/{uid}` is gone.

Expected: account deletion does not leave a public-profile record behind.

## 12. Privacy verification

The Firebase Console uses administrator credentials and bypasses security rules, so it cannot prove browser privacy.

The emulator suite already verifies that:

- a signed-in user cannot read another user's private `/users/{uid}` document;
- signed-out users cannot read private or public profiles;
- clients cannot list either profile collection;
- a public profile cannot contain email or other private fields;
- commissioners cannot write the shared global injury report directly.

During browser testing, the practical signal is that normal pages load without private-profile `permission-denied` errors.

## Stop conditions

Stop deployment or roll back if any of these occur:

- Existing accounts cannot load their own profile.
- Account Settings fails to save.
- Game Center loses opponent names or favorite-team styling.
- New account registration fails.
- Injury refresh produces repeated permission errors.
- The shared report becomes empty after a sparse or failed ESPN response.
- A public profile contains email or private preferences.
- Manual commissioner overrides stop working.

## Rollback

Use the commit hash saved before deployment.

```bash
git revert <batch-5-commit-hash>
git push
npm run build:all
firebase deploy --only functions:refreshGlobalPlayerAvailabilityScheduled,functions:refreshDailyPlayerAvailability,functions:getPublicManagerProfiles,functions:deleteMyAccount,firestore:rules,hosting:app -m "Rollback Batch 5"
```

If `getPublicManagerProfiles` did not exist before Batch 5, Firebase may retain the unused Function after a code rollback. It is harmless, or it can be deleted explicitly after the site is stable.
