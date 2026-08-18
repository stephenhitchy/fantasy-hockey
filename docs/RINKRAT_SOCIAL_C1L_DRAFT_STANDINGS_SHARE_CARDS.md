# Social Batch C1L — Draft and Standings Share Cards

**Runtime release:** Release Candidate 38

**Competitive models:** Production Scoring V3 and Projection V11

**Primary surfaces:** Draft Room and League Standings

**Authority:** Browser-only rendering from already authorized, member-visible data

## Purpose

C1L completes the roadmap's first share-card set by adding one member-triggered Draft result card and one member-triggered current-standings card. C1J already supplied matchup, playoff, placement, and championship result cards. C1L deliberately reuses the same local PNG and Web Share approach instead of creating a social-image backend, Cloud Storage object, Firestore record, or another page.

## Draft result card

After a Draft reaches the authoritative `complete` state, each manager may press **Share my draft** inside the existing completion card. RinkRat prepares a 1080×1080 PNG containing:

- league name;
- the signed-in manager's team name;
- their Draft slot and league team count;
- their total completed picks;
- up to six earliest completed picks, including round, overall pick, player or goalie-unit name, and position;
- RinkRat branding and the six-game competition reference.

Only the signed-in manager's own completed picks are selected. The button is absent while the Draft is live, when the team cannot be resolved, or when no completed pick exists.

## Standings card

The League Standings header now includes **Share standings**. RinkRat prepares a 1080×1080 PNG containing:

- league name;
- the current period label;
- up to the top eight ranked teams;
- rank, team name, record, points for, and point differential;
- a playoff cut line;
- a subtle highlight for the signed-in manager's team;
- an honest note when additional teams remain outside the eight-row card.

The card is generated from the same locally calculated standings rows already rendered on the page. It does not publish owner IDs, email addresses, invite codes, waiver information, roster-slot IDs, or private manager data.

## Native sharing and fallback

Both cards use the shared browser-only utility in:

```text
src/app/core/league/league-share-card-browser.util.ts
```

The image Blob is prepared synchronously before the first asynchronous share boundary. The fallback sequence is:

1. native share sheet with the PNG file when supported;
2. native text sharing when the browser supports sharing but not files;
3. local PNG download;
4. best-effort caption copy after the download.

Closing the native share sheet returns a normal cancellation and does not surface an error.

## Mobile experience

The new actions remain inline and use at least 44-pixel touch targets. On narrow screens:

- **Share my draft** expands to the completion card width;
- **Share standings** and **Refresh** stack cleanly;
- no modal, preview dialog, fuzzy backdrop, fixed panel, or sticky control is introduced;
- the existing Draft and standings pages remain scrollable and usable while a card is prepared.

## Privacy and operational boundary

C1L adds no:

- Cloud Function;
- Firestore document or listener;
- Cloud Storage object;
- Firestore Rule or index;
- TTL policy;
- migration or historical backfill;
- analytics event.

It changes no scoring, projection, Draft authority, roster-window, transaction, waiver, App Check, scoring-queue, or NHL-cache behavior.

## Verification

After manually replacing the project files:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

nvm use 22.23.1

git restore -- public/assets/team-identity-logos

npm run verify:batchc1l && echo "C1L VERIFICATION PASSED"
```

The release proceeds only when the final success line appears.

## Deployment

C1L is Hosting-only:

```bash
firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Social C1L Draft and standings share cards Release Candidate 38"
```

No Functions, Rules, indexes, TTL, App Check, scoring queue, or NHL-cache deployment belongs to C1L.

## Site-first smoke test

### Draft

1. Open a completed Draft as a manager with completed picks.
2. Confirm **Share my draft** appears only in the completed state.
3. Share or download the PNG.
4. Confirm the league, team, Draft slot, total picks, and displayed picks are correct.
5. Confirm another manager receives a card based only on their own picks.
6. Cancel the native share sheet and confirm no error appears.

### Standings

1. Open League Standings with at least two teams.
2. Press **Share standings**.
3. Confirm the period, rank order, records, points for, point differential, and playoff line match the page.
4. In a league larger than eight teams, confirm the card says that more teams remain in RinkRat rather than pretending the list is complete.
5. Confirm the signed-in manager's row is visually distinguishable but no private identifier is shown.

### Mobile

1. Repeat both actions on a narrow phone viewport.
2. Confirm the share buttons are easy to press and do not cause horizontal scrolling.
3. Confirm no overlay blocks the page.
4. Confirm the native share sheet receives a square PNG when file sharing is supported.

When those visible flows pass, no routine Function log, TTL, NHL-cache, or global deployment inspection is required.

## Rollback

C1L stores no server data and needs no migration rollback. Restore the prior known-good Hosting revision to remove the buttons. Existing league, Draft, standings, scoring, projection, transaction, waiver, and League Wire data are unaffected.
