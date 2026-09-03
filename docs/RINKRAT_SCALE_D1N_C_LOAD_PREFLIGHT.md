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

D1N-C-B will build the fixture and task generator separately. It must use the
real `processLeagueAutomationTask` and `processDraftClockDeadline` workers in
staging, deterministic operation identities, bounded batches, explicit cleanup,
and no direct Production dependency. D1N-C-A intentionally does not pretend
that a stale/no-op task is representative scoring or Draft throughput.

## Physical-device prerequisite

Before the first 100-operation ramp, the exact staging build must have bounded
aggregate evidence from physical iPhone Safari and physical Android Chrome.
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

After D1N-C-A is merged, the physical evidence is complete, the exact clean
commit is deployed only to the required staging resources, and the staging
manifest matches that commit, run:

```bash
npm run d1n:c:preflight -- \
  --project=rinkrat-staging-d1nc-2026 \
  --stage=100 \
  --ack=inspect-d1n-c-stage-100-in-rinkrat-staging-d1nc-2026 \
  --device-evidence=path/to/private-aggregate-device-evidence.json \
  --billing-export-evidence=path/to/private-aggregate-billing-evidence.json
```

The preflight requires a clean synchronized `main`, Node 22.23.1/npm 11.17.0,
an exact matching staging manifest, a distinct billed staging project,
Firestore Native in `us-west4`, required Google APIs, a settled staging-filtered
Cloud Billing export, and ACTIVE Node 22 copies of only these worker Functions:

- `processLeagueAutomationTask`
- `processDraftClockDeadline`

The preflight is read-only. A missing worker is a stop condition and not
permission for a broad deployment. D1N-C-B must independently review the exact
targeted staging deployment selectors before any ramp.

For 500, 2,000, or 5,000, also pass `--previous-evidence` containing the passing
immediately preceding stage. A failure, missing metric, delayed cost record, or
different source revision blocks advancement.

## Observability and evidence

Every ramp result must record bounded aggregates for:

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

D1N-C-A changes documentation, tests, and local read-only tooling only. It
requires no Firebase deployment. Rollback is a normal Git revert.

D1N-C-B may later require only the two explicitly reviewed staging Function
workers above plus the staging Hosting manifest used to bind the clean source
revision. It must never target Production, broaden the selector, change worker
limits, or change queue mode. Its rollback is deletion/restoration of only the
synthetic fixture and staged task evidence after retention, followed by removal
or restoration of those two staging workers if the reviewed plan requires it.
