# RinkRat D1N-C Staging Load Harness

## Scope and architecture

D1N-C-B implements the bounded traffic generator that D1N-C-A deliberately
left open. It exercises the real `processLeagueAutomationTask` and
`processDraftClockDeadline` task endpoints in the separately billed
`rinkrat-staging-d1nc-2026` project. It never targets Production.

The generator creates only synthetic documents beneath one
`d1nLoadRuns/{runId}` root. The worker entry points recognize a versioned load
probe envelope before normal league or Draft validation, verify the runtime is
the exact staging project, and then transact only against that synthetic root.
Normal scoring and Draft payloads follow their existing paths unchanged.

This is infrastructure-envelope evidence, not a substitute for the disposable
six-manager lifecycle rehearsal. The scoring probe preserves exactly six
synthetic owned-game values and a legitimate zero, but it does not recompute
Production Scoring V4. The Draft probe commits one synthetic pick result but
does not mutate a real Draft. Real competitive-path behavior remains covered by
the FF1 Draft/lifecycle gate.

## Protected behavior

The implementation does not change Production Scoring V4, Projection V11,
six-game ownership, seventh-game rollover, immutable started windows, Draft or
transaction authority, standings, playoffs, Rules, indexes, TTL, App Check,
queue rollout mode, pending-task limits, or canonical authority. Scoring
remains limited to four concurrent tasks. FF1.39 reserves scheduled-start work
five seconds before zero and raises the measured Draft task-queue dispatch
ceiling from twenty to sixty; Function instance/request concurrency and every
competitive-authority boundary remain unchanged.

Every synthetic operation has a hashed deterministic identity. Ten percent of
each workload is intentionally delivered twice using distinct hashed Cloud
Task identities. The result document is created transactionally at the
operation identity, so a duplicate delivery updates bounded delivery evidence
but cannot create a second result. Sixteen shards prevent all operations from
writing one global counter.

## Entry criteria

Do not run a ramp until all of these are true:

- the implementation is independently reviewed and merged to clean,
  synchronized `main`;
- Node 22.23.1 and npm 11.17.0 are active;
- the exact commit passes `npm run verify:batchd1ncb`, `npm run build:all`,
  `git diff --check`, and the clean-source guard;
- the exact commit is deployed only to the two staging workers and staging
  Hosting, and the live staging manifest matches it;
- the staging Billing export prerequisite file proves a settled,
  staging-filtered row and active budget alert; and
- no other D1N-C run is seeding or running.

Physical iPhone, Android, reconnect, cleanup, and multi-tab evidence is an
independent Draft/public-scale lane. It does not block this infrastructure-only
backend ramp. If a device-evidence file is supplied, it must contain
measurements actually recorded from the exact candidate and pass the strict
D1N-C-A validator. If it is omitted, the raw and finalized ramp evidence records
`physicalDeviceEvidenceStatus: "deferred"` and cannot authorize a real Draft or
public scale. Never convert prior manual testing into invented counts.

## Exact staging deployment boundary

Stephen performs deployment after review. Deploy only these staging Functions
from the clean merge commit, in consumer-first order:

```bash
firebase deploy \
  --project rinkrat-staging-d1nc-2026 \
  --only functions:processDraftClockDeadline

firebase deploy \
  --project rinkrat-staging-d1nc-2026 \
  --only functions:processLeagueAutomationTask
```

`processLeagueAutomationTask` has no runtime behavior change in this repair,
but the strict D1N-C preflight compares its immutable common Functions source
archive with the clean commit. FF1.38 changes only the Draft consumer queue
ceiling, so its task producers do not require deployment.

Then deploy only site-pinned staging Hosting so the manifest binds that exact
source:

```bash
firebase deploy \
  --project rinkrat-staging-d1nc-2026 \
  --config .d1n-staging.firebase.json \
  --only hosting
```

