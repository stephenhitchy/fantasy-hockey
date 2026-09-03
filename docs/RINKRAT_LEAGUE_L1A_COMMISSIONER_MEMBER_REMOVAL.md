# League Lifecycle L1A — Commissioner Member Removal

## Outcome

League Lifecycle L1A gives the current commissioner a server-authoritative way
to remove another manager only while the league is still safely pre-Draft. The
operation removes the member's empty team authority, empty roster authority,
and Draft queue in one Firestore transaction. It also reopens the invite when
appropriate, releases one active-league quota slot, and creates a deterministic
audit record for League Wire publication.

This is implemented behavior on the feature branch. It is not evidence of a
production deployment.

## Safety boundary

Removal is allowed only when all of the following are true:

- the caller is the current commissioner with a verified email and recent
  authentication;
- the target is another current member with matching member, team, and roster
  authority documents;
- the commissioner types the target team name exactly;
- league membership has not been locked;
- no Draft order, scheduled/live/completed Draft, pick, cycle, transaction, or
  waiver exists;
- the target team has no standings or scoring history; and
- every target roster slot is empty and has no pending move.

The server rechecks every condition inside the same transaction that performs
the deletion. Browser state is only an early usability guard and is never the
authority.

## Explicit non-goal: post-Draft expulsion

L1A does not delete a team after Draft setup or competition begins. That would
break Draft order and may invalidate immutable player windows, six-game
ownership, Game 7 rollover, matchups, standings, playoffs, and historical
transactions. A future post-Draft feature must instead revoke manager access
while preserving a server-owned vacant team and its immutable history. That is
a separate design and migration task.

## Idempotency and retry behavior

The browser persists one pending request identifier in session storage. The
server derives a deterministic audit document identifier from the commissioner
and request identifier and binds it to a payload hash. Concurrent or repeated
delivery returns the completed result without repeating deletion, quota
release, or invite changes. Reusing the request identifier with different
information fails closed.

A failed transaction changes nothing and remains retryable. A successful
transaction is visible in the league audit collection with action
`member-removed`; the existing audit activity publisher turns that audit record
into deterministic League Wire work.

## User experience and accessibility

The control appears in League HQ only for the commissioner. It explains why
removal is unavailable after the safety boundary, requires exact team-name and
current-password confirmation, disables duplicate submission, preserves retry
state across a reload in the same tab, restores focus when cancelled, moves
focus to the success status, and ignores late asynchronous UI updates after
navigation away. Existing Client Health competitive-action readiness remains a
browser-side prerequisite.

## Edge cases covered

- commissioner self-removal;
- stale or mismatched member/team/roster authority;
- exact confirmation mismatch;
- saved, scheduled, live, or completed Draft state;
- Draft picks or competition cycles;
- public or member-private transactions and waivers;
- non-zero team record;
- occupied or malformed roster state;
- expired, missing, or malformed invite-expiration authority;
- malformed or unknown Draft documents;
- concurrent duplicate requests;
- replay after success; and
- request-identifier reuse with a different payload.

## Observability

Successful operations create a single deterministic league audit document with
the commissioner, target owner, removed team name, resulting team count,
maximum team count, join state, payload hash, release label, and server
timestamp. The League Wire activity is the bounded member-visible outcome.

Operational review should alert on callable failure rate and latency, especially
`failed-precondition`, `aborted`, and unexpected internal errors. No user,
league, or team identifiers should be added to aggregate client telemetry.

## Verification contract

Focused verification is:

```text
npm run test:batchl1a
```

The suite runs against the demo-only Firestore emulator and proves the
pre-Draft guard matrix, concurrent exact-once behavior, replay safety, lifecycle
quota integrity, locked-Draft refusal without partial deletion, commissioner
authority, exact confirmation, UI safety hooks, activity publication contract,
and unchanged Firebase configuration.

The inherited release gate is:

