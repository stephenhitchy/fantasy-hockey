# RinkRat Beta Batch B1E — Shareable Invite-Link Onboarding

**Runtime release:** Release Candidate 60  
**Date:** 2026-08-21  
**Priority:** P0 before the first observed invite-beta cohort

## Outcome

B1E adds canonical commissioner-shareable league links in this form:

```text
https://rinkratfantasy.com/join/AB7K9Q
```

The link reuses the existing six-character invite-code contract and the existing server-authoritative `joinLeagueSecure` transaction. It does not add a second membership authority or permit browser writes to league membership documents.

## Scanner-safe activation

Opening an invitation URL is read-only. The public page validates only the six-character URL shape and does not read a league or invite document. A pending invitation is created only after the person deliberately presses **Join League**.

This prevents mail scanners, chat previews, crawlers, and accidental opens from creating membership. Firebase Hosting additionally serves `/join/**` with:

- `Cache-Control: no-store, private`
- `X-Robots-Tag: noindex, nofollow, noarchive`
- `Referrer-Policy: no-referrer`

`public/robots.txt` also disallows `/join/`.

## Continuation model

After the deliberate action, the browser stores one bounded local intent containing only:

- schema version;
- normalized invite code;
- request and expiration timestamps;
- optional bound Firebase account UID;
- whether the newly created account still requires Training Camp.

The intent expires after 72 hours. Corrupted, invalid, or expired values are discarded. The account binding prevents a silent switch to another signed-in account; the user must explicitly choose **Join With This Account** or **Use Another Account**.

The supported paths are:

| Starting state | Continuation |
| --- | --- |
| Signed in and verified | Confirm the account, call the existing secure join, then open the league. |
| Signed out with an existing account | Sign in, return to the invitation automatically, then join. |
| No account | Register, complete Training Camp, verify email, return automatically, then join. |
| Signed in but unverified | Send or reuse the verification email, refresh the Firebase user/token, then join. |
| Different account restored | Stop at an account-choice screen; never silently rebind. |
| Temporary callable/network failure | Preserve the pending intent and offer retry. |
| Expired/inactive/full/locked/missing invite | Show the server explanation and clear the terminal intent. |
| Already a member or lost prior response | Rely on the idempotent server transaction and open the existing league. |

The manual `/leagues/join` form remains available and now presents the correct six-character format.

## Existing authority preserved

The final join still goes through `joinLeagueByInviteCode()` and the deployed `joinLeagueSecure` callable. B1E preserves:

- verified-email enforcement;
- invite-code validation and expiration;
- active/locked/full league checks;
- account league quotas;
- transaction rate limits;
- request idempotency and replay recovery;
- atomic member, team, roster, league-count, invite-count, and audit writes;
- Firestore denial of direct client membership writes.

No unauthenticated league-name, commissioner, roster, member, or invite-document preview was added.

## Commissioner experience

League HQ now offers:

- **Copy Invite Link** as the primary action;
- **Copy Code** as the fallback.

The Commissioner Playbook also offers **Copy Invite Link**, and its complete invitation message contains both the canonical link and the six-character code.

## Privacy and diagnostics

Invite codes are normalized to `/join/:inviteCode` before they enter:

- browser route telemetry;
- beta route evidence;
- diagnostic text;
- CSP report paths.

B1E telemetry records only bounded state such as whether the person was signed in, whether continuation was used, and whether a failure was terminal. It does not send the invite code, email address, user ID, league ID, or league metadata in the new events.

## Deployment scope

RC60 requires:

```bash
firebase deploy --only functions,hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Beta B1E Invite-Link Onboarding Release Candidate 60"
```

The Functions deployment is required because B1E extends route/diagnostic redaction. The existing `joinLeagueSecure` authority is unchanged.

B1E changes no:

- Firestore Rule;
- Firestore index;
- TTL policy;
- data migration;
- Production Scoring V4 value;
- legacy V3 reconstruction;
- Projection V11 formula;
- six-game boundary or seventh-game rollover;
- App Check Monitor/canary mode;
- scoring-queue Shadow mode;
- shared NHL-cache Shadow mode.

## Verification

Use the pinned toolchain:

```bash
nvm use 22.23.1
npm install -g npm@11.17.0
npm ci
npm --prefix functions ci
npm run verify:batchb1e
```

The focused B1E source suite covers:

- canonical code and URL construction;
- 72-hour storage expiration;
- account binding and explicit switching;
- Training Camp ownership;
- public route placement;
- scanner-safe deliberate activation;
- auth, registration, Training Camp, and verification continuation;
- reuse of `joinLeagueSecure`;
- manual-code fallback;
- commissioner sharing;
- route/diagnostic redaction;
- Firestore read boundary;
- noindex/no-referrer/no-store Hosting controls;
- RC60 release-policy synchronization.

## Required deployed-browser matrix before freeze

Complete each path against the deployed RC60 build, not only a development server:

1. Existing verified account, already signed in.
2. Existing verified account, signed out.
3. Brand-new account through all five Training Camp shifts and email verification.
4. Existing unverified account.
5. Verification link opened in the same browser with the session restored.
6. Pending invite bound to a different account.
7. Already-member/idempotent replay.
8. Invalid, expired, inactive, full, and Draft-locked invitation responses.
9. Offline/timeout followed by retry.
10. Cancel invitation and manual-code fallback.
11. Desktop Chrome and Safari.
12. Mobile Safari on iPhone and Chrome on Android.

Do not freeze `rinkrat-rc60-invite-beta` or recruit the observed cohort until the exact verification command and this deployed-browser matrix pass.

## Source validation snapshot

This implementation review completed the following local evidence on 2026-08-21:

- focused B1E source suite: **13 passed, 0 failed**;
- all runnable repository source tests: **1,011 passed, 0 failed**;
- accessibility, mobile-readability, design-system, shared-UI, async-operation-safety, beginner-language, product-copy-density, invite-beta handoff, private-season-plan, source-preflight, and release-manifest audits: passed;
- JSON parsing, Node syntax checks, TypeScript syntax transpilation, roadmap-copy equality, and `git diff --check`: passed.

The exact `npm run verify:batchb1e` release gate is deliberately still open. This review host has Node 22.16.0 and npm 10.9.2 rather than the pinned Node 22.23.1 and npm 11.17.0, and the dependency/Functions-emulator installation is unavailable here. The two excluded repository files require the compiled `functions/lib/draft-pick-engine.js` output and the Firebase Rules test package/emulator. Run the pinned clean-install gate before deployment or freeze.
