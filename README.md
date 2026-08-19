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
- [`docs/RINKRAT_SOCIAL_C1G_LEAGUE_WIRE_REACTIONS.md`](docs/RINKRAT_SOCIAL_C1G_LEAGUE_WIRE_REACTIONS.md) — the full locally bundled Unicode Emoji 17 reaction catalog, verified-member server authority, same-listener mobile presentation, targeted deployment, and site-first proof.
- [`docs/RINKRAT_SOCIAL_C1H_PLAYER_OF_THE_ROUND.md`](docs/RINKRAT_SOCIAL_C1H_PLAYER_OF_THE_ROUND.md) — Player of the Round authority, emoji-only picker cleanup, phone category access, scroll behavior, targeted deployment, and site-first proof.
- [`docs/RINKRAT_SOCIAL_C1I_ROUND_AWARDS.md`](docs/RINKRAT_SOCIAL_C1I_ROUND_AWARDS.md) — Pickup of the Round, Biggest Upset from frozen team projections, bounded server evidence, targeted deployment, and site-first proof.
- [`docs/RINKRAT_SOCIAL_C1J_MATCHUP_SHARE_CARDS.md`](docs/RINKRAT_SOCIAL_C1J_MATCHUP_SHARE_CARDS.md) — browser-generated matchup and championship PNG cards, native mobile sharing, desktop fallback, privacy boundary, Hosting-only deployment, and site-first proof.
- [`docs/RINKRAT_SOCIAL_C1K_IDENTITY_ARCHITECT.md`](docs/RINKRAT_SOCIAL_C1K_IDENTITY_ARCHITECT.md) — server-reconciled identity challenges, a sixth custom logo/three-color scheme for every NHL team, top-right completion notifications, targeted deployment, and site-first proof.
- [`docs/RINKRAT_SOCIAL_C1L_DRAFT_STANDINGS_SHARE_CARDS.md`](docs/RINKRAT_SOCIAL_C1L_DRAFT_STANDINGS_SHARE_CARDS.md) — browser-generated Draft result and current-standings PNG cards, native mobile sharing, desktop fallback, Hosting-only deployment, and site-first proof.
- [`docs/RINKRAT_PRODUCT_A1A_WATCHLIST_CLEAR_ICE.md`](docs/RINKRAT_PRODUCT_A1A_WATCHLIST_CLEAR_ICE.md) — account-wide player watchlists independent of Draft queues, watched-only filters, the Clear Ice copy-density pass, targeted deployment, and site-first proof.
- [`docs/RINKRAT_PRODUCT_A1B_PLAYER_BOARD.md`](docs/RINKRAT_PRODUCT_A1B_PLAYER_BOARD.md) — one league-wide Player Board for rostered, available, waiver, reserved, and watched assets plus real Projection V11 Player Intel, Hosting-only deployment, and site-first proof.
- [`docs/RINKRAT_PRODUCT_A1C_UNIFIED_ADD_DROP.md`](docs/RINKRAT_PRODUCT_A1C_UNIFIED_ADD_DROP.md) — the unified Add / Drop player directory, same-layout roster selection, six-game trackers, injury return context, replay-driven Projection V11 refresh, targeted deployment, and site-first proof.
- [`docs/RINKRAT_PRODUCT_A1D_REPLAY_PLAYER_NOTES.md`](docs/RINKRAT_PRODUCT_A1D_REPLAY_PLAYER_NOTES.md) — replay-aligned source-season player statistics, target-season six-game markers, quiet snapshot freshness, private Player Intel notes, targeted deployment, and site-first proof.
- [`docs/RINKRAT_PRODUCT_A1E_WINDOW_SYNC_OPPORTUNITY.md`](docs/RINKRAT_PRODUCT_A1E_WINDOW_SYNC_OPPORTUNITY.md) — authoritative Game Center/Add / Drop roster-slot tracker parity, honest NHL-block fallbacks, compact next-six opportunity explanation, Hosting-only deployment, and site-first proof.
- [`docs/RINKRAT_PRODUCT_A1F_DECISION_HISTORY.md`](docs/RINKRAT_PRODUCT_A1F_DECISION_HISTORY.md) — manager-private completed Add / Drop history, current side-by-side player comparisons, the replay-refresh latency follow-up, Hosting-only deployment, and site-first proof.
- [`docs/RINKRAT_PRODUCT_A1G_TRANSPARENT_MOVE_LENS.md`](docs/RINKRAT_PRODUCT_A1G_TRANSPARENT_MOVE_LENS.md) — opt-in roster-fit ordering and an explainable selected-move lens with visible factors, uncertainty, Hosting-only deployment, and site-first proof.
- [`docs/RINKRAT_PRODUCT_A1H_POSITION_FIT_POWER_RANKINGS.md`](docs/RINKRAT_PRODUCT_A1H_POSITION_FIT_POWER_RANKINGS.md) — exact-position default Roster Fit, entertainment-only weekly Power Rankings, Hosting-only deployment, and site-first proof.
- [`docs/RINKRAT_PRODUCT_A1I_MANAGER_BRIEFING.md`](docs/RINKRAT_PRODUCT_A1I_MANAGER_BRIEFING.md) — a bounded personalized Coach's Briefing for injuries, recent waiver outcomes, close matchups, roster-slot boundaries, scheduled moves, and live Drafts.
- [`docs/RINKRAT_MOBILE_N1A_PWA_FOUNDATION.md`](docs/RINKRAT_MOBILE_N1A_PWA_FOUNDATION.md) — installable PWA shell, safe versioned caching, offline boundaries, release-worker coordination, Hosting deployment, and site-first proof.
- [`docs/RINKRAT_MOBILE_N1B_OFFLINE_MATCHUPS.md`](docs/RINKRAT_MOBILE_N1B_OFFLINE_MATCHUPS.md) — account-scoped saved Game Center snapshots, explicit stale/read-only presentation, exact-route privacy, Hosting-only deployment, and offline site proof.
- [`docs/RINKRAT_SCORING_V4_GOALIE_DIFFERENTIATION.md`](docs/RINKRAT_SCORING_V4_GOALIE_DIFFERENTIATION.md) — Production Scoring V4 formula, goalie differentiation evidence, guarded league migration, projection refresh, verification, cutover, and rollback boundaries.
- [`docs/RINKRAT_OPERATIONS_O1_TESTER_SEASON_PUBLIC_LAUNCH.md`](docs/RINKRAT_OPERATIONS_O1_TESTER_SEASON_PUBLIC_LAUNCH.md) — product and operations backlog derived from the 2026–27 tester-season/public-launch gameplan, including integrity, support, legal, funnel, commissioner, moderation, capacity, and launch-wave gates.
- [`docs/RINKRAT_OPERATIONS_O1A_COMMISSIONER_PLAYBOOK.md`](docs/RINKRAT_OPERATIONS_O1A_COMMISSIONER_PLAYBOOK.md) — public commissioner guide, league-specific readiness checks, Draft-night checklist, copy tools, recovery guidance, Hosting-only deployment, and non-founder commissioner proof boundary.
- [`docs/RINKRAT_SCORING_QUEUE_ROLLOUT_RUNBOOK.md`](docs/RINKRAT_SCORING_QUEUE_ROLLOUT_RUNBOOK.md) — Shadow, Canary, staging Primary, production lock, audit, and rollback procedure.
- [`docs/RINKRAT_HIGH_SCALE_AUTOMATION_BLUEPRINT.md`](docs/RINKRAT_HIGH_SCALE_AUTOMATION_BLUEPRINT.md) — queued-scoring foundation and remaining high-scale architecture.
- [`docs/RINKRAT_100K_CAPACITY_PLAN.md`](docs/RINKRAT_100K_CAPACITY_PLAN.md) — capacity-model interpretation and staged-load-test sequence.

