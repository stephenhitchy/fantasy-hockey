# RinkRat B2G — Future Matchup Lineups

Date: 2026-10-12

## Purpose

B2G lets a manager prepare the active lineup for any future regular-season
matchup from My Team. This is especially important when independent six-game
player windows make several fantasy matchups visible at once: the manager can
select a matchup, review its opponent, set the desired active players, and see
when each roster slot is expected to begin contributing.

The current matchup remains a read-only score view. Editing is limited to a
future regular-season matchup because already started games, points, and
player-window ownership are immutable.

## Manager experience

The My Team page adds one matchup selector backed by the deterministic
regular-season schedule. For a selected future matchup it shows the complete
active lineup, each slot's current or planned player, the player's start-date
evidence, and whether the slot is editable, planned, already applied, or in a
visible conflict state.

A future plan may keep the current player in a persistent active slot or
replace that player with a compatible player who is currently on the bench.
An active player cannot be moved directly between persistent active slots, an
IR player is not a planning candidate, and an occupied active slot cannot be
saved empty. Those restrictions keep a plan deterministic while different
slots cross their six-game boundaries at different times.

The browser exposes loading, retry, saving, saved, conflict, stale-revision,
and navigation-away behavior. When previewing a later matchup, it composes any
earlier saved future plans in cycle order so the manager sees the expected
carry-forward roster; each saved plan remains a complete independent snapshot
and is still revalidated at its own boundary. The browser uses bounded reads
rather than a new Firestore listener. The server remains the authority for
every saved plan and every eventual roster change.

An unsaved draft disables matchup switching and manual refresh until the
manager saves it or chooses **Reset changes**. The same method-level guards
protect programmatic calls, and the page explains why navigation is paused.
This prevents a slow authority refresh from silently replacing an edit.

## Private authority and storage

The authenticated callable `manageFutureMatchupLineups` owns all list, save,
and clear operations. It verifies the signed-in manager's current membership
and team ownership and shares the existing `executeSecureRosterAction` App
Check canary classification. It rejects an incomplete Draft, Historical
Replay, playoffs, past periods, malformed full-lineup assignments, pending
roster moves, stale revisions, reused request IDs with different payloads,
and incompatible or no-longer-owned players.

Plans and bounded idempotency state are callable-private documents:

- `leagues/{leagueId}/teams/{ownerId}/lineupPlans/cycle-{cycleNumber}`
- `leagues/{leagueId}/teams/{ownerId}/lineupPlanMutationState/cycle-{cycleNumber}`

Firestore Rules do not grant the browser direct access to either collection.
The plan collection read is capped. Each per-cycle mutation-state document
stores a monotonic latest revision and at most 64 hashed request receipts; a
stable request ID replays only its exact previously committed response, while
further edits fail visibly once that cap is reached. Clearing a plan preserves
the mutation-state document, so a recreated plan receives a later revision
instead of reusing revision 1. A saved plan contains the complete active-lineup
assignment plus per-slot resolution state. For a resolved slot, `assetKey`
preserves the manager's original request and remains covered by the plan's
assignment hash, while `resolvedAssetKey` records the authoritative player who
actually received the target window (including an explicit `null` when no pick
could be created). This keeps conflict history auditable without making later
edits submit a player who is no longer on the roster. Materialized slots remain
locked while untouched planned slots in the same partial or conflicted overlapping
matchup may still be edited. A plan can be cleared only before any target slot
has materialized or acquired a roster pick.

An already-open target matchup accepts a new save only while its preceding
regular-season matchup is still active, because that preceding matchup's
asynchronous slot rollovers are the remaining consumer for untouched target
slots. Once the predecessor is complete or unavailable, the target matchup is
read-only even if an empty slot never received a pick; the callable fails with
`cycle-started` instead of saving a plan that no worker could consume.

