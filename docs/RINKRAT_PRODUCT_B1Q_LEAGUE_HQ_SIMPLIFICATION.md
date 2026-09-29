# Product Batch B1Q: League HQ Simplification

## Scope

Batch B1Q removes the duplicated status-and-settings area from League HQ. The
header, League Wire, team directory, navigation, and focused tools already
provide the useful destinations without repeating draft, matchup, roster, and
injury information in one tall mobile section.

## Commissioner controls

Commissioner tools remain available in their collapsed disclosure. Comparable
fantasy products provide commissioner management tools, and RinkRat still
needs a clear home for competition setup and player-availability management.
Platform-owner diagnostics remain restricted to platform administrators.

League-size and member-removal controls are setup-only UI. They remain visible
to the commissioner while a draft is absent, in setup, or scheduled. They are
removed from League HQ when the draft becomes live or complete, and whenever
fantasy competition has begun. Server authorization remains authoritative if a
stale tab tries an old action.

The league danger zone remains available to the commissioner after the draft;
this batch does not change deletion authority or confirmation requirements.

## Competitive boundaries

This batch changes League HQ presentation only. It does not change Scoring V4,
Projection V11, six-game ownership, seventh-game rollover, frozen projections,
roster timing, draft authority, Firestore Rules, indexes, TTLs, App Check,
queue mode, or competitive write authority.
