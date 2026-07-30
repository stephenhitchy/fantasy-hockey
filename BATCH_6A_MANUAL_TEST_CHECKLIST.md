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
