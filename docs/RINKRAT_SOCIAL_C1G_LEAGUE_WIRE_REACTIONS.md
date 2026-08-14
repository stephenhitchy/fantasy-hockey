# Social Batch C1G — League Wire Reactions

**Runtime release:** Release Candidate 33

**Competitive models:** Production Scoring V3 and Projection V11

**Primary product surface:** League HQ → League Wire

**Authority:** Verified league-member callable; server-owned update of an existing activity document

**Build maintenance:** C1G.1 narrows the normalized nullable rate-window timestamp before arithmetic so strict Functions TypeScript compilation succeeds; RC33 runtime behavior is unchanged.

## Purpose

C1G gives managers a small way to respond to the moments already worth celebrating in League Wire without introducing full chat, free-form trash talk, moderation queues, or another social page. The feature is limited to four reactions:

```text
🏒 Stick tap
🔥 On fire
😮 No way
🐀 Rink Rat
```

Each manager may hold at most one reaction on an eligible Wire item. Selecting a different option switches the reaction. Selecting the current option again removes it.

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
- a current membership document in that league;
- an existing server-owned activity document with `league-activity-authority`;
- an eligible activity event type;
- one of the four approved reactions, or `null` to remove the current reaction.

The server performs the membership, activity, reaction transition, and rate-control reads inside one Firestore transaction. Browser clients still cannot write League Wire documents directly.

## Storage and privacy

C1G updates the existing activity document rather than creating a separate browser collection:

```text
leagues/{leagueId}/activity/{activityId}
```

The server stores a bounded `reactionRecords` array with one league-member record per owner, derives `reactionCounts` from that array, and stamps reaction authority/release metadata. It never accepts browser-provided totals. The maximum is 32 unique managers, matching the intentionally bounded league-sized design.

Reaction identities and totals are visible only within the existing member-readable League Wire document. They contain no email address, message text, request identifier, transaction identifier, claim information, or administrative note. A signed-out user or nonmember cannot read the activity document under the existing Rules.

The current manager's selected reaction is resolved from the same activity snapshot after refresh. This keeps the same two Firestore listeners already used by League Wire:

1. the ordered, capped recent-activity listener;
2. the exact pinned-announcement listener.

C1G adds no third listener, unbounded query, Firestore Rule, index, or TTL policy.

## Idempotency and abuse controls

A retry that asks for the already-saved reaction is idempotent and returns `changed: false` without consuming another rate-limit change.

Actual changes are bounded by two server-side controls:

```text
Minimum interval: 750 milliseconds
Rolling window: 20 changes per 60 seconds
```

The server-only control document is:

```text
leagues/{leagueId}/members/{ownerId}/activityReactionControls/current
```

The Firestore catch-all keeps that control document unreadable and unwritable by the browser. Malformed reaction history or malformed rate-control state fails closed rather than accepting an ambiguous update.

## Mobile experience

Reaction totals appear as compact chips below eligible Wire items. **React** opens a small inline four-option picker; **Change** opens the same picker when the manager already has a reaction. The selected option is exposed through `aria-pressed`, and the status message announces save/removal results without moving focus into a dialog.

The picker:

- is inline rather than modal;
- has 44-pixel reaction targets;
- uses four columns on wider screens and two columns on phones;
- adds no backdrop, bottom sheet, sticky element, or fixed panel;
- preserves the five-item collapsed feed and **Show earlier updates** behavior.

## Preserved systems

C1G changes no:

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

C1G.1 copies the normalized timestamp into a local constant, performs the explicit null-or-expired guard on that constant, and uses the narrowed number afterward. Runtime branching, retry timing, the 750-millisecond minimum interval, the 20-change rolling minute window, persisted reaction-control schema, callable API, browser UI, and RC33 manifest are unchanged.

No Firestore Rule, index, TTL policy, Scoring V3 source, Projection V11 source, App Check mode, scoring-queue mode, transaction/waiver privacy behavior, or shared NHL cache authority changed.

## One automated verification gate

After manually replacing the project files, the normal owner workflow uses one automated verification gate:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

nvm use 22.23.1

git restore -- public/assets/team-identity-logos

npm run verify:batchc1g && echo "C1G VERIFICATION PASSED"
```

The release may continue only when the final success line appears.

## Targeted deployment

After verification, cleanup, commit, push, and a fresh browser build, deploy only the new callable and Hosting:

```bash
firebase deploy \
  --only functions:setLeagueActivityReaction \
  --project=nhl-fantasy-app-ab673 \
  -m "Social C1G League Wire reactions"

firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Social C1G Release Candidate 33"
```

No Rules, indexes, TTL, scoring queue, App Check enforcement, or NHL-cache authority deployment belongs to C1G.

## Site-first smoke test

Use one disposable Internal Test league and two verified manager accounts:

1. Open League HQ and find an eligible Draft pick, completed transaction, final result, announcement, or Round Recap.
2. As Manager A, select **Stick tap** and confirm its count becomes one.
3. As Manager B in another browser or tab, confirm the update arrives through the existing Wire listener and select **On fire**.
4. Confirm both counts are correct and each manager sees their own selected option.
5. As Manager A, switch from **Stick tap** to **No way** and confirm the old count decreases while the new count increases.
6. Select **No way** again and confirm Manager A's reaction is removed.
7. Refresh both sessions and confirm the saved reactions persist without duplication.
8. Confirm **React** is absent from ineligible commissioner-control/settings activity.
9. Check a narrow phone viewport and confirm the picker remains inline, uses two columns, and does not block scrolling or **Show earlier updates**.

When that visible flow passes, no routine TTL, NHL-cache, global Function-list, or log inspection is required.

## Fallback diagnostic

Only when reacting fails or the count is wrong on the site:

```bash
firebase functions:log \
  --project=nhl-fantasy-app-ab673 \
  --only setLeagueActivityReaction
```

## Rollback

C1G is additive and needs no data migration. A Hosting rollback removes the reaction controls while existing bounded reaction fields remain harmless member-readable activity metadata. A targeted Functions rollback stops future changes. Do not change Firestore Rules, indexes, TTL, scoring, projections, App Check, scoring queue, or NHL-cache settings as part of a C1G rollback.
