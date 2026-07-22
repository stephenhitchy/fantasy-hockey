# Auto-Draft Starter Priority and Balanced Bench

## Behavior implemented

Auto-draft now uses two strict phases for every manager:

1. Fill all 14 active roster slots.
2. Fill the three bench coverage roles with one forward, one defenseman, and one goalie unit.

The forward role includes LW, C, and RW. Auto-draft will not use a second forward bench selection while defense or goalie coverage is still missing.

## Mid-draft activation

The strategy recalculates from the manager's existing picks each time auto-draft needs to select:

- Existing manual bench picks are recognized.
- Existing automatic bench picks are recognized.
- If any active slot remains open, auto-draft returns to the starting lineup before adding another bench asset.
- Once all starters are filled, the next bench pick uses a role not already represented on the bench.

Examples:

- Bench already has a forward: auto-draft next targets defense and goalie.
- Bench already has a defenseman and goalie: auto-draft next targets a forward.
- Bench has two players but the active roster is incomplete: auto-draft fills the active roster first, then returns to the final bench slot.
- Bench manually contains duplicate roles: auto-draft uses a still-missing role for any remaining bench slot, but does not move or replace existing manual picks.

## Queue behavior

The personal queue remains the first preference, but only among candidates that match the current roster phase:

- While starters are incomplete, queued bench-only candidates are skipped temporarily.
- Once starters are complete, queued candidates with an already-covered bench role are skipped temporarily.
- If no eligible queued asset exists, the best available eligible asset by the existing draft-value ranking is selected.

Queued players are not deleted merely because they are temporarily ineligible.

## Transaction protection

The same policy is checked inside the Firestore draft-pick transaction. This prevents a stale commissioner screen from submitting a bench pick before all starters are filled or duplicating a bench role.

Manual draft picks are unchanged. The stricter balance policy applies only to automatic selections, including manager-enabled auto-draft and timer-expiration picks.

## Files changed

- `src/app/core/draft/auto-draft-strategy.ts`
- `src/app/core/draft/auto-draft-strategy.spec.ts`
- `src/app/core/draft/draft.service.ts`
- `src/app/features/draft/draft-room/draft-room.ts`
- `src/app/features/draft/draft-room/draft-room.html`

## Deployment

This is a client application update. No Cloud Functions, Firestore rules, or indexes changed.
