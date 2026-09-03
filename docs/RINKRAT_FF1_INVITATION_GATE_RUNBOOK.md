# RinkRat FF1 Invitation Gate Runbook

**Season candidate:** Release Candidate 65
**Production Hosting source:** `1754f80736e9abef46b08cccef7142c021cdf3a8`
**Protected contracts:** Production Scoring V4 / Projection V11
**Scope:** disposable pre-Draft invitation and removal evidence only

## Decision boundary

This gate answers one question: may RinkRat send real family-and-friends
invitations without risking duplicate membership, lost continuation, an
unrecoverable account choice, or a destructive pre-Draft removal?

Passing this gate authorizes invitations only. It does not authorize a real
Draft. The separate FF1 Draft gate still requires the exact-build lifecycle,
physical-device Draft rehearsal, D1M detect-only release, D1N reconnect and
100/500 evidence, D1J freeze/tag/rollback record, and formal go/no decision.

Codex may review source, run local/emulator checks, inspect read-only Production
evidence, and evaluate privacy-limited diagnostics. Stephen performs all
Production account, league, membership, and commissioner actions manually.

## Fixed safety rules

- Use only disposable identities controlled by Stephen. Do not use a family or
  friend account as a test subject.
- Use a new disposable league for each terminal state that cannot be safely
  reversed, especially Draft lock.
- Do not schedule or open a Draft in the reusable invitation/removal league.
- Never edit Production documents directly in Firestore.
- Never share an invite code, email address, account ID, league ID, team ID, or
  raw Firestore document in the evidence record.
- Label evidence with bounded aliases such as `league-a`, `new-complete`, and
  `existing-verified`.
- Stop on the first P0/P1 result. Preserve the affected account, league, browser
  state, diagnostics, and timestamp before retrying or cleaning up.
- Cleanup uses only ordinary supported UI or server-authoritative operations.
  Do not repair a failed test by editing Firestore.

## Entry gate

Record these values before the first test:

```text
Production Hosting source: 1754f80736e9abef46b08cccef7142c021cdf3a8
Repository review source: <current clean main revision>
Repository delta from live source: none or documentation/tests only
Repository status: clean
Repository divergence from origin/main: 0/0
Live release: Release Candidate 65
Scoring: V4
Projection: V11
Production domain: rinkratfantasy.com
Invite-beta preflight: passed
```

This runbook may be merged without deploying Hosting, so current `main` may be
ahead of the live source by documentation/test-only commits. In that case,
record both revisions and verify the boundary before testing:

```bash
git diff --name-only 1754f80736e9abef46b08cccef7142c021cdf3a8...HEAD
```

Only documentation and test paths may appear. Stop if runtime, package,
configuration, Firebase, deployment-input, or generated application source
appears. Do not deploy a documentation-only commit merely to make the live and
repository hashes match.

Required automated evidence:

- atomic secure join and retry identity;
- invite link activation, privacy, account binding, and manual-code fallback;
- Training Camp completion and Finish Later continuation;
- email-verification sequencing and manual resend;
- commissioner pre-Draft removal, duplicate delivery, invite-capacity repair,
  immutable audit, and Draft-history fail-closed behavior.

## Disposable identities and leagues

Prepare email inboxes Stephen controls for these aliases:

| Alias | Starting condition | Purpose |
| --- | --- | --- |
| `commissioner-a` | existing verified | reusable invitation/removal league |
| `existing-verified` | existing verified | signed-in and signed-out continuation |
| `new-complete` | no RinkRat account | full Training Camp path |
| `new-defer` | no RinkRat account | Finish Later path |
| `account-a` | existing verified | account-binding source |
| `account-b` | existing verified | explicit account-choice recovery |
| `capacity-*` | disposable verified accounts | fill the bounded full-league fixture |

Create these disposable leagues through the normal RinkRat UI:

| Alias | Purpose | Required state |
| --- | --- | --- |
| `league-a` | normal join, replay, removal, and reinvite | pre-Draft; invite active |
| `league-full` | capacity rejection | exactly at configured capacity |
| `league-expired` | expired invitation rejection | invite expired through supported controls |
| `league-locked` | Draft-lock rejection | disposable Draft settings saved; no real Draft |

