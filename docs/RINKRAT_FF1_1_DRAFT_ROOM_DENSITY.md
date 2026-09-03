# RinkRat FF1.1 Draft Room Density

**Status:** source implementation complete; independent review and authenticated visual evidence pending

**Runtime boundary:** Hosting only

**Protected contracts:** Production Scoring V4, Projection V11, six-game ownership,
seventh-game rollover, server Draft authority, transaction authority, and exact-once
pick behavior

## Implemented behavior

The player pool now presents one compact decision line on desktop: team identity,
player identity and actual injury state, Rank, Next 6, Season, and the available
queue or Draft action. On narrow screens, the same information reflows into bounded
rows so values remain legible and controls retain the shared mobile touch target.

The Draft-only Watch action, watched-only filter, visible rating, reliability/risk,
recent form, projected active-games tracker, and repeated news prose are removed
from this surface. The account watchlist remains available in the player/Add-Drop
experience; the private Draft queue remains available in Draft Room and remains the
only list used by Auto-Draft.

Rank, Projection V11 outputs, injury data, and news/team-change data are not deleted
or recalculated. The compact card changes presentation only. Search now fulfills its
existing label by matching player name, current team, previous team, or announced
new team without changing result ranking.

## Authority boundary

No pick, clock, queue, roster, projection, or scoring write path was added. The Draft
action appears only for the manager whose turn is live. The existing `canDraftAsset`
contract still requires:

- authoritative Draft status `live`;
- authoritative clock status `running` and an unexpired server deadline;
- the authenticated manager's exact turn;
- healthy, current Draft board evidence; and
- a legal server-compatible roster destination.

Queue writes retain the existing private server-owned queue authority. Removing the
Watch control also removes its one bounded callable read from Draft Room; it does not
delete or mutate any saved watchlist.

## Acceptance criteria

- Desktop player cards use a single compact information line.
- At 320, 390, and 430 CSS pixels, identity and the three metrics reflow without
  horizontal clipping and actions keep a minimum 44-pixel touch target.
- Long names, team changes, missing projections, and actual injury states remain
  readable or have an accessible full label.
- The final Draft action uses the shared high-visibility semantic commit treatment.
- Queue state exposes `aria-pressed`; queue reorder/remove and Draft actions include
  the player name in their accessible label.
- Non-turn managers and scheduled/completed Drafts do not receive a pick action.
- Rink Dark, OLED Black, Ice Gray, Light Ice, 200% zoom, keyboard focus, disabled,
  loading, error, and reduced-motion states remain usable.
- No Scoring V4, Projection V11, Draft authority, Rules, indexes, TTL, App Check,
  queue mode, worker limit, or canonical authority changes are present.

## Verification and evidence

Automated coverage lives in
`test/batchff1-1-draft-room-density/draft-room-density.test.mjs`. It covers search,
visible information, removal of Draft watchlist behavior, action authority, stable
accessible names, desktop/mobile layout contracts, and the read-only utility
boundary. The inherited Draft, mobile, confirmation, handoff, competitive-action,
accessibility, and build gates must also pass.

Authenticated screenshot evidence is still required after a clean exact-source
staging release. Capture 320, 390, 430, and desktop widths with a normal skater, a
long name, a traded player, an injured/IR-eligible player, a goalie unit, a queued
player, the active manager, and a waiting manager across all four themes.

## Deployment, observability, and rollback

If review and staging evidence pass, the only changed runtime resource is
`hosting:app`. No Function, Rule, index, TTL policy, App Check, queue, or worker
deployment is required.

Observe the existing client Draft action diagnostics, release manifest, connection
state, queue failures, and pick confirmation history during the staging smoke. The
presentation itself adds no telemetry or manager/player identifiers.

Rollback restores the preceding verified Hosting release. Saved watchlists and Draft
queues require no data rollback because this slice neither deletes nor migrates them.

## Separate next slices

1. **One-hour Draft lobby:** render the board, order, queue, rankings, and readiness
   state during a bounded server-derived pre-Draft window while keeping every pick
   path disabled.
2. **Start-readiness repair:** prepare injury/projection prerequisites before the
   scheduled time, expose an explicit preparing/ready/failure state, and never start
   the Draft clock until server authority declares the Draft ready.
3. **Exact-release rehearsal:** verify early entry, scheduled transition, clock
   convergence, reconnect, multi-tab stale state, duplicate delivery, and mobile
   layout in a disposable six-manager Draft before real Draft authorization.

The lobby and readiness work are intentionally not implemented in this Hosting-only
slice because they cross the scheduled-start and server-authority boundary.
