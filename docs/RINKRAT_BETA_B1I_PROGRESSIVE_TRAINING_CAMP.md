# RinkRat Beta Batch B1I — Progressive Training Camp and Position Help

**Runtime release:** Release Candidate 64

**Deployment scope:** Hosting only

**Protected baseline retained:** RC62 Firestore Rules and Functions, Production Scoring V4, Projection V11, immutable six-game windows, seventh-game rollover, Draft/roster/waiver authority, App Check Monitor, Scoring Queue Shadow, and Shared NHL Cache Shadow

## Why this batch exists

The first observed beginner session confirmed that Training Camp was organized but still felt like a wall of instructions. The manager had to decide what to read first, found the six-game matchup explanation difficult to absorb, and saw position-definition panels overlap or extend beyond the visible board.

B1I turns that feedback into a focused onboarding pass. Training Camp now teaches one focused drill at a time, asks the manager to make a small decision, and reveals the next part only after the current idea is understood. Position help is coordinated and viewport-safe so a definition can never become a stack of competing panels.

## Progressive Training Camp

Training Camp is organized into five shifts with two drills per shift:

1. **Six Games** — one active roster spot counts exactly six NHL games; Game 7 starts that spot’s next matchup.
2. **Your Roster** — active slots, bench/IR depth, and the different scoring jobs of forwards, defensemen, and the Team Goalie Unit.
3. **Roster Moves** — immediate changes before a spot starts and scheduled changes after counted games must be protected.
4. **Player Cards** — Next 6 projection, supporting context, and played/upcoming/missed game markers.
5. **Season Flow** — completed matchups update standings and feed the playoff bracket automatically.

Only the current drill is displayed. Each shift’s second drill includes a short **Coach Challenge**. A correct answer unlocks the next shift; an incorrect answer gives immediate plain-language feedback and allows another attempt. Previously cleared shifts remain available for review.

The page also provides:

- a five-shift progress rail;
- a ten-drill completion percentage;
- clear locked, ready, and cleared states;
- session-scoped progress recovery after an ordinary reload;
- keyboard-focus movement to the newly opened drill heading;
- a reduced-motion path that removes nonessential transitions.

Training Camp completion authority remains server-backed. Browser progress is only a convenience and cannot mark the account complete.

## Plain-language six-game explanation

The primary rule is now introduced as:

> Each active roster spot gets six NHL games. Those six games make that spot’s score for the matchup.

The follow-up rule is:

> After a spot counts six games, its next NHL game starts that spot’s next matchup. Other spots keep finishing their own six.

The visual uses two independent counters so beginners can see that one roster spot may reach Game 7 while another is still completing Games 5 and 6. No completed six-game score is reopened or rewritten.

## Position teaching and fantasy-football comparison

The roster shift first shows the active lineup and lets the manager request a definition for LW, C, RW, D, or the Team Goalie Unit. The next drill separates the three scoring personalities:

- forwards provide larger scoring swings and upside;
- defensemen create a steadier workload-based floor;
- the Team Goalie Unit generally produces the largest raw total.

The familiar fantasy-football comparison remains available, but it is now an optional collapsed teaching tool instead of another block competing for attention. Managers who already understand the hockey roles can continue without reading it. Beginners can open the WR, RB, and QB mental model when it helps.

## RC65 viewport-portal correction

The original fixed-position implementation correctly clamped coordinates but remained nested under animated route and lesson surfaces. Because transformed ancestors can redefine the containing block for fixed descendants, a later desktop/mobile playtest exposed a large horizontal offset. RC65 B1J.2 portals the existing definition node to `document.body` without modal scroll locking, preserving Angular bindings and theme variables while making its fixed coordinates truly viewport-relative.

## One-at-a-time, viewport-safe definitions

All `app-hockey-term` chips now share one application-level coordinator. Opening a new definition closes the previous definition automatically.

The active panel:

- is positioned from the selected trigger;
- clamps its width and horizontal position to the current viewport;
- opens above the trigger when there is more usable room there;
- receives a bounded maximum height and scrolls internally when needed;
- repositions after viewport resize or page scroll;
- closes from its Close button, Escape, or an outside pointer action;
- returns keyboard focus to the originating trigger after an explicit close or Escape;
- becomes a fixed bottom sheet on narrow mobile screens.

This removes the overlapping-panel defect and prevents edge positions such as Defense or Team Goalie Unit from being cut off by the Training Camp board.

## Training-first verification and invitations remain authoritative

B1I changes presentation only. It preserves the RC62 onboarding order:

```text
Invite Link
→ Create Account
→ Training Camp completed or explicitly deferred
→ Verification email released
→ Verified account
→ Existing joinLeagueSecure transaction
```

**Finish Later & Verify** remains an explicit, separate outcome and does not falsely award Training Camp completion. A pending league invitation remains bounded and account-bound, and final membership still requires the verified-email-protected server transaction.

## Numeric typography boundary

Number-bearing Training Camp controls, counters, scores, percentages, ranks, and values use the readable UI font with tabular numerals rather than the pixel display face. This is a local fix for the observed onboarding surface. The site-wide score/date/rank/form typography and copy-density review remains separately tracked as B1.37.

## Exact local release gate

Use the pinned toolchain from the extracted project root:

```bash
nvm install 22.23.1
nvm use 22.23.1
npm install -g npm@11.17.0

npm ci
npm --prefix functions ci
npm run verify:batchb1i
```

Do not deploy if any part of the gate fails.

## Deployment

B1I changes browser code and documentation only. After the exact gate passes, deploy Hosting:

```bash
firebase deploy --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Beta B1I Progressive Training Camp Release Candidate 64"
```

Do not include Functions, Firestore Rules, indexes, or TTL policies. Keep the proven RC62 account-email Functions and private Training Camp fields live.

## Required browser matrix

Validate the deployed build with fresh accounts and previously completed accounts in desktop Chrome, desktop Safari, iPhone Safari, and Android Chrome.

For each supported path, confirm:

1. Only one drill’s primary explanation is visible at a time.
2. A wrong Coach Challenge answer gives feedback without unlocking the next shift.
3. A correct answer unlocks the next shift.
4. Reloading restores the latest unlocked shift without granting server completion.
5. Every position chip opens one—and only one—definition.
6. Rapidly selecting LW, C, RW, D, and Team Goalie Unit never leaves stacked panels.
7. Edge panels stay fully visible or scroll internally on small windows.
8. Escape, outside click/tap, and Close dismiss the panel; explicit keyboard close restores focus.
9. The fantasy-football comparison begins closed and remains readable when opened.
10. Completing all ten drills saves genuine completion, releases verification, and resumes a pending invitation.
11. **Finish Later & Verify** saves only the deferral outcome, releases verification, and resumes the same invitation.
12. Reopening Training Camp after genuine completion allows review without losing the completed state.

## Rollback

A B1I rollback is a Hosting rollback from RC64 to the known-good RC63 browser. Retain the separately proven RC62 Firestore Rules and Functions. A browser rollback must not rewrite manager profiles, pending invitations, league membership, matchup windows, Draft state, scoring output, or projection snapshots.
