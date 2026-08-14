# RinkRat Fantasy

Core project references:

- [`docs/RINKRAT_PROJECT_DOCUMENTATION.md`](docs/RINKRAT_PROJECT_DOCUMENTATION.md) — consolidated architecture, release history, deployment, and testing guidance.
- [`docs/RINKRAT_COMPETITIVE_ROADMAP.txt`](docs/RINKRAT_COMPETITIVE_ROADMAP.txt) — permanent completed/in-progress tracker from invite beta through public-scale competition.
- [`docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md`](docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md) — pinned Node/npm toolchain, TTL procedure, exact-build validation export, freeze record, annotated beta tag, and application rollback rehearsal.
- [`docs/RINKRAT_FIRESTORE_BACKUP_RESTORE_RUNBOOK.md`](docs/RINKRAT_FIRESTORE_BACKUP_RESTORE_RUNBOOK.md) — native backup schedules, delete protection, optional PITR, named-database restore drills, verification, cleanup, and recovery evidence.
- [`docs/RINKRAT_BETA_OPERATIONS_RUNBOOK.md`](docs/RINKRAT_BETA_OPERATIONS_RUNBOOK.md) — beta issue severity, triage, public known issues, live evidence, privacy, deployment, and rollback.
- [`docs/RINKRAT_SECURITY_S3C_RUNBOOK.md`](docs/RINKRAT_SECURITY_S3C_RUNBOOK.md) — CI, dependency/secret auditing, CSP report-only, HSTS, TTL, cleanup, and emergency patch procedure.
- [`docs/RINKRAT_SECURITY_S3D_IDENTIFIER_BOUNDARIES.md`](docs/RINKRAT_SECURITY_S3D_IDENTIFIER_BOUNDARIES.md) — Firestore identifier policies, task/trigger boundary rules, static audit, deployment, and rollback.
- [`docs/RINKRAT_SECURITY_S3E_APP_CHECK_READINESS.md`](docs/RINKRAT_SECURITY_S3E_APP_CHECK_READINESS.md) — exact-build App Check evidence gates, supported-browser matrix, selected-callable canary handoff, compact mobile injury status, deployment, and rollback.
- [`docs/RINKRAT_SECURITY_S3E_1_DRAFT_IR_HOTFIX.md`](docs/RINKRAT_SECURITY_S3E_1_DRAFT_IR_HOTFIX.md) — non-blocking Draft scheduling, verified Projection V11 background preparation, displaced-starter bench preservation during IR activation, deployment, and rollback.
- [`docs/RINKRAT_SECURITY_S3E_1_1_DRAFT_PREPARATION_TYPE_HOTFIX.md`](docs/RINKRAT_SECURITY_S3E_1_1_DRAFT_PREPARATION_TYPE_HOTFIX.md) — strict TypeScript narrowing for persisted Draft preparation states without changing the S3E.1 runtime contract.
- [`docs/RINKRAT_SECURITY_S3F_APP_CHECK_CALLABLE_CANARY.md`](docs/RINKRAT_SECURITY_S3F_APP_CHECK_CALLABLE_CANARY.md) — exact-build evidence revalidation, exact-league and exact-callable App Check canary routing, health proof, audit history, and emergency monitor rollback.
- [`docs/RINKRAT_DATA_D1A_SCORE_FRESHNESS.md`](docs/RINKRAT_DATA_D1A_SCORE_FRESHNESS.md) — manager-facing score timing, honest NHL correction language, first restore-drill evidence, and backup recurrence inspection.
- [`docs/RINKRAT_DATA_D1A_1_TIMESTAMP_TYPE_HOTFIX.md`](docs/RINKRAT_DATA_D1A_1_TIMESTAMP_TYPE_HOTFIX.md) — strict Angular TypeScript narrowing for Firestore timestamp-like values without changing score-freshness behavior.
- [`docs/RINKRAT_DATA_D1B_INJURY_MATCH_QUALITY.md`](docs/RINKRAT_DATA_D1B_INJURY_MATCH_QUALITY.md) — categorized ESPN-to-NHL identity matching, bounded candidate context, source-controlled aliases, intentionally ignored individual goalies, deployment, and rollback.
- [`docs/RINKRAT_DATA_D1C_SHARED_NHL_CACHE_SHADOW.md`](docs/RINKRAT_DATA_D1C_SHARED_NHL_CACHE_SHADOW.md) — deterministic shared NHL Shadow cache, hash deduplication, bounded payloads, retention, inspection, deployment, and future cutover gates.
- [`docs/RINKRAT_SOCIAL_C1A_LEAGUE_WIRE.md`](docs/RINKRAT_SOCIAL_C1A_LEAGUE_WIRE.md) — member-only League Wire, server-sanitized public outcomes, waiver and queued-action privacy boundaries, bounded mobile UX, deployment, smoke test, and rollback.
- [`docs/RINKRAT_SOCIAL_C1B_TRANSACTION_PRIVACY.md`](docs/RINKRAT_SOCIAL_C1B_TRANSACTION_PRIVACY.md) — owner-private transaction and claim projections, claim-free waiver pool, guarded backfill, privacy inspection, staged cutover, smoke test, and coordinated rollback.
- [`docs/RINKRAT_SOCIAL_C1C_MATCHUP_RESULTS.md`](docs/RINKRAT_SOCIAL_C1C_MATCHUP_RESULTS.md) — one-event final matchup activity, playoff/championship context, no live-score spam, Functions-first deployment, mobile smoke testing, and rollback.
- [`docs/RINKRAT_SOCIAL_C1D_COMMISSIONER_TRANSPARENCY.md`](docs/RINKRAT_SOCIAL_C1D_COMMISSIONER_TRANSPARENCY.md) — public commissioner Draft controls and player-availability overrides, privacy boundaries, targeted deployment, and live-site proof.
- [`docs/RINKRAT_SOCIAL_C1E_COMMISSIONER_ANNOUNCEMENTS.md`](docs/RINKRAT_SOCIAL_C1E_COMMISSIONER_ANNOUNCEMENTS.md) — commissioner-only plain-text announcements, optional pinning, bounded League Wire presentation, targeted deployment, and live-site proof.
- [`docs/RINKRAT_SOCIAL_C1F_ROUND_RECAPS.md`](docs/RINKRAT_SOCIAL_C1F_ROUND_RECAPS.md) — one immutable regular-season round recap, top-score and closest-finish context, League Wire-era scoring high-water, targeted deployment, and site-first proof.
- [`docs/RINKRAT_SCORING_QUEUE_ROLLOUT_RUNBOOK.md`](docs/RINKRAT_SCORING_QUEUE_ROLLOUT_RUNBOOK.md) — Shadow, Canary, staging Primary, production lock, audit, and rollback procedure.
- [`docs/RINKRAT_HIGH_SCALE_AUTOMATION_BLUEPRINT.md`](docs/RINKRAT_HIGH_SCALE_AUTOMATION_BLUEPRINT.md) — queued-scoring foundation and remaining high-scale architecture.
- [`docs/RINKRAT_100K_CAPACITY_PLAN.md`](docs/RINKRAT_100K_CAPACITY_PLAN.md) — capacity-model interpretation and staged-load-test sequence.

