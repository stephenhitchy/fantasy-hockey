# RinkRat Beta Batch B1H — Navigation Reliability and Primary Actions

**Runtime release:** Release Candidate 63  
**Competition baseline:** Production Scoring V4 / Projection V11  
**Deployment scope:** Hosting only

## Why this batch exists

The first observed friend playtest showed that RinkRat's individual pages were usable, but a new manager could still lose their place:

- the most important destinations did not always look different from secondary tools;
- several corner return links went to a fixed League HQ or dashboard destination instead of the page the manager had actually left;
- signed-in Support could return to the root sign-in screen;
- public scoring, fairness, calculator, policy, and support pages did not share the normal navigation shell;
- Draft auto-entry could appear stuck on Safari or a slower connection without a second way into the room; and
- My Team navigation was too compact for a first-time manager.

B1H addresses that navigation and recovery layer before changing Training Camp content itself. The progressive tutorial, position-help overlay, numeric typography, copy-density, and Safari unlock-notification follow-ups are tracked separately as B1.35–B1.38.

## Persistent navigation shell

The authentication-aware RinkRat navbar now appears on:

- signed-in league and account pages through the existing main layout;
- the sign-in and registration page;
- the public league-invitation page;
- Support, Service Status, Known Issues, Commissioner Guide, Fairness Report, Scoring Guide, Scoring Calculator, Privacy, and Terms through one public-resource layout.

Signed-in managers see their remembered/current league destinations. Signed-out visitors receive public scoring, calculator, fairness, support, and sign-in destinations without attempting member-only reads.

The desktop and mobile navigation both give stable icons and stronger visual priority to the live destinations a manager is most likely to need:

- Current Matchup or Draft Room, depending on league state;
- My Team; and
- Add / Drop.

## History-aware return behavior

Corner return controls now use one session-scoped in-app navigation history coordinator. A manager who opens Add / Drop from My Team and then presses **Back** returns to My Team rather than being forced to League HQ.

The coordinator:

- records successful internal Angular routes;
- follows browser back/popstate changes without duplicating the stack;
- ignores modified clicks, new tabs, downloads, and external links;
- retains each page's safe route as a fallback when no earlier in-app destination exists; and
- stores only a bounded session history.

League invitation URLs are never written to that session history. Invite codes are short-lived credentials and remain excluded even when query strings or fragments are present.

Support now falls back to `/dashboard`, so a signed-in manager is not returned to the root authentication screen. A signed-out visitor who opened Support directly is still safely handled by the normal dashboard authentication guard.

## Clearer primary actions

Manager-facing labels and buttons now use the destination name rather than an internal product-area name:

- Dashboard: **Open Current Matchup** instead of **Open Game Center**;
- League HQ: **Open Current Matchup**;
- My Team: **Open Current Matchup**.

Dashboard league actions, the My Team shortcut, League HQ matchup controls, My Team navigation, and the persistent navbar include stable icons so the same destination is visually recognizable across pages.

## My Team navigation and copy reduction

The My Team quick-action block now uses larger, full-label buttons in a responsive grid. It keeps:

- League HQ;
- Add / Drop Player;
- Open Current Matchup;
- All Current Matchups;
- Full Schedule; and
- League Standings.

Projection Lab is removed from this high-priority navigation block. The route itself is not deleted and remains available to the intended testing/admin surfaces.

League HQ's Daily Injury Report no longer displays the low-value **Last updated** timestamp. Commissioner-only refresh recovery remains available when the daily report has not run.

## Draft entry recovery

When a commissioner starts a Draft, the confirmation dialog now provides **Open Draft Room** immediately while retaining automatic entry. If routing takes longer than expected, it reveals **Reload & Open Draft Room**, which performs a direct page navigation and gives Safari or a slower browser a fresh connection.

The Draft Room also has its own first-load recovery. After eight seconds of unresolved loading, the page reveals **Reload Draft Room** rather than leaving the manager on an indefinite “joining” message.

These are recovery paths, not alternate Draft authority. Draft membership, picks, timers, queues, and server-authoritative actions remain unchanged.

## Exact verification

Use the pinned toolchain:

```bash
nvm install 22.23.1
nvm use 22.23.1
npm install -g npm@11.17.0
npm ci
npm --prefix functions ci
npm run verify:batchb1h
```

The B1H gate inherits the complete B1G chain and adds checks for:

- actual previous-page resolution and browser-popstate reconciliation;
- invite-link exclusion from session navigation history;
- the global safe-fallback Back coordinator;
- persistent navigation on public, sign-in, invitation, and authenticated routes;
- stable icons and priority styling for Current Matchup/Draft, My Team, and Add / Drop;
- the **Open Current Matchup** wording;
- larger My Team navigation and removal of Projection Lab from its quick actions;
- removal of the daily injury timestamp;
- Draft automatic-entry timeout and manual/direct-reload recovery; and
- the protected Scoring V4, Projection V11, six-game, App Check Monitor, queue Shadow, and cache Shadow baseline.

## Deployment

After the exact gate passes:

```bash
firebase deploy --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Beta B1H Navigation Reliability Release Candidate 63"
```

RC62 B1G's Firestore Rules and account-email Functions must already be live and remain unchanged. Do not deploy Functions, Rules, indexes, or TTL policies for B1H.

## Required browser matrix

Before accepting B1H as deployed evidence, verify at minimum:

1. From My Team, open Add / Drop and use the corner Back control; confirm it returns to My Team.
2. Repeat from League HQ, Current Matchup, Standings, Schedule, Player Intel, Scoring Guide, Support, and Fairness Report.
3. Open Support while signed in and confirm Back does not show the sign-in screen.
4. Open Support and the public scoring resources while signed out and confirm the public navbar remains usable.
5. Confirm the navbar appears on sign-in/registration and `/join/:inviteCode` without exposing league details before authentication.
6. Confirm Current Matchup, My Team, and Add / Drop are easy to identify on desktop and mobile.
7. Confirm My Team buttons remain readable at desktop, tablet, and narrow-phone widths.
8. Start a Draft and use the immediate **Open Draft Room** button.
9. Simulate or observe a slow route and confirm **Reload & Open Draft Room** appears.
10. Simulate or observe a slow Draft Room load and confirm **Reload Draft Room** appears after eight seconds.
11. Repeat the highest-risk navigation and Draft paths in desktop Safari and iPhone Safari.
12. Re-run the RC62 no-early-email, Training Camp completion, Finish Later, verification, and invitation-continuation paths to confirm B1H did not regress them.

## Protected baseline

B1H changes no Function source, Firestore Rule, index, TTL policy, migration, scoring formula, Projection V11 calculation, immutable six-game window, seventh-game rollover, Draft/roster/waiver authority, App Check Monitor setting, scoring-queue Shadow setting, or shared NHL-cache Shadow setting.