No Production Function or Hosting deployment belongs to this load-evidence
slice. No Rules, indexes, TTL, App Check, scoring-queue, worker-instance, or
Firebase configuration deployment is required. The Draft queue ceiling changes
only through the targeted `processDraftClockDeadline` Function deployment; no
standalone queue mutation is permitted.

## Run the 100-operation stage

Use private evidence paths outside the Git worktree. Begin with the templates:

- `docs/evidence-templates/d1n-c-physical-device-evidence.template.json`
- `docs/evidence-templates/d1n-c-billing-export-evidence.template.json`
- `docs/evidence-templates/d1n-c-runtime-usage-evidence.template.json`
- `docs/evidence-templates/d1n-c-ramp-cost-evidence.template.json`

Run the read-only preflight first, then the generator:

```bash
npm run d1n:c:preflight -- \
  --project=rinkrat-staging-d1nc-2026 \
  --stage=100 \
  --ack=inspect-d1n-c-stage-100-in-rinkrat-staging-d1nc-2026 \
  --billing-export-evidence=/absolute/private/d1n-billing-prerequisite.json

npm run staging:d1n:c:run -- \
  --project=rinkrat-staging-d1nc-2026 \
  --stage=100 \
  --ack=run-d1n-c-stage-100-in-rinkrat-staging-d1nc-2026 \
  --billing-export-evidence=/absolute/private/d1n-billing-prerequisite.json \
  --output=/absolute/private/d1n-c-stage-100-raw.json
```

Add `--device-evidence=/absolute/private/d1n-device-evidence.json` to both
commands only when that exact-revision physical evidence has actually been
recorded. The Billing evidence argument is always mandatory.

The executable refuses Production, emulator variables, a dirty worktree, a
non-`main` branch, Git divergence, unsupported stages, a weak acknowledgement,
missing Billing prerequisite, invalid optional device evidence, evidence output
inside the repository, and either worker whose immutable
deployed source archive differs from the clean Git commit. Before creating a
synthetic run, it also reads both exact deployed worker resources, requires
them to be ACTIVE with one shared runtime service account, and supplies that
verified identity to Firebase Admin for authenticated Cloud Tasks delivery.
This avoids guessing an OIDC identity when the operator uses local Application
Default Credentials. It enqueues 50
scoring probes and 50 Draft probes at stage 100, plus the bounded duplicate
deliveries.

## Observability and evidence finalization

The raw file includes an explicit backend-only scope and whether physical-device
evidence was `verified` or `deferred`, plus the worker-derived operation counts, retries, recovered
transaction contention, duplicates, p50/p95/p99/maximum task timing, queue age,
drain time, interval concurrency, and cold starts. It intentionally has status
`awaiting-external-usage-and-cost` and cannot pass the fixed evaluator.

The generator interleaves scoring and Draft operations in bounded enqueue
batches. FF1.34's two-wave repeat materially improved but did not pass the
fixed drift gate, so FF1.35 schedules one write-free warmup per measured Draft
operation every ten seconds from T-180 through T-10. FF1.36 makes only the
fifty T-10 warmups perform one read-only authority-path prime each. FF1.39
replaces FF1.37's read-free T-5 pulse with the measured authority task itself:
the task dispatches at T-5, holds without Firestore access, and begins its
transaction only at zero. The measured Draft operations share one exact
deadline at least 185 seconds after planning. At stage 100 this is 50 Draft
results plus 900 warmups. Warmups remain part of expected queue drain, Cloud
Monitoring, and settled Billing/cost evidence, but cannot create a synthetic
result or competitive write. The recorded
`draftQueueWarmupTaskCount` must equal 9 times the selected operation stage.
A partial seed, partial enqueue, or drain timeout moves
the synthetic run to a terminal diagnostic state; any late task for that exact
authenticated run is acknowledged without a competitive write or a seven-day
retry loop.
An `enqueue-error` run is retained for diagnosis and must show zero worker
results before a corrected attempt. It does not count as a completed ramp and
must not be silently deleted or represented as load evidence.
Peak operation backlog is sampled while batches are enqueued and while they
drain. After every result and planned duplicate converges, the runner also
lists both exact staging queues and waits until every hashed task identity for
the run is absent; an operation result alone cannot falsely claim an empty
queue while a retry remains scheduled. Producer duration is reported
separately; the two-minute drain gate starts only after the final enqueue and
scheduled work becomes eligible, while per-operation queue age still measures
from each operation's own enqueue or scheduled deadline. An intentional future
schedule is never counted as queue drain time. The drain ends only after every
expected task identity is absent from both exact staging queues; a late warmup
or retry therefore cannot disappear behind the last operation result.

