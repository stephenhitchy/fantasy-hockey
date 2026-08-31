# RinkRat Firebase Functions Instructions

These instructions supplement the root AGENTS.md.

- All competitive writes are server-authoritative.
- Every task, trigger, callable, and scheduled worker must be retry-safe.
- Use deterministic task/request identifiers where duplicate delivery is
  possible.
- Do not trust client-provided league membership, roster ownership, scoring
  versions, timestamps, or completion state.
- Do not add broad all-league scans when a due-time query, shard, or
  affected-league index can be used.
- Avoid high-frequency writes to one shared global document.
- Preserve bounded concurrency and backpressure.
- Record enough bounded evidence to explain failures without storing private
  roster, score, email, invite-code, or raw manager data.
- An NHL timeout or malformed response must never publish a partial score.
- A final-stat correction must update score evidence exactly once and must not
  rerun roster transactions, move game ownership, or advance a competition
  period twice.
- Use the Firebase Emulator Suite for Rules and write-path tests when the task
  touches Firestore authority.