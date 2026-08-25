# RinkRat Invite-Beta Release Freeze and Rollback Runbook

**Release tooling:** B1C
**Current product batch:** B1J
**Runtime release being frozen:** Release Candidate 65
**Purpose:** Turn the exact deployed beta build, Release Readiness evidence, production security posture, pinned toolchain, Git revision, and rollback order into one reviewable record before inviting the first observed cohort.

B1C remains the repository and release-operations tooling, and the tooling itself does not deploy or mutate production. This maintained runbook now targets the current Release Candidate 65 / Beta Batch B1J runtime; Production Scoring V4 and Projection V11 are the frozen competition models after the guarded preseason migration.

O1I.1 remains the verification-only TypeScript 6 correction: the isolated scoring regression writes a temporary Node16 project and invokes `tsc --project`, avoiding TS5112 without changing runtime code.

B1E added scanner-safe shareable league links, one explicit join-intent action, a bounded 72-hour local continuation, account binding, Training Camp and email-verification handoff, and resumption through the existing `joinLeagueSecure` transaction. B1F made the saved manager profile authoritative on every resume. B1G / RC62 withholds the first verification email until Training Camp is completed or deliberately deferred through **Finish Later & Verify**. Either server-visible outcome releases the retryable account email and returns invite-based registrations to the same saved invitation. B1H / RC63 preserves that authority and adds persistent navigation, history-aware Back controls, priority destinations, larger My Team actions, lower injury-report copy density, and bounded Draft entry/reload recovery. B1I / RC64 replaces the instruction-heavy Training Camp with five two-drill shifts, one visible idea at a time, simpler six-game language, session-scoped progress, and one-at-a-time viewport-safe position definitions. B1J / RC65 removes the quiz gate, preserves exact return from the Scoring Guide, simplifies the global navbar, shares league navigation between My Team and Matchup, and lets the Draft Room render before ranking reads finish. Commissioners retain the six-character code fallback, and invite codes remain redacted from application telemetry, beta diagnostics, CSP route collection, and session navigation history. RC62 Rules and Functions remain required; RC65 deploys Hosting only and changes no index, TTL policy, scoring formula, Projection V11 calculation, App Check mode, scoring-queue mode, or NHL-cache authority.

O1B adds the platform-admin Private Season Control Center, exact-build cohort freeze, privacy-limited tester matrix, and immutable approved/delayed gate decision. The control center is evidence support; it does not automatically approve the private season or change competition state.

O1C adds the platform-admin Private Season Health dashboard over the exact O1B league list. It records bounded verified-member route engagement through league-specific SHA-256 manager hashes, measures activation and Week 4 retention, reads exact-build reliability and unresolved integrity evidence, and stores audited weekly support/cost/commissioner-intent records. It does not approve the season automatically or promote any Shadow/canary control.

O1D adds the public Service Status page and private Incident Command Center. Active P0 incidents feed the private-season integrity gate; public guidance is stored separately from private evidence; resolved incidents are immutable; and no incident action may silently edit competitive truth.

O1E adds seven server-gated milestone surveys for verified members of the exact private-season cohort and one platform-admin research dashboard. Responses are stored with league-specific pseudonymous manager references and no raw account ID, email address, or phone number. The surveys support evidence collection but do not replace observed interviews or the full-season postmortem. O1E.1 is a source-only release-verification correction: the competition-design audit now follows the intentional unified Add / Drop successor instead of the retired Batch 7C.3 Free Agents composition, and `verify:batcho1i` explicitly reruns that corrected audit before release-manifest validation. O1E.2 makes League Dashboard finalization-date labels deterministic across UTC and Pacific development environments by pinning calendar-only display to UTC; it changes no scoring, window, or matchup authority.

O1G replaces repeated exact-release checks on O1B–O1F operational callables with operations API contract v1. After the RC57 compatibility Functions are deployed once, later browser-only releases may use Hosting-only deployment while the operations contract, Scoring V4, and Projection V11 remain unchanged. Formal Private Season approval and App Check canary evidence remain exact-build-bound.

