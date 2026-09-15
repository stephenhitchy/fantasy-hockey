# RinkRat D1N-C Staging Load Preflight

## Purpose and current boundary

D1N-C-A defines the fail-closed entry gate for the staged scoring-worker and
Draft-deadline load ramps. It does not generate traffic, seed fixtures, enqueue
tasks, deploy Functions, change queue configuration, or authorize a real Draft.

No Production Firebase project may be a load target. The only permitted target
is the separately billed `rinkrat-staging-d1nc-2026` project. Production
Scoring V4, Projection V11, six-game ownership, Game 7 rollover, server
authority, exact-once behavior, Rules, indexes, TTLs, App Check Monitor, scoring
queue Shadow, worker concurrency, pending-task limits, and canonical authority
remain unchanged.

## Workload contract

The permitted stages are exactly 100, 500, 2,000, and 5,000 operations. Every
stage is split evenly between isolated synthetic scoring-worker tasks and
isolated synthetic Draft-deadline tasks. A stage is an operation ramp, not a
claim that the same number of full browsers or public leagues were tested.

The 100 and 500 stages are required before the family-and-friends Draft gate.
The 2,000 and 5,000 stages remain later public-scale evidence. No higher stage
may start until the immediately preceding stage has a passing evidence file for
the same exact source revision.

D1N-C-B now supplies the separately reviewed fixture and task generator. It
uses the real `processLeagueAutomationTask` and `processDraftClockDeadline`
workers in staging, deterministic operation identities, bounded batches,
transactional duplicate suppression, sharded evidence, explicit cleanup, and
no direct Production dependency. See
`docs/RINKRAT_SCALE_D1N_C_LOAD_HARNESS.md`. D1N-C-A still refuses to pretend
that a stale/no-op task is representative scoring or Draft throughput.

## Independent physical-device evidence lane

Physical-device evidence does not block an infrastructure-only backend ramp.
It remains a separate requirement before a real Draft or any public-scale
authorization. The exact staging build must ultimately have bounded aggregate
evidence from physical iPhone Safari and physical Android Chrome.
Each device and viewport must record at least twenty privacy-safe samples for
Available Players, Matchup, Draft, League Home, and Projection. Those twenty
samples must explicitly include cold, warm, and reconnect profiles; their
profile counts must add back to the route total. Each profile must prove:

- one controlled reconnect snapshot;
- repaired Draft focus and 200% zoom behavior;
- zero listener errors, unknown document counts, and awaiting snapshots;
- zero pending-write snapshots after the no-op identity-write repair;
- zero horizontal overflow; and
- navigation cleanup to zero listeners.

The same exact build also requires a four-tab stale-session sample that cleans
up to zero listeners without errors, pending writes, or awaiting snapshots. The
template is
`docs/evidence-templates/d1n-c-physical-device-evidence.template.json`. It
contains aggregate labels only and must never contain account, league, team,
roster, player, game, document, invite, or task identifiers.

The preflight accepts `--device-evidence` when measured evidence is available
and validates it strictly. Invalid supplied evidence fails closed. When the
argument is omitted, the ramp evidence is explicitly marked `deferred`,
`backendLoadOnly`, and unable to authorize either a real Draft or public scale.
No manual testing may be converted into invented counts.

Cloud Billing export must be enabled before traffic begins because it does not
backfill usage from before enablement. Observe at least one settled export row,
verify an exact staging-project filter, and retain the active staging budget
alert. Record only that bounded prerequisite evidence using
`docs/evidence-templates/d1n-c-billing-export-evidence.template.json`; do not
record a billing-account, dataset, table, or principal identifier.

## Fixed pass/fail thresholds

Integrity thresholds are absolute at every stage:

- zero duplicate Draft picks or scoring results;
- zero terminal operation errors;
- zero terminal Firestore aborts;
- queue backlog returns to zero;
- Scoring V4, Projection V11, six-game ownership, Game 7 rollover,
  transactions, standings, and playoffs remain stable.

The initial performance and cost thresholds are conservative and must be
reviewed after each stage, never silently weakened:

