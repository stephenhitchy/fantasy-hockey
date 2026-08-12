# RinkRat Security Batch S3F — Selected-Callable App Check Canary

**Runtime:** Release Candidate 24  
**Competitive models:** Production Scoring V3 · Projection V11  
**Default enforcement state:** Monitor  
**Firestore App Check enforcement:** Off

## Purpose

S3E proved that App Check enforcement must be based on exact-build evidence rather than guesswork. S3F installs the guarded runtime control needed to test enforcement without redeploying after the evidence gate passes.

The canary is intentionally two-dimensional:

1. An exact set of callable Functions.
2. An exact set of league IDs.

A request is rejected only when both dimensions match and the request does not contain the approved verified App Check application context. Every other league and callable remains in monitor mode.

## Candidate callables

The first canary surface is restricted to:

1. `requestProjectionSnapshotGeneration`
2. `advanceHistoricalReplayDay`
3. `makeSecureDraftPick`
4. `applyImmediateRosterMove`
5. `executeSecureRosterAction`

Begin with recoverable server work before adding live Draft or roster actions.

## Activation gates

Starting or changing a canary requires all of the following:

- Platform-administrator access.
- Verified email and a recently authenticated administrator session.
- A valid App Check token on the administrator browser.
- A reason of at least eight characters.
- At least one exact callable.
- At least one exact league and no more than five.
- Every selected league must already be marked **Internal Test** in the Scoring Queue Control Center.
- A passing exact-build S3E readiness result.
- A server-owned audit entry.

The server recalculates readiness from production evidence. It does not trust the browser's displayed gate state.

## Emergency rollback

Returning to monitor mode requires recent administrator authentication but deliberately does not require App Check. This preserves a recovery path when App Check itself is the suspected failure.

From Admin Center:

```text
Live Evidence
→ Exact-league App Check canary
→ Record rollback reason
→ Return Everything to Monitor
```

The control cache is bounded to five seconds, so warm Function instances converge quickly after a change.

## Health evidence

For canary-selected requests, RinkRat records privacy-limited token-gate totals:

- Allowed verified calls.
- Blocked missing or mismatched calls.
- Totals by callable.
- Latest event timestamps.
- A short one-way league reference.
- The control revision and approved build.

An allowed count proves the request carried the approved App Check context; the separate Beta Operations action outcome still determines whether the competitive operation succeeded.

The health record excludes raw manager IDs, player IDs, roster contents, fantasy scores, invite codes, and raw league IDs.

## Recommended rollout

### Stage 0 — Monitor

- Deploy RC24.
- Leave mode `monitor`.
- Collect the full exact-build browser, device, platform, manager-day, and action matrix.
- Confirm 99% or better verification and every sample minimum.

### Stage 1 — Recoverable callable

Use one disposable league already marked **Internal Test** and select:

```text
requestProjectionSnapshotGeneration
```

Complete at least three successful verified requests and confirm zero unexpected blocked requests.

### Stage 2 — Administrative replay

Add:

```text
advanceHistoricalReplayDay
```

Use only a historical test league. Confirm preserved retry behavior and zero permanent UI locks.

### Stage 3 — Draft

Add:

```text
makeSecureDraftPick
```

Use a disposable Draft. Test desktop Chrome, desktop Safari, Mobile Safari, and Android Chrome before expanding.

### Stage 4 — Roster authority

Add:

```text
applyImmediateRosterMove
executeSecureRosterAction
```

Test immediate and scheduled add/drop, waiver, lineup swap, and Injured Reserve paths.

### Stage 5 — Later all-user enforcement

Do not expand beyond exact canary leagues in S3F. A later release must review canary proof, supported-browser results, support burden, and rollback behavior before selected-callable enforcement is considered for every league.

## Safety properties

S3F never:

- Automatically starts a canary.
- Automatically expands a canary.
- Enables Firestore App Check enforcement.
- Enables `enforceAppCheck: true` globally.
- Changes Production Scoring V3.
- Changes Projection V11.
- Changes the scoring queue from Shadow.
- Accepts any league that is not explicitly marked Internal Test.
- Routes friend leagues into the canary automatically.

## Deployment

Deploy Functions first:

```bash
firebase use nhl-fantasy-app-ab673

firebase deploy --only functions \
  -m "Security S3F exact-league App Check canary control"
```

Then deploy Hosting:

```bash
firebase deploy --only hosting:app \
  -m "Security S3F Release Candidate 24"
```

No Firestore Rules, index, TTL, or backup change is required.

## Post-deployment verification

1. Open Admin Center → Live Evidence.
2. Confirm the control says Monitor.
3. Confirm no callable or league is selected unexpectedly.
4. Confirm the exact-build evidence counter begins for RC24.
5. Confirm the Start button remains locked until every readiness blocker passes.
6. After the gate passes, mark one disposable league Internal Test, then choose that league and projection generation only.
7. Enter a reason and start the canary.
8. Complete three verified projection requests.
9. Confirm allowed count increases and blocked count remains zero.
10. Test an intentionally unverified browser only when prepared to observe a safe rejection.
11. Return to Monitor and confirm selected requests stop being rejected within the bounded cache interval.
12. Confirm friend leagues never changed behavior.
