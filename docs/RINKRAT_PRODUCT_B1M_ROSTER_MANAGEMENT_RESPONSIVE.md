# Batch B1M — Responsive Roster Management and Add/Drop Identity

## Scope

This Hosting-only presentation batch repairs the My Team roster-management
sheet, the bench-to-starter destination flow, and player identity imagery used
by My Team and Add / Drop. It does not modify roster eligibility, waivers,
scoring, Projection V11, six-game ownership, or move timing.

## Confirmed root causes

1. `ViewportOverlayPortalDirective` correctly moves fixed sheets under
   `document.body` so Mobile Safari positions them in the visual viewport. The
   Manage Roster Spot styles were global selectors beginning with
   `app-team-settings`. Once portaled, the sheet no longer had that ancestor,
   so its image, metric, and action rules did not match. The browser rendered
   a largely unconstrained NHL team logo and unstructured inline action copy.
2. The bench-to-starter card had a specialized two-column grid, but a later
   generic mobile `.ir-activation-target` rule won the cascade. The main card
   copy fell into the generic 30px logo track, creating one-character lines and
   an extremely tall card.
3. My Team used team logos as the primary image for skaters even though the
   NHL-backed player record already carries a headshot URL tied to the stable
   NHL player id. Image failures had no local failure state.
4. Missing scoring summaries were displayed as numeric zero in My Team,
   obscuring the difference between no evidence and a real zero-point result.

## Implemented presentation behavior

- The unique roster-manager selectors are portal-safe and no longer depend on
  a route-host ancestor.
- Destination cards explicitly retain a radio column plus one flexible content
  column after every mobile rule. Names wrap at words, controls stay within the
  card, and the destination shows slot, occupant, proposed action, and saved
  six-game progress.
- `AssetPortrait` uses a skater's NHL headshot as the primary image and a small
  NHL team badge as secondary context. Missing or failed skater headshots use a
  neutral silhouette. Team-goalie units retain the NHL team logo as their
  primary identity.
- Current points, next-six projection, and six-game progress are separate
  labeled values. Missing scoring evidence displays an em dash; a stored zero
  remains `0.0`.
- Roster-card identity and non-control card space open existing player detail.
  A separate **Manage / Move** button opens the existing roster manager with the
  exact slot preselected. Open slots keep their existing Add / Drop handoff.
- Every direct roster dialog declares its scroll root, opens at the top, uses
  dynamic viewport bounds, includes safe-area space, and retains the shared
  focus trap, Escape handling, body lock, and focus restoration.
- Drop remains a separately styled destructive action and still opens the
  existing confirmation before submitting.

## Verification

Focused command:

```bash
npm run test:batchb1m:run
```

The suite covers headshot/placeholder/goalie-unit resolution, portaled style
scope, the final mobile grid cascade, details-versus-action separation,
dynamic-viewport and safe-area behavior, missing-versus-zero display, and
hashes for roster authority, scoring, Projection V11, Rules, and indexes.

Manual browser coverage must include 320, 375, 390, 430, 768, and desktop
widths with long names, broken/missing headshots, skaters, team-goalie units,
active/bench/IR cards, queued moves, and disabled actions. Desktop WebKit can
exercise the layout and interaction path, but real-device iPhone Safari remains
a post-build manual check because desktop emulation cannot reproduce browser
chrome and every safe-area behavior exactly.

## Deployment and rollback

No Firebase deployment is performed by this batch. When approved, only Hosting
is required:

```bash
firebase deploy --only hosting:app
```

Rollback is a Hosting rollback to the immediately preceding approved release.
There is no schema migration or server compatibility dependency. No Functions,
Rules, indexes, TTLs, App Check settings, queue controls, scoring authority, or
competitive authority are changed.