```text
npm run verify:batchl1a
npm run build:all
git diff --check
npm run release:verify-clean-deploy-source
```

The clean-source gate must be run from a clean commit; an uncommitted worktree
is expected to fail it.

## Bounded staging fixture

The source-controlled staging fixture uses two fixed synthetic, verified Auth
accounts and one fixed synthetic pre-Draft league. Its target team has zero
standings history, empty active/bench/IR slots, no cycles, picks, transactions,
or waivers, and one empty Draft queue. The seeder refuses Emulator Suite
connections, every project except `rinkrat-staging-d1nc-2026`, weak passwords,
missing operation acknowledgement, conflicting Auth identities, and any fixed
Firestore path that does not carry the exact fixture marker.

Run the fixture only after the two targeted staging Functions are active:

```text
L1A_STAGING_PROJECT_ID=rinkrat-staging-d1nc-2026 \
L1A_STAGING_ACK=reset-and-seed-rinkrat-l1a-member-removal-fixture-v1-in-rinkrat-staging-d1nc-2026 \
L1A_STAGING_FIXTURE_PASSWORD="$L1A_STAGING_FIXTURE_PASSWORD" \
npm run staging:l1a:seed-member-removal

L1A_STAGING_PROJECT_ID=rinkrat-staging-d1nc-2026 \
L1A_STAGING_RUN_ACK=exercise-l1a-member-removal-fixture-in-rinkrat-staging-d1nc-2026 \
L1A_STAGING_FIXTURE_PASSWORD="$L1A_STAGING_FIXTURE_PASSWORD" \
npm run staging:l1a:exercise-member-removal
```

The exercise signs in through the client SDK and invokes the deployed callable.
It must prove that member, team, roster, and queue authority are removed; the
invite reopens; lifecycle quota decrements once; exactly one audit becomes
exactly one deterministic League Wire activity; duplicate delivery is a stable
idempotent replay; and request-ID reuse with a different payload is rejected
without another write. Its terminal output contains only bounded counts and
labels—never an account ID, email, invite code, password, request ID, or audit
ID. Reseeding resets only the exact marked fixture and preserves the final
evidence state until that explicit reset.

On 2026-09-03, this bounded exercise passed against the targeted staging
Functions deployed from `d6b10678f8f0a46e07df1c24fa73be38694997ff`.
It observed one completed request, four removed authority documents, an open
one-team invite, a zero remaining lifecycle count, one audit, one League Wire
activity, stable duplicate delivery, and rejected payload reuse. This is
staging evidence only; it is not evidence that either Function is deployed
from the eventual merge commit or that Production was changed.

## Deployment resources

No deployment is performed as part of L1A. If the branch is reviewed, merged,
and independently released, the only changed runtime selectors are:

```text
functions:removeLeagueMemberSecure
functions:publishLeagueAuditActivity
hosting:app
```

`publishLeagueAuditActivity` is included because its event mapper gains the new
audit action. Do not deploy all Functions. Firestore Rules, indexes, TTLs, App
Check mode, scoring queue mode, worker limits, and pending-task limits do not
change.

## Rollback

Before release, discard or revert the L1A commit. After release, first restore
the previous verified Hosting manifest, then deploy the previous verified
revision of exactly `publishLeagueAuditActivity`. Because
`removeLeagueMemberSecure` is a new callable with no prior revision, Stephen
must separately remove only that exact function after confirming the restored
Hosting build no longer invokes it; Codex does not execute Function deletion.
Existing successful removals are authoritative audit-backed membership changes
and are not automatically undone by code rollback; restoring one would require
a separately reviewed authority repair.

## Protected contracts

L1A does not change Production Scoring V4, Projection V11, player-window
ownership, seventh-game rollover, immutable started windows, Draft selection
authority, add/drop, waiver, IR, transaction, standings, playoff, historical
scoring, canonical scoring, Rules, indexes, TTLs, App Check, queue mode, or
worker limits.
