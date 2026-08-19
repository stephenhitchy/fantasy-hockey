# Product Batch A1I — Manager Briefing

**Runtime release:** Release Candidate 47

**Competitive models:** Production Scoring V3 and Projection V11

**Primary surface:** Manager Dashboard

**Deployment scope:** Hosting only

## Purpose

A1I completes the first bounded personalized manager-home feed from roadmap item A1.1 without turning the Dashboard into another information wall.

The Dashboard adds one optional section:

```text
Coach's Briefing
Your next decisions
```

It appears only when RinkRat can identify an actionable item. When no item qualifies, the section is absent rather than showing an empty state or explanatory paragraph.

## Bounded presentation

The briefing shows:

```text
Maximum items: 3
Maximum items from one league: 1
```

The highest-priority item from each league is considered first. A single busy league therefore cannot hide every other league from the manager's home screen.

Every item contains only:

- league identity;
- one short headline;
- at most one short detail line;
- one direct action.

The complete league cards remain below the briefing for ordinary status and navigation.

## Supported briefing items

A1I can surface:

### Unavailable starters

Uses the signed-in manager's existing roster read and current availability fields. The action opens My Team.

### Recent private waiver outcomes

Reads at most twelve owner-private waiver-claim projections once for each post-Draft league. Only outcomes updated within the last 72 hours qualify:

```text
Awarded
Not awarded
Cleared
```

The projection may include the sanitized waiver asset already available to that owner. No losing claimant, competing claim, waiver-priority value, destination manager, or canonical waiver record is read.

### Live Draft

Appears while the authoritative Draft status is `live` and links directly to Draft Room.

### Close late matchup

Appears only when:

```text
Matchup status: active
Progress: at least 60%
Score margin: 5.0 fantasy points or less
Not a scheduled bye
```

The item links to the existing Game Center cycle route. It does not publish or persist a projected winner.

### Roster-slot boundary

Uses the manager's already loaded authoritative team-window document. A slot qualifies only when its current window is active and exactly one NHL team game remains.

### Scheduled move

Uses the existing pending-move count from the manager's roster. It does not expose another manager's transaction or any private waiver evidence.

## Priority order

The briefing favors immediate competitive action. The effective order is:

1. Recent waiver award.
2. Unavailable starter.
3. Live Draft.
4. Close late matchup.
5. One-game roster-slot boundary.
6. Scheduled move.
7. Recent missed or cleared waiver outcome.

Small deterministic adjustments handle ties, but no hidden recommendation or scoring model is introduced.

## Reads and performance

A1I reuses the existing opt-in Dashboard activity path. Account Settings and other surfaces do not pay these reads.

For each post-Draft league, the existing Dashboard activity load already reads:

- active cycles and the latest cycle;
- the signed-in manager's roster;
- the manager's current matchup and bounded team-window documents.

A1I adds one bounded one-time read:

```text
leagues/{leagueId}/members/{ownerId}/waiverClaims
Order: updatedAt descending
Maximum documents: 12
```

Failure of that optional private-claim read produces no waiver briefing item and does not make the entire Dashboard fail.

A1I adds no permanent listener, Cloud Function, Rule, index, TTL policy, scheduled job, or migration.

## Privacy

The manager can read only their own private waiver-claim projection under the existing transaction-privacy boundary. The briefing never reads canonical waiver or transaction documents.

It does not expose:

- another manager's claim;
- waiver priority;
- claim count;
- destination roster slot;
- outgoing player;
- request identity;
- commissioner note;
- user email or private profile data.

## Mobile behavior

The briefing is an ordinary inline card:

- no modal;
- no fuzzy backdrop;
- no bottom sheet;
- no fixed or sticky panel;
- 44-pixel action targets;
- one-column actions on narrow phones;
- no horizontal page scrolling.

The section contains no introductory description because its items and actions are self-explanatory.

## Preserved systems

A1I changes no:

- Production Scoring V3 calculation;
- Projection V11 calculation;
- independent immutable six-game roster-slot windows;
- seventh-game rollover;
- Draft, roster, scoring, waiver, or transaction authority;
- transaction and waiver privacy Rules;
- Firestore indexes or TTL configuration;
- App Check Monitor or selected-callable canary state;
- scoring queue Shadow or shared NHL cache Shadow authority.

Roadmap item A1.16 remains in progress. Replay player-data catch-up may be optimized later only without coupling projection generation to scoring authority.

## Verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

nvm use 22.23.1

git restore -- public/assets/team-identity-logos

npm run verify:batcha1i && echo "A1I VERIFICATION PASSED"
```

The release may continue only when the final success line appears.

## Deployment

A1I is browser-only:

```bash
firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Product A1I Manager Briefing Release Candidate 47"
```

Do not deploy Functions, Firestore Rules, indexes, TTL configuration, App Check settings, scoring queue configuration, or NHL-cache configuration for A1I.

## Site-first proof

Use leagues that collectively expose several states:

1. Confirm an unavailable starter creates a concise Review lineup item.
2. Confirm a recent private waiver award creates one View result item.
3. Confirm a missed or cleared recent claim never exposes another manager or claim count.
4. Confirm a Draft in progress creates Enter Draft.
5. Confirm a matchup at least 60% complete and within 5.0 points creates Open matchup.
6. Confirm a roster slot with one NHL team game left creates Check windows.
7. Confirm a pending scheduled move creates Review moves.
8. Confirm no more than three items appear.
9. Confirm no more than one item from the same league appears.
10. Confirm the entire section disappears when nothing qualifies.
11. Confirm the card remains inline and scrollable on a narrow phone.

No routine log, TTL, shared-cache, or global Function inspection is required for this Hosting-only release.
