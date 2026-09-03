# RinkRat FF1 Draft Authorization Gate

**Season candidate:** Release Candidate 65

**Current verified Production Hosting source:** `01e93ac522f99a090489fc3e7da1d6602937ffee`

**Protected contracts:** Production Scoring V4 / Projection V11 / six-game ownership / Game 7 rollover

**Scope:** disposable exact-release Draft and lifecycle evidence; no family roster

## Decision boundary

This gate answers whether the exact season release is safe for a real
friends-and-family Draft. Passing invitation testing does not answer this
question. Draft authorization requires all FF1 evidence below, the recorded
manager-replacement decision, the D1N physical-device and 100/500 staging
evidence, freeze/rollback proof, and a separate formal go/no decision.

Do not use a real family roster as the rehearsal. Use only disposable accounts
and leagues controlled by Stephen. Stephen performs every Production account,
league, Draft, roster, and transaction action through the supported RinkRat UI.
Codex may run local/emulator tests and inspect read-only Production metadata.

Never edit Production documents directly in Firestore. Never deploy from this
runbook. Never repair failed evidence through the Firebase or Google Cloud
console. Stop on the first P0/P1 result and preserve the affected state.

## Entry gate

From a clean, synchronized `main` using Node 22.23.1 and npm 11.17.0:

```bash
npm run verify:batchff1
npm run build:all
git diff --check
npm run release:verify-clean-deploy-source
npm run ff1:draft:preflight
```

The live preflight is read-only. It requires:

- exact clean `main` at `origin/main`;
- a valid RC65 live manifest with Scoring V4 and Projection V11;
- live source as an ancestor of reviewed `main`;
- only the source-controlled FF1 documentation/test/tooling delta ahead of
  live Hosting;
- no dependency, package configuration, runtime, Functions, Rules, indexes,
  TTL, Firebase configuration, or deployment-input change;
- full local/deployed Production Function inventory parity; and
- all critical Draft/Projection Functions and the D1M read-only detector
  ACTIVE.

Record the reviewed Git revision and the distinct live manifest revision/build.
Do not describe local source as Production when those hashes differ.

## Fixed safety and evidence rules

- Use one six-manager normal Draft league and one separate supported Historical
  Season replay league for accelerated lifecycle evidence.
- Keep both leagues disposable and omit personal/family identities.
- Never expose email, invite, account, league, team, roster, player, game, or
  Firestore document identifiers. Use aliases such as `draft-a`, `manager-1`,
  and `lifecycle-a`.
- Record UTC timestamp, exact build, browser/device, expected result, actual
  result, PASS/FAIL/BLOCKED, privacy-limited diagnostics, and cleanup status.
- Capture desktop Chrome or Safari plus physical iPhone Safari and Android
  Chrome. Emulation is supplementary and cannot replace both physical phones.
- Use separate tabs for stale-state tests. Do not manufacture races with direct
  database edits.
- A timeout, reconnect, retry, or duplicate delivery must produce one
  authoritative outcome, never a second pick, roster, game, transaction,
  standing, playoff advancement, or Game 7 assignment.
- D1M remains detect-only: it may report evidence and must never correct a
  completed result automatically.

## Evidence record

| Field | Required value |
| --- | --- |
| Scenario | stable ID below |
| Timestamp | UTC |
| Reviewed main | full Git revision |
| Live release | full source revision and build ID |
| Browser/device | product, major version, desktop/physical phone |
| Account/league | bounded aliases only |
| Expected / actual | concise outcomes |
| Result | PASS / FAIL / BLOCKED |
| Diagnostics | privacy-limited reference or none |
| Cleanup | completed / intentionally retained |

## Matrix A — exact Projection V11 Draft

### DRF-01 Exact-release and capacity entry

Confirm the preflight and inherited gate pass. Run the deterministic Draft-night
capacity model and record its report. Create `draft-a` through the normal UI,
fill exactly six stable manager/team identities, and verify Draft settings lock
the expected roster structure.

Pass: the candidate, live release, functions, six identities, and capacity
evidence are explicit; no identity is recreated.

### DRF-02 Projection snapshot and order

Before opening the Draft, record the bounded Projection version/hash evidence,
Draft order, and first manager. Reload on desktop and phone.

Pass: Projection V11 and its snapshot/hash stay consistent; order and first
manager do not change on reload or device.

### DRF-03 Scheduled start and server clock

Schedule the disposable Draft, join from all six accounts, and allow the normal
start path to open it. Compare two devices near the deadline.

Pass: one server-authoritative Draft opens once; the displayed clock converges
on the server deadline without a client becoming authority.

### DRF-04 Manual snake-order picks

Make enough manual picks to cross both ends of the snake order.

Pass: only the on-clock manager can pick, each asset is selected once, reversal
at the round boundary is correct, and reload shows the same history.

### DRF-05 Queue and auto-pick

Create a bounded queue for one manager, let the manager time out, and repeat
with an empty queue.

Pass: the queue uses Projection V11 order; each timeout creates one pick; the
empty-queue fallback is deterministic; unavailable assets are skipped without
duplicate selection or stalled handoff.

### DRF-06 Pause, resume, and deadline

The commissioner pauses near a deadline, waits past the old deadline, then
resumes.

Pass: no pick occurs while paused, the old deadline cannot fire after resume,
and exactly one subsequent server deadline controls the turn.

