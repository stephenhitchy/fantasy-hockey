# RinkRat Beta Batch B1G — Training-First Email Verification

**Runtime release:** Release Candidate 62
**Competition baseline:** Production Scoring V4 / Projection V11
**Deployment scope:** Firestore Rules, Functions, and Hosting

## Why this batch exists

A new manager could previously receive and open the account verification email before finishing Training Camp. Although RC61 reconciled the saved profile after every return, real playtesting confirmed that the email-first order could still interrupt the saved league-invitation continuation.

RC62 removes that order entirely for newly created accounts. The first verification email is withheld until the manager makes one explicit Training Camp decision:

1. **Finish Training Camp**, which records the canonical completion version; or
2. **Finish Later & Verify**, which records a separate deferral version without claiming the tutorial was completed.

Both outcomes release email verification and allow an invite-based registration to return to the same saved invitation.

## Authoritative state

Private manager profiles now distinguish these fields:

```text
trainingCampVersion
trainingCampCompletedAt
trainingCampDeferredVersion
trainingCampDeferredAt
```

`trainingCampVersion` remains the only signal that the tutorial was completed. `trainingCampDeferredVersion` means the manager deliberately exited and chose to continue onboarding. The browser and Functions use **completed OR deferred** only for deciding whether the first account email may be released.

Firestore Rules permit the signed-in manager to update only the existing approved preference fields plus the two new deferral fields. Email-delivery status remains server-owned.

## Email sequencing

The profile-created trigger no longer immediately sends the first welcome/verification email. It records a waiting status while Training Camp is unresolved. A retryable profile-write trigger releases the first account email after either completion or deferral appears in the current saved profile.

The resend callable applies the same gate:

- before completion/deferral, the first verification request is rejected with a plain-language prerequisite message;
- after completion/deferral, it can safely send the first verification email as a fallback;
- later resend requests keep the existing cooldown;
- provider idempotency keys protect retry and trigger races;
- an account already verified through an older path receives a normal welcome message and continues.

The profile-created trigger re-reads the current Firestore document before writing a waiting status. This prevents a delayed creation event from overwriting a manager who completed or deferred Training Camp very quickly.

## Invite continuation

The `/join/:inviteCode` coordinator now reads `hasResolvedTrainingCampOnboarding(profile)` rather than completion alone.

| Saved Training Camp state | Firebase email | Next action |
|---|---|---|
| Neither completed nor deferred | Unverified or verified legacy account | Open Training Camp |
| Completed | Unverified | Show the released-email verification step |
| Deferred | Unverified | Show the released-email verification step |
| Completed or deferred | Verified | Call the existing secure join transaction |

Final league membership still runs through:

```text
joinLeagueByInviteCode() → joinLeagueSecure
```

The verified-email requirement, invite expiration, active status, capacity, Draft lock, account quotas, rate limits, idempotency, atomic writes, and Firestore denial of direct membership writes are unchanged.

## Manager experience

### Complete Training Camp

After the fifth shift, **Finish Training Camp** saves completion. For an invitation, RinkRat returns to the invitation, waits for verification, and joins after the manager comes back from the email link. For ordinary registration, RinkRat shows the verification prompt directly.

### Exit Training Camp

The top action for a new manager is now **Finish Later & Verify**. It saves an explicit deferral, releases the verification email, and follows the same invitation continuation. It does not mark Training Camp complete, so the manager can return to learn the tutorial later.

Closing a browser tab without pressing the exit action is intentionally not treated as consent to defer Training Camp. Browser-unload writes are unreliable and could send account email after an accidental close. The explicit exit control is the supported close-out path.

## Backward recovery

Accounts that already verified before RC62 are not trapped. Once they complete or defer Training Camp, the invitation reconciler sees the verified Firebase state and proceeds directly to the secure join. Existing accounts with prior email history retain normal resend behavior.

## Exact verification

Use the pinned project toolchain:

```bash
nvm install 22.23.1
nvm use 22.23.1
npm install -g npm@11.17.0
npm ci
npm --prefix functions ci
npm run verify:batchb1g
```

The B1G gate inherits the complete B1F chain and additionally checks:

- no first verification email before completion or explicit deferral;
- completion and deferral remain separate saved states;
- both outcomes release the retryable email trigger;
- the resend callable enforces the same prerequisite;
- invite continuation uses the resolved state;
- the verification prompt and resend fallback remain available;
- current Rules allow only the intended private profile fields;
- schema-v4 Release Readiness evidence includes complete and finish-later flows;
- RC62/B1G runtime, freeze, CI, and release identity;
- Production Scoring V4 and Projection V11 remain unchanged.

## Deployment

After the exact gate passes:

```bash
firebase deploy --only firestore:rules,functions,hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Beta B1G Training-First Verification Release Candidate 62"
```

Deploy the three changed surfaces together. Do not deploy indexes or TTL policies for this batch.

## Required browser matrix

Before freezing the invite-beta baseline, verify:

1. New invite account: no email while remaining inside Training Camp.
2. New invite account: finish all five shifts, receive email, verify, and join exactly once.
3. New invite account: choose **Finish Later & Verify**, receive email, verify, and join exactly once.
4. Reload and reopen the invitation during both paths.
5. Verify in another tab, return to the original tab, and continue.
6. Use **Use Another Account** and confirm no silent account switch.
7. Repeat the same invitation and confirm idempotent membership.
8. Confirm an older already-verified account can resolve Training Camp and join.
9. Confirm the manual six-character invite code remains available.
10. Repeat the main paths on Chrome, Safari, iPhone Safari, and Android Chrome.

## Protected baseline

B1G changes no scoring formula, projection calculation, immutable six-game window, seventh-game rollover, Draft authority, roster authority, waiver authority, Firestore index, TTL policy, App Check Monitor setting, scoring-queue Shadow setting, or shared NHL-cache Shadow setting.
