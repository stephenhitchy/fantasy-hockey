# RinkRat Async Operation Recovery

## Batch R1D scope

Batch R1D replaces the remaining indefinite browser wait states with bounded, authoritative reconciliation. It is specifically intended to prevent a successful Firebase operation from leaving the page blurred, locked, or stuck on messages such as **Sending selection**, **Confirming pick**, or **Saving draft settings**.

A browser timeout does not mean the server operation was cancelled. RinkRat therefore separates two responsibilities:

1. The browser releases its local visual/pending state after a fixed safety window.
2. Competitive actions reconcile against the exact authoritative Firestore document before the manager is encouraged to retry.

## Draft pick safety

Every new manual selection receives a stable `submissionId` and the expected overall pick number. The same identifier is stored on the committed pick document.

The server checks the exact pick document before and inside the Firestore transaction. A retry with the same submission ID returns the original committed pick. A conflicting submission for the same overall pick is rejected clearly. Older tabs that do not yet send an identifier remain compatible, but new tabs use the exact idempotent path.

The Draft Room:

- leaves the initial **Sending selection** phase after 2.5 seconds;
- checks the exact draft and pick documents with six-second read limits;
- repeats reconciliation every four seconds;
- uses a compact status dock instead of a fuzzy full-screen shield;
- releases the local pending state after 45 seconds without awaiting Firebase;
- requires a fresh live-listener handshake before another competitive action;
- caches the immutable pinned draft projection for five minutes per warm Function instance to reduce repeated pick latency.

## Draft settings safety

Each **Save Draft Settings** click receives its own settings submission ID. The server saves that identifier beside the exact order, date, clock duration, and status. The client can therefore confirm the exact save through a live listener or bounded direct document reads even when the callable response is lost.

Projection preparation reuses a verified fresh Projection V11 snapshot when available. A new projection build has a 75-second local deadline. Saving/reconciliation has a 35-second window plus a final five-second document check. The page uses a compact status dock and never a full-screen save lock.

## Site-wide visual recovery

The shared action sheet releases its backdrop after 12 seconds when a parent operation remains busy. The parent operation continues reconciling through a compact page status message.

The viewport overlay portal now tracks actual connected overlay nodes, watches DOM removal, and repairs body scroll locking on page lifecycle events. Every Angular route completion also runs the repair. This prevents Mobile Safari from preserving a fixed body, blurred backdrop, or offscreen overlay after the Angular view has disappeared.

Every browser Firebase callable has an explicit transport timeout. Draft queue, Auto-Draft, clock controls, roster changes, goalie-unit changes, Injured Reserve moves, waiver processing, profile actions, feedback, and administrative actions also use bounded local waits or authoritative live-document reconciliation.

## Competitive preservation

Batch R1D does not change Production Scoring V3, Projection V11 calculations, draft order, roster legality, waiver priority, six-game roster-slot windows, seventh-game rollover, standings, playoffs, Firestore rules, or indexes.

The only server behavior changes are idempotent Draft pick/settings submissions and a small in-memory cache for the already frozen draft projection snapshot.

## Verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm ci
npm --prefix functions ci
npm run verify:batchr1d
```

## Deployment order

Deploy the two updated Draft authority Functions first so the new browser can use exact submission IDs safely:

```bash
firebase use nhl-fantasy-app-ab673
firebase deploy --only functions:makeSecureDraftPick,functions:executeDraftCommand -m "Batch R1D idempotent draft submissions"
```

Then deploy Hosting:

```bash
firebase deploy --only hosting:app -m "Batch R1D universal async recovery"
```

**Functions first.** No Firestore rules, indexes, or data migration are required.

## Recovery rule for an uncertain result

When RinkRat says it could not confirm an operation, refresh the authoritative page before repeating it. For a Draft pick, inspect the exact pick number. For draft settings, inspect the saved date, clock, and order. For a roster action, inspect My Team. Repeating only after verification prevents a delayed first request from being mistaken for a missing request.