O1H publishes the first public Fairness Report and public standard Scoring Guide. O1I adds the public exact Scoring V4 calculator and applies fixed contrast-safe colors to scoring-reference values and completed Game Center scoring breakdowns. B1E deployed the invite-code privacy redaction in Functions with RC60. B1G changed private Training Camp deferral fields, account-email Functions, browser continuation, validation evidence, and documentation, so RC62 required Firestore Rules, Functions, and Hosting. B1H changed only browser navigation and recovery surfaces in RC63. B1I and B1J change only browser presentation and navigation surfaces; RC65 therefore deploys Hosting only while the RC62 Rules and Functions remain live.

O1F adds the signed-in Privacy Center, immediate bounded JSON export, privacy-request operations, scheduled cleanup, and account-deletion pseudonymization. O1G subsequently replaces the former exact-release coupling with Operations API v1 compatibility, while sensitive writes still require a deployed release/build identity and the normal authority checks. The operational workflow remains subject to jurisdiction-specific legal review before public beta.

O1A.1 is a compiler-only correction for the Commissioner Playbook checklist normalizer. It widens the local membership allowlist to accept general string keys from `Object.entries()` while preserving the same six supported checklist IDs and all RC51 runtime behavior. O1A.2 is a Hosting-only dashboard timing clarification that replaces the generic matchup-active label with the date the current matchup is expected to finalize.

V4A changes only Team Goalie Unit scoring: 2 points per completed NHL team game, 0.20 per save, 5 for a win, 5 for a shutout, and save quality `3 + ((SV% - .900) × 100 × 1.8)` bounded from -6 to +14 with no per-game cap. Every skater value, the six-game boundary, seventh-game rollover, server authority, frozen-window projections, App Check Monitor, scoring Shadow, and shared NHL-cache Shadow remain unchanged. Legacy V3 reconstruction remains available for deliberately unmigrated or rollback-only records.

V4A.1 is the RC50 compiler-only import hotfix for League HQ Draft-snapshot compatibility. It adds no deployment resource, migration, scoring change, or projection change beyond the already documented V4A release.

A1I's bounded Coach's Briefing remains intact: at most three timely items, no more than one from each league, and no empty briefing card.

A1H makes Roster Fit the default Add / Drop ordering, limits replacement comparisons to legal exact-position roster options, and adds entertainment-only Weekly Power Rankings beside Official Standings. Official Standings remains the default and remains the sole playoff authority. A1H deploys Hosting only and adds no Function, listener, Rule, index, TTL policy, migration, runtime recommendation service, or competitive write.

A1G remains the transparent Move-lens foundation. Its factors and uncertainty stay visible, but A1H corrects the comparison pool so a candidate is never inflated by an unrelated weak position.

A1F remains the manager-private Decision History route from Add / Drop and Team Settings. It reads completed owner-private transaction projections once, joins them to today’s bounded Player Board data, and labels the comparison honestly rather than creating a frozen transaction-date grade.

A1C unifies Player Board and Add / Drop, adds same-layout roster selection, and queues replay-fresh Projection V11 snapshots after historical scoring. It deploys only `processHistoricalReplayAdvance`, `processProjectionGenerationTask`, and Hosting. It changes no Rule, index, TTL policy, App Check setting, scoring formula, projection algorithm, scoring-queue mode, or NHL-cache authority.

A1D fixes the RC41 replay-alignment defect by rebuilding the target-date player snapshot from progressively released source-season NHL game rows while retaining the target-season schedule for played, missed, and upcoming six-game markers. It also adds server-owned private Player Intel notes.

A1B is a Hosting-only player-discovery release. It reuses the existing verified shared projection snapshot, member-readable rosters, waiver projection, and private Watchlist callables; it adds no Function, Rule, index, TTL policy, migration, or background listener.

