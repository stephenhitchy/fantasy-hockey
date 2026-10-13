# RinkRat B2G — Future Matchup Lineups

Date: 2026-10-12

## Purpose

B2G lets a manager prepare the active lineup for any future regular-season
matchup from My Team. This is especially important when independent six-game
player windows make several fantasy matchups visible at once: the manager can
select a matchup, review its opponent, set the desired active players, and see
when each roster slot is expected to begin contributing.

The selector keeps the current matchup and each future regular-season matchup
in one place. The selected matchup uses the same full roster-board cards and
Manage / Move interaction as the ordinary My Team view. Current-matchup
actions retain their existing roster authority. Future-matchup actions are
limited to active/bench lineup choices, and no action may move a started game,
earned point, or player-window ownership boundary.

## Manager experience

The My Team page adds one matchup selector backed by the deterministic
regular-season schedule. Selecting a matchup keeps the complete roster board
on screen instead of replacing it with a compact form. Each active card shows
the player assigned to that exact matchup, that matchup's score and six-game
markers, an exact saved start or clearly labelled nominal NHL-block start, and
any later planned starter. The bench remains explicit about current ownership
until a planned move actually reaches its server-owned boundary.

For an older overlapping matchup, the board uses that cycle's bounded owner
pick and window reads instead of borrowing the newest physical roster. If the
cycle says a slot should exist but neither exact source identifies its player,
or a present pick and window identify different players, the card says
**Assignment pending** and offers a retry rather than presenting the newest
player as historical fact. A genuinely open slot is shown as open
only when the selected cycle omits it from the owner's expected-slot set, the
physical persistent slot is still empty, and no selected-cycle pick or window
contradicts that state. Missing or malformed cycle metadata fails closed.

A future plan may keep the current player in a persistent active slot or
replace that player with a compatible player who is currently on the bench.
The selected card's **Manage / Move** sheet reuses the current roster flow for
player detail and active/bench choice, but does not expose add/drop or IR as a
matchup-local action. An active player cannot be moved directly between
persistent active slots, an IR player is not a planning candidate, and an
occupied active slot cannot be saved empty. Those restrictions keep a plan
deterministic while different slots cross their six-game boundaries at
different times.

A compatible bench player may also fill an active slot that is physically
empty. That request binds a `null` outgoing asset rather than inventing a
placeholder player. The server accepts that nullable binding only while the
exact persistent active slot is still physically empty and the selected
matchup still has no pick or scoring window for it. The browser cannot use the
empty-slot path to replace an assigned player or erase a started assignment.

The browser exposes loading, confirmation, retry, saved, timing-conflict,
stale-revision, stale-tab, and navigation-away behavior. Each confirmed move
is saved atomically; there is no unsaved multi-slot browser draft in the full-
board flow. When previewing a later matchup, the board composes earlier saved
plans in cycle order so the manager sees the expected carry-forward roster;
each saved plan remains a complete independent snapshot and is revalidated at
its own boundary. A currently owned bench player who is already the projected
starter is not offered as a no-op swap candidate. Before any slot materializes,
the manager can clear the saved plan from the selected roster board and return
to the current-roster projection. If the server discovers that one or more
additional overlapping matchups have already crossed their boundary, the UI
retains the server's exact suggested effective cycle for the same player pair, refreshes,
and requires a new confirmation instead of repeating the stale estimate. The
browser uses bounded reads rather than a new Firestore listener. The server
remains the authority for every saved plan and every eventual roster change.

Matchup 1 follows the same selected-card swap contract once its regular-season
cycle has actually materialized. Before that cycle document exists, its roster
board is read-only and explains that lineup changes unlock when the season
matchup starts. Normal full-plan save and clear operations remain future-only;
only the narrow selected-matchup swap may manage a materialized Matchup 1. An
untouched exact pick/window can change atomically, while any started assignment
preserves Matchup 1 and moves the incoming player's expected start to the next
fair matchup.

## Private authority and storage

