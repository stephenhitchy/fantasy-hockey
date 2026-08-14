# Social Batch C1G — League Wire Reactions

**Runtime release:** Release Candidate 33

**Current implementation:** C1G.3 custom quick reactions + full emoji catalog

**Competitive models:** Production Scoring V3 and Projection V11

**Primary product surface:** League HQ → League Wire

**Authority:** Verified league-member callable; server-owned update of an existing activity document

**Build maintenance:** C1G.1 preserves the original reaction rate limits while satisfying strict Functions TypeScript compilation. C1G.2 expands the picker without creating RC34. C1G.3 keeps RC33 and swaps the quick row to five custom RinkRat icons, including Laughing.

## Purpose

C1G gives managers a lightweight way to respond to moments already worth celebrating in League Wire without introducing full chat, free-form trash talk, moderation queues, or another social page.

C1G.2 expanded the original four-choice picker to all **3,944 fully-qualified Emoji 17.0 sequences** from the Unicode emoji keyboard/display data. C1G.3 keeps that full picker, but the quick-access row now uses five custom RinkRat icon reactions:

```text
Stick tap (custom icon)
On fire (custom icon)
No way (custom icon)
Rink Rat (custom icon)
Laughing (custom icon)
```

Managers can also search or browse standard categories such as Smileys & Emotion, People & Body, Animals & Nature, Food & Drink, Travel & Places, Activities, Objects, Symbols, and Flags.

Each manager may hold at most one reaction on an eligible Wire item. Selecting a different emoji switches the reaction. Selecting the current emoji again removes it.

## Local catalog and compatibility

The client and server catalogs are generated from the same Unicode `emoji-test.txt` snapshot:

```text
Unicode Emoji version: 17.0
Fully-qualified sequences: 3,944
Source date: 2025-08-04
Source SHA-256: 1d8a944f88d7952f7ef7c5167fef3c67995bcae24543949710231b03a201acda
```

The browser does not call an emoji CDN or a third-party picker service. The full labeled catalog is bundled as a local lazy-loaded chunk and loads only when a manager opens **React**. The five custom quick reactions remain immediately available while that chunk loads or if it cannot load.

The Functions source contains a matching local `Set` used as the exact authority allowlist for emojis, plus a local quick-reaction ID set. The callable therefore accepts only a bundled quick-reaction ID, a standardized fully-qualified sequence in the pinned catalog, or `null`; it does not accept arbitrary text merely because it resembles an emoji.

Existing C1G records remain compatible. The legacy values below normalize to their custom quick-reaction IDs when read, and all records are rewritten canonically the next time an actual reaction change updates that activity document:

```text
stick-tap → rr_stick_tap
fire      → rr_on_fire
wow       → rr_no_way
rink-rat  → rr_rink_rat
```

No production migration or activity backfill is required.

Emoji artwork is rendered by the manager's operating system and browser. A recently standardized sequence may use a fallback glyph on a device whose emoji font has not yet added it; the stored reaction identity remains valid.

## Eligible activity

Reactions are available only on bounded competitive or commissioner-announcement activity:

- Draft picks;
- completed add/drop, open-slot, Injured Reserve, bench, and waiver outcomes;
- activated queued roster moves;
- final matchup results;
- commissioner announcements;
- completed regular-season Round Recaps.

Reactions do not appear on league creation, member joins, presentation/settings changes, Draft settings, commissioner Draft-control notices, availability-override notices, live score changes, failed actions, queued plans, pending claims, or internal administrative activity.

## Server authority and membership

The browser calls:

```text
setLeagueActivityReaction
```

The callable requires:

- an authenticated user;
- a verified email address;
- a valid league and activity identifier;
- a current membership document in that exact league;
- an existing server-owned activity document with `league-activity-authority`;
- an eligible activity event type;
- one exact quick-reaction ID or Emoji 17.0 catalog value, or `null` to remove the current reaction.

The server performs the membership, activity, reaction transition, and rate-control reads inside one Firestore transaction. Browser clients still cannot write League Wire documents directly.

## Storage and privacy

C1G updates the existing activity document rather than creating a separate browser collection:

```text
leagues/{leagueId}/activity/{activityId}
```

The server stores a bounded `reactionRecords` array with one league-member record per owner, derives dynamic `reactionCounts` from that array, and stamps reaction authority/release metadata. It never accepts browser-provided totals. The maximum remains 32 unique managers, matching the intentionally bounded league-sized design.

Reaction identities and totals are visible only within the existing member-readable League Wire document. They contain no email address, message text, request identifier, transaction identifier, claim information, or administrative note. A signed-out user or nonmember cannot read the activity document under the existing Rules.

The current manager's selected reaction is resolved from the same activity snapshot after refresh. This keeps the same two Firestore listeners already used by League Wire:

1. the ordered, capped recent-activity listener;
2. the exact pinned-announcement listener.

C1G.3 adds no third listener, unbounded query, Firestore Rule, index, or TTL policy.

## Idempotency and abuse controls

A retry that asks for the already-saved emoji is idempotent and returns `changed: false` without consuming another rate-limit change.

Actual changes keep the same server-side controls:

```text
Minimum interval: 750 milliseconds
Rolling window: 20 changes per 60 seconds
Maximum unique reactors per item: 32
Maximum UTF-8 bytes per reaction: 64
```

The server-only control document is:

```text
leagues/{leagueId}/members/{ownerId}/activityReactionControls/current
```

