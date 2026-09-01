# RinkRat Data Infrastructure Batch D1L-A

**Purpose:** finalized score-input integrity and durable canonical notification

**Implementation state:** locally committed feature-branch implementation and verification only; not deployed or proven against production

**Competitive authority:** direct NHL scoring remains authoritative and available as fallback

**Canonical rollout:** unchanged; Primary remains disabled and the Canary cohort is not expanded

## Acceptance criteria

D1L-A is acceptable only when all of the following are true:

1. A required final-game source failure is stored as explicit incomplete evidence, never as an authoritative zero or did-not-appear result.
2. A legitimate zero-point final is complete and reusable only after its asset-specific source contract passes.
3. An incomplete final remains active and retryable at the existing scoring cadence.
4. A numeric final is reused only with complete, deterministic source-version evidence.
5. Retrying the same game cannot add points, move six-game ownership, assign Game 7 again, reactivate a transaction, reapply standings, or advance playoffs twice.
6. A signal-worthy canonical publication and its deterministic downstream work record commit in one Firestore transaction.
7. Duplicate publication, trigger, or task delivery cannot create duplicate durable work or reopen delivered work.
8. An older canonical publication or task cannot clear or replace a newer source version.
9. Canonical parity reads and compares only the exact game IDs and source versions carried by its task.
10. Direct NHL scoring remains the authoritative fallback; no completed matchup is automatically corrected.

## Implemented behavior

### Final-input completeness contract

The direct scorer now retains every settled fetch outcome instead of dropping rejected promises. Final input is assessed per asset and game:

| Asset | Required final sources |
| --- | --- |
| Skater | structurally valid boxscore, structurally valid play-by-play, successfully retrieved player game log, deterministic source version |
| Team Goalie Unit | structurally valid boxscore, deterministic source version |

Stored outcomes distinguish:

- `complete`;
- `incomplete-boxscore`;
- `incomplete-play-by-play`;
- `incomplete-player-log`;
- `incomplete-source-version`;
- `temporarily-unavailable`; and
- `malformed`.

Failure details are bounded and marked retryable. A skater who appeared in the boxscore but is not yet present in a successfully retrieved final player log remains incomplete. A skater who did not appear and a Team Goalie Unit that did not appear can still settle to a legitimate, complete zero when their required sources are available.

Incomplete finals do not increment `gamesPlayed`, do not enter `completedGameIds`, and do not make the player window complete. If a trustworthy provisional score already existed, it may remain visible with `preservedPreviousScore: true`, but the final stays incomplete and cannot be reused. No new numeric score is invented when no trustworthy provisional score exists.

Per-game evidence is persisted in regular-season and playoff window snapshots through:

```text
gameInputCompleteness
incompleteFinalGameIds
hasIncompleteFinalGames
```

The last field keeps the existing standard or exact-Canary refresh cadence active while required final input is missing.

### Final-score reuse and safe retry

A stored final score is reusable only when all of these are present:

- game state is `final`;
- score is finite, including a legitimate `0`;
- completeness status is `complete`;
- `reusableFinal` is true; and
- the deterministic source version is a valid SHA-256 value.

Legacy numeric finals without this evidence are fetched again while their player window is active. Completed matchups remain outside the active scoring path and are not automatically corrected. Existing server transactions, scoring fingerprints, immutable-window rules, standings guards, playoff guards, and canonical task follow-up logic remain the exact-once boundaries after a successful retry.
A delayed incomplete scorer result cannot downgrade a slot window that a newer
retry already completed.

### Canonical final settlement

The canonical observer still performs player-log settlement at the established checkpoints: immediately after final, at five minutes, and at 28 minutes. Every checkpoint re-fetches relevant final player logs so post-final changes remain detectable. A missing or malformed required log records bounded evidence, leaves the checkpoint unadvanced, and retries while the game remains on the NHL scoreboard. This is bounded observation and is not the future universal Final Score Reconciler.

Canonical game documents expose:

```text
finalSettlementComplete
finalSettlementMissingPlayerIds
finalSettlementFailureReasons
finalInputCompletenessByAssetType
```

### Durable canonical publication handoff

For a canonical change that should signal downstream scoring, `nhlCanonicalGameFacts/{gameId}` and `nhlCanonicalPublicationOutbox/{gameId}_{sourceVersion}` are written atomically in one Firestore transaction. The outbox identity is deterministic and validates the canonical payload's exact game and source version.

The leased canonical poll drains at most 40 pending entries per run. Routing continues to use the bounded affected-league impact index and exact Canary fallback. Delivery uses the existing idempotent league request transaction. The outbox is marked delivered only after every affected request succeeds; failures remain pending with bounded retry evidence. A late duplicate failure cannot reopen delivered work. If the canonical game has already advanced to a newer source version, the older entry becomes `superseded` and cannot overwrite the newer request.

Canonical publication also uses compare-and-set against the source version read
by the observer. A stale observer cannot overwrite a newer canonical document
or create downstream work for its stale version. The feed persists a document-ID
cursor and wraps at the end of the pending set, so a stable failing first page
cannot permanently starve later pending entries.