If the UI cannot create one of these states without starting competitive
history, mark that scenario blocked and stop. Do not manufacture it through the
Firebase Console.

## Evidence format

Record one row for every scenario:

| Field | Value |
| --- | --- |
| Scenario | stable ID below |
| Timestamp | UTC |
| Release | short source revision and build ID |
| Browser/device | product and major version; desktop/physical phone |
| Account alias | bounded alias only |
| League alias | bounded alias only |
| Expected | concise outcome |
| Actual | concise outcome |
| Result | PASS / FAIL / BLOCKED |
| Diagnostics | privacy-limited reference, only when needed |
| Cleanup | completed / intentionally retained |

Screenshots must exclude invite codes and personal email addresses. Copy Beta
Diagnostics is acceptable because the report excludes raw identifiers and
documents.

## Matrix A — invitation continuation and exactly-once join

### INV-01 Existing verified account, signed in

1. Sign in as `existing-verified`.
2. Open `league-a`'s canonical invite link.
3. Press **Join League** once.
4. Confirm exactly one membership, team, and roster appear.
5. Reload the league and confirm the same stable team remains.

Pass: one join, one stable team, no Training Camp or verification detour.

### INV-02 Existing verified account, signed out

1. Sign out, open the same link, and deliberately press **Join League**.
2. Sign in as `existing-verified`.
3. Confirm the invitation resumes and recognizes the existing membership.

Pass: no duplicate member/team/roster and no second capacity decrement.

### INV-03 New account completing Training Camp

1. Open the link signed out and press **Join League**.
2. Create `new-complete`.
3. Confirm no first verification email is released before an explicit Training
   Camp outcome.
4. Complete all Training Camp shifts and press **Finish Training Camp**.
5. Use the released verification flow, return to RinkRat, and confirm the
   pending invitation resumes automatically.

Pass: Training Camp completion remains authoritative, verification is required,
and exactly one league identity is created.

### INV-04 New account choosing Finish Later

Repeat INV-03 with `new-defer`, but press **Finish Later & Verify**.

Pass: the profile records a deferral rather than false completion, verification
is released, and the same pending invitation resumes exactly once.

### INV-05 Manual verification send and cooldown

On either new-account path, use the manager-facing manual verification control
after completion/deferral.

Pass: the first send is available only after Training Camp is resolved; a
repeated immediate send reports the cooldown truthfully without losing the
invitation.

### INV-06 Reload and reopen recovery

Reload once during Training Camp, once during verification, and reopen the same
invite link in another tab.

Pass: the bounded continuation survives, one account remains bound, and the
final secure join remains exactly once.

### INV-07 Duplicate delivery and already-member replay

After a successful join, press the same link again and repeat the deliberate
join action. Repeat once from another tab.

Pass: RinkRat opens the existing league and creates no duplicate membership,
team, roster, count change, or audit outcome.

### INV-08 Explicit account choice

1. Start a pending invitation as `account-a`.
2. Sign in as `account-b` before completion.
3. Confirm RinkRat stops at the account-choice screen.
4. Exercise **Use Another Account**, then finish with the intended account.

Pass: there is no silent rebind or join by the unintended account.

### INV-09 Manual six-character code fallback

Cancel the pending link continuation and join through the manual Join League
screen with the same disposable invitation.

Pass: the fallback reaches the same secure transaction and preserves
idempotency.

## Matrix B — terminal and retry states

### INV-10 Temporary interruption

Use browser offline mode only after the pending intent exists, attempt the next
step, return online, and retry.

Pass: the UI reports uncertainty/retry honestly, preserves the pending intent,
and eventually creates exactly one membership.

### INV-11 Full league

Attempt to join `league-full` with a non-member.

Pass: the server rejects the join; member/team/roster/count state is unchanged.

### INV-12 Expired or inactive invitation

Attempt to join `league-expired`.

Pass: the server rejects the join, explains the terminal state, and clears the
terminal local intent without revealing league data publicly.

