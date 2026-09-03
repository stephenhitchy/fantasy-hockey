# RinkRat Data Infrastructure Batch D1M-A

**Purpose:** bounded, detect-only finalized-score reconciliation

**Implementation state:** deployed to the isolated D1N staging project from clean
commit `d23f05bff404dbd10de0996c2be9e61ad0761ca3`; bounded live behavior evidence
is the next gate and Production remains unchanged

**Competitive authority:** unchanged; direct NHL scoring remains authoritative

**Correction authority:** none; this batch cannot write or correct a score

## Acceptance criteria

D1M-A is acceptable only when all of the following are true:

1. A legitimate zero-point or did-not-appear final can verify when both saved D1L evidence and current canonical evidence are complete.
2. Missing saved source evidence, missing canonical facts, and incomplete canonical settlement remain explicitly `unverifiable`; none become zero.
3. A saved point or appearance difference becomes a review candidate only after both evidence contracts pass.
4. Window-structure problems are reported separately from game-score differences.
5. The scanner reads one exact league and cycle in bounded pages and cannot become an unbounded all-league sweep.
6. Only a platform administrator can call the scanner. Returned team identifiers are pseudonymized for display.
7. Repeated page delivery is read-only and idempotent. It cannot duplicate points, transactions, ownership, standings, or playoff progress.
8. A partial page, missing continuation cursor, read cap, window cap, finding cap, navigation away, or transport error remains visibly incomplete.
9. No completed matchup is automatically corrected and no final-score replay path is introduced.
10. Direct NHL scoring, canonical Shadow/Canary posture, worker limits, and every protected competitive contract remain unchanged.

## Implemented behavior

### Server-authoritative, read-only classifier

`getFinalScoreReconciliationPage` is a platform-admin callable. It reads the exact requested league and cycle, or the newest saved cycle when the caller leaves the cycle blank. It reads four team-window documents per page in document-ID order and returns an opaque continuation value to the already-authorized client.

The server loads saved immutable player windows, current canonical game facts, and the league's frozen scoring rules. For each saved `completedGameId`, it requires:

- a finite saved game score;
- saved game state `final`;
- a valid D1L `gameInputCompleteness` record for that asset and game;
- `complete: true`, `reusableFinal: true`, the exact asset-specific required-source set, no failures, and a valid saved source hash;
- a valid current canonical game document;
- complete current canonical final-input evidence for the asset type; and
- a complete canonical score calculation, including required skater final settlement.

Only after both evidence contracts pass does the detector compare saved points and appearance with current canonical points and appearance. Exact matches increment `verifiedGameCount`. Point or appearance differences increment `candidateGameCount` and return bounded evidence. The detector does not claim that a candidate is an approved correction.

The saved direct-source version and canonical-source version use different deterministic contracts. D1M-A displays both for investigation but deliberately does not claim they should be equal.

### Explicit unverifiable state

A final is `unverifiable` when any required proof is absent or incomplete. This includes a missing finite saved score, legacy completed windows without D1L evidence, invalid saved completeness, missing/invalid or non-final canonical documents, non-finite canonical output, incomplete canonical final input, and missing canonical skater final settlement. The classifier does not calculate an authoritative replacement from partial evidence.

A valid saved zero remains distinguishable: with complete saved evidence and complete canonical no-appearance/zero evidence, it is a verified match.

### Window-integrity checks

The detector reports storage-integrity candidates for:

- duplicate scheduled, completed, incomplete, or appearance game IDs;
- completed or incomplete games outside the immutable scheduled set;
- appearances outside the immutable scheduled set;
- saved per-game score entries outside the immutable scheduled set;
- saved scores attached to a missing or future scheduled game state;
- a game marked both complete and incomplete;
- a completed game whose saved state is not final;
- scheduled, played, appearance, and remaining count mismatches;
- a complete window that still has live, incomplete, or unplayed games;
- a window total that does not equal its per-game score sum; and
- a missing or malformed team-window structure that could otherwise hide finalized games;
- missing, duplicate, cross-team, cross-cycle, or unexpected roster-slot windows; and
- a document that exceeds a bounded inspection limit.

These checks are evidence only. They do not write the window, matchup, roster, transaction, standings, or playoff documents.

### Bounded admin experience