The authenticated callable `manageFutureMatchupLineups` owns all list, save,
clear, and selected-matchup swap operations. It verifies the signed-in
manager's current membership and team ownership and shares the existing
`executeSecureRosterAction` App
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

The callable also owns the active-to-bench `swap` intent used by the selected-
matchup **Manage / Move** flow. The request binds the requested cycle, the
browser's expected effective cycle, both exact roster slots, the incoming
asset key, the occupied slot's outgoing asset key or `null` for a physical
empty-slot promotion, the effective plan revision, and one stable request ID.
The browser's expected cycle is only a stale-evidence guard: the server
independently classifies the selected cycle and rejects a mismatch with
`swap-timing-conflict` instead of letting the browser choose a competitive
boundary.

An already-open target matchup accepts a normal full-plan save only while its
preceding regular-season matchup is still active, because that preceding
matchup's asynchronous slot rollovers are the remaining consumer for untouched
target slots. Once the predecessor is complete or unavailable, the target
matchup is read-only for normal saves even if an empty slot never received a
pick; the callable fails with `cycle-started` instead of saving a plan that no
worker could consume. The narrowly scoped `swap` operation is different: it
may retarget an already-materialized occupied slot only under the exact
untouched-window proof described below.

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

Normal future plans do not rewrite a started roster window and do not wait for
every player on a team to finish together. Each planned slot is consumed only
when that persistent slot reaches its real six-game boundary and its next
regular-season window is about to be created. Both the ordinary next-cycle
path and the overlapping fast-slot rollover path use the same plan authority.
The existence of an overlapping cycle does not blanket-lock the other slots
that are still explicitly `planned`.

For an explicit selected-matchup active-to-bench swap, materialization by
itself is not treated as game ownership. When both exact assignments remain
untouched, the selected-matchup plan changes immediately. If that selected
matchup is already materialized, the server may also rewrite its occupied
assignment only when all of the following remain true in one Firestore
transaction:

- the manager still owns the exact active and bench assets in the exact slots;
- no normal pending roster move reserves either boundary;
- the exact target pick still owns the outgoing asset;
- the exact target scoring window is present, scheduled, identity-matched, and
  contains zero games, zero points, no live/final or scoring evidence, and no
  injury-replacement ownership;
- the incoming asset has no pick or scoring window in that cycle;
- the cycle's frozen outgoing and incoming NHL game IDs each contain exactly
  the league-required number of unique positive IDs, and a fresh schedule
  fetch proves every one remains before puck drop; and
- a final clock check immediately before writes proves none of those games
  crossed puck drop while the request was being verified.

The transaction rereads the league's required-game contract and both frozen
ID sequences. Any scoring-contract change, missing or duplicate ID, or
difference from the preflight evidence aborts before a roster, pick, window,
plan, receipt, or audit write can occur.

An empty-active-slot promotion has no outgoing player to verify. Its nullable
outgoing binding is valid only when the exact physical active slot is empty,
the exact incoming player is still in the submitted bench slot, and the target
cycle has no pick or scoring window for that active slot. The target cycle
must still provide one complete league-sized set of unique frozen NHL game IDs
for the incoming player's current team. Fresh provider evidence and the final
transaction clock check must prove that none of those incoming games started.
The transaction rereads the empty target, frozen IDs, and roster ownership;
any pick, window, player, schedule, or puck-drop change aborts before the plan
or receipt is written.

Missing or malformed evidence never means zero. If either occupied-slot
assignment has started, the empty slot's incoming assignment has started, an
assignment is already owned elsewhere, or the selected target is otherwise
unavailable, the server preserves the selected matchup and searches forward
through overlapping regular-season cycles for the next fair eligible cycle.
It either saves the complete plan there or applies the same exact untouched
proof to an already-materialized later cycle. Fresh provider puck-drop
evidence that contradicts a stale scheduled window returns a
`swap-timing-conflict` with the authoritative next cycle; the browser must
refresh and reconfirm, and the stale window is never rewritten. The successful
response states `immediate` or `queued`, requested and effective cycle numbers,
the timing reason, the saved plan, and a human-readable effective-start reason.
The board then shows that later matchup as the incoming player's expected
start. An unmaterialized A-to-B plan can be changed to B-to-C or safely
reversed to A without pretending the physical roster has already moved. For
an older overlapping matchup, the exact saved pick and window may identify the
displayed outgoing player, but only exact current physical active/bench
ownership can authorize an immediate materialized rewrite.

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
substitutes zero, steals a bench player from another slot, or moves a started
game. The only existing target pick it may rewrite is the exact selected-
matchup pick covered by the untouched proof above; the roster, pick, scoring
window, complete plan, bounded idempotency receipt, and deterministic audit are
committed atomically. Historical Replay explicitly disables plan consumption,
and playoff windows remain outside this first contract.
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