The Firestore catch-all keeps that control document unreadable and unwritable by the browser. Malformed reaction history, unknown emoji, or malformed rate-control state fails closed rather than accepting an ambiguous update.

## Mobile experience

Reaction totals appear as compact chips below eligible Wire items. To keep an unusually diverse item readable, the summary shows at most eight distinct reaction types, always prioritizing the signed-in manager's own selection, and reports any additional types as `+N`.

**React** or **Change** opens an inline picker with:

- the five custom RinkRat quick reactions first;
- a local search field;
- horizontally scrollable Unicode categories;
- 48 results at a time with inline progressive disclosure;
- icon-only 44-pixel custom-icon or emoji targets with accessible names and native hover titles;
- the selected reaction exposed through `aria-pressed`;
- no modal, fuzzy backdrop, bottom sheet, fixed panel, or sticky element.

The complete 3,944-entry catalog is never part of the initial application bundle. It is dynamically imported only after the picker opens. The existing five-item collapsed feed and **Show earlier updates** behavior remain unchanged.

## Preserved systems

C1G.3 changes no:

- Production Scoring V3 calculation;
- Projection V11 calculation;
- independent immutable six-game roster-slot window;
- seventh-game rollover;
- Draft, roster, scoring, transaction, or waiver authority;
- transaction and waiver privacy projection;
- Firestore Rules, indexes, or TTL policies;
- App Check Monitor or exact-league/callable canary state;
- scoring queue Shadow or shared NHL cache Shadow authority.

## C1G.1 TypeScript build hotfix

The original C1G rate-limit utility correctly treated a `null` `windowStartedAtMilliseconds` value as a fresh rolling window, but it stored that condition in a separate boolean. Strict Functions TypeScript compilation did not carry the nullable-property narrowing through that boolean alias and reported TS18047 when the same property was used in the remaining-window arithmetic.

C1G.1 copies the normalized timestamp into a local constant, performs the explicit null-or-expired guard on that constant, and uses the narrowed number afterward. C1G.3 retains that exact narrowing. Retry timing, the 750-millisecond minimum interval, the 20-change rolling minute window, and the control schema are unchanged.

## C1G.3 custom quick reactions

C1G.3 remains Release Candidate 33 because C1G had not been finalized when the custom quick-reaction revision was requested. It keeps the catalog-validated string reaction model, preserves the full emoji picker, and swaps the quick row and visible summary to five bundled custom SVG icons.

It adds no npm dependency and no runtime network dependency. The source repository carries the exact catalog data needed by the browser and callable.

## One automated verification gate

After manually replacing the project files, the normal owner workflow uses one automated verification gate:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

nvm use 22.23.1

git restore -- public/assets/team-identity-logos

npm run verify:batchc1g && echo "C1G.3 VERIFICATION PASSED"
```

The release may continue only when the final success line appears.

## Targeted deployment

After verification, cleanup, commit, push, and a fresh browser build, deploy only the existing callable and Hosting:

```bash
firebase deploy \
  --only functions:setLeagueActivityReaction \
  --project=nhl-fantasy-app-ab673 \
  -m "Social C1G.3 custom quick reactions"

firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Social C1G.3 Release Candidate 33"
```

No Rules, indexes, TTL, scoring queue, App Check enforcement, or NHL-cache authority deployment belongs to C1G.3.

## Site-first smoke test

Use one disposable Internal Test league and two verified manager accounts:

1. Open League HQ and find an eligible announcement, Draft pick, completed transaction, final result, or Round Recap.
2. Open **React** and confirm the five custom quick reactions appear immediately, including **Laughing**.
3. Select **Laughing** and confirm the count becomes one.
4. As Manager B in another browser or private window, confirm the update arrives through the existing Wire listener.
5. Have Manager B browse **Activities**, select 🏆 from the full emoji picker, and confirm both counts are correct.
6. As Manager A, switch from **Laughing** to a different emoji and confirm the old count decreases while the new count increases.
7. Select Manager A's current reaction again and confirm it is removed.
8. Refresh both sessions and confirm the saved reactions persist without duplication.
9. Confirm a legacy `stick-tap`, `fire`, `wow`, or `rink-rat` value still displays and can be switched or removed.
10. Confirm **React** remains absent from ineligible commissioner-control/settings activity.
11. Check a narrow phone viewport: search, category scrolling, the 44-pixel emoji grid, **Show more**, and **Show earlier updates** must remain inline and scroll normally.
12. Confirm the initial League HQ load remains normal before anyone opens the picker.

When that visible flow passes, no routine TTL, NHL-cache, global Function-list, or log inspection is required.

## Fallback diagnostic

Only when reacting fails or a count is wrong on the site:

```bash
firebase functions:log \
  --project=nhl-fantasy-app-ab673 \
  --only setLeagueActivityReaction
```

## Rollback

C1G.3 is additive and needs no data migration. A Hosting rollback removes the custom quick-icon presentation while existing quick IDs and standardized emoji remain harmless member-readable activity metadata. The older browser can still derive existing counts from the activity records, though it will not show the refreshed quick-icon treatment. A targeted Functions rollback would stop accepting the quick IDs, so deploy Hosting and the callable from the same known-good RC33 revision when rolling back.

Do not change Firestore Rules, indexes, TTL, scoring, projections, App Check, scoring queue, or NHL-cache settings as part of a C1G.3 rollback.