The Release Readiness page contains a separate Final Score Reconciliation card. The administrator can enter any exact league ID, with the current Release Readiness league as the blank default, then inspect an exact cycle or leave the cycle blank for the latest saved cycle. The browser follows at most eight four-team pages, matching the protected 32-team server ceiling. It exposes loading, progress, retry, partial-result, truncation, navigation-away, and error states without adding a Firestore listener.

Displayed findings use a deterministic 12-character team pseudonym rather than a manager identifier. The browser shows at most 120 findings; page summaries continue to report the complete counted total.

Server bounds are:

```text
4 team documents classified per page
up to 32 expected team-document existence reads on the first page only
32 windows per team document
12 completed NHL games per window
512 unique canonical game reads per page
80 returned findings per page
3 maximum callable instances
```

Reaching any cap is visible and prevents a clean-audit conclusion.

## Edge cases

- A real zero and did-not-appear result verifies only with complete saved and canonical evidence.
- A numeric legacy final without D1L provenance is unverifiable even if current canonical facts exist.
- A saved final with an incomplete or malformed source contract is unverifiable.
- A missing or malformed team-window structure makes the scan visibly incomplete; it cannot produce a clean result.
- Missing or empty cycle scope metadata, an expected team with no roster slots, a missing expected team-window document, or an unexpected team-window document makes the scan visibly incomplete.
- A latest-cycle document whose ID does not match its declared cycle number fails closed instead of redirecting the audit to another cycle path.
- Each expected roster slot must have exactly one structurally valid window in the correct team document and cycle.
- A canonical document without the relevant skater final settlement is unverifiable.
- Current canonical evidence may contain a later NHL correction. A resulting difference is a candidate, not an automatic mutation.
- Point-only, appearance-only, and combined differences remain distinct finding codes.
- Duplicate IDs cannot inflate the number of finalized games inspected; duplicates are separate integrity findings.
- An unscheduled per-game score cannot hide inside a matching saved window total; it is a separate integrity finding.
- A score attached to a missing or future scheduled state cannot inflate a matching saved window total.
- A paged retry can reread prior evidence safely because the operation performs no writes.
- A route change invalidates the browser request generation so a late response cannot replace the next screen's state.
- A partial scan or inspection cap is never labeled clean.

## Tests

The D1M-A focused suite covers:

- valid zero/no-appearance verification;
- saved-evidence absence and invalid saved completeness;
- missing and incomplete canonical evidence;
- point, appearance, and combined mismatch classification;
- duplicate, out-of-window, count, state, total, and limit integrity findings;
- missing and malformed team-window structures that fail visibly closed;
- exact result-count identities and finding truncation;
- platform-admin authorization, bounded reads, pagination, and absence of write APIs;
- pseudonymized UI evidence, loading/retry/partial states, and no client listener;
- unchanged Production Scoring V4, Projection V11, Rules, and indexes.

Use Node.js 22.23.1 and npm 11.17.0:

```bash
npm run test:batchd1m:run
npm run verify:batchd1m
npm run build:all
git diff --check
npm run release:verify-clean-deploy-source
```

The clean-deploy-source check is expected to reject an uncommitted worktree. Release conclusions require the exact clean Git commit, successful build/gate, live release manifest, and deployed Function evidence as separate checks.

## Isolated staging evidence protocol

The D1M staging harness is pinned to billed non-production project
`rinkrat-staging-d1nc-2026`. It refuses Production, every Emulator Suite
environment, a weak or missing fixture password, and any missing or incorrect
operation acknowledgement. The fixed synthetic paths are replaced only when
they already carry the exact D1M fixture marker. The harness cannot deploy a
Firebase resource.

The fixture contains one team and four finalized windows with deliberately
bounded outcomes:

- one verified zero / did-not-appear final with complete saved and canonical
  evidence;
- one complete-evidence score and appearance mismatch that must remain a
  review candidate;
- one complete saved final whose canonical game document is deliberately
  absent and must remain unverifiable; and
- one numeric saved final with missing saved D1L evidence that must remain
  unverifiable even though a canonical document exists.

A second synthetic Auth identity has no `platformAdmins` document. The live
runner requires that non-admin request to fail with `permission-denied` before
the platform-admin request is accepted. It then repeats the exact page request
and resolves the same cycle through the blank/latest-cycle path. Every response
must report `authority: detect-only`, `writesPerformed: 0`, a complete one-page
scan, and the exact expected aggregate and finding codes.

