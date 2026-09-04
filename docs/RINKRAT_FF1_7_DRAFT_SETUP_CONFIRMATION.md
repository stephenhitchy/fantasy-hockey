# FF1.23 — Durable Draft Setup Confirmation

Status: source candidate; independently review and merge it, then deploy only
staging Hosting and repeat the supported Draft Setup save before continuing
the Draft authorization gate.

## Observed problem

On exact staging source `fe5f68cc`, both named staging origins passed CORS and
an authenticated Draft Setup save reached `executeDraftCommand` as a `POST`.
Server authority committed the requested schedule while retaining
`scheduled`, a stopped clock, next pick 1, zero drafted assets, and zero pick
documents. The browser nevertheless reported
`Cannot read properties of undefined (reading 'toMillis')` until reload.

The confirmation utility detached Firestore `Timestamp.toDate` from its
object before invoking it. Firestore's implementation calls `this.toMillis()`,
so the detached call lost its receiver after the successful server commit.

## Implemented behavior

Invoke a timestamp-like `toDate` with the original value as its receiver.
Draft Setup can therefore recognize the authoritative committed schedule and
report success without a false error or manual reload.

This is a browser confirmation repair only. The server remains the sole Draft
authority, the exact submission identifier remains required, and the existing
bounded server-read confirmation remains unchanged.

## Acceptance criteria

1. A real Firestore-style timestamp whose `toDate()` uses `this.toMillis()` is
   accepted by `draftSettingsMatchExpectation`.
2. A supported authenticated Draft Setup save reports success and displays the
   server schedule without reload.
3. Reload, reconnect, and a duplicate tab show the same server schedule.
4. The Draft remains `scheduled`, the clock remains stopped, next pick remains
   1, and no pick or drafted asset is created.
5. A mismatched submission, order, schedule, status, or pick duration remains
   rejected by confirmation.

## Edge cases and stop conditions

- Preserve Date, ISO-string, numeric, and ordinary timestamp-like inputs.
- Do not treat a transport response alone as proof; the exact server document
  remains the confirmation source after uncertain requests.
- Stop if the browser reports success for mismatched settings, if a stale tab
  overwrites a newer schedule, if the clock starts, or if any pick appears.
- Do not directly edit Firestore to make the rehearsal pass.

## Tests

`test:batchff1-7:run` contains a receiver-sensitive timestamp regression.
The inherited `batchr1d` test repeats the same shape inside the established
operation-recovery coverage. The clean candidate must pass
`verify:batchff1-7`, `build:all`, `git diff --check`, and the clean-source
guard.

## Deployment resources

After independent review and merge, deploy only staging `hosting`. No Function
changed. Do not deploy Rules, indexes, TTL, App Check, queues, workers,
scoring, or Production resources.

## Observability

Record the exact Git revision and matching staging manifest, the authenticated
`POST`, the visible saved schedule without reload, schedule persistence after
reload/reconnect/duplicate tab, and aggregate Draft status, clock state, next
pick, drafted-asset count, and pick-document count. Omit account, team, queue,
request, and document identifiers.

## Rollback

Restore the preceding verified `fe5f68cc` staging Hosting release. A Git
rollback is a reviewed revert of this client-only slice. The already committed
synthetic schedule does not require a data rollback; verify it remains
scheduled with a stopped clock and zero picks.

## Protected contracts

FF1.23 does not change Production Scoring V4, Projection V11, six-game
ownership, seventh-game rollover, immutable started windows, Draft command or
pick authority, add/drop, waiver, IR, transactions, standings, playoffs,
Rules, indexes, TTL, App Check, canonical authority, queue mode, worker limits,
or Function runtime behavior.
