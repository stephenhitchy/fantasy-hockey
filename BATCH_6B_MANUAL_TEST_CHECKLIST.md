# RinkRat Batch 6B Manual Test Checklist

## Purpose

Batch 6B changes Game Center presentation only. It does not change scoring, roster windows, draft data, Firestore rules, Cloud Functions, or cycle advancement.

Use an existing started league with real drafted rosters. A league that already contains completed NHL games is best because it lets you compare the new totals with known data.

## 1. Automated verification

Run:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm ci
npm --prefix functions ci
npm run verify:batch6b
```

Expected:

- 44 Firestore rules tests passed
- 7 draft-authority tests passed
- 2 league-onboarding tests passed
- 4 competition-authority tests passed
- 7 profile/injury authority tests passed
- 7 Game Center structural tests passed
- 11 Game Center hierarchy/behavior tests passed
- Angular production build completed
- Functions TypeScript build completed

Total: **82 named tests**.

Stop if any test or build fails.

## 2. Desktop Game Center

Open your own current matchup at a desktop width.

Confirm:

- A new matchup overview appears before the detailed lineups.
- It says **You lead by**, **You trail by**, or **Your matchup is tied**, as appropriate.
- The two large current scores match the scores shown in the detailed team panels.
- “Projected finish” matches the existing projected totals.
- Projection wording is an estimate stage, not a percentage or guarantee.
- “Matchup progress” equals both teams' counted games combined.
- Each team row shows `played of total counted · left`.
- Both progress bars match the detailed team progress bars.
- Bench players are not added to counted-game totals.
- The readiness badge says something like `53 Starter Games Left` instead of `Waiting on 53 roster games`.

## 3. Perspective checks

Use available test matchups to verify:

- Your team ahead → `You lead by X.X`.
- Your team behind → `You trail by X.X`.
- Tied matchup → `Your matchup is tied`.
- Completed win → `You won by X.X`.
- Completed loss → `You lost by X.X`.
- A matchup you are only viewing → the leading team name is used instead of “You.”
- A bye matchup, if available → it identifies the bye without inventing an opponent score.

## 4. Asynchronous window regression

Confirm the existing behavior remains unchanged:

- Each starter still has its own six numbered game markers.
- Played, missed, upcoming, and unavailable markers remain correct.
- A player whose next window has not started still shows the pending-window message.
- Different players can show different numbers of games completed.
- A seventh NHL team game is not added to the prior six-game window.
- Detailed player cards still open.
- Bench cards still open and still show that bench assets do not score.

## 5. Mobile test

Test around 390 pixels wide and at a normal phone width.

Confirm:

- The sticky matchup scorebar remains visible while scrolling.
- Each team shows current score, projected score, a small progress bar, and `played/total counted`.
- The center status is concise, such as `53 left`, `Updating`, `Finalizing`, or `Final`.
- Team names truncate cleanly rather than pushing the scorebar wider than the screen.
- The new overview does not repeat the large desktop score cards on mobile.
- The overview headline, projected finish, progress, and team bars fit without horizontal scrolling.
- The mobile head-to-head roster still appears below it.
- Player names and score columns remain readable.

## 6. Theme and motion test

Check at least:

- Rink Dark
- Light Ice
- Your normal favorite-team colors

Confirm the overview headline, insight cards, progress text, and bars are readable.

With reduced motion enabled, progress fills should not animate.

## 7. Accessibility spot-check

In browser developer tools, inspect a team progress bar.

Confirm it exposes:

- `role="progressbar"`
- `aria-valuemin="0"`
- The correct `aria-valuemax`
- The correct `aria-valuenow`
- A readable `aria-valuetext`, such as `31 of 84 counted roster games played. 53 left.`

Keyboard-tab through Game Center and confirm player cards still receive visible focus and open with Enter.

## 8. Regression pages

Navigate away and back through:

- Dashboard
- League HQ
- My Team
- Free Agents
- Game Center

Confirm no Game Center overview styles leak onto another page and no new red console errors appear.

## 9. Commit and deploy

After verification and manual testing pass:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey

git restore .firebase/hosting.ZGlzdC9mYW50YXN5LWhvY2tleS9icm93c2Vy.cache 2>/dev/null || true

git status
git add .
git commit -m "Improve Game Center matchup hierarchy"
git push
```

This batch is frontend-only:

```bash
firebase deploy --only hosting:app -m "Batch 6B Game Center hierarchy"
```

Hard-refresh with **Command + Shift + R** after deployment.

## Stop conditions

Do not deploy, or roll back, if:

- Current scores differ between the overview and team panels.
- Progress totals include bench players.
- Team A information appears under Team B.
- A completed matchup is labeled as live.
- Mobile introduces horizontal scrolling.
- Light Ice makes important text unreadable.
- Any scoring, window, roster, or player-detail behavior changes.
- New console or Angular errors appear.
