# Operations B2H — Cost Hardening Without Competitive Drift

**Reviewed source base:** `f47de25a7cf73e4e1709c8d01146efc343617ae2`

**Live Hosting observed on 2026-10-21:** `1a8b74ff6cd3309489059e485ae98e3416fd044b`

**Status:** implementation candidate; not deployed

## Purpose

B2H removes bounded, verified read/write repetition and adds the evidence needed
for a later scoring-compute reduction. It does not remove a product feature,
skip a due scoring pass, reduce a recovery cadence, or change competitive
authority.

The implementation is deliberately split across two independent release
surfaces:

1. Functions observation and idle-health coalescing;
2. Hosting-only immutable Projection chunk reuse.

The pre-existing, tested `liveScoring.result` index exemption was verified as
already active in Production during the complete read-only parity audit on
2026-10-21. It needs no deployment in B2H.

## Implemented behavior

### Legacy scoring observation only

`runScheduledLeagueAutomation` still sends every selected league through the
existing lease and scoring path. After those unchanged results return, it adds
one fixed aggregate `legacySkipObservation` map to the health write the worker
already performs.

The observer marks only an existing `not-due` result with a future saved
refresh boundary as observationally eligible. A due run that publishes
nothing remains ineligible because hindsight is not pre-run NHL source proof.
`enforcementEnabled` is a literal `false`; no observation can bypass scoring.

See `docs/RINKRAT_OPERATIONS_B2H_SCORING_SKIP_OBSERVATION.md`.

### Draft idle-health coalescing

`runScheduledDraftAutomation` retains its once-per-minute inventory scan and
all Draft processing. Only an identical healthy result with zero active Drafts,
zero picks, and zero failures may suppress its repeated aggregate write and
completion log. Active work, transitions, malformed or unavailable prior
evidence, and every failure write immediately. A three-minute due boundary plus
one cadence reserve keeps expected health freshness within four minutes.

See `docs/RINKRAT_OPERATIONS_B2H_DRAFT_IDLE_HEALTH_COALESCING.md`.

### Immutable Projection chunk reuse

The browser continues to refresh mutable Projection pointers on the existing
15-second policy. Once a pointer resolves to an immutable snapshot ID, its
complete asset chunks may be reused from a four-entry, tab-lifetime LRU keyed
by exact league and snapshot identity. Concurrent loads coalesce. Failed or
incomplete loads are not cached, a changed snapshot ID loads its own chunks,
and completeness is rechecked against the current pointer metadata on every
cache hit. Missing, non-positive, fractional, or mismatched asset counts fail
closed, and each consumer receives a detached copy so route-local mutation
cannot poison later cache readers.

This changes neither Projection V11 formulas nor hashes. It reduces repeated
48-document reads for the currently observed full asset catalog during normal
same-tab navigation.

### Verified existing live-scoring index exemption

`firestore.indexes.json` already excludes `liveScoring.result` from automatic
single-field indexing. Scoring snapshots are loaded by exact document path;
no supported query filters or orders by fields below `result`. The exemption
changes neither stored result data nor score calculation. It avoids unused
nested index entries and the previously documented index-entry overflow.

The complete 2026-10-21 read-only Production parity inspection showed that
this exact override is already active. It also found that the ten protected TTL
fields inherit different live index scopes than the checked-in configuration.
Therefore B2H must not deploy `firestore:indexes`: that deployment is
unnecessary for `liveScoring.result` and would reconcile unrelated protected
TTL/index configuration. See
`docs/RINKRAT_DATA_D1A_2_LIVE_SCORING_INDEX_CAPACITY.md`.

## Verification

The focused B2H gate is:

```bash
npm run test:batchb2h:run
```

The inherited release gate is:

```bash
npm run verify:batchb2h
npm run build:all
git diff --check
git status --short
npm run release:verify-clean-deploy-source
```

The clean-deployment guard is expected to pass only after the reviewed
candidate is committed.

On 2026-10-21, the complete inherited core gate and the B2H tests passed, but
the outer release gate stopped at the already-recorded expired browser-only
Firestore gRPC advisory exception. The current Firebase release still pins the
affected Node transport range. B2H is therefore not release-ready: do not
extend the exception, force a dependency override, downgrade Firebase, or
deploy this candidate until the dedicated dependency-security review described
in `docs/RINKRAT_COMPUTER_MIGRATION_2026_10_20.md` resolves that gate.

## Release boundaries

Stephen performs all Firebase deployments manually. Do not combine these
stages into a broad deploy. Do not include Rules, indexes, TTLs, or data
migrations.

### Stage 1 — Functions cost evidence

```bash
firebase deploy \
  --project nhl-fantasy-app-ab673 \
  --only "functions:runScheduledLeagueAutomation,functions:runScheduledDraftAutomation"
```

`runScheduledLeagueAutomation` adds observation evidence only.
`runScheduledDraftAutomation` coalesces only identical healthy idle output.
No other scheduler, task worker, callable, or trigger belongs in this stage.

### Stage 2 — Hosting read reduction

```bash
firebase deploy \
  --project nhl-fantasy-app-ab673 \
  --only "hosting:app"
```

This stage releases only the immutable Projection chunk cache. It adds no
Firestore listener or server write.

## Acceptance before any scoring skip

B2H does not contain scoring-skip enforcement. A later batch must first collect
at least seven consecutive days of observation that include live, final, and
post-final NHL states. It must then prove, with fault-injection and compatibility
tests, a pre-run source/version gate that also covers pending roster work,
transactions, final settlement, provider gaps, and an hourly bounded full
recovery pass.

Queue Primary must not be enabled merely to save money. Direct NHL scoring
remains the proven fallback, and incomplete evidence must continue to fail open
to the existing scoring path.

## Deferred work

The following audited opportunities remain separate because they require
additional compatibility or recovery evidence:

- replacing the completed-Draft global scan with atomic pending-season-start
  markers;
- making Shadow watchdog and dispatcher diagnostics state-driven;
- reducing Dashboard team/matchup fanout and duplicate pick subscriptions;
- adding more large-field index exemptions after query-contract tests;
- compacting terminal outbox/notification evidence without losing
  idempotency; and
- changing backup retention only after a restore drill and explicit RPO/RTO
  decision.

Cloud Billing Export also needs to be completed outside application source
before invoice-level savings can be attributed. B2H does not mutate billing
configuration.

## Rollback

- Functions: targeted redeploy of the preceding approved revisions of
  `runScheduledLeagueAutomation` and `runScheduledDraftAutomation`.
- Hosting: targeted redeploy of the preceding approved Hosting revision. The
  cache stores browser memory only and requires no data cleanup.

No rollback requires rewriting a score, roster, window, Draft, transaction,
standing, playoff record, or Projection snapshot.

Production Scoring V4, Projection V11 formulas and hashes, six-game ownership,
seventh-game rollover, immutable started windows, Draft and transaction
authority, Rules, TTLs, App Check, queue mode, worker limits, scheduler cadence,
and canonical scoring authority are unchanged. B2H changes no Firebase Rules,
index, TTL, App Check, queue, or data configuration and requires no deployment
of those surfaces.
