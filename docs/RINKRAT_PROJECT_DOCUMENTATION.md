## Batch M5.2 — Side-by-Side Add/Drop Comparison and Transaction Confirmation Recovery

### Purpose

This Hosting-only refinement follows Batch M5.1 and addresses two issues found during add/drop testing:

1. managers needed a more direct old-player-versus-new-player comparison that explained the exact asynchronous matchup timing; and
2. a roster transaction could commit successfully while the callable response remained pending or failed to reach mobile Safari, leaving the compare sheet dimmed with an endless busy indicator until the page was refreshed.

The batch changes presentation and client-side confirmation recovery only. Production Scoring V3, Projection V11, waiver priority, roster authority, scheduled-move authority, independent six-game windows, Cloud Functions, Firestore rules, and indexes remain unchanged.

### Side-by-side decision surface

The Available Players comparison sheet now supports a wider desktop surface while retaining a two-column comparison on phones:

- the current roster player or open slot is always on the left;
- the incoming player or goalie unit is always on the right;
- the primary confirmation action is fixed at the top of the sheet rather than after the long comparison;
- season points, next-six projection, and rest-of-season estimate are shown for both sides; and
- the full current-season scoring-category table shows the raw NHL total and RinkRat fantasy-point contribution for every category available on either player.

The top action stays disabled until the manager selects a compatible roster slot and the incoming player's NHL-team schedule has been refreshed. While a request is pending, the same visible sheet explains that RinkRat is waiting for either the secure callable response or the authoritative live roster update.

### Exact six-game and matchup explanation

The comparison uses the actual asynchronous state of both sides rather than a generic league-wide week:

- the outgoing side shows the immutable roster-slot matchup, exact six saved NHL team games, dates, opponents, final/live/upcoming state, appearance or missed-game status, and saved fantasy points where available;
- the incoming side shows the player's current NHL six-game block, exact game dates and opponents, played/missed/live/upcoming markers, and current matchup number;
- a separate **Exact First Legal Start** section shows the six currently scheduled NHL team games for the first matchup in which the incoming player can legally own the selected roster slot; and
- the preview states that postponements may update an unstarted schedule, while the roster-slot schedule becomes immutable when that window begins.

Timing copy names the source of any delay:

- **No matchup delay** when both assignments are untouched and can be replaced safely;
- the current player by name when their active six-game roster window must finish;
- the incoming player by name when their NHL block has already started and prior games cannot be acquired;
- **Both players affect timing** when both histories have started;
- the roster-slot boundary when the old player is complete but the next immutable window has not opened; or
- a waiver condition when the move first depends on winning the claim.

When both sides are aligned, the sheet explicitly states that they are in the same matchup. When the incoming player is one or more matchups behind, it states the exact difference, explains that no prior games are backfilled, and identifies the next clean matchup window in which the change can begin.

Historical replay timing is evaluated from the replay control's simulated target-season date rather than from the real-world NHL API state. Games on or before that simulated date are treated as completed for the incoming player's six-game eligibility calculation, even though the target-season NHL schedule still labels them as future games in the live API. The comparison labels the replay date being used. While replay is actively advancing or recovering from an error, the add/drop timing check is blocked with a plain-language message so a manager cannot submit a move against an in-between replay state.

### Resilient post-submit confirmation

The previous client awaited only the callable promise. A committed Firebase transaction could therefore be visible in Firestore while a slow, interrupted, or failed mobile HTTP response kept `moving` true indefinitely. Because the shared action sheet treats a busy dialog as non-dismissible, the manager saw a dimmed page and spinning pointer even though the transaction appeared after refresh.

Batch M5.2 now accepts either of two authoritative completion signals:

1. the callable returns successfully; or
2. the live Firestore listener observes the expected result.

The listener confirms:

- an immediately activated player in the selected active slot;
- an incoming player reserved in that active slot's scheduled move;
- a player added to the selected bench slot; or
- the signed-in manager's claim recorded on the selected waiver.

If the callable reports a transport error just before the listener receives the committed update, the client allows a brief reconciliation period before showing an error. A hard 20-second ceiling prevents an endless pending state. If neither signal arrives, the interface unlocks and tells the manager to check My Team before retrying because the original request may still complete in the background.

The NHL schedule prerequisite has its own 15-second ceiling. A stalled schedule request therefore cannot keep the sheet busy before the roster callable is even submitted. Commissioner waiver processing uses the same bounded replay-aware eligibility check.

After success, Angular first removes the busy state while the sheet remains mounted, waits one animation frame, and only then closes and restores the player pool. This avoids a Safari portal/body-lock race that could otherwise leave the backdrop or fixed-body state behind after a successful transaction.

Other roster operations continue to use the existing full-page pending shield. The add/drop compare step deliberately remains visible during submission so managers see the transaction and confirmation status instead of a fuzzy screen.

### Shared action-sheet extension

The reusable action sheet now supports:

- an optional 68rem wide presentation for data-heavy comparisons; and
- a projected top-action row between the title and independently scrollable content.

Sheets that do not use these options retain their prior dimensions and layout.

### Automated verification

After manually replacing the project files:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm ci
npm --prefix functions ci

npm run verify:batchm5-2
npm run build:all
```

The focused M5.2 suite verifies:

- same-matchup, incoming-behind, incoming-ahead, outgoing-delay, incoming-delay, and both-player timing explanations;
- no-backfill messaging and the exact first legal matchup;
- outgoing immutable game dates, opponents, appearances, missed games, live games, and saved points;
- incoming current-block and first-start schedules;
- unioned current-season stat categories in old-left/new-right order;
- simulated-date-aware historical replay eligibility even while target-season games retain live `FUT` states;
- immediate, queued, boundary-activated, bench, and waiver listener confirmation;
- top-positioned confirmation and wide action-sheet composition;
- the compare sheet remaining visible instead of being replaced by a blurred full-screen shield; and
- preservation of all earlier dependency-free regression, design, accessibility, mobile, and beginner-language contracts.

### Deployment

This is a Hosting-only batch:

```bash
firebase use nhl-fantasy-app-ab673
firebase deploy --only hosting:app -m "Batch M5.2 add drop comparison and transaction confirmation"
```

Do not deploy Functions, Firestore rules, or indexes for this batch.

### Post-deployment checks

1. Open Available Players and select a normal free agent.
2. Confirm the primary action is visible at the top before scrolling and remains disabled until a roster spot is selected.
3. Select an active player whose six-game window has started. Confirm that player appears on the left, the incoming player appears on the right, and the timing message names the outgoing player as the delay.
4. Verify all six outgoing games show the exact dates, opponents, states, appearance status, and points.
5. Verify the incoming current block and first legal start block show the correct matchup numbers and exact scheduled games.
6. Test two players aligned to the same matchup and confirm the sheet says so.
7. Test an incoming player one matchup behind and confirm the sheet says the move uses the next clean matchup with no backfill.
8. Compare skater-versus-skater and goalie-unit-versus-goalie-unit category tables.
9. Submit an immediate add/drop, a scheduled add/drop, an open-slot addition, a bench replacement, and a waiver claim.
10. On iPhone Safari, interrupt the connection immediately after submitting. Confirm the sheet either closes after the live roster update or unlocks with a clear recovery message within 20 seconds; it must not remain fuzzy or spin indefinitely.
11. After success, confirm the player pool returns to its saved search, filters, and scroll position and that the page itself scrolls normally.
12. In a historical replay league, advance the simulated date into the incoming player's second six-game NHL block. Confirm the comparison names the replay date and does not treat all target-season games as unplayed merely because the live NHL API still marks them as future.
13. Repeat at 320px, 360px, 390px, and 430px in Rink Dark, Light Ice, and OLED Black.

### Rollback

A Hosting-only rollback to the approved M5.1 build is safe for competition data because M5.2 adds no schema and changes no server authority. The transaction itself remains server-authoritative in either build. Rolling back would restore the older single-sided comparison and the possibility that a committed operation remains visually pending when its callable response is lost.

---

## Batch M5.1 — Mobile Viewport Overlays, Compact Draft Controls, Replay Scoring Detail, and League Return Navigation

### Purpose

This client-side hotfix follows Batch M5–V1 and addresses four usability issues found during real iPhone testing:

1. modal-style interfaces sometimes showed only a blurred page while the dialog rendered far below the visible Safari viewport;
2. the Draft Room kept too many controls sticky and obscured player information;
3. Back to League links were visually inconsistent and difficult to notice;
4. historical replay totals advanced, but the full player game-history view could load the ordinary live-season schedule instead of the exact saved replay window.

The batch does not change Production Scoring V3, Projection V11, draft authority, roster authority, transaction timing, six-game-window ownership, Cloud Functions, Firestore rules, or indexes.

### Shared mobile viewport-overlay correction

Mobile Safari can treat a `position: fixed` descendant as fixed to a transformed or filtered route surface rather than to the visual viewport. The backdrop may still cover the visible screen while the actual dialog is positioned several screens lower in the document.

`ViewportOverlayPortalDirective` now moves an open fixed overlay directly under `document.body` while preserving all Angular bindings. It:

- records the exact horizontal and vertical scroll position;
- freezes the page body and document while the overlay is open;
- resets the dialog's own scroll area to its beginning;
- supports more than one protected overlay through a shared lock count;
- restores the original inline styles and exact page position after close; and
- removes the portaled element safely when its original Angular view has already been destroyed.

The shared correction is used by:

- Game Center mobile player/game-history detail;
- Available Players compare-and-confirm sheets;
- My Team management and roster confirmation sheets;
- the Draft Room live-entry prompt and pick-confirmation shield;
- Draft Setup save protection;
- league draft-start prompts; and
- pending roster-operation shields.

The overlays use a shared viewport z-index above mobile navigation and Coach Help, remain inside dynamic viewport height, include iPhone safe-area padding, and keep their own content scrollable.

### Draft Room phone layout

At phone widths, search, position, sort, and Players/Queue/Roster controls now remain in the normal document flow and scroll away. Only these elements remain sticky:

- the current pick, manager, clock, connection indicator, and legal commissioner clock action; and
- the selected-player Draft action.

The command bar is shorter, uses smaller labels, and does not apply a backdrop blur. This preserves substantially more vertical space for player names, rankings, risk, form, projections, and roster-fit information.

### Shared league return control

Every existing league-owned return link now uses the same high-contrast `league-return-link` treatment. The control includes a local hockey-rink/return-arrow SVG, a minimum touch target, keyboard focus styling, theme-aware contrast, and reduced-motion behavior.

The same treatment is also used for closely related returns such as Back to My Team, Back to Matchup, Back to Matchup Overview, and Back to Playoffs where those controls already existed.

### Historical replay game-history correction

Game Center already displayed the server-authoritative score generated by the historical replay. The full player detail route previously rebuilt its rows from an ordinary season schedule slice, which could diverge from the exact asynchronous roster-slot window and from the replay's source season.

The detail page now subscribes to the same shared scoring snapshot used by Game Center and resolves the selected player in this order:

1. exact immutable `cycleWindowId` in `windowScores`;
2. matching asset summary as a backward-compatible fallback.

For each of the six saved games, the detail page uses the authoritative:

- source NHL game ID;
- simulated matchup date;
- target-schedule opponent label;
- scheduled/live/final state;
- appearance status;
- server fantasy score; and
- immutable roster-slot window association.

During replay, NHL boxscore, play-by-play, and player game-log detail are loaded from the mapped source season while the interface retains the simulated target-season date and opponent. If detailed NHL endpoints are temporarily unavailable, the saved Game Center score remains visible. Any small difference between locally reconstructed category lines and the saved server score is shown as a labeled reconciliation line rather than silently changing the total.

The page listens to both the scoring snapshot and replay control, so advancing the test date while the page is open triggers a refresh.

### Automated verification

Run the complete project verification after replacing the files:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm ci
npm --prefix functions ci

npm run verify:batchm5-1
npm run build:all
```

The focused M5.1 suite verifies:

- immutable window-first score-summary selection;
- preservation of saved dates, states, appearances, and scores;
- source-season resolution for historical replay;
- live subscriptions to scoring and replay state;
- body portaling and exact scroll restoration;
- portal coverage across all recently added modal-style interfaces;
- visual-viewport containment and safe-area behavior;
- the reduced Draft Room sticky surface;
- migration of every Back to League control;
- consistent treatment of related return controls; and
- no changes to production scoring or Cloud Functions.

### Deployment

This is a Hosting-only batch:

```bash
firebase use nhl-fantasy-app-ab673
firebase deploy --only hosting:app -m "Batch M5.1 mobile overlays draft compactness and replay detail"
```

Do not deploy Functions, Firestore rules, or indexes for this batch.

### Post-deployment mobile checks

1. On iPhone Safari, scroll far down Game Center and open a player. Confirm the sheet appears immediately in the visible viewport and starts at its header.
2. Close the sheet and confirm the page returns to the exact prior player and scroll position.
3. Repeat with Draft Enter Now, Available Players Compare Player, My Team Manage, and a roster confirmation.
4. Confirm the bottom navigation and Coach Help never cover the active dialog.
5. In Draft Room, scroll through the player pool and confirm search, filters, sorting, and view tabs scroll away while the compact clock/current-manager bar remains available.
6. Confirm the selected-player Draft action remains reachable without hiding the player card.
7. Visit every league-owned page and confirm the graphic return control is clear, keyboard-focusable, and readable in Rink Dark, Light Ice, and OLED Black.
8. Advance historical replay by one day, open a player with a released game, and confirm the full breakdown uses the same total and six saved games shown in Game Center.
9. Advance another day with the detail page open and confirm it refreshes.
10. Repeat representative checks at 320px, 360px, 390px, and 430px, including landscape orientation and reduced motion.

### Rollback

A Hosting-only rollback to the approved M5–V1 build is safe for competition data because this batch writes no new schema and changes no server authority. The rollback would restore the Safari overlay positioning issue and the older replay-detail reconstruction, so retain M5.1 unless a separate frontend regression is found.

---

## Batch M5–V1 — Mobile Roster Actions and Calm Utility Surfaces

### Scope

This combined beta-finalization batch completes the planned M5 phone task-flow pass for **My Team** and **Available Players**, while beginning the V1 visual-consistency pass on the utility surfaces managers use most often. The changes are client-side only. They do not change roster authority, transaction timing, waiver processing, Production Scoring V3, Projection V11, independent six-game windows, Firestore rules, indexes, or Cloud Functions.

### My Team: one clear Manage action on phones

Occupied active, bench, and Injured Reserve slots now use a full-width **Manage** action at phone widths. Tapping it opens an accessible bottom sheet that shows the selected player or goalie unit, exact roster spot, current matchup points, frozen projection, six-game progress, and any scheduled move already attached to the slot.

The sheet builds its actions from the slot's real state rather than presenting one universal menu. Depending on the area and legal roster state, it can offer:

- View Scoring Detail;
- Find a Replacement;
- Review Scheduled Move;
- Move into Starting Lineup;
- Move to Injured Reserve;
- Activate to Starting Lineup;
- Move to Bench; or
- Drop to Waivers.

Every action explains the consequence before the manager continues. When an action is relevant but temporarily blocked, the sheet explains why—for example, no open Injured Reserve slot, an ineligible injury status, or an existing scheduled move that must be canceled first.

The Injured Reserve action remains hidden for healthy or otherwise ineligible skaters, matching the established roster policy. A bench player already reserved for a scheduled active-lineup swap exposes only **View Scoring Detail** and **Review Scheduled Move**; it cannot be silently replaced, dropped, or reused by a second mobile flow. Available Players also excludes that reserved bench slot from add/drop candidates.

Open active and bench slots now include a direct **Find Player** action. It opens Available Players with the exact position, roster area, and roster-slot ID carried in the URL so the intended slot can be preselected during comparison.

Desktop keeps its existing direct roster controls, while gaining an explicit View Stats button instead of relying on a clickable card containing nested buttons.

### Available Players: focused two-step compare and confirm flow

The main player pool now keeps only the decision information managers need while scanning:

- current-season fantasy points;
- next-six-game projection;
- rest-of-season estimate;
- performance direction; and
- next-six rank when available.

Available players and waiver players are separated into **Available Now** and **Waivers** controls. Search, position, sort mode, selected view, selected player, intended roster slot, and scroll position are preserved in session storage for up to two hours. Malformed, expired, future-dated, or unavailable browser storage is ignored safely. A direct handoff from My Team intentionally starts a fresh roster task rather than reopening an unrelated older comparison. The **Review Scheduled Move** handoff waits for the live roster listener before scrolling and focusing the scheduled-move section, so a slower connection does not lose the destination.

Selecting a player opens the shared action sheet for Step 2. The manager can then:

1. review the incoming player's three primary metrics;
2. expand **Why this projection?** for reliability, schedule, recent form, source, six-game markers, and stat contribution;
3. verify incoming-player eligibility;
4. choose an exact compatible active or bench slot;
5. compare incoming and outgoing season, next-six, and rest-of-season values;
6. read the exact immediate, scheduled, or waiver-contingent activation timing; and
7. confirm from a footer that remains reachable while the comparison content scrolls.

A preferred slot opened from My Team is selected automatically only when that exact slot is still a legal candidate. The manager can clear it and choose another without losing the selected player.

### Pending-operation navigation protection

My Team and Available Players now share a route guard for roster writes. While a roster move, waiver action, Injured Reserve change, bench swap, player drop, or related team save is awaiting the server:

- in-app navigation is denied;
- browser Back, refresh, tab close, and window close invoke the pending-operation warning; and
- a full-page confirmation shield explains that the page should remain open.

The shared action sheet also refuses to close while the operation is in progress, preventing a manager from accidentally submitting a duplicate or believing a move failed before the server responds.

### Shared accessible action sheet

A reusable `app-action-sheet` component now provides:

- a centered dialog on larger screens;
- a full-width bottom sheet on phones;
- semantic dialog and modal attributes;
- keyboard focus containment;
- Escape and backdrop dismissal when safe;
- focus restoration;
- background-page scroll locking while the sheet is open;
- a fixed action footer;
- safe-area spacing; and
- reduced-motion support, including a non-animated pending indicator when reduced motion is requested.

The component is used by both My Team and Available Players so future mobile roster actions can follow the same interaction pattern.

### V1 visual restraint: first pass

The first V1 pass focuses on the repeated utility surfaces in My Team and Available Players:

- repeated cards and roster panels use one-pixel borders and fewer stacked shadows;
- phone roster sections become simple one-column rows;
- team colors remain accents rather than competing with names, scores, and actions;
- projected comparison panels use existing semantic design tokens rather than new page-specific colors;
- the readable Barlow Condensed interface font remains high priority; and
- decorative Pixelify Sans and Silkscreen font stylesheets load asynchronously with a no-script fallback.

This is intentionally not a full-site restyle. It establishes the calmer pattern on the two roster-management pages before the later V1 contrast and consistency sweep expands it across the remaining utility surfaces.

### Competitive architecture preserved

This batch does not modify:

- Production Scoring V3;
- Projection V11;
- healthy-versus-availability projection handling;
- roster or waiver Cloud Functions;
- immediate or scheduled add/drop behavior;
- active/bench/IR transaction authority;
- the immutable six-scheduled-team-game window owned by every starting roster slot;
- seventh-game rollover;
- standings, playoffs, or historical replay;
- Firestore rules or indexes; or
- persisted Firestore schemas.

The browser still delegates every competitive write to the existing server-authoritative services. M5 changes how managers choose and understand an action, not how the action is judged or executed.

### Automated verification

After replacing the project files:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm ci
npm --prefix functions ci
npm run verify:batchm5-v1
npm run build:all
```

The focused M5–V1 suite verifies:

- legal action construction for active, bench, Injured Reserve, and open roster slots;
- scheduled-move protection for both active slots and reserved bench sources;
- safe My Team-to-Available Players roster-target parameters;
- mobile task-state validation and expiration;
- exact preferred-slot matching;
- route-parameter validation;
- one-action mobile roster rows without nested clickable cards;
- Available Now and Waivers tabs;
- the compare-and-confirm sheet, projection explanation, add/drop comparison, and timing explanation;
- shared dialog accessibility and phone bottom-sheet behavior;
- route and browser-exit protection during roster writes;
- interface-versus-decorative font loading priority;
- calm one-pixel utility surfaces using semantic tokens; and
- preservation of scoring, Projection V11, Firestore rules, indexes, and the entire Functions tree.

### Manual mobile checklist

#### My Team

1. Test occupied LW, C, RW, D, goalie, bench, and Injured Reserve slots at 320px, 360px, 390px, and 430px.
2. Confirm each occupied phone row has one full-width Manage action and no tiny competing roster buttons.
3. Open each Manage sheet and confirm the correct player, roster spot, score, projection, and six-game count.
4. Confirm an active slot with a scheduled move shows Review Scheduled Move and prevents an unsafe direct drop.
5. Test a healthy skater, IR-eligible skater, ineligible skater, goalie unit, bench player, and IR player; verify only relevant actions appear and blocked actions explain why.
6. Open an empty starting slot and an empty bench slot; confirm Find Player opens Available Players with the intended slot visible.
7. Begin a bench swap, IR move, activation, or drop and immediately attempt in-app navigation, browser Back, refresh, and tab close. Confirm the page remains protected until the server responds.
8. Confirm desktop View Stats and existing direct controls still work.

#### Available Players

1. Switch between Available Now and Waivers and confirm the count, filter, and search results match the selected tab.
2. Search, filter, sort, and scroll deep into the player list; select a player, then choose Change Player. Confirm the list returns to the prior state and scroll position.
3. Select a normal free agent and a waiver player. Confirm each opens the same two-step sheet with the correct Add or Claim wording.
4. Expand Why this projection? and verify the reliability, schedule, form, source, six-game markers, and stat breakdown remain readable.
5. Confirm a My Team handoff preselects only the intended compatible roster slot.
6. Compare an incoming player against an occupied active slot, open active slot, occupied bench slot, and open bench slot.
7. Verify the timing panel distinguishes immediate, scheduled, bench ownership, and waiver-contingent activation.
8. Start a roster move or waiver claim, then attempt duplicate confirmation, sheet dismissal, in-app navigation, browser Back, refresh, and tab close.
9. Complete a successful move and confirm the sheet closes, the list state returns, and the preferred target clears.
10. Repeat in Rink Dark, Light Ice, OLED Black, reduced motion, landscape orientation, and 200% text zoom.

### Deployment

This is a Hosting-only release:

```bash
firebase use nhl-fantasy-app-ab673
firebase deploy --only hosting:app -m "Batch M5-V1 mobile roster flows and visual restraint"
```

No Functions, Firestore rules, indexes, or data migration should be deployed for this batch.

### Rollback

A Hosting rollback to the approved M3–M4 build is safe. M5–V1 does not introduce a Firestore schema field or change any server-side transaction behavior.

---

## Batch M3–M4 — Mobile Live Draft Resilience and Game Center Experience

### Scope

This combined beta-finalization batch completes the planned M3 Draft Room phone pass and M4 Game Center phone pass together. The work is intentionally limited to client-side presentation, listener health, action confirmation, and matchup explanation. It does not modify scoring, Projection V11, draft authority, roster authority, six-game-window ownership, Cloud Functions, Firestore rules, or indexes.

### M3: Draft Room mobile focus and connection safety

#### Focused phone navigation

At phone widths, the Draft Room now presents three explicit views:

- **Players** — the searchable player pool and the selected-player action.
- **Queue** — the manager's private ordered queue, including entries that have become unavailable.
- **Roster** — the manager's current starter and bench construction.

A sticky live command bar keeps the current pick, team on the clock, server clock, connection state, and commissioner clock control visible. The existing recent/upcoming pick rail remains available but is reduced so it does not dominate the phone screen.

Selecting a player on mobile no longer requires drafting from a small button inside a dense card. Selection opens a fixed action bar showing the player, legal roster destination, and one primary Draft action. Desktop behavior remains available through the original card action.

#### Server-confirmed connection state

Draft, pick, and queue listeners now expose Firestore snapshot metadata and listener errors. Competitive actions remain disabled until all three critical streams have delivered a fresh server-confirmed snapshot after the current connection checkpoint.

The interface distinguishes:

- **Connecting** — waiting for the first confirmed snapshot.
- **Connected** — draft state, picks, and queue are server-confirmed.
- **Reconnecting** — listeners are being restored after an error, internet return, or manual retry.
- **Draft view may be stale** — the page resumed after being backgrounded but has not received a fresh server snapshot within the safety window.
- **Offline** — internet access is unavailable and competitive actions are paused.

The Draft Room revalidates after the browser returns online and after a phone or browser tab has been hidden for at least ten seconds. A Retry Connection control restarts all critical listeners without requiring a full page refresh.

#### Pick submission confirmation

A manual pick now has separate **Submitting** and **Confirming** phases:

1. The callable Function must accept the requested pick.
2. The live pick listener must then return the same overall pick, owner, and asset.
3. Only after that matching server snapshot arrives does the interface unlock and announce the confirmed selection.

While either phase is active:

- Duplicate Draft actions are blocked.
- In-app route navigation is denied by a `canDeactivate` guard.
- Refreshing or closing the page invokes the browser's pending-operation warning.
- A full-screen status shield explains that the page should remain open.

A slow listener response triggers a reconnect attempt rather than silently allowing another selection. If the callable succeeds but the live board cannot be confirmed after the extended recovery window, drafting remains blocked until the manager refreshes the live connection.

#### Queue and Auto-Draft transparency

The queue no longer silently removes every unusable entry from view. It identifies why an entry cannot currently be selected, including:

- Already drafted.
- Starting position and bench are full.
- Bench selection is reserved until the starting lineup is complete.
- No legal roster destination.
- Player data could not be loaded.

After an automatic selection, a visible notice distinguishes a queue-based pick from the highest-ranked legal fallback and explains whether the clock expired or Auto-Draft was already enabled. The latest explanation remains visible while later managers pick, and a dismissal is remembered for that manager and league so it does not reappear after a refresh. A newly reset draft clears stale dismissal state when its new pick sequence begins.

### M4: Game Center mobile live-lineup redesign

#### Three owner-relative views

The mobile matchup lineup now has three focused modes:

- **My Team**
- **Head-to-Head**
- **Opponent**

For a manager viewing someone else's matchup, the first and third labels use the actual team names. The underlying desktop team selector remains unchanged; the mobile controls update the same existing `matchupView` state.

#### Calm lineup hierarchy

The phone layout keeps the existing sticky score and matchup-finish information, then presents a compact team/progress context followed by collapsible position sections:

- Forwards — LW, C, and RW
- Defense — D
- Goalie Unit — G
- Bench — collapsed by default and clearly labeled non-scoring

Head-to-Head mode uses compact paired player rows. Single-team modes use full-width rows with more room for names, status, projection, progress, and the six game markers. No additional large duplicate matchup-overview card was introduced.

#### Six-game detail sheet

Tapping a starter opens an accessible mobile bottom sheet with:

- Team, player, NHL team, and position.
- Current score and frozen matchup projection.
- Projection V11 likely range when available.
- Six-game progress and current roster-slot status.
- A separate explanation for every one of the six scheduled NHL team games.

Each game explanation identifies whether:

- The player appeared and the fantasy points counted.
- The NHL team played but the player did not appear, producing zero while still using one scheduled team game.
- The game is live and points may change.
- The game is upcoming.
- The asynchronous roster-slot schedule is still pending.

The sheet traps keyboard focus, supports Escape to close, restores focus to the triggering player, respects reduced motion, and provides a direct route to the existing full scoring breakdown.

Tapping a bench player opens a simpler sheet that explains that bench players do not score until entering a starting slot at a legal roster boundary.

### Competitive architecture preserved

This batch leaves the following behavior unchanged:

- Each starting roster slot owns an independent immutable six-scheduled-team-game window.
- A player's seventh scheduled NHL team game belongs to that slot's next matchup, even when other slots remain in the prior matchup.
- A queued transaction does not rewrite a window that has already started.
- Future lineup previews continue to use the correct current or scheduled incoming player.
- Draft order, draft clock, pick validation, Auto-Draft selection, scoring, Projection V11, waivers, roster moves, standings, playoffs, and historical replay remain server-authoritative.
- No Cloud Function, Firestore rule, Firestore index, or data migration is included.

### Automated verification

After replacing the project files:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm ci
npm --prefix functions ci
npm run verify:batchm3-m4
npm run build:all
```

The focused M3–M4 suite verifies:

- Connected, connecting, reconnecting, stale, and offline draft states.
- Persistent, dismissible Auto-Draft explanations for queue and ranked fallback selections.
- Owner-relative My Team, Head-to-Head, and Opponent mapping.
- Forward, defense, and goalie grouping.
- Played, missed, live, upcoming, and pending six-game explanations.
- Firestore listener metadata and error callbacks.
- Mobile Draft Room tabs, sticky actions, queue reasons, duplicate-pick shield, route guard, and browser-exit warning.
- Mobile Game Center perspective controls, accordions, collapsed bench, six markers, accessible detail sheet, and reduced-motion behavior.
- Preservation of Production Scoring V3, Projection V11, Firestore rules, indexes, and the complete Cloud Functions tree.
- Raw component-style sizes below the configured 45 kB ceiling.

### Manual mobile checklist

#### Draft Room

1. Test at 320px, 360px, 390px, and 430px in Mobile Safari and Mobile Chrome.
2. Confirm the sticky command bar always shows the correct team, pick number, timer, and connection state.
3. Switch repeatedly among Players, Queue, and Roster; confirm no horizontal page scrolling and that each view preserves its data.
4. Search and filter, scroll deep into the pool, select a player, and confirm the fixed Draft action remains reachable above the bottom navigation.
5. Submit a pick and immediately try another Draft button, in-app navigation, browser Back, refresh, and tab close. Confirm the first pick remains protected until the matching live snapshot arrives.
6. Background the browser for at least ten seconds, return, and confirm the page temporarily blocks actions until the fresh server snapshot arrives.
7. Disable Wi-Fi during the draft. Confirm Offline appears, actions are blocked, and the page recovers after internet access returns.
8. Force or observe a listener error and test Retry Connection.
9. Put drafted players, position-full players, and otherwise illegal choices in the queue; confirm each remains visible with an accurate reason.
10. Allow the clock to expire with a legal queue choice and without one; confirm each resulting Auto-Draft explanation is accurate.
11. Confirm commissioner Pause/Resume and manager Start Clock remain available in the mobile command bar only when legal.
12. Repeat the flow in Rink Dark, Light Ice, and OLED Black with reduced motion and 200% text zoom.

#### Game Center

1. Confirm the existing sticky score bar still shows current score, projection/progress, matchup number, and exact or pending finish date.
2. Switch among My Team, Head-to-Head, and Opponent as both Team A and Team B managers.
3. Confirm Forwards, Defense, and Goalie Unit open by default while Bench starts collapsed.
4. Check long player and team names at 320px without horizontal page scrolling.
5. Open a starter detail sheet and test Close, backdrop click, Escape, keyboard focus containment, and focus restoration.
6. Verify all six marker explanations against one player with appearances, one missed scheduled team game, one live game, and upcoming games.
7. Confirm a missed appearance explicitly says that the NHL team game still uses one of the six scheduled roster-slot games.
8. Open a future matchup with a queued add/drop. Confirm the incoming player appears, the schedule is described as planned or scheduled, and no outgoing points or markers are inherited.
9. Open overlapping matchups where some roster slots are in Matchup N and others are in Matchup N+1; confirm every row retains its own correct immutable state.
10. Open a bench player and confirm the sheet identifies the slot as non-scoring rather than presenting starter game markers.
11. Use **Open full scoring breakdown** and confirm the existing detailed page opens for both starters and bench players.
12. Repeat in all three display themes, reduced motion, landscape orientation, and 200% text zoom.

### Deployment

This is a Hosting-only release:

```bash
firebase use nhl-fantasy-app-ab673
firebase deploy --only hosting:app -m "Batch M3-M4 mobile live draft and Game Center"
```

No Functions, Firestore rules, indexes, or data migration should be deployed for this batch.

### Rollback

A Hosting rollback to the approved F1.1 build is safe. The M3–M4 package does not write new schema fields or change server behavior. Existing drafts, picks, queues, roster windows, scores, and projections remain compatible.

---

# RinkRat Fantasy — Project Documentation

_Consolidated 2026-08-03._

## Batch F1.1 — Projection V11 Accuracy and Matchup Build Hotfix

### Purpose

Batch F1.1 fixes the Angular production-build failure reported after Batch F1 and upgrades the shared projection model from V10 to V11. The projection work is intentionally general rather than player-specific: there is no hard-coded Cutter Gauthier adjustment or manual player override. Every skater and team-goalie unit is evaluated through the same versioned browser and Cloud Functions implementation.

Production Scoring V3 remains unchanged. Projection V11 changes how future performance is estimated; it does not rewrite earned scores, completed matchup results, roster windows, transactions, standings, or playoff outcomes.

### Angular TS2365 build hotfix

The Batch F1 matchup-finish utility compared an ISO date string against a nullable accumulator inside a compact boolean/ternary expression:

```ts
finishDate = !finishDate || resolved.finishDate > finishDate
  ? resolved.finishDate
  : finishDate;
```

Angular's TypeScript 6 compiler narrowed the accumulator's comparison branch to `never`, producing:

```text
TS2365: Operator '>' cannot be applied to types 'string' and 'never'.
```

The utility now uses an explicit null-safe helper and `localeCompare()`:

```ts
function getLaterIsoDate(
  currentDate: string | null,
  candidateDate: string,
): string {
  if (currentDate === null) {
    return candidateDate;
  }

  return candidateDate.localeCompare(currentDate) > 0
    ? candidateDate
    : currentDate;
}
```

ISO `YYYY-MM-DD` dates retain chronological lexical ordering, and the explicit branch avoids the TypeScript narrowing failure. The asynchronous matchup-finish calculation itself is unchanged: the displayed finish remains the latest sixth-game date across all independent active roster slots for both teams.

### Projection V11 — stat-component ensemble

Projection V10 improved completed-season trajectory handling, but it still relied heavily on blended total fantasy-point pace. A total-points blend can overreact to a short run of goals or goalie results, while reacting too slowly to a real role change. Projection V11 forecasts the underlying stat components separately so categories with different repeatability can stabilize at different speeds.

For skaters, the shared model separately estimates:

- average ice time;
- shots on goal;
- hits;
- blocked shots;
- goals;
- assists;
- power-play points;
- short-handed points;
- game-winning and overtime goals; and
- plus/minus, which remains strongly regressed because it is noisy and only affects the defense time-on-ice multiplier in RinkRat scoring.

Ice time, shots, hits, and blocks can respond relatively quickly because they describe role and opportunity. Goals, power-play output, plus/minus, and rare bonuses require more evidence before the current season dominates the projection.

For team-goalie units, V11 separately estimates:

- shots faced per game;
- save percentage;
- win rate; and
- shutout rate.

This prevents a small number of wins, shutouts, or unusually strong save-percentage games from overwhelming the more stable workload and longer-term talent signal.

### Empirical sample stabilization and regression

Every component blends current production, the most recent completed season, the preceding completed season, and a positional prior. The current-season weight grows with the relevant sample rather than using one universal threshold for every statistic.

Examples:

- time on ice begins carrying meaningful current-season weight quickly;
- shots, hits, and blocks stabilize after a moderate sample;
- goals and assists require more games;
- plus/minus, short-handed points, game-winning goals, and overtime goals remain heavily regressed; and
- goalie save percentage is weighted by shots faced rather than only appearances.

The model records its effective current-season and historical weights plus a model-confidence score for inspection in Projection Lab.

### Shooting-percentage regression

Skater goals are no longer projected only from the observed goals-per-game rate. V11 estimates a sustainable shooting percentage from:

1. the player's current shot and goal sample;
2. the two completed-season samples; and
3. a position-level prior.

Most of the goal forecast is then derived from projected shot volume multiplied by the regressed shooting percentage. A smaller direct goal-rate component remains so proven elite finishers are not reduced to the positional average.

This structure can distinguish two players with the same recent goal total:

- a player whose shots and role also increased receives a more durable improvement; and
- a player scoring on an unusually high percentage of limited shots is pulled back more aggressively.

Projection Lab shows the regressed shooting percentage and the estimated goals-per-82 added or removed by the shooting-regression step.

### More realistic assist valuation

The prior aggregate-data fallback valued only 40% of assists as primary and 60% as secondary. That was overly conservative under RinkRat's larger primary-assist value. V11 uses a bounded position estimate of approximately:

- 56% primary assists for forwards; and
- 53% primary assists for defense.

Exact play-by-play assist order remains preferable when available. The revised estimate is used consistently in the browser and server projection mirrors when only aggregate assist totals are available.

### Opportunity-weighted recent form

Short six-game projections should react to a genuine promotion without chasing every hot scoring streak. V11 therefore calculates two recent-form signals:

- **raw form**, containing all recently earned fantasy production; and
- **sustainable form**, preserving shots, hits, blocks, ice time, and most repeatable role value while heavily discounting volatile goals, assists, rare bonuses, and the volatile portion of power-play scoring.

The next-matchup adjustment uses 72% sustainable opportunity/form change and 28% raw scoring change. It continues to require a minimum sample and remains capped. Draft-ranking trend adjustments are more conservative than matchup adjustments.

### Completed-season trajectory retained as a guardrail

The V10 breakout/rising/stable/declining assessment remains in place. V11 uses its age, sample, role, shot, and power-play evidence to establish completed-season weights, then combines the new component forecast with the trajectory-aware total-points forecast.

The component model is the primary signal, but its result is bounded relative to the trajectory model:

- skater draft forecasts are limited to approximately ±15% of the trajectory-aware result;
- team-goalie draft forecasts are limited to approximately ±14%; and
- positive development uplift remains capped.

This protects against bad or unavailable endpoint data while allowing supported young breakouts to move materially above the old fixed 70% / 20% / 10% blend.

A Cutter Gauthier-type profile should now move from a conservative high-50s healthy six-game estimate toward a value closer to the high 60s when the full stat line supports the breakout. The exact value still depends on the saved season data, role, shots, power-play usage, opponent schedule, projection date, and live availability. An exceptional 100-plus-point six-game result remains an upside outcome rather than the mean projection.

### Injuries remain separate from healthy talent

Projection V11 preserves the injury behavior reviewed before this batch:

- missed NHL team games are not inserted as zero-production appearances when estimating healthy talent;
- partial injury games can receive reduced sample weight;
- historical availability modestly affects reliability rather than erasing per-appearance production; and
- live injury status, return timing, and expected appearances are applied after the healthy projection.

The saved asset continues to distinguish:

- `healthyProjectedCyclePoints`; and
- the availability-adjusted `projectedCyclePoints`.

After availability reduces the expected games, V11 recalculates the likely floor, ceiling, and uncertainty around the adjusted mean.

Historical replay continues to use the simulated replay date and ignores present-day injury records, so a current injury cannot reduce an earlier historical projection.

### Likely six-game range

A single mean can make two equally projected players look equally safe even when one is much more volatile. V11 adds a likely six-game range based on:

- the official mean projection;
- recent game-level standard deviation;
- recent sample size;
- player reliability;
- expected available games; and
- position-specific baseline uncertainty.

The mean remains the official value used by matchup projections. The range is explanatory and does not independently change scores or lineup totals.

New optional projection fields include:

- `projectionModelVersion`
- `projectionModelConfidence`
- `projectionPrimaryAssistShare`
- `projectionShootingPercentage`
- `projectionShootingRegressionAdjustment`
- `projectionCurrentSeasonWeight`
- `projectionHistoricalWeight`
- `projectionFloorPoints`
- `projectionCeilingPoints`
- `projectionUncertaintyPoints`
- `sustainableFormAdjustment`
- `recentGameStandardDeviation`

### Browser and Cloud Functions parity

The browser and server use byte-identical copies of:

- `draft-player-pool.service.ts`;
- `draft.models.ts`; and
- `projection-v11.util.ts`.

The shared snapshot version is now `11`, so saved V10 projection pools are treated as stale and regenerated. Newly opened independent roster-slot windows therefore freeze a V11 projection, including schedule, current availability, sustainable form, and the simulated as-of date during historical replay.

A projection refresh failure continues to fall back to the best valid saved data rather than blocking scoring or asynchronous window rollover.

### Projection Lab V11

Projection Lab now exposes the model's most important diagnostics:

- trajectory classification and latest-season weight;
- V11 model confidence;
- current-season versus historical component weight;
- likely six-game floor and ceiling;
- uncertainty estimate;
- sustainable form adjustment;
- shooting-percentage regression;
- primary-assist estimate; and
- healthy versus availability-adjusted next-six projection.

The diagnostics make it possible to determine whether a low value comes from conservative talent regression, an unsustainable finishing rate, an unfavorable schedule, current availability, or ordinary matchup uncertainty.

### Architecture preserved

Batch F1.1 does not change:

- Production Scoring V3 values or formulas;
- any completed score or game ledger;
- the 14 active / 3 bench / 3 Injured Reserve roster structure;
- independent six-game windows per active roster slot;
- seventh-game rollover;
- scheduled transaction activation;
- waivers;
- draft-clock authority;
- standings;
- playoff advancement or game backfill;
- Firestore rules or indexes; or
- manager permissions.

No Firestore data migration is required. All V11 fields are optional and backward-compatible.

### Automated verification

After manually replacing the project files:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm ci
npm --prefix functions ci

npm run verify:batchf1-1
npm run build:all
```

The focused F1.1 suite verifies:

- the exact TypeScript narrowing build defect is removed;
- missed games do not become zero-production appearances;
- hot shooting is regressed toward shot volume and history;
- repeatable opportunity responds faster than finishing luck;
- aggregate assist estimation no longer assumes only 40% primary assists;
- goalie save percentage, wins, and shutouts receive sample-size regression;
- likely ranges expand for volatile, low-confidence players;
- browser and server model files remain identical;
- availability remains separate from healthy talent;
- Projection Lab exposes the new diagnostics; and
- production Scoring V3 files remain unchanged.

### Commit

```bash
git status
git add .
git commit -m "Fix matchup build and add Projection V11"
git push
```

### Deployment

Deploy Functions first so newly opened roster-slot windows and refreshed shared pools use Projection V11:

```bash
firebase use nhl-fantasy-app-ab673
firebase deploy --only functions -m "Batch F1.1 Projection V11"
```

Then deploy the build hotfix and Projection Lab diagnostics:

```bash
firebase deploy --only hosting:app -m "Batch F1.1 projection diagnostics and build hotfix"
```

No Firestore rules or index deployment is required.

### Post-deployment verification

1. Run `npm run build:all` and confirm the former TS2365 matchup-finish error is gone.
2. Refresh the shared projection pool and confirm its metadata reports version 11.
3. Inspect Cutter Gauthier and several comparable young breakouts in Projection Lab V11.
4. Confirm the Development section explains the season weighting rather than using a player-specific override.
5. Compare projected shooting percentage with observed shooting percentage for a hot finisher.
6. Confirm a role/shot increase moves faster than a short goal streak with unchanged opportunity.
7. Confirm a healthy player who missed prior team games still shows six expected games and no historical zero-game penalty.
8. Mark a test player day-to-day or out and confirm the healthy projection remains visible while only the availability-adjusted value and range change.
9. Inspect a volatile forward and a stable defenseman with similar means; confirm their likely ranges differ appropriately.
10. Advance historical replay until a roster slot opens another matchup and confirm the frozen projection is version 11 and uses the replay's simulated date.
11. Confirm the exact matchup-finish card and compact mobile end date still display correctly.
12. Watch for console errors, stale V10 snapshots, clipped Projection Lab columns, or horizontal page overflow outside the intended table scroller.

### Rollback guidance

A Hosting rollback removes the Projection Lab diagnostics and build hotfix, but restoring the Batch F1 file would also restore the TypeScript build defect. For a safe frontend rollback, redeploy a build known to contain the F1.1 date-comparison helper.

Reverting Functions to Batch F1 restores Projection V10 snapshots. Existing version-11 fields are optional, so no data rollback is required. Keeping the F1.1 Functions build is recommended because browser/server parity and regenerated V11 window projections are the intended production state.

---

## Batch F1 — Projection V10, Historical Scoring Calibration, and Matchup Finish Date

### Purpose

This batch completes the next beta-finalization roadmap item after the mobile and beginner-onboarding work. It addresses three related release questions without changing the production competition rules:

1. distinguish a player's healthy production from games missed because of injury;
2. recognize a supported young-player breakout more quickly without chasing one hot week; and
3. measure the current scoring system across a complete historical season before deciding whether any point value should change.

It also adds a prominent Game Center timeline showing when the exact displayed matchup is expected to finish under RinkRat's independent six-game roster-slot model.

### Projection V10 — healthy talent, trajectory, and availability

Projection V10 preserves the strongest parts of Projection V9:

- Player pace is calculated from NHL appearances. A scheduled NHL team game in which the player did not appear is **not** inserted as a zero when estimating healthy talent.
- Current injury availability remains a separate next-six-game adjustment. The saved projection continues to distinguish `healthyProjectedCyclePoints` from the availability-adjusted `projectedCyclePoints`.
- Current-season form, role, opponent schedule, reliability, sample-size caps, and conservative manager-facing calibration remain bounded.
- A short partial game can still be regressed toward the player's normal role rather than being treated as a full poor appearance.
- Team-goalie units retain the established stable multi-season baseline; an individual skater age curve is not applied to the goalie unit.

The V9 completed-season draft baseline was fixed at 70% latest completed season, 20% previous completed season, and 10% conservative positional baseline. That is still the default for stable players. Projection V10 adds a bounded trajectory assessment:

- **Supported breakout:** requires at least 50 appearances, a substantial completed-season pace increase, and either supporting growth in ice time, shots, or power-play production, or an unusually large pace increase. A young supported breakout can use up to an 86% / 11% / 3% completed-season blend.
- **Rising:** requires a meaningful pace increase with a sufficient sample and supporting evidence. A young rising player can use up to an 80% / 15% / 5% blend.
- **Stable:** keeps the existing 70% / 20% / 10% blend.
- **Declining:** gives the more recent completed season additional weight when the decline is established over a meaningful sample.
- **Insufficient data:** keeps the conservative stable baseline. Age alone never creates a breakout classification.

Any positive trajectory uplift is capped. The maximum supported young-breakout increase over the V9 stable result is 10%; other rising/breakout profiles receive smaller caps. This lets a Cutter Gauthier-type profile move materially above a high-50s conservative draft rating when a large full-season jump is supported, while preventing one unsustainable shooting season from becoming the entire projection.

The following explanation fields are now saved with projection assets and shown in Projection Lab V10:

- `draftTrajectoryLabel`
- `draftTrajectoryConfidence`
- `draftTrajectoryAdjustment`
- `draftLatestSeasonWeight`
- `draftPaceChangePercent`

`draftTrajectoryAdjustment` describes the season-level rating change from trajectory. It is not an injury deduction. Projection Lab converts it to a six-game equivalent for explanation while continuing to show healthy and availability-adjusted matchup projections separately.

### Fresh server projections at independent window boundaries

The Cloud Functions projection mirror now performs the full Projection V10 calculation. The previous placeholder implementation deliberately threw and caused the scoring worker to preserve an older saved or draft projection. That fallback protected scoring automation, but it meant a later roster-slot window was not guaranteed to receive a fresh schedule- and injury-aware projection.

At a legal roster-slot boundary, the server now:

1. resolves the exact target matchup number;
2. loads the current league/global availability records for a live league;
3. generates the full skater and team-goalie projection pool;
4. ranks the pool with the same draft-value logic as the browser;
5. writes a versioned Projection V10 snapshot for that target matchup; and
6. freezes the applicable player's value into the immutable roster-slot window.

A failed NHL refresh still does **not** block asynchronous roster advancement. The server uses the best target or current snapshot as a fallback and records a warning, preserving the rule that one roster slot can enter Matchup N+1 while other slots continue Matchup N.

Snapshot freshness now includes the projection context and as-of date, not only elapsed wall-clock time. This matters during historical replay, where many simulated NHL dates can be advanced within a few real minutes. A roster slot opening on a later replay date cannot reuse an earlier-date target-matchup snapshot merely because that snapshot is less than six real hours old. Multiple slots opening on the same simulated date can still share one consistent target-matchup pool.

### Historical replay safety

Historical replay projections are calculated as of the replay control document's `simulatedDate`.

- The replay target season is treated as the current season.
- The replay source season is treated as the latest completed season.
- The preceding completed season remains available for the multi-season baseline.
- Current-season game rows and role/form inputs are filtered to the simulated date.
- Present-day league/global injury records are ignored. A real 2026 injury cannot reduce a player in an earlier simulated matchup.
- Missed appearances continue to affect confidence only modestly and never become artificial zero-point healthy-production games.

This keeps replay projections temporally consistent while allowing the exact earned scoring ledger to continue using the historical source-season results mapped onto the target schedule.

### F1 historical scoring calibration report

Platform administrators can run the new report from `/scoring-test`. It is a read-only browser analysis and does not write Firestore scoring rules, league settings, or score documents.

The report loads one complete NHL regular season and runs each recorded game through the current production scoring engine:

- `calculateSkaterGamePoints()` for skaters;
- `calculateGoalieGamePoints()` for team-goalie units; and
- `calculateGoalieGameBreakdown()` to measure goalie cap behavior.

Every player window is formed from six scheduled NHL team games. A scheduled team game in which the skater did not appear contributes zero to that fantasy window, which matches how an already-rostered player occupies an immutable RinkRat slot. Only complete six-game blocks are included; a final partial block is excluded.

The full-season report includes:

- position counts and six-game distributions;
- P10, P25, median, P75, P90, and P95 outcomes;
- best window, standard deviation, coefficient of variation, and median player volatility;
- starter averages, replacement thresholds, replacement-pool averages, and value above replacement for the selected league size;
- modeled team-goalie share in the 14-slot active lineup;
- team-goalie per-game cap hit count and rate;
- frequency of 100-point-or-higher forward windows;
- defense-versus-comparable-forward separation;
- optional Spearman correlation between a league's saved draft rankings and historical average outcomes; and
- plain-language findings and a keep/review/insufficient-data recommendation.

Two assist modes are available:

- **Fast report:** uses the complete schedule and a deterministic integer estimate for primary versus secondary assist order.
- **Exact assist mode:** reads NHL play-by-play, stores completed game assist order in browser local storage, and resumes from that cache on a later run. If only part of the season is cached, the report clearly labels the result as hybrid.

The report also calculates three candidate rule sets in memory:

- **Current V3** — exact production rules;
- **Star Separation** — a narrow what-if increase to forward goals/primary assists with a reduction to repeatable floor categories; and
- **Lower Goalie Ceiling** — a narrow what-if reduction to goalie cap/save/win values.

These candidates are evidence displays only. **Scoring V3 and the production scoring engine remain byte-for-byte unchanged in this batch.** Review the full report with the user before promoting any candidate rule adjustment.

### Exact displayed-matchup finish date

Game Center now includes a dedicated matchup-finish card directly below the page header, plus a compact end-date line in the mobile score bar.

The calculation follows the asynchronous architecture rather than inventing one league-wide cycle deadline:

- every starting roster slot for both displayed teams is considered independently;
- an already-created immutable slot window uses its saved `scheduledGameDates`;
- an untouched future slot uses the effective current or scheduled incoming player shown by the M2.3 lineup resolver;
- that future slot begins only after the same roster slot's prior six-game boundary;
- the incoming/current player's NHL team schedule supplies the remaining dates; and
- the matchup finish is the **latest sixth-game date across all starting roster slots on both teams**.

The card labels the result as scheduled or projected. It does not present a partial result as definitive. When one slot's prior boundary, player assignment, or NHL schedule is not yet resolvable, it says the finish date is still being calculated and shows how many roster-slot schedules are resolved.

A projected date can move when an NHL game is postponed or a planned starter changes before that slot begins. Once all participating slot schedules are immutable, the card describes the date as the scheduled matchup finish. Completed historical matchups retain the date derived from their frozen six-game schedules.

### Architecture preserved

This batch does not change:

- Scoring V3 point values, diminishing returns, bonuses, or goalie cap;
- the 14 active / 3 bench / 3 Injured Reserve roster structure;
- independent six-game windows per active roster slot;
- seventh-game rollover into that slot's next matchup;
- scheduled add/drop, waiver, bench, or Injured Reserve activation rules;
- frozen projections after a roster-slot window begins;
- standings, playoff advancement, or playoff game banking/backfill;
- Firestore rules or indexes; or
- manager permissions.

No Firestore data migration is required. New projection fields are optional and backward-compatible.

### Automated verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm ci
npm --prefix functions ci
npm run verify:batchf1
npm run build:all
```

The focused F1 suite verifies:

- supported young breakouts receive additional recent-season weight;
- positive trajectory uplift is capped;
- short samples and age alone cannot create a breakout;
- stable players and goalie units retain the conservative baseline;
- missed appearances and current availability remain separate concepts;
- live server Projection V10 generation replaces the former placeholder failure;
- historical replay uses its simulated date and ignores present-day injuries;
- replay snapshot freshness compares the simulated as-of date, not only wall-clock age;
- the F1 report invokes the production scoring engine and remains read-only;
- production Scoring V3 files are unchanged from Batch M2.3;
- the matchup finish is the latest independent sixth-game date;
- unresolved slot paths cannot produce a misleading definitive date; and
- desktop and mobile Game Center surfaces expose the timeline.

### Manual verification checklist

1. Refresh shared projections for a test league and open Projection Lab V10.
2. Inspect a supported young breakout. Confirm Development explains the latest-season weight, pace change, confidence, and bounded adjustment.
3. Confirm `Healthy Matchup` remains above or equal to `Next 6 Games` only when current availability removes expected appearances.
4. Confirm a player who missed prior team games is evaluated from appearances rather than receiving zeroes in healthy pace.
5. Mark a test skater day-to-day or out, refresh, and confirm only the availability-adjusted next-six value changes as expected.
6. During historical replay, advance to a new simulated date and let one roster slot open a new matchup. Confirm the saved snapshot metadata uses that simulated date and `historical-replay` context.
7. Advance another simulated date quickly and open another slot in the same target matchup. Confirm a later-date snapshot is generated rather than reusing the prior date solely because it is less than six real hours old.
8. Confirm no present-day injury record reduces a historical replay projection.
9. As platform administrator, open `/scoring-test`, run the fast full-season report, and export the JSON.
10. Review position distributions, replacement values, goalie share/cap rate, forward ceilings, volatility, and draft-rank correlation before discussing a scoring change.
11. Optionally run exact assist mode and confirm cached progress resumes after cancellation/reload.
12. Confirm the report never changes a league's scoring rules or published scores.
13. Open an active matchup and confirm the finish card is visible directly below the header.
14. Confirm the displayed date equals the latest sixth scheduled game among both teams' 28 active roster slots.
15. Schedule an add/drop for a future matchup and confirm the incoming player's NHL schedule is used for the untouched future slot.
16. Confirm the current matchup still uses the outgoing player's immutable schedule until that slot reaches its legal boundary.
17. Open a matchup with one unresolved future slot and confirm the page says the date is pending rather than showing a partial date as exact.
18. Check the compact `Ends Mon D` line in the mobile score bar at 320px, 360px, 390px, and 430px.
19. Repeat in Rink Dark, Light Ice, and OLED Black and check focus, zoom, horizontal overflow, and console errors.

### Deployment

Deploy Functions first so every newly opened roster-slot window can use Projection V10 server generation:

```bash
firebase use nhl-fantasy-app-ab673
firebase deploy --only functions -m "Batch F1 Projection V10 server window refresh"
```

Then deploy the Projection Lab, historical calibration report, and Game Center timeline:

```bash
firebase deploy --only hosting:app -m "Batch F1 scoring calibration and matchup timeline"
```

No Firestore rules or index deployment is required.

### Rollback guidance

A Hosting-only rollback is safe and does not alter competition data. Keeping the Batch F1 Functions build is recommended because it supplies fresh window-boundary Projection V10 snapshots and replay-date safety. Reverting Functions to Batch M2.3 restores the previous saved-projection fallback behavior; scoring and rollover continue, but later windows are no longer guaranteed to receive a newly generated schedule/injury projection at their boundary. No scoring, roster, transaction, or matchup migration is needed for either direction.

---


## Batch M2.3 — Future Matchup Lineup Integrity and Scoring Review

### Future-lineup display defect corrected

An overlapping future matchup could briefly or permanently display the player who originally occupied a starting roster slot even after that player had been replaced. The displayed identity corrected itself only after the incoming player recorded the first counted NHL game in the new six-game window.

The server-authoritative roster and asynchronous window behavior were not the cause. The Game Center presentation layer combined two sources:

1. immutable cycle roster snapshots for slots already represented in that matchup, and
2. the original draft-pick collection for any slot that had not yet received a new snapshot.

That fallback was safe immediately after the draft but stale after an add/drop. Future matchup documents are intentionally allowed to be partial while roster slots finish their prior six-game windows at different times. Therefore an untouched future slot could continue borrowing the original drafted player until the server created that slot's next immutable window after its first game.

### Manager-facing lineup resolution

Game Center now resolves each persistent active roster slot according to its lifecycle:

- **Started or completed six-game window:** keep the immutable cycle snapshot and its frozen projection, even when the live roster has since changed.
- **Untouched future window:** preview the authoritative current roster assignment.
- **Scheduled add/drop, waiver award, open-slot addition, or active/bench change:** once the viewed matchup reaches the move's requested and eligibility matchup number, preview the incoming player immediately rather than the outgoing player.
- **Move not eligible yet:** continue showing the player who legally owns the earlier matchup window.
- **Authoritative empty slot:** do not resurrect the previously drafted player.
- **Roster listener still loading:** suppress an unlocked stale snapshot rather than flashing the wrong player. If the roster read genuinely fails, fall back to the saved snapshot so the page remains usable.

A scheduled incoming player is labelled **Scheduled move · Matchup N**. A current roster assignment that is waiting for its first game is labelled **Planned starter · Matchup N**.

### Projection integrity

A future-lineup preview is not yet an immutable scoring window. For that reason it:

- clears frozen projection fields inherited from an older player or matchup;
- prefers the latest shared projection for the incoming/current player when one is available for the viewed matchup;
- refreshes when roster, cycle-window, or player-pool projection data changes;
- includes projection values in the effective-lineup cache key so a new projection snapshot cannot be ignored merely because the player identity stayed the same; and
- freezes normally through the existing server path when that roster slot actually begins its six-game window.

When an untouched stale window belongs to the outgoing player, Game Center does not display that outgoing player's schedule markers beneath the incoming-player preview. The immutable window ID and actual scoring history remain unchanged until the server performs the legal slot transition.

### Architecture and deployment impact

This is a browser presentation/projection-integrity correction only. It does not change:

- scoring values or Scoring V3;
- Projection V9 model weights or manager-facing calibration multipliers;
- roster authority, transaction activation, or waiver behavior;
- Cloud Functions;
- Firestore rules, indexes, or schemas;
- asynchronous six-game rollover; or
- playoff banking/backfill.

Deployment is Hosting-only.

### Scoring review conclusion

The two supplied test matchups do not justify a scoring-rule change by themselves. The stronger roster was projected to win both and did win the completed matchup, while the actual margin was narrowed by an injury and an unusually strong individual six-game result. That is desirable fantasy variance rather than evidence that roster strength is absent.

Several current design choices intentionally keep one roster from becoming unbeatable:

- Fourteen scoring starters average out individual differences.
- Forward and defense volume categories create useful floors.
- Defense is deliberately steady through time on ice, blocks, hits, and shots.
- Forward goals and assists use diminishing returns within an NHL game, limiting one explosive night without removing upside.
- One team-goalie unit is important but capped at 28 points per NHL game.
- Projection V9 blends multiple seasons, caps short-term form/role/schedule adjustments, and applies small manager-facing discounts instead of chasing every hot week.

Increasing goal or assist values now would not reliably reward only the better draft. It would also magnify one-week breakout variance, making performances like the Cutter Gauthier test window even more decisive. If future evidence shows insufficient talent separation, the first calibration should be a narrow review of upper-tier projection/ranking compression—not a broad increase to earned scoring.

Recommended evaluation targets for the historical calibration phase are product goals, not claims about current measured performance:

- projected favorite wins roughly 60–70% of ordinary matchups;
- clearly top-quartile versus bottom-quartile lineups win roughly 70–80%;
- upsets remain common enough that lineup management and injuries matter;
- projected margins meaningfully distinguish elite, average, and replacement-level starters without deciding the matchup in advance; and
- position medians, volatility, replacement value, goalie share, and cap frequency remain consistent with the intended forward/defense/goalie identities.

Do not tune from two matchups. Re-evaluate after at least 20–30 completed matchup pairs, and preferably a full historical season, using Projection Accuracy to compare projected margin, actual margin, favorite win rate, mean signed error, mean absolute error, and results by position. Re-run the current test after this future-lineup fix because the outgoing-player display defect could also have made the visible future team projection use the wrong player.

### Automated verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm ci
npm --prefix functions ci
npm run verify:batchm2-3
npm run build:all
```

The focused M2.3 suite verifies:

- queued incoming players appear in their eligible future matchup before their first counted game;
- the same move does not replace the current matchup early;
- active and completed window identities remain immutable;
- stale unlocked snapshots are hidden while live roster data loads;
- a failed roster read falls back safely;
- empty slots do not resurrect old drafted players;
- `eligibleFromCycleNumber` prevents historical roster contamination;
- requested and asset eligibility dates both constrain a scheduled move;
- scheduled game IDs alone do not falsely lock a stale identity;
- future previews refresh from roster, window, and projection changes; and
- Scoring V3 and Projection V9 calibration files remain unchanged.

### Verification completed for the packaged source

The dependency-free verification available in the packaging workspace completed successfully:

- **12/12** focused future-lineup/projection-integrity tests;
- **188/188** available non-emulator, non-draft-authority regression tests;
- focused strict TypeScript type-check for the new pure lineup resolver and its models;
- syntax transpilation of **203 TypeScript files** with zero errors;
- structural parsing of **46 CSS files** with zero errors;
- parsing of **16 JSON/JSONC files** with zero errors; and
- design-system, accessibility, shared-interface, page-interface, competition-interface, mobile-readability, and beginner-language audits.

A complete Angular build, Functions build, Firestore emulator suite, and server draft-authority suite still need to run on the development Mac. The packaging workspace uses Node `22.16.0`, below the root requirement of Node `22.22.3` or newer, and does not contain installed frontend or Functions dependencies.

### Manual regression checklist

1. Queue an add/drop for a starter whose current six-game window is still active.
2. Open the target future matchup before the outgoing player finishes.
3. Confirm the incoming player already occupies that future slot and is labelled **Scheduled move**.
4. Return to the current matchup and confirm the outgoing player remains there with all existing games and points.
5. Cancel the scheduled move and confirm the future matchup reverts to the legal current roster player.
6. Queue the move again and advance through the outgoing player's sixth game.
7. Confirm the incoming player remains in the future matchup after activation and that the label changes from a preview to the normal window state.
8. Confirm the incoming player inherits no games, points, or markers from the outgoing player.
9. Change the shared projection snapshot without changing the player and confirm the future projected total refreshes.
10. Test an empty active slot and confirm an old drafted player does not reappear.
11. Test one active and one untouched slot in the same future matchup; the active slot must preserve its snapshot while the untouched slot follows the current/queued roster.
12. Repeat on desktop and phone, then compare the corrected projected team totals with the original scoring screenshots.

### Deployment

```bash
firebase use nhl-fantasy-app-ab673
firebase deploy --only hosting:app -m "Batch M2.3 future lineup projection integrity"
```

No Function, Firestore-rule, index, or data-migration deployment is required.

### Rollback guidance

A Hosting-only rollback to Batch M2.2 is mechanically safe because this batch performs no writes or schema changes. The old Hosting build will, however, resume showing original/stale players in untouched future matchup slots until their new windows begin.

---

## Batch M2.2 — neutral profile authority, Training Camp polish, and draft-save lock

This hotfix removes the browser Firestore write path that produced a `400` / `Missing or insufficient permissions` failure when a manager selected the neutral `RR` RinkRat identity. Registration, automatic favorite-team changes, and full account-preference saves now use the authenticated `saveManagerProfile` callable. The callable validates the same supported teams and preferences, including `RR`, then writes the private `users/{uid}` profile and display-safe `publicProfiles/{uid}` copy atomically with Admin SDK authority. A narrowly scoped direct-registration fallback remains only for local or staged environments where the callable is not deployed; validation and permission failures are never silently retried through that fallback.

Training Camp roster slots now share the same position accents as the value guide: gold for LW/C/RW, cyan for D, and blue for the team goalie unit. Glossary popovers support start, center, and end alignment; the rightmost goalie definition uses end alignment so the lesson card no longer clips it.

Draft Setup now enters a full-page saving state as soon as **Save Draft Settings** is pressed. Angular route changes are denied by `pendingDraftSaveGuard` while rankings and the draft time are being saved. A `beforeunload` warning covers browser refresh, tab close, and browser-level navigation. The page unlocks automatically after success or failure.

Verification command:

```bash
npm run verify:batchm2-2
npm run build:all
```

Deployment order:

```bash
firebase deploy --only functions:saveManagerProfile -m "Batch M2.2 manager profile authority"
firebase deploy --only firestore:rules -m "Batch M2.2 neutral profile rule refresh"
firebase deploy --only hosting:app -m "Batch M2.2 Training Camp and draft save lock"
```

Batch M2.2 does not introduce a new Firestore schema or index. The packaged rules already contain the `RR` validation added in Batch M2, but they are intentionally redeployed here so a stale production ruleset cannot reject later browser-owned profile updates such as Training Camp completion or identity-unlock persistence.

This file combines the current project context, implementation notes, operational guides, and historical manual test checklists that previously lived as many loose files in the project root.

## Local browser-workflow email safety

Before Batch 6C browser workflows start the Firebase emulators, `npm run prepare:browser-workflows` creates a gitignored `functions/.secret.local` placeholder when needed. Functions running under `FUNCTIONS_EMULATOR=true` log transactional-email intent without contacting Resend. Production Functions continue to require the real `RESEND_API_KEY` secret and send normally.

The headless Chrome launcher also disables background component updates and sync to reduce macOS App Management prompts. If macOS still displays a one-time warning when tests are launched from VS Code, run the same verification command from the standard Terminal app; no App Management permission is required.

## Current project context

```text
RINKRAT FANTASY — CONSOLIDATED PROJECT CONTEXT
Last consolidated: July 2026

PURPOSE OF THIS FILE
--------------------
This is the single handoff/reference file for the RinkRat Fantasy project. It replaces the many old INSTALL, REPORT, MANIFEST, NOTES, DEPLOY_COMMANDS, checklist, and revision files that previously cluttered the project root. A new ChatGPT conversation should read this file before changing the project.

PROJECT IDENTITY
----------------
Application: RinkRat Fantasy
Repository/local path: /Users/StephenH/Documents/Programming/fantasy-hockey
Frontend: Angular 22 standalone application
Backend: Firebase Authentication, Firestore, Firebase Hosting, Cloud Functions v2, Cloud Scheduler, and Cloud Tasks
Firebase project: nhl-fantasy-app-ab673
Firebase Hosting target: app
Firebase Hosting site ID: cycle-puck
Public domain: https://rinkratfantasy.com
Optional redirect domain: https://www.rinkratfantasy.com
Primary Functions region: us-central1
Known working Node version: 22.23.1
Root Node requirement: >=22.22.3 and <23

EMAIL CONFIGURATION
-------------------
Provider: Resend
Sender name: RinkRat Fantasy
Sender address: notifications@rinkratfantasy.com
Reply-to/support: support@rinkratfantasy.com
Secret name: RESEND_API_KEY
Non-secret Functions environment file: functions/.env.nhl-fantasy-app-ab673
Expected values:
  APP_BASE_URL=https://rinkratfantasy.com
  EMAIL_FROM_NAME=RinkRat Fantasy
  EMAIL_FROM_ADDRESS=notifications@rinkratfantasy.com
  EMAIL_REPLY_TO=support@rinkratfantasy.com
Never place the Resend API key in source code, Angular environment files, Firestore, or this text file.

STANDARD LOCAL COMMANDS
-----------------------
Use these from the project root:

  cd /Users/StephenH/Documents/Programming/fantasy-hockey
  nvm use 22.23.1

Install frontend dependencies:
  npm ci

Build frontend only:
  npm run build

Build frontend and Functions:
  npm run build:all

Repair Functions dependencies manually:
  npm run repair:functions

Build Functions only:
  npm --prefix functions run build

The Functions build now checks for firebase-admin, firebase-functions, @types/node, and TypeScript before compiling. If functions/node_modules is missing or incomplete, it automatically runs npm ci inside functions. This prevents the recurring wall of TypeScript errors such as “Cannot find module firebase-admin,” “Cannot find name process,” and “Cannot find name Buffer.”

Full deployment:
  firebase use nhl-fantasy-app-ab673
  firebase deploy --only firestore:rules,firestore:indexes,functions,hosting:app

Frontend-only deployment:
  npm run build
  firebase deploy --only hosting:app

Functions-only deployment:
  npm --prefix functions run build
  firebase deploy --only functions

Important: do not run npm audit fix --force casually. It may introduce breaking dependency upgrades. The current audit warnings do not block builds or deployment by themselves.

CRITICAL FANTASY ARCHITECTURE
-----------------------------
The most important rule is that fantasy cycles are asynchronous at the persistent roster-slot/player-window level. Do not redesign the app around one league-wide cycle start or end timestamp.

Each active roster slot owns an immutable six-NHL-game window. NHL schedules differ, so different assets finish their windows on different dates. When an asset plays its seventh scheduled NHL team game, that game belongs to the next window even if other assets are still completing their previous windows. Several cycle numbers may therefore be active at the same time across one fantasy team.

All future scoring, projections, queued roster moves, standings, playoffs, recovery logic, and Firestore optimization must preserve this model. Use immutable per-slot windows plus the shared NHL game-result ledger. Never discard already-played games simply because a matchup destination was not known yet.

ROSTER CONFIGURATION
--------------------
Starting roster:
  3 LW
  3 C
  3 RW
  4 D
  1 team-based goalie unit
Bench: 3 flexible slots
IR: 3 slots
Starting roster size: 14
Total roster capacity including bench and IR: 20

The goalie asset represents the NHL team goalie unit, not one individual goalie.

SCORING V3
----------
Every roster-slot window contains six NHL team games.

Forward scoring per NHL game:
  Goals: first 6, second 4, additional 2.5
  Primary assists: first 5, second 3.5, additional 2.5
  Secondary assists: first 2.5, second 1.5, additional 0.5
  Shot on goal: 0.75
  Hit: 0.45
  Blocked shot: 0.75
  Power-play point bonus: 1.25
  Short-handed point bonus: 3
  Game-winning goal: 2
  Overtime goal: 2
  TOI multiplier: 0.2

Defense scoring per NHL game:
  Goals: first 4.5, second 2.75, additional 1.5
  Primary assists: first 4, second 2.75, additional 1.5
  Secondary assists: first 1.75, second 1, additional 0.4
  Shot on goal: 0.4
  Hit: 0.55
  Blocked shot: 1.05
  Power-play point bonus: 0.85
  Short-handed point bonus: 2
  Game-winning goal: 2
  Overtime goal: 2
  Defense TOI multiplier is adaptive with base 0.27, plus/minus modifier 0.015, floor 0.24, and ceiling 0.31.

Goalie-unit scoring per NHL game:
  Participation base: 3
  Save: 0.27
  Win: 3.5
  Shutout: 4
  Continuous save-percentage quality model with baseline 0.900
  Save-percentage quality is clamped from -3 to 10
  Maximum goalie-unit fantasy points per NHL game: 28

Scoring rules are frozen in league/cycle records so completed games remain reproducible.

PROJECTION ENGINE
-----------------
Current shared projection version: Projection V9.
Projection snapshots are shared and stored in Firestore. Per-slot window projections are frozen when the window begins.

Drafts must use a verified Projection V9 snapshot. The server must not silently use the old emergency low-value ranking board. A live draft pins the exact verified snapshot ID so the Draft Room and server auto-picks use the same rankings for the full draft.

A valid draft projection must:
  use Projection V9;
  not have generationReason “server-emergency”;
  contain a healthy asset pool;
  be generated for the actual number of participating fantasy teams;
  remain available through the draft.

If the current projection pointer is bad but a healthy recent V9 snapshot exists, the server may restore the healthy pointer. If no verified snapshot exists, the draft should remain stopped rather than make inaccurate selections.

DRAFT SYSTEM
------------
Draft type: snake draft.
The system supports manual picks, queues, auto-draft, timeouts, consecutive-timeout auto-mode, bench filling, and position constraints.

Server-controlled behavior:
  runScheduledDraftAutomation checks drafts on a schedule.
  continueServerDraftAutomation reacts to draft document changes.
  processAutoDraftQueueChange reacts when a manager enables auto-draft.
  processDraftClockDeadline is a Cloud Tasks worker for an exact individual pick deadline.

Important draft safeguards:
  One per-league server lease prevents several workers from processing the same draft simultaneously.
  Temporary Firestore transaction contention is retried.
  Every pick clock receives its own exact Cloud Task.
  A deadline task may make no more than one automatic pick.
  Duplicate or stale tasks verify league ID, pick number, and clock timestamp before acting.
  Auto-picks are paced rather than allowing one worker to make most of the draft in a single burst.
  The minute scheduler remains a recovery mechanism if a task is interrupted.
  Snake-turn consecutive picks must remain valid.

Previous bugs that must not return:
  Firestore error 10 ABORTED caused by several workers contending for the same draft.
  Clock stuck at 0:00 because no exact deadline job existed.
  A single invocation making up to 24 picks and making the draft appear to jump ahead.
  Server emergency rankings placing elite players such as Connor McDavid near 49 projected points.

CYCLE 1 START BEHAVIOR
----------------------
Cycle 1 starts automatically as soon as a draft changes to status complete. The commissioner does not press a Start Cycle button.

initializeSeasonAfterDraft is the immediate Firestore trigger.
runSeasonStartAutomation now runs every minute as a recovery sweep, not as a September calendar gate. It finds completed drafts missing cycle-1 and repairs them.
runScheduledLeagueAutomation continues scoring, cycle progression, standings, and playoff work.

The project still contains default season metadata for 2026-27 and September 29, 2026 at 2:00 p.m. Pacific, but that date must not block Cycle 1 after a completed draft. It remains useful as season metadata and for historical/live configuration.

SERVER AUTOMATION FUNCTIONS
---------------------------
Critical deployed Functions include:
  runScheduledDraftAutomation
  processDraftClockDeadline
  continueServerDraftAutomation
  processAutoDraftQueueChange
  initializeSeasonAfterDraft
  runSeasonStartAutomation
  runScheduledLeagueAutomation
  refreshGlobalPlayerAvailabilityScheduled
  refreshDailyPlayerAvailability
  processQueuedInjuryEmails
  sendInjuryEmailsOnGlobalAvailabilityChange
  sendInjuryEmailOnAvailabilityChange
  sendTestInjuryEmail
  sendWelcomeEmailOnProfileCreated
  requestPasswordResetEmail
  resendVerificationEmail
  applyImmediateRosterMove
  nhlApiProxy
  advanceHistoricalReplayDay

Release Readiness surfaces automation health for commissioners. Scheduled workers write health/status documents under appData.

INJURY DATA AND EMAIL ALERTS
----------------------------
The browser uses same-origin API routes. NHL API routes use /v1 and /stats. ESPN injury data uses /espn/injuries through the server-side proxy; the browser should not contact ESPN directly.

The global player-availability report refreshes server-side. Browser refresh remains an emergency/manual fallback.

Injury email alerts are optional, disabled by default, and require a verified email address. Actionable states include Out, IR, LTIR, Suspended, and Personal Leave.

Availability changes create server-only queue records. processQueuedInjuryEmails runs every five minutes. Messages are batched so nearby alerts for the same owner can be sent together rather than spamming one email per player.

Before sending, the server rechecks that:
  the owner still has alerts enabled;
  the authentication email remains verified;
  the player is still unavailable after league override rules;
  the player remains in an active roster slot;
  no replacement is already queued for that slot;
  the independent slot window still has games remaining;
  the regular-season or playoff window remains actionable.

If the player is in a live NHL game, the alert waits until the game is no longer live, followed by a 15-minute hold. Otherwise it uses a 15-minute hold. Delivery is normally within about five minutes after the hold expires.

The commissioner test email is only a format preview. It sends to the verified commissioner and uses the fictional players Riley Rinkrat and Casey Crease. It does not modify real rosters or queue records.

ADD/DROP, BENCH, AND IR
-----------------------
Roster changes are evaluated against the persistent slot windows, not a global league cycle timestamp.

A roster move may occur immediately when neither involved asset has played a game in its current relevant window. Once either side has begun its window, the move may be queued for the correct next boundary. The UI must explain which player/window delays the transaction.

Moving to IR is only offered when the player is eligible. Injury and suspension indicators appear consistently on My Team, Matchup, and Add/Drop views.

Queued moves and injury replacement logic must preserve the already-counted games in each immutable window.

PLAYOFFS
--------
The app reserves 13 complete fantasy periods, corresponding to the first 78 scheduled NHL games for each NHL team. Regular-season length adjusts to make room for playoffs.

2-3 fantasy teams:
  12 regular cycles, 1 championship cycle.

4-7 fantasy teams:
  11 regular cycles, 2 playoff cycles.
  Semifinals: 1 vs 4 and 2 vs 3.

8-12 fantasy teams:
  10 regular cycles, 3 playoff cycles.
  Seeds 1 and 2 receive byes.
  Opening round: 3 vs 6 and 4 vs 5.

Tied playoff matchups advance the higher seed. The bracket does not reseed. Non-title teams continue classification/consolation games so all teams receive a final placement.

Playoff rounds preserve the asynchronous window philosophy. Assets may begin and accumulate games before the fantasy opponent or bracket destination is known. After the prior round resolves, those games must be backfilled into the championship, third-place, fifth-place, or consolation matchup. Do not discard them or force the player to wait.

STANDINGS AND MATCHUP COMPLETION
-------------------------------
A fantasy matchup finalizes only after the relevant independent roster-slot windows complete. Standings are applied once. Regular-season standings freeze when playoffs begin.

Seeding order:
  1. Win percentage, counting a tie as half a win
  2. Points For
  3. Point differential
  4. Total wins
  5. Stable team-name/owner fallback

LIVE SCORING AND PERFORMANCE
----------------------------
The server owns live scoring and league automation. The target cadence is roughly every ten minutes. Shared control documents and leases prevent duplicate work. Unchanged snapshots should not be rewritten.

Mobile performance is a priority. Avoid adding high-frequency listeners or repeated league-wide reads. Injury data is shared globally rather than fetched independently per league. The scoring/game ledger should be reused across leagues.

BRANDING AND UI
---------------
The site uses a pixel-art hockey theme with the masked RinkRat mascot and a clearer pixel jersey icon. Primary site branding assets are under public/assets/branding and public/assets/pixel-icons.

Favorite NHL team colors are identity accents rather than whole-page backgrounds. The app uses a neutral readable canvas and chooses black/white foregrounds based on contrast.

Background presets:
  Rink Dark
  OLED Black
  Ice Gray
  Light Ice

The favorite team is selected during profile creation and saved to the user profile. Existing profiles without a favorite team fall back to Vegas.

Important UX direction:
  Mobile is as important as desktop.
  Keep status colors clear: upcoming yellow, played green, missed red.
  Keep cycle numbers centered and readable.
  Reduce low-use buttons and dense explanations.
  Do not restore obsolete commissioner Start Cycle controls.
  Account Settings contains the discoverable Email Injury Alerts callout and email icon.

PRODUCTION SAFETY
-----------------
Production runtime configuration is live-only and hides developer controls. Historical replay tools are for development/testing and should not appear in a normal production build.

The full-season simulator is deterministic and should not make NHL requests or Firestore writes. It is regression coverage for roster size, 11-cycle four-team seasons, six-game windows, 7-vs-4 asynchronous advancement, queued moves, immutable projections, scoring leases, standings, and playoff routing.

The Release Readiness page reads existing league and app health. It classifies checks as pass, warning, or fail. A warning immediately after deploying a new scheduled worker can be normal until the first execution.

KNOWN NON-BLOCKING BUILD OUTPUT
-------------------------------
The Angular production build may warn that src/app/features/cycles/cycle-one/cycle-one.css exceeds its configured style budget by several kilobytes. This is currently a warning, not a failed build.

npm audit may report low, moderate, or high dependency vulnerabilities. Do not use npm audit fix --force without reviewing the dependency changes.

FUNCTIONS DEPENDENCY RECOVERY
-----------------------------
The repeated 100+ TypeScript error pattern is not 100 separate source problems. It means the Functions dependency tree is missing or incomplete. Typical errors include:
  Cannot find module firebase-admin/firestore
  Cannot find module firebase-functions/v2/https
  Cannot find name node:crypto
  Cannot find name process
  Cannot find name Buffer
  FirebaseFirestore namespace missing
  Many implicit-any or unknown errors caused by missing imported types

Current prevention:
  functions/package.json has a prebuild dependency check.
  functions/scripts/ensure-dependencies.cjs checks the required packages.
  If they are missing, npm ci runs automatically before tsc.

Manual recovery remains:
  rm -rf functions/node_modules
  npm --prefix functions ci
  npm --prefix functions run build

IMPORTANT SOURCE FILE MAP
-------------------------
Frontend:
  src/app/features/draft/draft-room/ — draft UI
  src/app/features/draft/draft-setup/ — draft schedule and projection preparation
  src/app/features/cycles/cycle-one/ — cycle/matchup UI
  src/app/features/leagues/league-detail/ — league home and navigation
  src/app/features/account/account-settings/ — profile, themes, and email-alert preference
  src/app/core/release/release-readiness.service.ts — health/readiness checks
  src/styles.css — global visual tokens and shared styling

Functions:
  functions/src/draft-automation.ts — scheduled draft opening, leases, Cloud Tasks deadlines, auto-picks
  functions/src/league-automation.ts — Cycle 1 creation, scoring/cycle progression, recovery, playoffs
  functions/src/email-notifications.ts — account emails, injury queue, Resend delivery, test preview
  functions/src/index.ts — API proxy and global injury refresh
  functions/src/roster-moves.ts — immediate/queued roster move server logic
  functions/src/season-config.ts — season metadata/defaults
  functions/src/shared/core/ — shared scoring, projection, roster, cycle, playoff, and Firebase compatibility logic

Firestore and deployment:
  firestore.rules
  firestore.indexes.json
  firebase.json
  .firebaserc
  functions/package.json
  functions/package-lock.json
  functions/.env.nhl-fantasy-app-ab673

TROUBLESHOOTING COMMANDS
------------------------
List deployed Functions:
  firebase functions:list

Selected logs:
  firebase functions:log --only runScheduledDraftAutomation
  firebase functions:log --only processDraftClockDeadline
  firebase functions:log --only continueServerDraftAutomation
  firebase functions:log --only runSeasonStartAutomation
  firebase functions:log --only runScheduledLeagueAutomation
  firebase functions:log --only refreshGlobalPlayerAvailabilityScheduled
  firebase functions:log --only processQueuedInjuryEmails

Confirm Resend secret exists without printing its value:
  firebase functions:secrets:get RESEND_API_KEY

Verify same-origin API routes after deployment:
  curl -I https://rinkratfantasy.com
  curl -sS https://rinkratfantasy.com/v1/roster/VGK/current | head
  curl -sS https://rinkratfantasy.com/espn/injuries | head

CURRENT HANDOFF STATUS
----------------------
The project includes:
  server-controlled draft opening and exact deadline tasks;
  per-league draft automation leases;
  verified Projection V9 draft rankings with a frozen snapshot;
  automatic Cycle 1 creation immediately after draft completion;
  minute-by-minute Cycle 1 recovery;
  scheduled scoring/cycle/playoff automation;
  server-side global injury refresh;
  queued and batched injury emails through Resend;
  Release Readiness health checks;
  RinkRat branding, favorite-team accents, and neutral background themes;
  five selectable identity packs for every current NHL club;
  ten selectable RinkRat manager profile icons with sitewide account-avatar usage;
  global challenge rewards that permanently unlock away, retro, alternate, and special identities;
  custom league emblems selected during league creation, with eight pixel-art designs and eight
  color variants per design;
  automatic Functions dependency repair before TypeScript compilation.

When beginning work in a new chat, provide the current full project ZIP and tell the assistant to read RINKRAT_PROJECT_CONTEXT.txt first. The ZIP is the source of truth if this file and implementation ever disagree.

=====================================================================
TEAM LOGO + COLOR IDENTITY VARIANTS AND CHALLENGE REWARDS (JULY 2026)
=====================================================================
User profiles store:
  favoriteTeamAbbreviation
  favoriteTeamVariantId
  teamIdentityUnlocks

Every current NHL club has five identity choices generated by the central catalog:
  Current Home — available immediately.
  Current Away — ice-white presentation with team-color accents.
  Retro/Heritage — a historical franchise identity and period-style colors.
  Alternate — an alternate crest or alternate uniform-inspired palette.
  Special — an additional reverse-retro, color-rush, outdoor, or creative heritage identity.

Identity reward tiers unlock globally, not only for the currently selected club:
  First Line Change — join a fantasy hockey league — unlocks Current Away for every team.
  Commissioner Mode — create or manage a league — unlocks Retro/Heritage for every team.
  League Explorer — compete in three leagues — unlocks Alternate for every team.
  Crowded Schedule — face at least ten fantasy opponents — unlocks every Special identity.

Unlock behavior:
  Unlocks are calculated from the manager's league summaries when Account Settings loads.
  Newly earned tiers are saved permanently in users/{uid}.teamIdentityUnlocks.
  Once saved, an unlock remains available even if the manager later leaves a league.
  Existing accounts require no manual migration; absent unlock data is treated as an empty list.
  A saved variant that is not unlocked falls safely back to current-home.
  Firestore rules allow no more than the four known reward strings.

Account-page behavior:
  Select a favorite club first, then choose among its five identity cards.
  Locked cards remain visible and show the challenge required to open them.
  The Trophy Shelf shows each challenge and its global identity reward.
  Selecting an unlocked identity saves immediately and updates the app theme.
  Account-page logo images fall back to the club's current NHL crest if a future asset fails.
  Historical identities use curated exact NHL archive filenames rather than guessed season ranges.
  Alternate identities without a verified alternate crest reuse the current crest while preserving
  the selected alternate uniform-inspired color palette.

The selected identity controls:
  sitewide CSS color variables;
  dashboard and account visuals;
  My Team and favorite-team logo displays;
  matchup/opponent identity data;
  local theme storage and the Firestore user profile.

Important source files:
  src/app/shared/pixel-theme/pixel-theme.data.ts
    - all 32 club palettes, 160 total identity entries, reward metadata, and verified logo URLs
  scripts/validate-team-logo-urls.mjs
    - checks all current and archived NHL logo URLs and fails on any unreachable asset
  src/app/core/user/user-theme.service.ts
    - validates unlocks before applying or restoring a selected identity
  src/app/core/user/user.service.ts
    - profile types and identity-unlock persistence
  src/app/features/account/account-settings/
    - team picker, locked cards, achievements, and challenge calculations
  firestore.rules
    - validates favoriteTeamVariantId and teamIdentityUnlocks

New identity packs should be added centrally in SPECIAL_TEAM_VARIANTS. Each club currently has
one heritage, one alternate, and one special definition in addition to the universal home/away
pair. Keep variant IDs stable because they are stored in user profiles. Never construct historical
logo URLs by guessing a season range or appending _alt.svg. Add an exact archivedLogo filename
that has been verified against the NHL logo archive, then run `npm run validate:team-logos`.

============================================================
CUSTOM LEAGUE EMBLEMS AND COLOR VARIANTS (JULY 2026)
============================================================
League documents now store:
  leagueLogoId
  leagueLogoPaletteId

The league creator selects one of eight high-resolution pixel-art emblems and one of eight color
variants. This provides 64 combinations without allowing arbitrary uploaded URLs. Existing league
documents require no migration; missing or invalid values fall back to the Rink Rat emblem in the
Rink Gold palette.

The selected emblem appears:
  on each league card on the Dashboard;
  beside the league name on the Current League page.

Important source files:
  src/app/shared/league-logo/league-logo.data.ts
    - stable emblem IDs, palette IDs, display names, safe normalization, and asset paths
  public/assets/league-logos/{leagueLogoId}/{leagueLogoPaletteId}.png
    - 256x256 transparent pixel-art assets; eight designs by eight palettes
  scripts/validate-league-logo-assets.mjs
    - verifies that all 64 local PNG combinations exist and remain 256x256
  src/app/features/leagues/create-league/
    - emblem picker, palette picker, and live preview
  src/app/core/league/league.service.ts
    - persists selections and includes them in league summaries
  src/app/features/dashboard/
    - displays the selected emblem on league cards
  src/app/features/leagues/league-detail/
    - replaces the old generic rat title icon with the selected league emblem

Keep leagueLogoId and leagueLogoPaletteId values stable because they are stored in Firestore.
When adding an emblem or palette, add every matching asset combination so the central path helper
can always resolve to a real file, then run `npm run validate:league-logos`.

=====================================================================
LEAGUE-SPECIFIC PROFILE PICTURES (JULY 2026)
=====================================================================
Profile pictures are NOT global user-account settings. They belong to the manager's identity
inside one specific league and are stored on both league-owned identity documents:
  leagues/{leagueId}/members/{uid}.profileIconId
  leagues/{leagueId}/teams/{uid}.profileIconId

The catalog contains 35 optimized 512x512 WebP assets in three sections:
  Rink Rats — 10 original player and goalie characters.
  Jerseys — 15 standalone fictional sweaters with no NHL branding.
  Misc Hockey — 10 hockey references including a referee, ice resurfacer, goalie mask, skates,
  crossed sticks, visor helmet, goal light, goalie gear, championship cup, and bench gear.

Every asset has a transparent background. ManagerAvatar also has no border, background, shadow,
or glow, so only the pixel artwork appears beside a name.

League behavior:
  - Creating a league assigns the commissioner a random picture from all 35 choices.
  - Joining a league for the first time assigns that membership a random picture from all 35.
  - Rejoining preserves the picture already saved for that league.
  - Opening a legacy league membership without a valid picture assigns and saves a random one.
  - A manager can choose a different picture from the Your Team card on the Current League page.
  - Changing the picture affects only that league and does not change the manager's other leagues.

The Dashboard and global Account Settings page intentionally do not show or edit a manager
profile picture. Account Settings still controls global username, favorite NHL team, theme, and
other account preferences. User documents may contain a legacy profileIconId from an older build,
but current code ignores it and Firestore rules no longer allow it to be edited as a global field.

Within league context, the saved league picture appears next to manager/team identities in the
Current League page, My Team, team lists, draft setup, draft room, standings, schedule preview,
cycle matchups, matchup overview, point leaders, and playoff bracket/placements.

Important source files:
  src/app/shared/profile-icon/profile-icon.data.ts
    - all 35 stable IDs, categories, metadata, random selection, seeded display fallback, and lookup
  src/app/shared/manager-avatar/manager-avatar.ts
    - reusable transparent profile-picture component for league manager/team labels
  public/assets/profile-icons/
    - ten transparent Rink Rat assets
  public/assets/profile-icons/jerseys/
    - fifteen transparent fictional standalone jersey assets
  public/assets/profile-icons/misc-hockey/
    - ten transparent equipment and rink-reference assets
  src/app/features/leagues/league-detail/
    - categorized league-only picker in the Your Team card
  src/app/core/league/league.service.ts
    - random assignment, legacy repair, league-only persistence, and manager-name synchronization
  src/app/core/team/team.service.ts
    - team identity fields and stable read fallback
  src/app/core/auth/auth.service.ts
    - no longer creates a global user profileIconId
  src/app/features/dashboard/
    - deliberately contains no profile-picture display or picker
  src/app/features/account/account-settings/
    - deliberately contains no global profile-picture picker
  firestore.rules
    - exact 35-ID allowlist for league member/team identity writes; global user icon edits blocked
  scripts/validate-profile-icon-assets.mjs
    - recursively validates all 35 mobile-friendly WebP assets

Validation command:
  npm run validate:profile-icons

Keep IDs stable because they are stored in league member and team documents. New future categories
should be added centrally to profile-icon.data.ts, mirrored in the Firestore allowlist, and added
to the asset validator.

THEME CONTRAST AND MATCHUP IDENTITY UPDATE (JULY 28, 2026)
---------------------------------------------------------
Theme-aware compatibility rules now keep legacy draft headings, labels, controls, and cards readable across Rink Dark, OLED Black, Ice Gray, and Light Ice. The global navigation intentionally remains a dark navy bar in every background preset so the white RinkRat Fantasy brand and navigation labels always retain strong contrast.

The detailed Cycle matchup header now displays each manager's selected NHL identity logo, selected variant label, and a three-color identity strip. The logo follows the exact current, away, retro, alternate, or special identity selected on the account page. The color strip makes home and away identities visibly different even when both managers choose the same NHL team and therefore share the same primary crest. The selected palette also lightly tints that manager's matchup summary while roster content remains on readable neutral surfaces.


ADD/DROP DECISION CENTER AND LIGHT ICE CONTRAST (JULY 28, 2026)
----------------------------------------------------------------
The global NHL logo ribbon remains a fixed dark presentation in every background theme so its white team abbreviations never disappear on Light Ice. The Free Agents page also uses a stable dark decision surface across all themes, including its search, position, sort controls, roster-slot cards, and comparison panels.

Shared projection version 9 adds manager-facing add/drop decision data to each skater and goalie-unit asset: current-season fantasy points, rest-of-season estimate, estimated final total, expected points to date, over/under projection values, current NHL-team six-game cycle number, six played/missed/upcoming game markers, and a category-by-category point breakdown. A green marker means the player appeared, red means the NHL team played while the player missed, and yellow means the game is upcoming.

The Free Agents page now supports sorting by next-cycle projection, season points, rest-of-season estimate, final outlook, projection performance, or reliability. Expandable details show recent fantasy pace, reliability, schedule difficulty, expected availability, sample size, projection source, and scoring breakdown. The roster-slot step also compares the incoming player directly with the selected outgoing player and calculates the projected next-cycle and rest-of-season gain or loss. Mobile keeps the core metrics visible and places lower-priority detail inside expandable sections.

Important files:
  src/app/core/draft/draft.models.ts
  src/app/core/draft/draft-player-pool.service.ts
  src/app/core/projection/projection-snapshot.service.ts
  src/app/features/free-agents/free-agents.ts
  src/app/features/free-agents/free-agents.html
  src/app/features/free-agents/free-agents.css
  src/styles.css
  ADD_DROP_DECISION_CENTER_UPDATE.txt

CURRENT-SEASON ADD/DROP STAT DROPDOWN (JULY 28, 2026)
------------------------------------------------------
- Add/Drop expandable player details no longer explain projection construction.
- Free-agent, waiver, incoming, and outgoing dropdowns show current-season NHL
  stat totals and the fantasy-point contribution from each scoring category.
- Each dropdown ends with a clear current-season fantasy total.
- Projection comparison metrics remain visible on the main card outside the
  dropdown so the dropdown can stay focused on actual production.

=====================================================================
RINKRAT VISUAL SYSTEM PHASE 2A — PAGE IDENTITIES (JULY 2026)
=====================================================================
Phase 2A gives the Dashboard, Current League page, and Draft Room distinct visual
identities on top of the Phase 1 arena foundation. The Dashboard is an arcade
league-select/save-file screen, Current League is a franchise front office, and
Draft Room is an arena jumbotron with a scouting terminal and GM desk.

The implementation is presentation-only in src/rinkrat-page-identities-phase2.css,
loaded after src/rinkrat-visual-system.css through angular.json. It does not change
Firestore, league logic, draft logic, roster rules, scoring, projections, or the
asynchronous six-game cycle architecture. Team colors remain controlled accents,
not unsafe whole-card text/background combinations. Mobile and Light Ice support
are included. No rat-tail divider is used.

=====================================================================
DRAFT START, AUTO-DRAFT, AND LEGACY MEMBERSHIP FIX (JULY 2026)
=====================================================================
- Firestore draft and pick reads now recognize legacy league team documents even
  when they predate the ownerId field. Commissioner access is also explicit.
- Browser and Cloud Functions now agree on Shared Projection Version 9. The old
  server-side Version 8 requirement could prevent scheduled starts and automatic
  selections after the Add/Drop projection upgrade.
- Commissioner-browser scheduled activation starts the first pick clock
  immediately and pins the verified shared projection snapshot.
- Server draft-document and auto-draft queue triggers process automatic picks
  immediately, while exact Cloud Tasks remain the deadline/contention fallback.
- League status messaging now accurately says the server is opening a scheduled
  draft rather than telling managers it is waiting for the commissioner.
- See DRAFT_START_AUTODRAFT_PERMISSION_FIX.txt for the detailed summary.


ARENA VISUAL SYSTEM — PHASE 3 (JULY 2026)
------------------------------------------
The site now includes the final coordinated page-identity and mascot-polish
layer in `src/rinkrat-arena-phase3.css`, loaded after Phase 1 and Phase 2A.

Key page identities:
- My Team = locker room / roster board.
- Add / Drop = scouting terminal / general manager decision center.
- Matchups = RinkRat Sports Network broadcast package.
- Standings = arena standings board.
- Point Leaders = league stat network.
- Playoffs = Road to the RinkRat Cup.

Polish includes mascot loading/empty states, puck-slide transaction feedback,
goal-light score feedback, penalty-box suspended states, treatment-room IR,
and trophy styling for completed challenges. Reduced-motion preferences remain
respected. The rat-tail divider idea remains intentionally excluded.

This update is frontend presentation only and does not change draft, scoring,
roster, projection, cycle, Firestore, or Cloud Function logic.

LEAGUE DELETION (JULY 2026)
---------------------------
- Current League now includes a commissioner-only League Danger Zone.
- Permanent deletion requires typing the complete league name exactly.
- Deletion is performed by the authenticated deleteLeague callable Cloud Function, not by client-side Firestore deletes.
- The function verifies commissioner ownership, recursively removes the complete leagues/{leagueId} tree, deletes matching leagueInvites, injuryEmailQueue, and emailNotificationLog records, then returns the commissioner to Dashboard.
- Firestore rules block direct deletion of the league root so nested data cannot be orphaned by an incomplete client delete.
- The remembered last-league ID is cleared when it matches the deleted league.

BETA FOUNDATION — PART 1 (JULY 2026)
------------------------------------
The first beta-hardening package adds product observability, safer navigation,
and a direct support channel without changing fantasy scoring or cycle logic.

Implemented:
- Authenticated main-layout routes now use an auth guard and preserve a safe
  returnUrl so signed-out users return to the page they originally requested.
- Every league route verifies membership before loading. Commissioner-only
  setup, projection, and management pages also verify commissioner ownership.
- Production-hidden diagnostics and simulators use a developer-tools guard.
- Unauthorized users see a themed Access Check page instead of raw Firestore
  permission errors.
- Firebase Analytics initializes only on supported non-local hosts. Page paths
  are generalized so league IDs, player IDs, matchup IDs, cycle numbers, and
  asset keys are not sent as analytics path values.
- Initial funnel events include login, registration, league creation, league
  joining, feedback submission, page views, and generalized client-error types.
- A custom Angular ErrorHandler deduplicates and rate-limits authenticated
  client reports before sending sanitized error context to the
  reportClientError callable Function.
- Signed-in managers can submit bug reports, confusing-flow reports, incorrect
  result reports, feature ideas, and account/privacy requests through the new
  feedback page. Reports include an optional verified league context, a
  generalized route, and a reference ID.
- Server-side callable Functions validate, rate-limit, and store feedback and
  error reports. Browser Firestore rules deny direct access to those internal
  collections.
- Public Support, Privacy Policy, and Terms of Use pages are linked from the
  login screen and authenticated footer. The mobile More menu links directly
  to feedback and support.

Important files:
  src/app/core/guards/auth.guard.ts
  src/app/core/guards/league-access.guard.ts
  src/app/core/observability/telemetry.service.ts
  src/app/core/observability/client-error-reporter.service.ts
  src/app/core/observability/rinkrat-error-handler.ts
  src/app/features/support/
  src/app/features/legal/
  src/app/features/errors/access-denied/
  functions/src/index.ts
  firestore.rules

The next beta-foundation package should add App Check configuration and staged
rollout, account deletion/reauthentication, a development-only listener and
performance monitor, and emulator-backed multi-account workflow tests. Training
Camp onboarding and daily manager retention features should follow after the
foundation is tested.

BETA ONBOARDING — TRAINING CAMP AND COACH HELP (JULY 2026)
-----------------------------------------------------------
The highest-priority new-user clarity work is now implemented as an authenticated five-step
RinkRat Training Camp plus contextual Coach help throughout the application.

Training Camp route:
  /training-camp

New registrations are routed to Training Camp before the Dashboard. Existing managers who have
not completed the current version see a Dashboard invitation, but they may continue using the app
without completing it. Completion is saved cross-device on the user profile:
  users/{uid}.trainingCampVersion
  users/{uid}.trainingCampCompletedAt

Current Training Camp version: 1.

The five lessons explain:
  1. Independent six-NHL-game roster-slot windows and seventh-game rollover.
  2. The 14-active, 3-bench, and 3-IR roster structure, including team goalie units.
  3. Immediate versus queued moves and IR behavior.
  4. Current production, projection, schedule dots, form, reliability, and stat breakdowns.
  5. Automatic standings, playoffs, placement routing, and preservation of already-played games.

A global Ask Coach control is mounted in the authenticated Main Layout. It detects the active route
and supplies concise help for Dashboard, League HQ, Draft Setup, Draft Room, My Team, Add/Drop,
Matchups, Standings, Leaders, Playoffs, Account Settings, and Training Camp. It links back to the
full Training Camp and sits above the mobile bottom navigation.

Training Camp analytics events:
  training_camp_started
  training_camp_step_viewed
  training_camp_completed
  training_camp_exited
  coach_help_opened

Important files:
  src/app/core/onboarding/training-camp.service.ts
  src/app/features/onboarding/training-camp/
  src/app/shared/coach-help/
  src/app/layouts/main-layout/
  src/app/features/dashboard/
  src/app/features/auth/auth.ts
  src/app/shared/navbar/navbar.html
  firestore.rules

Future Training Camp changes must increment CURRENT_TRAINING_CAMP_VERSION only when managers
should be invited to review materially changed rules. Do not mark completion for merely opening or
exiting the page; completion is saved only after the final lesson.

TRAINING CAMP CLARITY UPDATE
- Shift 1 now explicitly labels games 1-6 as the First Matchup and game 7 as the Start of Second Matchup.
- The description uses a three-part plain-language breakdown emphasizing independent six-game counters per roster spot.
- Shift 2 now explains scoring identity by position: forwards have higher upside and more volatility, defensemen are more consistent, and the team goalie unit is normally the highest-scoring roster asset.
- Training Camp tells managers to compare players primarily within the same position.

BETA FOUNDATION — PART 2 (JULY 2026)
------------------------------------
The second beta-hardening package adds secure account lifecycle controls and a
staged Firebase App Check client foundation.

Account deletion:
- Account Settings includes a permanent deletion checker.
- The manager must have no commissioner-owned leagues, type the exact saved
  manager name, acknowledge the irreversible action, and re-enter the current
  password.
- The client reauthenticates with Firebase Authentication and refreshes the ID
  token. The deleteMyAccount callable independently requires a recent auth_time.
- The callable removes the Auth user, user profile tree, feedback, diagnostics,
  injury email queues/logs, and observability rate-limit data.
- Joined-league team and membership records are anonymized rather than removed
  so league history remains mathematically stable. The record becomes Deleted
  Manager / Vacant Team.
- An unfinished draft queue for a deleted manager is switched to Auto-Draft so
  the draft can continue.
- Commissioner-owned leagues block deletion and must be removed through each
  league's existing Danger Zone first.

App Check preparation:
- Firebase App Check initialization now occurs before the Angular application
  imports Auth, Firestore, Functions, or Analytics.
- reCAPTCHA Enterprise configuration is centralized in
  src/environments/app-check.config.ts.
- App Check is intentionally disabled until a production site key is registered
  and request metrics can be monitored. Follow APP_CHECK_ROLLOUT_GUIDE.txt and
  never enable enforcement before the token-monitoring stage is healthy.

Important files:
  src/app/core/auth/account-deletion.service.ts
  src/app/core/firebase-app-check.ts
  src/environments/app-check.config.ts
  src/app/features/account/account-settings/
  functions/src/index.ts
  firestore.indexes.json
  APP_CHECK_ROLLOUT_GUIDE.txt

9. BETA OPERATIONS — AUTH HARDENING AND ADMIN CENTER (JULY 2026)
- Login is bounded by timeouts for credential sign-in, fresh ID token confirmation, Auth observer settlement, and manager profile loading. A stalled request cannot keep the UI in "Logging in..." indefinitely.
- Late sign-in completion after a timeout is automatically signed out so a rejected login attempt cannot silently become active later.
- Successful account deletion performs a complete browser-session reset: sign out, terminate the current Firestore client/listeners, clear user-scoped local/session storage, and hard-replace the page before another account signs in.
- Platform operations use a private /admin route protected by a server-verified platform administrator check. League commissioner status alone never grants access.
- Platform administrators can be bootstrapped with platformAdmins/{uid}.enabled == true; a platformAdmin Auth custom claim is also accepted.
- Feedback and automatic errors remain server-managed and blocked by Firestore browser rules.
- Admin Center feedback workflow supports filtering, follow-up email visibility only when consented, likely-error correlation, private notes, and statuses.
- Admin Center errors are grouped by a sanitized fingerprint and show occurrences, affected users, browser distribution, routes, releases, timestamps, sample stack, notes, and review status.
- Admin changes are written through callable Functions and recorded in adminAuditLogs.
- Release label advanced to Release Candidate 3.


FAVORITE-TEAM LOGO RELIABILITY
- Favorite-team current and historical logo assets are now synchronized from the official NHL logo catalog into public/assets/team-identity-logos.
- npm start and npm run build automatically prepare missing assets.
- Runtime identity cards use local SVG paths, removing broken guessed remote filenames and hot-link dependence.
- npm run validate:team-logos verifies all 32 current crests plus every archived/secondary identity asset.

BENCH CARD AND MATCHUP VISIBILITY UPDATE (2026-07-29)
- My Team bench cards now reuse the same fantasy-player-card structure as active starters instead of the older separate bench-card layout.
- Detailed matchup pages show each team's three current bench slots below the active lineup; bench assets are explicitly non-scoring and still show their projection.
- Mobile head-to-head matchup view includes a matching Bench group below LW/C/RW/D/G.
- The matchup component listens only to the current roster documents for the one displayed matchup, and unsubscribes when the matchup/route changes.

SCORING GUIDE (JUL 2026)
- Added /scoring for current standard RinkRat rules and /leagues/:leagueId/scoring for exact league-frozen rules.
- Guide imports the actual ScoringRules object and scoring engine, includes all forward/defense/goalie values, diminishing-return rules, defense TOI formula, goalie save-quality formula, bonuses, worked examples, and print support.
- Linked from desktop/mobile navigation, Training Camp, and Ask Coach.

MATCHUP ROSTER-GAME PROGRESS UPDATE (2026-07-29)
- Each team summary on the detailed matchup page now includes a themed progress bar showing counted starter roster games played versus games left.
- The progress uses the same per-asset gamesPlayed/gamesLeft data as matchup completion, so both team bars add up to the matchup-level "Waiting on N roster games" badge.
- The mobile condensed head-to-head team cards show the same progress. Bench and IR assets are excluded because they do not score in the active lineup window.
```

# Batch 6C — Browser Workflow Test Foundation and Documentation Cleanup

## Purpose

Batch 6C adds the first real-browser, multi-account workflow suite for RinkRat. It runs the production Angular build in headless Google Chrome or Chromium against isolated Firebase Authentication, Firestore, and Cloud Functions emulators. The test project ID is `demo-rinkrat-e2e`, so the suite cannot touch production data.

## Browser workflow coverage

The automated workflow now verifies that:

1. A signed-out visitor who requests Dashboard is redirected to authentication.
2. A commissioner account can register through the real UI.
3. The commissioner can create a league.
4. League creation writes the league, invite, membership, team, and server-created empty roster.
5. A second account can register and join with the invite code.
6. The second manager receives a membership, team, and server-created roster.
7. An ordinary manager is denied access to Draft Setup.
8. The commissioner can open Draft Setup.
9. Neither browser produces uncaught exceptions or `console.error` output.

The runner uses Chrome DevTools Protocol directly and therefore adds no Playwright, Puppeteer, Selenium, or browser-binary dependency to the project.

The workflow confirms the authoritative Firestore league document before expecting the Dashboard card. The Firestore Emulator can briefly delay a brand-new collection-group membership result, so the test performs bounded Dashboard reload retries and includes the current URL and visible page text if the card still does not appear. This retry is limited to the local emulator workflow and does not change production behavior.

## Safe emulator switch

The Angular app connects to emulators only when both conditions are true:

- The site is running on `localhost` or `127.0.0.1`.
- The initial URL contains `?e2e=1`.

The flag is stored only in the current browser session. The same query parameter is ignored on production domains.

## Documentation cleanup

All loose root-level `.txt` update files and historical `BATCH_*_MANUAL_TEST_CHECKLIST.md` files were combined into this document. A short root `README.md` points here. Future loose notes can be merged with:

```bash
npm run docs:consolidate
```

## Verification command

```bash
npm run verify:batch6c
```

The browser portion requires Java 21, Firebase CLI, and Google Chrome or Chromium. It automatically clears only the isolated `demo-rinkrat-e2e` emulator data.

## Manual confirmation after the automated suite

No production deployment is required for the test foundation itself. After the suite passes, continue using the normal site smoke test for the current production build:

- Sign in.
- Open an existing league.
- Open Game Center and My Team.
- Confirm no new console errors appear.

Because the Firebase emulator switch is localhost-only, production behavior is unchanged.


# Historical manual test checklists


## BATCH_1_MANUAL_TEST_CHECKLIST.md


# Batch 1 test checklist

Do not continue to Batch 2 until every required item below passes.

## 1. Prerequisites

Use the Node version required by the project:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1
node --version
firebase --version
java -version
```

The Firestore Emulator requires Java. The project already uses the Firebase CLI for deployment, so `firebase --version` should normally work.

## 2. Install and build

```bash
npm ci
npm --prefix functions ci
npm run build:all
```

**Pass condition:** Angular and Functions both compile with no errors.

## 3. Run the local security suite

```bash
npm run test:rules
```

Expected result:

- 24 tests pass
- 0 tests fail
- the command uses `demo-rinkrat-rules`
- no production league or account data changes

Several passing tests include **`[baseline exposure]`** in their names. That is intentional for Batch 1. They document permissions that later batches must remove.

## 4. Review the most important baseline findings

The following tests should currently pass as exposure documentation:

- an owner can overwrite a roster with forged and duplicate assets
- a commissioner can overwrite another team roster
- a manual draft pick accepts a non-canonical client asset
- a commissioner can alter draft records and competition records
- a transaction can contain an arbitrary client payload
- a waiver can contain an arbitrary client asset
- a commissioner can write global player availability
- a signed-in user can retrieve another full profile document

Do not interpret these passes as approval. They are the red tests that later batches will convert into denials.

## 5. Commit the checkpoint

After the build and rules tests pass:

```bash
git status
git add .
git commit -m "Add security test foundation and server scoring controls"
git push
```

## 6. Deploy only the Batch 1 runtime changes

Firestore rules are unchanged in this batch. Deploy the three new callable Functions and the updated site:

```bash
firebase deploy --only functions:requestLeagueLiveScoringRefresh,functions:releaseLeagueLiveScoringHandoff,functions:clearExpiredOrErroredLiveScoringLease,hosting:app -m "Batch 1 security test foundation"
```

## 7. Manual commissioner live-scoring test

Use a test league whose draft is complete.

1. Sign in as the commissioner.
2. Open **League HQ → Commissioner Tools → Live Scoring**.
3. Confirm the page title is **Server NHL Scorer**.
4. Open the browser developer console and clear existing messages.
5. Press **Refresh Scores Now** once.
6. Wait for the success message.
7. Confirm there is no `permission-denied` error in the console.
8. Confirm the page returns to **Server automation ready** after the refresh.
9. Confirm **Last completed refresh** changes to the current time.
10. Confirm **Last refresh reason** displays **Commissioner request**.
11. Press **Refresh Scores Now** again without waiting for NHL data to change.
12. Confirm the second pass completes and the unchanged/skipped count increases or remains consistent with no changed scoring snapshot.

**Pass condition:** the commissioner refresh runs through the Cloud Function and the browser never attempts a direct live-scoring write.

## 8. Manual role test

### Ordinary manager

1. Sign in as a non-commissioner manager in the same league.
2. Open the matchup page.
3. Confirm current scores and progress information load.
4. Confirm no live-scoring `permission-denied` errors appear in the console.
5. Attempt to open the Live Scoring developer route directly.

**Expected:** the manager can read shared scoring but cannot open commissioner diagnostics or request a refresh.

### League outsider

1. Sign in with an account that is not in the league.
2. Attempt to open the league URL directly.

**Expected:** league data is not displayed.

### Signed out

1. Sign out.
2. Attempt to open the league URL directly.

**Expected:** authentication is required and protected league data is not displayed.

## 9. Recovery-control test

Only run this while the diagnostics page says **Server automation ready**, not while a refresh is active.

1. Press **Clear Stale Control Lease**.
2. Confirm the success message appears.
3. Confirm no scoring snapshot, matchup score, cycle, or roster document is deleted.
4. Press **Refresh Scores Now** and confirm scoring still runs normally.

**Pass condition:** stale-control recovery works and does not change competition data.

## 10. Firestore spot check

In the Firebase console, inspect:

`leagues/{testLeagueId}/liveScoring/control`

After a manual refresh, confirm:

- `schemaVersion` is `2`
- `automationMode` is `server`
- `serverAutomationEnabled` is `true`
- `status` returns to `idle`
- `holderUserId` is `null`
- `holderClientId` is empty after completion
- `serverTrigger` is `manual`
- `lastRefreshReason` is `manual`
- `lastError` is empty
- `lastRefreshCompletedAt` is recent

## 11. Stop conditions

Do not proceed to Batch 2 when any of these occur:

- fewer than 24 rules tests pass
- an unexpected permission denial appears
- an ordinary manager can open commissioner diagnostics
- Refresh Scores Now writes from the browser instead of the Function
- a manual refresh remains stuck at `refreshing`
- a scoring refresh unexpectedly changes roster ownership or historical windows
- Angular or Functions build fails

## 12. Rollback

Use the checkpoint commit created before deployment:

```bash
git log --oneline -5
git revert <batch-1-commit-hash>
git push
npm run build:all
firebase deploy --only functions,hosting:app -m "Rollback Batch 1"
```


## BATCH_2_MANUAL_TEST_CHECKLIST.md


# RinkRat Batch 2 — Roster Authority Test Checklist

Batch 2 changes the authority boundary for roster actions. Ordinary managers now request roster changes through authenticated Cloud Functions instead of directly writing roster, waiver, claim, and transaction documents from the browser.

Use a **test league**, not a league whose data you care about. A completed draft is required for roster actions.

## 1. Install and run all automated checks

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm ci
npm --prefix functions ci
npm run verify:batch2
```

Expected results:

- Firestore Emulator: **28 tests passed, 0 failed**.
- Angular production build completes.
- Functions `tsc` build completes without an error.
- Tests marked `[baseline exposure]` and `[temporary Batch 3/4 dependency]` are intentional transition tests described in the change summary.

Do not continue to deployment if any test or build fails.

## 2. Create the Git checkpoint

```bash
git status
git add .
git commit -m "Harden roster moves behind server authority"
git push
```

Record the commit hash shown by:

```bash
git rev-parse --short HEAD
```

## 3. Deploy in the safe order

The Functions must exist before the new web client and rules begin relying on them.

### Step A — deploy the three roster-authority Functions

```bash
firebase deploy --only functions:ensureFantasyRoster,functions:executeSecureRosterAction,functions:applyImmediateRosterMove -m "Batch 2 roster authority functions"
```

### Step B — deploy the updated site

```bash
firebase deploy --only hosting:app -m "Batch 2 roster authority client"
```

### Step C — run the pre-rules smoke test in Section 4

After it passes, deploy the tightened rules:

```bash
firebase deploy --only firestore:rules -m "Batch 2 roster authority rules"
```

### Step D — repeat the smoke test after the rules deploy

The post-rules pass is the one that approves Batch 2.

## 4. Required five-minute smoke test

Use a manager in a completed-draft test league.

1. Open Dashboard, My Team, Free Agents, and Game Center.
2. Confirm the roster and matchup load normally.
3. From Free Agents, complete one legal add/drop involving a bench slot.
4. Return to My Team and confirm:
   - the incoming asset appears in the selected bench slot;
   - the outgoing asset is no longer on the roster;
   - no duplicate copy appears elsewhere;
   - the page updates without a manual reload.
5. Open the league transaction history and confirm a new entry appears.
6. Open browser Developer Tools → Console and verify there is no red `permission-denied`, `not-found`, failed callable, or unhandled error.

In Firestore, inspect the new transaction document and confirm:

```text
authority: "cloud-function"
```

Also confirm the dropped asset has an active document under the league's `waivers` collection.

## 5. Full roster-action regression

Complete these tests before approving the batch. Use Manager A unless another account is specified.

### A. Add/drop to a bench slot

1. Add a free agent while dropping a bench asset.
2. Confirm the new asset occupies that exact bench slot.
3. Confirm the dropped asset appears on waivers.
4. Confirm one transaction document was created with `authority: "cloud-function"`.

Expected: the move applies immediately as an ownership change.

### B. Add to an open bench slot

1. Drop a bench asset to create an open bench slot.
2. Add a free agent into the open slot.

Expected: the open slot fills, no unrelated slot changes, and the added asset cannot appear on another roster.

### C. Active-slot add/drop

Test whichever path your test league currently permits:

- **Untouched current slot window:** the move may apply immediately to the current cycle.
- **Started slot window:** the move must be queued for the next fair slot boundary.

Confirm:

- the incoming asset matches the active slot's position;
- a started window is never silently rewritten;
- a queued move shows on the correct slot;
- the current matchup score/window remains intact.

### D. Cancel a queued move

1. Create a queued active-slot move.
2. Cancel it before activation.

Expected: the pending move disappears, the current asset remains, and a cancellation transaction is written. A waiver-award move should not offer a normal cancellation path.

### E. Active/bench swap

1. Select a bench asset whose position matches an active slot.
2. Perform the swap.

Expected:

- an untouched eligible window may swap immediately;
- otherwise the swap is queued;
- the bench asset remains reserved while queued;
- attempting to drop or replace that reserved bench asset is rejected with a useful message;
- no asset is duplicated.

### F. Drop from active, bench, and IR

Test each area that has an asset available.

Expected:

- the selected asset leaves only the selected roster area;
- an active waiver is created;
- the current immutable scoring window is not erased;
- a reserved bench asset cannot be dropped until its queued swap is canceled.

### G. IR movement and activation

Use an actually IR-eligible skater (`Out`, `IR`, or `LTIR`) in the test league.

1. Move an eligible active skater to IR.
2. Move an eligible bench skater to IR if one is available.
3. Attempt to move an active/healthy or day-to-day skater to IR.
4. Activate an IR player to an active slot of the matching position.
5. Activate an IR player to a bench slot.

Expected:

- only server-authoritative `Out`, `IR`, or `LTIR` statuses are accepted;
- healthy, day-to-day, suspended, and unknown players are rejected;
- goalie units cannot be placed on IR;
- all three IR slots are enforced;
- activation never creates a duplicate;
- replacing an occupied destination sends the outgoing asset to waivers.

### H. Duplicate and position protection

1. Try to add a player already on Manager A's roster.
2. Try to add a player owned by Manager B.
3. Try to place a C in an LW, RW, D, or G active slot.
4. Try to add a player who currently has an active waiver document as a normal free agent.

Expected: every attempt is rejected and no roster, waiver, or transaction document is partially changed.

## 6. Waiver regression with two managers

Use Manager A, Manager B, and the commissioner.

1. Manager A drops a bench asset to waivers.
2. Verify Manager A cannot submit a claim on their own active waiver drop.
3. Manager B submits a claim using either:
   - an open compatible slot; or
   - a valid drop slot.
4. Verify the claim appears in the UI.
5. Sign in as commissioner and process the waiver.
6. Confirm:
   - the highest-priority eligible claimant wins;
   - the asset appears once on the winning roster;
   - the waiver status becomes `claimed`;
   - `awardedToOwnerId` is set;
   - the winning manager moves to the end of waiver priority;
   - other priorities shift correctly;
   - any dropped replacement asset receives its own active waiver;
   - the transaction has `authority: "cloud-function"`.
7. Repeat with a claim whose selected slot becomes invalid before processing.

Expected: the server skips the invalid claim and considers the next eligible claimant. If no claim remains eligible, the waiver clears and a `waiver-cleared` transaction is written.

## 7. New-team roster initialization

Use a disposable account or new test league.

1. Join/create the league and allow the team to be created.
2. Open My Team or Team Settings.
3. Confirm the roster loads with:
   - 14 active slots;
   - 3 bench slots;
   - 3 IR slots.
4. Confirm there is no `permission-denied` error.
5. In Firestore, confirm `teams/{uid}/roster/current` exists with `schemaVersion: 2`.

This verifies that `ensureFantasyRoster` replaced direct browser roster creation correctly.

## 8. Manual draft transition check

Batch 3 will move drafting behind server authority. Until then, Batch 2 deliberately preserves the existing atomic manual-pick roster update.

In a disposable live draft:

1. Start the draft normally.
2. Make at least one manual pick as a non-commissioner manager.
3. Confirm the pick is recorded and placed into the correct active or bench slot.
4. Confirm the next manager goes on the clock.
5. Confirm no `permission-denied` error occurs.

Do not approve Batch 2 if manual picks fail after the rules deployment.

## 9. Commissioner cycle-boundary transition check

Batch 4 will move cycle/playoff boundary writes to the server. For now, confirm the existing commissioner process is not broken.

In a test league with a queued roster move:

1. Run or allow the normal cycle/window progression that activates the move.
2. Confirm the incoming asset activates at the intended boundary.
3. Confirm a bench swap moves the outgoing active asset to the bench.
4. Confirm an add/drop queues the outgoing asset to waivers when activated.
5. Confirm matchup and roster-window data still load.

This is the temporary reason commissioner roster/waiver/transaction writes remain permitted until Batch 4.

## 10. Browser and device checks

Run the smoke test in:

- Chrome desktop;
- Safari desktop;
- one mobile viewport or physical phone.

Check Free Agents, My Team, queued-move labels, waiver dialogs, and confirmation/error messages. Batch 2 is not a visual redesign, so unexplained layout changes are regressions.

## 11. Firestore spot checks

For each successful test action, verify:

- only the signed-in user's roster changed unless processing a commissioner waiver award;
- each asset key exists on no more than one roster, including `pendingMove.incomingAsset` reservations;
- transaction documents created by new roster actions contain `authority: "cloud-function"`;
- active waiver documents contain matching `assetKey` and `asset.assetKey`;
- roster shape remains 14 active / 3 bench / 3 IR;
- historical cycle roster picks and completed game windows were not rewritten.

## 12. Stop conditions

Stop and send the full console/terminal output if any of these occur:

- a normal roster action returns `permission-denied`;
- a valid free agent returns “not available in the authoritative player pool”;
- a successful UI action changes the wrong slot;
- an asset appears on two rosters or both active and bench/IR unexpectedly;
- a failed action leaves a partial roster, waiver, or transaction update;
- a current or completed six-game window is erased or restarted;
- a manual draft pick fails after rules deployment;
- a commissioner cycle-boundary activation fails;
- any callable returns `not-found` immediately after deployment;
- browser console shows an unhandled error.

## 13. Approval gate

Batch 2 is approved only when:

- `npm run verify:batch2` passes;
- all 28 rule tests pass;
- the pre-rules and post-rules smoke tests pass;
- the add/drop, queued move, cancel, swap, IR, and waiver paths pass;
- manual drafting still works;
- one commissioner cycle-boundary activation still works;
- no unexpected browser-console errors remain;
- no duplicate assets or partial writes are found.

## 14. Rollback

Revert the Batch 2 Git commit, rebuild, and redeploy the Batch 1 runtime/rules:

```bash
git revert <BATCH_2_COMMIT_HASH>

npm ci
npm --prefix functions ci
npm run build:all

firebase deploy --only functions:applyImmediateRosterMove,firestore:rules,hosting:app -m "Rollback Batch 2 roster authority"
```

The two new callables may remain deployed but unused after rollback; they validate authentication and ownership and are not harmful. They can be deleted later if desired. Do not manually edit production roster documents as part of a rollback.


## BATCH_3_MANUAL_TEST_CHECKLIST.md


# RinkRat Batch 3 — Draft Authority Test Checklist

Batch 3 makes the draft server-authoritative. Use a **disposable test league** with at least two separate manager accounts. Do not deploy this batch during an active real draft.

## 1. Production safety check before running or deploying

In the Firebase console, check each document at:

```text
leagues/{leagueId}/draft/current
```

For any draft where `status` is `live` and `nextOverallPick` is greater than `1`, confirm:

```text
serverDraftProjectionSnapshotId: "non-empty snapshot ID"
```

Stop before deployment if a live draft already has picks but does not have that field. Batch 3 intentionally refuses to continue a legacy live draft without a frozen pool because silently selecting from a different snapshot would be unfair.

Also confirm no real draft is actively running during deployment.

## 2. Install and run all automated checks

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm ci
npm --prefix functions ci
npm run verify:batch3
```

Expected results:

- Firestore Emulator: **32 tests passed, 0 failed**.
- Angular production build completes.
- Functions `tsc` build completes without an error.
- Draft authority engine: **7 tests passed, 0 failed**.
- Tests still labeled `[baseline exposure]` or `[temporary Batch 4 dependency]` cover systems scheduled for Batch 4; they do not represent final release permissions.

Do not deploy if any test or build fails.

## 3. Create the Git checkpoint

```bash
git status
git add .
git commit -m "Harden draft picks behind server authority"
git push

git rev-parse --short HEAD
```

Keep the displayed commit hash for rollback.

## 4. Deploy in the safe order

### Step A — deploy draft Functions and changed automation first

```bash
firebase deploy --only functions:executeDraftCommand,functions:makeSecureDraftPick,functions:runScheduledDraftAutomation,functions:processDraftClockDeadline,functions:continueServerDraftAutomation,functions:processAutoDraftQueueChange -m "Batch 3 draft authority functions"
```

Confirm the deployment reports all six Functions successfully created or updated.

### Step B — deploy the updated site

```bash
firebase deploy --only hosting:app -m "Batch 3 draft authority client"
```

### Step C — complete the pre-rules smoke test in Section 5

At this stage the new client should already use the Functions, while the previous rules remain available as a rollback cushion.

### Step D — deploy the hardened rules

Only after Section 5 passes:

```bash
firebase deploy --only firestore:rules -m "Batch 3 draft authority rules"
```

### Step E — repeat Sections 5 through 9

The post-rules pass is the one that approves Batch 3.

## 5. Required smoke test

Use a new two-manager test league.

1. Sign in as commissioner and open Draft Setup.
2. Set a 30-second clock and schedule the draft a few minutes in the future.
3. Save the settings.
4. Confirm the success message reports verified shared projections.
5. Open browser Developer Tools → Console and confirm there is no red callable, `permission-denied`, or unhandled error.
6. In Firestore, inspect `draft/current` and confirm:
   - `status` is `scheduled`;
   - `roundOneOrder` contains every team once;
   - `pickSeconds` is `30`;
   - `nextOverallPick` is `1`;
   - `draftedAssetKeys` is empty.
7. At the scheduled time, confirm the draft becomes `live` and the clock starts.
8. As the manager on the clock, make one manual pick.
9. Confirm:
   - the pick appears immediately;
   - the asset is placed into the correct roster slot;
   - the next manager goes on the clock;
   - the selected asset disappears from available players and queues;
   - no duplicate copy appears on any roster;
   - no console error appears.
10. Inspect the pick document and confirm:

```text
authority: "cloud-function"
projectionSnapshotId: "same ID as draft/current.serverDraftProjectionSnapshotId"
selectionType: "manual"
selectedByUserId: "manager UID"
```

## 6. Scheduled opening with browsers closed

This verifies the scheduled server path rather than only the commissioner fallback.

1. Create another disposable draft scheduled at least three minutes in the future.
2. Close every RinkRat tab before the start time.
3. Reopen the site after the scheduled time.
4. Confirm the draft is live and the first clock/automatic handling occurred without a browser being open.
5. Confirm `serverDraftProjectionSnapshotId` is populated.
6. Confirm the server automation fields report a healthy/opened state.

Expected: a scheduled draft does not depend on the commissioner leaving a browser tab open.

## 7. Manual-pick authority and race tests

### A. Wrong manager

1. Keep Manager A on the clock.
2. Sign in as Manager B in another browser/profile.
3. Attempt to select a player.

Expected: Manager B cannot submit the pick. No pick, roster, queue, or draft state changes.

### B. Double-click or two-tab race

1. As the manager on the clock, open the draft in two tabs.
2. Submit a pick nearly simultaneously from both tabs, or double-click rapidly.

Expected:

- exactly one pick document is created;
- `nextOverallPick` advances by exactly one;
- exactly one asset is placed on the roster;
- the losing request reports that the turn or asset is no longer valid;
- no duplicate asset appears.

### C. Expired manual request

1. Allow the visible clock to reach zero.
2. Attempt a manual pick after expiration.

Expected: the manual request is rejected and server automation owns the expired turn. The browser must not overwrite the automatic selection.

### D. Draft settings lock

After the first pick, return to Draft Setup and attempt to save a new order or clock.

Expected: settings are locked and the existing live draft remains unchanged.

## 8. Queue and automatic-draft tests

### A. Owner-only queue

1. Manager A adds several legal assets to their queue and reorders them.
2. Toggle Manager A's own Auto Draft control.
3. Confirm the queue updates normally.
4. Sign in as commissioner and confirm the commissioner can view the current manager's auto-draft state but no longer has a control to change another manager's preference.

Expected: each manager controls only their own queue. The commissioner cannot manipulate another team's queue or auto-draft mode.

### B. Queued automatic selection

1. Put a legal, undrafted player first in Manager A's queue.
2. Enable Manager A's auto-draft before their turn.
3. Let the server process the turn.

Expected:

- the first legal queued asset is selected;
- the pick has `selectionType: "queue"`;
- the pick has `authority: "cloud-function"`;
- the pick has the frozen `projectionSnapshotId`;
- the selected key is removed from the queue;
- roster and draft progression update atomically.

### C. Invalid queued entry fallback

1. Put an already-drafted asset first and a legal asset second in a queue.
2. Enable auto-draft or allow the timer to expire.

Expected: the server skips the drafted entry and selects the next legal queued asset. If no queued asset is legal, it selects the highest-ranked legal canonical asset.

### D. Two consecutive clock expirations

1. Leave one manager on manual mode.
2. Allow two of that manager's turns to expire.

Expected after the second expiration:

```text
autoDraftEnabled: true
consecutiveClockExpirations: 2
autoDraftActivatedByTimeout: true
```

Future turns should auto-process until that manager changes their own preference where allowed by the existing timeout policy.

## 9. Commissioner clock controls

1. As commissioner, pause a running clock.
2. Confirm the countdown stops for all signed-in managers.
3. Confirm a manager cannot pick while paused.
4. Resume the clock.
5. Confirm it resumes from the preserved remaining seconds, not a fresh full clock.
6. Try pause/resume as a non-commissioner.

Expected: only the commissioner can request pause/resume, and the server writes the clock state.

## 10. Frozen player-pool test

1. Once the draft is live, confirm the Draft Room does not offer a button to rebuild shared projections.
2. Make several picks and verify every pick document uses the same `projectionSnapshotId`.
3. Confirm `draft/current.serverDraftProjectionSnapshotId` does not change.
4. Run the Firestore Emulator suite and confirm the live projection-tampering test passes.

Expected: the player pool and asset details stay frozen for the entire live draft.

Do not try to manually edit production Firestore documents to test denial; the emulator tests already perform those hostile-write checks safely.

## 11. Roster-feasibility regression

Continue a small test draft far enough to check these behaviors, using auto-draft to accelerate it when useful:

- Starting LW, C, RW, D, and G slots fill before automatic bench picks.
- A player is placed only into a compatible active slot.
- Bench auto-draft avoids duplicating forward/defense/goalie roles until all three roles are represented.
- A bench goalie selection cannot consume the last goalie unit needed by another team's starting G slot.
- No asset is drafted twice.
- Every pick has one corresponding roster placement.
- The number of `draftedAssetKeys` equals the number of pick documents.

For a fully completed two-team test draft, confirm:

- 34 total picks exist;
- both teams have 14 active and 3 bench assets;
- `status` and `clockStatus` are `complete`;
- the normal post-draft season initialization still begins;
- My Team, Game Center, Free Agents, and League HQ load without errors.

## 12. Firestore consistency spot-check

After at least five mixed manual/automatic picks, verify:

```text
pick document count == draft/current.draftedAssetKeys.length
nextOverallPick == pick document count + 1
```

For each pick:

- the pick's `asset.assetKey` occurs once in `draftedAssetKeys`;
- it occurs on exactly one league roster;
- `rosterArea` and `rosterSlotId` match the actual roster location;
- `projectionSnapshotId` matches the draft's pinned snapshot;
- `authority` is `cloud-function`.

Also confirm no stale duplicate asset remains in a manager queue after it is selected.

## 13. Role-based browser regression

### Commissioner

- Draft Setup saves before the draft.
- Scheduled opening works.
- Pause/resume works.
- Draft Room and all queues are readable.
- There is no control to change another manager's auto-draft preference.

### Manager

- Own queue add/remove/reorder works.
- Own auto-draft toggle works.
- Manual pick works only on their turn and before expiration.
- Opponent queue remains unreadable.

### Outsider

- Cannot read the private draft or queues.
- Cannot call draft actions successfully.

### Signed-out browser

- Cannot call draft Functions or read league draft data.

## 14. Browser and responsive smoke test

Test the Draft Room in current Chrome/Safari desktop and one narrow mobile viewport.

Confirm:

- player rows and draft buttons remain usable;
- clock state updates without a reload;
- queue controls remain usable;
- removed commissioner/repair controls do not leave an awkward blank area;
- manual and automatic pick messages remain understandable;
- no layout regression appears in the header, sidebar, recent picks, roster, or player pool.

## 15. Stop conditions

Do not approve Batch 3 if any of these occur:

- a browser receives unexplained `permission-denied` errors during normal use;
- a manual pick writes client-supplied asset details that differ from the frozen snapshot;
- two simultaneous requests create two picks for one turn;
- an automatic pick lacks `authority` or `projectionSnapshotId`;
- the draft snapshot changes during a live draft;
- a commissioner can modify another manager's queue;
- pick, roster, queue, and draft progression partially update;
- the timer can be restarted or extended by a normal manager;
- draft completion no longer initializes the season correctly;
- Angular, Functions, rules, or engine tests fail.

## 16. Rollback

Use the Batch 3 commit hash recorded in Section 3.

```bash
git revert <BATCH_3_COMMIT_HASH>
git push
npm run build:all
```

Deploy the reverted runtime first:

```bash
firebase deploy --only functions:executeDraftCommand,functions:makeSecureDraftPick,functions:runScheduledDraftAutomation,functions:processDraftClockDeadline,functions:continueServerDraftAutomation,functions:processAutoDraftQueueChange,hosting:app -m "Rollback Batch 3 runtime"
```

Then restore the previous rules:

```bash
firebase deploy --only firestore:rules -m "Rollback Batch 3 rules"
```

A rollback reopens the temporary Batch 2 browser draft permissions, so use it only as an emergency bridge and do not run a real public draft until Batch 3 is repaired and redeployed.

## Approval record

Record the following before starting Batch 4:

```text
Batch 3 commit:
Automated verification date:
32 rules tests passed: yes / no
7 draft-engine tests passed: yes / no
Pre-rules smoke test passed: yes / no
Post-rules smoke test passed: yes / no
Scheduled no-browser test passed: yes / no
Manual race test passed: yes / no
Automatic draft test passed: yes / no
Completed-draft regression passed: yes / no
Console clean: yes / no
Approved for Batch 4: yes / no
Notes:
```


## BATCH_4_MANUAL_TEST_CHECKLIST.md


# RinkRat Batch 4 Testing Checklist

## Goal

Batch 4 makes scoring, cycle progression, standings, roster-window transitions,
and playoff records server-authoritative. The browser may display these records
and request authenticated server actions, but it may not directly rewrite the
outcome of a fantasy competition.

Use a disposable completed-draft test league. Keep the successful Batch 3 test
league because it already has realistic teams, rosters, and draft records.

Do not use Firebase Console edits as a security test. Console/Admin SDK writes
bypass Firestore Security Rules.

---

## 1. Preparation

Before replacing the project, record the current Git commit:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
git rev-parse --short HEAD
git status
```

Save the commit hash. The working tree should be clean except for Firebase's
generated hosting cache. That cache may be discarded with:

```bash
git restore .firebase/hosting.ZGlzdC9mYW50YXN5LWhvY2tleS9icm93c2Vy.cache
```

In Firebase Console, take screenshots of these records in the test league so
there is a before/after reference:

- `leagues/{leagueId}/teams/{ownerId}` for both teams
- `leagues/{leagueId}/cycles/cycle-1`
- One document under `cycles/cycle-1/matchups`
- One document under `cycles/cycle-1/teamWindows`
- `leagues/{leagueId}/liveScoring/control`
- `leagues/{leagueId}/playoffs/current`, when present

Do not deploy while a real user draft is active. A normal active scoring period
is supported, but testing during a quiet period is easier to interpret.

---

## 2. Automated verification

Run:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm ci
npm --prefix functions ci
npm run verify:batch4
```

Expected results:

- **40** Firestore rules tests passed
- **7** draft-engine tests passed
- **2** league-onboarding contract tests passed
- **4** competition-authority contract tests passed
- Angular production build completed
- Functions TypeScript build completed
- Zero failed tests

The rules suite uses `demo-rinkrat-rules` and the local Auth/Firestore
emulators. It must not access production data.

Stop here if any test or build fails.

---

## 3. Commit checkpoint

After verification passes:

```bash
git status
git add .
git commit -m "Move competition state behind server authority"
git push

git rev-parse --short HEAD
```

Save the new commit hash as the Batch 4 checkpoint.

---

## 4. Safe deployment order

### A. Deploy server authority first

```bash
firebase deploy --only functions:runScheduledLeagueAutomation,functions:runSeasonStartAutomation,functions:initializeSeasonAfterDraft,functions:requestLeagueLiveScoringRefresh,functions:openNextCompetitionPeriod,functions:releaseLeagueLiveScoringHandoff,functions:clearExpiredOrErroredLiveScoringLease,functions:advanceHistoricalReplayDay -m "Batch 4 competition authority functions"
```

### B. Deploy the read-only browser client

```bash
firebase deploy --only hosting:app -m "Batch 4 competition authority client"
```

Do **not** deploy the new rules yet. Complete Section 5 first.

---

## 5. Pre-rules smoke test

Use the commissioner account in the completed-draft test league.

### League and matchup loading

1. Open Dashboard, League HQ, My Team, and Game Center.
2. Confirm all pages load without a blank screen.
3. Confirm scores, roster cards, game markers, and roster-game progress display.
4. Open browser Developer Tools → Console.
5. Confirm there are no new red errors or `permission-denied` messages.

### Server scoring refresh

1. Open Game Center → Dev Controls.
2. Click **Refresh Shared Scores**.
3. Confirm the button shows a processing state and then succeeds.
4. Confirm the shared score snapshot remains visible.
5. Confirm `liveScoring/control` returns to `status: "idle"`.
6. Confirm its refresh fields update, including the last-completed time and a
   manual trigger/reason.

### Historical replay test

Use only a disposable historical-replay league.

1. Click **Start Replay + Advance One Day** or **Advance One NHL Day**.
2. Confirm the action succeeds without a browser write permission error.
3. Confirm the simulated date advances exactly once.
4. Confirm the released-game count and shared scores update when that date has
   games.
5. Confirm cycle/matchup/team-window records are written by the server.

### Existing secured workflows

Perform one legal action from each applicable area:

- Rename your team.
- Change the league profile icon.
- Make an active/bench move or legal add/drop.
- Create or cancel a queued roster move when the test state permits it.
- Submit one waiver claim when a waiver is available.

These actions must continue to use their secure Batch 2 Functions and must not
produce permission errors.

Stop before rules deployment if any pre-rules action fails.

---

## 6. Deploy the hardened rules

```bash
firebase deploy --only firestore:rules -m "Batch 4 competition authority rules"
```

Hard-refresh the site after deployment:

- Chrome on Mac: **Command + Shift + R**

Then repeat all relevant tests in Section 5.

---

## 7. Post-rules role tests

### Commissioner

Verify that the commissioner can:

- Read every team, roster, matchup, cycle, and playoff record in the league.
- Rename their own team and change their profile icon.
- Request a shared score refresh.
- Use historical replay in a dedicated test league.
- Complete legal roster and waiver actions through the secure UI.
- Open an already completed period's next cycle through the server fallback
  button, when such a test state exists.

The commissioner must not receive a browser-side permission error during any
legitimate action.

### Ordinary manager

Sign in as the second manager and verify:

- Dashboard, My Team, Game Center, standings, and playoff pages load.
- The manager sees the same shared scores as the commissioner.
- Team-name and profile-icon changes still save.
- Legal roster moves still work through the secure roster Function.
- Commissioner-only scoring controls are not visible.
- No red console errors appear.

### League outsider

Sign in with an account that is not a member of the league and paste a direct
Game Center or playoff URL.

Expected result:

- Access is denied or redirected by the league guard.
- No team, roster, scoring, cycle, or playoff data appears.

---

## 8. Cycle-transition regression

This is the most important behavior test for Batch 4.

In the disposable historical-replay league, advance the simulated NHL calendar
until one complete fantasy matchup period resolves.

Confirm all of the following:

1. Each roster slot retains its independent six-game window.
2. A slot that finishes Game 6 can begin its next window without waiting for
   every other slot.
3. The seventh scheduled NHL team game is not lost or counted twice.
4. Matchup scores update from the server snapshot.
5. The matchup becomes complete only when both sides' required windows finish.
6. The cycle document changes to `status: "complete"`.
7. Winner and final scores are stored on the matchup document.
8. Wins, losses, ties, points for, and points against update once—not twice.
9. Queued roster moves activate at the correct slot boundary.
10. Exactly one next-cycle document is created.
11. Refreshing or opening the next period again does not create a duplicate.
12. The next cycle contains the correct immutable roster-slot snapshots.

If server automation already opened the next period, the commissioner fallback
button should return/open the existing period rather than creating another.

---

## 9. Playoff regression

When a test league reaches the postseason, verify before public launch:

1. The playoff bracket is created from final regular-season standings.
2. Seeds and byes match the intended format.
3. Early NHL games continue accumulating in immutable per-slot playoff banks.
4. Once the prior round resolves, already-played games are assigned/backfilled
   into the correct championship, third-place, fifth-place, or consolation
   matchup.
5. Winners advance and losers move to the proper placement matchup.
6. No game disappears, duplicates, or moves between a slot's immutable windows.
7. Final placements are saved once.
8. Re-running scoring is idempotent and does not change a completed bracket.
9. Ordinary managers can read the bracket but cannot alter it.

A full postseason replay is a release gate before opening the app publicly. It
is not necessary to manufacture a live playoff state solely to deploy this
batch when the emulator suite and regular-season transition test pass.

---

## 10. Firestore spot checks

After a server refresh or transition, inspect:

### Shared scoring control

`leagues/{leagueId}/liveScoring/control`

Expected characteristics:

- `automationMode` is `server` or `historical-replay`.
- `status` returns to `idle` after a successful run.
- `holderClientId` is empty after completion.
- Successful-refresh and snapshot counters increase appropriately.
- `lastError` is empty.

### Cycle

`leagues/{leagueId}/cycles/cycle-{number}`

Check:

- Status, phase, expected-window counts, and completion counts agree.
- `standingsAppliedAt` appears only after completion.
- Projection-accuracy fields may update independently but do not alter scores.

### Matchup

`cycles/cycle-{number}/matchups/{matchupId}`

Check:

- Team scores match the shared scoring snapshot.
- Winner and completion fields are populated only when ready.

### Team standings

`leagues/{leagueId}/teams/{ownerId}`

Check:

- Identity fields remain intact.
- Record and point totals change only through server completion.
- Refreshing an already finalized cycle does not increment them again.

### Windows and playoffs

Check team-window and playoff-bank documents for stable slot IDs, game IDs,
and window numbers. Repeated refreshes should update scoring state without
creating duplicate windows.

---

## 11. Stop conditions

Stop testing and do not continue to the next batch if any of these occur:

- A legal roster, waiver, scoring-refresh, or identity action receives
  `permission-denied`.
- A cycle remains active after every required roster window is complete and a
  server refresh finishes.
- A next cycle is duplicated.
- Standings increment more than once.
- A player's seventh NHL team game is skipped or counted in both windows.
- Playoff banks or bracket assignments disappear.
- Ordinary managers see different shared scores than the commissioner.
- Browser console errors repeat during ordinary page use.
- Scheduled automation remains in `refreshing` or `error` state.

Record the league ID, cycle number, screenshots, browser console output, and the
relevant Cloud Function log before changing production data.

---

## 12. Rollback

Use the pre-Batch-4 commit hash saved in Section 1.

```bash
git checkout <PRE_BATCH_4_COMMIT>
npm ci
npm --prefix functions ci
npm run build:all
```

For a functional rollback, restore server code first, then the matching rules,
then hosting so the old browser and rules are never mismatched longer than
necessary:

```bash
firebase deploy --only functions -m "Rollback Batch 4 functions"
firebase deploy --only firestore:rules -m "Rollback Batch 4 rules"
firebase deploy --only hosting:app -m "Rollback Batch 4 client"
```

After recovery, return to `main` and investigate the captured failing league in
a disposable environment before attempting another production deployment.


## BATCH_5_MANUAL_TEST_CHECKLIST.md


# RinkRat Batch 5 Test Checklist

## Scope

Batch 5 makes account profiles private, creates display-safe public manager profiles, and moves the shared ESPN injury report completely behind Cloud Function authority.

Do not deploy when any automated test or build fails.

## 1. Automated verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm ci
npm --prefix functions ci
npm run verify:batch5
```

Expected results:

- 44 Firestore rules tests pass
- 7 draft-authority tests pass
- 2 league-onboarding tests pass
- 4 competition-authority tests pass
- 7 profile/injury authority tests pass
- Angular production build completes
- Functions TypeScript build completes

There are 64 named tests in total.

## 2. Commit checkpoint

The Firebase hosting cache is generated and should not be committed.

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey

git restore .firebase/hosting.ZGlzdC9mYW50YXN5LWhvY2tleS9icm93c2Vy.cache 2>/dev/null || true
git status
git add .
git commit -m "Secure injury refreshes and split public manager profiles"
git push
git rev-parse --short HEAD
```

Save the displayed commit hash for rollback.

## 3. Safe deployment order

### Step A — Functions

```bash
firebase deploy --only functions:refreshGlobalPlayerAvailabilityScheduled,functions:refreshDailyPlayerAvailability,functions:getPublicManagerProfiles,functions:deleteMyAccount -m "Batch 5 injury and profile authority"
```

### Step B — Firestore rules

```bash
firebase deploy --only firestore:rules -m "Batch 5 profile privacy and injury authority rules"
```

### Step C — Hosting

```bash
firebase deploy --only hosting:app -m "Batch 5 private profiles and server injury refresh"
```

After hosting finishes, hard-refresh with **Command + Shift + R**, then sign out and sign back in once.

## 4. Existing-account profile test

Use an account created before Batch 5.

1. Sign in.
2. Confirm Dashboard, Account Settings, My Team, League HQ, and Game Center load.
3. In Firestore, open:

   ```text
   publicProfiles/{yourUid}
   ```

4. Confirm the document exists after login or after opening Game Center.
5. Confirm it contains only:

   ```text
   uid
   username
   favoriteTeamAbbreviation
   favoriteTeamVariantId
   updatedAt
   ```

6. Confirm it does **not** contain email, injuryEmailEnabled, reducedMotion, backgroundTheme, unlocks, or onboarding fields.

Expected: existing accounts work normally and receive a safe public-profile copy without a manual migration.

## 5. Account-settings synchronization test

1. Change the account username.
2. Change the favorite NHL team or logo variant.
3. Save Account Settings.
4. Confirm the page reports success and reloads with the new values.
5. In Firestore, confirm:
   - `users/{uid}` contains the complete private settings.
   - `publicProfiles/{uid}` contains the new username and favorite-team fields only.
6. Change a private-only preference such as reduced motion, background theme, or injury email.
7. Confirm that private preference changes under `users/{uid}` but does not appear in `publicProfiles/{uid}`.

Expected: public and private display identity remains synchronized while private preferences stay private.

## 6. Opponent identity and theme test

Use a league with at least two managers, preferably one containing an older account.

1. Sign in as Manager A and open Game Center.
2. Confirm Manager B's username, favorite-team colors, and logo styling appear normally.
3. Sign in as Manager B and repeat against Manager A.
4. Check the browser console for red errors or `permission-denied` messages.
5. Confirm a missing legacy `publicProfiles/{opponentUid}` document is automatically created after Game Center loads.

Expected: matchup identity works without either browser reading the opponent's private `/users` document.

## 7. Shared injury refresh test — commissioner

1. Sign in as a league commissioner.
2. Open the injury-management or commissioner injury area.
3. Run the normal refresh action.
4. Confirm the page shows either:
   - a successful refreshed report,
   - an already-current message,
   - or a clear in-progress/cooldown message.
5. Confirm no browser `permission-denied` error occurs.
6. Inspect:

   ```text
   appData/playerAvailability
   ```

7. Confirm:
   - `updatedBy` is a server label, not your Firebase UID.
   - `refreshLeagueId` is absent.
   - `status`, timestamps, counts, message, and records look valid.
   - the prior report remains available if ESPN returns an error or suspiciously sparse feed.

Expected: the commissioner requests the action, but only the server writes the shared report.

## 8. Shared injury refresh test — ordinary manager

1. Sign in as an ordinary league manager.
2. Open the league and draft/game pages that normally trigger the daily injury check.
3. Confirm those pages load without errors.
4. Confirm the shared injury report remains readable.
5. Confirm commissioner-only force-refresh controls are not available.

Expected: normal daily/draft checks remain functional, but an ordinary manager cannot force a refresh.

## 9. Manual override regression test

This test concerns league-specific commissioner overrides, not the shared ESPN report.

1. As commissioner, set one disposable player's manual availability override.
2. Confirm the override appears where expected and IR eligibility behaves correctly.
3. As an ordinary manager, confirm the same override cannot be edited.
4. Remove the disposable override afterward.

Expected: commissioner overrides still work and remain separate from the global server report.

## 10. New-account registration test

Use a disposable email/account.

1. Register a new account.
2. Confirm registration completes and the account can sign in.
3. Confirm both documents exist:

   ```text
   users/{newUid}
   publicProfiles/{newUid}
   ```

4. Confirm the private document contains email and account preferences.
5. Confirm the public document contains only the five safe fields.
6. Create or join a disposable league and confirm normal onboarding works.

Expected: public-profile creation cannot prevent the private account from being created. A transient public-profile failure is repaired after login.

## 11. Account deletion test

Use only the disposable account from the prior test.

1. Delete the account through the normal account-deletion workflow.
2. Confirm authentication is removed.
3. Confirm `users/{uid}` is gone.
4. Confirm `publicProfiles/{uid}` is gone.

Expected: account deletion does not leave a public-profile record behind.

## 12. Privacy verification

The Firebase Console uses administrator credentials and bypasses security rules, so it cannot prove browser privacy.

The emulator suite already verifies that:

- a signed-in user cannot read another user's private `/users/{uid}` document;
- signed-out users cannot read private or public profiles;
- clients cannot list either profile collection;
- a public profile cannot contain email or other private fields;
- commissioners cannot write the shared global injury report directly.

During browser testing, the practical signal is that normal pages load without private-profile `permission-denied` errors.

## Stop conditions

Stop deployment or roll back if any of these occur:

- Existing accounts cannot load their own profile.
- Account Settings fails to save.
- Game Center loses opponent names or favorite-team styling.
- New account registration fails.
- Injury refresh produces repeated permission errors.
- The shared report becomes empty after a sparse or failed ESPN response.
- A public profile contains email or private preferences.
- Manual commissioner overrides stop working.

## Rollback

Use the commit hash saved before deployment.

```bash
git revert <batch-5-commit-hash>
git push
npm run build:all
firebase deploy --only functions:refreshGlobalPlayerAvailabilityScheduled,functions:refreshDailyPlayerAvailability,functions:getPublicManagerProfiles,functions:deleteMyAccount,firestore:rules,hosting:app -m "Rollback Batch 5"
```

If `getPublicManagerProfiles` did not exist before Batch 5, Firebase may retain the unused Function after a code rollback. It is harmless, or it can be deleted explicitly after the site is stable.


## BATCH_6A_MANUAL_TEST_CHECKLIST.md


# RinkRat Batch 6A — Game Center Structural Refactor Test Checklist

## Purpose

Batch 6A is intended to produce **no visible or scoring-behavior change**. It divides the Game Center into smaller presentation components while keeping `CycleOne` as the single state and scoring presenter.

Use the completed-draft test league retained from Batches 3–5. A league with an active historical-replay matchup is best because it exposes scores, game markers, progress, bench assets, and commissioner controls.

## 1. Automated verification

From the project root:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm ci
npm --prefix functions ci
npm run verify:batch6a
```

Expected result:

- 44 Firestore rules tests pass
- 7 draft-authority tests pass
- 2 league-onboarding tests pass
- 4 competition-authority tests pass
- 7 profile/injury authority tests pass
- 7 Game Center refactor tests pass
- Angular production build completes
- Functions TypeScript build completes

Do not deploy if the Angular build reports an unknown component, unknown input, template error, or component-style budget failure.

## 2. Desktop Game Center smoke test

Use a desktop window around 1440 pixels wide.

1. Sign in and open the completed test league.
2. Open **Game Center** for the current cycle.
3. Confirm the page loads without a blank section, flicker loop, or console error.
4. Confirm the following remain visible in their existing locations:
   - Back to League link
   - Fantasy Season heading and league name
   - Cycle Matchup selector
   - My Team, Schedule Preview, Matchup Overview, Standings, and Playoff links
   - Shared scoring status
   - Cycle explanation
   - Detailed Matchup View heading
5. Compare the page with a prior screenshot when available. This batch should not intentionally alter spacing, colors, typography, wording, or card order.

## 3. Matchup navigation and display modes

In a cycle containing more than one matchup:

1. Use the left and right matchup arrows.
2. Confirm the matchup ID and position counter update.
3. Select **Team A**, **Both**, and **Team B**.
4. Confirm:
   - Team A shows only the first team.
   - Both shows both teams with the VS divider.
   - Team B shows only the second team.
   - Returning to another matchup preserves valid navigation.
5. Open Matchup Overview and return to the detailed matchup.

Stop if a control does nothing, changes the wrong matchup, or produces a console error.

## 4. Team summary and roster progress

For both teams, verify:

- Manager icon and team name load
- NHL theme logo and selected color strip load
- Record displays
- Current and projected totals match the pre-refactor values
- Roster Progress shows the same played and left counts
- Progress-bar width matches the displayed counts
- Screen-reader attributes are present in DevTools:
  - `role="progressbar"`
  - `aria-valuemin="0"`
  - correct `aria-valuemax`
  - correct `aria-valuenow`
  - descriptive `aria-label`

The two sides now share one template, so pay special attention that Team B does not accidentally show Team A’s identity, scores, roster, or progress.

## 5. Active lineup and asynchronous windows

Check forwards, defense, and goalie sections on both teams.

Confirm:

- Every drafted active asset appears in the correct position group
- Current and projected values match previous behavior
- Played/left totals remain correct
- Six game circles remain visible
- Played, missed, upcoming, and unavailable circle states still use the correct appearance
- A player whose next cycle has begun early still shows the correct pending/future-window callout
- No seventh scheduled NHL game is lost or shown in the wrong window
- One player finishing six games does not force unrelated roster slots to finish

This is a visual refactor only; any scoring-window difference is a stop condition.

## 6. Player interactions and status indicators

Test at least one active player and one bench player.

1. Click an active player card and confirm its detail view opens.
2. Focus the same kind of card with the keyboard and press **Enter**.
3. Click a bench asset and confirm its detail view opens.
4. Confirm bench cards still state that their points do not count.
5. Verify an injured or suspended test player, when available:
   - Status indicator appears
   - Tooltip/title text remains correct
   - Injured and suspended visual states are not swapped

## 7. Mobile presentation

Test Chrome responsive mode at approximately 780, 390, and 360 pixels wide. Also test a real phone when convenient.

Confirm:

- Sticky mobile matchup scorebar appears
- Both team names, icons, current totals, projections, cycle label, and readiness label appear
- Scorebar remains sticky without covering page controls
- Mobile head-to-head rows align Team A and Team B correctly
- Position labels and slot numbers remain centered
- Game circles remain readable
- Bench comparison remains visually separate
- No horizontal page scrolling appears
- No player card is clipped or layered over another card

## 8. Completed matchup breakdown

Open a completed matchup and verify:

- Projected winner note remains present
- “Why this matchup finished this way” section appears
- Both team position breakdowns load
- Current, projected, and delta values remain correct
- Top Contributors appears
- Biggest Overperformers appears
- Biggest Underperformers appears
- Empty messages still appear when a category has no players

## 9. Commissioner-only controls

As commissioner:

1. Expand **Dev Controls**.
2. Confirm historical replay controls remain visible and responsive.
3. Confirm Shared Score Refresh remains available.
4. Confirm the test injury email control remains available when developer tools are enabled.
5. Do not advance a replay day unless using the dedicated disposable historical test league.

As an ordinary manager, confirm the commissioner Dev Controls are absent.

## 10. Theme and browser console check

Test at least the lightest available theme and a dark theme.

Confirm:

- Game Center colors match prior behavior
- Team theme colors still apply independently to both teams
- Text remains readable
- No styles from Game Center appear on Dashboard, My Team, League HQ, or another route after navigating away
- Browser console contains no new red errors
- No `permission-denied` errors appear
- No `NG0303`, unknown-property, or unknown-element errors appear

## 11. Commit and deploy

After all verification passes:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey

git restore .firebase/hosting.ZGlzdC9mYW50YXN5LWhvY2tleS9icm93c2Vy.cache 2>/dev/null || true

git status
git add .
git commit -m "Refactor Game Center into presentation components"
git push

git rev-parse --short HEAD
```

Save the commit hash.

This batch requires hosting only:

```bash
firebase deploy --only hosting:app -m "Batch 6A Game Center component refactor"
```

Hard-refresh with **Command + Shift + R**, then repeat Sections 2, 3, 4, and 7 in production.

## Stop conditions

Rollback or stop deployment if any of these occur:

- Angular template or component-style budget failure
- Blank Game Center or missing matchup card
- Team B displays Team A data
- Current/projected scores change unexpectedly
- Roster progress differs from the previous build
- Missing active player, bench asset, or game marker
- Seventh-game rollover or independent windows look different
- Completed-matchup breakdown disappears
- Mobile horizontal scrolling or severe overlap
- Styles leak onto another page
- New console, Firebase permission, or callable Function errors

## Rollback

No data migration, Function, rule, or index change is included. Rollback is a hosting rollback to the saved pre-Batch-6A commit:

```bash
git revert <BATCH_6A_COMMIT_HASH>
git push
firebase deploy --only hosting:app -m "Rollback Batch 6A Game Center refactor"
```


## BATCH_6B_2_MANUAL_TEST_CHECKLIST.md


# Batch 6B.2 — Game Center Hierarchy Rollback Test Checklist

This update restores the approved Batch 6A.1 Game Center appearance while retaining the structural component refactor.

## Automated verification

Run:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm run verify:batch6b-rollback
```

The command should complete with:

- Firestore rules tests passing
- Draft-authority tests passing
- League-onboarding tests passing
- Competition-authority tests passing
- Profile/injury-authority tests passing
- Game Center structural-refactor tests passing
- Game Center rollback tests passing
- Angular production build completing
- Functions TypeScript build completing

Do not deploy if any test or build fails.

## Manual Game Center checks

Use the same started league used for Batch 6A and Batch 6B testing.

1. Open Game Center on desktop.
2. Confirm the large Batch 6B lead/trail/tie overview is gone.
3. Confirm the matchup card begins with the original matchup heading and status badges.
4. Confirm each team still has its original Roster Progress bar with played and left totals.
5. Confirm scores, projections, game markers, lineups, bench cards, and completed-matchup details still appear.
6. Switch among Team A, Both, and Team B views and verify the correct roster appears.
7. Resize to approximately 390 pixels wide.
8. Confirm the sticky mobile scorebar has returned to the simpler score, projection, cycle, and status layout.
9. Confirm there is no duplicated matchup progress information.
10. Verify dark and light themes remain readable.
11. Open player details and bench cards.
12. Confirm there are no new red browser-console errors.

## Deployment

This update is frontend-only:

```bash
firebase deploy --only hosting:app -m "Restore original Game Center hierarchy"
```

After deployment, hard-refresh with Command + Shift + R.


# Historical implementation and operations notes


## ADD_DROP_DECISION_CENTER_UPDATE.txt

```text

RINKRAT ADD/DROP DECISION CENTER UPDATE
July 28, 2026

LIGHT ICE CONTRAST
- The scrolling NHL logo ribbon now remains intentionally dark in every site theme.
- Team abbreviation text stays white against the dark logo chips, fixing the nearly invisible labels in Light Ice.
- The Free Agents / Add-Drop workspace now uses a stable dark decision surface in every theme.
- Search, position, sort controls, headings, helper text, player rows, and roster-slot comparison panels retain strong contrast.

FREE-AGENT DECISION DATA
Each free agent and waiver player now shows:
- Current NHL-team six-game cycle number.
- Six game markers:
  green = player appeared and the game counted,
  red = the NHL team played but the player missed the game,
  yellow = upcoming scheduled game.
- Current-season fantasy points.
- Projected fantasy points for the rest of the regular season.
- Next-cycle projection.
- Estimated final-season fantasy total.
- Ahead / behind / on-pace comparison against the stable draft projection.
- Next-cycle rank.

Expandable decision details include:
- Projection reliability.
- Upcoming schedule difficulty and point adjustment.
- Expected availability within the next six-game window.
- Projection data source.
- Season, last-3, last-5, last-10, and last-20 fantasy-point pace.
- NHL appearance and team-game sample sizes.
- Category-by-category fantasy point breakdown.

The point breakdown is exact from current-season game rows when those rows are available. The NHL projection feed does not distinguish primary from secondary assists, so the assist split is explicitly labeled as an estimate. Aggregate-stat fallback is also labeled when game rows are unavailable.

ADD VERSUS DROP COMPARISON
- Roster-slot choices now show the outgoing player's season points, next-cycle projection, and projection-performance indicator.
- Selecting a slot opens a side-by-side incoming/outgoing comparison.
- The comparison shows season points, rest-of-season estimate, next-cycle projection, estimated final total, and the projected gain or loss created by the move.
- The outgoing player's detailed pace, reliability, availability, schedule, and stat breakdown can be expanded before confirming.
- Open slots are clearly identified as removing no player value.

RESPONSIVE DESIGN
- Desktop keeps the full decision grid visible.
- Tablet stacks action and comparison areas while preserving the important metrics.
- Phone view keeps the cycle markers, four core projections, performance status, and confirmation flow visible; deeper pace and stat details remain available through expandable sections.

PROJECTION SNAPSHOT VERSION
- Shared projection schema version increased from 8 to 9.
- Version 9 adds decision fields, current-cycle markers, and stat breakdowns to shared projection assets.
- Existing version-8 snapshots are considered stale and should regenerate through the normal projection refresh path.

```


## ADMIN_CENTER_SETUP_GUIDE.txt

```text

RINKRAT ADMIN CENTER — ONE-TIME OWNER SETUP
============================================

The Admin Center is intentionally hidden from normal users and league commissioners.
After deploying this update, grant your own main account access once:

1. Open Firebase Console for project nhl-fantasy-app-ab673.
2. Open Security > Authentication > Users.
3. Find your main RinkRat account and copy its UID.
4. Open Firestore Database > Data.
5. Create a top-level collection named:

   platformAdmins

6. Create a document whose Document ID is your copied Firebase UID.
7. Add these fields:

   enabled   Boolean   true
   role      String    owner

8. Save the document.
9. Sign out of RinkRat and sign back in, or open a new tab.
10. The Admin link will appear in desktop navigation and the mobile More menu.

The platformAdmins collection is denied by Firestore browser rules. Creating the record
in Firebase Console works because the Console uses administrative credentials.

OPTIONAL CUSTOM CLAIM
---------------------
The Cloud Functions also accept a Firebase Auth custom claim:

   platformAdmin: true

The Firestore platformAdmins document is the simpler bootstrap method and does not
require a local service-account script.

HOW TO REMOVE ACCESS
--------------------
Set enabled to false or delete the user's platformAdmins document, then have that user
sign out and back in. Normal league commissioner permissions are not affected.

WHAT THE ADMIN CENTER CAN READ
------------------------------
- feedbackReports
- clientErrorReports
- adminErrorReviews

It does not provide arbitrary Firestore browsing or control over fantasy league data.

```


## APP_CHECK_ROLLOUT_GUIDE.txt

```text

RINKRAT FIREBASE APP CHECK — STAGED ROLLOUT GUIDE
=================================================

Do not enable enforcement before completing the monitoring stage.

STAGE 1 — CREATE THE PROVIDER
-----------------------------
1. Open Google Cloud Console for project nhl-fantasy-app-ab673.
2. Open reCAPTCHA Enterprise.
3. Create a Website, score-based key. Do not enable a checkbox challenge.
4. Add these production domains:
   - rinkratfantasy.com
   - www.rinkratfantasy.com
   - cycle-puck.web.app
   - cycle-puck.firebaseapp.com
5. Open Firebase Console > Security > App Check.
6. Register the RinkRat web app using the reCAPTCHA Enterprise provider and the
   public site key created above.

STAGE 2 — ENABLE TOKENS IN THE CLIENT
-------------------------------------
Edit:
  src/environments/app-check.config.ts

Set:
  enabled: true
  recaptchaEnterpriseSiteKey: 'YOUR_PUBLIC_SITE_KEY'

The site key is public configuration. Do not place a secret key in the web app.
Keep localDebugTokenEnabled false for normal production builds.

Build and deploy the frontend. At this stage, Firebase receives App Check tokens
but requests are not rejected yet.

STAGE 3 — LOCAL DEVELOPMENT
---------------------------
For localhost testing after App Check is enabled:
1. Temporarily set localDebugTokenEnabled: true in your local branch only.
2. Start the app locally.
3. Copy the debug token printed in the browser console.
4. Register that token in Firebase Console > App Check > Manage debug tokens.
5. Never commit a fixed debug token or enable local debug mode in production.

STAGE 4 — MONITOR
-----------------
In Firebase Console > Security > App Check, review request metrics for:
- Cloud Firestore
- Authentication
- Cloud Functions

Confirm that normal desktop, mobile, Safari, Chrome, login, draft, scoring,
feedback, league deletion, and account deletion traffic is verified.
Monitor for several days during beta before enforcing anything.

STAGE 5 — ENFORCE GRADUALLY
---------------------------
Recommended order:
1. Callable Cloud Functions
2. Cloud Firestore
3. Authentication

Enable only one service at a time. Retest the complete multi-account workflow
after each enforcement change. Keep a rollback plan and disable enforcement if
legitimate managers begin receiving permission or unauthorized errors.

```


## AUTO_DRAFT_BUTTON_CLICK_FIX.txt

```text

RinkRat Auto-Draft Button Click Fix

This patch addresses a Safari/macOS pointer hit-testing regression introduced by the Phase 2A Draft Room jumbotron styling.

Changes:
- Removes clip-path from the interactive Draft Room header container.
- Makes decorative header pseudo-elements ignore pointer events.
- Raises the Draft header actions and Auto-Draft button above decorative layers.
- Adds touch-action support for reliable tapping on mobile/tablet browsers.

No draft logic, Firebase rules, scoring, or database schema are changed.

```


## BATCH_1_SECURITY_TEST_FOUNDATION_UPDATE.txt

```text

RINKRAT — BATCH 1 SECURITY TEST FOUNDATION
===========================================

Purpose
-------
This batch creates a repeatable security test foundation before the more restrictive roster,
draft, scoring, injury, and profile changes begin.

What changed
------------
1. Added 24 Firestore Emulator security tests covering:
   - signed-out access
   - account profiles
   - league members and outsiders
   - team and roster records
   - draft state, picks, and private queues
   - transactions and waivers
   - cycles, matchups, roster picks, and team windows
   - playoff records and playoff window banks
   - live-scoring documents
   - global and league-specific availability records

2. Added five test identities:
   - commissioner
   - manager
   - opponent manager
   - signed-in league outsider
   - signed-out browser

3. Added safe emulator commands:
   - npm run test:rules
   - npm run verify:batch1

   The rules suite uses the demo project id demo-rinkrat-rules. It does not use the production
   Firebase project.

4. Documented current security exposures as executable tests.
   Tests labeled [baseline exposure] intentionally prove that a risky permission still exists.
   Those tests will be flipped from allowed to denied as later batches harden each area.

5. Fixed the live-scoring refresh permission mismatch.
   The browser no longer tries to write leagues/{leagueId}/liveScoring/control when the
   commissioner requests a refresh. It now calls a trusted Cloud Function that runs the same
   Admin SDK scoring path used by scheduled automation.

6. Added two server-controlled scoring recovery actions:
   - releaseLeagueLiveScoringHandoff
   - clearExpiredOrErroredLiveScoringLease

   Both refuse to interrupt a healthy active server worker.

7. Updated the Live Scoring Diagnostics screen so it describes server automation rather than a
   commissioner browser acting as the authoritative scoring worker.

Intentionally not fixed in Batch 1
----------------------------------
The following exposures remain because later batches will change them behind dedicated server
transactions and migration-safe client flows:

- owners can directly overwrite structurally valid roster documents
- commissioners can directly overwrite other teams' rosters
- draft picks can contain non-canonical client asset objects
- commissioners can directly alter draft and competition records
- transaction and waiver validation trusts too much client data
- commissioners can write the global availability document
- any signed-in user can get another user's full profile document

Leaving these unchanged in this batch prevents us from tightening rules without first having tests
that prove which legitimate flows would break.

Files added
-----------
- test/firestore-rules/emulator-helpers.mjs
- test/firestore-rules/firestore.rules.test.mjs
- test/firestore-rules/README.md
- BATCH_1_SECURITY_TEST_FOUNDATION_UPDATE.txt
- BATCH_1_MANUAL_TEST_CHECKLIST.md

Files updated
-------------
- package.json
- firebase.json
- functions/src/index.ts
- functions/src/league-automation.ts
- src/app/core/live-scoring/live-scoring.service.ts
- src/app/features/live-scoring/live-scoring-diagnostics/live-scoring-diagnostics.ts
- src/app/features/live-scoring/live-scoring-diagnostics/live-scoring-diagnostics.html
- src/app/features/cycles/cycle-one/cycle-one.ts

```


## BATCH_2_ROSTER_AUTHORITY_UPDATE.txt

```text

RINKRAT BATCH 2 — ROSTER AUTHORITY HARDENING
================================================

PURPOSE
-------
Batch 2 moves ordinary manager roster, transaction, waiver, and waiver-claim
writes out of the browser and behind authenticated Cloud Functions.

PRIMARY CHANGES
---------------
1. Added executeSecureRosterAction (Cloud Function)
   - Validates the signed-in manager's league membership and team ownership.
   - Requires the league draft to be complete before roster moves.
   - Handles free-agent adds, add/drops, open-slot adds, queued moves,
     active/bench swaps, IR moves, IR activation, drops, waiver claims,
     waiver awards, and queued-move cancellation.
   - Writes the roster, waiver, and transaction records atomically with the
     Firebase Admin SDK.

2. Added ensureFantasyRoster (Cloud Function)
   - Creates a missing roster only for the signed-in user's own team.
   - Migrates legacy roster documents to the current 14 active / 3 bench /
     3 IR schema.
   - Replaces browser-side roster creation and migration writes.

3. Hardened immediate active-slot moves
   - The browser now sends only an asset key.
   - applyImmediateRosterMove reloads the canonical asset from the league's
     authoritative projection snapshot instead of trusting client-supplied
     player names, positions, projections, or other fields.
   - Duplicate ownership checks use actual team document IDs.

4. Added server-side roster validation
   - Canonical free-agent lookup.
   - Duplicate ownership and queued-reservation checks across the league.
   - Position and slot-state checks.
   - Active waiver protection.
   - Server-calculated earliest fair cycle.
   - Authoritative IR eligibility checks.
   - Protection for bench players reserved by queued swaps.
   - Waiver priority processing from team documents read inside the server
     transaction.

5. Tightened Firestore rules
   - Ordinary managers can no longer directly create or update roster docs.
   - Ordinary managers can no longer create transaction docs.
   - Ordinary managers can no longer create/update/delete waiver docs or append
     claims directly.
   - Browser roster creation is denied; ensureFantasyRoster performs it.
   - Removed obsolete manager-write validation helpers from the rules.

6. Expanded the rules test suite
   - 28 total Firestore Emulator tests.
   - Forged owner roster overwrite is now denied.
   - Recreating a missing roster from the browser is denied.
   - Direct manager transaction creation is denied.
   - Arbitrary waiver creation is denied.
   - Direct waiver-claim updates are denied.
   - A temporary same-batch manual draft roster update remains tested so
     drafting is not broken before Batch 3.

7. Added npm run verify:batch2
   - Runs the complete Firestore rules suite, Angular build, and Functions
     TypeScript build.

IMPORTANT TEMPORARY TRANSITION PATHS
------------------------------------
Two browser write paths intentionally remain until their scheduled batches:

- Batch 3 dependency: a manager making a valid manual draft pick may update
  their existing roster in the same atomic draft transaction. Draft authority
  and canonical draft assets are hardened in Batch 3.

- Batch 4 dependency: a league commissioner may still update roster, waiver,
  and transaction records because current cycle/playoff boundary code runs in
  the commissioner browser. This is removed when scoring/cycle/playoff
  authority moves fully server-side in Batch 4.

These are documented transition exceptions, not final release permissions.

DATA MIGRATION
--------------
No destructive production migration is required. Existing roster documents are
preserved. Missing or legacy rosters are normalized on demand through
ensureFantasyRoster.

FILES ADDED
-----------
- functions/src/roster-authority.ts
- src/app/core/transactions/roster-authority.service.ts

KEY FILES UPDATED
-----------------
- firestore.rules
- functions/src/index.ts
- functions/src/roster-moves.ts
- src/app/core/draft/draft.service.ts
- src/app/core/team/roster.service.ts
- src/app/core/transactions/immediate-roster-move.service.ts
- test/firestore-rules/firestore.rules.test.mjs
- test/firestore-rules/emulator-helpers.mjs
- test/firestore-rules/README.md
- package.json

LOCAL VALIDATION COMPLETED IN THE DELIVERY ENVIRONMENT
------------------------------------------------------
- Changed TypeScript files passed TypeScript syntax/transpile checks.
- JavaScript test files passed node --check.
- JSON configuration files parsed successfully.
- Source references and Function exports were checked.
- ZIP integrity is checked before delivery.

The full Angular build, Functions build, and Firebase Emulator tests must be run
on Stephen's project machine because the delivery environment cannot install
all locked npm packages or run the Firebase CLI.

```


## BATCH_3_1_LEAGUE_ONBOARDING_HOTFIX.txt

```text

RINKRAT BATCH 3.1 — LEAGUE ONBOARDING PERMISSION HOTFIX
========================================================

ROOT CAUSE
----------
Batch 2 correctly made roster/current server-authoritative by denying browser
roster creation. However, the existing create-league and join-league client
flows still tried to create roster/current inside their Firestore write batch.
Because one write in the batch was denied, the entire Create League or Join
League action surfaced "Missing or insufficient permissions."

This was a client/rules integration regression. It was not caused by the age of
the account, platform-admin status, league commissioner status, or Batch 3's
secure draft callable.

FIX
---
- Create League now writes only the league, invite, commissioner membership,
  and commissioner team from the browser.
- Join League now writes only the membership and team from the browser.
- Roster creation and legacy roster repair now use ensureFantasyRoster, the
  authenticated Cloud Function introduced in Batch 2.
- Existing memberships that are missing a roster are repaired through the same
  callable.
- Added Firestore Emulator regression tests for the complete create/join write
  batches.
- Added source-contract tests that fail if create/join reintroduce direct roster
  writes.
- verify:batch3 now includes the new league-onboarding regression suite.

DEPLOYMENT
----------
The necessary ensureFantasyRoster Function and tightened Firestore rules are
already deployed. This hotfix only requires the updated hosting build after all
verification passes.

```


## BATCH_3_DRAFT_AUTHORITY_UPDATE.txt

```text

RINKRAT BATCH 3 — DRAFT AUTHORITY HARDENING
==============================================

PURPOSE
-------
Batch 3 removes authoritative draft progression from the browser. Draft setup,
clock controls, manual picks, automatic picks, roster placement, and pick
records now pass through Cloud Functions or existing server automation.

PRIMARY CHANGES
---------------
1. Added executeDraftCommand (callable Cloud Function)
   - Saves draft settings only for the commissioner.
   - Requires the snake order to contain every current league team exactly once.
   - Restricts pick-clock values to supported durations.
   - Requires a healthy verified Projection V9 snapshot before scheduling.
   - Opens scheduled drafts, starts the first clock, and handles commissioner
     pause/resume commands without browser writes to the draft document.
   - Locks settings once picks or a live/completed draft exist.

2. Added makeSecureDraftPick (callable Cloud Function)
   - Accepts only leagueId and assetKey from the browser.
   - Verifies authentication, league membership, current turn, live clock state,
     and unexpired pick time.
   - Loads the complete canonical asset from the draft's frozen shared
     projection snapshot instead of trusting client-supplied player data.
   - Rechecks all authority and timing conditions inside one Firestore
     transaction.
   - Stops the draft if the current team documents no longer exactly match the
     saved draft order.
   - Rejects duplicate drafted assets and assets already assigned to any roster.
   - Validates starter/bench destination and positional feasibility.
   - Preserves enough assets for other managers' required starting positions.
   - Atomically writes the pick, roster, queue, and next draft state.
   - Stamps manual pick records with authority: "cloud-function" and the frozen
     projectionSnapshotId.

3. Centralized server draft-selection logic
   - Added functions/src/draft-pick-engine.ts.
   - Manual and automatic server picks now share the same snake-order,
     destination, bench-role, position-reserve, and roster-placement logic.
   - Automatic pick records now also include authority: "cloud-function" and
     projectionSnapshotId.
   - Server automatic picks verify the frozen snapshot again inside the
     transaction before committing.

4. Removed the legacy browser draft transaction
   - The Angular draft service no longer contains the former direct Firestore
     transaction that accepted a complete client-provided DraftableAsset.
   - The client submits only the selected assetKey to makeSecureDraftPick.
   - The obsolete browser automatic-pick API was removed; scheduled automation
     and Cloud Tasks own all automatic selections.

5. Tightened Firestore rules
   - All browser create/update/delete operations on draft/current are denied.
   - All browser create/update/delete operations on draft pick records are denied.
   - The former temporary manual-draft roster-write exception is removed.
   - A manager may edit only their own queue.
   - Commissioners may read queues for draft visibility but cannot reorder or
     enable auto-draft for another manager.
   - Shared projection records cannot be modified during any live draft, so the
     frozen pool remains immutable from the first clock through the final pick.

6. Updated the Draft Room
   - Removed the commissioner control that changed another manager's auto-draft
     preference.
   - Removed the live-draft browser projection-rebuild path, which conflicts with
     an immutable frozen draft pool.
   - Managers retain control of their own queue and auto-draft setting.
   - Commissioner pause/resume remains available through executeDraftCommand.

7. Expanded automated coverage
   - 32 Firestore Emulator security tests.
   - 7 pure server draft-engine tests.
   - New security tests deny forged picks, direct draft creation, draft clock
     manipulation, commissioner draft tampering, live projection tampering, and
     commissioner edits to another manager's queue.
   - Draft-engine tests cover snake order, starter-first auto-draft behavior,
     queue fallback, bench-role diversity, goalie reserve protection, and
     authoritative roster placement.

8. Added npm scripts
   - npm run test:draft-authority
   - npm run verify:batch3

AUTHORITY BOUNDARY AFTER BATCH 3
--------------------------------
Browser clients may:
- read draft state and picks when they are league members;
- manage only their own draft queue and auto-draft preference;
- request commissioner draft commands through executeDraftCommand;
- request their own current manual pick by assetKey through makeSecureDraftPick.

Browser clients may not:
- create, update, or delete the draft document;
- create, update, or delete pick documents;
- place a drafted player directly onto a roster;
- submit an automatic pick;
- edit another manager's queue;
- change the shared projection pool while the draft is live.

Cloud Functions/server automation own:
- authoritative settings validation;
- scheduled opening and clock state;
- manual and automatic pick selection;
- canonical asset lookup;
- roster placement;
- duplicate prevention;
- pick/queue/draft atomic progression.

DATA AND DEPLOYMENT SAFETY
--------------------------
- Do not deploy Batch 3 while a real draft is actively running.
- Before deployment, inspect every live draft with existing picks. It must have a
  non-empty serverDraftProjectionSnapshotId. A legacy live draft with picks but
  no frozen snapshot is deliberately stopped by the new callable rather than
  silently continuing from a different player pool.
- Functions must be deployed before hosting, and rules must be deployed only
  after the pre-rules browser smoke test passes.
- No destructive data migration is performed automatically.

IMPORTANT REMAINING TRANSITION PATH
-----------------------------------
Batch 4 still needs to move commissioner cycle, matchup, standings, playoff,
waiver-boundary, and related competition writes fully behind server authority.
The rules tests continue to label those permissions as baseline exposure or a
temporary Batch 4 dependency.

FILES ADDED
-----------
- functions/src/draft-authority.ts
- functions/src/draft-pick-engine.ts
- src/app/core/draft/draft-authority.service.ts
- test/draft-authority/draft-pick-engine.test.mjs

KEY FILES UPDATED
-----------------
- firestore.rules
- functions/src/draft-automation.ts
- functions/src/index.ts
- src/app/core/draft/draft.service.ts
- src/app/features/draft/draft-room/draft-room.ts
- src/app/features/draft/draft-room/draft-room.html
- src/app/features/draft/draft-room/draft-room.css
- test/firestore-rules/firestore.rules.test.mjs
- test/firestore-rules/README.md
- package.json

LOCAL VALIDATION COMPLETED IN THE DELIVERY ENVIRONMENT
------------------------------------------------------
- Changed TypeScript files passed TypeScript syntax/transpile checks.
- JavaScript test files passed node --check.
- The 7 pure draft-engine tests were executed successfully against a temporary
  compiled copy of the engine.
- JSON configuration parsed successfully.
- Firestore rules delimiter structure was checked.
- Client source was checked for remaining direct draft/pick writes.
- Function exports and deployment names were verified.
- ZIP integrity is checked before delivery.

The Angular build, Functions semantic TypeScript build, and Firebase Emulator
suite must still be run on Stephen's Mac because the delivery environment's npm
mirror cannot install all locked dependencies and it cannot run the Firebase
CLI emulators.

```


## BATCH_4_COMPETITION_AUTHORITY_UPDATE.txt

```text

RINKRAT BATCH 4 — COMPETITION AUTHORITY HARDENING
=================================================

Purpose
-------
Make scoring, roster-window progression, standings, cycle transitions, and
playoff records server-authoritative before public release.

What changed
------------
1. Firestore competition records are read-only to browsers.
   - Roster documents
   - Transaction audit records
   - Waiver records
   - Cycle documents and matchup records
   - Cycle roster snapshots and team windows
   - Playoff brackets and playoff window banks

2. Team identity updates remain available, but calculated fields are protected.
   Managers and commissioners may update only teamName, managerName,
   profileIconId, logo, and updatedAt from the browser. Wins, losses, ties,
   points for/against, waiver priority, and draft position are server-owned.

3. Browser live scoring is now read-only.
   The old browser lease/scoring writer has been removed from the live-scoring
   service. Browsers listen to shared snapshots and call authenticated Cloud
   Functions for manual refresh or recovery actions.

4. Manual next-period opening is server-authoritative.
   The new openNextCompetitionPeriod callable verifies commissioner ownership
   and delegates to the same Admin SDK lifecycle used by scheduled scoring.
   It is idempotent and returns an existing next cycle rather than duplicating
   it when two requests overlap.

5. The matchup page no longer persists competition state.
   Finalize and next-period controls request server reconciliation instead of
   writing cycles, matchups, standings, windows, or playoffs directly.

6. Projection-accuracy analytics remain intentionally separate.
   Commissioners may still write projection-accuracy detail records and a
   tightly limited cycle marker containing only analytics status/count fields.
   These fields cannot alter competition results or progression.

Automated verification
----------------------
- 40 Firestore Emulator rules tests
- 7 draft-engine tests retained from Batch 3
- 2 league-onboarding contract tests retained from Batch 3.1
- 4 competition-authority contract tests
- Angular production build
- Functions TypeScript build

Run:
  npm run verify:batch4

Expected total named tests: 53, with zero failures.

Deployment order
----------------
1. Deploy the competition-authority Functions.
2. Deploy hosting.
3. Run the pre-rules smoke test.
4. Deploy Firestore rules.
5. Repeat the post-rules regression checklist.

See RinkRat_Batch_4_Test_Checklist.md supplied with this package for the full
verification, deployment, Firestore inspection, stop conditions, and rollback
procedure.

```


## BATCH_5_2_FUNCTIONS_BUILD_HOTFIX.txt

```text

RinkRat Batch 5.2 - Functions TypeScript Build Hotfix
July 30, 2026

This hotfix corrects the five Functions build errors reported after Batch 5.1.

Corrections:
1. Added an explicit discriminated union for the global injury refresh transaction claim.
   This allows TypeScript to prove that the skipped-refresh branch cannot pass a
   "success" status into buildSkippedResult().

2. Restored the DeleteLeagueResult return interface used by the deleteLeague callable.

3. Reconnected league deletion cleanup to the existing generic
   deleteTopLevelDocumentsByField() helper for leagueInvites, injuryEmailQueue, and
   emailNotificationLog.

4. Retains the Batch 5.1 public-profile updatedAt type narrowing fix.

No Firestore schema, security-rule, callable API, or runtime behavior was intentionally
changed by this hotfix. It is a TypeScript integration/build correction.

```


## BATCH_5_INJURY_PROFILE_AUTHORITY_UPDATE.txt

```text

RINKRAT BATCH 5 — INJURY DATA AUTHORITY AND PROFILE PRIVACY
============================================================

Purpose
-------
This batch closes two important privacy and authority gaps:

1. Private account documents are now readable only by their owner.
2. The shared ESPN injury report can now be written only by trusted Cloud Functions.

The site still displays manager names and favorite-team styling through a separate,
minimal public profile containing only display-safe fields.

Major changes
-------------

PRIVATE AND PUBLIC PROFILES
- /users/{uid} is now private to that signed-in user.
- Added /publicProfiles/{uid} with only:
  - uid
  - username
  - favoriteTeamAbbreviation
  - favoriteTeamVariantId
  - updatedAt
- Public-profile collection listing is denied.
- Users may update only their own public profile.
- Email addresses, injury-email preferences, accessibility preferences, unlocks,
  onboarding state, and other private account fields are never copied publicly.
- Existing accounts are repaired lazily after login or when their league matchup
  identity is requested. No bulk migration is required.
- Username and favorite-team changes update the private and public copies together.
- Account deletion now removes the public profile too.

LEAGUE MANAGER IDENTITY
- Game Center no longer reads an opponent's private /users document.
- Added getPublicManagerProfiles Cloud Function.
- The function verifies the requester belongs to the league.
- It returns profiles only for managers who own teams in that league.
- It returns only display-safe fields and backfills missing legacy public profiles.

INJURY DATA AUTHORITY
- Browsers can read the shared appData/playerAvailability report but cannot write it.
- The browser no longer fetches ESPN directly or writes shared injury data.
- refreshDailyPlayerAvailability verifies league membership before running.
- Forced/manual refreshes require the league commissioner.
- A global lease prevents duplicate concurrent refreshes.
- Successful, running, cooldown, and error states are handled server-side.
- The scheduled server refresh and authenticated callable now share one authority path.
- The shared report no longer stores the requesting league ID or a user's UID as the
  report authority label.
- League-specific commissioner manual overrides remain separate and continue to work.

TEST COVERAGE
-------------
- 44 Firestore security-rule tests
- 7 draft-authority tests
- 2 league-onboarding tests
- 4 competition-authority tests
- 7 profile/injury authority contract tests
- 64 named tests total, plus Angular and Functions production builds

Deployment order
----------------
Deploy Functions first, then Firestore rules, then hosting.

This order ensures the new callables exist before the browser uses them, closes the
old private/global write paths before the new client is released, and avoids a new
client attempting public-profile writes before the publicProfiles rules exist.

Compatibility
-------------
- No manual Firestore migration is required.
- Existing accounts are backfilled safely and gradually.
- Missing public profiles do not prevent login or account creation.
- Existing leagues, team identities, profile icons, and favorite-team themes remain
  compatible.

```


## BATCH_6A_1_TEAM_B_NULLABLE_OWNER_HOTFIX.txt

```text

RinkRat Batch 6A.1 - Nullable Team B Owner Build Hotfix
Date: July 30, 2026

Corrected the reusable Game Center team-panel input so it accepts `string | null`.

Why this is correct:
- FantasyMatchup.teamBOwnerId is intentionally nullable for bye/unpaired matchups.
- The original pre-refactor Game Center template already passed the nullable value directly to presenter methods.
- Those presenter methods are designed to accept a null owner ID and render safe fallback values.
- The extracted component had accidentally narrowed the input to `string`, causing Angular strict-template compilation to fail.

No scoring logic, Firestore behavior, layout, markup, or runtime data was changed.

```


## BATCH_6A_GAME_CENTER_COMPONENT_REFACTOR_UPDATE.txt

```text

RINKRAT BATCH 6A — GAME CENTER COMPONENT BOUNDARIES
====================================================

PURPOSE
-------
This batch restructures the Game Center / cycle matchup route without intentionally changing its
appearance, scoring behavior, Firestore reads, Cloud Function calls, navigation, or asynchronous
six-game roster-window model.

The goal is to make the flagship page safer to maintain before the later information-hierarchy,
mobile, accessibility, and visual-system work.

WHAT CHANGED
------------
1. The 2,660-line route template is now a 309-line page composition.
2. The matchup card shell is now 81 lines instead of approximately 2,052 lines.
3. The duplicated Team A and Team B panels now use one reusable team-panel template.
4. The following presentation boundaries were extracted:
   - Mobile matchup scorebar
   - Game Center page header
   - Automatic/scoring status banners
   - Six-game cycle explainer
   - Matchup navigation and Team A/B/Both controls
   - Matchup card shell
   - Mobile head-to-head roster
   - Reusable manager/team panel
   - Completed-matchup breakdown
5. Game Center-only types and constants moved to cycle-one.models.ts.
6. Authentication wait logic moved to cycle-one-auth.util.ts.
7. The original stylesheet is emitted without Angular parent-only scoping, but every selector is
   explicitly limited to the Game Center host. This allows extracted child templates to keep the
   exact existing appearance without leaking styles to other pages.
8. Seven new source-contract tests protect the component boundaries, shared team panel,
   asynchronous window UI, scoped stylesheet, browser read-only authority, and exact pre-refactor
   markup.

BEHAVIOR-PRESERVATION DESIGN
----------------------------
The CycleOne route remains the only state/scoring presenter in this batch. Extracted components are
presentation-only. They receive the existing route presenter and do not import Firebase, Firestore,
callable Functions, scoring services, roster services, or draft services.

A reconstruction test expands all new component templates and verifies that the normalized markup
has the exact same SHA-256 digest as the pre-refactor Game Center template. This protects against
accidentally dropping a score, progress bar, player card, bench section, game marker, status badge,
or completed-matchup detail during the extraction.

INTENTIONALLY UNCHANGED
-----------------------
- Current and projected scoring
- Six-game immutable roster-slot windows
- Seventh-game rollover behavior
- Roster progress calculations and labels
- Score-change animations
- Team A / Both / Team B display modes
- Mobile head-to-head presentation
- Bench scoring behavior
- Injury and suspension indicators
- Player detail actions
- Matchup navigation
- Commissioner replay and refresh controls
- Firestore rules
- Cloud Functions
- Firestore indexes
- Existing league data

NEW VERIFICATION COMMAND
------------------------
npm run verify:batch6a

This runs:
- 44 Firestore emulator rules tests
- 7 draft-authority tests
- 2 league-onboarding tests
- 4 competition-authority tests
- 7 profile/injury authority tests
- 7 Game Center refactor contract tests
- Angular production build
- Functions TypeScript build

DEPLOYMENT SCOPE
----------------
Hosting only. This batch contains no backend, rules, index, or data-migration changes.

NEXT PLANNED STEP
-----------------
After Batch 6A passes production smoke testing, Batch 6B can improve Game Center information
hierarchy and mobile usability from these smaller component boundaries rather than editing one
monolithic template.

```


## BATCH_6B_2_GAME_CENTER_HIERARCHY_ROLLBACK.txt

```text

RINKRAT BATCH 6B.2 — GAME CENTER HIERARCHY ROLLBACK

Purpose
-------
This update removes the Batch 6B matchup-overview redesign and restores the Game Center appearance from the approved Batch 6A.1 checkpoint.

What was removed
----------------
- The large lead/trail/tie summary block above each matchup.
- The duplicate combined matchup-progress overview.
- The added projection-maturity messaging.
- The added progress bars and counted-game totals inside the sticky mobile scorebar.
- The Batch 6B matchup-summary utility and hierarchy-only presentation component.

What was kept
-------------
- The Batch 6A component refactor.
- Existing score and projection displays.
- Existing per-team Roster Progress bars.
- Existing desktop and mobile matchup layouts.
- The nullable Team B owner fix for bye and unpaired matchups.
- All security, roster, draft, scoring, injury, and profile-authority work from Batches 1–5.
- The asynchronous six-game player-window architecture.

Behavioral impact
-----------------
This is a frontend presentation rollback only. It does not change scoring, Firestore rules, Cloud Functions, draft behavior, roster moves, cycles, standings, injuries, or playoff processing.

```


## BENCH_CARD_AND_MATCHUP_VISIBILITY_UPDATE.txt

```text

RINKRAT BENCH CARD + MATCHUP VISIBILITY UPDATE

My Team
- Rebuilt all three bench cards with the same fantasy-player-card structure used by active starters.
- Bench cards now keep consistent logo, name, team/position, projection, injury/suspension, and action placement.
- Start, Move to IR, and Drop controls stop their clicks from opening player detail.
- Bench cards clearly state that benched assets do not score.

Matchup Detail
- Added a Bench section below each team's active lineup.
- Reads the current roster document for only the matchup teams currently being displayed, so add/drop and bench changes remain accurate without listening to every team in the league.
- Displays all three bench slots using the same player-card presentation as starters.
- Bench projections remain visible, but current score is shown as non-scoring while benched.
- Added the same bench comparison beneath the active position groups in the condensed mobile head-to-head layout.
- Empty bench slots, injuries, suspensions, team logos, and player-detail navigation are supported.

Files changed
- src/app/features/team/team-settings/team-settings.html
- src/app/features/team/team-settings/team-settings.css
- src/app/features/cycles/cycle-one/cycle-one.ts
- src/app/features/cycles/cycle-one/cycle-one.html
- src/app/features/cycles/cycle-one/cycle-one.css

```


## BENCH_COMPONENT_STYLE_BUDGET_FIX.txt

```text

RINKRAT BENCH COMPONENT STYLE BUDGET FIX

The matchup bench UI increased cycle-one.css to 40.73 kB, which was 733 bytes above the previous 40 kB production error limit.
This update raises the anyComponentStyle warning threshold to 42 kB and the hard error threshold to 45 kB.
No runtime code, scoring logic, Firebase behavior, or styling was changed.
The limit remains intentionally narrow so future accidental CSS growth still fails the build.

```


## CURRENT_SEASON_STATS_DROPDOWN_UPDATE.txt

```text

RINKRAT CURRENT-SEASON STATS DROPDOWN UPDATE
============================================

The Add/Drop player-card dropdowns now focus on real current-season production
instead of explaining how the projection model was created.

Updated areas
-------------
- Normal free-agent cards
- Waiver cards
- The selected incoming-player review
- The selected outgoing-player review during an Add/Drop comparison

Each dropdown now shows
-----------------------
- Current-season fantasy-point total
- Fantasy points per appearance
- Current-season appearance/team-game sample
- Number of scoring categories contributing to the total
- The player's actual current-season NHL stat totals
- The fantasy-point contribution from every displayed category
- A clear total row showing the resulting current-season fantasy total

Skater examples include goals, estimated primary and secondary assists, shots,
hits, blocks, special-teams points, game-winning goals, overtime goals, and
TOI contribution. Goalie-unit examples include games, saves, save quality,
wins, shutouts, and any per-game cap adjustment.

The projection metrics that help compare players remain on the main player card,
but the expandable dropdown is now strictly a current-season stat explanation.

```


## DRAFT_START_AUTODRAFT_PERMISSION_FIX.txt

```text

RinkRat draft reliability fix

This update addresses three related production problems:

1. Draft and pick listeners could receive permission-denied for legacy league records whose team documents predated the ownerId field. Firestore membership checks now accept the authenticated user's team document ID as proof of membership and explicitly recognize the commissioner.

2. The browser generated Projection Version 9 snapshots, while the deployed server draft automation still required Version 8. The server shared projection version and messages now match Version 9, allowing scheduled starts and automatic picks to use the current verified player pool.

3. A scheduled draft activated by the commissioner browser now starts the first clock immediately and pins the verified projection snapshot. Server draft and queue triggers also process the next automatic pick immediately, with the exact Cloud Task deadline retained as the contention fallback.

The league page no longer tells non-commissioners that it is waiting for the commissioner; it accurately explains that the server opens the room automatically.

```


## FAVORITE_TEAM_CUSTOM_LOGO_PIPELINE_FIX.txt

```text

RINKRAT FAVORITE-TEAM CUSTOM LOGO PIPELINE FIX

Root cause
- The Vegas and San Jose alternate marks were local PNG files referenced through archivedLogo().
- The logo sync and validation scripts assumed every archivedLogo() asset was an official SVG.
- During prestart/prebuild, those PNG paths were rejected and the account page silently fell back to the current team crest.
- Team colors were not involved in the failure.

Fix
- Added a dedicated customLogo() path for locally curated alternate marks.
- The NHL sync now manages only official NHL SVG assets and separately verifies local custom images without trying to download or overwrite them.
- The validator now supports both official SVGs and custom PNG alternate marks.
- Added new versioned filenames and a URL version token to bypass any cached failed image requests.
- Reprocessed both supplied logos with transparent outer backgrounds.

Updated identities
- Vegas Golden Knights / Gold Jersey: crossed-swords secondary mark.
- San Jose Sharks / Stealth Black: circular fin secondary mark.

```


## FAVORITE_TEAM_TRUE_ALTERNATE_LOGOS_UPDATE.txt

```text

RINKRAT FAVORITE-TEAM TRUE ALTERNATE LOGOS UPDATE

What changed
- Vegas Golden Knights "Gold Jersey" alternate now uses the crossed-swords secondary crest instead of reusing the primary shield logo.
- San Jose Sharks "Stealth Black" alternate now uses the circular fin secondary crest instead of reusing the primary shark logo.
- Added stable local assets for those alternate marks under public/assets/team-identity-logos/custom/.
- Clarified the identity-catalog note so teams with a real secondary mark use that asset, while teams without one keep the primary crest on color-based alternates.

Files changed
- src/app/shared/pixel-theme/pixel-theme.data.ts
- public/assets/team-identity-logos/custom/vgk-alt-crossed-swords.png
- public/assets/team-identity-logos/custom/sjs-alt-fin-circle.png

```


## LEAGUE_DELETION_UPDATE.txt

```text

RINKRAT LEAGUE DELETION UPDATE
===============================

Added a commissioner-only permanent league deletion workflow.

SAFETY
------
- The control appears only to the league commissioner on Current League.
- The confirmation panel is collapsed by default inside a League Danger Zone.
- The commissioner must type the complete league name exactly before the destructive button is enabled.
- The server independently checks authentication, commissioner ownership, league ID, and exact league-name confirmation.
- Direct client deletion of the league root is blocked by Firestore rules so the safe cleanup function cannot be bypassed accidentally.

DELETION SCOPE
--------------
The deleteLeague callable Cloud Function removes:
- The league document and every nested subcollection.
- Members, teams, rosters, drafts, picks, queues, cycles, matchups, standings data, transactions, projections, availability records, playoff data, diagnostics, and automation state stored under the league.
- League invite documents associated with the league.
- Pending injury email queue records and notification logs associated with the league.

AFTER DELETION
--------------
- The deleted league is cleared as the remembered last league when applicable.
- The commissioner is returned to the Dashboard.
- Other managers lose access because their league membership documents are removed with the league.

DEPLOYMENT
----------
This update changes Angular code, Firestore rules, and Cloud Functions. Use npm run deploy:production rather than a Hosting-only deployment.

```


## LEAGUE_PROFILE_ICON_UPDATE.txt

```text

RINKRAT LEAGUE-SPECIFIC PROFILE PICTURE UPDATE
===============================================

Included in this full project:
- 10 Rink Rat character pictures.
- 15 standalone fictional jersey pictures in a Jerseys section.
- 10 referee/equipment/rink-reference pictures in a Misc Hockey section.
- All 35 images use transparent backgrounds, so the artwork appears by itself without the old glow/aura.
- Profile pictures belong to a manager's membership in one league, not to the global user account.
- Creating or joining a league assigns a random picture from all 35 choices for that league only.
- Existing league memberships without a valid picture receive a random league-specific picture the next time that league is opened.
- The Current League page lets the manager change the picture from the Your Team card beside Rename Team.
- The Dashboard and Account Settings pages do not show or edit a global profile picture.
- Within league pages, a manager's selected league picture appears beside that manager/team identity throughout the primary UI.
- Firestore member and team documents store the league-specific profileIconId.
- Firestore user documents no longer accept profileIconId as an editable global account setting.

Important data locations:
  leagues/{leagueId}/members/{uid}.profileIconId
  leagues/{leagueId}/teams/{uid}.profileIconId

Required before live use:
1. npm ci
2. npm run validate:profile-icons
3. npm run validate:league-logos
4. npm run build
5. Test league creation, league joining, the Current League picker, draft, standings, matchups, and playoffs locally.
6. Deploy Firestore rules together with Hosting.

Recommended deployment command:
  npm run deploy:production

Do not run npm audit fix --force as part of this update.

```


## LIGHT_ICE_REMAINING_CONTRAST_FIX.txt

```text

RinkRat Light Ice Remaining Contrast Fix
Date: July 28, 2026

This patch corrects the remaining Light Ice readability problems visible on:
- My Team / Roster Board player cards and roster metadata
- Current League daily injury report and league information cards
- Cycle summary and matchup preview cards
- League Teams headings, names, record/stat blocks, and status pills

The update is CSS-only and is intentionally scoped to the Light Ice background theme.
It preserves dark/OLED/Ice Gray presentation and keeps semantic injury, suspension,
and active/complete status colors distinct.

No Firestore rules, functions, projection data, or application logic changed.

```


## MATCHUP_ROSTER_GAME_PROGRESS_UPDATE.txt

```text

RINKRAT MATCHUP ROSTER-GAME PROGRESS UPDATE
Date: July 29, 2026

WHAT CHANGED
- Added a progress bar to each desktop matchup team summary.
- Added the same compact progress bar to each mobile head-to-head team summary.
- Each bar displays counted starter roster games played and games left.
- The fill percentage is played / (played + left).
- The progress bar uses the manager's selected NHL identity colors.
- Screen-reader progressbar values and descriptive labels are included.

WHY THIS COUNTS ROSTER GAMES
RinkRat windows are asynchronous at the roster-slot level and every starter has a six-game window. A simple count of players who have appeared at least once would fill too early and would not match matchup readiness. Counted roster games remain accurate for the entire cycle and sum directly to the existing matchup-level "Waiting on N roster games" status.

FILES CHANGED
- src/app/features/cycles/cycle-one/cycle-one.html
- src/app/features/cycles/cycle-one/cycle-one.ts
- src/rinkrat-arena-phase3.css
- RINKRAT_PROJECT_CONTEXT.txt

```


## MOBILE_MATCHUP_LAYOUT_UPDATE.txt

```text

RinkRat Mobile Matchup Layout Update
=====================================

This update uses substantially more of the available phone width on the Cycle
Matchup page and makes the floating score dock look intentional.

Changes
-------
- Pulls the mobile Cycle page through nearly all of the main layout gutter.
- Reduces interior matchup-card padding instead of shrinking the content.
- Gives the two team identity cards and player cards more horizontal room.
- Allows team and player names to use up to two lines before truncating.
- Slightly reduces the center VS/slot columns, logos, and avatar chrome.
- Restyles the sticky score bar as a rounded floating LIVE MATCHUP dock.
- Adds a three-color team rail to the top of the score dock.
- Moves the sticky dock nearer the top of the viewport instead of leaving an
  unexplained navigation-sized blank area after the top bar scrolls away.
- Preserves safe-area support and the fixed mobile bottom navigation.

Files changed
-------------
- src/styles.css
- src/app/features/cycles/cycle-one/cycle-one.css

```


## PROFILE_ICON_CATEGORIES_UPDATE.txt

```text

RINKRAT LEAGUE-SPECIFIC PROFILE PICTURE UPDATE
===============================================

Included in this full project:
- 10 Rink Rat character pictures.
- 15 standalone fictional jersey pictures in a Jerseys section.
- 10 referee/equipment/rink-reference pictures in a Misc Hockey section.
- All 35 images use transparent backgrounds, so the artwork appears by itself without the old glow/aura.
- Profile pictures belong to a manager's membership in one league, not to the global user account.
- Creating or joining a league assigns a random picture from all 35 choices for that league only.
- Existing league memberships without a valid picture receive a random league-specific picture the next time that league is opened.
- The Current League page lets the manager change the picture from the Your Team card beside Rename Team.
- The Dashboard and Account Settings pages do not show or edit a global profile picture.
- Within league pages, a manager's selected league picture appears beside that manager/team identity throughout the primary UI.
- Firestore member and team documents store the league-specific profileIconId.
- Firestore user documents no longer accept profileIconId as an editable global account setting.

Important data locations:
  leagues/{leagueId}/members/{uid}.profileIconId
  leagues/{leagueId}/teams/{uid}.profileIconId

Required before live use:
1. npm ci
2. npm run validate:profile-icons
3. npm run validate:league-logos
4. npm run build
5. Test league creation, league joining, the Current League picker, draft, standings, matchups, and playoffs locally.
6. Deploy Firestore rules together with Hosting.

Recommended deployment command:
  npm run deploy:production

Do not run npm audit fix --force as part of this update.

```


## READABLE_SCORE_NUMERALS_UPDATE.txt

```text

RINKRAT READABLE SCORE NUMERALS UPDATE

- Keeps Pixelify Sans for page titles, headings, and branded display text.
- Changes large scores, totals, timers, rankings, and other prominent numeric values to Barlow Condensed ExtraBold.
- Barlow Condensed was already loaded by RinkRat, so this adds no new font request or external dependency.
- Uses tabular lining numerals and slightly increased spacing for easier comparison of decimal scores.
- Applies across the scoring guide, matchups, My Team, Dashboard, leaders, draft values, standings-style numbers, labs, and admin summaries.

```


## RINKRAT_ARENA_PHASE_3_UPDATE.txt

```text

RINKRAT ARENA VISUAL SYSTEM — PHASE 3
=====================================

This package continues the visual redesign on top of Phase 1, Phase 2A, and the
latest draft reliability fix. It is presentation-only and does not change
scoring, projection, cycle, roster, draft, or Firebase behavior.

IMPLEMENTED PAGE IDENTITIES
---------------------------

MY TEAM — LOCKER ROOM
- The team hero is presented as a locker-room roster board.
- Manager identity, season HUD, coaching board, current matchup, transaction
  notice board, locker stalls, bench rail, treatment room, and penalty-box
  states now share one coherent hockey presentation.
- Roster and bench cards remain readable and preserve all controls.

ADD / DROP — SCOUTING TERMINAL
- The page is presented as a waiver-wire scouting terminal.
- Available players, waivers, filters, cycle markers, performance metrics,
  season-stat breakdowns, incoming/outgoing comparisons, and pending moves are
  visually grouped like a general manager decision screen.
- Existing decision data and transaction logic are unchanged.

MATCHUP — RINKRAT SPORTS NETWORK
- Cycle headers and scoreboards use a television-broadcast presentation.
- Team identity panels retain selected logos and home/away/retro colors.
- Roster boards resemble broadcast lineup graphics.
- Existing score-change animation gains a short goal-light effect.
- Opponent score changes continue to use the opponent-selected identity colors.

STANDINGS / LEADERS / PLAYOFFS
- Standings are presented as an arena board with a clear playoff cut line.
- Point leaders use a league-stat-network treatment.
- Playoffs use a Road to the RinkRat Cup presentation with stronger round,
  winner, and championship identity.

MASCOT AND HOCKEY POLISH
------------------------
- Loading states use the existing RinkRat mascot and a pixel loading rail.
- Empty states use a restrained mascot watermark.
- Successful transactions use a short puck-slide effect.
- Suspended players receive a penalty-box treatment.
- IR remains a treatment-room identity.
- Unlocked challenge cards receive trophy and unlock presentation.
- Score gains trigger a short goal-light sprite effect.
- Motion is disabled when reduced-motion is enabled.
- No rat-tail divider is used.

FILES ADDED / UPDATED
---------------------
- angular.json
- src/rinkrat-arena-phase3.css
- RINKRAT_ARENA_PHASE_3_UPDATE.txt
- RINKRAT_PROJECT_CONTEXT.txt

DEPLOYMENT
----------
This phase is frontend-only. A Hosting deployment is sufficient after the local
Angular build succeeds.

```


## RINKRAT_AUTH_HARDENING_ADMIN_CENTER_UPDATE.txt

```text

RINKRAT AUTH SESSION HARDENING + ADMIN CENTER
==============================================

AUTH SESSION HARDENING
- Sign-in, fresh-token confirmation, Auth observer confirmation, and profile loading now have bounded timeouts.
- A stalled Firebase request can no longer leave the login button on "Logging in..." forever.
- If sign-in times out after Firebase later completes in the background, the late session is automatically signed out.
- Account deletion now signs out, terminates the current Firestore client, clears user-scoped browser storage, and replaces the page with a completely new Angular/Firebase runtime.
- The login screen confirms when a deleted-account browser session has been cleared.
- Auth route guards and Dashboard/Auth profile startup no longer wait forever for an Auth observer.

PRIVATE ADMIN CENTER
- New route: /admin
- Platform-wide access is separate from league commissioner status.
- A server-side platformAdmins record or platformAdmin custom claim is required.
- Feedback and automatic client errors remain unreadable through normal browser Firestore rules.
- Admin data is returned only through authenticated callable Cloud Functions.

FEEDBACK INBOX
- Newest feedback first.
- Filter by status/category and search by message, page, email, or reference.
- Shows follow-up email only when the manager explicitly allowed follow-up.
- Shows likely related client errors from the same user/page within 30 minutes.
- Private admin notes and statuses: new, reviewing, planned, in-progress, resolved, not-planned.

ERROR INBOX
- Similar raw client errors are grouped by a sanitized fingerprint.
- Shows occurrence count, affected users, browser distribution, route, release, first/last seen, and sample stack.
- Private admin notes and statuses: new, investigating, fixed, ignored.
- Existing clientErrorReports without a stored fingerprint are grouped at read time, so older reports still appear.

AUDITING AND SECURITY
- Admin updates are written by Cloud Functions and recorded in adminAuditLogs.
- platformAdmins, adminErrorReviews, and adminAuditLogs are blocked from all direct browser reads/writes.
- League commissioners do not automatically gain platform-admin access.

```


## RINKRAT_BETA_FOUNDATION_PART_2_UPDATE.txt

```text

RINKRAT BETA FOUNDATION — PART 2
================================

This package adds the next production-safety layer without changing fantasy
scoring, cycle windows, rosters, draft order, projections, or standings.

1. SECURE SELF-SERVICE ACCOUNT DELETION
---------------------------------------
Account Settings now contains a permanent Account Deletion safety center.

Before deletion can run:
- The manager must be signed in.
- The server confirms the account has no commissioner-owned leagues.
- The manager must type the full saved manager name exactly.
- The manager must enter the current account password.
- Firebase reauthentication refreshes the sign-in session.
- The callable Function independently checks that authentication is recent.
- The manager must acknowledge that deletion cannot be undone.

Commissioner-owned leagues block account deletion. The UI links directly to
each blocked league so its existing League Danger Zone can be used first.

When deletion succeeds:
- The Firebase Authentication user is permanently removed.
- users/{uid} and nested user data are recursively removed.
- Feedback and client-error reports for the account are removed.
- Injury email queue and notification-log records for the account are removed.
- Observability rate-limit data for the account is removed.
- Membership/team records inside joined leagues are anonymized rather than
  erased so other managers' drafts, scores, standings, and playoffs do not
  change. The manager becomes "Deleted Manager" and the team becomes
  "Vacant Team".
- If a draft is unfinished, that vacant team is placed into Auto-Draft so the
  league cannot become stuck because the deleted manager is on the clock.

New callable Functions:
- getAccountDeletionReadiness
- deleteMyAccount

New client service:
- src/app/core/auth/account-deletion.service.ts

A collection-group index for teams.ownerId was added to firestore.indexes.json.

2. FIREBASE APP CHECK ROLLOUT PREPARATION
-----------------------------------------
The client now has a safe App Check initialization point that runs before Auth,
Firestore, Functions, or Analytics are imported.

Files:
- src/environments/app-check.config.ts
- src/app/core/firebase-app-check.ts
- src/main.ts

App Check remains DISABLED in the included configuration because the Firebase
web app must first be registered with a reCAPTCHA Enterprise score-based site
key. This prevents an unconfigured deployment from blocking legitimate users.
See APP_CHECK_ROLLOUT_GUIDE.txt for the staged production setup.

3. POLICY AND SUPPORT UPDATES
-----------------------------
Privacy, Terms, and Support now describe the self-service deletion flow and the
limited anonymous league history retained to protect other managers' results.

4. RELEASE LABEL
----------------
The application release label is now "Release Candidate 2" so new diagnostic
reports can be distinguished from the previous beta-foundation release.

```


## RINKRAT_PROJECT_CONTENT.txt

```text

RINKRAT FANTASY — CONSOLIDATED PROJECT CONTEXT
Last consolidated: July 2026

PURPOSE OF THIS FILE
--------------------
This is the single handoff/reference file for the RinkRat Fantasy project. It replaces the many old INSTALL, REPORT, MANIFEST, NOTES, DEPLOY_COMMANDS, checklist, and revision files that previously cluttered the project root. A new ChatGPT conversation should read this file before changing the project.

PROJECT IDENTITY
----------------
Application: RinkRat Fantasy
Repository/local path: /Users/StephenH/Documents/Programming/fantasy-hockey
Frontend: Angular 22 standalone application
Backend: Firebase Authentication, Firestore, Firebase Hosting, Cloud Functions v2, Cloud Scheduler, and Cloud Tasks
Firebase project: nhl-fantasy-app-ab673
Firebase Hosting target: app
Firebase Hosting site ID: cycle-puck
Public domain: https://rinkratfantasy.com
Optional redirect domain: https://www.rinkratfantasy.com
Primary Functions region: us-central1
Known working Node version: 22.23.1
Root Node requirement: >=22.22.3 and <23

EMAIL CONFIGURATION
-------------------
Provider: Resend
Sender name: RinkRat Fantasy
Sender address: notifications@rinkratfantasy.com
Reply-to/support: support@rinkratfantasy.com
Secret name: RESEND_API_KEY
Non-secret Functions environment file: functions/.env.nhl-fantasy-app-ab673
Expected values:
  APP_BASE_URL=https://rinkratfantasy.com
  EMAIL_FROM_NAME=RinkRat Fantasy
  EMAIL_FROM_ADDRESS=notifications@rinkratfantasy.com
  EMAIL_REPLY_TO=support@rinkratfantasy.com
Never place the Resend API key in source code, Angular environment files, Firestore, or this text file.

STANDARD LOCAL COMMANDS
-----------------------
Use these from the project root:

  cd /Users/StephenH/Documents/Programming/fantasy-hockey
  nvm use 22.23.1

Install frontend dependencies:
  npm ci

Build frontend only:
  npm run build

Build frontend and Functions:
  npm run build:all

Repair Functions dependencies manually:
  npm run repair:functions

Build Functions only:
  npm --prefix functions run build

The Functions build now checks for firebase-admin, firebase-functions, @types/node, and TypeScript before compiling. If functions/node_modules is missing or incomplete, it automatically runs npm ci inside functions. This prevents the recurring wall of TypeScript errors such as “Cannot find module firebase-admin,” “Cannot find name process,” and “Cannot find name Buffer.”

Full deployment:
  firebase use nhl-fantasy-app-ab673
  firebase deploy --only firestore:rules,firestore:indexes,functions,hosting:app

Frontend-only deployment:
  npm run build
  firebase deploy --only hosting:app

Functions-only deployment:
  npm --prefix functions run build
  firebase deploy --only functions

Important: do not run npm audit fix --force casually. It may introduce breaking dependency upgrades. The current audit warnings do not block builds or deployment by themselves.

CRITICAL FANTASY ARCHITECTURE
-----------------------------
The most important rule is that fantasy cycles are asynchronous at the persistent roster-slot/player-window level. Do not redesign the app around one league-wide cycle start or end timestamp.

Each active roster slot owns an immutable six-NHL-game window. NHL schedules differ, so different assets finish their windows on different dates. When an asset plays its seventh scheduled NHL team game, that game belongs to the next window even if other assets are still completing their previous windows. Several cycle numbers may therefore be active at the same time across one fantasy team.

All future scoring, projections, queued roster moves, standings, playoffs, recovery logic, and Firestore optimization must preserve this model. Use immutable per-slot windows plus the shared NHL game-result ledger. Never discard already-played games simply because a matchup destination was not known yet.

ROSTER CONFIGURATION
--------------------
Starting roster:
  3 LW
  3 C
  3 RW
  4 D
  1 team-based goalie unit
Bench: 3 flexible slots
IR: 3 slots
Starting roster size: 14
Total roster capacity including bench and IR: 20

The goalie asset represents the NHL team goalie unit, not one individual goalie.

SCORING V3
----------
Every roster-slot window contains six NHL team games.

Forward scoring per NHL game:
  Goals: first 6, second 4, additional 2.5
  Primary assists: first 5, second 3.5, additional 2.5
  Secondary assists: first 2.5, second 1.5, additional 0.5
  Shot on goal: 0.75
  Hit: 0.45
  Blocked shot: 0.75
  Power-play point bonus: 1.25
  Short-handed point bonus: 3
  Game-winning goal: 2
  Overtime goal: 2
  TOI multiplier: 0.2

Defense scoring per NHL game:
  Goals: first 4.5, second 2.75, additional 1.5
  Primary assists: first 4, second 2.75, additional 1.5
  Secondary assists: first 1.75, second 1, additional 0.4
  Shot on goal: 0.4
  Hit: 0.55
  Blocked shot: 1.05
  Power-play point bonus: 0.85
  Short-handed point bonus: 2
  Game-winning goal: 2
  Overtime goal: 2
  Defense TOI multiplier is adaptive with base 0.27, plus/minus modifier 0.015, floor 0.24, and ceiling 0.31.

Goalie-unit scoring per NHL game:
  Participation base: 3
  Save: 0.27
  Win: 3.5
  Shutout: 4
  Continuous save-percentage quality model with baseline 0.900
  Save-percentage quality is clamped from -3 to 10
  Maximum goalie-unit fantasy points per NHL game: 28

Scoring rules are frozen in league/cycle records so completed games remain reproducible.

PROJECTION ENGINE
-----------------
Current shared projection version: Projection V9.
Projection snapshots are shared and stored in Firestore. Per-slot window projections are frozen when the window begins.

Drafts must use a verified Projection V9 snapshot. The server must not silently use the old emergency low-value ranking board. A live draft pins the exact verified snapshot ID so the Draft Room and server auto-picks use the same rankings for the full draft.

A valid draft projection must:
  use Projection V9;
  not have generationReason “server-emergency”;
  contain a healthy asset pool;
  be generated for the actual number of participating fantasy teams;
  remain available through the draft.

If the current projection pointer is bad but a healthy recent V9 snapshot exists, the server may restore the healthy pointer. If no verified snapshot exists, the draft should remain stopped rather than make inaccurate selections.

DRAFT SYSTEM
------------
Draft type: snake draft.
The system supports manual picks, queues, auto-draft, timeouts, consecutive-timeout auto-mode, bench filling, and position constraints.

Server-controlled behavior:
  runScheduledDraftAutomation checks drafts on a schedule.
  continueServerDraftAutomation reacts to draft document changes.
  processAutoDraftQueueChange reacts when a manager enables auto-draft.
  processDraftClockDeadline is a Cloud Tasks worker for an exact individual pick deadline.

Important draft safeguards:
  One per-league server lease prevents several workers from processing the same draft simultaneously.
  Temporary Firestore transaction contention is retried.
  Every pick clock receives its own exact Cloud Task.
  A deadline task may make no more than one automatic pick.
  Duplicate or stale tasks verify league ID, pick number, and clock timestamp before acting.
  Auto-picks are paced rather than allowing one worker to make most of the draft in a single burst.
  The minute scheduler remains a recovery mechanism if a task is interrupted.
  Snake-turn consecutive picks must remain valid.

Previous bugs that must not return:
  Firestore error 10 ABORTED caused by several workers contending for the same draft.
  Clock stuck at 0:00 because no exact deadline job existed.
  A single invocation making up to 24 picks and making the draft appear to jump ahead.
  Server emergency rankings placing elite players such as Connor McDavid near 49 projected points.

CYCLE 1 START BEHAVIOR
----------------------
Cycle 1 starts automatically as soon as a draft changes to status complete. The commissioner does not press a Start Cycle button.

initializeSeasonAfterDraft is the immediate Firestore trigger.
runSeasonStartAutomation now runs every minute as a recovery sweep, not as a September calendar gate. It finds completed drafts missing cycle-1 and repairs them.
runScheduledLeagueAutomation continues scoring, cycle progression, standings, and playoff work.

The project still contains default season metadata for 2026-27 and September 29, 2026 at 2:00 p.m. Pacific, but that date must not block Cycle 1 after a completed draft. It remains useful as season metadata and for historical/live configuration.

SERVER AUTOMATION FUNCTIONS
---------------------------
Critical deployed Functions include:
  runScheduledDraftAutomation
  processDraftClockDeadline
  continueServerDraftAutomation
  processAutoDraftQueueChange
  initializeSeasonAfterDraft
  runSeasonStartAutomation
  runScheduledLeagueAutomation
  refreshGlobalPlayerAvailabilityScheduled
  refreshDailyPlayerAvailability
  processQueuedInjuryEmails
  sendInjuryEmailsOnGlobalAvailabilityChange
  sendInjuryEmailOnAvailabilityChange
  sendTestInjuryEmail
  sendWelcomeEmailOnProfileCreated
  requestPasswordResetEmail
  resendVerificationEmail
  applyImmediateRosterMove
  nhlApiProxy
  advanceHistoricalReplayDay

Release Readiness surfaces automation health for commissioners. Scheduled workers write health/status documents under appData.

INJURY DATA AND EMAIL ALERTS
----------------------------
The browser uses same-origin API routes. NHL API routes use /v1 and /stats. ESPN injury data uses /espn/injuries through the server-side proxy; the browser should not contact ESPN directly.

The global player-availability report refreshes server-side. Browser refresh remains an emergency/manual fallback.

Injury email alerts are optional, disabled by default, and require a verified email address. Actionable states include Out, IR, LTIR, Suspended, and Personal Leave.

Availability changes create server-only queue records. processQueuedInjuryEmails runs every five minutes. Messages are batched so nearby alerts for the same owner can be sent together rather than spamming one email per player.

Before sending, the server rechecks that:
  the owner still has alerts enabled;
  the authentication email remains verified;
  the player is still unavailable after league override rules;
  the player remains in an active roster slot;
  no replacement is already queued for that slot;
  the independent slot window still has games remaining;
  the regular-season or playoff window remains actionable.

If the player is in a live NHL game, the alert waits until the game is no longer live, followed by a 15-minute hold. Otherwise it uses a 15-minute hold. Delivery is normally within about five minutes after the hold expires.

The commissioner test email is only a format preview. It sends to the verified commissioner and uses the fictional players Riley Rinkrat and Casey Crease. It does not modify real rosters or queue records.

ADD/DROP, BENCH, AND IR
-----------------------
Roster changes are evaluated against the persistent slot windows, not a global league cycle timestamp.

A roster move may occur immediately when neither involved asset has played a game in its current relevant window. Once either side has begun its window, the move may be queued for the correct next boundary. The UI must explain which player/window delays the transaction.

Moving to IR is only offered when the player is eligible. Injury and suspension indicators appear consistently on My Team, Matchup, and Add/Drop views.

Queued moves and injury replacement logic must preserve the already-counted games in each immutable window.

PLAYOFFS
--------
The app reserves 13 complete fantasy periods, corresponding to the first 78 scheduled NHL games for each NHL team. Regular-season length adjusts to make room for playoffs.

2-3 fantasy teams:
  12 regular cycles, 1 championship cycle.

4-7 fantasy teams:
  11 regular cycles, 2 playoff cycles.
  Semifinals: 1 vs 4 and 2 vs 3.

8-12 fantasy teams:
  10 regular cycles, 3 playoff cycles.
  Seeds 1 and 2 receive byes.
  Opening round: 3 vs 6 and 4 vs 5.

Tied playoff matchups advance the higher seed. The bracket does not reseed. Non-title teams continue classification/consolation games so all teams receive a final placement.

Playoff rounds preserve the asynchronous window philosophy. Assets may begin and accumulate games before the fantasy opponent or bracket destination is known. After the prior round resolves, those games must be backfilled into the championship, third-place, fifth-place, or consolation matchup. Do not discard them or force the player to wait.

STANDINGS AND MATCHUP COMPLETION
-------------------------------
A fantasy matchup finalizes only after the relevant independent roster-slot windows complete. Standings are applied once. Regular-season standings freeze when playoffs begin.

Seeding order:
  1. Win percentage, counting a tie as half a win
  2. Points For
  3. Point differential
  4. Total wins
  5. Stable team-name/owner fallback

LIVE SCORING AND PERFORMANCE
----------------------------
The server owns live scoring and league automation. The target cadence is roughly every ten minutes. Shared control documents and leases prevent duplicate work. Unchanged snapshots should not be rewritten.

Mobile performance is a priority. Avoid adding high-frequency listeners or repeated league-wide reads. Injury data is shared globally rather than fetched independently per league. The scoring/game ledger should be reused across leagues.

BRANDING AND UI
---------------
The site uses a pixel-art hockey theme with the masked RinkRat mascot and a clearer pixel jersey icon. Primary site branding assets are under public/assets/branding and public/assets/pixel-icons.

Favorite NHL team colors are identity accents rather than whole-page backgrounds. The app uses a neutral readable canvas and chooses black/white foregrounds based on contrast.

Background presets:
  Rink Dark
  OLED Black
  Ice Gray
  Light Ice

The favorite team is selected during profile creation and saved to the user profile. Existing profiles without a favorite team fall back to Vegas.

Important UX direction:
  Mobile is as important as desktop.
  Keep status colors clear: upcoming yellow, played green, missed red.
  Keep cycle numbers centered and readable.
  Reduce low-use buttons and dense explanations.
  Do not restore obsolete commissioner Start Cycle controls.
  Account Settings contains the discoverable Email Injury Alerts callout and email icon.

PRODUCTION SAFETY
-----------------
Production runtime configuration is live-only and hides developer controls. Historical replay tools are for development/testing and should not appear in a normal production build.

The full-season simulator is deterministic and should not make NHL requests or Firestore writes. It is regression coverage for roster size, 11-cycle four-team seasons, six-game windows, 7-vs-4 asynchronous advancement, queued moves, immutable projections, scoring leases, standings, and playoff routing.

The Release Readiness page reads existing league and app health. It classifies checks as pass, warning, or fail. A warning immediately after deploying a new scheduled worker can be normal until the first execution.

KNOWN NON-BLOCKING BUILD OUTPUT
-------------------------------
The Angular production build may warn that src/app/features/cycles/cycle-one/cycle-one.css exceeds its configured style budget by several kilobytes. This is currently a warning, not a failed build.

npm audit may report low, moderate, or high dependency vulnerabilities. Do not use npm audit fix --force without reviewing the dependency changes.

FUNCTIONS DEPENDENCY RECOVERY
-----------------------------
The repeated 100+ TypeScript error pattern is not 100 separate source problems. It means the Functions dependency tree is missing or incomplete. Typical errors include:
  Cannot find module firebase-admin/firestore
  Cannot find module firebase-functions/v2/https
  Cannot find name node:crypto
  Cannot find name process
  Cannot find name Buffer
  FirebaseFirestore namespace missing
  Many implicit-any or unknown errors caused by missing imported types

Current prevention:
  functions/package.json has a prebuild dependency check.
  functions/scripts/ensure-dependencies.cjs checks the required packages.
  If they are missing, npm ci runs automatically before tsc.

Manual recovery remains:
  rm -rf functions/node_modules
  npm --prefix functions ci
  npm --prefix functions run build

IMPORTANT SOURCE FILE MAP
-------------------------
Frontend:
  src/app/features/draft/draft-room/ — draft UI
  src/app/features/draft/draft-setup/ — draft schedule and projection preparation
  src/app/features/cycles/cycle-one/ — cycle/matchup UI
  src/app/features/leagues/league-detail/ — league home and navigation
  src/app/features/account/account-settings/ — profile, themes, and email-alert preference
  src/app/core/release/release-readiness.service.ts — health/readiness checks
  src/styles.css — global visual tokens and shared styling

Functions:
  functions/src/draft-automation.ts — scheduled draft opening, leases, Cloud Tasks deadlines, auto-picks
  functions/src/league-automation.ts — Cycle 1 creation, scoring/cycle progression, recovery, playoffs
  functions/src/email-notifications.ts — account emails, injury queue, Resend delivery, test preview
  functions/src/index.ts — API proxy and global injury refresh
  functions/src/roster-moves.ts — immediate/queued roster move server logic
  functions/src/season-config.ts — season metadata/defaults
  functions/src/shared/core/ — shared scoring, projection, roster, cycle, playoff, and Firebase compatibility logic

Firestore and deployment:
  firestore.rules
  firestore.indexes.json
  firebase.json
  .firebaserc
  functions/package.json
  functions/package-lock.json
  functions/.env.nhl-fantasy-app-ab673

TROUBLESHOOTING COMMANDS
------------------------
List deployed Functions:
  firebase functions:list

Selected logs:
  firebase functions:log --only runScheduledDraftAutomation
  firebase functions:log --only processDraftClockDeadline
  firebase functions:log --only continueServerDraftAutomation
  firebase functions:log --only runSeasonStartAutomation
  firebase functions:log --only runScheduledLeagueAutomation
  firebase functions:log --only refreshGlobalPlayerAvailabilityScheduled
  firebase functions:log --only processQueuedInjuryEmails

Confirm Resend secret exists without printing its value:
  firebase functions:secrets:get RESEND_API_KEY

Verify same-origin API routes after deployment:
  curl -I https://rinkratfantasy.com
  curl -sS https://rinkratfantasy.com/v1/roster/VGK/current | head
  curl -sS https://rinkratfantasy.com/espn/injuries | head

CURRENT HANDOFF STATUS
----------------------
The project includes:
  server-controlled draft opening and exact deadline tasks;
  per-league draft automation leases;
  verified Projection V9 draft rankings with a frozen snapshot;
  automatic Cycle 1 creation immediately after draft completion;
  minute-by-minute Cycle 1 recovery;
  scheduled scoring/cycle/playoff automation;
  server-side global injury refresh;
  queued and batched injury emails through Resend;
  Release Readiness health checks;
  RinkRat branding, favorite-team accents, and neutral background themes;
  five selectable identity packs for every current NHL club;
  ten selectable RinkRat manager profile icons with sitewide account-avatar usage;
  global challenge rewards that permanently unlock away, retro, alternate, and special identities;
  custom league emblems selected during league creation, with eight pixel-art designs and eight
  color variants per design;
  automatic Functions dependency repair before TypeScript compilation.

When beginning work in a new chat, provide the current full project ZIP and tell the assistant to read RINKRAT_PROJECT_CONTEXT.txt first. The ZIP is the source of truth if this file and implementation ever disagree.

=====================================================================
TEAM LOGO + COLOR IDENTITY VARIANTS AND CHALLENGE REWARDS (JULY 2026)
=====================================================================
User profiles store:
  favoriteTeamAbbreviation
  favoriteTeamVariantId
  teamIdentityUnlocks

Every current NHL club has five identity choices generated by the central catalog:
  Current Home — available immediately.
  Current Away — ice-white presentation with team-color accents.
  Retro/Heritage — a historical franchise identity and period-style colors.
  Alternate — an alternate crest or alternate uniform-inspired palette.
  Special — an additional reverse-retro, color-rush, outdoor, or creative heritage identity.

Identity reward tiers unlock globally, not only for the currently selected club:
  First Line Change — join a fantasy hockey league — unlocks Current Away for every team.
  Commissioner Mode — create or manage a league — unlocks Retro/Heritage for every team.
  League Explorer — compete in three leagues — unlocks Alternate for every team.
  Crowded Schedule — face at least ten fantasy opponents — unlocks every Special identity.

Unlock behavior:
  Unlocks are calculated from the manager's league summaries when Account Settings loads.
  Newly earned tiers are saved permanently in users/{uid}.teamIdentityUnlocks.
  Once saved, an unlock remains available even if the manager later leaves a league.
  Existing accounts require no manual migration; absent unlock data is treated as an empty list.
  A saved variant that is not unlocked falls safely back to current-home.
  Firestore rules allow no more than the four known reward strings.

Account-page behavior:
  Select a favorite club first, then choose among its five identity cards.
  Locked cards remain visible and show the challenge required to open them.
  The Trophy Shelf shows each challenge and its global identity reward.
  Selecting an unlocked identity saves immediately and updates the app theme.
  Account-page logo images fall back to the club's current NHL crest if a future asset fails.
  Historical identities use curated exact NHL archive filenames rather than guessed season ranges.
  Alternate identities without a verified alternate crest reuse the current crest while preserving
  the selected alternate uniform-inspired color palette.

The selected identity controls:
  sitewide CSS color variables;
  dashboard and account visuals;
  My Team and favorite-team logo displays;
  matchup/opponent identity data;
  local theme storage and the Firestore user profile.

Important source files:
  src/app/shared/pixel-theme/pixel-theme.data.ts
    - all 32 club palettes, 160 total identity entries, reward metadata, and verified logo URLs
  scripts/validate-team-logo-urls.mjs
    - checks all current and archived NHL logo URLs and fails on any unreachable asset
  src/app/core/user/user-theme.service.ts
    - validates unlocks before applying or restoring a selected identity
  src/app/core/user/user.service.ts
    - profile types and identity-unlock persistence
  src/app/features/account/account-settings/
    - team picker, locked cards, achievements, and challenge calculations
  firestore.rules
    - validates favoriteTeamVariantId and teamIdentityUnlocks

New identity packs should be added centrally in SPECIAL_TEAM_VARIANTS. Each club currently has
one heritage, one alternate, and one special definition in addition to the universal home/away
pair. Keep variant IDs stable because they are stored in user profiles. Never construct historical
logo URLs by guessing a season range or appending _alt.svg. Add an exact archivedLogo filename
that has been verified against the NHL logo archive, then run `npm run validate:team-logos`.

============================================================
CUSTOM LEAGUE EMBLEMS AND COLOR VARIANTS (JULY 2026)
============================================================
League documents now store:
  leagueLogoId
  leagueLogoPaletteId

The league creator selects one of eight high-resolution pixel-art emblems and one of eight color
variants. This provides 64 combinations without allowing arbitrary uploaded URLs. Existing league
documents require no migration; missing or invalid values fall back to the Rink Rat emblem in the
Rink Gold palette.

The selected emblem appears:
  on each league card on the Dashboard;
  beside the league name on the Current League page.

Important source files:
  src/app/shared/league-logo/league-logo.data.ts
    - stable emblem IDs, palette IDs, display names, safe normalization, and asset paths
  public/assets/league-logos/{leagueLogoId}/{leagueLogoPaletteId}.png
    - 256x256 transparent pixel-art assets; eight designs by eight palettes
  scripts/validate-league-logo-assets.mjs
    - verifies that all 64 local PNG combinations exist and remain 256x256
  src/app/features/leagues/create-league/
    - emblem picker, palette picker, and live preview
  src/app/core/league/league.service.ts
    - persists selections and includes them in league summaries
  src/app/features/dashboard/
    - displays the selected emblem on league cards
  src/app/features/leagues/league-detail/
    - replaces the old generic rat title icon with the selected league emblem

Keep leagueLogoId and leagueLogoPaletteId values stable because they are stored in Firestore.
When adding an emblem or palette, add every matching asset combination so the central path helper
can always resolve to a real file, then run `npm run validate:league-logos`.

=====================================================================
LEAGUE-SPECIFIC PROFILE PICTURES (JULY 2026)
=====================================================================
Profile pictures are NOT global user-account settings. They belong to the manager's identity
inside one specific league and are stored on both league-owned identity documents:
  leagues/{leagueId}/members/{uid}.profileIconId
  leagues/{leagueId}/teams/{uid}.profileIconId

The catalog contains 35 optimized 512x512 WebP assets in three sections:
  Rink Rats — 10 original player and goalie characters.
  Jerseys — 15 standalone fictional sweaters with no NHL branding.
  Misc Hockey — 10 hockey references including a referee, ice resurfacer, goalie mask, skates,
  crossed sticks, visor helmet, goal light, goalie gear, championship cup, and bench gear.

Every asset has a transparent background. ManagerAvatar also has no border, background, shadow,
or glow, so only the pixel artwork appears beside a name.

League behavior:
  - Creating a league assigns the commissioner a random picture from all 35 choices.
  - Joining a league for the first time assigns that membership a random picture from all 35.
  - Rejoining preserves the picture already saved for that league.
  - Opening a legacy league membership without a valid picture assigns and saves a random one.
  - A manager can choose a different picture from the Your Team card on the Current League page.
  - Changing the picture affects only that league and does not change the manager's other leagues.

The Dashboard and global Account Settings page intentionally do not show or edit a manager
profile picture. Account Settings still controls global username, favorite NHL team, theme, and
other account preferences. User documents may contain a legacy profileIconId from an older build,
but current code ignores it and Firestore rules no longer allow it to be edited as a global field.

Within league context, the saved league picture appears next to manager/team identities in the
Current League page, My Team, team lists, draft setup, draft room, standings, schedule preview,
cycle matchups, matchup overview, point leaders, and playoff bracket/placements.

Important source files:
  src/app/shared/profile-icon/profile-icon.data.ts
    - all 35 stable IDs, categories, metadata, random selection, seeded display fallback, and lookup
  src/app/shared/manager-avatar/manager-avatar.ts
    - reusable transparent profile-picture component for league manager/team labels
  public/assets/profile-icons/
    - ten transparent Rink Rat assets
  public/assets/profile-icons/jerseys/
    - fifteen transparent fictional standalone jersey assets
  public/assets/profile-icons/misc-hockey/
    - ten transparent equipment and rink-reference assets
  src/app/features/leagues/league-detail/
    - categorized league-only picker in the Your Team card
  src/app/core/league/league.service.ts
    - random assignment, legacy repair, league-only persistence, and manager-name synchronization
  src/app/core/team/team.service.ts
    - team identity fields and stable read fallback
  src/app/core/auth/auth.service.ts
    - no longer creates a global user profileIconId
  src/app/features/dashboard/
    - deliberately contains no profile-picture display or picker
  src/app/features/account/account-settings/
    - deliberately contains no global profile-picture picker
  firestore.rules
    - exact 35-ID allowlist for league member/team identity writes; global user icon edits blocked
  scripts/validate-profile-icon-assets.mjs
    - recursively validates all 35 mobile-friendly WebP assets

Validation command:
  npm run validate:profile-icons

Keep IDs stable because they are stored in league member and team documents. New future categories
should be added centrally to profile-icon.data.ts, mirrored in the Firestore allowlist, and added
to the asset validator.

=====================================================================
ADD/DROP DECISION CENTER AND LIGHT ICE CONTRAST (JULY 28, 2026)
=====================================================================
The global NHL logo ribbon stays dark in every theme so Light Ice cannot turn its team abbreviations into white-on-white text. The Free Agents page uses a fixed high-contrast dark workspace for filters, player rows, roster slots, and add/drop comparisons.

Shared projection version 9 adds current-season fantasy production, rest-of-season and final estimates, projection-performance comparison, six-game current-cycle markers, and scoring-category breakdowns. Free-agent cards show green played markers, red missed markers, yellow upcoming markers, four core projection values, next-cycle rank, and an over/under projection indicator. Expandable desktop/mobile details include recent pace, reliability, availability, schedule outlook, sample size, projection source, and stat-level scoring.

The roster-slot step includes outgoing-player metrics and a direct incoming-versus-outgoing comparison, including projected next-cycle and rest-of-season gain/loss. Lower-priority details collapse on smaller screens while the core decision data remains visible.

See ADD_DROP_DECISION_CENTER_UPDATE.txt for the full implementation summary.

CURRENT-SEASON ADD/DROP STAT DROPDOWN (JULY 28, 2026)
------------------------------------------------------
- Add/Drop expandable player details no longer explain projection construction.
- Free-agent, waiver, incoming, and outgoing dropdowns show current-season NHL
  stat totals and the fantasy-point contribution from each scoring category.
- Each dropdown ends with a clear current-season fantasy total.
- Projection comparison metrics remain visible on the main card outside the
  dropdown so the dropdown can stay focused on actual production.

=====================================================================
VISUAL SYSTEM PHASE 2A — PAGE IDENTITIES (JULY 2026)
=====================================================================
- Dashboard: arcade league-select and save-file/cartridge presentation.
- Current League: franchise front-office presentation.
- Draft Room: arena jumbotron, medical ticker, lineup board, pick ticker,
  scouting terminal, and general-manager desk presentation.
- Implemented in src/rinkrat-page-identities-phase2.css and loaded after Phase 1.
- Presentation only; no fantasy logic or Firebase behavior changed.
- Mobile and Light Ice refinements included.
- No rat-tail divider.

=====================================================================
DRAFT START, AUTO-DRAFT, AND LEGACY MEMBERSHIP FIX (JULY 2026)
=====================================================================
- Firestore draft and pick reads now recognize legacy league team documents even
  when they predate the ownerId field. Commissioner access is also explicit.
- Browser and Cloud Functions now agree on Shared Projection Version 9. The old
  server-side Version 8 requirement could prevent scheduled starts and automatic
  selections after the Add/Drop projection upgrade.
- Commissioner-browser scheduled activation starts the first pick clock
  immediately and pins the verified shared projection snapshot.
- Server draft-document and auto-draft queue triggers process automatic picks
  immediately, while exact Cloud Tasks remain the deadline/contention fallback.
- League status messaging now accurately says the server is opening a scheduled
  draft rather than telling managers it is waiting for the commissioner.
- See DRAFT_START_AUTODRAFT_PERMISSION_FIX.txt for the detailed summary.

LEAGUE DELETION FEATURE
-----------------------
Commissioners can permanently delete a league from a collapsed Danger Zone on Current League. The full league name must be typed exactly. An authenticated Cloud Function verifies ownership and recursively removes the league tree plus related invite and injury-email records. Direct client deletion of league roots is blocked by Firestore rules.


FAVORITE-TEAM LOGO RELIABILITY
- Favorite-team current and historical logo assets are now synchronized from the official NHL logo catalog into public/assets/team-identity-logos.
- npm start and npm run build automatically prepare missing assets.
- Runtime identity cards use local SVG paths, removing broken guessed remote filenames and hot-link dependence.
- npm run validate:team-logos verifies all 32 current crests plus every archived/secondary identity asset.

```


## RINKRAT_PROJECT_CONTEXT.txt

```text

RINKRAT FANTASY — CONSOLIDATED PROJECT CONTEXT
Last consolidated: July 2026

PURPOSE OF THIS FILE
--------------------
This is the single handoff/reference file for the RinkRat Fantasy project. It replaces the many old INSTALL, REPORT, MANIFEST, NOTES, DEPLOY_COMMANDS, checklist, and revision files that previously cluttered the project root. A new ChatGPT conversation should read this file before changing the project.

PROJECT IDENTITY
----------------
Application: RinkRat Fantasy
Repository/local path: /Users/StephenH/Documents/Programming/fantasy-hockey
Frontend: Angular 22 standalone application
Backend: Firebase Authentication, Firestore, Firebase Hosting, Cloud Functions v2, Cloud Scheduler, and Cloud Tasks
Firebase project: nhl-fantasy-app-ab673
Firebase Hosting target: app
Firebase Hosting site ID: cycle-puck
Public domain: https://rinkratfantasy.com
Optional redirect domain: https://www.rinkratfantasy.com
Primary Functions region: us-central1
Known working Node version: 22.23.1
Root Node requirement: >=22.22.3 and <23

EMAIL CONFIGURATION
-------------------
Provider: Resend
Sender name: RinkRat Fantasy
Sender address: notifications@rinkratfantasy.com
Reply-to/support: support@rinkratfantasy.com
Secret name: RESEND_API_KEY
Non-secret Functions environment file: functions/.env.nhl-fantasy-app-ab673
Expected values:
  APP_BASE_URL=https://rinkratfantasy.com
  EMAIL_FROM_NAME=RinkRat Fantasy
  EMAIL_FROM_ADDRESS=notifications@rinkratfantasy.com
  EMAIL_REPLY_TO=support@rinkratfantasy.com
Never place the Resend API key in source code, Angular environment files, Firestore, or this text file.

STANDARD LOCAL COMMANDS
-----------------------
Use these from the project root:

  cd /Users/StephenH/Documents/Programming/fantasy-hockey
  nvm use 22.23.1

Install frontend dependencies:
  npm ci

Build frontend only:
  npm run build

Build frontend and Functions:
  npm run build:all

Repair Functions dependencies manually:
  npm run repair:functions

Build Functions only:
  npm --prefix functions run build

The Functions build now checks for firebase-admin, firebase-functions, @types/node, and TypeScript before compiling. If functions/node_modules is missing or incomplete, it automatically runs npm ci inside functions. This prevents the recurring wall of TypeScript errors such as “Cannot find module firebase-admin,” “Cannot find name process,” and “Cannot find name Buffer.”

Full deployment:
  firebase use nhl-fantasy-app-ab673
  firebase deploy --only firestore:rules,firestore:indexes,functions,hosting:app

Frontend-only deployment:
  npm run build
  firebase deploy --only hosting:app

Functions-only deployment:
  npm --prefix functions run build
  firebase deploy --only functions

Important: do not run npm audit fix --force casually. It may introduce breaking dependency upgrades. The current audit warnings do not block builds or deployment by themselves.

CRITICAL FANTASY ARCHITECTURE
-----------------------------
The most important rule is that fantasy cycles are asynchronous at the persistent roster-slot/player-window level. Do not redesign the app around one league-wide cycle start or end timestamp.

Each active roster slot owns an immutable six-NHL-game window. NHL schedules differ, so different assets finish their windows on different dates. When an asset plays its seventh scheduled NHL team game, that game belongs to the next window even if other assets are still completing their previous windows. Several cycle numbers may therefore be active at the same time across one fantasy team.

All future scoring, projections, queued roster moves, standings, playoffs, recovery logic, and Firestore optimization must preserve this model. Use immutable per-slot windows plus the shared NHL game-result ledger. Never discard already-played games simply because a matchup destination was not known yet.

ROSTER CONFIGURATION
--------------------
Starting roster:
  3 LW
  3 C
  3 RW
  4 D
  1 team-based goalie unit
Bench: 3 flexible slots
IR: 3 slots
Starting roster size: 14
Total roster capacity including bench and IR: 20

The goalie asset represents the NHL team goalie unit, not one individual goalie.

SCORING V3
----------
Every roster-slot window contains six NHL team games.

Forward scoring per NHL game:
  Goals: first 6, second 4, additional 2.5
  Primary assists: first 5, second 3.5, additional 2.5
  Secondary assists: first 2.5, second 1.5, additional 0.5
  Shot on goal: 0.75
  Hit: 0.45
  Blocked shot: 0.75
  Power-play point bonus: 1.25
  Short-handed point bonus: 3
  Game-winning goal: 2
  Overtime goal: 2
  TOI multiplier: 0.2

Defense scoring per NHL game:
  Goals: first 4.5, second 2.75, additional 1.5
  Primary assists: first 4, second 2.75, additional 1.5
  Secondary assists: first 1.75, second 1, additional 0.4
  Shot on goal: 0.4
  Hit: 0.55
  Blocked shot: 1.05
  Power-play point bonus: 0.85
  Short-handed point bonus: 2
  Game-winning goal: 2
  Overtime goal: 2
  Defense TOI multiplier is adaptive with base 0.27, plus/minus modifier 0.015, floor 0.24, and ceiling 0.31.

Goalie-unit scoring per NHL game:
  Participation base: 3
  Save: 0.27
  Win: 3.5
  Shutout: 4
  Continuous save-percentage quality model with baseline 0.900
  Save-percentage quality is clamped from -3 to 10
  Maximum goalie-unit fantasy points per NHL game: 28

Scoring rules are frozen in league/cycle records so completed games remain reproducible.

PROJECTION ENGINE
-----------------
Current shared projection version: Projection V9.
Projection snapshots are shared and stored in Firestore. Per-slot window projections are frozen when the window begins.

Drafts must use a verified Projection V9 snapshot. The server must not silently use the old emergency low-value ranking board. A live draft pins the exact verified snapshot ID so the Draft Room and server auto-picks use the same rankings for the full draft.

A valid draft projection must:
  use Projection V9;
  not have generationReason “server-emergency”;
  contain a healthy asset pool;
  be generated for the actual number of participating fantasy teams;
  remain available through the draft.

If the current projection pointer is bad but a healthy recent V9 snapshot exists, the server may restore the healthy pointer. If no verified snapshot exists, the draft should remain stopped rather than make inaccurate selections.

DRAFT SYSTEM
------------
Draft type: snake draft.
The system supports manual picks, queues, auto-draft, timeouts, consecutive-timeout auto-mode, bench filling, and position constraints.

Server-controlled behavior:
  runScheduledDraftAutomation checks drafts on a schedule.
  continueServerDraftAutomation reacts to draft document changes.
  processAutoDraftQueueChange reacts when a manager enables auto-draft.
  processDraftClockDeadline is a Cloud Tasks worker for an exact individual pick deadline.

Important draft safeguards:
  One per-league server lease prevents several workers from processing the same draft simultaneously.
  Temporary Firestore transaction contention is retried.
  Every pick clock receives its own exact Cloud Task.
  A deadline task may make no more than one automatic pick.
  Duplicate or stale tasks verify league ID, pick number, and clock timestamp before acting.
  Auto-picks are paced rather than allowing one worker to make most of the draft in a single burst.
  The minute scheduler remains a recovery mechanism if a task is interrupted.
  Snake-turn consecutive picks must remain valid.

Previous bugs that must not return:
  Firestore error 10 ABORTED caused by several workers contending for the same draft.
  Clock stuck at 0:00 because no exact deadline job existed.
  A single invocation making up to 24 picks and making the draft appear to jump ahead.
  Server emergency rankings placing elite players such as Connor McDavid near 49 projected points.

CYCLE 1 START BEHAVIOR
----------------------
Cycle 1 starts automatically as soon as a draft changes to status complete. The commissioner does not press a Start Cycle button.

initializeSeasonAfterDraft is the immediate Firestore trigger.
runSeasonStartAutomation now runs every minute as a recovery sweep, not as a September calendar gate. It finds completed drafts missing cycle-1 and repairs them.
runScheduledLeagueAutomation continues scoring, cycle progression, standings, and playoff work.

The project still contains default season metadata for 2026-27 and September 29, 2026 at 2:00 p.m. Pacific, but that date must not block Cycle 1 after a completed draft. It remains useful as season metadata and for historical/live configuration.

SERVER AUTOMATION FUNCTIONS
---------------------------
Critical deployed Functions include:
  runScheduledDraftAutomation
  processDraftClockDeadline
  continueServerDraftAutomation
  processAutoDraftQueueChange
  initializeSeasonAfterDraft
  runSeasonStartAutomation
  runScheduledLeagueAutomation
  refreshGlobalPlayerAvailabilityScheduled
  refreshDailyPlayerAvailability
  processQueuedInjuryEmails
  sendInjuryEmailsOnGlobalAvailabilityChange
  sendInjuryEmailOnAvailabilityChange
  sendTestInjuryEmail
  sendWelcomeEmailOnProfileCreated
  requestPasswordResetEmail
  resendVerificationEmail
  applyImmediateRosterMove
  nhlApiProxy
  advanceHistoricalReplayDay

Release Readiness surfaces automation health for commissioners. Scheduled workers write health/status documents under appData.

INJURY DATA AND EMAIL ALERTS
----------------------------
The browser uses same-origin API routes. NHL API routes use /v1 and /stats. ESPN injury data uses /espn/injuries through the server-side proxy; the browser should not contact ESPN directly.

The global player-availability report refreshes server-side. Browser refresh remains an emergency/manual fallback.

Injury email alerts are optional, disabled by default, and require a verified email address. Actionable states include Out, IR, LTIR, Suspended, and Personal Leave.

Availability changes create server-only queue records. processQueuedInjuryEmails runs every five minutes. Messages are batched so nearby alerts for the same owner can be sent together rather than spamming one email per player.

Before sending, the server rechecks that:
  the owner still has alerts enabled;
  the authentication email remains verified;
  the player is still unavailable after league override rules;
  the player remains in an active roster slot;
  no replacement is already queued for that slot;
  the independent slot window still has games remaining;
  the regular-season or playoff window remains actionable.

If the player is in a live NHL game, the alert waits until the game is no longer live, followed by a 15-minute hold. Otherwise it uses a 15-minute hold. Delivery is normally within about five minutes after the hold expires.

The commissioner test email is only a format preview. It sends to the verified commissioner and uses the fictional players Riley Rinkrat and Casey Crease. It does not modify real rosters or queue records.

ADD/DROP, BENCH, AND IR
-----------------------
Roster changes are evaluated against the persistent slot windows, not a global league cycle timestamp.

A roster move may occur immediately when neither involved asset has played a game in its current relevant window. Once either side has begun its window, the move may be queued for the correct next boundary. The UI must explain which player/window delays the transaction.

Moving to IR is only offered when the player is eligible. Injury and suspension indicators appear consistently on My Team, Matchup, and Add/Drop views.

Queued moves and injury replacement logic must preserve the already-counted games in each immutable window.

PLAYOFFS
--------
The app reserves 13 complete fantasy periods, corresponding to the first 78 scheduled NHL games for each NHL team. Regular-season length adjusts to make room for playoffs.

2-3 fantasy teams:
  12 regular cycles, 1 championship cycle.

4-7 fantasy teams:
  11 regular cycles, 2 playoff cycles.
  Semifinals: 1 vs 4 and 2 vs 3.

8-12 fantasy teams:
  10 regular cycles, 3 playoff cycles.
  Seeds 1 and 2 receive byes.
  Opening round: 3 vs 6 and 4 vs 5.

Tied playoff matchups advance the higher seed. The bracket does not reseed. Non-title teams continue classification/consolation games so all teams receive a final placement.

Playoff rounds preserve the asynchronous window philosophy. Assets may begin and accumulate games before the fantasy opponent or bracket destination is known. After the prior round resolves, those games must be backfilled into the championship, third-place, fifth-place, or consolation matchup. Do not discard them or force the player to wait.

STANDINGS AND MATCHUP COMPLETION
-------------------------------
A fantasy matchup finalizes only after the relevant independent roster-slot windows complete. Standings are applied once. Regular-season standings freeze when playoffs begin.

Seeding order:
  1. Win percentage, counting a tie as half a win
  2. Points For
  3. Point differential
  4. Total wins
  5. Stable team-name/owner fallback

LIVE SCORING AND PERFORMANCE
----------------------------
The server owns live scoring and league automation. The target cadence is roughly every ten minutes. Shared control documents and leases prevent duplicate work. Unchanged snapshots should not be rewritten.

Mobile performance is a priority. Avoid adding high-frequency listeners or repeated league-wide reads. Injury data is shared globally rather than fetched independently per league. The scoring/game ledger should be reused across leagues.

BRANDING AND UI
---------------
The site uses a pixel-art hockey theme with the masked RinkRat mascot and a clearer pixel jersey icon. Primary site branding assets are under public/assets/branding and public/assets/pixel-icons.

Favorite NHL team colors are identity accents rather than whole-page backgrounds. The app uses a neutral readable canvas and chooses black/white foregrounds based on contrast.

Background presets:
  Rink Dark
  OLED Black
  Ice Gray
  Light Ice

The favorite team is selected during profile creation and saved to the user profile. Existing profiles without a favorite team fall back to Vegas.

Important UX direction:
  Mobile is as important as desktop.
  Keep status colors clear: upcoming yellow, played green, missed red.
  Keep cycle numbers centered and readable.
  Reduce low-use buttons and dense explanations.
  Do not restore obsolete commissioner Start Cycle controls.
  Account Settings contains the discoverable Email Injury Alerts callout and email icon.

PRODUCTION SAFETY
-----------------
Production runtime configuration is live-only and hides developer controls. Historical replay tools are for development/testing and should not appear in a normal production build.

The full-season simulator is deterministic and should not make NHL requests or Firestore writes. It is regression coverage for roster size, 11-cycle four-team seasons, six-game windows, 7-vs-4 asynchronous advancement, queued moves, immutable projections, scoring leases, standings, and playoff routing.

The Release Readiness page reads existing league and app health. It classifies checks as pass, warning, or fail. A warning immediately after deploying a new scheduled worker can be normal until the first execution.

KNOWN NON-BLOCKING BUILD OUTPUT
-------------------------------
The Angular production build may warn that src/app/features/cycles/cycle-one/cycle-one.css exceeds its configured style budget by several kilobytes. This is currently a warning, not a failed build.

npm audit may report low, moderate, or high dependency vulnerabilities. Do not use npm audit fix --force without reviewing the dependency changes.

FUNCTIONS DEPENDENCY RECOVERY
-----------------------------
The repeated 100+ TypeScript error pattern is not 100 separate source problems. It means the Functions dependency tree is missing or incomplete. Typical errors include:
  Cannot find module firebase-admin/firestore
  Cannot find module firebase-functions/v2/https
  Cannot find name node:crypto
  Cannot find name process
  Cannot find name Buffer
  FirebaseFirestore namespace missing
  Many implicit-any or unknown errors caused by missing imported types

Current prevention:
  functions/package.json has a prebuild dependency check.
  functions/scripts/ensure-dependencies.cjs checks the required packages.
  If they are missing, npm ci runs automatically before tsc.

Manual recovery remains:
  rm -rf functions/node_modules
  npm --prefix functions ci
  npm --prefix functions run build

IMPORTANT SOURCE FILE MAP
-------------------------
Frontend:
  src/app/features/draft/draft-room/ — draft UI
  src/app/features/draft/draft-setup/ — draft schedule and projection preparation
  src/app/features/cycles/cycle-one/ — cycle/matchup UI
  src/app/features/leagues/league-detail/ — league home and navigation
  src/app/features/account/account-settings/ — profile, themes, and email-alert preference
  src/app/core/release/release-readiness.service.ts — health/readiness checks
  src/styles.css — global visual tokens and shared styling

Functions:
  functions/src/draft-automation.ts — scheduled draft opening, leases, Cloud Tasks deadlines, auto-picks
  functions/src/league-automation.ts — Cycle 1 creation, scoring/cycle progression, recovery, playoffs
  functions/src/email-notifications.ts — account emails, injury queue, Resend delivery, test preview
  functions/src/index.ts — API proxy and global injury refresh
  functions/src/roster-moves.ts — immediate/queued roster move server logic
  functions/src/season-config.ts — season metadata/defaults
  functions/src/shared/core/ — shared scoring, projection, roster, cycle, playoff, and Firebase compatibility logic

Firestore and deployment:
  firestore.rules
  firestore.indexes.json
  firebase.json
  .firebaserc
  functions/package.json
  functions/package-lock.json
  functions/.env.nhl-fantasy-app-ab673

TROUBLESHOOTING COMMANDS
------------------------
List deployed Functions:
  firebase functions:list

Selected logs:
  firebase functions:log --only runScheduledDraftAutomation
  firebase functions:log --only processDraftClockDeadline
  firebase functions:log --only continueServerDraftAutomation
  firebase functions:log --only runSeasonStartAutomation
  firebase functions:log --only runScheduledLeagueAutomation
  firebase functions:log --only refreshGlobalPlayerAvailabilityScheduled
  firebase functions:log --only processQueuedInjuryEmails

Confirm Resend secret exists without printing its value:
  firebase functions:secrets:get RESEND_API_KEY

Verify same-origin API routes after deployment:
  curl -I https://rinkratfantasy.com
  curl -sS https://rinkratfantasy.com/v1/roster/VGK/current | head
  curl -sS https://rinkratfantasy.com/espn/injuries | head

CURRENT HANDOFF STATUS
----------------------
The project includes:
  server-controlled draft opening and exact deadline tasks;
  per-league draft automation leases;
  verified Projection V9 draft rankings with a frozen snapshot;
  automatic Cycle 1 creation immediately after draft completion;
  minute-by-minute Cycle 1 recovery;
  scheduled scoring/cycle/playoff automation;
  server-side global injury refresh;
  queued and batched injury emails through Resend;
  Release Readiness health checks;
  RinkRat branding, favorite-team accents, and neutral background themes;
  five selectable identity packs for every current NHL club;
  ten selectable RinkRat manager profile icons with sitewide account-avatar usage;
  global challenge rewards that permanently unlock away, retro, alternate, and special identities;
  custom league emblems selected during league creation, with eight pixel-art designs and eight
  color variants per design;
  automatic Functions dependency repair before TypeScript compilation.

When beginning work in a new chat, provide the current full project ZIP and tell the assistant to read RINKRAT_PROJECT_CONTEXT.txt first. The ZIP is the source of truth if this file and implementation ever disagree.

=====================================================================
TEAM LOGO + COLOR IDENTITY VARIANTS AND CHALLENGE REWARDS (JULY 2026)
=====================================================================
User profiles store:
  favoriteTeamAbbreviation
  favoriteTeamVariantId
  teamIdentityUnlocks

Every current NHL club has five identity choices generated by the central catalog:
  Current Home — available immediately.
  Current Away — ice-white presentation with team-color accents.
  Retro/Heritage — a historical franchise identity and period-style colors.
  Alternate — an alternate crest or alternate uniform-inspired palette.
  Special — an additional reverse-retro, color-rush, outdoor, or creative heritage identity.

Identity reward tiers unlock globally, not only for the currently selected club:
  First Line Change — join a fantasy hockey league — unlocks Current Away for every team.
  Commissioner Mode — create or manage a league — unlocks Retro/Heritage for every team.
  League Explorer — compete in three leagues — unlocks Alternate for every team.
  Crowded Schedule — face at least ten fantasy opponents — unlocks every Special identity.

Unlock behavior:
  Unlocks are calculated from the manager's league summaries when Account Settings loads.
  Newly earned tiers are saved permanently in users/{uid}.teamIdentityUnlocks.
  Once saved, an unlock remains available even if the manager later leaves a league.
  Existing accounts require no manual migration; absent unlock data is treated as an empty list.
  A saved variant that is not unlocked falls safely back to current-home.
  Firestore rules allow no more than the four known reward strings.

Account-page behavior:
  Select a favorite club first, then choose among its five identity cards.
  Locked cards remain visible and show the challenge required to open them.
  The Trophy Shelf shows each challenge and its global identity reward.
  Selecting an unlocked identity saves immediately and updates the app theme.
  Account-page logo images fall back to the club's current NHL crest if a future asset fails.
  Historical identities use curated exact NHL archive filenames rather than guessed season ranges.
  Alternate identities without a verified alternate crest reuse the current crest while preserving
  the selected alternate uniform-inspired color palette.

The selected identity controls:
  sitewide CSS color variables;
  dashboard and account visuals;
  My Team and favorite-team logo displays;
  matchup/opponent identity data;
  local theme storage and the Firestore user profile.

Important source files:
  src/app/shared/pixel-theme/pixel-theme.data.ts
    - all 32 club palettes, 160 total identity entries, reward metadata, and verified logo URLs
  scripts/validate-team-logo-urls.mjs
    - checks all current and archived NHL logo URLs and fails on any unreachable asset
  src/app/core/user/user-theme.service.ts
    - validates unlocks before applying or restoring a selected identity
  src/app/core/user/user.service.ts
    - profile types and identity-unlock persistence
  src/app/features/account/account-settings/
    - team picker, locked cards, achievements, and challenge calculations
  firestore.rules
    - validates favoriteTeamVariantId and teamIdentityUnlocks

New identity packs should be added centrally in SPECIAL_TEAM_VARIANTS. Each club currently has
one heritage, one alternate, and one special definition in addition to the universal home/away
pair. Keep variant IDs stable because they are stored in user profiles. Never construct historical
logo URLs by guessing a season range or appending _alt.svg. Add an exact archivedLogo filename
that has been verified against the NHL logo archive, then run `npm run validate:team-logos`.

============================================================
CUSTOM LEAGUE EMBLEMS AND COLOR VARIANTS (JULY 2026)
============================================================
League documents now store:
  leagueLogoId
  leagueLogoPaletteId

The league creator selects one of eight high-resolution pixel-art emblems and one of eight color
variants. This provides 64 combinations without allowing arbitrary uploaded URLs. Existing league
documents require no migration; missing or invalid values fall back to the Rink Rat emblem in the
Rink Gold palette.

The selected emblem appears:
  on each league card on the Dashboard;
  beside the league name on the Current League page.

Important source files:
  src/app/shared/league-logo/league-logo.data.ts
    - stable emblem IDs, palette IDs, display names, safe normalization, and asset paths
  public/assets/league-logos/{leagueLogoId}/{leagueLogoPaletteId}.png
    - 256x256 transparent pixel-art assets; eight designs by eight palettes
  scripts/validate-league-logo-assets.mjs
    - verifies that all 64 local PNG combinations exist and remain 256x256
  src/app/features/leagues/create-league/
    - emblem picker, palette picker, and live preview
  src/app/core/league/league.service.ts
    - persists selections and includes them in league summaries
  src/app/features/dashboard/
    - displays the selected emblem on league cards
  src/app/features/leagues/league-detail/
    - replaces the old generic rat title icon with the selected league emblem

Keep leagueLogoId and leagueLogoPaletteId values stable because they are stored in Firestore.
When adding an emblem or palette, add every matching asset combination so the central path helper
can always resolve to a real file, then run `npm run validate:league-logos`.

=====================================================================
LEAGUE-SPECIFIC PROFILE PICTURES (JULY 2026)
=====================================================================
Profile pictures are NOT global user-account settings. They belong to the manager's identity
inside one specific league and are stored on both league-owned identity documents:
  leagues/{leagueId}/members/{uid}.profileIconId
  leagues/{leagueId}/teams/{uid}.profileIconId

The catalog contains 35 optimized 512x512 WebP assets in three sections:
  Rink Rats — 10 original player and goalie characters.
  Jerseys — 15 standalone fictional sweaters with no NHL branding.
  Misc Hockey — 10 hockey references including a referee, ice resurfacer, goalie mask, skates,
  crossed sticks, visor helmet, goal light, goalie gear, championship cup, and bench gear.

Every asset has a transparent background. ManagerAvatar also has no border, background, shadow,
or glow, so only the pixel artwork appears beside a name.

League behavior:
  - Creating a league assigns the commissioner a random picture from all 35 choices.
  - Joining a league for the first time assigns that membership a random picture from all 35.
  - Rejoining preserves the picture already saved for that league.
  - Opening a legacy league membership without a valid picture assigns and saves a random one.
  - A manager can choose a different picture from the Your Team card on the Current League page.
  - Changing the picture affects only that league and does not change the manager's other leagues.

The Dashboard and global Account Settings page intentionally do not show or edit a manager
profile picture. Account Settings still controls global username, favorite NHL team, theme, and
other account preferences. User documents may contain a legacy profileIconId from an older build,
but current code ignores it and Firestore rules no longer allow it to be edited as a global field.

Within league context, the saved league picture appears next to manager/team identities in the
Current League page, My Team, team lists, draft setup, draft room, standings, schedule preview,
cycle matchups, matchup overview, point leaders, and playoff bracket/placements.

Important source files:
  src/app/shared/profile-icon/profile-icon.data.ts
    - all 35 stable IDs, categories, metadata, random selection, seeded display fallback, and lookup
  src/app/shared/manager-avatar/manager-avatar.ts
    - reusable transparent profile-picture component for league manager/team labels
  public/assets/profile-icons/
    - ten transparent Rink Rat assets
  public/assets/profile-icons/jerseys/
    - fifteen transparent fictional standalone jersey assets
  public/assets/profile-icons/misc-hockey/
    - ten transparent equipment and rink-reference assets
  src/app/features/leagues/league-detail/
    - categorized league-only picker in the Your Team card
  src/app/core/league/league.service.ts
    - random assignment, legacy repair, league-only persistence, and manager-name synchronization
  src/app/core/team/team.service.ts
    - team identity fields and stable read fallback
  src/app/core/auth/auth.service.ts
    - no longer creates a global user profileIconId
  src/app/features/dashboard/
    - deliberately contains no profile-picture display or picker
  src/app/features/account/account-settings/
    - deliberately contains no global profile-picture picker
  firestore.rules
    - exact 35-ID allowlist for league member/team identity writes; global user icon edits blocked
  scripts/validate-profile-icon-assets.mjs
    - recursively validates all 35 mobile-friendly WebP assets

Validation command:
  npm run validate:profile-icons

Keep IDs stable because they are stored in league member and team documents. New future categories
should be added centrally to profile-icon.data.ts, mirrored in the Firestore allowlist, and added
to the asset validator.

THEME CONTRAST AND MATCHUP IDENTITY UPDATE (JULY 28, 2026)
---------------------------------------------------------
Theme-aware compatibility rules now keep legacy draft headings, labels, controls, and cards readable across Rink Dark, OLED Black, Ice Gray, and Light Ice. The global navigation intentionally remains a dark navy bar in every background preset so the white RinkRat Fantasy brand and navigation labels always retain strong contrast.

The detailed Cycle matchup header now displays each manager's selected NHL identity logo, selected variant label, and a three-color identity strip. The logo follows the exact current, away, retro, alternate, or special identity selected on the account page. The color strip makes home and away identities visibly different even when both managers choose the same NHL team and therefore share the same primary crest. The selected palette also lightly tints that manager's matchup summary while roster content remains on readable neutral surfaces.


ADD/DROP DECISION CENTER AND LIGHT ICE CONTRAST (JULY 28, 2026)
----------------------------------------------------------------
The global NHL logo ribbon remains a fixed dark presentation in every background theme so its white team abbreviations never disappear on Light Ice. The Free Agents page also uses a stable dark decision surface across all themes, including its search, position, sort controls, roster-slot cards, and comparison panels.

Shared projection version 9 adds manager-facing add/drop decision data to each skater and goalie-unit asset: current-season fantasy points, rest-of-season estimate, estimated final total, expected points to date, over/under projection values, current NHL-team six-game cycle number, six played/missed/upcoming game markers, and a category-by-category point breakdown. A green marker means the player appeared, red means the NHL team played while the player missed, and yellow means the game is upcoming.

The Free Agents page now supports sorting by next-cycle projection, season points, rest-of-season estimate, final outlook, projection performance, or reliability. Expandable details show recent fantasy pace, reliability, schedule difficulty, expected availability, sample size, projection source, and scoring breakdown. The roster-slot step also compares the incoming player directly with the selected outgoing player and calculates the projected next-cycle and rest-of-season gain or loss. Mobile keeps the core metrics visible and places lower-priority detail inside expandable sections.

Important files:
  src/app/core/draft/draft.models.ts
  src/app/core/draft/draft-player-pool.service.ts
  src/app/core/projection/projection-snapshot.service.ts
  src/app/features/free-agents/free-agents.ts
  src/app/features/free-agents/free-agents.html
  src/app/features/free-agents/free-agents.css
  src/styles.css
  ADD_DROP_DECISION_CENTER_UPDATE.txt

CURRENT-SEASON ADD/DROP STAT DROPDOWN (JULY 28, 2026)
------------------------------------------------------
- Add/Drop expandable player details no longer explain projection construction.
- Free-agent, waiver, incoming, and outgoing dropdowns show current-season NHL
  stat totals and the fantasy-point contribution from each scoring category.
- Each dropdown ends with a clear current-season fantasy total.
- Projection comparison metrics remain visible on the main card outside the
  dropdown so the dropdown can stay focused on actual production.

=====================================================================
RINKRAT VISUAL SYSTEM PHASE 2A — PAGE IDENTITIES (JULY 2026)
=====================================================================
Phase 2A gives the Dashboard, Current League page, and Draft Room distinct visual
identities on top of the Phase 1 arena foundation. The Dashboard is an arcade
league-select/save-file screen, Current League is a franchise front office, and
Draft Room is an arena jumbotron with a scouting terminal and GM desk.

The implementation is presentation-only in src/rinkrat-page-identities-phase2.css,
loaded after src/rinkrat-visual-system.css through angular.json. It does not change
Firestore, league logic, draft logic, roster rules, scoring, projections, or the
asynchronous six-game cycle architecture. Team colors remain controlled accents,
not unsafe whole-card text/background combinations. Mobile and Light Ice support
are included. No rat-tail divider is used.

=====================================================================
DRAFT START, AUTO-DRAFT, AND LEGACY MEMBERSHIP FIX (JULY 2026)
=====================================================================
- Firestore draft and pick reads now recognize legacy league team documents even
  when they predate the ownerId field. Commissioner access is also explicit.
- Browser and Cloud Functions now agree on Shared Projection Version 9. The old
  server-side Version 8 requirement could prevent scheduled starts and automatic
  selections after the Add/Drop projection upgrade.
- Commissioner-browser scheduled activation starts the first pick clock
  immediately and pins the verified shared projection snapshot.
- Server draft-document and auto-draft queue triggers process automatic picks
  immediately, while exact Cloud Tasks remain the deadline/contention fallback.
- League status messaging now accurately says the server is opening a scheduled
  draft rather than telling managers it is waiting for the commissioner.
- See DRAFT_START_AUTODRAFT_PERMISSION_FIX.txt for the detailed summary.


ARENA VISUAL SYSTEM — PHASE 3 (JULY 2026)
------------------------------------------
The site now includes the final coordinated page-identity and mascot-polish
layer in `src/rinkrat-arena-phase3.css`, loaded after Phase 1 and Phase 2A.

Key page identities:
- My Team = locker room / roster board.
- Add / Drop = scouting terminal / general manager decision center.
- Matchups = RinkRat Sports Network broadcast package.
- Standings = arena standings board.
- Point Leaders = league stat network.
- Playoffs = Road to the RinkRat Cup.

Polish includes mascot loading/empty states, puck-slide transaction feedback,
goal-light score feedback, penalty-box suspended states, treatment-room IR,
and trophy styling for completed challenges. Reduced-motion preferences remain
respected. The rat-tail divider idea remains intentionally excluded.

This update is frontend presentation only and does not change draft, scoring,
roster, projection, cycle, Firestore, or Cloud Function logic.

LEAGUE DELETION (JULY 2026)
---------------------------
- Current League now includes a commissioner-only League Danger Zone.
- Permanent deletion requires typing the complete league name exactly.
- Deletion is performed by the authenticated deleteLeague callable Cloud Function, not by client-side Firestore deletes.
- The function verifies commissioner ownership, recursively removes the complete leagues/{leagueId} tree, deletes matching leagueInvites, injuryEmailQueue, and emailNotificationLog records, then returns the commissioner to Dashboard.
- Firestore rules block direct deletion of the league root so nested data cannot be orphaned by an incomplete client delete.
- The remembered last-league ID is cleared when it matches the deleted league.

BETA FOUNDATION — PART 1 (JULY 2026)
------------------------------------
The first beta-hardening package adds product observability, safer navigation,
and a direct support channel without changing fantasy scoring or cycle logic.

Implemented:
- Authenticated main-layout routes now use an auth guard and preserve a safe
  returnUrl so signed-out users return to the page they originally requested.
- Every league route verifies membership before loading. Commissioner-only
  setup, projection, and management pages also verify commissioner ownership.
- Production-hidden diagnostics and simulators use a developer-tools guard.
- Unauthorized users see a themed Access Check page instead of raw Firestore
  permission errors.
- Firebase Analytics initializes only on supported non-local hosts. Page paths
  are generalized so league IDs, player IDs, matchup IDs, cycle numbers, and
  asset keys are not sent as analytics path values.
- Initial funnel events include login, registration, league creation, league
  joining, feedback submission, page views, and generalized client-error types.
- A custom Angular ErrorHandler deduplicates and rate-limits authenticated
  client reports before sending sanitized error context to the
  reportClientError callable Function.
- Signed-in managers can submit bug reports, confusing-flow reports, incorrect
  result reports, feature ideas, and account/privacy requests through the new
  feedback page. Reports include an optional verified league context, a
  generalized route, and a reference ID.
- Server-side callable Functions validate, rate-limit, and store feedback and
  error reports. Browser Firestore rules deny direct access to those internal
  collections.
- Public Support, Privacy Policy, and Terms of Use pages are linked from the
  login screen and authenticated footer. The mobile More menu links directly
  to feedback and support.

Important files:
  src/app/core/guards/auth.guard.ts
  src/app/core/guards/league-access.guard.ts
  src/app/core/observability/telemetry.service.ts
  src/app/core/observability/client-error-reporter.service.ts
  src/app/core/observability/rinkrat-error-handler.ts
  src/app/features/support/
  src/app/features/legal/
  src/app/features/errors/access-denied/
  functions/src/index.ts
  firestore.rules

The next beta-foundation package should add App Check configuration and staged
rollout, account deletion/reauthentication, a development-only listener and
performance monitor, and emulator-backed multi-account workflow tests. Training
Camp onboarding and daily manager retention features should follow after the
foundation is tested.

BETA ONBOARDING — TRAINING CAMP AND COACH HELP (JULY 2026)
-----------------------------------------------------------
The highest-priority new-user clarity work is now implemented as an authenticated five-step
RinkRat Training Camp plus contextual Coach help throughout the application.

Training Camp route:
  /training-camp

New registrations are routed to Training Camp before the Dashboard. Existing managers who have
not completed the current version see a Dashboard invitation, but they may continue using the app
without completing it. Completion is saved cross-device on the user profile:
  users/{uid}.trainingCampVersion
  users/{uid}.trainingCampCompletedAt

Current Training Camp version: 1.

The five lessons explain:
  1. Independent six-NHL-game roster-slot windows and seventh-game rollover.
  2. The 14-active, 3-bench, and 3-IR roster structure, including team goalie units.
  3. Immediate versus queued moves and IR behavior.
  4. Current production, projection, schedule dots, form, reliability, and stat breakdowns.
  5. Automatic standings, playoffs, placement routing, and preservation of already-played games.

A global Ask Coach control is mounted in the authenticated Main Layout. It detects the active route
and supplies concise help for Dashboard, League HQ, Draft Setup, Draft Room, My Team, Add/Drop,
Matchups, Standings, Leaders, Playoffs, Account Settings, and Training Camp. It links back to the
full Training Camp and sits above the mobile bottom navigation.

Training Camp analytics events:
  training_camp_started
  training_camp_step_viewed
  training_camp_completed
  training_camp_exited
  coach_help_opened

Important files:
  src/app/core/onboarding/training-camp.service.ts
  src/app/features/onboarding/training-camp/
  src/app/shared/coach-help/
  src/app/layouts/main-layout/
  src/app/features/dashboard/
  src/app/features/auth/auth.ts
  src/app/shared/navbar/navbar.html
  firestore.rules

Future Training Camp changes must increment CURRENT_TRAINING_CAMP_VERSION only when managers
should be invited to review materially changed rules. Do not mark completion for merely opening or
exiting the page; completion is saved only after the final lesson.

TRAINING CAMP CLARITY UPDATE
- Shift 1 now explicitly labels games 1-6 as the First Matchup and game 7 as the Start of Second Matchup.
- The description uses a three-part plain-language breakdown emphasizing independent six-game counters per roster spot.
- Shift 2 now explains scoring identity by position: forwards have higher upside and more volatility, defensemen are more consistent, and the team goalie unit is normally the highest-scoring roster asset.
- Training Camp tells managers to compare players primarily within the same position.

BETA FOUNDATION — PART 2 (JULY 2026)
------------------------------------
The second beta-hardening package adds secure account lifecycle controls and a
staged Firebase App Check client foundation.

Account deletion:
- Account Settings includes a permanent deletion checker.
- The manager must have no commissioner-owned leagues, type the exact saved
  manager name, acknowledge the irreversible action, and re-enter the current
  password.
- The client reauthenticates with Firebase Authentication and refreshes the ID
  token. The deleteMyAccount callable independently requires a recent auth_time.
- The callable removes the Auth user, user profile tree, feedback, diagnostics,
  injury email queues/logs, and observability rate-limit data.
- Joined-league team and membership records are anonymized rather than removed
  so league history remains mathematically stable. The record becomes Deleted
  Manager / Vacant Team.
- An unfinished draft queue for a deleted manager is switched to Auto-Draft so
  the draft can continue.
- Commissioner-owned leagues block deletion and must be removed through each
  league's existing Danger Zone first.

App Check preparation:
- Firebase App Check initialization now occurs before the Angular application
  imports Auth, Firestore, Functions, or Analytics.
- reCAPTCHA Enterprise configuration is centralized in
  src/environments/app-check.config.ts.
- App Check is intentionally disabled until a production site key is registered
  and request metrics can be monitored. Follow APP_CHECK_ROLLOUT_GUIDE.txt and
  never enable enforcement before the token-monitoring stage is healthy.

Important files:
  src/app/core/auth/account-deletion.service.ts
  src/app/core/firebase-app-check.ts
  src/environments/app-check.config.ts
  src/app/features/account/account-settings/
  functions/src/index.ts
  firestore.indexes.json
  APP_CHECK_ROLLOUT_GUIDE.txt

9. BETA OPERATIONS — AUTH HARDENING AND ADMIN CENTER (JULY 2026)
- Login is bounded by timeouts for credential sign-in, fresh ID token confirmation, Auth observer settlement, and manager profile loading. A stalled request cannot keep the UI in "Logging in..." indefinitely.
- Late sign-in completion after a timeout is automatically signed out so a rejected login attempt cannot silently become active later.
- Successful account deletion performs a complete browser-session reset: sign out, terminate the current Firestore client/listeners, clear user-scoped local/session storage, and hard-replace the page before another account signs in.
- Platform operations use a private /admin route protected by a server-verified platform administrator check. League commissioner status alone never grants access.
- Platform administrators can be bootstrapped with platformAdmins/{uid}.enabled == true; a platformAdmin Auth custom claim is also accepted.
- Feedback and automatic errors remain server-managed and blocked by Firestore browser rules.
- Admin Center feedback workflow supports filtering, follow-up email visibility only when consented, likely-error correlation, private notes, and statuses.
- Admin Center errors are grouped by a sanitized fingerprint and show occurrences, affected users, browser distribution, routes, releases, timestamps, sample stack, notes, and review status.
- Admin changes are written through callable Functions and recorded in adminAuditLogs.
- Release label advanced to Release Candidate 3.


FAVORITE-TEAM LOGO RELIABILITY
- Favorite-team current and historical logo assets are now synchronized from the official NHL logo catalog into public/assets/team-identity-logos.
- npm start and npm run build automatically prepare missing assets.
- Runtime identity cards use local SVG paths, removing broken guessed remote filenames and hot-link dependence.
- npm run validate:team-logos verifies all 32 current crests plus every archived/secondary identity asset.

BENCH CARD AND MATCHUP VISIBILITY UPDATE (2026-07-29)
- My Team bench cards now reuse the same fantasy-player-card structure as active starters instead of the older separate bench-card layout.
- Detailed matchup pages show each team's three current bench slots below the active lineup; bench assets are explicitly non-scoring and still show their projection.
- Mobile head-to-head matchup view includes a matching Bench group below LW/C/RW/D/G.
- The matchup component listens only to the current roster documents for the one displayed matchup, and unsubscribes when the matchup/route changes.

SCORING GUIDE (JUL 2026)
- Added /scoring for current standard RinkRat rules and /leagues/:leagueId/scoring for exact league-frozen rules.
- Guide imports the actual ScoringRules object and scoring engine, includes all forward/defense/goalie values, diminishing-return rules, defense TOI formula, goalie save-quality formula, bonuses, worked examples, and print support.
- Linked from desktop/mobile navigation, Training Camp, and Ask Coach.

MATCHUP ROSTER-GAME PROGRESS UPDATE (2026-07-29)
- Each team summary on the detailed matchup page now includes a themed progress bar showing counted starter roster games played versus games left.
- The progress uses the same per-asset gamesPlayed/gamesLeft data as matchup completion, so both team bars add up to the matchup-level "Waiting on N roster games" badge.
- The mobile condensed head-to-head team cards show the same progress. Bench and IR assets are excluded because they do not score in the active lineup window.

```


## RINKRAT_TRAINING_CAMP_CLARITY_UPDATE.txt

```text

RinkRat Training Camp clarity update

- Rewrites Shift 1 in simpler language and adds a three-step explanation of independent six-game counters.
- Labels games 1-6 as "First Matchup" and labels game 7 as "Start of Second Matchup."
- Clarifies that one player may begin Matchup 2 while another player is still finishing Matchup 1.
- Expands Shift 2 with a plain-language explanation of roster spots.
- Adds a position-value guide: forwards have bigger scoring swings, defensemen are steadier, and the team goalie unit is usually the highest-scoring asset.
- Reminds managers to compare players primarily with others at the same position.
- Includes responsive desktop and mobile layouts and retains theme-aware colors.

```


## RINKRAT_TRAINING_CAMP_UPDATE.txt

```text

RINKRAT BETA ONBOARDING UPDATE
==============================

Adds the five-shift Training Camp, first-registration routing, cross-device completion state,
Dashboard invitation for incomplete managers, global contextual Ask Coach help, navigation links,
and privacy-conscious onboarding analytics.

This update changes Angular code and Firestore rules. It does not change draft, scoring,
projection, roster, cycle, standings, or playoff behavior.

```


## SCORING_GUIDE_POSITION_BUTTON_ROUTE_FIX.txt

```text

RINKRAT SCORING GUIDE POSITION BUTTON ROUTE FIX

Problem
- The Forward, Defensemen, Goalie Unit, and Examples controls used plain hash-link anchors.
- In some app/route states those clicks were treated as navigation, reran route guards, and could return the manager to login.

Fix
- Replaced the four hash links with type=button controls.
- Buttons now use Angular ViewportScroller to move to the requested section without changing routes.
- Updated CSS so the controls retain the exact same appearance and responsive layout.

```


## SCORING_GUIDE_UPDATE.txt

```text

RINKRAT COMPLETE SCORING GUIDE UPDATE

Purpose
- Adds one permanent, easy-to-find place where managers can see the exact scoring rules by position.
- Uses the same ScoringRules object and scoring-engine functions as live scoring, so examples and displayed values stay synchronized with the site.

New routes
- /scoring shows the current standard rules used for newly created leagues.
- /leagues/:leagueId/scoring shows the exact rules saved to that existing league and is protected by the league-member guard.

Guide contents
- Simple explanation of how six NHL games become one cycle total.
- Full forward table, including per-game diminishing goal and assist values.
- Full defense table, including the exact time-on-ice and plus/minus multiplier behavior.
- Full team goalie-unit table, save-quality formula, examples, per-game maximum, and six-game maximum.
- Game-winning and overtime goal bonuses.
- Worked forward, defense, and goalie examples calculated by the production scoring engine.
- Clarifications for stacking bonuses, bench/IR scoring, independent slot windows, and frozen completed scoring.
- Print-friendly layout.

Access points
- Desktop navigation.
- Mobile More menu.
- Current-league navigation uses that league's frozen scoring rules.
- Training Camp roster lesson.
- Ask Coach panel.

```


## TEAM_IDENTITY_LOGO_RELIABILITY_UPDATE.txt

```text

RINKRAT FAVORITE-TEAM LOGO RELIABILITY UPDATE

Problem fixed
-------------
The Favorite Team identity picker previously loaded historical and alternate NHL
logos directly from guessed remote URLs. Many of those date-range filenames did
not match the NHL's current official logo catalog, so the browser silently fell
back to the current crest. This made only a small number of alternate logos appear.

New behavior
------------
- Current, historical, alternate, and secondary crests are downloaded from the
  official NHL asset service into public/assets/team-identity-logos/.
- The application displays those local SVG files instead of hot-linking every
  identity card to a remote URL.
- Before npm start or npm run build, the sync script checks the local cache.
- Missing exact filenames are resolved against the official NHL franchise logo
  catalog by team code and intended season range.
- Once the assets exist, normal builds are offline-safe and do not redownload them.
- A source-manifest.json file records the official source URL used for every asset.

Commands
--------
npm run sync:team-identity-logos
npm run refresh:team-identity-logos
npm run validate:team-logos

The normal npm start and npm run build commands invoke the sync automatically.

```


## THEME_CONTRAST_MATCHUP_IDENTITY_UPDATE.txt

```text

RINKRAT THEME CONTRAST + MATCHUP IDENTITY UPDATE
Date: July 28, 2026

WHAT CHANGED
------------
1. Theme contrast
- The main navigation now remains dark navy in every background preset so the white RinkRat Fantasy brand is always readable.
- Draft Room headings, league name, pick count, Player Pool, My Queue, control labels, inputs, cards, and supporting text now use the active theme's text and surface variables.
- Rink Dark, OLED Black, Ice Gray, and Light Ice now receive appropriate foreground and control colors.
- Special draft states such as urgent clocks, paused clocks, active auto-draft, current picks, and completed picks preserve their status colors.
- Shared card headings receive a theme-aware foreground so older light-only component styles no longer become dark-on-dark.

2. Matchup identity presentation
- Each fantasy team's detailed matchup header now shows the exact NHL identity logo selected by that manager.
- Retro and heritage selections use their alternate historical crest when the catalog contains one.
- Each header shows the selected identity label and a three-part color strip.
- Two managers using the same NHL team can now clearly distinguish home and away identities through the palette strip and tinted summary surface.
- Current and projected scores remain in the header.
- The condensed mobile matchup header receives the same logo, identity label, and color strip.
- Player cards and roster boards remain mostly neutral for readability while the identity header carries the selected colors.

FILES CHANGED
-------------
src/styles.css
src/app/features/cycles/cycle-one/cycle-one.ts
src/app/features/cycles/cycle-one/cycle-one.html
RINKRAT_PROJECT_CONTEXT.txt

LOCAL TEST COMMANDS
-------------------
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1
npm ci
npm run validate:profile-icons
npm run validate:league-logos
npm run build
npm start

FULL DEPLOYMENT
---------------
npm run deploy:production

```


## VISUAL_SYSTEM_PHASE_1_UPDATE.txt

```text

RINKRAT VISUAL SYSTEM — PHASE 1: ARENA FOUNDATION
==================================================

Implemented
-----------
- Three-font hierarchy:
  - Pixelify Sans for page titles, major scores, league names, and large display text.
  - Barlow Condensed for readable interface text, player names, stats, controls, and mobile UI.
  - Silkscreen for compact labels such as CURRENT, PROJECTED, CYCLE, and status tags.
- Unified arcade-cabinet button treatment with stepped corners, top highlights,
  physical press feedback, consistent focus rings, and distinct primary,
  secondary, warning, destructive, and disabled states.
- Standardized form controls with high-contrast inset fields.
- Arena scoreboard styling for score-, timer-, draft-, and live-status modules.
- Rink-board card rails for player, roster, team, league, transaction, and asset cards.
- Standardized badges, chips, table headers, stat boxes, and fantasy HUD numbers.
- Refined desktop and mobile navigation active states using a lit arena-board marker.
- Subtle ice-rink markings and pixel grid texture behind pages.
- Strong Light Ice contrast safeguards independent of selected NHL colors.
- Reduced-motion and increased-contrast support.
- No rat-tail divider was added.

Files added/updated
-------------------
- src/rinkrat-visual-system.css (new)
- src/index.html
- angular.json
- VISUAL_SYSTEM_PHASE_1_UPDATE.txt (new)

Recommended next phases
-----------------------
Phase 2 — Page identities
- Dashboard cartridge/save-file league cards
- Current League front-office board
- Draft Room jumbotron and pick ticker
- My Team locker-room / bench / treatment-room presentation
- Add/Drop scouting-terminal presentation
- Matchup broadcast package
- Standings arena board

Phase 3 — Mascot and interaction polish
- Rat mascot empty/loading/success/error states
- Goal-light, puck-slide, line-change, trophy, and challenge-unlock animations
- Consistent pixel sprites and optional sound-ready event hooks

```


## VISUAL_SYSTEM_PHASE_2A_UPDATE.txt

```text

RINKRAT VISUAL SYSTEM — PHASE 2A
================================

This phase gives the three highest-traffic league entry experiences a distinct
1990s hockey-video-game identity while preserving all existing fantasy logic.
No rat-tail divider is used.

DASHBOARD — ARCADE SAVE FILES
- The page now reads like a league-select / save-file screen.
- League cards resemble chunky game cartridges with a SAVE FILE label,
  recessed identity panel, team-count data, and a strong Continue/Open action.
- The favorite-team area is presented as a manager-profile console.
- Desktop and mobile layouts preserve room for league and team names.

CURRENT LEAGUE — FRANCHISE FRONT OFFICE
- The league header is now a franchise front-office board.
- The manager identity, medical desk, league information, current cycle,
  draft state, quick actions, and franchise cards share one visual language.
- Existing team colors remain accents rather than unsafe page backgrounds.
- Light Ice keeps dark readable text and restrained shadows.

DRAFT ROOM — ARENA JUMBOTRON
- The league/draft header and active clock now resemble an arena jumbotron.
- Injury status is treated as a medical ticker.
- Roster requirements look like a bench-and-lineup board.
- Recent/upcoming picks look like a pick ticker.
- The player pool is a scouting terminal and the sidebar is a GM desk.
- Urgent clock, paused clock, current pick, and availability states remain clear.

IMPLEMENTATION
- New global stylesheet: src/rinkrat-page-identities-phase2.css
- angular.json loads it after src/rinkrat-visual-system.css.
- No TypeScript, Firebase rules, database schema, or fantasy-scoring logic changed.

```

# Batch 6C.4 — Browser Workflow Retirement

The live multi-account browser workflow was removed from the default verification process after its test-only Firestore inspection conflicted with the intentionally hardened league-list rules. This retirement does not loosen Firestore rules, Cloud Function authority, authentication checks, or any production behavior. It removes only the flaky local browser automation.

The approved verification path continues to run the Firestore rule suite, Angular production build, Functions TypeScript build, draft authority tests, league onboarding tests, competition authority tests, profile and injury authority tests, Game Center structural tests, Game Center rollback tests, and documentation-cleanliness tests.

# Batch 7A — Design-System Foundation

Batch 7A creates a controlled visual foundation without intentionally redesigning any current page. The approved Batch 6C.4 appearance remains in place while future pages gain a consistent, testable styling API.

## What changed

- Added `src/rinkrat-design-tokens.css` as the single global source of truth for theme colors, favorite-team aliases, typography, spacing, control sizing, elevation, motion, and z-index layers.
- Preserved the existing Rink Dark, OLED Black, Ice Gray, and Light Ice values exactly while adding semantic `--rr-*` aliases for future migrations.
- Moved the existing Phase 1, Phase 2, Phase 3, numeric-font, and pixel-arena global token declarations into the centralized file.
- Added `src/rinkrat-shared-primitives.css` with opt-in foundations for cards, buttons, forms, badges, notices, progress bars, empty/loading states, layout stacks, and clusters.
- Kept all primitives opt-in. No current feature template uses them yet, so this batch does not silently change the appearance of Game Center, Dashboard, League HQ, Draft Room, Free Agents, My Team, or Account Settings.
- Added a repeatable design-debt audit. The audit prevents the existing `!important` and literal-color counts from increasing beyond the Batch 7A baseline and requires shared primitives to remain token-driven.
- Added nine design-system contract tests and retained the consolidated documentation structure. No loose update `.txt` files or root-level batch checklists were added.

## New styling rules for future work

1. Reusable values belong in `rinkrat-design-tokens.css`.
2. New shared controls should compose `.rr-*` primitives instead of adding broad global selectors.
3. Feature styles may handle layout and feature-specific states, but should consume semantic tokens rather than introducing new hard-coded colors.
4. The design-system debt budgets may be lowered as pages migrate. They should not be raised casually.
5. Page migrations must be reviewed in both Rink Dark and Light Ice before old overrides are removed.

## Batch 7A verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm ci
npm --prefix functions ci
npm run verify:batch7a
```

The command runs all approved Batch 6C verification, nine design-system foundation tests, and the visual-debt audit.

## Manual appearance-preservation checklist

After the automated verification passes, run the site and check these pages in both Rink Dark and Light Ice:

- Dashboard
- Current League / League HQ
- Game Center
- My Team
- Free Agents
- Draft Setup and Draft Room
- Account Settings

For one favorite-team palette with a light primary color and one with a dark primary color, confirm:

- Page backgrounds, cards, borders, headings, buttons, fields, scores, badges, and progress bars look the same as before Batch 7A.
- Text remains readable in both themes.
- Buttons still show hover, pressed, disabled, and keyboard-focus states.
- No horizontal scrolling appears around 390 pixels wide.
- No new console errors appear.

This batch changes only CSS organization, opt-in shared style foundations, tests, and documentation. It does not change Angular behavior, Firebase configuration, Firestore rules, Cloud Functions, scoring, drafts, rosters, cycles, standings, injuries, or playoffs.

# Batch 7B — Accessibility Foundations

Batch 7B standardizes keyboard, focus, form, and route-announcement behavior without redesigning the approved RinkRat pages or changing fantasy logic.

## What changed

- Added `DialogFocusTrapDirective`, a standalone shared directive that:
  - Moves focus into an opened dialog.
  - Keeps Tab and Shift+Tab inside the dialog.
  - Restores focus to the control that opened the dialog.
  - Emits a consistent Escape action for dismissible dialogs.
- Applied the shared dialog behavior to Coach Help, the mobile More menu, all My Team roster-move dialogs, and the automatic Draft Is Live prompt.
- Converted the sign-in, registration, and password-reset controls into one semantic form. Pressing Enter now submits the current action.
- Added explicit input names, labels, autocomplete values, required states, busy state, accessible validation, and automatic focus on the first invalid field.
- Converted favorite-team selection to a radio-group interaction with Arrow keys, Home, End, Enter, and Space support.
- Added route titles for every lazy-loaded page.
- Added authenticated route-change announcements, document-title updates, and focus movement to the new page heading or main content.
- Added the reusable `.rr-visually-hidden` primitive for screen-reader-only announcements.
- Added nine accessibility contract tests and a repeatable accessibility audit. The audit rejects new modal dialogs without the shared focus trap and icon-only close buttons without accessible labels.

## Batch 7B verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm ci
npm --prefix functions ci
npm run verify:batch7b
```

The command runs all approved Batch 7A verification, nine accessibility-foundation tests, and the accessibility audit.

## Manual keyboard checklist

1. On the login page, enter an email and password and press Enter. Confirm the form submits once.
2. Open registration, submit empty fields, and confirm focus moves to the first missing item.
3. In the favorite-team grid, use Arrow keys, Home, and End. Confirm the selected team and focus move together.
4. Open Coach Help and the mobile More menu. Confirm focus enters the panel, Tab stays inside, Escape closes it, and focus returns to the opener.
5. In My Team, open an IR activation, bench move, active/bench swap, and drop confirmation. Confirm each traps focus and Escape safely cancels it.
6. Navigate between Dashboard, League HQ, My Team, Free Agents, and Game Center using only the keyboard. Confirm focus moves to the new page heading and the browser tab title updates.
7. Repeat the checks at approximately 390 pixels wide and with reduced motion enabled.
8. Confirm there are no new console errors and that mouse/touch behavior remains unchanged.

## Deployment

Batch 7B is frontend-only. It does not require Firestore rules, indexes, Functions, or data migration.

```bash
firebase deploy --only hosting:app -m "Batch 7B accessibility foundations"
```

# Batch 7C.1 — Shared UI Migration

Batch 7C.1 begins applying the approved Batch 7A design system to low-risk shared surfaces while preserving the established RinkRat appearance and all fantasy behavior.

## What changed

- Migrated the desktop and mobile primary navigation to the shared `.rr-nav-item` primitive.
- Replaced every literal color in `navbar.css` with semantic navigation tokens from `rinkrat-design-tokens.css`.
- Moved the duplicated Create League and Join League page shell into shared token-driven `.rr-pixel-shell-*` primitives.
- Reduced `join-league.css` to feature-specific grid settings instead of keeping a second copy of the page, panel, form, button, error, and mascot styling.
- Migrated Support, Feedback, Access Denied, Privacy, and Terms surfaces to shared card primitives.
- Migrated Feedback controls to shared select, textarea, button, and notice primitives.
- Added compatibility aliases for older `--text-main`, `--text-strong`, `--surface-raised`, and status variables so migrated pages use the same theme source as newer pages.
- Added customization hooks to cards, buttons, fields, and notices so individual pages can preserve their approved spacing and presentation without duplicating the full implementation.
- Lowered the tracked CSS debt ceiling from 597 to 595 `!important` declarations and from 3,295 to 3,216 literal colors.
- Added nine migration contract tests and a shared UI migration audit.

No TypeScript business logic, Firebase configuration, Firestore rules, Cloud Functions, scoring, drafting, roster processing, cycles, standings, injuries, or playoffs changed.

## Batch 7C.1 verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm ci
npm --prefix functions ci
npm run verify:batch7c1
```

The command runs every approved Batch 7B check, nine shared UI migration tests, the design-system debt audit, the accessibility audit, and the new migration audit.

## Manual appearance checklist

Review the following in Rink Dark and Light Ice:

1. Desktop navigation: active link, hover, Account, and Logout.
2. Mobile navigation: all five bottom items, More panel, close control, and logout.
3. Create League: copy panel, form panel, emblem/palette selection, error notice, and preview panel.
4. Join League: invite field, submit button, error notice, and mascot panel.
5. Support home, Feedback, Access Denied, Privacy, and Terms cards.
6. Feedback success/error notices, fields, buttons, checkbox, and mobile stacking.
7. Keyboard focus states on navigation, fields, buttons, and links.
8. A mobile viewport around 390 pixels with no horizontal scrolling.

## Deployment

Batch 7C.1 is frontend-only:

```bash
firebase deploy --only hosting:app -m "Batch 7C.1 shared UI migration"
```

# Batch 7C.2 — Dashboard, League HQ, and Account Migration

Batch 7C.2 applies the shared design system to the three largest everyday management surfaces while preserving their approved feature layouts and all fantasy behavior.

## What changed

- Dashboard hero cards, league cards, action buttons, training notice, error notice, badges, and empty state now compose shared `.rr-*` primitives.
- Account Settings now composes shared cards, stat tiles, choice cards, fields, selects, notices, action tiles, buttons, and danger-zone foundations.
- League HQ now composes shared stat tiles, status cards, notices, action tiles, forms, buttons, matchup/team cards, profile choices, and commissioner danger-zone foundations.
- Added shared page-composition primitives for interactive cards, section headings, stat grids, action tiles, choice cards, and danger zones.
- Consolidated repeated page-specific color literals into transitional local aliases. These aliases preserve the exact approved palette values while reducing duplicate CSS declarations and preparing the pages for later semantic token replacement.
- Reduced the project-wide literal-color ceiling from 3,216 to 3,079 without increasing the existing `!important` ceiling.
- Kept feature CSS responsible for the current approved spacing and page-specific layout, so this migration does not intentionally redesign Dashboard, League HQ, or Account Settings.
- Added seven contract tests and a page-design migration audit.

No TypeScript business logic, Firebase configuration, Firestore rules, Cloud Functions, scoring, drafting, rosters, cycles, standings, injuries, playoffs, or data structures changed.

## Batch 7C.2 verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm ci
npm --prefix functions ci
npm run verify:batch7c2
```

The command runs every approved Batch 7C.1 check, seven page-migration tests, and the page-design migration audit.

## Manual appearance checklist

Review Dashboard, League HQ, and Account Settings in Rink Dark and Light Ice, then repeat around 390 pixels wide.

1. Confirm page spacing, favorite-team colors, cards, headings, and backgrounds remain familiar.
2. Check every primary, secondary, quiet, and danger action for hover, pressed, disabled, and keyboard-focus states.
3. Confirm Dashboard league cards, commissioner badges, empty state, and training notice remain readable.
4. Confirm League HQ profile selection, rename controls, injury status, draft/cycle status, hub actions, invite code, team cards, and Danger Zone work normally.
5. Confirm Account Settings favorite-team choices, background choices, email verification, save action, quick links, sign out, and account deletion checker work normally.
6. Confirm Light Ice fields and notices have readable text and borders.
7. Confirm no horizontal scrolling or new console errors appear.

## Deployment

Batch 7C.2 is frontend-only:

```bash
firebase deploy --only hosting:app -m "Batch 7C.2 page design migration"
```

# Batch 7C.3 — Competition Surface Design Migration

Batch 7C.3 applies the shared RinkRat design system to the remaining high-traffic fantasy surfaces while preserving their approved page structure and all competition behavior.

## What changed

- My Team now composes shared page shells, cards, statistic tiles, notices, roster panels, list rows, form controls, and accessible dialog surfaces.
- Free Agents and the Add/Drop Decision Center now compose shared pool cards, filter controls, waiver rows, slot choices, notices, comparison panels, and confirmation actions.
- Draft Setup now composes shared statistics, schedule and order cards, form controls, notices, list rows, and action buttons.
- Draft Room now composes shared clock cards, roster-needs choices, player-pool controls, draft rows, queue and roster cards, badges, and actions.
- Game Center now composes shared matchup cards, team panels, semantic progress bars, notices, badges, navigation actions, and commissioner tools while retaining the approved Batch 6A hierarchy. The duplicate Batch 6B overview remains removed.
- Added shared toolbar, list-row, data-panel, dialog, and score-number primitives for future competition surfaces.
- Consolidated repeated feature-specific palette literals into transitional aliases without changing their exact values.
- Reduced the project-wide literal CSS color ceiling from 3,079 to 2,774 without increasing the existing 595 `!important` declarations.
- Added eight contract tests and a dedicated competition-surface migration audit.

No TypeScript business logic, Firebase configuration, Firestore rules, Cloud Functions, scoring, drafting, roster authority, cycle processing, standings, injuries, playoffs, or data structures changed.

## Batch 7C.3 verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm ci
npm --prefix functions ci
npm run verify:batch7c3
```

The command runs every approved Batch 7C.2 check, eight competition-surface migration tests, and the new migration audit.

## Manual appearance and behavior checklist

Review My Team, Free Agents, Draft Setup, Draft Room, and Game Center in Rink Dark and Light Ice, then repeat around 390 pixels wide.

1. Confirm all page structures, favorite-team colors, roster cards, player rows, scores, and six-game markers remain familiar.
2. On My Team, test team-name saving, active/bench/IR actions, every confirmation dialog, and recent transactions.
3. In Free Agents, test search, position and sort filters, waiver actions, player selection, slot selection, comparison details, and the final confirmation dock.
4. In Draft Setup, test scheduling, pick-clock selection, order movement, reset/randomize, save, and snake preview.
5. In Draft Room, test search and filters, queue actions, manual picks, auto-draft, pause/resume, roster needs, and mobile layout.
6. In Game Center, confirm scores, projections, roster progress, player markers, Team A/B/Both views, benches, and completed-matchup breakdowns remain unchanged.
7. Confirm the rejected duplicate Game Center overview has not returned.
8. Confirm keyboard focus, disabled states, Light Ice contrast, no horizontal scrolling, and no new console errors.

## Deployment

Batch 7C.3 is frontend-only:

```bash
firebase deploy --only hosting:app -m "Batch 7C.3 competition surface design migration"
```


## Batch 7C.3.1 — Game Center Component-Style Budget Hotfix

The first Batch 7C.3 package replaced repeated Game Center color literals with long transitional custom-property references. Although the rendered values were unchanged, those longer references increased the compiled `cycle-one.css` component bundle from approximately 42.08 kB to 46.38 kB, exceeding Angular's 45 kB component-style error budget.

This hotfix keeps all Batch 7C.3 shared primitive classes in the Game Center templates, including cards, data panels, semantic progress bars, notices, buttons, and score-number foundations. It restores only the approved local Game Center palette declarations from Batch 7C.2 so the compiled component stylesheet returns below the build-stopping threshold. My Team, Free Agents, Draft Setup, and Draft Room retain their palette-alias consolidation.

No HTML hierarchy, visual values, TypeScript logic, Firebase behavior, scoring, roster windows, draft behavior, cycles, standings, injuries, or playoffs changed. The design-debt baseline was adjusted honestly from 2,774 to 2,862 literal colors because keeping Game Center below the Angular style budget is more important than reducing a static color-count metric.

Run the normal verification command:

```bash
npm run verify:batch7c3
```

A small warning near the 42 kB preferred Game Center budget may remain, but the stylesheet stays below the 45 kB error budget and the production build completes.

## Batch 7C.3.2 — Game Center Six-Game Marker Layout Hotfix

The six numbered game markers inside each active Game Center player card were still rendered inside the narrow player-name column. In the two-team view, that column can become too narrow and force the six markers into a tall one-per-line stack.

This hotfix moves the marker group to its own full-width row inside every forward, defense, and goalie card. The row uses a fixed six-column responsive grid, so games 1–6 remain ordered left to right while the marker circles scale to the available card width. Single-team mode no longer applies the old negative horizontal offset to this row.

No game results, marker statuses, player scores, projections, roster windows, Firebase data, Cloud Functions, or Firestore rules changed. The update is presentation-only.

Run the normal verification command:

```bash
npm run verify:batch7c3
```

After deployment, check Game Center in Team A, Both, and Team B views on desktop and mobile. Confirm every active player card shows games 1–6 as one compact ordered row and that played, missed, upcoming, and unavailable colors remain correct.


## Batch 7C.3.3 — Wider Game Center Cards and Two-Row Game Markers

The active-player cards now reserve more room for names, NHL team/position details, and current/projected scores. The Game Center shell can expand to 1,760 pixels on large displays, uses smaller internal gutters, and switches the two-team comparison to full-width stacked team panels at 1,180 pixels or below instead of squeezing both rosters into narrow columns.

Each six-game indicator is now arranged as a compact 3-by-2 grid: games 1–3 on the first row and games 4–6 directly beneath them. This layout is used consistently in Team A, Both, Team B, single-team, and narrow-card fallbacks. Player names may wrap naturally instead of being forced into a single truncated line, and score numerals and supporting information are slightly larger.

No game status, scoring, projection, roster-window, Firebase, Cloud Function, or Firestore behavior changed. The update is presentation-only.

Run the normal verification command:

```bash
npm run verify:batch7c3
```

After deployment, check Game Center on a wide monitor and near 1,068 pixels. Above 1,180 pixels, both teams remain side by side with more room. At 1,180 pixels and below, the teams stack so every roster card remains readable. Confirm each active player shows games 1–3 above games 4–6 and that all played, missed, upcoming, and unavailable colors remain unchanged.

---

## Batch 8A — Dashboard League Command Cards

### Goal

Turn the Dashboard from a league selector into a restrained daily command center without repeating the same information in multiple places.

### Changes

- Each league card now shows one compact **Next Up** panel.
- The panel chooses one state-specific action:
  - Invite managers / open League HQ
  - Set up the draft
  - Open a scheduled draft
  - Enter a live draft
  - Open the user's active Game Center
  - Review the most recently completed period
- Active matchup cards show the user's score, opponent score, lead/tie/trail state, and combined counted starter-game progress.
- Matchup discovery checks every currently active cycle and selects the user's earliest unfinished matchup. It does not assume one league-wide cycle timestamp.
- The duplicated **Your Club** stat was replaced with the team's record.
- Compact chips appear only when an active starter is unavailable or a roster move is waiting for its slot boundary.
- League names remain direct links to League HQ, so the state-specific primary action does not remove normal navigation.
- Dashboard activity reads are opt-in. Account Settings continues using the lightweight league summary path and does not pay for draft, cycle, matchup, window, or roster reads.
- Dashboard cache version 5 prevents older cached league cards from mixing with the new activity shape.

### Data behavior

- No Firestore rules, Functions, scoring, drafts, rosters, cycles, standings, or playoff documents were changed.
- Activity reads are read-only and fail safely. If a summary cannot load, the league card still opens League HQ.
- Roster progress is calculated from immutable per-slot team-window documents.
- Unavailable starter counts include day-to-day, out, IR, LTIR, suspended, personal-leave, and roster-marked injured assets.

### Verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm ci
npm --prefix functions ci
npm run verify:batch8a
```

The Batch 8A suite adds 11 checks covering draft authority, scheduled/live draft actions, asynchronous matchup selection, score perspective, roster-window progress, compact attention counts, completed-period fallback, opt-in reads, semantic progress, and duplicate-data removal.

### Manual checks

1. Open the Dashboard with a league still forming. Confirm the commissioner and ordinary manager receive appropriate actions.
2. Open a league with a scheduled or live draft. Confirm the primary action goes to the Draft Room.
3. Open an active league and compare the Dashboard score and counted-game progress with Game Center.
4. Confirm the Dashboard follows the earliest unfinished matchup when several cycle numbers remain active.
5. Confirm unavailable starters and queued moves appear only when their counts are greater than zero.
6. Confirm the league name opens League HQ and the team shortcut opens My Team.
7. Check Rink Dark, Light Ice, and a viewport near 390 pixels wide.
8. Confirm no new console errors or horizontal scrolling appear.

---

## Batch 8A.1 — Readable League Names and Around-the-NHL Scoreboard

### Goal

Give league names enough room to remain recognizable and add a lightweight NHL-wide dashboard feature that is separate from each user's fantasy competitions.

### Changes

- League-card badges now sit on their own row instead of competing with the league title for horizontal space.
- League titles use the full identity area and may occupy up to two lines before truncating.
- League-title typography increased slightly while team names remain compact.
- Added a standalone **Around the NHL** scoreboard above My Leagues.
- The scoreboard uses RinkRat's existing server-side NHL proxy and the NHL web score feed at `/v1/score/now`; no browser request is sent directly to the upstream service.
- Live games appear first, followed by the user's favorite-team game, then the remaining games by puck-drop time.
- The panel shows up to six games in a horizontally scrollable strip, including team logos, records, scores, game state, time/period, and available broadcast label.
- During live games the panel refreshes every 30 seconds. Outside live games it refreshes every five minutes.
- NHL scoreboard failures remain isolated from fantasy league loading and never block Dashboard or league actions.
- The proxy caches the shared score response for 15 seconds to prevent every dashboard visitor from creating a separate upstream request.

### Authority and cost behavior

- No Firestore data, league records, scoring records, roster windows, or user profiles are written.
- The NHL feed remains read-only and is shared through the existing `nhlApiProxy` Cloud Function.
- The scoreboard does not add a paid API dependency or an API key.

### Verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm ci
npm --prefix functions ci
npm run verify:batch8a1
```

### Manual checks

1. Confirm league names receive the full card width and display up to two readable lines.
2. Confirm Matchup Active and Commissioner badges appear beneath the identity instead of covering the title.
3. Confirm the Around-the-NHL panel loads independently from fantasy league cards.
4. Confirm future games show a local puck-drop time, live games show period/time remaining, and finished games show Final/OT/SO when applicable.
5. Confirm the favorite-team game is prioritized when no game is live.
6. Confirm Refresh updates only the NHL panel and does not reload league summaries.
7. Confirm the panel scrolls horizontally without causing page-level horizontal overflow on mobile.
8. Confirm a temporarily unavailable NHL feed leaves all fantasy tools usable.

### Deployment

This batch adds the `/v1/score/now` route to the existing NHL proxy, so deploy the proxy Function and hosting:

```bash
firebase deploy --only functions:nhlApiProxy,hosting:app -m "Add NHL dashboard scoreboard and readable league names"
```

---

## Batch 8B — Task-First League HQ Organization

### Goal

Make League HQ read in the same order a manager or commissioner naturally thinks: invite people, take the current action, manage their team, understand league status, review teams, then open less-common management tools.

### Changes

- The league invite code now appears in the top-right priority area beside the league name whenever the pre-draft invite period is open.
- The invite card includes a large readable code, one-click copy action, joined-team count, open-slot label, and semantic fill progress.
- The single top action adapts to league state:
  - Enter Live Draft during a live draft.
  - Draft Setup for a commissioner before draft completion.
  - Draft Room for an ordinary pre-draft manager.
  - My Matchup after the fantasy season begins.
  - My Team while the completed draft is still being converted into the opening cycle.
- The first full-width section is now **League Essentials**. It keeps My Team, Players, Standings, Point Leaders, and Playoffs in a stable manager-friendly order. A commissioner also receives Draft Room before the draft begins, while the state-critical action remains in the header.
- League-specific team name and profile-picture controls moved into a dedicated **Your Team** section rather than expanding the page header.
- Draft status, season status, league format, and the shared injury report are grouped into one **League Overview** area.
- The complete matchup-card list is preserved but moved behind an optional cycle preview. Direct My Matchup and All Matchups buttons remain visible.
- Schedule and projection pages moved into a less-prominent **Schedule and analysis** disclosure.
- Commissioner tools are now separated into:
  - League management: Draft Setup and Player Availability.
  - Technical and testing: Scoring Diagnostics and Release Readiness.
- League deletion remains isolated at the very bottom of the page.

No scoring, draft, roster, cycle, standings, injury, Firebase, Cloud Function, or Firestore authority behavior changed.

### Verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm ci
npm --prefix functions ci
npm run verify:batch8b
```

### Manual checks

1. Open a pre-draft league and confirm the invite code is immediately visible beside the league title.
2. Copy the code and confirm the success message is announced and the code is placed on the clipboard.
3. Confirm joined teams, open spots, and the capacity progress bar match the league.
4. Confirm commissioners see Draft Setup before Draft Room and ordinary managers see Draft Room without commissioner tools.
5. Confirm a live draft prioritizes Enter Live Draft.
6. Confirm an active season prioritizes My Matchup and My Team.
7. Test every League Essentials tile.
8. Rename the team and change the league-specific profile picture from the Your Team section.
9. Expand the cycle matchup preview, Schedule and analysis, and Commissioner tools disclosures.
10. Confirm technical diagnostics remain separated from everyday league management.
11. Check Rink Dark, Light Ice, and a viewport near 390 pixels wide for readable code layout and no horizontal scrolling.
12. Confirm the Danger Zone remains last and still requires the full league-name confirmation.

### Deployment

This batch is frontend-only:

```bash
firebase deploy --only hosting:app -m "Batch 8B task-first League HQ"
```

---

## Batch 8B.1 — League HQ Identity Order and Clear Invite Code

### Goal

Keep league-specific team identity visible before the navigation grid and make invite codes unmistakable when read aloud or copied manually.

### Changes

- The **Your Team Identity** section now appears immediately after the League HQ header and invite card, before **Most-used league pages**.
- The league invite code now uses a system monospaced code font instead of the decorative display font.
- The code uses tabular numerals, a slashed-zero font feature where supported, slightly tighter spacing, and a larger minimum size.
- The copy button and all invite-capacity behavior remain unchanged.

No league, roster, draft, scoring, Firebase, or Firestore behavior changed.

### Manual checks

1. Confirm Your Team Identity appears before League Essentials.
2. Confirm the invite code clearly distinguishes characters such as `0/O`, `1/I`, and `5/S` as well as the available system font permits.
3. Confirm the code remains readable in Rink Dark, Light Ice, and at approximately 390 pixels wide.
4. Confirm Copy Code still places the exact code on the clipboard.

---

## Batch 8C — Free Agents and Decision Center Simplification

### Goal

Make free-agent and waiver decisions easier to scan without removing the deeper six-game-window and scoring information advanced managers rely on.

### Changes

- Free-agent and waiver cards now lead with three primary values:
  - Current season fantasy points
  - Projected points over the next six games
  - Remaining-season projection
- The estimated final total, current six-game cycle number, game markers, fantasy points per appearance, and full scoring-category breakdown remain available under **View cycle status & full stats**.
- The performance indicator, next-cycle rank, waiver priority, and primary Add/Claim action remain visible without expanding the card.
- The desktop card layout was reduced from four dense columns to three clearer regions: identity, decision metrics, and action.
- Tablet and mobile layouts collapse cleanly to one column while preserving the three primary metrics in a compact row.
- The change is presentation-only. Existing add/drop, waiver, IR, queue, eligibility, and asynchronous slot-window rules are unchanged.

### Verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm ci
npm --prefix functions ci
npm run verify:batch8c
```

### Manual checks

1. Search and filter the free-agent pool and confirm results remain unchanged.
2. Confirm each free-agent and waiver card shows Season points, Next 6 games, and Rest of season before expansion.
3. Expand **View cycle status & full stats** and confirm the six game markers, cycle label, estimated final total, per-appearance value, and stat contribution table remain available.
4. Test one legal add/drop and one waiver claim in a disposable league.
5. Confirm performance labels and next-cycle ranks still display.
6. Check desktop, tablet, and approximately 390-pixel mobile layouts for readable names, metrics, and action buttons.
7. Confirm no new console errors or horizontal page scrolling appear.

### Deployment

This batch is frontend-only:

```bash
firebase deploy --only hosting:app -m "Batch 8C Free Agent Decision Center simplification"
```


---

## Batch 8C.1 — Owner-only historical replay controls

The Game Center keeps the preseason historical replay button available without exposing it to ordinary league commissioners.

- The historical **Advance One NHL Day** control is rendered only after the signed-in account is verified through the existing RinkRat platform-admin authority service.
- The server callable independently requires either the platform-admin custom claim or an enabled `platformAdmins/{uid}` record. Hiding the button is not the security boundary.
- A platform administrator can use the replay control in a dedicated test league even when they are not that league's commissioner.
- Ordinary commissioner recovery actions remain commissioner-only.
- No production scoring automation, six-game windows, standings, roster rules, or playoff behavior changed.

Verification command:

```bash
npm run verify:batch8c-owner-controls
```

Deployment requires the updated historical replay Function and hosting:

```bash
firebase deploy --only functions:advanceHistoricalReplayDay,hosting:app -m "Restrict historical replay controls to platform admin"
```



## Batch 8D — Streamlined Game Center and owner-only testing tools (clean rebuild)

This batch was rebuilt from the approved Batch 8C.1 baseline as one clean update rather than stacking the earlier patch and test correction.

- Removed the embedded six-game cycle explainer from Game Center. Training Camp, Ask Coach, and the scoring guide remain the dedicated educational surfaces.
- Deleted the unused explainer component and its Game Center CSS, reducing dead frontend code and lowering the Game Center component-style bundle.
- Restricted the complete Game Center Testing Controls panel to verified platform administrators. Ordinary commissioners and managers no longer see replay, test-email, manual score-refresh, cycle-finalization, next-period, or projection-validation controls.
- Restricted Scoring Test Lab, Live Scoring Diagnostics, Release Readiness, Cycle Simulator, and Playoff Window Simulator routes to the platform-admin guard.
- Hid League HQ technical/testing links from ordinary commissioners while preserving normal draft, availability, invitation, team-management, and league-deletion controls.
- Replaced the brittle whole-template hash test with structural regression checks so approved Game Center changes no longer create false failures.
- No automatic scoring, roster, draft, waiver, cycle, standings, playoff, or scheduled server behavior changed.

Verification command: `npm run verify:batch8d`.

---

## Batch M1 — Mobile Readability and Adaptive Navigation

### Goal

Make the primary phone experience readable and easy to navigate during every league phase without changing scoring, six-game windows, roster rules, Firestore data, Cloud Function authority, or the approved desktop information architecture.

### Adaptive mobile navigation

The second bottom-navigation destination now follows the signed-in manager's real league state:

| League state | Mobile destination | Route behavior |
| --- | --- | --- |
| Draft not yet scheduled (`setup`) or draft state still loading | **League** | Opens League HQ. |
| Draft scheduled or live | **Draft** | Opens the league Draft Room directly. |
| Draft complete and an owner matchup is available | **Matchup** | Opens that exact cycle and matchup. |
| Draft complete but no owner matchup exists yet | **League** | Uses League HQ as a safe fallback while initialization finishes. |

The matchup listener intentionally uses `listenToEarliestUnfinishedOwnerMatchup`. It searches across all active fantasy periods for the signed-in owner instead of assuming one league-wide cycle timestamp. This preserves RinkRat's asynchronous six-game roster-slot architecture when different NHL schedules cause multiple fantasy periods to overlap.

`/leagues/create` and `/leagues/join` are explicitly excluded from league-ID detection. League HQ remains directly available in the **More** menu even while Draft or Matchup occupies the adaptive tab.

### Shared phone readability scale

The design-token layer now provides one restrained mobile scale:

- Essential microcopy: 12px minimum.
- Labels and controls: 13px.
- Body copy: 14px.
- Player names: 15px.
- Matchup scores: responsive 28–40px.
- Frequent action targets: 44px minimum.

The pass applies these tokens to the mobile bottom navigation and the six highest-use league surfaces:

- Dashboard
- League HQ
- Draft Room
- Game Center
- My Team
- Free Agents

Repeated utility cards use lighter one-pixel borders, smaller mobile padding, and calmer radii where appropriate. On phones at 430px or narrower, the decorative team ribbon keeps the logos but hides the redundant abbreviations and reduces its height. No desktop Game Center redesign or M3–M5 task-flow restructuring is included in this batch.

### Automated verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm ci
npm --prefix functions ci
npm run verify:batchm1
```

The M1 suite verifies:

- Reserved create/join routes are not interpreted as league IDs.
- Setup, scheduled, live, and complete draft states resolve to the correct mobile destination.
- A completed draft routes to the exact owner matchup when one exists.
- Navbar state is backed by the real draft and cross-active-cycle owner-matchup listeners.
- The shared 12px essential-text floor and 44px frequent-action target exist.
- Dashboard, League HQ, Draft Room, Game Center, My Team, and Free Agents include their M1 mobile contracts.
- The narrow-phone decorative ribbon reduction remains in place.

### Manual mobile checklist

Run the following checks in portrait at **320px, 360px, 390px, and 430px**, with mobile Safari and mobile Chrome represented before beta release.

1. **Global navigation:** Confirm Home, the adaptive League/Draft/Matchup tab, Team, Players, and More remain visible above the safe area without horizontal scrolling. Confirm `/leagues/create` and `/leagues/join` show the non-league navigation.
2. **Pre-draft:** Confirm the second tab reads League during setup, changes to Draft when scheduled or live, and opens the Draft Room directly.
3. **Active season:** Confirm the second tab reads Matchup and opens the signed-in owner's earliest unfinished matchup even when roster-slot windows span overlapping periods. Confirm League HQ remains available in More.
4. **Dashboard:** Confirm league names, state, score, matchup progress, attention chips, and the primary action are readable without zooming.
5. **League HQ:** Confirm invite, copy, team identity, quick actions, injury refresh, rename, and profile controls are readable and the frequent controls are at least 44px high.
6. **Draft Room:** Confirm turn state, clock, player names, queue rows, filters, Auto Draft, and Draft actions are readable and comfortably tappable.
7. **Game Center:** Confirm both team names, scores, projections, readiness copy, player names, current points, and game markers 1–6 remain legible. Confirm no desktop hierarchy or scoring behavior changed.
8. **My Team:** Confirm roster names, scores, injury state, transactions, Add/Drop, IR, bench, and confirmation controls are readable and easy to tap.
9. **Free Agents:** Confirm search/filter fields, player cards, Season/Next 6/Rest of Season metrics, cycle markers, Add/Claim actions, slot comparison, and the confirmation dock remain readable. Test one legal add/drop and one waiver claim in a disposable league.
10. **Themes and accessibility:** Repeat representative screens in Rink Dark, Light Ice, and OLED Black. Check reduced motion, keyboard focus where available, 200% browser text zoom, and the iPhone home-indicator safe area.
11. **Stability:** Confirm no new console errors, clipped dialogs, accidental double actions, or horizontal page scrolling appear at any required width.

### Deployment

This batch changes the frontend, documentation, and local verification only. It does not require Firestore rule, index, or Cloud Function deployment.

```bash
npm run build
firebase use nhl-fantasy-app-ab673
firebase deploy --only hosting:app -m "Batch M1 mobile readability and adaptive navigation"
```

---

## Batch M2 — Beginner Language and Neutral Onboarding

### Goal

Make RinkRat welcoming to managers who do not know much about hockey while preserving the exact competitive system experienced managers already use. This batch changes onboarding, terminology, explanations, and profile presentation. It does **not** change scoring values, roster authority, draft logic, waivers, standings, playoff advancement, NHL game ingestion, or the asynchronous six-game roster-slot model.

### Neutral RinkRat identity

A first-class neutral identity is now available under the stable abbreviation `RR`.

- New accounts begin with **No favorite yet — Use neutral RinkRat colors** selected.
- Choosing an NHL favorite is optional during registration and remains editable from Account Settings.
- The neutral palette uses the RinkRat mascot and the colors `#26384C`, `#D6E2EE`, and `#C94F5D`, with `#74B9DF` as the accessible accent.
- `RR` participates in the same theme and public-manager-profile paths as NHL abbreviations, so the UI never has to store an empty or invalid team value.
- The decorative login marquee remains NHL-only; `RR` is a profile identity, not an NHL club.
- Missing or invalid favorite-team values now fall back to `RR` rather than silently presenting a Vegas identity.

The private user profile and display-safe public profile both allow `RR`. Public profiles still contain only the manager name, identity abbreviation, identity variant, and update timestamp.

### Hockey-familiarity preference

Registration and Account Settings now offer three explanation levels:

| Stored value | Manager choice | Presentation behavior |
| --- | --- | --- |
| `new` | **New to hockey** | Shows fuller labels and additional plain-language context. |
| `basic` | **I know the basics** | Uses familiar abbreviations with definitions one tap away. |
| `experienced` | **Experienced fan** | Uses the most compact labels while retaining glossary access. |

The private profile field is `hockeyExperience`. It is validated as `new`, `basic`, or `experienced`; it is never copied into `publicProfiles`. The browser also stores the active level under `rinkrat-hockey-experience` so glossary labels can render correctly before or between profile reads. This setting affects explanation density only and never changes scoring or league rules.

### Contextual hockey glossary

The reusable `app-hockey-term` control provides a labelled, keyboard-accessible definition popover. It exposes expanded state with `aria-expanded` and `aria-controls`, closes with its Close button or Escape, and uses a non-modal labelled region so ordinary page focus is preserved.

The launch glossary covers:

- `LW` — Left Wing
- `C` — Center
- `RW` — Right Wing
- `D` — Defenseman
- `G` — Team Goalie Unit
- `SOG` — Shots on Goal
- `BLK` — Blocked Shots
- `PPP` — Power-Play Points
- `SHP` — Short-Handed Points
- `SV%` — Save Percentage
- `TOI` — Time on Ice
- `GWG` — Game-Winning Goal
- `IR` — Injured Reserve
- `Pts/Game` — Fantasy Points per Game

Definitions are available contextually in Training Camp and the Scoring Guide, and the complete list is available through Coach Help.

### Beginner-first language

Primary manager screens now prefer the language below:

| Previous engineering-oriented label | Manager-facing label |
| --- | --- |
| Asset | Player or goalie unit |
| Active asset | Starter |
| Current asset | Current player |
| Incoming asset | New player |
| Available Assets | Available Players |
| Asset window | This roster spot's six games |
| Cycle 3 | Matchup 3 |
| Cycle total | Matchup total or six-game total |
| Next-cycle projection | Next 6 Games |
| Cycle boundary | After this roster spot finishes its six games |
| Queued move | Scheduled move |
| IR | Injured Reserve (IR) when first introduced |

The pass covers registration, Account Settings, Training Camp, the Scoring Guide, Coach Help, Dashboard, League HQ, standings, join/setup/draft screens, Game Center, matchup details, My Team, Free Agents, player details, projections, leaders, playoffs, and support copy.

Platform-administrator diagnostics and simulators intentionally retain internal terms where they describe implementation state rather than manager instructions.

### Internal compatibility preserved

Firestore collections, TypeScript models, transaction records, Cloud Function contracts, and asynchronous six-game calculations still use the established `cycle`, `asset`, and `window` names. In particular:

- Historical transaction records continue to use labels such as `Cycle N` where compatibility requires them.
- Each roster slot still owns an independent immutable six-game window.
- A slot's seventh scheduled NHL team game still belongs to its next window even when other slots remain in the prior matchup.
- Matchups, projections, roster moves, and playoff backfill continue to resolve across overlapping fantasy periods.

No data migration is required.

### Backend compatibility

This batch updates both browser and server validation:

- Firestore private-profile validation accepts `RR` and the optional `hockeyExperience` field.
- Firestore public-profile validation accepts `RR` but rejects private familiarity data.
- The safe public-manager-profile callable accepts `RR` and uses it as the fallback for missing or invalid identity data.
- Existing NHL identities and accounts without `hockeyExperience` remain valid.
- Firestore indexes are unchanged.

### Automated verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm ci
npm --prefix functions ci
npm run verify:batchm2
npm run build:all
```

The M2 suite verifies:

- Neutral `RR` identity behavior and NHL-ribbon separation.
- Familiarity normalization, browser persistence, and private-profile boundaries.
- All 14 launch glossary terms and accessible popover controls.
- Optional favorite-team registration and Account Settings behavior.
- Firestore and Cloud Function compatibility for `RR` and familiarity values.
- Beginner-first copy across primary manager templates.
- Preservation of internal cycle labels required by existing transaction data.
- All earlier mobile, accessibility, design-system, authority, and release-facing contracts.

The Firestore emulator suite additionally checks that:

- A manager can save `RR` plus a supported familiarity level.
- An unsupported level such as `expert` is rejected.
- A display-safe public profile can use `RR` without exposing familiarity.

### Manual checklist

1. Create a new account and confirm **No favorite yet** is selected by default.
2. Create accounts with each familiarity level and confirm registration reaches Training Camp normally.
3. Confirm a neutral account uses RinkRat colors, mascot art, and `RR` identity wherever a manager identity is shown.
4. Select an NHL team during registration and confirm its theme still applies normally.
5. In Account Settings, switch between neutral colors and multiple NHL teams; reload and confirm the choice persists.
6. Change Hockey Familiarity, save, reload, and confirm the saved level remains selected.
7. Confirm familiarity never appears in another manager's public identity or league member display.
8. With **New to hockey** selected, check that contextual glossary controls use fuller labels where supported.
9. Open every glossary term from Training Camp and the Scoring Guide; verify button activation, Escape, Close, focus visibility, mobile placement, and screen-reader labels.
10. Open Coach Help and confirm all 14 glossary definitions are present.
11. Review Dashboard, League HQ, Draft Room, Game Center, My Team, Free Agents, standings, leaders, and projections for manager-facing `asset`, `cycle`, or `queued move` jargon.
12. Complete one legal add/drop, one waiver claim, one bench swap, and one Injured Reserve move to confirm only the wording changed.
13. Confirm scheduled moves still activate only after the affected roster spot completes its six counted games.
14. Confirm a live matchup with overlapping roster-slot periods still opens, scores, and advances normally.
15. Repeat representative screens at 320px, 390px, and desktop width in Rink Dark, Light Ice, and OLED Black.
16. Check keyboard navigation, 200% text zoom, reduced motion, console output, horizontal scrolling, and public-profile fallback behavior.

### Staged deployment

Because the new client writes `RR` and `hockeyExperience`, deploy the backward-compatible server and rule support **before** Hosting:

```bash
firebase use nhl-fantasy-app-ab673

firebase deploy --only functions:getPublicManagerProfiles -m "Batch M2 neutral onboarding compatibility"
firebase deploy --only firestore:rules -m "Batch M2 neutral profile and familiarity validation"
firebase deploy --only hosting:app -m "Batch M2 beginner language and neutral onboarding"

# Smoke-test registration, Account Settings, public manager identity,
# Training Camp, Game Center, My Team, and Free Agents.
```

No Firestore index deployment is required.

### Rollback guidance

The safest rollback is to redeploy only the approved Batch M1 Hosting build while leaving the M2 Functions and Firestore rules in place. Those server changes are backward-compatible and continue to protect any profile that has already saved `RR` or `hockeyExperience`. Revert the M2 Functions or rules only after confirming no such profiles remain, or after the older client/server has been updated to tolerate those values. No scoring, roster, transaction, or matchup data requires rollback or migration.

---

## Batch M2.1 — Asynchronous Roster-Slot Rollover and Scheduled-Move Recovery

### Incident corrected

The historical **Advance One Day** control could return HTTP `503` exactly when a roster slot completed its sixth counted NHL game and had a scheduled add/drop or bench swap waiting for its next six-game window.

The regular-season lifecycle was already designed to open the next matchup asynchronously for each completed roster slot. The failure occurred inside the atomic Firestore transaction that both:

1. creates that slot's Matchup N+1 snapshot,
2. activates its scheduled roster move,
3. updates the authoritative roster and waiver records, and
4. records the activation in the league transaction log.

The shared browser-shaped Firestore compatibility layer used by Cloud Functions supported `doc(collectionRef, explicitId)` but incorrectly rejected `doc(collectionRef)`, which is the valid auto-ID overload used by transaction-log writes. When the first scheduled move reached its boundary, that helper threw before the transaction could commit. `advanceHistoricalReplayDay` converted the uncaught server error to `unavailable`, which appeared in the browser as HTTP `503`.

Because the Firestore operation is atomic, the exception rolled back both the roster move and the new Matchup N+1 roster-slot window. This made the site look as though it was waiting for every player in the league to finish six games, even though there was no intended league-wide completion gate in the asynchronous rollover path.

### Corrections

#### 1. Cloud Functions auto-ID compatibility

`functions/src/shared/core/firebase-admin-compat.ts` now implements the browser Firestore SDK's zero-segment collection overload:

```ts
doc(collectionReference)
```

It delegates to the Admin SDK's `collectionReference.doc()` method. Explicit IDs continue to work unchanged. This repairs regular-season scheduled-move activation and the equivalent playoff-window transaction-log path.

#### 2. Independent six-game rollover remains authoritative

`advanceCompletedRegularSeasonAssetWindows` continues to inspect completed roster-slot windows rather than waiting for every roster slot or every team. As soon as one slot completes its sixth counted game:

- Matchup N+1 may be created with `overlapsPreviousCycle: true`.
- Only that completed slot receives its next immutable snapshot.
- Its next scheduled NHL team game counts in Matchup N+1.
- Slower roster slots remain in Matchup N until their own sixth game is complete.
- A scheduled move for that slot activates in the same transaction as its next-window snapshot.

No league-wide start date, league-wide completion timestamp, or all-rosters-complete gate was added.

#### 3. Self-healing for a Matchup 2 already opened with the old roster

`reconcilePendingRosterMovesForRegularSeasonCycle` repairs an active regular-season period that already contains a roster-slot snapshot but still has a ready scheduled move on the authoritative roster.

The repair is deliberately slot-specific:

- The exact roster slot must already have a snapshot in the active target matchup.
- The move's requested effective matchup must be reached.
- The target snapshot must have been created at or after the move was queued. A current-window snapshot that predates the reservation is never treated as a recovery target, so the move cannot activate before that slot's six-game boundary.
- A faster slot can be repaired without advancing a slower slot.
- The current outgoing player and any reserved bench player are revalidated inside a Firestore transaction.
- The incoming player becomes active, the outgoing player moves to the correct bench or waiver destination, the pending reservation is cleared, and the target matchup snapshot is replaced.
- Transaction history records the recovery source.
- One manager's roster is processed independently so a malformed reservation does not require unrelated managers to be rewritten in the same recovery transaction.

Server scoring runs this reconciliation before loading target-matchup picks. The commissioner manual next-period callable also runs it before returning. Therefore an existing test league does not need Matchup 2 deleted and does not need its scheduled moves recreated.

#### 4. Score-cache identity guard

A repaired roster slot retains its immutable roster-slot window ID but changes from the incorrectly snapshotted outgoing player to the scheduled incoming player. Both the server and browser scoring services now reuse a prior `windowScores[windowId]` entry only when its `assetKey` matches the currently snapshotted asset.

This prevents the incoming player from inheriting the outgoing player's completed games or fantasy points. If the asset keys differ, scoring falls back only to a cache entry belonging to the incoming player and then recomputes from that player's NHL game ledger.

#### 5. Historical replay retries the failed date

Older builds wrote the attempted replay date before scoring and then returned `503`. Pressing **Advance One Day** again could otherwise skip that failed date. The replay control now records `lastFailedSimulatedDate` and retries the same simulated NHL date after an error.

For a legacy error document created before this field existed, an `error` status with a saved simulated date is treated as a failed-date retry once. Retry behavior does not double-increment `daysAdvanced` or `totalReleasedGameCount`.

### Existing-league recovery procedure

After deploying Batch M2.1:

1. Leave the existing Matchup 2 document and scheduled roster moves in place.
2. Open the same test league as the verified platform administrator.
3. Press **Advance One Day** once.
4. The failed simulated NHL date is retried rather than skipped.
5. Before scoring, ready scheduled moves are reconciled into the Matchup 2 snapshots that already exist.
6. Confirm the new players are active on the roster and appear in their correct Matchup 2 roster slots.
7. Confirm dropped players are on waivers, or on the bench for a scheduled active/bench swap.
8. Confirm players still finishing Matchup 1 remain there until their own sixth counted game is complete.
9. Advance until one repaired incoming player reaches a game and confirm only that player's NHL games and points appear in the repaired window.

A move is skipped rather than forced if its outgoing player, incoming reservation, or reserved bench slot was manually changed after it was queued. This protects the current roster from an unsafe automatic overwrite.

### Automated verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm ci
npm --prefix functions ci
npm run verify:batchm2-1
npm run build:all
```

The focused hotfix suite verifies:

- Admin Firestore auto-ID document support.
- Per-slot regular-season rollover without an all-rosters-complete gate.
- Scheduled-move activation in the same transaction as next-window assignment.
- Self-healing of a previously opened target matchup.
- Reconciliation before server scoring loads target-matchup picks.
- Reconciliation from the manual next-period recovery path.
- Asset-identity validation before prior window scores are reused.
- Same-date retry after a historical replay failure.

### Deployment

This batch changes Cloud Functions and the browser scoring mirror. It does not change Firestore rules or indexes.

```bash
firebase use nhl-fantasy-app-ab673
firebase deploy --only functions -m "Batch M2.1 asynchronous rollover and scheduled move recovery"
firebase deploy --only hosting:app -m "Batch M2.1 scoring cache identity guard"
```

Deploy Functions before pressing **Advance One Day** again. Hosting may be deployed immediately afterward. No data migration, rules deployment, or index deployment is required.

### Rollback guidance

Do not roll back the Functions fix after it has repaired a queued move unless the replacement build also supports auto-ID transaction records and the same per-slot rollover behavior. The repair writes ordinary roster, waiver, cycle-pick, and transaction documents that remain compatible with Batch M2. A Hosting-only rollback is safe because the server remains authoritative, but keeping the browser score-cache identity guard is recommended for consistent client-side displays.