## Current release and toolchain

The current source runtime is **Release Candidate 32 / Social Batch C1F**. C1F adds exactly one server-created regular-season round recap after an authoritative matchup cycle first becomes complete. The recap highlights the top team score and closest finish while leaving live score changes, byes, playoffs, one-game rounds, and historical backfill off the wire.

The recap reuses the existing bounded League Wire listener and mobile card. It adds no modal, backdrop, sticky panel, or additional browser query. Commissioner announcements and optional pinning from C1E remain unchanged. A server-only high-water mark can identify a strictly higher score in a later League Wire-era round without claiming an all-time record from pre-C1F history.

Production Scoring V3, Projection V11, independent immutable six-game roster-slot windows, seventh-game rollover, server-authoritative competitive actions, App Check Monitor, the inactive exact-league/callable canary, scoring queue Shadow, shared NHL cache Shadow, Firestore Rules, indexes, and TTL remain unchanged. The current verification command is `npm run verify:batchc1f`.

Historical verification checkpoints remain available and intentionally stay documented for regression and rollback work:

```text
verify:batchr1f
verify:batchp1e
verify:batchp1f
verify:batchp1f-1
verify:batchs1a
verify:batchs1b
verify:batchs1c
verify:batchs2a
verify:batchs2a-1
verify:batchs2b
verify:batchs2b-1
verify:batchs3a
verify:batchs3a-1
verify:batchs3a-2
verify:batchs3b
verify:batchs3b-1
verify:batchs3c
verify:batchb1a
verify:batchb1b
verify:batchb1b-1
verify:batchb1c
verify:batchs4a
verify:batchb1d
verify:batchs3d
verify:batchs3e
verify:batchs3e-1
verify:batchs3e-1-1
verify:batchs3f
verify:batchd1a
verify:batchd1a-1
verify:batchd1b
verify:batchd1c
verify:batchc1a
verify:batchc1b
verify:batchc1c
verify:batchc1d
verify:batchc1e
verify:batchc1f
```