### INV-13 Draft-locked league

Attempt to join `league-locked` after its Draft settings are saved.

Pass: the server rejects the join and the frozen team set remains unchanged.

### INV-14 Invalid invitation shape

Open a deliberately invalid local test URL that contains no real invite code.

Pass: the scanner-safe public route performs no unauthenticated league or invite
read and asks for a valid six-character invitation.

## Matrix C — commissioner removal and reinvite

### INV-15 Pre-Draft removal

1. In `league-a`, select a disposable joined manager.
2. Complete fresh authentication/password confirmation and type the exact team
   confirmation required by the UI.
3. Remove the manager once.

Pass:

- member, team, and current roster are removed together;
- league and account lifecycle counts decrement once;
- invite capacity is repaired without reactivating expired authority;
- one immutable commissioner audit and one League Wire activity exist;
- the commissioner and all other teams remain unchanged.

### INV-16 Removal replay safety

Reload after INV-15 and verify the removed manager remains absent. Do not create
a new destructive request solely to simulate transport duplication.

Pass: the completed state is stable and counts/audit activity do not duplicate.

### INV-17 Reinvite recovery

Send `league-a`'s still-valid invitation to the removed disposable account and
join again.

Pass: the account receives one new pre-Draft membership/team/roster, capacity
returns to the correct value, and no old roster or competitive history is
restored.

### INV-18 Removal blocked after Draft history

On `league-locked`, inspect the commissioner removal surface without attempting
to bypass it.

Pass: removal is unavailable or server-rejected before any partial deletion.
Do not extend this test into post-Draft account transfer; FF1.12 owns that
separate product decision.

## Matrix D — physical browsers

Run at minimum:

- INV-01, INV-06, INV-07, and INV-10 on desktop Chrome or Safari;
- INV-03 or INV-04 plus INV-06 on physical iPhone Safari;
- the other new-account path plus INV-08 on physical Android Chrome;
- INV-15 and INV-17 on a desktop commissioner session.

At 320, 390, and 430 CSS-pixel widths confirm:

- Join, verification, Finish Training Camp, Finish Later, account-choice, and
  retry controls are visible and keyboard/touch reachable;
- no invite code or account identifier appears in telemetry/diagnostics;
- no blocking modal is clipped at 200% zoom;
- loading, offline, failure, cooldown, terminal, and success states remain
  legible.

## Stop conditions and severity

P0 — block invitations immediately:

- unauthorized, unverified, full, expired, inactive, or Draft-locked join
  succeeds;
- duplicate membership, team, roster, or lifecycle count;
- removal changes another team or any competitive history;
- account binding silently joins the wrong account;
- a normal release would require reinviting managers or recreating a league.

P1 — fix before invitations:

- continuation is lost after supported reload/reopen;
- completion and deferral are conflated;
- retry state encourages a second uncertain write;
- supported physical browser cannot finish onboarding;
- terminal error has no safe recovery or leaks private league information.

P2 — record for later if the workflow remains safe and understandable:

- cosmetic spacing, copy, or non-blocking performance issue.

## Exit decision

Real invitations may be authorized only when:

- INV-01 through INV-18 are PASS or an explicitly inapplicable case is approved
  with written evidence;
- no P0/P1 finding remains;
- the live manifest still identifies `1754f80736e9abef46b08cccef7142c021cdf3a8`;
- Production remains Scoring V4 and Projection V11;
- the invitation approval is recorded separately from Draft approval.

If the live source changes during the matrix, stop and repeat affected cases on
the new exact build. Do not carry exact-build evidence across a Hosting release.

## Cleanup and rollback

After evidence review, retain terminal-state leagues until the decision is
recorded. Then use supported account/league cleanup flows during a quiet window.
Do not delete audit evidence manually.

This runbook changes no runtime. If it is wrong, revert its documentation
commit. If a Production test exposes a runtime defect, stop invitations,
preserve the disposable fixture and diagnostics, and roll Hosting back to the
preceding verified release only when the defect is caused by the current
browser release. Function rollback requires a separately identified changed
Function revision; never use a broad Firebase deployment.