This adds an Admin-SDK-only collection. Its `status == pending` query uses Firestore's automatic single-field index. No Rules, composite-index, or TTL change is required.

### Exact canonical parity scope

The queued task's normalized game/version pairs are now part of parity context. The loader reads only those exact game IDs and rejects a current canonical document whose source version differs from the task's version. The scorer compares only IDs in that requested set. Other active-window games do not emit `canonical-missing` evidence.

Direct-source incompleteness for a requested game emits parity status `incomplete`, not a numeric zero mismatch. Missing canonical data for a requested game remains `canonical-missing`.
Final canonical parity also requires the asset-specific canonical completeness
record to be complete and to carry the exact canonical source version. Missing,
malformed, or version-mismatched canonical evidence stays `incomplete` and
therefore retains direct fallback even if the incomplete facts happen to
produce the same number.

## Edge cases

- Partial `Promise.allSettled` success retains independent boxscore and play-by-play evidence.
- A malformed fulfilled payload is incomplete just like a rejected request, with a distinct reason.
- A missing appeared-skater entry in a successful final player-log response remains retryable.
- A valid no-appearance result remains distinguishable from missing source data.
- A duplicate canonical publication does not reset a delivered outbox entry.
- A stale canonical publisher cannot replace the version written by a newer observer.
- A failure reported after another worker delivered the same entry cannot return it to pending.
- Partial league delivery safely coalesces already-requested leagues on retry.
- A durable cursor rotates beyond a stable failing 40-entry page and wraps safely.
- An older outbox entry is superseded when the canonical game document carries a newer version.
- An older task completion leaves a newer request in `pending-follow-up`.
- Completed matchups and started-window ownership are not rewritten.

## Observability

Inspect these server-owned fields before any release conclusion:

```text
appData/nhlCanonicalImpactFeed.outboxLoadedCount
appData/nhlCanonicalImpactFeed.outboxDeliveredCount
appData/nhlCanonicalImpactFeed.outboxFailedCount
appData/nhlCanonicalImpactFeed.outboxCursorId
appData/nhlCanonicalImpactFeed.outboxStatus
nhlCanonicalPublicationOutbox/{id}.status
nhlCanonicalPublicationOutbox/{id}.attemptCount
nhlCanonicalPublicationOutbox/{id}.lastErrorCode
nhlCanonicalGameFacts/{gameId}.finalInputCompletenessByAssetType
leagueAutomationCanonicalParity/{leagueId}.versionMismatchGameIds
```

Also inspect incomplete final counts in saved scoring/window snapshots, queue age, duplicate/coalesced requests, transaction activation, standings application, playoff advancement, and Game 6-to-7 ownership. A persistent pending outbox entry or final input that remains incomplete after the expected NHL publication window requires investigation; it is not permission to substitute zero.

## Verification

Use the pinned Node.js 22.23.1 and npm 11.17.0 toolchain:

```bash
npm ci
npm --prefix functions ci
npm run test:batchd1l
npm run verify:batchd1l
npm run build:all
git diff --check
git status --short
npm run release:verify-clean-deploy-source
```

`test:batchd1l` starts the Firestore emulator and runs the complete D1L-A suite.
It exercises the real scorer retry and reuse path, Game 6-to-7 ownership,
atomic publication/outbox writes, stale-writer rejection, cursor fairness,
duplicate roster transaction activation, standings application, and playoff
progression. The clean-deploy-source gate is expected to refuse an uncommitted
implementation worktree; it must pass only from the exact clean commit selected
for release.

## Deployment boundary

No deployment is part of D1L-A implementation. If a later, clean release review approves this change, the runtime consumers requiring targeted Functions deployment are:

```text
pollCanonicalNhlImpactFeed
processLeagueAutomationTask
runScheduledLeagueAutomation
runSeasonStartAutomation
initializeSeasonAfterDraft
requestLeagueLiveScoringRefresh
processHistoricalReplayAdvance
```

No Hosting, Firestore Rules, composite indexes, TTL policies, App Check configuration, queue mode, worker concurrency, pending-task limit, migration, or canonical-authority rollout resource is changed. Do not broaden this selector without proving another deployed Function executes the changed scoring path.

## Rollback

Operationally return the scoring queue to Shadow first, preserving direct NHL fallback. Inspect and allow current idempotent work to settle. Revert the D1L-A source commit, rerun the prior inherited verification and build gates from a clean commit, and deploy only the seven affected Functions above. Leave canonical facts, scoring snapshots, and outbox records intact for audit; do not delete or rewrite league data. Verify the live release manifest and deployed Function revisions separately after rollback.

## Architecture recommendations not implemented

The following remain recommendations for later, separately approved work:

- a detect-only universal Final Score Reconciler for archived and completed matchups;
- measured retention or cleanup policy for delivered outbox evidence;
- administrator alerting and bounded inspection tools for persistent incomplete finals;
- automatic corrections only after exact-once proofs cover completed windows, transactions, standings, playoffs, and Game 7 ownership.

D1L-A does not implement those systems, automatically correct completed matchups, enable canonical Primary, expand Canary, or increase concurrency.
