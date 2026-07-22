# Mobile Add/Drop and Cycle-Safety Report

## Result

The add/drop page is now a mobile-first two-step workflow, and transaction activation is protected against retroactive scoring. A manager can no longer acquire a player after seeing that player's early results from an already-started six-game block and receive those results in the same cycle.

## New mobile workflow

### Step 1 — Choose a player

The free-agent and waiver lists remain searchable and filterable. Selecting a player immediately leaves the long pool and opens a dedicated roster-slot screen.

### Step 2 — Choose a roster slot

The second screen contains only the selected player, cycle eligibility, and compatible same-position roster slots. Each slot card shows:

- The player currently occupying the slot, or that it is open.
- The immutable window currently attached to that slot.
- Current cycle number and completed team games.
- The slot's next available cycle.
- The incoming player's earliest untouched cycle.
- The final activation cycle after both restrictions are combined.

The confirmation panel is fixed to the bottom of mobile screens and respects the device safe area. The user no longer needs to scroll to the bottom of the player pool to submit the move.

## Incoming-player cycle calculation

The new `roster-move-eligibility.service.ts` loads the selected asset's NHL-team regular-season schedule and divides it into the league's configured six-game blocks.

It identifies the first block that is not fully complete and reports:

- Current asset cycle number.
- Final games already completed in that block.
- Any live game in that block.
- Scheduled games in the block.
- Whether the block has started.
- Earliest untouched cycle in which the player can legally activate.

If any game in the block is final or live, the earliest activation moves to the next cycle. This check is refreshed again immediately before the transaction is saved.

## Final activation rule

The saved target is:

`max(selected roster slot's next cycle, incoming player's earliest untouched cycle)`

That target is stored on the persistent pending roster move as `requestedEffectiveCycleNumber` and shown to the user before confirmation.

## Server enforcement

The UI is not the only protection. Both copies of the authoritative cycle engine now enforce the requested target:

- Angular/client cycle service used by local tools and compatibility paths.
- Firebase Functions shared cycle service used by scheduled server automation.
- Angular playoff window-bank service.
- Firebase Functions playoff window-bank service.

A pending move activates only when the slot has reached a legal boundary and the new cycle is at least the saved requested cycle.

## Filled-slot behavior

When an outgoing player finishes the current slot window before the incoming player becomes eligible, the outgoing player remains in that slot for the intermediate cycle. The reserved incoming player activates only at the target cycle.

Example: outgoing slot completes Cycle 5, but incoming player has already started Cycle 6. The outgoing asset receives the Cycle 6 window and the incoming player starts Cycle 7.

## IR/open-slot behavior

Moving the outgoing player to IR does not bypass the fairness protection. If that player's current slot window is still active, the replacement cannot start early. Once the current window ends, the slot may remain empty during an ineligible intermediate cycle and open directly when the incoming player's target cycle arrives.

No already-played games are backfilled.

## Waiver behavior

Waiver claims save the cycle calculated when the claim is submitted. Commissioner processing refreshes the incoming player's schedule again and uses the later of:

- The claimant's saved slot/player target.
- The newly calculated target at processing time.

The commissioner cannot accidentally move the award earlier than the claimant originally saw, and schedule progression while the claim waits can only delay—not accelerate—the activation.

## Playoff behavior

Playoff window-bank creation now respects the same requested cycle. A pending move that is not eligible for the bank's source cycle remains pending. The outgoing player continues if present; an open slot remains empty. The move activates in the first playoff bank whose source cycle reaches the target.

## Data-loading protection

The slot screen waits until all currently active cycle-window listeners have returned before enabling confirmation. This prevents a fast mobile tap from using a fallback cycle number while the user's asynchronous roster-slot windows are still loading.

## Validation performed

- Angular production build passed.
- Firebase Functions TypeScript build passed.
- Exact app/server cycle-enforcement files compile together.
- The mobile free-agent route remains lazy-loaded.
- Initial bundle remains approximately 404 kB raw / 106 kB transferred.
- Free-agent route is approximately 60 kB raw / 13 kB transferred.

The existing unrelated `cycle-one.css` component-style budget warning remains.

## Deployment dependency

Firebase Functions must be deployed before hosting because the updated UI begins saving earliest-activation targets that the scheduled server worker must enforce. Since the previous server-automation Firestore rules were not yet deployed, the installation instructions include those rules in the subsequent hosting deployment.