## Current release and toolchain

The current source runtime is **Release Candidate 52 / Operations Batch O1B**. O1B adds a platform-admin Private Season Control Center for the exact 2026–27 proof cohort: 2–4 verified leagues with at least six tracked managers each, 10–30 unique privacy-limited tester aliases, required experience/device coverage, one non-founder commissioner, exact-build freeze, support/rollback/deputy readiness, live league evidence, revision history, and an immutable approved/delayed go/no-go decision. O1A.2 remains included and shows the expected matchup finalization date on each active League Dashboard card.

Production Scoring V4 from V4A remains unchanged. V4 keeps every forward and defense scoring value unchanged and rebalances only the Team Goalie Unit: lower participation/save background points, stronger win and shutout value, a wider continuous save-quality curve, and no per-game cap. RC49 saved read-only matchups, the installable PWA shell, A1I **Coach's Briefing**, exact-position default Roster Fit, Power Rankings, League Wire, and every other established manager surface remain intact.

Existing leagues do not switch scoring merely because Functions were deployed. V4A includes a guarded dry-run/apply migration, a read-only inspector, a projection hash-schema bump that includes the scoring version, and a hard projection-generation guard until the league is explicitly on Scoring V4. Completed cycle/window documents are never rewritten by the migration.

V4A.1 is a compiler-only hotfix for the RC50 source package. It restores the missing `CURRENT_SCORING_RULES_VERSION` import used by League HQ when validating a last-good Draft projection snapshot. It changes no scoring value, projection formula, migration rule, Firestore behavior, or deployed release identity.