A1A adds a private account-wide Player Watchlist independent of Draft queues and completes the Clear Ice copy-density pass across 17 manager-facing templates. It deploys the two authenticated watchlist callables, the updated account-deletion callable, and Hosting. It adds no migration, listener, Rule, index, TTL policy, App Check change, scoring-queue change, or NHL-cache authority change.

C1K remains the server-authoritative Identity Architect foundation with the sixth Custom Identity scheme and top-right challenge-completion notice. C1J matchup and championship cards, C1I Round Recap awards, and C1H emoji-only mobile browsing also remain intact.

## Approved toolchain

RinkRat pins:

```text
Node 22.23.1
npm 11.17.0
```

The npm notice shown after a command is informational. Do not install a new npm major version merely because npm advertises it. A package-manager major update belongs in a separate maintenance release with clean installs, builds, emulator tests, dependency audits, and rollback evidence.

Inspect the current shell:

```bash
npm run toolchain:inspect
```

Restore the approved versions when needed:

```bash
nvm use 22.23.1
npm install -g npm@11.17.0
node --version
npm --version
```

Expected:

```text
v22.23.1
11.17.0
```

## Firestore TTL procedure

The safe recurring procedure is:

1. Inspect the current production policies.
2. Apply the source-controlled baseline only when a policy is missing, creating, unhealthy, or a new collection has been added to the baseline.
3. Inspect again until every expected policy is `ACTIVE`.

Inspect:

```bash
npm run security:inspect-ttl -- --project=nhl-fantasy-app-ab673
```

Apply only when needed:

```bash
RINKRAT_APPLY_TTL_SECURITY=APPLY \
npm run security:apply-ttl-baseline -- \
  --project=nhl-fantasy-app-ab673
```

The apply command is idempotent: it creates only missing policies. It is safe to rerun, but it should not be treated as a required step after every ordinary Hosting or Functions deployment. The current source baseline expects 10 active policies.

## Current release verification

After manually replacing the project files:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1
npm install -g npm@11.17.0
npm ci
npm --prefix functions ci
npm run verify:batchb1j
```

After the gate passes, deploy the changed browser surface only:

```bash
firebase deploy --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Beta B1J Tutorial Navigation Draft Readiness Release Candidate 65"
```

Commit and push the verified RC65 source:

```bash
git status
git add .
git commit -m "Complete RC65 B1J tutorial navigation and Draft readiness"
git push
```

Do not run the freeze command until the RC62 Firestore Rules and Functions remain deployed, RC65 Hosting is live, the B1G training-first verification matrix still passes, the B1H navigation/Draft-recovery browser checks pass, the B1I progressive Training Camp and position-help browser matrix passes, the B1J exact-return, simplified-navbar, shared-league-navigation, and slow/failing-ranking Draft matrix passes, every intended preseason league is migrated and inspected, each migrated league has a fresh Scoring V4 Projection V11 snapshot, and the live manifest identifies Release Candidate 65. The freeze tooling itself never deploys or mutates production.

## Production Scoring V4 preseason cutover prerequisite

V4A must be applied before any real 2026–27 Draft pick or competition window starts. The dry run and inspector are read-only. The apply command updates the versioned league scoring contract, invalidates mutable projection pointers and Draft projection-preparation fields, and writes one deterministic audit record. It retains immutable projection snapshot documents and never rewrites scores, cycles, windows, standings, rosters, Draft picks, transactions, or waivers.

Perform the cutover during a quiet maintenance window. Deploy the complete V4-aware Functions source and make the verified RC65 browser available before operating a V4 league. RC65 is dual-version-aware: historical V3 leagues continue displaying and scoring as V3 until an explicit migration, while eligible/new V4 leagues use V4. Do not create, schedule, or start a Draft during the brief Functions/Hosting transition.

Run the dry run:

```bash
npm run scoring:v4:migrate -- \
  --project=nhl-fantasy-app-ab673 \
  --eligible-only
