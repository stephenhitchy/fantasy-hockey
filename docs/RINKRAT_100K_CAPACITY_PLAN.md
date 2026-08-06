# RinkRat 100,000-User Capacity Plan

## What the included model does

Run:

```bash
npm run capacity:100k
npm run capacity:100k:draft-night
npm run capacity:100k:game-night
```

The dependency-free model reads current Functions source settings and combines them with explicit route assumptions. It estimates concurrent Firestore listeners, initial document reads, steady-state reads, draft-pick request rate, roster-action request rate, and the approximate scoring-worker concurrency required at several average per-league durations.

This is deliberately labeled a **capacity estimate**, not a live load test. It does not create 100,000 authenticated browsers or Firestore streams.

## Current conclusion

RinkRat is suitable for continued controlled invite-beta work, but it is not yet certified for 100,000 simultaneously active managers.

The most important current findings are:

- **The live-scoring queue foundation now exists, but cutover remains the primary red risk.** P1E adds deterministic per-league tasks, due-time schedules, shadow/canary/primary modes, recovery, queue health, and a conservative 24-task pending-depth limit. The default remains shadow, so the two-league ten-minute sweep is still the production path until staging parity and throughput are proven.
- **Draft deadlines already use exact Cloud Tasks.** `processDraftClockDeadline` is the primary path, with deterministic task IDs and scheduled delivery. The 250-league sequential scan is a fallback recovery path, not the only clock engine.
- **Draft task throughput and fallback coverage still need staging tests.** Ten concurrent task dispatches may or may not be sufficient depending on measured task duration and Firestore contention.
- **The NHL proxy remains an amber risk.** It is capped at ten instances and its fastest cache is process-local.
- **Cold starts and reconnect storms can create millions of Firestore reads.** Listener counts must be measured by route and traffic must be ramped gradually.
- **Firebase Hosting is not the leading risk.** Static Angular assets are CDN-friendly.

The exact recommended migration is preserved in:

```text
docs/RINKRAT_HIGH_SCALE_AUTOMATION_BLUEPRINT.md
```

That document names the exact source files, task payloads, scheduling fields, idempotency strategy, migration sequence, observability requirements, rollback path, and staged test gates.

## Safe real-load sequence

1. Create a separate billed Firebase project with synthetic users and leagues. Never point a large test at production.
2. Run staged tests at 100, 500, 2,000, and 5,000 concurrent clients.
3. Measure Firestore usage, Key Visualizer, Function concurrency, Cloud Tasks queue age, error rates, p95/p99 latency, cold starts, and billing after every stage.
4. Run P1E in shadow and staging canary mode, then intentionally promote the idempotent per-league Cloud Tasks path before the 20,000- and 100,000-user stages.
5. Keep the exact draft-deadline task path and paginate or shard only its recovery sweep.
6. Run separate scenarios for read-only Game Center traffic, simultaneous drafts, add/drop bursts, score-update fanout, cold app launches, and reconnect storms.
7. Define pass/fail thresholds before testing, including no duplicate picks, no duplicate scoring, no skipped roster windows, bounded deadline drift, acceptable score freshness, and backlog recovery.
8. Follow Firestore's gradual traffic-ramp guidance rather than jumping directly to peak traffic.

## Replay responsiveness retained

The browser replay callable timeout remains longer than the server timeout and the Firebase JavaScript callable default 70-second deadline, preventing the client transport from falsely reporting failure while the worker is still healthy.

Historical replay window rollover also uses the best saved Projection V11 snapshot instead of synchronously rebuilding the full NHL projection pool on the score-advance critical path. Live scoring still refreshes projections normally. Replay scoring, queued transactions, independent six-game rollover, standings, and playoff transitions remain server-authoritative.