For the exact raw run window:

1. Record Firestore document reads, document writes, and terminal aborted
   operations from Cloud Monitoring in the runtime-usage template. Broaden the
   time window enough to enclose the raw start and end timestamps. Do not use
   client snapshot sizes or estimates.
2. Wait for the Cloud Billing export to settle. Query only the staging project
   and same enclosing window, then record the incremental USD cost and
   settlement timestamp in the cost template. Do not store billing-account,
   dataset, table, or principal identifiers.
3. Finalize the evidence:

```bash
npm run staging:d1n:c:finalize -- \
  --aggregate=/absolute/private/d1n-c-stage-100-raw.json \
  --usage=/absolute/private/d1n-c-stage-100-usage.json \
  --cost=/absolute/private/d1n-c-stage-100-cost.json \
  --output=/absolute/private/d1n-c-stage-100-final.json
```

Finalization rejects a mismatched project, source revision, run fingerprint,
or measurement window; estimated usage; unsettled or non-export cost; invalid
timestamps; missing activity; or any fixed threshold failure. It writes a new
file without overwriting prior evidence.

After independent review, mark only that retained synthetic run reviewed:

```bash
npm run staging:d1n:c:run -- \
  --mark-reviewed \
  --project=rinkrat-staging-d1nc-2026 \
  --stage=100 \
  --ack=mark-reviewed-d1n-c-stage-100-in-rinkrat-staging-d1nc-2026 \
  --run-id=REPLACE_WITH_PRIVATE_RUN_ID \
  --evidence=/absolute/private/d1n-c-stage-100-final.json
```

That command revalidates the passing evidence and exact clean `main` revision
before changing the synthetic run’s retention status. It cannot mark a failed,
stale, mismatched, or already-reviewed run.

## Progression and stop conditions

Stage 500 uses the same commands with `500` and must pass the final stage-100
file as `--previous-evidence` to both preflight and generator. The 2,000 and
5,000 stages follow the same sequential rule, but are later public-scale
evidence rather than a family-and-friends Draft prerequisite.

Stop immediately and preserve the run if any of these occur:

- a result is duplicated, missing, mapped to the wrong operation kind, or does
  not preserve the six-value/legitimate-zero probe contract;
- a terminal worker or Firestore abort occurs;
- a duplicate task fails to converge to the existing result;
- retry or recovered-contention rate exceeds one percent;
- scoring p95/p99 exceeds 20/60 seconds;
- Draft deadline drift p95/p99 exceeds 2/5 seconds;
- queue age p95/p99 exceeds 60/120 seconds or drain exceeds two minutes;
- observed interval concurrency exceeds 4 scoring or 20 Draft operations;
- the queue does not return to zero;
- settled incremental cost exceeds the stage ceiling; or
- a protected competitive document changes.

Do not advance a failed or incomplete stage. Do not weaken thresholds to make a
run pass. Retry only after the failure is understood and a separately reviewed
fix is deployed.

