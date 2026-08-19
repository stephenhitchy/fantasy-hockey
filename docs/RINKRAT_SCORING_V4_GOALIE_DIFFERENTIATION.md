# Scoring Batch V4A — Team Goalie Differentiation

**Runtime release:** Release Candidate 50
**Competitive models:** Production Scoring V4 and Projection V11
**Migration authority:** guarded administrator script
**Primary change:** Team Goalie Unit only
**Unchanged:** every forward and defense scoring value, six-game windows, seventh-game rollover, roster timing, frozen projections, server authority, completed-window immutability

## Decision

The multi-season scoring audit did not support a broad skater rebalance. Forwards, defensemen, and the roster construction already produced recognizable NHL leaders, healthy positional value over replacement, strong season-long draft signal, and meaningful six-game upset potential.

The confirmed weakness was goalie-unit compression. Production Scoring V3 gave almost every respectable NHL team a similarly high and safe six-game result. The best units did not separate enough from the twelfth- and later-ranked units, which contributed to clustered goalie selections in Drafts.

Production Scoring V4 therefore changes only the Team Goalie Unit.

## Exact formula

### Skaters

All V3 skater rules are unchanged:

- forward and defense diminishing goal values;
- primary and secondary assists;
- shots, hits, and blocked shots;
- power-play and short-handed bonuses;
- game-winning and overtime-goal bonuses;
- forward TOI at `0.20` per minute;
- defense TOI plus/minus multiplier bounded from `0.24` to `0.31`.

No LW, C, or RW-specific multiplier was introduced. The historical RW difference was a talent/position-depth and classification effect, not a scoring defect.

### Team Goalie Unit

| Category | Scoring V3 | Production V4 |
|---|---:|---:|
| Completed NHL team game | 3 | **2** |
| Save | 0.27 | **0.20** |
| Win | 3.5 | **5** |
| Shutout | 4 | **5** |
| Save-quality base at .900 | 4 | **3** |
| Points per save-percentage point | 1.2 | **1.8** |
| Save-quality minimum | -3 | **-6** |
| Save-quality maximum | 10 | **14** |
| Per-game maximum | 28 | **None** |

V4 save quality is:

```text
3 + ((save percentage − .900) × 100 × 1.8)
```

bounded from `-6` to `+14`.

The complete goalie-game score is:

```text
2
+ (saves × .20)
+ save-quality points
+ 5 when the NHL team wins
+ 5 when the NHL team records a shutout
```

No final cap is applied.

## Intended effect

The historical sensitivity run predicted approximately:

| Six-game goalie result | V3 | V4 candidate |
|---|---:|---:|
| Overall mean | 104.9 | 93.5 |
| Median | 105.2 | 93.7 |
| Coefficient of variation | .161 | .256 |
| 10th percentile | 82.9 | 62.8 |
| 90th percentile | 126.4 | 124.0 |
| 99th percentile | 141.5 | 147.0 |
| 100+ frequency | 62.4% | 39.7% |

Approximate tier behavior:

| Tier | Mean | 100+ frequency |
|---|---:|---:|
| Elite goalie unit | 106.9 | 62.3% |
| Good starter-level unit | 99.4 | 51.0% |
| Poor unit | 82.2 | 22.9% |

These are historical design estimates rather than guarantees for a future NHL season. They are used as initial acceptance ranges.

## Why the cap was removed

The cap hid the difference between a merely strong performance and an extraordinary one. V4 instead limits the efficiency component itself while retaining the complete result. An exceptional win or shutout can therefore produce a memorable ceiling, and a high-volume poor-efficiency loss can no longer rely on saves and the participation base to remain artificially close to an elite result.

The Scoring Guide includes a direct quality-versus-volume comparison and labels V4 as uncapped.

## Projection and Draft integration

Goalie season points, recent form, next-six projections, stat breakdowns, Draft values, Player Intel, Add / Drop, Decision History, Roster Fit, share cards, and historical calibration all use the same V4 goalie constants.

Projection snapshots now include `scoringRulesVersion` in the deterministic root hash and use hash schema version 2. A V3 snapshot cannot be accepted as a V4 snapshot.

The projection worker refuses to build a new snapshot until the league document has been explicitly migrated to Scoring V4. This prevents a source deployment from silently generating V4 rankings for a league still scoring under V3.

V4 intentionally does not change Projection V11's non-scoring assumptions. After live V4 Draft evidence is collected, the separate goalie slot-curve component in Draft ranking must be reviewed before any additional scoring adjustment is considered.

## Existing-league migration

The migration is dry-run-only unless:

```text
RINKRAT_APPLY_SCORING_V4=APPLY
```

is supplied.

It changes only the versioned scoring/pre-Draft preparation boundary:

- the canonical V4 `scoringRules` map;
- `scoringRulesVersion: 4`;
- league scoring/update timestamps;
- the Draft's saved Projection V11 preparation/pin fields, which are marked for regeneration;
- the mutable `current` and `target-cycle-N` projection pointer documents, which are invalidated;
- one deterministic server audit document.