RinkRat pins:

```text
Node 22.23.1
npm 11.17.0
```

Do not automatically follow npm major-version notices. Restore the pinned version unless a named maintenance release deliberately changes `packageManager` and revalidates the complete project.

## Current verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1
npm install -g npm@11.17.0
npm ci
npm --prefix functions ci
npm run verify:batchc1f
```

After verification and a clean commit:

```bash
npm run beta:preflight
```




## Social Batch C1F — Matchup Round Recaps

C1F observes the existing server-authoritative cycle document and publishes exactly once when a regular-season round first changes to `complete`. It summarizes only immutable completed matchup records from that round, names the top team score and closest finish, skips scheduled byes, and fails closed when any real matchup is incomplete or malformed.

The first eligible post-deployment round establishes a server-only League Wire-era high-score baseline without being labeled a record. A later strictly higher score may be called a new League Wire scoring high. Ties are deterministic, retries are idempotent, out-of-order trigger delivery cannot overclaim a record, and existing completed rounds are intentionally not backfilled.

Verification:

```bash
npm run verify:batchc1f
```

The normal owner workflow is one automated gate, a targeted deployment of `publishLeagueRoundRecapActivity`, RC32 Hosting, and a short site-first smoke test. Firestore Rules, indexes, TTL, scoring, projections, commissioner announcements, transaction privacy, and queue/cache modes are not deployed for C1F. Full guidance is in `docs/RINKRAT_SOCIAL_C1F_ROUND_RECAPS.md`.


## Social Batch C1E — Commissioner Announcements

C1E lets the live league commissioner post a bounded title and message to League Wire and optionally replace the single pinned announcement shown above recent activity. The server verifies authentication, verified email, and the current commissioner inside one Firestore transaction; deterministic request identity makes retries idempotent, and a short server-only rate limit prevents accidental rapid duplicates.

Pinned content uses the existing member-only activity collection and an exact document named `pinned-announcement`. It omits the feed's ordered `occurredAt` field, so the existing 40-item query never returns the pinned snapshot a second time. Unpinning removes only the pin; the original immutable League Wire entry remains in history.

Verification:

```bash
npm run verify:batchc1e
```

The normal owner workflow is one automated gate, a targeted deployment of `publishLeagueAnnouncement` and `unpinLeagueAnnouncement`, RC31 Hosting, and a short site-first smoke test. Firestore Rules, indexes, TTL, scoring, projections, and queue/cache modes are not deployed for C1E. Full guidance is in `docs/RINKRAT_SOCIAL_C1E_COMMISSIONER_ANNOUNCEMENTS.md`.


## Social Batch C1D — Commissioner Transparency

C1D observes two existing authoritative surfaces. The Draft trigger publishes only when the saved Draft transitions because the actual commissioner opened it, paused its clock, or resumed it. Automatic server openings, automatic recovery, and a first manager starting the initial clock are not mislabeled as commissioner actions.

The player-availability trigger publishes only a successful league-specific status change or removal after verifying the saved actor still matches the league commissioner. It copies the bounded player name and public status, but never the commissioner note, raw player/document ID, request identity, or failed attempt.

Verification:

```bash
npm run verify:batchc1d
```

The normal owner workflow is one full verification gate, a targeted deployment of the two new Functions plus RC30 Hosting, and a short site test from Player Availability. Firestore Rules, indexes, TTL, scoring, projections, and queue/cache modes are not deployed for C1D. Full guidance is in `docs/RINKRAT_SOCIAL_C1D_COMMISSIONER_TRANSPARENCY.md`.


## Social Batch C1C — League Wire Matchup Results

C1C observes the existing server-owned matchup document and publishes exactly once when it first changes from `active` to `complete`. The deterministic activity ID combines the cycle and matchup identity only before hashing; raw source IDs, score ledgers, player scoring, projections, seeds, request IDs, and administrative details are never copied to League Wire.

The feed labels the item **Game Final** and resolves team names and manager icons from the existing league-team input. The UI adds no listener, modal, backdrop, sticky panel, or duplicate dialog. Existing completed matchups are intentionally not backfilled.

Verification:

```bash
npm run verify:batchc1c
```

The normal owner workflow is one full `verify:batchc1c` gate, a targeted deployment of the new matchup publisher plus RC29 Hosting, and a live-site Internal Test matchup. The scoped `social:inspect-matchup-activity` command and Function logs are fallback diagnostics only when the site result is missing, duplicated, or incorrect. C1C itself requires no Firestore Rules or index deployment. Full commands and rollback guidance are documented in `docs/RINKRAT_SOCIAL_C1C_MATCHUP_RESULTS.md`.


## Social Batch C1B — Transaction and Waiver Privacy

C1B removes the browser from the canonical transaction and waiver collections. New Firestore triggers project each manager's own transaction history and waiver claim to owner-only paths, while members receive only a claim-free waiver pool and allowlisted completed outcomes. Deterministic hashed transaction IDs preserve idempotency without exposing raw source IDs.

The Free Agents surface keeps its existing mobile decision flow but replaces public claim counts with **Your claim is private**, **Review Your Claim**, or **Claim details stay private**. Commissioners still adjudicate through the existing server-authoritative callable and receive outcome text from the server response.

Verification:

```bash
npm run verify:batchc1b
```

C1B.1 corrects only the Firestore Rules test harness by making intentionally denied writes lazy; RC28 runtime behavior and the final Rules file are unchanged.

The deployment order is mandatory: Functions only, guarded dry-run/apply backfill, zero-issue inspector, temporary dual-read transition Rules, RC28 Hosting, RC28 smoke proof, and final privacy Rules. No index deployment is required. Full commands, smoke tests, and staged rollback are documented in `docs/RINKRAT_SOCIAL_C1B_TRANSACTION_PRIVACY.md`.


## Social Batch C1A — League Wire

C1A adds the first bounded social-retention feature before full chat. League HQ listens to at most 40 server-owned activity projections and shows five recent items by default in one inline card. Managers can see new joins, selected league lifecycle actions, Draft picks, completed add/drop and IR outcomes, adjudicated waivers, and queued roster moves only after activation.

Three create-only Functions sanitize existing audit, Draft-pick, and transaction records into `leagues/{leagueId}/activity/{activityId}`. Deterministic hashed IDs make retries idempotent without exposing raw source IDs. Browsers may read the projection only as league members and cannot create, update, or delete it.

Verification:

```bash
npm run verify:batchc1a
```

Before deploying, confirm the D1C tenth TTL policy is active because the prior handoff did not record production proof:

```bash
npm run security:inspect-ttl -- \
  --project=nhl-fantasy-app-ab673