When a target cycle does not exist yet, the save transaction also reads the
latest materialized cycle and validates its exact document identity, number,
phase, and status. It accepts the absent target only when it is strictly later
than the latest valid regular-season cycle. Missing or malformed cycle
authority fails closed, and a deleted or stale past cycle cannot acquire a new
plan or strand a cross-cycle player reservation. Clearing an existing stale
plan remains available as the safe recovery path.

An asset may be planned for the same persistent roster slot across future
matchups. The server rejects reserving that same asset for different active
slots in different plans because asynchronously materialized windows could
otherwise compete for one bench player.

## Per-slot boundary behavior

Future plans do not rewrite a current roster window and do not wait for every
player on a team to finish together. Each planned slot is consumed only when
that persistent slot reaches its real six-game boundary and its next
regular-season window is about to be created. Both the ordinary next-cycle
path and the overlapping fast-slot rollover path use the same plan authority.
The lock begins when that persistent slot receives its target roster pick; it
does not wait for the player's first NHL puck drop. Conversely, the existence
of an overlapping cycle does not blanket-lock the other slots that are still
explicitly `planned`.

At that boundary the transaction rereads the exact plan revision and
assignment hash, the authoritative roster, the target roster pick, and the
bench player needed by the requested swap. A normal queued roster move has
precedence over a future-lineup plan. When the evidence still matches, the
planned bench player enters the active slot, the outgoing active player moves
to the exact vacated bench slot, the next immutable window snapshots the new
player, and one deterministic transaction audit is written. Keeping the
current player is recorded as an unchanged resolution. A newly promoted goalie
unit uses the target pick's commit timestamp as its eligibility cutoff, so a
game from before the planned swap cannot leak into the new window. On ordinary
cycle rollover, child windows advance before the parent cycle is marked
complete; a crash can therefore retry without stranding unresolved slots behind
a completed parent.

If ownership, position, pending-move state, roster identity, plan revision, or
target-window state changed before the boundary, the plan fails visibly for
that slot. The transaction uses the precomputed current-player fallback only
when the reread proves that fallback is still exact. If neither the planned
pick nor that exact fallback can be committed, the whole boundary transaction
aborts so a fresh automation attempt can rebuild from the new roster and plan
state; it never commits a target cycle with an expected slot but no recoverable
pick. Plans created after rollover preflight likewise force a fresh attempt,
including plans that fill an otherwise-empty active slot. A successful empty-
slot promotion is added to the target cycle's expected-window set, so matchup
completion waits for its full six games. The contract never silently
substitutes zero, steals a bench player from another slot, rewrites an existing
target pick, or moves a started game. Historical Replay explicitly disables
plan consumption, and playoff windows remain outside this first contract.
An existing malformed plan or owner/cycle identity mismatch also aborts both
materialization paths visibly instead of being treated as an absent plan.

## Start-date evidence

Start dates are per roster slot, not one date for the whole matchup. The page
uses the strongest available evidence in this order:

1. A materialized window with the same authoritative player identity supplies
   its exact first scheduled NHL date.
2. Before materialization, the browser shows the beginning of the selected
   matchup's NHL schedule block and labels it **Nominal NHL block**. This is a
   planning aid, not a promise that the player starts on that date: an
   independent persistent slot may reach its actual six-game boundary later.
3. If a locked window lacks usable matching schedule evidence, the page says
   **Start date pending** instead of inventing a date.

Dates are formatted in UTC so the NHL calendar date does not shift on a
manager's device. Plan save time, per-slot resolution time, cycle creation
time, and player start time are intentionally separate concepts; none of the
audit timestamps is presented as the player's first game. The callable
deliberately returns no plan-level target-start timestamp because independent
slots in one matchup can start on different dates.

The schedule preview uses bounded cached NHL requests, and exact window reads
load only the signed-in owner's selected-cycle document. There is no new
listener fanout. A failed schedule request remains visible as nominal or
pending evidence and does not become competitive authority. Saving performs a
fresh bounded plan-and-window authority read first; if anything changed, the
page preserves compatible unsaved choices, refreshes locked slots, and asks the
manager to review before submitting. Roster changes trigger the same bounded
window reread. Ambiguous save or clear failures retain one stable request ID so
the explicit retry can replay the exact mutation safely.

