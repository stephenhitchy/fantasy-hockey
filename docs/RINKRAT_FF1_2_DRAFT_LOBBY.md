# RinkRat FF1.18 — One-Hour Draft Lobby

Status: source implementation complete; independent review and authenticated staging evidence pending.

## Implemented behavior

The Draft Room now has a presentation-only lobby phase during the final hour before an authoritative scheduled Draft start. The scheduled start still comes from the Firestore Draft record. The client clock decides only whether to reveal the lobby; it does not make the Draft live and cannot authorize a competitive write.

During the lobby, a league member can:

- inspect the saved Draft order, rankings, roster needs, and existing picks;
- search and sort the shared Draft player pool;
- add, remove, and reorder entries in that member's existing private Draft queue; and
- see the scheduled start countdown plus current preparation and connection evidence.

The lobby does not expose pick submission, player selection, clock start, clock pause/resume, or Auto-Draft controls. `canDraftAsset` continues to require authoritative `live` status, a running and unexpired server clock, the exact authenticated manager's turn, a healthy ordered board, and a legal roster destination. Auto-Draft can be changed only while the Draft is live.

Before the final hour, the Draft Room remains a schedule card and reports the exact local lobby-open time. At the scheduled start, a Draft that remains `scheduled` continues to show the existing preparation/opening state. FF1.19 owns removing that post-countdown wait; this change does not bypass it.

League HQ sends both commissioners and managers to the scheduled Draft page. Within the final hour the action is labelled `Enter Draft Lobby`; earlier it is `View Draft Schedule`. Draft Setup remains available through the existing commissioner controls.

## Acceptance criteria

- At exactly 60 minutes before the scheduled start, the lobby becomes visible; one millisecond earlier it does not.
- At or after the scheduled start, the lobby no longer presents itself as open.
- Missing or invalid schedules and setup/live/complete phases fail closed.
- The lobby displays Draft order, rankings, roster needs, roster, and the authenticated manager's private queue.
- Queue add, remove, and reorder retain the existing connection, pending-action, stale-release, bounded timeout, owner-only, uniqueness, and 100-entry protections.
- Lobby queue updates never enable Auto-Draft and never create picks, move the clock, change order, or write a competitive roster.
- Every Draft/pick/clock control remains live-only, and the server remains authoritative if client time is incorrect or manipulated.
- Scheduled-start activation, injury/projection readiness, retry behavior, and the live Draft path remain unchanged.
- The lobby remains usable at 320, 390, 430, and desktop widths, in Rink Dark, OLED Black, Ice Gray, and Light Ice, at 200% zoom, with keyboard focus and reduced motion.

## Edge cases and required staging evidence

- Join at 60:00, 59:59, 00:01, and 00:00 relative to the scheduled start.
- Refresh directly into the lobby, navigate away and back, and confirm listeners return to the expected baseline.
- Open two tabs for one manager; reorder the queue in each and verify the later authoritative queue snapshot converges without duplicate entries.
- Disconnect before a queue mutation, reconnect, retry once, and verify the final private queue exactly once.
- Leave the page during an awaiting queue response and verify the bounded outcome and listener cleanup.
- Test commissioner and non-commissioner entry from League HQ.
- Test an empty queue, 100-entry queue, unavailable player, traded player, injured player, goalie unit, and first-pick manager.
- Confirm no pick, Auto-Draft, start-clock, pause, or resume control is present in the lobby DOM.
- Confirm a manipulated browser clock cannot make a pick because the callable/server Draft authority still requires live status and the current server-owned turn.

## Tests and observability

`test/batchff1-2-draft-lobby/draft-lobby.test.mjs` covers phase boundaries, invalid input, live-only control containment, private queue reuse, commissioner navigation, responsive theme-token styling, and roadmap/release-boundary documentation.

Existing client-health evidence continues to record the Draft listeners, first snapshots, cache/server origin, reconnects, pending writes, navigation cleanup, and listener lifetime. Existing competitive-action evidence records queue actions and all live Draft operations. No user, league, team, player, game, or queue identifier is added to telemetry by this slice.

## Deployment boundary and rollback

After independent review, a clean commit, successful inherited gate/build, and exact live-manifest verification, staging and eventual production require only a targeted `hosting:app` deployment.

No Functions, Rules, indexes, TTL, App Check, queue, or worker resource changed. No Firebase deployment should be run by Codex. If staging evidence fails, restore the preceding verified Hosting release. If the commit has been merged but not released, use a reviewed Git revert of the FF1.18 commit.

Production Scoring V4, Projection V11, six-game player-window ownership, seventh-game rollover, immutable started windows, Draft server authority, transactions, standings, playoffs, and exact-once behavior are unchanged.
