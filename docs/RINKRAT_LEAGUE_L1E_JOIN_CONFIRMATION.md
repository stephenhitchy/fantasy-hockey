# RinkRat League L1E — Confirmed Join Notification

## Implemented behavior

Both the manual invite-code flow and the share-link continuation flow announce
membership only after `joinLeagueSecure` returns a confirmed league identity.
The application then presents a persistent, dismissible **You're in!** notice
while navigation opens League HQ. The notice includes an **Open League HQ**
recovery action in case route navigation is interrupted.

The confirmation is held only in memory. It is not persisted, logged, or used
as membership authority, and it is cleared when the person dismisses it or
signs out.

## Acceptance and edge cases

- A successful new join and an idempotent already-member recovery both confirm
  that membership exists.
- A rejected, timed-out, offline, full, expired, or Draft-locked join never
  displays success.
- A successful server response followed by failed route navigation keeps the
  confirmation and its League HQ recovery link available.
- The status is announced politely to assistive technology, has a 44px dismiss
  target, remains visible until dismissed, fits above mobile navigation, and
  removes entrance motion when reduced motion is requested.
- No listener, Firestore read, write, retry, or competitive operation is added.

## Verification and observability

Focused tests cover secure-response ordering, both join entry paths, persistent
and dismissible copy, recovery navigation, in-memory-only state, mobile safe
area placement, and reduced-motion behavior. Existing `league_joined` and
`league_invite_joined` aggregate telemetry remain unchanged; no identity or
invite code is added to telemetry. The inherited release gate for this slice is
`npm run verify:batchl1e`.

## Deployment and rollback

This is an Angular presentation slice. After a clean merge commit, deploy only
the site-pinned Hosting target and verify its release manifest matches that
commit. No Function, Rule, index, TTL, queue, or worker deployment is required.
Rollback restores the preceding verified Hosting release or reverts this slice.

Production Scoring V4, Projection V11, six-game ownership, seventh-game
rollover, Draft and transaction authority, standings, playoffs, App Check,
scoring queues, worker limits, and canonical authority are unchanged.