### DRF-07 Reload, reconnect, and stale tabs

Reload the on-clock browser, disconnect/reconnect a physical phone, and retain
an older second tab while another tab completes the pick. Attempt the stale
action only through the ordinary UI.

Pass: current state recovers, the stale action is rejected or reconciled
truthfully, and one pick/turn handoff exists.

### DRF-08 Physical mobile layout and focus

On iPhone Safari and Android Chrome, exercise queue changes, asset details,
manual pick confirmation, error/retry, pause state, and the next-turn focus
announcement at narrow width and 200% zoom where supported.

Pass: controls remain visible and named; selection and focus are clear; no
clipped identity, clock, score, or action obscures the authoritative state.

### DRF-09 Completion and roster identity

Complete the Draft with a mix of manual, queue, and automatic picks. Reload all
six managers and revisit the league from another device.

Pass: one completion exists, Draft history and six stable team/roster identities
agree, every asset appears at most once, and post-Draft member removal is
correctly unavailable.

## Matrix B — complete six-team lifecycle

Use a separate disposable supported Historical Season replay league
`lifecycle-a` so scoring and rollover can be exercised without waiting for live
NHL dates. Do not claim replay timing is live-season timing.

### LIFE-01 Add/drop and duplicate retry

Perform one legal add/drop, reload during the action, and retry only through the
normal recovery control.

Pass: one transaction exists, roster ownership is correct, and no started
window moves.

### LIFE-02 Waiver authority

Create a legal waiver claim and allow server processing, including one reload
or reconnect before settlement.

Pass: priority and outcome are authoritative and settle exactly once.

### LIFE-03 IR activation

Move an eligible player to IR and later activate through the supported roster
workflow.

Pass: eligibility fails closed, confirmation is legible, and one roster change
occurs without rewriting started history.

### LIFE-04 Six games and legitimate zero

Advance until one active player has six complete owned games and include a
legitimate zero-point final appearance.

Pass: all six games are complete and uniquely owned; zero is preserved as a
complete result and is not confused with unavailable final input.

### LIFE-05 seventh-game rollover

Advance the same player through the seventh eligible NHL game.

Pass: Game 7 belongs only to the next matchup window; the prior six games and
points remain immutable.

### LIFE-06 standings and playoff progression

Settle the matchup and advance far enough to exercise standings and one playoff
progression boundary in the replay league.

Pass: each advancement occurs once; reload/retry does not duplicate points,
wins, standings records, or playoff movement.

### LIFE-07 incomplete final and successful retry

Use the inherited D1L emulator/staging fixture and exact source-controlled
regression evidence. Do not induce an NHL-source failure or manufacture one in
Production.

Pass: incomplete is explicit and retryable, no authoritative zero is persisted,
a legitimate zero stays distinct, and a later complete retry settles once.

### LIFE-08 D1M read-only comparison

As a platform admin, open the bounded detector for the disposable completed
cycle and repeat the same request. Confirm a normal manager is denied.

Pass: evidence is stable and privacy bounded; legitimate zero remains verified;
unverifiable is distinct; no score, window, transaction, standing, or playoff
record changes.

## Matrix C — freeze, rollback, and operational gates

### OPS-01 D1N route/device evidence

Complete authenticated reconnect, multi-tab, navigation cleanup, pending-write,
Draft-focus, and physical-device evidence. Run the staging-only 100 and 500
operation ramps and record queue age, p95/p99, contention, error rate,
concurrency, Firestore use, and cost.

Pass: listeners return to the expected route baseline, no unexplained write or
leak remains, and both private-season ramps meet documented thresholds.

### OPS-02 rollback rehearsal

Review the D1J freeze kit, targeted Function and Hosting restoration selectors,
previous verified revisions, first-15-minute incident procedure, and evidence
retention. Do not execute a Production rollback during rehearsal.

Pass: the exact rollback point, owner, deputy, triggers, and verification steps
are recorded and independently reviewed.

### OPS-03 manager-replacement decision

Record one choice before the Draft:

1. the pilot accepts no post-Draft manager replacement; or
2. a separately implemented and proven account-transfer/vacant-team workflow
   preserves team, roster, Draft history, windows, transactions, standings,
   and playoffs.

Pre-Draft removal must never be extended into post-Draft destructive deletion.

## Stop and release criteria

Any duplicate competitive result, unstable identity, unauthorized action,
wrong Projection V11 snapshot/order, moved six-game ownership, Game 7 assigned
twice, direct-write requirement, unexplained listener/write leak, or unavailable
rollback is P0/P1 and blocks a real Draft.

Real Drafts are authorized only when:

1. DRF-01 through DRF-09 pass on the exact release;
2. LIFE-01 through LIFE-08 pass;
3. OPS-01 and OPS-02 pass;
4. OPS-03 is explicitly decided;
5. no unresolved P0/P1 remains; and
6. FF1.16 records a separate formal Draft **GO** naming the exact release,
   open risks, owner/deputy, rollback point, modes, and invited leagues.

Until then, invitations may proceed under their separate approval, but real
Drafts remain blocked.

## Deployment and rollback boundary

This slice changes documentation, tests, and local release tooling only. It
requires no Firebase deployment. Rollback is a normal Git revert of the FF1
gate commit. Do not deploy Hosting merely to align a documentation-only commit.
