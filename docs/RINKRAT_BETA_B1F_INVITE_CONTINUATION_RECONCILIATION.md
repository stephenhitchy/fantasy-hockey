# RinkRat Beta Batch B1F — Invite Continuation Reconciliation

**Runtime release:** Release Candidate 61  
**Date:** 2026-08-21  
**Priority:** P0 hardening before the first observed invite-beta cohort  
**Deployment scope:** Hosting only

## Why this batch exists

A first new-account playtest appeared not to complete league membership, while a second attempt through the same share-link experience worked normally. The first outcome has not been reproduced and is not classified as a confirmed production defect. The observation did reveal one fragile assumption in RC60: the invitation page used the browser's stored `requiresTrainingCamp` flag to decide whether it needed to read the manager profile before joining.

That flag is useful continuation metadata, but browser storage is not the authority for onboarding completion. It can be reset, restored from an older tab, or become stale after the person verifies email and returns through a different route. RC61 therefore treats the saved manager profile as authoritative on every invitation resume.

## Deterministic prerequisite reconciler

Every resumed invitation now reads the signed-in manager profile, derives completion with the canonical `hasCompletedTrainingCamp()` check, refreshes Firebase email-verification state when necessary, and resolves one of three destinations:

| Saved Training Camp state | Current email state | Next action |
| --- | --- | --- |
| Incomplete | Unverified | Training Camp |
| Incomplete | Verified | Training Camp |
| Complete | Unverified | Email verification |
| Complete | Verified | Secure league join |

The browser `requiresTrainingCamp` value remains a bounded navigation hint. It can help the surrounding registration and Training Camp pages preserve context, but it can no longer permit a join or replace the profile check.

## Order-independent recovery

Both legitimate new-account orders now converge through the same reconciler:

### Training Camp first

1. Open the commissioner share link.
2. Press **Join League**.
3. Create the account.
4. Complete Training Camp.
5. Verify the email.
6. Return to either open RinkRat tab.
7. RinkRat reloads the account, confirms the saved Training Camp version, and calls the existing secure join.

### Email verification first

1. Open the commissioner share link.
2. Press **Join League**.
3. Create the account.
4. Open the verification email before Training Camp is complete.
5. Return to or reopen RinkRat.
6. RinkRat still reads the manager profile and requires Training Camp.
7. After Training Camp saves, RinkRat recognizes the already-verified email and calls the existing secure join.

A verification refresh no longer jumps directly to `joinLeagueByInviteCode()`. It re-enters the full prerequisite reconciler, which prevents verification from bypassing a missing or stale Training Camp state.

## Existing membership authority is unchanged

B1F changes continuation orchestration only. Final membership still goes through:

```text
joinLeagueByInviteCode() -> joinLeagueSecure
```

The deployed server continues to enforce:

- verified email;
- invitation identity, expiration, and active state;
- league capacity and Draft-entry lock;
- account league quotas and attempt limits;
- rate limiting and idempotency;
- atomic membership, team, roster, count, and audit writes;
- Firestore denial of direct browser membership writes.

Opening a link remains read-only. A person must deliberately press **Join League** before any pending intent is stored or any membership action can occur.

## Release Readiness evidence

The invite-beta validation schema advances from version 2 to version 3. Three required workflows are now explicit:

1. **Training Camp first** — complete Training Camp, then verify and resume.
2. **Verification first** — verify before Training Camp finishes, then complete Training Camp and resume.
3. **Reload and account-choice recovery** — reload during onboarding, reopen the same link, and exercise **Use Another Account** once.

The existing verified returning-account share-link test remains required. Together these checks cover repeated links, refreshes, account binding, idempotent membership, and the two new-account prerequisite orders.

The release-freeze parser also requires schema version 3, preventing an older validation report from being used for the RC61 freeze.

## Deployment scope

B1F assumes the required RC60 B1E diagnostic-redaction Functions are already live and leaves them unchanged. B1F changes Angular browser logic, release evidence, tests, and documentation only. Deploy RC61 Hosting without redeploying Functions:

```bash
firebase deploy --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Beta B1F Invite Continuation Reconciliation Release Candidate 61"
```

B1F changes no:

- Functions source or callable contract;
- Firestore Rule, index, or TTL policy;
- data migration or league document;
- Production Scoring V4 value or legacy V3 reconstruction;
- Projection V11 calculation;
- immutable six-game window or seventh-game rollover;
- App Check Monitor/canary mode;
- scoring-queue Shadow mode;
- shared NHL-cache Shadow mode.

## Exact verification

Use the repository's pinned release toolchain:

```bash
nvm use 22.23.1
npm install -g npm@11.17.0
npm ci
npm --prefix functions ci
npm run verify:batchb1f
```

The B1F gate inherits the complete B1E/O1I chain and additionally checks:

- all four Training Camp/email-verification combinations;
- profile-authoritative prerequisite resolution;
- verification refresh re-entry;
- manager-facing order-independence copy;
- validation-board schema and workflows;
- RC61/B1F runtime, freeze, CI, and release identity;
- preservation of Firestore Rules, Production Scoring V4, and Projection V11.

## Required deployed-browser matrix

Before freezing the invite-beta baseline, pass these paths against the deployed RC61 site:

1. New account: Training Camp first, verification second.
2. New account: verification first, Training Camp second.
3. Reload during Training Camp, then reopen the same invitation link.
4. Verification link opens the site in the same browser while Training Camp is incomplete.
5. Verification link opens another tab, then the original tab regains focus.
6. Explicit **Use Another Account**, followed by the intended account.
7. Existing verified account, signed in and signed out.
8. Repeated Join click, repeated link opening, and already-member recovery.
9. Temporary offline/callable failure followed by retry.
10. Desktop Chrome, desktop Safari, Mobile Safari on iPhone, and Chrome on Android.

Record the result in Release Readiness. Do not freeze `rinkrat-rc61-invite-beta` or recruit the observed cohort until the pinned gate and deployed matrix pass.

## Playtest interpretation

The original first-attempt result remains an observation, not a proven root cause. RC61 removes the most plausible client-state weakness without weakening the verified-email requirement or altering the secure backend. If another tester reproduces a failure, retain the invitation, note the exact step order and browser/tab behavior, and capture the privacy-limited Beta Diagnostics reference before retrying.
