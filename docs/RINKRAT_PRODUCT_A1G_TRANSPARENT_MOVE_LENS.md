# Product Batch A1G — Transparent Roster Fit and Move Lens

**Runtime release:** Release Candidate 45

**Competitive models:** Production Scoring V3 and Projection V11

**Primary surface:** Add / Drop

**Deployment:** Hosting-only

## Purpose

A1G completes roadmap item A1.8 with optional waiver and free-agent guidance that explains its evidence instead of issuing a hidden grade. The default Add / Drop view remains unchanged: Free agents ordered by Next 6 projection. Managers see guidance only when they choose **Roster fit (for you)** or after they select a legal transaction comparison.

The feature is decision support, not transaction authority. It never selects an outgoing player, submits a move, changes waiver priority, or bypasses the existing six-game timing and roster-validity checks.

## Roster fit ordering

The Add / Drop sort menu now includes:

```text
Roster fit (for you)
```

When selected, free agents and active waivers are ordered from the manager's strongest current fit to weakest. Each row receives a compact tier:

```text
Strong fit
Possible fit
Speculative
Limited fit
More data needed
```

The tier is derived from visible, current evidence:

- a legal open active or Bench slot;
- the lowest-projected legal same-position active or flexible Bench comparison;
- Next 6 Projection V11 points;
- rest-of-season Projection V11 points;
- expected games available in the six-game block;
- exact-position Next 6 rank;
- projection reliability;
- current availability context.

The signed-in manager can open **Why** to see the exact comparison and raw differences. The page never exposes a secret composite score.

When the roster-fit comparison names an outgoing player and that player is still legal after the authoritative timing check, the transaction step shows a quiet **Suggested comparison** badge. The player is not auto-selected.

## Selected-move lens

After the manager chooses an incoming player and a legal outgoing player or open slot, one compact **Move lens** appears in the confirmation card.

It can say:

```text
Leans add
Leans claim
Leans hold
Close call
Open-slot caution
```

The lens evaluates simple directional signals from the same current snapshot:

- Next 6 points;
- rest-of-season points;
- expected games and availability;
- Projection V11 floor;
- current-season fantasy points per game;
- projection reliability;
- replacement value for an open slot.

At most three factors are shown. Detailed evidence remains inside the inline **Why?** disclosure.

## Uncertainty and boundaries

A1G explicitly states what it cannot know. Depending on the move, the uncertainty line may mention:

- waiver priority cost is not scored;
- competing claims are private and not predicted;
- injury and return timing can change;
- a next-six projection range is wide;
- some evidence is unavailable.

The normal transaction workflow still performs the authoritative checks after selection:

- current league membership;
- asset availability;
- valid roster slot;
- pending-move conflicts;
- exact six-game activation timing;
- waiver ownership and processing rules;
- server-authoritative submission.

A1G cannot write or alter any of those outcomes.

## Mobile and information density

The default player rows remain unchanged unless **Roster fit (for you)** is selected. Roster-fit summaries are one compact inline strip, factors wrap as small chips, and details expand inside the row. The selected-move lens stays inside the existing confirmation card.

A1G adds no modal, fuzzy backdrop, fixed panel, sticky recommendation, or additional default-visible page section.

## Data and architecture

A1G uses only data already loaded by Add / Drop:

- the current verified shared Projection V11 snapshot;
- the signed-in manager's existing roster;
- the existing public claim-free waiver projection;
- the existing legal transaction choices.

It adds:

```text
No Cloud Function
No Firestore listener
No Firestore Rule
No Firestore index
No TTL policy
No migration
No recommendation API
No competitive write
```

Production Scoring V3, Projection V11 calculation, immutable independent six-game roster-slot windows, seventh-game rollover, App Check Monitor, the inactive exact-callable canary, scoring queue Shadow, and the non-authoritative shared NHL cache remain unchanged.

## Verification

After manually replacing the project files:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

nvm use 22.23.1

git restore -- public/assets/team-identity-logos

npm run verify:batcha1g && echo "A1G VERIFICATION PASSED"
```

The release may continue only when the final success line appears.

## Deployment

A1G is browser-only:

```bash
firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Product A1G transparent roster fit Release Candidate 45"
```

Do not deploy Functions, Rules, indexes, TTL policies, App Check configuration, scoring-queue configuration, or NHL-cache configuration for A1G.

## Site-first proof

Use a disposable league with a complete Draft and a mix of free agents, waivers, open slots, and occupied roster slots.

1. Open Add / Drop and confirm the default remains **Free agents** sorted by **Next 6 projection**.
2. Change Sort to **Roster fit (for you)**.
3. Confirm the strongest evidence appears first and every visible fit has an inline **Why** action.
4. Open **Why** and confirm the named comparison, Next 6 difference, rest-of-season difference, expected games, and confidence are understandable.
5. Confirm a weak or injured candidate is downgraded rather than presented with false certainty.
6. Start a move whose fit names a roster comparison.
7. Confirm the legal matching candidate receives **Suggested comparison** but is not selected automatically.
8. Choose a roster player or open slot and confirm the Move lens appears only after that choice.
9. Confirm **Why?** exposes no more than three factors plus an uncertainty line.
10. For a waiver, confirm the lens says that waiver priority cost is not scored.
11. Complete or cancel the move and confirm the existing six-game timing and server confirmation remain unchanged.
12. On a narrow phone, confirm the optional fit strip and Move lens remain inline and the page scrolls normally.

## Rollback

A Hosting rollback removes the A1G presentation. No server data or migration must be reversed. Existing transactions, waiver priority, roster windows, scoring, projections, and player-data snapshots remain unchanged.