Production Scoring V4, Projection V11 calculation, independent immutable six-game roster-slot windows, seventh-game rollover, server-authoritative competitive actions, transaction/waiver privacy, App Check Monitor, the inactive exact-league/callable canary, scoring queue Shadow, and shared NHL cache Shadow are the current protected baseline. The current verification command is `npm run verify:batcho1b`.

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
verify:batchc1g
verify:batchc1h
verify:batchc1i
verify:batchc1j
verify:batchc1k
verify:batchc1l
verify:batcha1a
verify:batcha1b
verify:batcha1c
verify:batcha1d
verify:batcha1e
verify:batcha1f
verify:batcha1g
verify:batcha1h
verify:batcha1i
verify:batchn1a
verify:batchn1b
verify:batchv4a
verify:batcho1a
verify:batcho1b
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
npm run verify:batcho1b
```

After verification and a clean commit:

```bash
npm run beta:preflight
```

## Operations Batch O1A — Commissioner Playbook

O1A advances the tester-season commissioner-independence work without adding competition authority. The public `/commissioner-guide` route explains the six-game format, setup order, Draft-night checklist, weekly operations, recovery rules, and common commissioner questions. Current league commissioners can open `/leagues/{leagueId}/commissioner` from League HQ to see existing account, manager-count, Draft-order, Draft-time, and Projection V11/Scoring-version readiness evidence.

Checklist state is device-local convenience data. Copy tools never send messages automatically. O1A adds no Function, Rule, index, TTL policy, migration, or competitive write. Demo-league work and observed proof that a non-founder commissioner can operate a complete league remain open.

O1A.1 corrects strict Angular compilation for the device-local checklist normalizer by declaring its membership-only allowlist as `ReadonlySet<string>`. The six supported checklist IDs remain the same, unknown keys still fail closed, and no persisted or competitive behavior changes.

O1A.2 improves League Dashboard timing clarity by replacing the generic matchup status badge with the expected finalization date of the current matchup.

Verification:

```bash
npm run verify:batcho1b
```

Full guidance is in `docs/RINKRAT_OPERATIONS_O1A_COMMISSIONER_PLAYBOOK.md`.

## Scoring Batch V4A — Team Goalie Differentiation

V4A retains the complete Production Scoring V3 skater model unchanged and replaces only the Team Goalie Unit values. Production V4 uses a 2-point completed-game base, 0.20 per save, 5 for a win, 5 for a shutout, and a continuous save-quality formula of `3 + ((SV% - .900) × 100 × 1.8)` bounded from -6 to +14. The former 28-point game cap is removed.

The guarded migration is dry-run-only unless `RINKRAT_APPLY_SCORING_V4=APPLY` is present. Leagues with cycle or Draft-pick history are blocked by default. The global `--eligible-only` option safely migrates only pre-competition leagues and skips every blocked/history league. One exact disposable historical test league may use the separately named mixed-history override. Applying V4 invalidates only mutable projection pointers and Draft projection-preparation fields while retaining immutable snapshot documents. Projection V11 must then be regenerated and inspected because its deterministic hash now includes Scoring V4. The global inspector may use `--allow-legacy-history` to accept V3 only for leagues that already have competition history; a no-history league left on V3 remains an incomplete cutover issue.

Verification:

```bash
npm run verify:batchv4a
```

Migration sequence:

```bash
npm run scoring:v4:migrate -- --project=nhl-fantasy-app-ab673 --eligible-only
# Apply one exact eligible league first, regenerate Projection V11 in the site, then inspect it.
npm run scoring:v4:inspect -- --project=nhl-fantasy-app-ab673 --league=EXACT_LEAGUE_ID
# After all eligible leagues are migrated/regenerated, inspect globally while preserving historical V3 leagues.
npm run scoring:v4:inspect -- --project=nhl-fantasy-app-ab673 --allow-legacy-history
```

Full guidance is in `docs/RINKRAT_SCORING_V4_GOALIE_DIFFERENTIATION.md`.

## Mobile Batch N1B — Saved Read-Only Matchups

N1B completes the roadmap's clearly labeled stale matchup access. After an online Game Center view fully loads, RinkRat stores a sanitized copy in account-scoped browser IndexedDB. Offline navigation loads only the matching league, cycle, and matchup, shows its exact saved time and source release, and removes every competitive control. The store is limited to 12 matchups per account, seven days, and 350 KB per snapshot; logout clears that account's copies.

N1B adds no Function, Firestore record, Rule, index, TTL policy, Background Sync, offline mutation queue, or competitive write.

Verification:

```bash
npm run verify:batchn1b
```

N1B deploys RC49 Hosting only. Full guidance is in `docs/RINKRAT_MOBILE_N1B_OFFLINE_MATCHUPS.md`.

## Mobile Batch N1A — Installable PWA Foundation

N1A makes the existing website installable without creating a separate native-code fork. Supported browsers receive the native installation prompt; browsers that require **Add to Home Screen** receive concise manual guidance in Account Settings. The mobile More menu shows an install action only while a native prompt is actually available.

A root-scoped production service worker caches a versioned public application shell, the current built JavaScript/CSS discovered from the deployed index, and later stable same-origin assets. Navigation is network-first, release identity and proxy/security routes remain network-only, and cross-origin Firebase/NHL traffic is never intercepted. The worker handles GET requests only and never queues a competitive action while offline. Waiting workers activate only when the manager approves the existing release reload.

Verification:

```bash
npm run verify:batchn1a
```

N1A deploys RC48 Hosting only. Full guidance is in `docs/RINKRAT_MOBILE_N1A_PWA_FOUNDATION.md`.

## Product Batch A1I — Manager Briefing

A1I completes the first personalized manager-home feed with one compact **Coach's Briefing** above the league grid. The browser prioritizes at most one item per league and at most three total, using only the existing bounded Dashboard activity reads plus one owner-private, twelve-record waiver-outcome read for post-Draft leagues. It can surface unavailable starters, recent waiver awards/misses/clears, a live Draft, a close late matchup, roster slots one NHL team game from rollover, or scheduled moves.

The briefing has no empty state, description paragraph, permanent listener, new Firestore Rule, index, TTL policy, Function, migration, or competitive write. It disappears when nothing needs attention and leaves the full league cards as the lower-priority status surface.

Verification:

```bash
npm run verify:batcha1i
```

A1I deploys only RC47 Hosting. Full guidance is in `docs/RINKRAT_PRODUCT_A1I_MANAGER_BRIEFING.md`.

## Product Batch A1H — Exact-Position Roster Fit and Weekly Power Rankings

A1H makes **Roster fit (for you)** the default Add / Drop ordering and restricts every replacement comparison to the candidate's exact position. A center is compared only with legal centers, a defenseman only with legal defensemen, and a Team Goalie Unit only with another Team Goalie Unit. A compatible open slot remains valid; otherwise RinkRat says there is not enough comparison evidence rather than using an unrelated weak player.

League Standings adds an optional **Weekly Power Rankings** tab. The transparent entertainment-only score uses 35% official record, 25% points per completed matchup, 20% point differential, and 20% last-three regular-season form. Official Standings remains the default and decides playoff qualification and seeding. A1H deploys Hosting only. Full guidance is in `docs/RINKRAT_PRODUCT_A1H_POSITION_FIT_POWER_RANKINGS.md`.

## Product Batch A1G — Transparent Roster Fit and Move Lens

A1G adds an opt-in **Roster fit (for you)** sort to Add / Drop and one compact **Move lens** after the manager chooses a legal incoming/outgoing combination. The feature uses only existing Projection V11 and roster evidence, presents simple directional factors, lowers confidence when data is weak, and explicitly excludes waiver priority, competing claims, future injuries, and exact activation timing.

A1H later makes Roster Fit the default and restricts comparisons to exact-position legal options; managers may still choose Next 6 or any other sort. Explanations expand inline only when requested, and no Function, listener, Rule, index, TTL policy, migration, runtime recommendation service, or competitive write is added. RC45 deploys Hosting only. Full guidance is in `docs/RINKRAT_PRODUCT_A1G_TRANSPARENT_MOVE_LENS.md`.


## Product Batch A1F — Decision History

A1F adds one manager-private **Decision History** route linked from Add / Drop and Team Settings. It reads at most 75 completed owner-private transaction projections once, excludes pending/queued/canceled outcomes, and joins each recorded added/dropped asset to today's bounded Player Board metrics. Current Season and Next 6 deltas are transparent arithmetic, not a grade or black-box recommendation.

A1F also records the A1.16 work-in-progress performance item for replay player-data catch-up latency. RC44 deploys Hosting only and adds no Function, listener, Rule, index, TTL policy, migration, or competitive mutation. Full guidance is in `docs/RINKRAT_PRODUCT_A1F_DECISION_HISTORY.md`.


## Product Batch A1E — Window Sync and Next-Six Opportunity Lens

A1E makes active rostered-player progress in Add / Drop and Player Intel come from the same authoritative fantasy roster-slot window used by Game Center. General Projection V11 schedules remain available for free agents, Bench, and IR, but are labeled as NHL blocks rather than fantasy Matchups. Player Intel’s existing Schedule tab also includes one bounded Next-six lens showing at most three transparent availability, schedule, rest, role, or form factors.

A1E deploys RC43 Hosting only. It adds no Function, listener, Firestore Rule, index, TTL policy, migration, or competitive mutation. Full guidance is in `docs/RINKRAT_PRODUCT_A1E_WINDOW_SYNC_OPPORTUNITY.md`.


## Product Batch A1B — League Player Board and Player Intel

A1B uses `/leagues/:leagueId/players` for the league-wide **Player Board** and `/leagues/:leagueId/players/:assetKey` for **Player Intel**. `/leagues/:leagueId/leaders` remains the focused **Point Leaders** history page. The board reads the verified shared Projection V11 snapshot plus bounded league roster, public waiver, and private Watchlist state to show every draftable asset in one searchable surface.

Rows include current-season fantasy points, all-position rank, position rank, next-six projection, ownership status, and Watchlist state. Selecting a row opens `/leagues/:leagueId/players/:assetKey`; Overview, Stats, Projection, and Schedule sections keep deeper data out of the default view. Pending incoming assets are labeled only as unavailable; their destination manager and slot stay private. Free Agent and Waiver names also link to Player Intel.

A1B deploys RC40 Hosting only. It adds no Function, permanent listener, Firestore Rule, index, TTL policy, migration, or competitive mutation. Full guidance is in `docs/RINKRAT_PRODUCT_A1B_PLAYER_BOARD.md`.


## Product Batch A1A — Player Watchlist and Clear Ice

A1A adds one server-owned account watchlist with a 100-asset bound and separate **Watch** and **Queue** actions. Draft Room, Available Players, and Waivers share the same watched state and watched-only filters without another persistent listener or any competitive mutation. The Clear Ice pass removes repeated descriptions across 17 manager routes and adds a source-controlled copy-density audit while retaining safety-critical guidance.

Verification:

```bash
npm run verify:batcha1a
```

A1A deploys `getPlayerWatchlist`, `setPlayerWatchlistEntry`, `deleteMyAccount`, and RC39 Hosting. It adds no Firestore Rule, index, TTL policy, App Check change, scoring-queue change, or NHL-cache authority change. Full guidance is in `docs/RINKRAT_PRODUCT_A1A_WATCHLIST_CLEAR_ICE.md`.


## Social Batch C1L — Draft and Standings Share Cards

C1L completes the first share-card set with two browser-only 1080×1080 PNG exports. **Share my draft** appears only after the Draft is complete and uses the signed-in manager's team, Draft slot, total picks, and up to six completed picks. **Share standings** exports the current period and up to the top eight ranked teams with records, points for, point differential, and the playoff cut line. Both use native mobile file sharing first and a local PNG download fallback. No Function, listener, Rule, index, TTL policy, or migration is added.

Verification:

```bash
npm run verify:batchc1l
```

C1L deploys only RC38 Hosting. Full guidance is in `docs/RINKRAT_SOCIAL_C1L_DRAFT_STANDINGS_SHARE_CARDS.md`.



## Social Batch C1K — Identity Architect

C1K makes team identity progression server-authoritative and adds a sixth **Custom Identity** option to every NHL team. Completing First Line Change, Commissioner Mode, League Explorer, and Crowded Schedule unlocks Identity Architect. The inline editor lets a manager choose among that team's available logos and save a custom primary, secondary, and tertiary site palette. Newly completed challenges appear one at a time in a top-right notification with a direct link to Account Settings. The final Rules lock routes challenge rewards and team-identity changes through server authority while allowing public-profile repair only when it mirrors the private profile.

Verification:

```bash
npm run verify:batchc1k
```

C1K deploys `reconcileTeamIdentityChallenges`, the updated `saveManagerProfile`, RC37 Hosting, and the final server-only challenge-reward Rules lock. Full guidance is in `docs/RINKRAT_SOCIAL_C1K_IDENTITY_ARCHITECT.md`.



## Social Batch C1J — Matchup Share Cards

C1J adds one inline **Share result** action to completed League Wire Game Finals. It creates a 1080×1080 RinkRat PNG in the browser from the existing sanitized final, supports native mobile file sharing, falls back to a local download, and gives championships a distinct Champion treatment. It creates no Firestore document, Function, listener, Rule, index, TTL policy, or migration.

Verification:

```bash
npm run verify:batchc1j
```

C1J deploys only RC36 Hosting. Full guidance is in `docs/RINKRAT_SOCIAL_C1J_MATCHUP_SHARE_CARDS.md`.


## Social Batch C1I — Round Recap Awards

C1I reuses the existing `publishLeagueRoundRecapActivity` trigger and League Wire card. A qualifying same-cycle completed acquisition may become Pickup of the Round based on final skater-window points. A final winner may become Biggest Upset when its frozen team projection was lower than the opponent's, ranked by the projected gap. Optional awards disappear when evidence is incomplete rather than guessing or blocking a valid recap.

Verification:

```bash
npm run verify:batchc1i
```

The release updates only `publishLeagueRoundRecapActivity` and RC35 Hosting. Full guidance is in `docs/RINKRAT_SOCIAL_C1I_ROUND_AWARDS.md`.

## Social Batch C1H — Player of the Round and Mobile Emoji Picker

C1H reads the authoritative completed team-window documents only after a regular-season cycle first becomes complete. It validates owner, cycle, slot, status, asset, and score boundaries before storing at most three tied public performer summaries plus the final score and total tie count. The existing Round Recap then shows Top team, Player of the Round, and Closest as three compact mobile-readable lines.

The reaction picker no longer contains Quick Picks or custom artwork. Existing legacy/custom IDs normalize to 🏒, 🔥, 😮, 🐀, or 😂, while all new selections come from the standard local Emoji 17.0 catalog. A native category selector and bounded vertical result scroller make every category and progressively disclosed result reachable on phones without a modal or extra listener.

Verification:

```bash
npm run verify:batchc1h
```

The release updates only `publishLeagueRoundRecapActivity`, `setLeagueActivityReaction`, and RC34 Hosting. Full guidance is in `docs/RINKRAT_SOCIAL_C1H_PLAYER_OF_THE_ROUND.md`.

## Social Batch C1G — League Wire Reactions

C1G established the complete locally generated Unicode Emoji 17.0 keyboard/display catalog on eligible Draft picks, completed roster and waiver outcomes, final matchups, commissioner announcements, and Round Recaps. C1H removes the later custom quick row, so search and standard categories now expose every selectable reaction. One verified manager can hold only one reaction per item; selecting another switches it, and selecting the same option removes it. The server validates exact catalog membership, derives totals from a bounded member record set, treats retries idempotently, and preserves the existing short and rolling-window throttles.

Reaction fields stay on the existing server-owned activity document. The browser therefore keeps the same two Firestore listeners and uses the current activity snapshot to show both totals and the signed-in manager's selection. The 3,944-entry catalog is a local lazy chunk rather than part of the initial application bundle. The inline picker adds no modal, sticky element, Firestore Rule, index, TTL policy, social subcollection listener, npm picker dependency, or remote emoji service.

Verification:

```bash
npm run verify:batchc1g
```

C1G.1 preserves strict Functions TypeScript compilation in the rate limiter. C1H retains that fix and maps every retired quick/custom identifier back to its standard emoji equivalent.

The current owner workflow is the C1I automated gate, targeted deployment of `publishLeagueRoundRecapActivity`, RC35 Hosting, and a short site-first completed-round smoke test. Reaction authority and mobile picker guidance remain in `docs/RINKRAT_SOCIAL_C1G_LEAGUE_WIRE_REACTIONS.md`; current release guidance is in `docs/RINKRAT_SOCIAL_C1I_ROUND_AWARDS.md`.

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


## Product Batch A1C — Unified Add / Drop and Replay-Fresh Player Data

A1C retires the duplicate Player Board route component and makes **Add / Drop** the single league player directory. Free agents are the default view and next-six projection is the default sort. Managers can still browse every rostered, waiver, unavailable, watched, or position-specific player, open Player Intel, and make a secure roster decision from the same surface.

The incoming player and valid outgoing roster choices use the same mobile-first player-row format. Each player row includes Matchup number, six numbered game markers, season points, ranks or projections, availability status, and a return date when known. The existing server-authoritative transaction and waiver callables remain the only competitive writers.

Historical replay scoring queues an asynchronous Projection V11 refresh after NHL games are released. An exact current-pointer listener reloads the unified page only when a new verified snapshot becomes authoritative. A catch-up check queues a newer snapshot when another replay day moved ahead during an existing projection build. The refresh never rolls back or blocks completed scoring.

Full verification, targeted deployment, site-first proof, and rollback guidance are maintained in `docs/RINKRAT_PRODUCT_A1C_UNIFIED_ADD_DROP.md`.

## Product Batch A1D — Replay-Accurate Player Data and Private Notes

A1D keeps the RC41 unified Add / Drop flow while correcting its historical-replay inputs. The server projection worker maps source-season player and goalie game rows onto target-season schedule positions, releases only rows whose simulated target date has passed, retains future games in the current six-game block, and publishes refreshed Season Points, stats, ranks, recent form, and markers through the existing current pointer. Projection V11 math and authoritative scoring do not change.

Player Intel now includes one private inline note per player. The authenticated server callables enforce plain text, 500 characters, eight lines, and a 100-player account cap; the browser never chooses the owner identity, and account deletion removes the note document.

Full verification, targeted deployment, site-first proof, and fallback diagnostics are maintained in `docs/RINKRAT_PRODUCT_A1D_REPLAY_PLAYER_NOTES.md`.