The schedule preview uses bounded cached NHL requests. Exact window reads load
only the signed-in owner's selected-cycle document, and one bounded owner-pick
query confirms the selected cycle's slot identities; duplicate or malformed
slot evidence fails visibly. Its bounded team set
includes the selected assignments and every currently eligible bench player's
NHL team, deduplicated and required to remain within the existing 32-team cap,
so an open-slot promotion or swap does not appear safe merely because the
incoming bench schedule was omitted. There is no new listener fanout. A failed
schedule request remains visible as nominal or pending evidence and does not
become competitive authority. Saving performs a fresh bounded plan-and-window
authority read first; if anything changed, the page preserves compatible
unsaved choices, refreshes locked slots, and asks the manager to review before
submitting. Roster changes trigger the same bounded window reread. Ambiguous
save or clear failures retain one stable request ID so the explicit retry can
replay the exact mutation safely.

## Scope and protected contracts

B2G changes regular-season roster authority only at a manager-selected
persistent-slot boundary. An occupied selected assignment can change only
before either exact player reaches NHL game ownership; an empty-slot promotion
requires that the incoming assignment has not started and that no target pick
or window exists. Otherwise the next fair cycle is authoritative. It does not
change Production
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

It builds Functions, then runs
`test/future-matchup-lineup-core/*.test.mjs`,
`test/future-matchup-lineup-authority/*.test.mjs`, and
`test/future-matchup-lineup-ui/*.test.mjs` inside the Firestore emulator. The
core coverage protects matchup selection, selected-cycle open-versus-missing
slot evidence, slot-bound active and bench
candidates, immutable windows, full-lineup validation, exact-versus-nominal
date precedence, stable game IDs, bounded one-owner reads, and the
no-new-listener contract. The authority coverage protects assignment hashes,
revision and request replay, private membership checks, cross-cycle
reservations, partial materialization, pending-move precedence, conflict
fallbacks, post-preflight races in both rollover paths, empty-slot expected-
window accounting, selected-cycle untouched swaps, stale provider puck-drop
evidence, nullable-outgoing empty-slot promotions, atomic
roster/pick/window/plan/audit commits, exact request replay, and regular-season-
only gating. The UI coverage protects the
current score view, complete selected-matchup roster-board reuse, future-only
active/bench actions, labelled native controls, per-slot date semantics,
eligible-bench schedule evidence, multi-overlap timing reconciliation, mobile
layout primitives, and complete async states.

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

Do not use the earlier incremental B2G assumption for the current Production
posture. At the 2026-10-12 review, the live Hosting manifest identifies source
`cc39319177670a0b9ce2fb0d0d18daf53eea634c`, while the operator-provided
targeted Functions deployment logs identify clean source
`412c3b8b1705478c992db5e79d847c8c943a6308`. Those sources are divergent, and
Function inventory or ACTIVE status does not prove one exact deployed source.
Use the complete staged sequence above from one verified clean commit unless a
fresh per-Function source audit first proves that every listed consumer already
has the reviewed B2G boundary contract. Do not broaden any selector merely to
make the runtime uniform.

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
the exact saved evidence passes again. If a future per-Function source audit
proves an incremental selected-matchup release safe, restore Hosting first and
then restore the preceding `manageFutureMatchupLineups` revision; do not
manually undo an atomic swap that already committed.