```

Deploy Rules, the complete Functions codebase, and Hosting together for RC27:

```bash
firebase use nhl-fantasy-app-ab673
firebase deploy \
  --only firestore:rules,functions,hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Social C1A League Wire Release Candidate 27"
```

Do not deploy indexes or promote App Check, the scoring queue, or the shared NHL cache. Existing leagues are not backfilled; create a new public league/Draft/roster event in one Internal Test league for the production smoke test. Full behavior, privacy gates, and rollback steps are documented in `docs/RINKRAT_SOCIAL_C1A_LEAGUE_WIRE.md`.




## Data Infrastructure Batch D1C — Shared NHL Cache Shadow Foundation

D1C begins the P0 shared-ingestion work without changing the RC26 browser build or allowing cached data to affect competition. Successful server-owned NHL schedule, game, player-log, statistics, roster, scoreboard, injury, bounded proxy, and roster-timing requests are canonicalized into deterministic SHA-256 document keys and observed in `nhlSharedDataCache`.

The shared documents remain explicitly non-authoritative. Unchanged payloads are suppressed by content hash, route-specific freshness and expiration dates are recorded, observations are bounded to 100 in flight per instance, and JSON larger than 700 KiB is skipped and measured rather than risking a Firestore document-size failure. The existing upstream response remains the only value returned to scoring, projection, Draft, replay, and roster logic.

Verification:

```bash
npm run verify:batchd1c
```

Deployment is Functions-only:

```bash
firebase use nhl-fantasy-app-ab673
firebase deploy --only functions -m "Data D1C shared NHL cache Shadow foundation"
```

Activate the newly source-controlled tenth TTL policy once, then inspect Shadow coverage after a score refresh, projection run, or historical replay:

```bash
RINKRAT_APPLY_TTL_SECURITY=APPLY \
npm run security:apply-ttl-baseline -- \
  --project=nhl-fantasy-app-ab673