The immutable Projection V11 snapshot/chunk documents are retained as evidence. The migration does not rewrite:

- completed or active cycles;
- team windows;
- scored NHL games;
- standings;
- rosters;
- Draft picks;
- transactions;
- waivers;
- playoffs;
- immutable projection snapshot assets.

A league with any cycle history is blocked by default. This prevents a real league from mixing V3 completed windows with V4 future windows. One disposable historical test league can be migrated only with the exact league ID and the explicit test-only mixed-history guard:

```text
RINKRAT_ALLOW_MIXED_SCORING_HISTORY=ALLOW_TEST_LEAGUE_ONLY
```

The guard is unavailable for a global migration.

For a global preseason pass, use `--eligible-only`. That mode never bypasses a blocker: it migrates only leagues with no competition cycles, no Draft picks, and no live/complete Draft, while listing and leaving every blocked league unchanged.

After eligible leagues have fresh Scoring V4 Projection V11 pointers, the global inspector may use `--allow-legacy-history`. This accepts canonical V3 only when a league already has Draft-pick or competition-cycle history that must remain immutable. A V3 league with no history is still reported as an incomplete cutover.

## Cutover order

1. Verify RC50 locally.
2. Commit and build the exact revision.
3. Enter a quiet maintenance window: do not create, schedule, or start a Draft during the cutover.
4. Deploy the complete V4-aware Functions codebase so scoring, projection, league creation, Draft, cycle, and repair workers all use the same versioned source.
5. Make the verified RC50 browser available. The simplest tester-season path is to deploy RC50 Hosting now because it is dual-version-aware: existing V3 leagues remain V3 until migration, while V4 leagues are displayed correctly. A local verified RC50 build may be used instead when production Hosting must wait.
6. Run a global V4 dry run with `--eligible-only`; review every migration candidate and every skipped historical league.
7. Apply V4 to one exact eligible pre-Draft test league first.
8. Regenerate that league's verified Projection V11 snapshot from the RC50 interface.
9. Run the exact-league read-only V4 inspector and require a Scoring V4 current pointer with hash schema 2.
10. Apply the global `--eligible-only` migration to the remaining eligible leagues.
11. Regenerate Projection V11 for every migrated league.
12. Run the global inspector with `--allow-legacy-history`; require no no-history V3 league and no V4 projection mismatch.
13. Exercise one disposable six-game scoring window and one goalie-unit result, then end the maintenance window.

## Rollback boundary

Before any V4 Draft pick or competition cycle exists, the guarded preseason rollback can restore the exact V3 scoring map/version, invalidate mutable projection pointers, clear the Draft's projection pin, and require a known-good V3 Projection V11 regeneration. It retains immutable snapshot documents and never rewrites competition history.

After a league has scored an active or completed V4 game, do not silently roll it back to V3. That would create a mixed scoring season and violate manager trust. Freeze the affected league, preserve evidence, and make a deliberate correction or season-reset decision.

Completed immutable windows are never reopened merely to make historical totals resemble a new scoring formula.

## Acceptance gates

### Exact formula tests

- V3 and V4 rules remain separately reconstructable.
- Client and Functions scoring rules/engine remain byte-for-byte synchronized.
- A high-volume poor-efficiency loss scores below a low-volume excellent win.
- A game above 28 points retains the complete V4 total.
- Win, shutout, save volume, and save quality stack exactly once.
- Multiple goalies in one NHL team game aggregate into one unit result.

### Historical design targets

Initial V4 targets:

```text
Elite goalie mean:                100–112
Good goalie mean:                  92–102
Poor goalie mean:                  below 88
Goalie coefficient of variation:  .20–.28
Elite goalie 100+ frequency:       50–70%
Good goalie 100+ frequency:        35–60%
Poor goalie 100+ frequency:        below 25%
```

These are design targets informed by the recovered historical audit. They must be repeated against recent complete NHL seasons before V4 is considered permanently calibrated.

### Protected competition tests

- exactly six NHL team games per roster-slot window;
- seventh game enters the next window;
- no duplicate scoring;
- no duplicate transaction activation;
- completed windows remain immutable;
- multiple slot cycles remain allowed;
- server and browser scoring agree;
- projection snapshot scoring version and hash agree;
- historical stat correction cannot duplicate or shift a window.

## Deployment scope

V4A changes Functions, projection metadata/hash behavior, the browser scoring presentation, release metadata, documentation, and migration tooling.

It does not change Firestore Rules, Firestore indexes, TTL policies, App Check Monitor, the exact-league callable canary, scoring queue Shadow mode, or shared NHL cache Shadow authority.

## V4A.1 RC50 Angular compiler hotfix

The original RC50 package referenced `CURRENT_SCORING_RULES_VERSION` in League HQ's last-good Draft snapshot compatibility check without importing it. Angular correctly stopped the build with TS2304. V4A.1 imports the constant from the canonical client scoring-rules module and adds a focused regression assertion.

This is source wiring only. It changes no Production Scoring V4 value, legacy V3 reconstruction, Projection V11 calculation, snapshot hash, migration eligibility, six-game boundary, seventh-game rollover, or production setting.
