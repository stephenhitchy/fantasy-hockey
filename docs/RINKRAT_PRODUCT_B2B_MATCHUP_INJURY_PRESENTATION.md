# B2B — Matchup Injury-Replacement Presentation

Date: 2026-10-08

## Purpose

My Team and Matchup use the same validated mixed-player score presentation.
Every affected roster slot keeps its authoritative **Slot total**, separately
shows each player's owned-game contribution and game range, and marks the exact
replacement boundary on the six game dots. The shared split also marks every
prior player with the injury cross, while its accessible label identifies the
injured and replacement players explicitly.

B2B does not add another score model, Firestore read, or listener. Desktop
Matchup cards and all three mobile paths reuse the B1Z presentation builder and
shared component. The split remains conditional: malformed, incomplete, or
unreconciled segment evidence stays hidden while the authoritative slot total
remains visible.

## Responsive behavior

The split now responds to the width of its own card rather than the width of
the viewport. Wide cards in My Team, desktop Matchup, and mobile single-team
views keep the side-by-side contribution treatment. Any narrow card, including
a head-to-head half-card, stacks its player contributions, preserving the
matchup grid and full names, points, and owned-game ranges without horizontal
overflow.

The accessible group label still announces the full slot total and every
segment. Each game dot still names its exact owner, and the swap boundary and
replacement outline remain non-color cues.

## Verification and release

`test/batchb2b-matchup-injury-presentation` protects the forward, defense,
goalie, team-A, team-B, and single-team paths plus the card-width responsive
contract. The inherited release gate is `verify:batchb2b` followed by
`build:all`.

This slice changes only Hosting. If B2A is still undeployed, release its two
roster Functions first as documented in
`docs/RINKRAT_PRODUCT_B2A_ADD_DROP_TRANSACTION_RECOVERY.md`; the same branch's
updated add/drop browser must not precede its server compatibility layer.
Then deploy exactly:

```bash
firebase deploy --project nhl-fantasy-app-ab673 --only "hosting:app"
```

Rollback is Hosting-only: restore the prior known-good Hosting build. Do not
remove or rewrite mixed-player scoring evidence. Scoring V4, Projection V11,
six-game ownership, Rules, indexes, TTLs, App Check, queue mode, workers, and
competitive authority are unchanged.