npm run data:inspect-nhl-shared-cache -- \
  --project=nhl-fantasy-app-ab673
```

Do not deploy Hosting, enable shared-cache reads, or claim capacity improvement from D1C alone. The later cutover still requires oversized-payload storage, direct-versus-shared hash parity, staging canary reads, freshness/stat-correction proof, cost measurements, and rollback.


## Data Quality Batch D1B — Injury Identity Match Quality

The shared ESPN injury report now records why a skater identity was not matched instead of exposing only one unexplained total. The commissioner Player Availability page separates missing names, ambiguous identities, alias maintenance, and safe team or position discrepancies. It also shows bounded current-roster suggestions that are never applied automatically.

Individual ESPN goalie entries are counted separately and intentionally ignored because RinkRat uses Team Goalie Units. Verified exceptions remain source controlled in `functions/src/shared/core/player/injury-player-aliases.ts`, and Release Readiness exposes injury identity coverage as a non-blocking advisory.

Verification:

```bash
npm run verify:batchd1b
```

Deployment:

```bash
firebase use nhl-fantasy-app-ab673
firebase deploy --only functions -m "Data D1B injury identity match quality"
firebase deploy --only hosting:app -m "Data D1B Release Candidate 26"
```

No Firestore Rules, indexes, TTL, PITR, or backup deployment is required.

## Data Quality Batch D1A.1 — Live-Scoring Timestamp Type Hotfix

The Angular TypeScript 6 build rejected a required `{ nanoseconds: number }` assertion after the value had only been proven to contain numeric `seconds`. D1A.1 narrows the unknown Firestore timestamp-like value once as `Record<string, unknown>`, validates `seconds` and `nanoseconds` independently, and safely defaults missing nanoseconds to zero.

Runtime behavior is unchanged. Score-freshness wording, timing thresholds, Scoring V3, Projection V11, App Check controls, queue routing, Firestore configuration, and recovery settings remain identical.

Verification:

```bash
npm run verify:batchd1a-1
```

The failed D1A build stopped before Hosting deployment, so after verification and a clean commit:

```bash
npm run build:all
firebase use nhl-fantasy-app-ab673
firebase deploy --only hosting:app -m "Data D1A.1 RC25 timestamp type hotfix"
```

No Functions, Firestore Rules, indexes, TTL, PITR, or backup deployment is required.

## Security Batch S3F — Exact Internal Test League App Check Canary

S3F installs a server-owned runtime control for the first deliberately bounded App Check enforcement exercise. The control defaults to Monitor and cannot promote itself. After RC27 independently passes the exact-build browser, device, platform, manager-day, and competitive-action evidence gates, a recently authenticated platform administrator may select an exact set of callables and no more than five exact leagues already marked Internal Test.

Only a request matching both an approved callable and an approved Internal Test league may be rejected for missing or mismatched App Check context. Every other callable and league remains monitor-only. The server rechecks readiness, validates the Internal Test allowlist, stores an immutable administrator audit entry, records privacy-limited allowed/blocked proof, and preserves a recently authenticated emergency route back to Monitor that does not depend on App Check.

Commands:

```bash
npm run security:audit-app-check-canary
npm run test:batchs3f:run
npm run verify:batchs3f
```

Deploy Functions first, then Hosting. No Firestore Rules, indexes, TTL, or backup configuration changes are part of S3F. Full operator guidance is maintained in `docs/RINKRAT_SECURITY_S3F_APP_CHECK_CALLABLE_CANARY.md`.


## Security Batch S3E.1.1 — Draft Preparation Status Type Hotfix

The strict Functions build identified that `FantasyDraft['projectionPreparationStatus']` includes `undefined` because the model property is optional. The automation path now narrows persisted request values through a dedicated four-state type guard before assigning them to the local `status | null` variable. No optional indexed-property cast remains.

Runtime behavior is unchanged: Draft scheduling still saves after one bounded preparation acknowledgement, server automation still waits safely for a verified Projection V11 board, App Check remains monitor-only, and scoring remains in Shadow.

Verification:

```bash
npm run verify:batchs3e-1-1
```

Because the original Functions deployment stopped at compilation, deploy the complete S3E.1 Functions set after this hotfix passes:

```bash
firebase use nhl-fantasy-app-ab673
firebase deploy --only functions -m "Security S3E.1.1 Draft preparation type hotfix"
firebase deploy --only hosting:app -m "Security S3E.1 RC25 Draft and IR hotfix"
```

No Firestore Rules or index deployment is required.

## Security Batch S3E.1 — Draft Scheduling and IR Roster Preservation

S3E.1 removes complete Projection V11 generation from the Draft-settings request path. Draft Setup now starts or reuses one verified preparation request, saves the scheduled time after acknowledgement, and lets server automation wait in `waiting-projection` until the board is fully server-generated, catalog-validated, and hashed. No Draft can open or Auto-Draft against an unverified board.

IR activation now preserves an occupied starter:

```text
Open bench:  displaced starter → bench; nobody dropped
Full bench:  displaced starter → selected bench slot; selected bench occupant → waivers
```

Reserved bench spots are excluded, and both immediate and started-window server authorities enforce the same rule.

Verification:

```bash
npm run verify:batchs3e-1
```

Deployment requires all Functions first, then Hosting:

```bash
firebase use nhl-fantasy-app-ab673
firebase deploy --only functions -m "Security S3E.1 Draft schedule and IR roster preservation"
firebase deploy --only hosting:app -m "Security S3E.1 RC25 Draft and IR hotfix"
```

No Firestore Rules or index deployment is required.

## Security Batch S3E — Exact-Build App Check Readiness and Mobile Injury Clarity

S3E adds a monitor-only readiness gate to Admin Center → Live Evidence. The server evaluates only evidence produced by the exact deployed build and reports whether the documented sample, browser, device, manager-day, competitive-action, and 99% verification thresholds have been met.

A passing gate means only **ready to plan a selected-callable canary**. It does not turn enforcement on. Firestore App Check enforcement remains a separate later step.

On mobile Matchup rows, injury status is now bounded to a compact presentation such as:

```text
✚ IR · Return Sep 15
✚ Out · Return TBD
```

The full article remains on the player detail page instead of occupying the matchup lineup.

Verification:

```bash
npm run verify:batchs3e
```

Deployment requires Functions first, then Hosting:

```bash
firebase use nhl-fantasy-app-ab673
firebase deploy --only functions -m "Security S3E App Check readiness evidence"
firebase deploy --only hosting:app -m "Security S3E RC25 readiness and mobile injury clarity"
```

No Firestore Rules or index deployment is required.

## Security Batch S3D — Universal Firestore Identifier Boundary Closure

S3D adds one shared normalized resolver, server-side path guards, semantic policies for league/user/request/task/pick/slot/asset/snapshot/catalog/invite/player/feedback/fingerprint IDs, and a source-controlled boundary inventory covering 13 authority modules.

The static audit rejects direct interpolation of `event.params`, `request.auth.uid`, `request.data`, or Cloud Tasks payload IDs into Firestore paths. It also verifies every task/trigger surface uses the shared resolver and that projection/Draft/replay cross-references are validated before lookup.

Verification:

```bash
npm run verify:batchs3d
```

Deployment requires Functions first, then Hosting so the current RC22 release identity and documentation match the hardened server authorities:

```bash
firebase use nhl-fantasy-app-ab673
firebase deploy --only functions -m "Security S3D Firestore identifier boundary closure"
firebase deploy --only hosting:app -m "Security S3D Release Candidate 22"
```

No Firestore Rules or index deployment is required.

## Onboarding Batch B1D — Big-Play Winger Comparison Clarity

B1D replaces the football-specific label **outside wide receivers** with the more beginner-friendly **big-play wide receivers** and leads with the plain-language idea **fewer chances, bigger scoring swings**. The card explains that one limited opportunity can create a strong fantasy week, while missed chances can produce a much quieter matchup.

Verification:

```bash
npm run verify:batchb1d
```

Deployment is Hosting-only:

```bash
firebase use nhl-fantasy-app-ab673
firebase deploy --only hosting:app -m "Onboarding B1D big-play winger comparison"
```

## Security Operations Batch S4A — Firestore Backup and Restore Rehearsal

S4A adds repository-controlled disaster-recovery operations without changing the then-current RC21 application runtime:

- production Firestore delete-protection inspection and guarded activation;
- daily backups retained 14 days;
- weekly Sunday backups retained 12 weeks;
- safe refusal when an existing daily/weekly recurrence conflicts with the baseline;
- optional, separately confirmed PITR activation;
- newest-READY-backup selection and restore planning;
- restore only into a new `restore-drill-*` database;
- privacy-limited comparison of critical collections and sampled league contracts;
- guarded restore-drill cleanup;
- source-controlled TTL field overrides so future index deployments preserve all ten active policies.

Inspect the baseline:

```bash
npm run security:backup:inspect -- --project=nhl-fantasy-app-ab673
```

Follow the full rehearsal sequence in:

```text
docs/RINKRAT_FIRESTORE_BACKUP_RESTORE_RUNBOOK.md
```

S4A has **no Angular, Functions, Rules, or Hosting deployment**. Google Cloud backup schedules, delete protection, optional PITR, and a temporary named restore database are managed only through the guarded operator commands in the runbook.

## Beta Operations Batch B1C — Invite-Beta Release Freeze and Rollback Tooling

B1C adds:

- exact Node/npm release preflight;
- live RC27 manifest, HSTS, CSP report-only, App Check, Hosting target, and 10/10 TTL checks;
- exact-build Release Readiness JSON validation;
- explicit GitHub CI, Shadow-mode, and rollback-rehearsal gates;
- ignored `.beta-release/` baseline and rollback records;
- annotated-tag verification against the actual deployed source revision.

B1C has **no Firebase deployment**. Commit and push the tooling, finish the exact RC27 Release Readiness board and full-season simulator, then follow:

```text
docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md
```

## Firestore TTL operating rule

Inspect first:

```bash
npm run security:inspect-ttl -- --project=nhl-fantasy-app-ab673
```

Apply only when a policy is missing, creating, unhealthy, or newly added to the source baseline:

```bash
RINKRAT_APPLY_TTL_SECURITY=APPLY \
npm run security:apply-ttl-baseline -- \
  --project=nhl-fantasy-app-ab673
```

The apply command is idempotent but is not required after every ordinary deployment. Keep the local index configuration synchronized with the same policies:

```bash
npm run security:sync-ttl-index-config -- --check
```