Six fully executed stage-100 runs are retained as failed timing diagnostics.
Exact `a08fbbc0` recorded Draft p95/p99 drift of 30,230/30,620 milliseconds.
Exact `9cc3dd01` preserved 100/100 operations, 10/10 duplicates, zero
errors/retries/contention, and every invariant while improving Draft p95/p99
to 10,426/10,826 milliseconds; scoring p95/p99 was 159/1,620 milliseconds and
queue-age p95/p99 was 44,111/44,907 milliseconds. FF1.35 then improved Draft
p95/p99 to 3,536/3,736 milliseconds with every operation, duplicate, and
invariant intact. Its p99 passed, but p95 remained above 2,000 milliseconds,
and its raw 170,209-millisecond drain value included the intentional future-
deadline hold. FF1.36 then removed the Firestore authority-path cold tail and
corrected drain measurement on exact `118f113b`: 100/100 operations and all
ten duplicates converged without correctness failure, corrected drain was
5,745 milliseconds, and Draft p95/p99 improved to 2,416/2,521 milliseconds.
The p99 gate passed again, but p95 remained 416 milliseconds high after the
T-10 wave finished about seven seconds before zero. Exact `084f352c` then added
FF1.37's T-5 pulse. It preserved 100/100 operations, all ten duplicates, zero
errors/retries/contention, every invariant, and a 4,338-millisecond corrected
drain; Draft p95/p99 was 2,422/2,523 milliseconds. Logs showed the pulses
completed before zero and exact transactions remained near 0.17–0.26 seconds,
leaving the ten-dispatch queue ceiling as the bottleneck. Exact `cd6eede0`
then raised the ceiling to twenty while preserving correctness, but Cloud
Tasks smoothed its fifty-five measured deliveries across about 5.3 seconds;
Draft p95/p99 regressed to 5,120/5,324 milliseconds even though exact
transactions stayed around 0.19–0.24 seconds. FF1.39 therefore reserves the
authoritative task at T-5, removes the superseded no-op T-5 pulse, and allows
sixty bounded concurrent Draft dispatches. Stage 500 is blocked until a fresh
stage-100 run passes and finalizes under every unchanged latency, integrity,
and cost gate.
See
`docs/RINKRAT_FF1_34_DRAFT_QUEUE_RAMP.md`,
`docs/RINKRAT_FF1_35_SUSTAINED_DRAFT_QUEUE_RAMP.md`,
`docs/RINKRAT_FF1_36_DRAFT_AUTHORITY_PRIME.md`,
`docs/RINKRAT_FF1_37_DRAFT_QUEUE_FINAL_PULSE.md`,
`docs/RINKRAT_FF1_38_DRAFT_QUEUE_CONCURRENCY.md`, and
`docs/RINKRAT_FF1_39_DRAFT_START_RESERVATION.md`.

## Cleanup and rollback

Preserve raw/final evidence, task history, logs, and the synthetic run through
review. Cleanup is optional and only accepts a run already marked `reviewed`.
Failed or incomplete runs stay retained for diagnosis rather than being easy
to erase:

```bash
npm run staging:d1n:c:run -- \
  --cleanup \
  --project=rinkrat-staging-d1nc-2026 \
  --stage=100 \
  --ack=cleanup-reviewed-d1n-c-stage-100-in-rinkrat-staging-d1nc-2026 \
  --run-id=REPLACE_WITH_PRIVATE_RUN_ID
```

The cleanup target must match the strict synthetic marker, project, stage, and
run-ID format. It recursively removes only that reviewed `d1nLoadRuns` root.

For FF1.39 runtime rollback, restore the exact preceding `cd6eede0` producer
revisions (`continueServerDraftAutomation`, then
`runScheduledDraftAutomation`), restore `processDraftClockDeadline`, restore
the archive-parity `processLeagueAutomationTask` revision, and restore the
preceding staging Hosting release last. Never broaden rollback to Production
or unrelated Firebase resources.

## Draft decision boundary

Passing stages 100 and 500 closes only OPS-01’s staging load requirement. A
real Draft still requires the source-controlled FF1 gate: exact-release
DRF-01–DRF-09, LIFE-01–LIFE-08, rollback/freeze evidence, an explicit
post-Draft manager-replacement decision, no unresolved P0/P1, and a formal
FF1.16 Draft GO naming the exact live release and rollback point. Deferred
physical-device evidence must be completed independently before that GO; a
passing backend ramp never substitutes for it.