Before the first request and after every rejected, successful, repeated, and
latest-cycle request, the runner calculates a competitive-document fingerprint
over the fixed league, member, team, roster, cycle, matchup, team-window,
platform-admin, and canonical documents plus bounded transaction and playoff
absence. Any data or update-time change fails the run. Public output contains
only aggregate labels and counts; it excludes account IDs, emails, passwords,
player IDs, game IDs, source versions, scores, team pseudonyms, and raw roster
identifiers.

From a reviewed clean evidence commit, Stephen supplies a fresh shell-only
password and runs:

```bash
export D1M_STAGING_FIXTURE_PASSWORD='Aa1!<fresh-random-secret>'

D1M_STAGING_PROJECT_ID=rinkrat-staging-d1nc-2026 \
D1M_STAGING_ACK=reset-and-seed-rinkrat-d1m-final-score-reconciliation-fixture-v1-in-rinkrat-staging-d1nc-2026 \
D1M_STAGING_FIXTURE_PASSWORD="$D1M_STAGING_FIXTURE_PASSWORD" \
npm run staging:d1m:seed-reconciliation

D1M_STAGING_PROJECT_ID=rinkrat-staging-d1nc-2026 \
D1M_STAGING_RUN_ACK=exercise-d1m-final-score-reconciliation-in-rinkrat-staging-d1nc-2026 \
D1M_STAGING_FIXTURE_PASSWORD="$D1M_STAGING_FIXTURE_PASSWORD" \
npm run staging:d1m:exercise-reconciliation

unset D1M_STAGING_FIXTURE_PASSWORD
```

No Production write, deployment, migration, score correction, or manager data
is part of this protocol. Passing it proves only the bounded staging behavior
of the exact deployed D1M callable. Production release still requires a clean
merge commit, inherited gate/build, exact targeted selectors, deployed Function
revision, live Hosting manifest, and post-release read-only smoke evidence.

## Observability

Every successful server page emits a structured `Final-score reconciliation page inspected.` log with:

```text
adminKey (pseudonymized)
leagueId
cycleNumber
teamDocumentCount
finalizedGameCount
candidateGameCount
unverifiableGameCount
integrityIssueCount
scanComplete
teamDocumentCoverageChecked
inspectionIncomplete
findingsTruncated
```

The log deliberately excludes manager IDs, roster details, saved points, canonical points, and source hashes. Detailed evidence is returned only to the authenticated platform administrator and is not persisted by D1M-A.

Before a release conclusion, verify callable error rate and latency, the browser's complete-page count, cap/truncation flags, the exact Git/release manifest, and current Shadow/Canary configuration. A finding is investigation evidence, not correction approval.

## Deployment boundary

No deployment is part of this implementation. If a later clean release review approves D1M-A, deploy Functions before Hosting with only:

```text
functions:getFinalScoreReconciliationPage
hosting:app
```

No other Function executes this new detector. No Firestore Rules, indexes, TTL policies, App Check configuration, queue mode, worker concurrency, pending-task limit, canonical authority, migration, or production data write is required.

## Rollback

Deploy the prior Hosting build first to remove the admin entry point. The new callable is read-only and may safely remain dormant while the prior Functions source is restored. If full resource removal is later required, Stephen may delete only `getFinalScoreReconciliationPage` after confirming no approved client still calls it; Codex does not perform Function deletion.

Do not delete findings from league data because D1M-A stores none. Do not edit scores as part of rollback. Verify the live release manifest and deployed Function revision independently.

## Protected contracts unchanged

D1M-A does not change:

- Production Scoring V4 or Projection V11;
- six-game ownership or seventh-game rollover;
- immutable started/completed windows;
- Draft, add/drop, waiver, IR, or transaction authority;
- standings or playoff authority;
- Firestore Rules, indexes, or TTL;
- App Check mode;
- scoring queue mode, worker concurrency, or pending-task limits; or
- canonical Primary/Canary rollout state.

## Architecture recommendations not implemented

The following require separate approval and proof:

- durable all-league scheduling and checkpoint storage for universal detection;
- selective source reacquisition for archived games that lack usable canonical settlement;
- persisted finding lifecycle, retention, alerting, and resolution evidence;
- incremental/sharded affected-league index maintenance beyond the current bounded index;
- any correction plan for completed matchups; and
- exact-once correction mutation across windows, Game 7 ownership, transactions, standings, and playoffs.

D1M-A intentionally stops at bounded detection and administrator evidence.
