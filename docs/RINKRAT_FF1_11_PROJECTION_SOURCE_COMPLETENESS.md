# FF1.27 — Strict Pre-Draft Schedule-Source Completeness

Status: source implementation candidate; independent review and isolated
staging evidence are required before any Production release or Draft GO.

## Approved problem

FF1.26 staging evidence observed real NHL `429 Too Many Requests` responses
while the Projection worker loaded team schedules. The shared loader logged and
omitted those rejected schedules, substituted the existing neutral six-game
assumption, and still published a `ready` snapshot. The Draft remained stopped
while the request was running, but it later opened from that degraded snapshot.

That behavior conflicts with FF1.26's release contract: a Draft-opening
Projection V11 snapshot must not become authoritative after an NHL schedule
timeout or 429 response. The earlier snapshot must remain current and the exact
pre-Draft request must remain visibly retryable.

## Architecture recommendation

Keep the established tolerant schedule fallback for ordinary projections, but
make source completeness an explicit input contract for the two server reasons
that may open a Draft: `pre-draft` and `draft-start-fallback`. Check the
contract before any ready snapshot or pointer is published. Let the existing
request error and Draft-readiness backoff paths own retry and recovery.

This is an authority-boundary correction, not a Projection V11 formula change.
It does not alter weights, ranks, hashes, six-game math, or the Draft-opening
transaction.

## Implemented behavior

- The team-schedule loader records every rejected NHL team request while still
  using bounded batches and the existing NHL retry policy.
- Draft-opening generation requires all expected team schedule requests to
  complete. Any rejected, missing, or duplicate result throws an explicit
  incomplete-input error.
- The failed snapshot remains `error`; `current` and target-cycle pointers are
  not advanced, so the preceding verified Projection V11 snapshot is retained.
- Successful strict snapshots carry a server-owned completeness contract
  version and `complete` attestation. Draft readiness and every scheduled or
  manual opening path reject older snapshots that lack that evidence.
- The Projection request becomes `error`. Existing Draft automation converts
  that result into its bounded readiness retry state.
- The Draft remains `scheduled`, the clock remains `stopped`, next pick remains
  one, and the picks collection remains empty until a later complete retry is
  verified.
- `manual`, legacy `draft-setup`, `cycle-refresh`, `window-boundary`, and
  `server-emergency` generations retain their established tolerant behavior.

## Acceptance criteria

1. One NHL team-schedule timeout, 429 response, or rejected request prevents a
   `pre-draft` or `draft-start-fallback` snapshot from becoming `ready`.
2. A failed generation cannot advance the `current` or target-cycle pointer.
3. The error states how many bounded team schedules were available without
   recording manager, league, roster, player, or queue identities.
4. The exact Draft remains scheduled, stopped, at next pick one, and at zero
   pick documents while input is incomplete or retry backoff is active.
5. A later complete retry may publish one verified snapshot and bind readiness
   to its exact request ID, snapshot ID, content hash, availability revision,
   and schedule.
6. Duplicate task or scheduler delivery does not create a second active request
   or open the Draft twice.
7. A pre-upgrade ready request or snapshot without the completeness attestation
   cannot be reused to bypass the strict worker.
8. Complete 32-team inputs preserve the existing Projection V11 outputs and
   hash construction.
9. Non-Draft generation reasons retain their previous fallback behavior.

## Edge cases

- A fulfilled team response with an empty regular-season schedule counts as a
  completed source response; a rejected request does not.
- A duplicate team abbreviation produces fewer loaded map entries than the
  expected club count and therefore fails the strict contract.
- Historical Replay Draft preparation may need target, source, and previous
  seasons. Every schedule set requested by that strict generation must pass.
- An availability revision changing during recovery remains protected by the
  existing exact-revision check and requires a new deterministic request.
- A stale failed task cannot clear or replace a newer request because existing
  request/control identity checks remain unchanged.
- The public NHL service may recover before a controlled staging rerun. Unit
  evidence must still prove the rejection path; staging must never induce a
  429 by unsafe load generation.

## Tests

Focused tests cover complete, partial, failed, duplicate-count, strict, and
tolerant source contracts; exact generation-reason selection; error publication
before ready pointer publication; inherited retry state; unchanged queue
concurrency; documentation; and the full FF1.26 gate.

Before release, run `npm run verify:batchff1-11`, `npm run build:all`, `git diff
--check`, and the clean-source guard from a clean exact commit.

Isolated staging must prove a strict incomplete request becomes `error`, the
Draft stays scheduled/stopped/zero, the preceding pointer stays unchanged,
bounded retry recovers after complete data, duplicate delivery converges, and
the 25-minute exact-start rehearsal still meets five seconds. Real NHL 429 log
evidence may be used only when it occurs naturally.

## Deployment resources

After independent review, a clean exact commit, successful build/gate, and no
unresolved P0/P1 finding, deploy only these existing Functions in
consumer-before-producer order:

1. `functions:executeDraftCommand`
2. `functions:processDraftClockDeadline`
3. `functions:runScheduledDraftAutomation`
4. `functions:continueServerDraftAutomation`
5. `functions:processProjectionGenerationTask`
6. the site-pinned staging Hosting target, followed only after staging approval
   by `hosting:app` so the manifest identifies the exact released commit

The first four consumers must reject an older unattested snapshot before the
worker begins publishing the new attestation. Auto-Draft queue and committed-
pick triggers operate only after authoritative live state and do not need this
pre-opening change. Rules, indexes, TTL policies, App Check, scoring queues,
worker limits, and other Functions did not change and must not be included.

## Observability

The Projection request and snapshot retain bounded `error` status and message;
the existing readiness document records attempt count, retry time, and stopped
Draft state. Logs may include NHL season and aggregate available/expected team
counts, but no private competitive identity. Observe request duration, natural
429/timeout count, retry recovery, pointer stability, clock state, and pick
count.

## Rollback

Restore the preceding consumer revisions first, then the preceding producer
revision, and finally the preceding Hosting release if its manifest was
advanced:

1. `functions:executeDraftCommand`
2. `functions:processDraftClockDeadline`
3. `functions:runScheduledDraftAutomation`
4. `functions:continueServerDraftAutomation`
5. `functions:processProjectionGenerationTask`

Preserve failed and successful request, snapshot, readiness, task, and
Function-log evidence. Do not repair a real Draft or Projection pointer through
direct Firestore edits.

Rollback re-enables the earlier neutral-schedule fallback, so do not conduct a
real Draft until the strict release is restored or a separately reviewed risk
decision is recorded.

## Protected contracts

Production Scoring V4 values, Projection V11 formulas and hash schema, six-game
ownership, Game 7 rollover, immutable started windows, roster/pick/transaction
authority, standings, playoffs, Rules, indexes, TTL, App Check mode, scoring
queue mode, canonical authority, task concurrency, worker limits, and
dependencies are unchanged. The direct NHL scoring fallback is unchanged.
