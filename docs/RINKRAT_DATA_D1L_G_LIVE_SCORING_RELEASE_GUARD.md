# RinkRat Data D1L-G: Live-Scoring Release Guard

## Purpose

This guard prevents a clean worktree that inherits D1L-G from silently
replacing the current live-scoring recovery behavior with the stale runtime
shape. It does not promise that the external NHL API will never fail. It
guarantees that Firebase predeploy fails closed if current or future source no
longer contains the reviewed D1L-F retry, jitter, throttle,
bounded-concurrency, retry-scheduling, and league-attribution controls.

A repository guard cannot execute from a historical revision created before
the guard existed. Any pre-D1L-G revision is therefore an invalid release
source even if it is clean. The operator must see all three success lines in
the predeploy log—clean source, protected roster, and protected live scoring—or
stop the release.

## 2026-10-06 incident

A broad Functions release from clean source `412c3b8b` replaced newer scoring
source with an older runtime. The older runtime retained only three critical
schedule attempts and did not add cross-instance 429 jitter. Production then
repeatedly exhausted Winnipeg/Washington schedule reads and later a Vegas
schedule read with HTTP 429 responses.

`Bar Down` remained safe but stale from `2026-10-06T23:08:13Z` until the
restored revision published at `2026-10-07T01:20:02Z`. Before recovery, 26
active player windows disagreed with the official live-game state. The restored
revision carried the D1L-F five-attempt/jittered throttle, and the complete
seven-league sweep ended at `2026-10-07T01:25:11Z` with seven successes, zero
failures, zero skips, and zero observed live-state mismatches.

This evidence is a point-in-time incident record, not permanent proof of
Production health. Every scoring release still requires fresh read-only live
evidence.

## Enforced source contract

`npm run release:verify-clean-deploy-source` now validates both clean Git source
and these live-scoring controls:

- ordinary NHL requests retain three bounded attempts;
- critical team-season schedules retain five bounded attempts;
- every attempt passes through the process-wide adaptive throttle gate;
- HTTP 429 retries retain zero-to-750-millisecond cross-instance jitter;
- queued retry permits retain 750-millisecond spacing;
- legacy scoring remains capped at two leagues in parallel;
- failed leagues remain scheduled for a bounded five-minute retry; and
- scheduled failures log the exact affected league ID.

Firebase runs that command before and after the Functions build. A source
change that reintroduces the runtime shape from `412c3b8b` therefore fails
before upload even when its Git tree is clean, provided the revision inherits
D1L-G. Never deploy `412c3b8b` or another pre-guard revision directly, and
never bypass or temporarily remove this guard to complete a release. An
intentional policy change must update the contract evaluator, its negative
regression fixtures, D1L-F documentation, and measured Production or isolated
staging evidence in one reviewed change.

The required successful predeploy markers are:

- `RinkRat clean-deployment guard passed`;
- `RinkRat protected roster runtime contract passed`; and
- `RinkRat protected live-scoring runtime contract passed`.

## Required post-release evidence

After Stephen deploys any Function importing the protected NHL/scoring path,
use read-only evidence to confirm:

1. every targeted Function is ACTIVE on the intended new revision;
2. `appData/leagueAutomation` records `status: success`, zero failed leagues,
   and zero skipped leagues for one complete post-release sweep;
3. every completed-Draft `leagueAutomationSchedules/{leagueId}` record has
   `lastOutcome: success` and `consecutiveFailureCount: 0`;
4. every active league published a newer `liveScoring/cycle-*` snapshot;
5. saved matchup totals equal snapshot `teamScores`;
6. saved player-window game states agree with the current official NHL game
   states, allowing only the expected cadence delay; and
7. no protected Function revision logged a new terminal scoring error.

Do not trigger a manual refresh merely to manufacture this evidence. Observe
the normal scheduled sweep. If the sweep fails, keep the last published score,
identify the exact league and upstream input, and allow the bounded retry path
to recover before considering a runtime change.

## Capacity warning

The successful incident-recovery sweep took about 491 seconds on a ten-minute
cadence. That is healthy but leaves limited headroom. The longest phase was
window-and-competition persistence, not NHL schedule loading. Do not increase
league or queue concurrency to hide that latency: more workers can worsen NHL
rate limiting. Optimize and measure persistence separately, then use the
existing queue Canary gates before changing queue mode or worker limits.

## Deployment and rollback

This D1L-G change modifies release tooling, tests, and documentation only. It
does not require a Firebase deployment.

Rollback by reverting the D1L-G commit. That removes the extra release guard
but does not change the deployed scorer or saved scores. Because the rollback
reopens the stale-source failure mode, retain it only long enough to repair a
false-positive guard and replace it with equivalent fail-closed coverage.