| Metric | Gate |
| --- | ---: |
| scoring task p95 | at most 20 seconds |
| scoring task p99 | at most 60 seconds |
| Draft deadline drift p95 | at most 2 seconds |
| Draft deadline drift p99 | at most 5 seconds |
| oldest queue age p95 | at most 60 seconds |
| oldest queue age p99 | at most 120 seconds |
| recovered retry rate | at most 1% |
| recovered contention rate | at most 1% |
| queue drain after the spike | at most 2 minutes |
| scoring concurrency | never above 4 |
| Draft concurrency | never above 10 |
| incremental billed cost | $2 / $5 / $15 / $25 by stage |

Cost must come from the Cloud Billing export after usage has settled. Client
snapshot sizes, local estimates, and pricing multiplication are not accepted as
exact billed cost.

## Read-only preflight

After this policy is merged, the exact clean commit is represented by the
staging Hosting manifest, the two required staging workers match the clean Git
source byte for byte, and the mandatory Billing prerequisite is complete, run:

```bash
npm run d1n:c:preflight -- \
  --project=rinkrat-staging-d1nc-2026 \
  --stage=100 \
  --ack=inspect-d1n-c-stage-100-in-rinkrat-staging-d1nc-2026 \
  --billing-export-evidence=path/to/private-aggregate-billing-evidence.json
```

When measured physical-device evidence exists for the exact revision, add
`--device-evidence=path/to/private-aggregate-device-evidence.json`. Omitting it
does not block an infrastructure-only backend ramp; it leaves the independent
Draft/public-scale device gate open.

The preflight requires a clean synchronized `main`, Node 22.23.1/npm 11.17.0,
an exact matching staging manifest, a distinct billed staging project,
Firestore Native in `us-west4`, required Google APIs, a settled staging-filtered
Cloud Billing export, and ACTIVE Node 22 copies of only these worker Functions:

- `processLeagueAutomationTask`
- `processDraftClockDeadline`

The preflight is read-only. It downloads only the two immutable deployed source
archives and requires each archive to match the clean Git source byte for byte
before any task can be enqueued. A missing, stale, or mismatched worker is a
stop condition and not permission for a broad deployment. The D1N-C-B runbook
fixes the only permitted staging selectors and requires independent review
before any ramp.

For 500, 2,000, or 5,000, also pass `--previous-evidence` containing the passing
immediately preceding stage. A failure, missing metric, delayed cost record, or
different source revision blocks advancement.

## Observability and evidence

Every ramp result must record bounded aggregates for:

- backend-only scope, physical-device evidence status, and explicit refusal to
  authorize a real Draft or public scale;
- requested/completed scoring and Draft operations;
- retries, recovered contention, terminal errors, and duplicates;
- scoring p50/p95/p99/maximum duration;
- Draft deadline-drift p50/p95/p99/maximum;
- peak and final queue depth, oldest age, and drain time;
- maximum scoring and Draft concurrency and cold starts;
- Firestore reads, writes, terminal aborts, and Key Visualizer contention;
- exact Cloud Billing export cost; and
- all protected competitive invariants.

Do not record raw identities or payloads. Preserve the staging fixture, task
history, logs, aggregate evidence, and billing window until the stage is
reviewed. Stop on the first integrity failure rather than continuing to produce
load.

## Deployment, rollback, and next slice

This device-evidence policy follow-up changes documentation, tests, and local
load tooling only. It changes no Function runtime. Staging Hosting must still
be rebuilt from the clean merge commit so the manifest binds the source used by
the preflight; no Function redeployment is required when the existing two
staging archives continue to match. Rollback is a normal Git revert plus
restoration of the preceding staging Hosting release if the manifest advanced.

D1N-C-B requires only the two explicitly reviewed staging Function workers
above plus the staging Hosting manifest used to bind the clean source revision.
It never targets Production, broadens the selector, changes worker limits, or
changes queue mode. Its rollback retains evidence first, stops new load tasks,
removes only the reviewed synthetic run when authorized, restores/removes only
the two staging workers as applicable, and restores the preceding staging
Hosting release last.
