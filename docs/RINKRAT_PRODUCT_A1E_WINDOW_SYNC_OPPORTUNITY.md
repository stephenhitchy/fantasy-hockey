# Product Batch A1E — Authoritative Window Sync and Next-Six Opportunity Lens

**Runtime release:** Release Candidate 43

**Competitive models:** Production Scoring V3 and Projection V11

**Primary surfaces:** Add / Drop and Player Intel

## Purpose

A1E corrects a display mismatch found during RC42 site testing and completes roadmap item A1.4 without adding another information-heavy page.

A rostered player could appear in Add / Drop as **Matchup 1 · Game 2** while Game Center showed the same active roster slot at **Matchup 2 · Game 1**. The two pages were not reading the same kind of window:

- Game Center used the authoritative fantasy roster-slot window.
- Add / Drop used the NHL team’s Projection V11 six-game schedule block.

Those blocks can start on different dates because RinkRat’s competitive contract is based on independent immutable roster-slot windows. The Projection V11 team block is useful for an unrostered player’s general schedule, but it is not the authoritative matchup state for a player already assigned to an active fantasy slot.

## Authoritative rostered-player tracker

A1E resolves each active rostered asset using this exact identity:

```text
ownerId + persistent rosterSlotId + assetKey
```

It searches only the already bounded active fantasy cycles, prefers the matching window that is actively scoring, then a scheduled next window, and uses a completed window only as a final fallback. Add / Drop waits until every active-cycle team-window listener has delivered before resolving the tracker, so an older completed window cannot briefly masquerade as the current Matchup while a newer cycle is still loading. The numbered markers then use the same fields and status rules as Game Center:

```text
scheduledGameIds
scheduledGameDates
scheduledGameLabels
completedGameIds
liveGameIds
appearanceGameIds
```

The result is the same six-marker interpretation on both pages:

```text
Played
Counted team game · no appearance
Live / Upcoming
Not scheduled
```

If a current roster assignment does not yet have a matching authoritative window, A1E fails closed with **Matchup pending** rather than showing a different NHL block as though it were the fantasy matchup.

## Honest labels for non-rostered players

A free agent has no active fantasy roster-slot window until a manager selects a legal destination slot. Bench and IR players likewise are not currently scoring inside an active lineup slot.

A1E therefore labels their Projection V11 schedule context as:

```text
NHL Block N
Bench · NHL Block N
IR · NHL Block N
```

This avoids presenting a general NHL-team six-game block as a league Matchup number. The transaction-selection step still shows the exact effective fantasy Matchup after a legal destination slot is selected.

## Player Intel parity

Player Intel now loads the same bounded active-cycle team-window documents as the Player Board base-data request and caches them with the existing 30-second league data cache.

For an active rostered player, the Schedule tab shows:

```text
Matchup N
six exact roster-slot games
played / missed / live / upcoming status
```

For a free agent, Bench player, or IR player, it shows the Projection V11 NHL block instead. No new permanent Firestore listener is added.

## Next-six lens

A1E completes roadmap item A1.4 through one compact explanation inside Player Intel’s existing Schedule tab.

The **Next-six lens** uses only fields already published by Projection V11:

```text
expectedGamesAvailable
scheduledGamesInProjectionCycle
scheduleDifficultyLabel
scheduleStrengthAdjustment
projectionBackToBackGames
projectionRestAdvantageGames
roleAdjustment
recentFormAdjustment
```

It produces a concise headline such as:

```text
Full six-game opportunity
Reduced to 4 of 6
Schedule boost
Tough six-game draw
Role and form trending up
```

No more than three factors appear. Reduced availability is always prioritized; other factors are ranked by their measured Projection V11 effect. The explanation never invents news, line assignments, injury dates, or private league information.

This is an explanation of an existing projection, not a new projection formula and not roster advice.

## Read and performance boundary

A1E adds no backend service. It reuses:

- the existing Add / Drop listeners for active-cycle team windows;
- the existing Player Intel one-time league data request;
- the existing 30-second Player Board data cache;
- the existing shared Projection V11 snapshot.

A1E adds:

```text
No Cloud Function
No new Firestore listener
No Firestore Rule
No Firestore index
No TTL policy
No migration
No scheduled job
No competitive write
```

## Preserved authority

A1E does not change:

- Production Scoring V3;
- Projection V11 calculation;
- independent immutable six-game roster-slot windows;
- seventh-game rollover;
- Draft, roster, scoring, waiver, or transaction authority;
- transaction and waiver privacy;
- App Check Monitor;
- exact-league/callable canary controls;
- scoring queue Shadow mode;
- shared NHL cache Shadow mode or its non-authoritative status.

## Verification

After manually replacing the project files:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

nvm use 22.23.1

git restore -- public/assets/team-identity-logos

npm run verify:batcha1e && echo "A1E VERIFICATION PASSED"
```

The release may continue only when the final success line appears.

## Deployment

A1E is browser-only:

```bash
firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Product A1E window sync and opportunity lens Release Candidate 43"
```

Do not deploy Functions, Firestore Rules, indexes, TTL, App Check settings, scoring queue controls, or NHL-cache settings for A1E.

## Site-first proof

Use a historical test league containing an active player whose roster slot has moved into a later Matchup than the NHL team’s season block.

1. Open Game Center and record the player’s Matchup number and six marker states.
2. Open Add / Drop and switch to **Rostered**.
3. Confirm the same active player shows the same Matchup number.
4. Confirm all six marker positions match Game Center.
5. Confirm a free agent is labeled **NHL Block N**, not **Matchup N**.
6. Confirm Bench and IR players use their non-scoring NHL block labels.
7. Open the active player’s Player Intel Schedule tab.
8. Confirm it uses the same authoritative Matchup number and markers.
9. Confirm the Next-six lens shows at most three concise factors.
10. Confirm reduced expected games, schedule adjustment, rest pattern, role, and form values agree with the existing Projection V11 fields on the page.
11. Check a narrow phone viewport and confirm the lens and six-game rows remain vertically scrollable with no modal, overlay, or sticky panel.

## Rollback

A1E stores no new data and needs no migration. Hosting can be rolled back to the prior known-good RC42 bundle without changing Functions, Rules, indexes, TTL, scoring, App Check, or NHL-cache settings.