```

The `--eligible-only` dry run lists every pre-competition league that may migrate and every historical/unsafe league that will be skipped. It never bypasses a blocker. Recreate preseason-only leagues when practical. Only one disposable historical test league may use the exact mixed-history guard documented in `docs/RINKRAT_SCORING_V4_GOALIE_DIFFERENTIATION.md`.

When the dry run is clean, migrate one exact pre-Draft test league first:

```bash
RINKRAT_APPLY_SCORING_V4=APPLY \
npm run scoring:v4:migrate -- \
  --project=nhl-fantasy-app-ab673 \
  --league=EXACT_PRE_DRAFT_TEST_LEAGUE_ID
```

Regenerate that league's Projection V11 snapshot from the verified RC65 interface, then inspect it:

```bash
npm run scoring:v4:inspect -- \
  --project=nhl-fantasy-app-ab673 \
  --league=EXACT_PRE_DRAFT_TEST_LEAGUE_ID
```

After the exact league passes, migrate the remaining eligible leagues:

```bash
RINKRAT_APPLY_SCORING_V4=APPLY \
npm run scoring:v4:migrate -- \
  --project=nhl-fantasy-app-ab673 \
  --eligible-only
```

Regenerate Projection V11 for every migrated league, then run the global inspection:

```bash
npm run scoring:v4:inspect -- \
  --project=nhl-fantasy-app-ab673 \
  --allow-legacy-history
```


Require a current Scoring V4 Projection V11 pointer using hash schema 2. Then apply the global eligible-only migration, regenerate Projection V11 for every migrated league, and run the global inspector with `--allow-legacy-history`. That allowance accepts V3 only where immutable Draft/cycle history already exists; any no-history V3 league remains an error. Draft and projection readiness must report the same Scoring V4 identity before a Draft opens.

A guarded preseason rollback exists only before any Draft pick or competition cycle is created:

```bash
npm run scoring:v4:rollback -- \
  --project=nhl-fantasy-app-ab673
```

The apply form requires the exact `RINKRAT_ROLLBACK_SCORING_V4=ROLLBACK_PRESEASON_ONLY` guard. Once any V4 cycle exists, do not rewrite league scoring rules; use the versioned stat-correction/incident process instead.

## C1B privacy-cutover prerequisite

The C1B transaction and waiver privacy cutover must already be complete before RC65 invite-beta freeze evidence is accepted. Confirm that the live browser uses owner-private transaction and claim projections, claim-free public waiver projections, and the final privacy Rules. The guarded migration, inspection, transition bridge, final lock, and rollback order remain documented in `docs/RINKRAT_SOCIAL_C1B_TRANSACTION_PRIVACY.md`. V4A changes no Firestore Rule, index, TTL policy, App Check setting, Projection V11 formula, scoring-queue mode, or NHL-cache authority.

## Preflight

After the working tree is clean:

```bash
npm run beta:preflight
```

Preflight verifies:

- Node 22.23.1 and npm 11.17.0 are active.
- The B1C tooling commit is clean.
- The live domain serves Release Candidate 65, Scoring V4, and Projection V11.
- The live manifest contains one clean source revision that exists in local Git history.
- HSTS and CSP report-only are live on `rinkratfantasy.com`.
- App Check monitor configuration is enabled and production debug mode is off.
- The `app` Hosting target still maps to `cycle-puck`.
- All 10 production TTL policies are active.
- The runtime release label remains RC65.

## Produce the exact-build validation JSON

On the deployed Release Candidate 65 Release Readiness page:

1. Run the deterministic full-season simulator.
2. Complete every required automated and manual item.
3. Confirm the launch gate says **Ready for a small invite-beta cohort**.
4. Press **Copy Validation Report**.

On the Mac, save the clipboard into a temporary JSON file:

```bash
pbpaste > "$HOME/Downloads/rinkrat-rc65-validation.json"
```

Validate that it is JSON:

```bash
node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); console.log('Validation JSON is readable.');" \
  "$HOME/Downloads/rinkrat-rc65-validation.json"
