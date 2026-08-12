# RinkRat Security Batch S3E.1

## Draft Scheduling and Injured Reserve Roster Preservation Hotfix

**Release family:** Release Candidate 23  
**Competitive models:** Scoring V3 · Projection V11  
**App Check:** monitor-only; no callable or Firestore enforcement  
**Scoring queue:** Shadow remains the production mode

## Purpose

S3E.1 corrects two production-beta blockers discovered during RC23 validation:

1. Draft Setup could wait for the complete Projection V11 ranking job before saving a scheduled start. The browser could reach its safety deadline even though the server was still doing healthy projection work.
2. Activating an Injured Reserve player into an occupied active slot could send the displaced starter directly to waivers, even when an open bench spot existed.

Neither issue changes Scoring V3 or Projection V11 mathematics.

## Draft scheduling contract

### Previous flow

```text
Choose draft time
→ build the entire Projection V11 snapshot
→ wait for every ranking asset
→ save the schedule
```

A normal projection build could outlive the browser's confirmation window. The Beta Operations evidence exposed the problem clearly: Draft Settings had repeated failures and a p95 near the old timeout ceiling.

### S3E.1 flow

```text
Choose draft time
→ acknowledge one server projection-preparation request
→ save the draft time
→ projection worker finishes in the background
→ scheduled automation opens only after the verified board is ready
```

The browser now:

- checks briefly for a fresh verified board;
- creates one exact idempotency-keyed preparation request when needed;
- waits only for the queue acknowledgement, not the full snapshot;
- sends that request ID with the draft settings;
- unlocks after the schedule is confirmed.

The Draft authority independently verifies either:

- a current server-generated, catalog-validated, hashed Projection V11 pointer; or
- a matching queued or processing Projection V11 request for this league and Draft target.

If the scheduled time arrives first, server automation leaves the Draft safely scheduled with `waiting-projection`. It retries automatically and never opens the room or Auto-Drafts from an unverified board.

## Injured Reserve activation contract

### Open active destination

When the selected active slot is open:

```text
IR player → active slot
No bench change
Nobody waived
```

### Occupied active destination with an open bench spot

RinkRat automatically proposes the open bench destination:

```text
IR player → active slot
Displaced starter → open bench slot
Nobody waived
```

### Occupied active destination with a full bench

The manager must explicitly choose the bench player or goalie unit to remove:

```text
IR player → active slot
Displaced starter → selected bench slot
Previous occupant of selected bench slot → waivers
```

The displaced starter is never silently discarded. Bench spots reserved by a scheduled lineup swap cannot be selected.

The browser and both server execution paths enforce the same contract:

- immediate untouched-window authority;
- secure started-window/ownership authority.

A stale older browser may omit the bench destination. The server safely uses an open non-reserved bench slot when one exists; when the bench is full, it rejects the request and requires an explicit choice.

## App Check evidence interpretation

The submitted RC23 evidence showed excellent request authenticity:

- 78 exact-build samples against a 50-sample threshold;
- 100% verified App Check traffic;
- Chrome, Safari, Mobile Safari, desktop, phone, and iOS coverage;
- verified Draft Pick, Add/Drop, Injured Reserve, and Lineup Swap actions.

The gate remains correctly blocked by operational evidence still missing:

- two additional UTC observation days;
- three additional privacy-limited manager-days;
- Android samples;
- waiver-claim samples.

Do not fabricate Android evidence. Complete it with a real Android browser when a friend is available. Because S3E.1 produces a new exact build ID, the exact-build counters begin again for the hotfix build. That reset is deliberate: a previous build must not authorize enforcement for changed code.

The two bugs found during this test are additional evidence that App Check enforcement should remain off until the corrected exact build completes the matrix.

## Verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey

nvm use 22.23.1
npm install -g npm@11.17.0

node --version
npm --version

npm ci
npm --prefix functions ci

npm run verify:batchs3e-1
```

Expected toolchain:

```text
Node v22.23.1
npm 11.17.0
```

## Deployment

Deploy Functions first because Draft authority, Draft automation, and both roster authorities changed:

```bash
firebase use nhl-fantasy-app-ab673

firebase deploy --only functions \
  -m "Security S3E.1 Draft schedule and IR roster preservation"
```

Then deploy Hosting:

```bash
firebase deploy --only hosting:app \
  -m "Security S3E.1 RC23 Draft and IR hotfix"
```

No Firestore Rules, indexes, TTL, backup, or migration deployment is required.

## Draft scheduling smoke test

1. Open Draft Setup in a disposable league.
2. Choose a future time and save.
3. Confirm the button unlocks after the schedule is acknowledged rather than after the complete ranking job.
4. Reload and confirm the saved time persists.
5. Confirm Draft Setup explains that Projection V11 may still be building in the background.
6. Inspect the Draft document and confirm the preparation request/status are present.
7. Let the scheduled time arrive before a deliberately slow projection finishes.
8. Confirm the Draft stays scheduled with `waiting-projection`.
9. Confirm the room opens automatically only after the verified snapshot becomes ready.
10. Confirm no pick or Auto-Draft occurs against an unverified snapshot.

## Injured Reserve smoke test

### Open bench

1. Put an eligible player on IR.
2. Leave one usable bench slot open.
3. Activate the IR player over an occupied starter.
4. Confirm the dialog automatically selects the open bench spot.
5. Confirm the IR player enters the selected active slot.
6. Confirm the displaced starter appears on the bench.
7. Confirm nobody is placed on waivers.

### Full bench

1. Fill all usable bench spots.
2. Activate an IR player over an occupied starter.
3. Confirm the activation button remains unavailable until a bench destination is selected.
4. Select the exact bench player or goalie unit to remove.
5. Confirm the displaced starter takes that bench spot.
6. Confirm only the selected bench occupant enters waivers.
7. Confirm the transaction description identifies the activated player, moved starter, and waived bench occupant.

### Reserved bench

1. Create a scheduled active/bench swap.
2. Open the IR activation dialog.
3. Confirm the reserved source bench slot is not offered as a destination.

## Rollback

If Draft scheduling regresses, roll back Functions and Hosting to the prior known-good RC23 release, then avoid saving new Draft schedules until the cause is understood.

If IR activation regresses, do not manually edit roster documents. Return to the prior Functions release, reconcile the affected roster from its transaction and waiver records, and record the issue in Beta Operations.

Rollback does not require changing Scoring V3, Projection V11, Firestore Rules, indexes, TTL policies, backup schedules, or queue mode.
