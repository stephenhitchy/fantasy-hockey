# RinkRat 100,000-User Capacity Plan

## What the included model does

Run:

```bash
npm run capacity:100k
npm run capacity:100k:draft-night
npm run capacity:100k:game-night
```

The model reads the current Functions source and combines the deployed scaling settings with explicit route assumptions. It estimates concurrent Firestore listeners, initial document reads, steady-state reads, draft-pick request rate, and roster-action request rate.

This is deliberately labeled a **capacity estimate**, not a live load test. It is useful for identifying architectural bottlenecks before spending money on distributed traffic.

## Current 100,000-user conclusion

RinkRat's static Hosting layer and Firestore read model can be designed for traffic at this scale when users are spread across many leagues. The current release is not yet ready for 100,000 simultaneous active managers because several server automation paths remain centralized:

- Scheduled draft automation scans at most 250 active drafts and processes them sequentially from one scheduled function instance.
- Scheduled league scoring processes only two leagues concurrently in a ten-minute sweep.
- The NHL API proxy is capped at ten instances and could become a cold-load bottleneck.
- A 100,000-user cold start would create millions of Firestore reads and requires staged ramp-up, billing alerts, and a dedicated test environment.

Per-league draft and roster transactions are safer because writes are distributed by league and the server remains authoritative. A single league with 100,000 people watching the same documents is a different workload from 100,000 managers distributed across 10,000 leagues and must be tested separately.

## Safe real-load sequence

1. Create a separate billed Firebase project with synthetic users and synthetic leagues. Never point the large test at production.
2. Run emulator and staging tests at 100, 500, 2,000, and 5,000 concurrent clients.
3. Inspect Firestore usage, Key Visualizer, Function concurrency, error rates, p95/p99 latency, cold starts, and billing after every stage.
4. Follow Firestore's gradual traffic ramp guidance instead of jumping directly to 100,000 users.
5. Refactor scheduled scoring and draft automation into sharded per-league tasks before the 20,000- and 100,000-user stages.
6. Run separate scenarios for read-only Game Center traffic, simultaneous draft rooms, add/drop bursts, and score-update fanout.
7. Define pass/fail thresholds before testing, including no lost draft picks, no duplicate transactions, no skipped roster-slot windows, p95 action latency, and acceptable error rate.

## Replay responsiveness change in this batch

The browser callable timeout now exceeds the server replay timeout, preventing the Firebase JavaScript SDK's default 70-second deadline from falsely reporting failure while the server is still healthy.

Historical replay window rollover also uses the best saved Projection V11 snapshot instead of synchronously rebuilding the entire NHL projection pool on the score-advance critical path. Live scoring still refreshes projections normally. Replay scoring, queued transactions, independent six-game rollover, standings, and playoff transitions remain server-authoritative.