## Scope and protected contracts

B2G changes regular-season roster authority only at a future persistent-slot
boundary chosen in advance by the manager. It does not change Production
Scoring V4 values, Projection V11 formulas or hashes, the six-game allowance,
seventh-game rollover, started-window ownership, injury-replacement ownership,
Draft authority, waivers, IR timing, standings, playoff authority, historical
scoring reconstruction, Firestore Rules, indexes, TTL policies, App Check
mode, scoring queue mode, worker or pending-task limits, or canonical scoring
authority.

## Verification

The focused suite is:

```bash
npm run test:batchb2g
```

The current B2G suite contains 63 tests.

It builds Functions, then runs
`test/future-matchup-lineup-core/*.test.mjs`,
`test/future-matchup-lineup-authority/*.test.mjs`, and
`test/future-matchup-lineup-ui/*.test.mjs` inside the Firestore emulator. The
core coverage protects matchup selection, slot-bound active and bench
candidates, immutable windows, full-lineup validation, exact-versus-nominal
date precedence, stable game IDs, bounded one-owner reads, and the
no-new-listener contract. The authority coverage protects assignment hashes,
revision and request replay, private membership checks, cross-cycle
reservations, partial materialization, pending-move precedence, conflict
fallbacks, post-preflight races in both rollover paths, empty-slot expected-
window accounting, and regular-season-only gating. The UI coverage protects the
compact current score view, future-only editor, labeled native controls,
per-slot date semantics, mobile layout primitives, and complete async states.

The new inherited release gate is:

```bash
npm run verify:batchb2g
npm run build:all
git diff --check
npm run release:verify-clean-deploy-source
```

`verify:batchb2g` inherits `verify:batchb2f:core` before running the emulator-
backed B2G suite, release-manifest validation, toolchain verification, and the
dependency audit.

## Targeted rollout

Do not deploy from a dirty worktree. Stephen performs each Production deploy.
Deploy the plan consumers before allowing a browser to create plans:

```bash
firebase deploy --project nhl-fantasy-app-ab673 --only "functions:initializeSeasonAfterDraft,functions:openNextCompetitionPeriod,functions:processHistoricalReplayAdvance,functions:processLeagueAutomationTask,functions:requestLeagueLiveScoringRefresh,functions:runScheduledLeagueAutomation,functions:runSeasonStartAutomation"
```

These are the existing league-automation entry points that transitively reach
the changed regular-season cycle/window materialization code. The Historical
Replay worker is included because its updated path must explicitly suppress
future-plan consumption. The scheduler, initialization, refresh, task worker,
and manual-open entry points must stay on the same boundary contract so a
different trigger cannot bypass plan consumption or replay suppression.

Then deploy the private plan authority:

```bash
firebase deploy --project nhl-fantasy-app-ab673 --only "functions:manageFutureMatchupLineups"
```

Finally deploy the My Team experience:

```bash
firebase deploy --project nhl-fantasy-app-ab673 --only "hosting:app"
```

No Rule, index, TTL, queue, Scheduler, App Check configuration, migration, or
Production data write belongs to this rollout. Existing leagues need no
backfill; they have no plan until a manager explicitly saves one.

## Rollback

The preferred rollback is Hosting-only: restore the preceding Hosting release
so no browser offers new plan mutations, while leaving the backward-compatible
callable and consumers deployed. A full rollback must first restore Hosting,
then disable or delete the new `manageFutureMatchupLineups` callable and
confirm it no longer accepts writes, and only then restore the preceding
revisions of the seven league-automation Functions listed above from one
verified clean source. The new callable has no earlier revision to restore.
Do not delete plan, mutation-state, transaction-audit, roster-pick, or window
documents. Restoring older cycle consumers makes any unconsumed plan inert;
already materialized roster windows and swaps remain authoritative and must
not be reversed. A forward fix may safely resume remaining planned slots after
the exact saved evidence passes again.
