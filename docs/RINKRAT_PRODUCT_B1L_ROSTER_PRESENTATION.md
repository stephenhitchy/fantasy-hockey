# RinkRat B1L — Roster Presentation Integrity

## Scope

B1L is a browser-only presentation repair for My Team, Matchup, roster actions,
Injured Reserve (IR) activation, and Coach glossary definitions. It does not
change roster documents, slot identities, transaction requests, scoring input,
or server authority.

## Implemented behavior

- My Team and Matchup display populated players from highest to lowest within
  each position.
- Before current-season activity exists, the order uses the current Draft
  projection feed. Once current-season activity exists, the order uses total
  current-season fantasy points, then season fantasy points per game and
  projection only as deterministic tie-breakers.
- A legitimate zero remains different from unavailable evidence. Unavailable
  values render as `—` and sort after zero.
- Empty slots follow populated players without changing their stable slot IDs.
- Add/Drop and promotion actions use one contrast-safe, theme-independent blue
  treatment, with explicit hover, keyboard focus, disabled, and mobile states.
- The IR activation target is a labelled radio group. Long player, slot,
  warning, and destination text wraps instead of colliding or clipping, and
  narrow-screen dialog actions become full-width.
- Portaled hockey-term definitions render above the Coach modal backdrop and
  retain bounded desktop and mobile positioning.

## Acceptance criteria

1. Preseason order is descending season projection within LW, C, RW, D, and G.
2. In-season order is descending season fantasy points within those positions.
3. Sorting creates display copies; it never mutates active slots, Draft picks,
   six-game windows, or score-calculation order.
4. Missing performance data is visible as unavailable and never substituted
   with zero.
5. IR activation choices have one programmatic group label and remain readable
   at 320, 390, 430, desktop, and 200% zoom.
6. Add/Drop, Start, Activate, and the equivalent mobile action are visibly
   prominent in every supported theme and keep a stable accessible name.
7. Primary action text meets 4.5:1 contrast. Focus, disabled, loading, failure,
   retry, stale-tab, and navigation-away behavior continue to use the existing
   transaction workflow.
8. Coach definitions appear above the Coach modal on desktop and mobile, stay
   inside the viewport, scroll when necessary, and return focus on close.

## Edge cases

- Zero projected or season points sort ahead of missing data.
- Non-finite metrics are treated as unavailable.
- Equal totals use points per game, projection, asset key, and original index
  for deterministic presentation.
- A projection refresh can reorder cards, but the card continues to operate on
  its original stable slot ID and asset key.
- Empty slots retain their relative order at the end of a position.
- The player-pool projection record is preferred over a stale embedded Draft
  or roster asset when the same asset key is available.
- Long names, occupied bench warnings, safe-area insets, keyboard focus,
  reduced motion, and narrow viewport heights must remain usable.

## Verification

Focused tests cover phase selection, sort order, non-mutation, zero-versus-
missing behavior, empty slots, My Team and Matchup wiring, action contrast,
responsive IR structure, Coach stacking, accessible names, and gate wiring.

The inherited D1N staging gate and `build:all` remain required before merge.
Authenticated visual checks should cover Rink Dark, OLED Black, Ice Gray, and
Light Ice at 320, 390, 430, desktop, and 200% zoom, including hover, keyboard
focus, disabled, loading, failure, reduced-motion, and Coach open/close states.

## Deployment, observability, and rollback

If merged and released, only the site-pinned `hosting:app` target contains
changed runtime bytes. Do not deploy Functions, Rules, indexes, TTL policies,
App Check, queues, or workers for B1L.

Existing roster-operation success/error notices, stale-operation guards, and
client health instrumentation remain the operational signals. Display sorting
adds no listeners, reads, writes, analytics identifiers, or user data.

Rollback is a revert of the single B1L commit followed by a targeted Hosting
release from the resulting clean commit. The live release manifest must match
that commit exactly.

## Protected contracts

B1L does not change Production Scoring V4, Projection V11 formulas or hashes,
six-game ownership, seventh-game rollover, immutable started windows, Draft or
transaction authority, standings, playoffs, historical reconstruction,
Firestore Rules/indexes/TTL, App Check, queue/worker limits, exact-once
transactions, or canonical scoring authority.
