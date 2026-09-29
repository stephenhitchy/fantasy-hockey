# RinkRat Product B1V — Invitation Onboarding Repair

## Scope

This batch repairs the existing email/password invitation journey without
changing authentication providers, the secure league-join authority, or
Training Camp lessons.

Target journey:

`Invite → Join → sign in/create → verify if needed → secure join → league`

## Confirmed root causes

1. The invitation coordinator treated Training Camp completion or explicit
   deferral as its first prerequisite. Unresolved profiles were redirected to
   `/training-camp` before they could verify or join.
2. Registration always navigated new managers to Training Camp and did not
   request the first verification email.
3. `resendVerificationEmail` returned an ineligible/blocked state until the
   profile recorded Training Camp completion or deferral.
4. Profile triggers wrote `waiting-for-training-camp` and only exposed manual
   verification sending after that tutorial decision.
5. Account Settings repeated the same tutorial-dependent eligibility and copy.

Route guards themselves only required an authenticated Firebase user; they did
not contain an additional tutorial gate.

## Implemented behavior

- A successful email/password registration makes one request to the existing
  `resendVerificationEmail` callable. When an invite is pending, its validated
  six-character code is included so the email returns to that invitation.
- A send error is isolated from account creation. The account remains signed in
  and the manager can resend without registering again.
- The existing 120-second server rate limit and the stable
  `welcome-verification-{uid}` provider idempotency key remain authoritative.
- Profile-created/profile-written functions retain their deployed names for a
  no-delete rollout. They only reconcile a `ready-for-manual-send` state and do
  not send verification email.
- Invitation continuation now depends only on authoritative Firebase email
  verification before calling `joinLeagueSecure`.
- Verification return-to-tab handling reloads the Firebase user and refreshes
  the ID token before re-entering the join coordinator.
- Old schema-v1 pending intents still load even if their legacy
  `requiresTrainingCamp` field is true; that field is ignored.
- Legacy `/training-camp?continue=league-invite` tabs immediately return to the
  bound invitation. Training Camp no longer owns verification UI or sending.
- Training completion and explicit deferral records remain distinct and valid.
- Built-in invite-beta validation copy now tests the repaired journey.

## Deliberately deferred

The optional seven-day Training Camp promotional reminder was not added. It
would require new preference state and UI that are not necessary to make the
core invitation journey reliable in the two-day repair window. Training Camp
remains available voluntarily through the existing app navigation and Account
Settings, and the existing completion badge remains based on legitimate
completion state.

## Email configuration required for real delivery

- Firebase project: `nhl-fantasy-app-ab673`
- Secret: `RESEND_API_KEY`
- Functions environment: a valid verified `EMAIL_FROM_ADDRESS`
- Functions environment: `APP_BASE_URL=https://rinkratfantasy.com`
- Firebase Auth authorized domain/action-code configuration must continue to
  allow the production RinkRat origin.

No new provider, secret, Firestore Rule, index, or production data migration is
required.

## Manual phone/email checklist

1. In a signed-out private mobile browser, open a real commissioner invite and
   press **Join League** once.
2. Create an ordinary non-admin account and confirm Training Camp never opens.
3. Confirm one verification email arrives at the displayed address and the
   resend button shows the real cooldown.
4. Open **Verify Email & Join League** in the same browser; confirm it opens the
   intended league with one membership/team.
5. Repeat with the email opening in another browser. Confirm RinkRat asks for
   the same account and then resumes the same league.
6. Test an existing verified account and an existing unverified account with no
   Training Camp decision.
7. Test **Use Another Account** and confirm the original pending intent is not
   silently applied to the wrong account.
8. Test full, expired/revoked, and post-cutoff invites; confirm the specific
   error appears and no membership is created.
9. Temporarily exercise a provider failure in staging and confirm the account
   survives and resend remains available.
10. Open Training Camp voluntarily, complete or defer it, and confirm neither
    action sends another verification email or changes league membership.

## Deployment and rollback

Deploy Functions before Hosting so the new client never depends on the old
tutorial-gated callable:

```bash
firebase deploy --project nhl-fantasy-app-ab673 \
  --only functions:resendVerificationEmail,functions:sendWelcomeEmailOnProfileCreated,functions:sendWelcomeEmailAfterTrainingCampResolved

firebase deploy --project nhl-fantasy-app-ab673 --only hosting:app
```

Rollback by checking out the prior clean release commit, running its inherited
verification/build gate, deploying the same three Functions first, and then
deploying `hosting:app`. No Rules, indexes, TTL, queue-mode, or data rollback is
part of this batch.

