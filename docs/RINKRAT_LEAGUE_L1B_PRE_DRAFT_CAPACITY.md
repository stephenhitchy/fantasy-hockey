# League Lifecycle L1B — Change Existing League Size

L1C adds a separate, explicitly confirmed reset for an unstarted scheduled
Draft more than 24 hours away; see
`docs/RINKRAT_LEAGUE_L1C_SCHEDULED_CAPACITY_REOPEN.md`. The L1B path below
still does not change saved Draft settings.

## Implemented behavior

In League HQ, the current commissioner may change an existing league's maximum
team count from 2 through 12 before Draft setup is saved. The new maximum
cannot be lower than the number of joined teams. Password reauthentication and
a verified email are required. The server, not the browser, makes the decision.

One Firestore transaction checks the commissioner, exact membership and invite
authority, Draft and competition state, and stale expected team count/limit.
It changes only the league maximum/join status, the existing invite's active
state, and one deterministic audit record. The invite code, team ownership,
rosters, Draft queue, picks, and scoring data remain intact. An expired invite
is never reopened. A successful retry returns the original audited result;
request-ID reuse with a different payload is rejected.

The audit action is `league-capacity-changed`. The present League Wire mapper
does not publish that action; this slice does not change the activity publisher.

Projection V11 formulas and hashes are unchanged. Its existing team-count
input means a snapshot generated for the old maximum is not reusable after a
size change. Projection preparation must be observed before a later Draft.

## Acceptance and edge cases

- A full 2-of-2 league expanded to 4 reopens the same unexpired invite.
- A 2-of-4 league reduced to 2 becomes full without removing either team.
- Reducing below joined count, a stale tab, missing/mismatched authority, an
  expired invite, and a duplicate request all have explicit outcomes.
- A saved Draft order, scheduled/live/completed Draft, pick, cycle,
  transaction, or waiver blocks the update with no partial write.
- Concurrent join or Draft setup transactions must serialize on the league and
  invite documents; the losing stale request must refresh before retrying.
- No change is permitted after Draft setup, even if the Draft has not started.

## Verification and operational evidence

The demo-only emulator suite is `npm run test:batchl1b`. Before release, run
the current inherited gate, `npm run build:all`, and the clean-source guard on
a reviewed clean commit. In staging, use a disposable commissioner and league
to verify the UI, password, same invite, join after expansion, stale second
tab, mobile/desktop focus and zoom, and a blocked saved Draft. Do not use an
existing real league as the first exercise.

Monitor bounded callable success/error counts and p95 latency; investigate
`failed-precondition`, `aborted`, and `already-exists` spikes without logging
invite codes, account identifiers, or passwords. The deterministic audit gives
per-league outcome evidence. Do not infer a Production release from local
source; verify the clean Git commit, build, Function revision, and live Hosting
manifest independently.

## Deployment and rollback

No deployment is performed in this slice. After independent review and staging
evidence, only `functions:updateLeagueCapacitySecure` and `hosting:app` contain
new runtime behavior. Do not deploy all Functions, Rules, indexes, or TTL.

If rolled back after use, restore the prior verified Hosting release first,
then retire only the new callable after confirming no old client invokes it.
Do not automatically revert successful capacity data changes: they are
audit-backed membership settings. A corrective capacity change, if needed,
requires a separate authorized commissioner action while still pre-Draft.

Production Scoring V4, Projection V11 formulas, six-game/Game 7 ownership,
Draft pick authority, transactions, standings, playoffs, Rules, indexes, TTL,
App Check, scoring queue mode, and worker limits are unchanged.
