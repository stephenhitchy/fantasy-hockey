# Social Batch C1G — League Wire Reactions

**Original runtime release:** Release Candidate 33

**Current follow-up:** C1H emoji-only mobile picker in Release Candidate 34

**Competitive models:** Production Scoring V3 and Projection V11

**Primary product surface:** League HQ → League Wire

**Authority:** Verified league-member callable; server-owned update of an existing activity document

## Purpose

C1G lets managers respond to meaningful League Wire events without introducing full chat, free-form trash talk, moderation queues, or another social page. Each verified league member may hold one reaction on an eligible activity item. Choosing another emoji switches the reaction; choosing the current emoji again removes it.

C1H keeps the complete emoji catalog but removes the custom Quick Picks row after mobile site testing. The current picker contains only standard Unicode emoji.

## Local emoji catalog

The picker supports **3,944 fully-qualified Emoji 17.0 sequences**. The client and server catalogs are generated from the same Unicode `emoji-test.txt` snapshot:

```text
Unicode Emoji version: 17.0
Fully-qualified sequences: 3,944
Source date: 2025-08-04
Source SHA-256: 1d8a944f88d7952f7ef7c5167fef3c67995bcae24543949710231b03a201acda
```

The browser does not call an emoji CDN or third-party picker service. The full labeled catalog is bundled locally and remains a lazy-loaded chunk that loads only when a manager opens **React**. The Functions source contains the matching local `Set`, so the callable accepts one exact fully-qualified catalog value or `null`; arbitrary text is rejected.

## Compatibility

No production migration or activity backfill is required. Historical reaction values normalize to standard emoji when read and are written canonically the next time that activity receives a real reaction change:

```text
stick-tap / rr_stick_tap → 🏒
fire / rr_on_fire         → 🔥
wow / rr_no_way           → 😮
rink-rat / rr_rink_rat    → 🐀
rr_laugh                  → 😂
```

Emoji artwork is rendered by the manager's operating system and browser. A recently standardized sequence may use a fallback glyph on an older device, but its stored reaction identity remains valid.

## Eligible activity

Reactions remain limited to bounded competitive or commissioner-announcement events:

- Draft picks;
- completed add/drop, open-slot, Injured Reserve, bench, and waiver outcomes;
- activated queued roster moves;
- final matchup results;
- commissioner announcements;
- completed regular-season Round Recaps.

Reactions do not appear on league creation, member joins, presentation/settings changes, Draft settings, commissioner Draft-control notices, availability-override notices, live score changes, failed actions, queued plans, pending claims, or internal administrative activity.

## Server authority and privacy

The browser calls:

```text
setLeagueActivityReaction
```

The callable requires an authenticated account, verified email, current membership in the exact league, an existing server-owned activity document, an eligible activity type, and a catalog-approved emoji or `null`.

The server performs membership, activity, reaction-transition, and rate-control reads inside one Firestore transaction. Browser clients cannot write League Wire documents directly. The server derives totals from a bounded `reactionRecords` array rather than accepting browser-provided counts.

The same two Firestore listeners remain in use:

1. the capped recent-activity listener;
2. the exact pinned-announcement listener.

No third listener, unbounded query, Firestore Rule, index, or TTL policy was added.

## Idempotency and abuse controls

A retry that asks for the already-saved emoji returns `changed: false` and does not consume another rate-limit change.

```text
Minimum interval: 750 milliseconds
Rolling window: 20 changes per 60 seconds
Maximum unique reactors per item: 32
Maximum UTF-8 bytes per reaction: 64
```

Malformed history, an unknown emoji, or malformed rate-control state fails closed.

## C1H mobile picker repair

C1H removes the Quick Picks category and every custom reaction asset. The reaction summary and picker now use standard emoji only.

On screens at or below 560 pixels:

- a native category selector exposes every Unicode category;
- the desktop horizontal category-chip row is hidden;
- the result region has a bounded viewport-height maximum;
- `overflow-y: auto`, momentum scrolling, and `touch-action: pan-y` make every visible result reachable;
- results remain paginated 48 at a time;
- **Show more** remains inside the scrollable result area.

The picker stays inline. It uses no modal, fuzzy backdrop, bottom sheet, fixed panel, sticky element, or extra listener.

## Preserved systems

C1H reaction changes do not modify:

- Production Scoring V3;
- Projection V11;
- independent immutable six-game roster-slot windows;
- seventh-game rollover;
- Draft, roster, scoring, transaction, or waiver authority;
- transaction and waiver privacy;
- Firestore Rules, indexes, or TTL policies;
- App Check Monitor or exact-league/callable canary state;
- scoring queue Shadow or shared NHL cache Shadow authority.

## One automated verification gate

Current verification belongs to C1H:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

nvm use 22.23.1

git restore -- public/assets/team-identity-logos

npm run verify:batchc1h && echo "C1H VERIFICATION PASSED"
```

## Targeted deployment

The existing reaction callable and the existing round-recap publisher are updated before RC34 Hosting:

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

No Rules, indexes, TTL, scoring-queue, App Check, or NHL-cache setting belongs to this deployment.

## Site-first smoke test

1. Open an eligible League Wire item and press **React**.
2. Confirm there is no Quick Picks category or custom reaction artwork.
3. On a phone, open the native category selector and confirm every category is available.
4. Scroll vertically through the results and use **Show more**.
5. Select an emoji, switch it, remove it, and refresh; counts must persist without duplication.
6. Confirm **React** remains absent from ineligible administrative activity.
7. Confirm League HQ, pinned announcements, and **Show earlier updates** continue scrolling normally.

Logs are needed only when the visible workflow fails:

```bash
firebase functions:log \
  --project=nhl-fantasy-app-ab673 \
  --only setLeagueActivityReaction
```

Current Player-of-the-Round verification and deployment guidance is maintained in `docs/RINKRAT_SOCIAL_C1H_PLAYER_OF_THE_ROUND.md`.