```

The freeze tool independently requires the report to contain:

- the same build ID and source revision as the live manifest;
- a `ready` launch gate;
- every required automated check passed;
- every required manual workflow passed;
- zero attention or untested manual items;
- a passing full-season simulator.

## Rollback rehearsal

Before freezing, rehearse rather than improvise:

1. Copy the current scoring queue rollback configuration from Release Readiness.
2. Confirm the production scoring queue is in **Shadow**.
3. Confirm the live source revision exists locally:

```bash
git cat-file -e "$(curl -fsSL https://rinkratfantasy.com/release-manifest.json | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).sourceRevision")^{commit}"
```

4. Review the RC65 Hosting rollback to the known-good corrected RC64 browser while retaining the separately proven RC62 Firestore Rules and Functions rollback selectors.
5. Confirm Firestore indexes are deployed only when an incident or known-good revision specifically requires them; C1B adds no index.
6. Confirm Release Readiness, action evidence, Function logs, and the known-issues workflow are available after rollback.

A rehearsal does not require intentionally breaking production or rolling back a healthy season. It requires proving that the exact source, commands, permissions, and decision order are understood and available.

## Freeze the invite-beta baseline

After GitHub Actions passes, Release Readiness is ready, the simulator passes, production queue mode is Shadow, and the rollback rehearsal is complete:

```bash
RINKRAT_FREEZE_INVITE_BETA=FREEZE \
npm run beta:freeze -- \
  --validation-report="$HOME/Downloads/rinkrat-rc65-validation.json" \
  --tag=rinkrat-rc65-invite-beta \
  --ci-passed \
  --rollback-rehearsed \
  --queue-shadow
```

The command creates ignored local records under:

```text
.beta-release/
```

It never deploys, creates a Git tag, changes queue mode, or writes competitive Firebase data.

Review the generated JSON and rollback Markdown, then create the annotated tag exactly as printed by the command. The tag deliberately points to the source revision recorded in the live RC65 manifest, not automatically to a newer release-tooling commit.

Example:

```bash
git tag -a rinkrat-rc65-invite-beta LIVE_SOURCE_REVISION \
  -m "RinkRat RC65 invite beta baseline"
git push origin rinkrat-rc65-invite-beta
```

Verify the tag:

```bash
npm run beta:verify-tag -- --tag=rinkrat-rc65-invite-beta
```

Verify the complete frozen state while RC65 remains live:

```bash
npm run beta:verify-freeze -- --tag=rinkrat-rc65-invite-beta
```

Regenerate the rollback plan later without changing the record:

```bash
npm run beta:rollback-plan -- --tag=rinkrat-rc65-invite-beta
```

## After the freeze

Proceed with the roadmap’s observed invite-beta phase:

- begin with 2–4 leagues and approximately 10–30 managers;
- include beginners, experienced managers, iPhone, Android, and another commissioner;
- keep Production Scoring V4 and Projection V11 frozen except for objective bugs handled through a versioned correction process;
- keep queued scoring in Shadow until one ordinary live canary league is ready;
- use the Beta Operations Center to classify integrity, blocker, serious UX, cosmetic, and idea reports;
- use real evidence to choose the next major feature rather than resetting the release for speculative changes.

## npm major-version notices

When npm prints a notice such as:

```text
New major version of npm available
```

use this decision rule:

```text
Project packageManager pin unchanged → do not upgrade
Named dependency/toolchain maintenance batch → upgrade deliberately, regenerate lockfiles, run the complete suite, and preserve rollback
```

Never run `npm audit fix --force` or a package-manager major upgrade as part of ordinary release verification or an emergency rollback.

## RC65 / B1J Hosting Release

Run the exact pinned gate from a clean RC65 checkout:

```bash
nvm use 22.23.1
npm --version  # must be 11.17.0
npm ci
npm --prefix functions ci
npm run verify:batchb1j
```

After every check passes, deploy only `hosting:app`. Validate exact Training Camp return, the simplified navbar, shared league quick navigation, and slow/failing projection behavior before closing the release. Functions, Rules, indexes, and TTL policies are outside this batch.

