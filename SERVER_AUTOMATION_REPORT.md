# Server-Controlled League Automation Report

## Result

The league's time-sensitive scoring and progression work has been moved out of the commissioner's browser and into Firebase Cloud Functions. Draft completion also initializes Cycle 1 automatically, so no commissioner needs to press a Start Cycle button.

## New server functions

### `initializeSeasonAfterDraft`

A Firestore document trigger watches `leagues/{leagueId}/draft/current`.

When the draft transitions to `complete`, it immediately:

1. Claims the league's server automation lease.
2. Creates Cycle 1 and its matchup documents idempotently.
3. Calculates and publishes the first shared scoring state.
4. Synchronizes roster-slot windows and matchup totals.
5. Records server health and scheduling metadata.

Updating the draft with `cycleOneStartedAt` does not recurse because later trigger events already have `complete` as the previous status.

### `runScheduledLeagueAutomation`

A scheduled function runs every ten minutes. It finds leagues whose drafts are complete and processes only those whose `nextRefreshAt` is due.

For each due league it:

- Claims a server-only lease.
- Repairs a missing Cycle 1 if the draft is already complete.
- Loads all active asynchronous cycles.
- Recalculates each active cycle using the existing six-game slot-window rules.
- Publishes a shared scoring snapshot only when its fingerprint changes.
- Synchronizes immutable per-slot windows.
- Updates matchup scores.
- Completes eligible regular-season matchups and applies standings once.
- Opens subsequent cycles without assuming one league-wide cycle boundary.
- Synchronizes playoff window banks and advances playoff rounds.
- Runs additional transition passes when one update opens another active cycle.
- Writes heartbeat, duration, counts, next refresh time, and errors to Firestore.

## Asynchronous cycle architecture preserved

The server implementation reuses the app's existing cycle, scoring, roster-window, standings, and playoff logic. It does not replace the system with a weekly or league-wide timer.

Each roster slot still has its own immutable six-game window. A player's seventh scheduled NHL game belongs to the next slot window even while other assets are completing an earlier cycle. Multiple cycle numbers can remain active at the same time, and playoff games already played before an opponent is known remain available through the playoff window bank.

## Lease and idempotency safeguards

- Server workers use a unique `server:<uuid>` identity.
- Two scheduled invocations cannot own the same active server lease.
- A server worker can supersede the obsolete browser-worker lease during rollout.
- Cycle 1 creation tolerates retries and existing documents.
- Shared scoring snapshots use fingerprints to suppress unchanged writes.
- Existing completion and standings guards remain in use.
- Failed runs record an error and become eligible for retry after five minutes.

## Browser changes

- The root Angular app no longer starts `startLeagueLiveScoringSession`.
- Users only read shared live-scoring documents.
- Firestore rules reject all client writes under `liveScoring`.
- The browser live-scoring service remains in the source tree temporarily for reference/rollback, but nothing starts it.
- The manual Start Cycle action, countdown, commissioner-only auto-start checks, and old hard-coded season-start date were removed.
- A completed draft with Cycle 1 still being created shows a short “Preparing the Season” state rather than a commissioner action.

## Refresh behavior

The scheduler checks every ten minutes, but a league may intentionally skip work until its stored `nextRefreshAt`:

- Live games or a recent transition: approximately ten minutes.
- Upcoming game nearby: up to one hour.
- No upcoming relevant game found: up to six hours.
- Error retry: approximately five minutes.

This keeps active scoring responsive without repeatedly recalculating idle leagues.

## Projection behavior

Server scoring does not block if a fresh projection snapshot cannot be generated inside the worker. At a window boundary it uses the best saved target/current projection or the projection already frozen on the roster/draft asset. The authoritative completed-game scoring and cycle advancement continue independently.

## Validation performed

- Angular production build passed.
- Firebase Functions TypeScript build passed.
- The compiled Functions entry point loaded successfully in Node.
- The Admin SDK compatibility layer was runtime-checked for nested Firestore paths.
- The exact replacement package was overlaid onto a clean copy of the latest project.
- Both builds passed again from that clean overlay.

The existing Angular warning for `cycle-one.css` exceeding its component-style budget remains and is unrelated to this update.

## Validation not possible in the build environment

The package was not deployed into the user's live Firebase project, so a real Firestore-trigger invocation, Cloud Scheduler run, NHL network request, and production-data migration could not be executed here. The included smoke test should be completed immediately after deployment before inviting the full beta group.
