# Social Batch C1H — Player of the Round and Mobile Emoji Picker

**Runtime release:** Release Candidate 34

**Competitive models:** Production Scoring V3 and Projection V11

**Primary product surface:** League HQ → League Wire

## Purpose

C1H finishes the next bounded portion of the weekly recap roadmap. When an authoritative regular-season round becomes complete, the existing Round Recap now identifies the highest-scoring completed skater roster-slot window as **Player of the Round**. Ties are deterministic, bounded to three displayed assets, and accompanied by the full tie count.

C1H also simplifies League Wire reactions after mobile site testing:

- custom quick picks are removed;
- the picker contains only standard Unicode Emoji 17.0 reactions;
- existing legacy and custom quick-reaction values normalize to their standard emoji equivalents without a migration;
- phones use a native category selector instead of a horizontally clipped category row;
- emoji results scroll vertically inside a bounded inline area;
- the full catalog remains lazy-loaded and paginated 48 results at a time.

## Player-of-the-Round authority

The existing `publishLeagueRoundRecapActivity` trigger remains the only publisher. On first regular-season cycle completion it reads:

```text
leagues/{leagueId}/cycles/{cycleId}/matchups
leagues/{leagueId}/cycles/{cycleId}/teamWindows
```

The publisher accepts performer data only when every real matchup owner has exactly one complete team-window document for the same cycle and every scored window has:

- the same owner and cycle identity;
- a unique roster-slot identity;
- `complete` status;
- a bounded finite fantasy-point score;
- a valid skater or team-goalie-unit summary.

Malformed, partial, duplicate-owner, mixed-cycle, or incomplete window data fails closed. The browser never calculates the winner and no live scoring update is posted.

The activity stores only:

```text
recapTopPerformers: up to 3 { ownerId, asset summary }
recapTopPerformerScore: bounded final fantasy points
recapTopPerformerTieCount: total number tied
```

It does not copy game ledgers, roster-slot IDs, NHL stat rows, projections, request IDs, or raw source document IDs.

## Mobile presentation

Round Recap details use three short lines:

```text
Top team: Rink Raiders · 54.25
Player of the Round: Connor McDavid (Rink Raiders) · 87.4
Closest: Ice Rats by 0.75
```

For a tie, the feed shows up to three names and reports any additional tied assets as `+N tied`.

The emoji picker remains inline. It has no modal, fuzzy backdrop, fixed layer, sticky control, or additional Firestore listener. On screens at or below 560 pixels:

- a native `select` exposes every category;
- the desktop category-chip row is hidden;
- the results region has a bounded viewport-height maximum;
- `overflow-y: auto`, momentum scrolling, and `touch-action: pan-y` keep every result reachable;
- **Show more** remains inside the scrollable results region.

## Compatibility

Existing reaction records remain readable:

```text
stick-tap / rr_stick_tap → 🏒
fire / rr_on_fire         → 🔥
wow / rr_no_way           → 😮
rink-rat / rr_rink_rat    → 🐀
rr_laugh                  → 😂
```

The next actual change to an affected activity document rewrites the selected reaction in canonical Unicode form. No production backfill is required.

## Preserved systems

C1H changes no:

- Production Scoring V3 calculation;
- Projection V11 calculation;
- independent immutable six-game roster-slot windows;
- seventh-game rollover;
- Draft, roster, transaction, waiver, or scoring authority;
- transaction and waiver privacy;
- Firestore Rules, indexes, or TTL policies;
- App Check Monitor or exact-league/callable canary controls;
- scoring queue Shadow mode;
- shared NHL cache Shadow mode or authoritative-read setting.

## One verification gate

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

nvm use 22.23.1

git restore -- public/assets/team-identity-logos

npm run verify:batchc1h && echo "C1H VERIFICATION PASSED"
```

## Targeted deployment

The publisher already exists, so C1H updates only that Function and Hosting:

```bash
firebase deploy \
  --only functions:publishLeagueRoundRecapActivity,functions:setLeagueActivityReaction \
  --project=nhl-fantasy-app-ab673 \
  -m "Social C1H round player and emoji picker"

firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Social C1H Release Candidate 34"
```

The reaction callable is included because it must normalize the retired custom quick IDs to standard emoji. Do not deploy Rules, indexes, TTL, App Check, scoring-queue, or NHL-cache settings.

## Site-first smoke test

Use a disposable Internal Test league with at least four managers:

1. Open an eligible League Wire item and press **React**.
2. Confirm there is no Quick Picks category or custom reaction artwork.
3. On a phone, open the category selector and confirm every Emoji 17.0 category is available.
4. Scroll the emoji results vertically and use **Show more**; confirm more than the first visible row is reachable.
5. Select an emoji, switch it, remove it, and refresh; counts must persist without duplication.
6. Complete a regular-season round containing at least two real matchups.
7. Confirm exactly one Round Recap appears with Top team, Player of the Round, and Closest lines.
8. Verify the performer name, owning team, and points against the completed six-game slot windows.
9. Refresh or rerun scoring and confirm the recap does not duplicate.
10. Confirm announcements, pinning, Game Final activity, and normal League HQ scrolling remain intact.

Logs are needed only if a visible action is missing or wrong:

```bash
firebase functions:log \
  --project=nhl-fantasy-app-ab673 \
  --only publishLeagueRoundRecapActivity,setLeagueActivityReaction
```
