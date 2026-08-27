# RinkRat Data Infrastructure Batch D1I

**Candidate:** RC66 / D1I
**Purpose:** Automatic season fallback, measured queue-capacity evidence, and conservative Primary launch gates
**Competitive authority:** D1H canonical authority remains limited to one exact Internal Test Canary; direct and legacy scoring remain the proven fallbacks
**Rollout scope:** Production-safe monitoring and fallback controls; no automatic worker tuning or Primary promotion

## Why this batch exists

D1H can identify stale feed/dispatcher heartbeats, excessive backlog, enqueue failures, missing schedule coverage, parity problems, and an opened canonical circuit breaker. Before D1I, those alerts still depended on the platform owner seeing the panel and manually selecting a safer scoring path.

D1I closes that operational gap without making the scoring architecture more aggressive:

- one server-owned watchdog evaluates scoring safety every minute;
- one unsafe observation produces a warning, not an immediate mode change;
- two consecutive queue-wide blocking observations return the queue to Shadow;
- two consecutive canonical-only blocking observations disable only canonical authority;
- every automatic action uses the existing revision-checked configuration and immutable audit trail;
- live queue-task duration is summarized hourly over a rolling fourteen-day window;
- Primary remains locked until the watchdog is healthy and measured queue capacity covers every active completed-Draft league with operating headroom;
- no process automatically increases workers, queue admission, league caps, or Primary scope.

## Automatic season fallback

The scheduled Function is:

```text
monitorLeagueAutomationSeasonSafety
```

Schedule and runtime boundary:

```text
Every minute
us-central1
maxInstances: 1
timeout: 60 seconds
no automatic retries
```

The watchdog reads only server-owned operational evidence:

```text
appData/leagueAutomationQueueConfig
appData/leagueAutomation
appData/nhlCanonicalImpactFeed
appData/leagueAutomationSeasonWatchdog
appData/leagueAutomationCapacityEvidence
```

Canonical parity documents are read by the watchdog only while a canonical-read authority experiment is actually configured. Ordinary Shadow and queued-direct Canary observation do not repeatedly scan the parity cohort.

### Two-strike confirmation

A single unsafe check records a warning streak. The watchdog acts only when the same class of blocking condition is present on two consecutive checks.

This avoids changing scoring mode because of one transient delayed heartbeat or one brief queue spike.

### Queue-wide fallback

The following conditions can become queue-wide blockers:

- scoring dispatcher heartbeat is stale;
- scoring backlog exceeds ten minutes;
- the latest dispatcher pass has enqueue failures;
- completed-Draft leagues are missing scoring schedules;
- Primary queue p95 exceeds the conservative ceiling;
- Primary measured capacity no longer covers the active league target;
- Primary capacity evidence is stale.

After two consecutive queue-wide blocking checks, D1I:

1. changes queue mode to `shadow`;
2. removes canonical authority;
3. preserves the exact Canary and Internal Test selections for diagnosis;
4. increments the server-owned configuration revision;
5. records an immutable `season-watchdog-returned-to-shadow` audit record;
6. leaves the legacy scorer available as the live authority;
7. allows already-created idempotent queue tasks to drain safely.

### Canonical-only fallback

The following conditions are canonical-only blockers while canonical authority is configured:

- canonical NHL feed heartbeat is stale;
- canonical feed/game requests repeatedly fail;
- current canonical-versus-direct parity is incomplete or mismatched;
- the canonical circuit breaker is open.

After two consecutive canonical-only blocking checks, D1I:

1. removes only canonical authority;
2. keeps queue mode Canary;
3. keeps queued direct NHL scoring active;
4. opens the authority record as a direct-fallback circuit;
5. increments the audited configuration revision;
6. records a `season-watchdog-canonical-fallback` audit record;
7. requires new D1G shadow-parity proof before canonical authority can be re-enabled.

A canonical problem therefore does not disable queued direct scoring and does not require a manual fantasy-point correction before the league can continue.

### Shadow behavior

Shadow is already the safest observation state. While the queue is in Shadow, the watchdog:

- records an `observing` heartbeat;
- resets warning streaks;
- performs no additional automatic fallback;
- never promotes the queue or canonical authority.

## Measured queue-capacity evidence

The scheduled Function is:

```text
refreshLeagueAutomationCapacityEvidence
```

It runs once per hour and writes one bounded summary to:

```text
appData/leagueAutomationCapacityEvidence
```

The refresh reads the existing privacy-limited `betaOperationsDaily` shards for the last fourteen UTC days. With sixteen daily shards, one refresh reads at most 224 small aggregate documents. The Control Center and Primary gate read the one saved summary rather than repeating that two-week scan on every administrator refresh. Refresh failures record bounded error and consecutive-failure evidence, keep the last successful summary for diagnosis, and block Primary until a fresh healthy refresh succeeds.

### Evidence used for launch decisions

Only successful live `queue-task` scoring runs contribute duration buckets used to unlock Primary. All queue attempts contribute reliability evidence: successful work and expected no-op skips are non-errors, while actual task errors reduce reliability. Skips never contribute to average, p95, maximum, or safe-capacity duration samples. Historical Replay, direct manual refreshes, and legacy runs remain visible as planning context but cannot satisfy the queue-capacity gate.

The summary includes:

- live queue-task attempt count;
- successful queue-task count;
- queue-task error and skipped counts;
- queue-task non-error reliability rate;
- number of sampled UTC days;
- mean duration;
- histogram-based p95 duration;
- maximum duration;
- current worker count;
- near-live refresh interval;
- fixed operating-headroom ratio;
- conservative affected-league capacity;
- estimated workers required for 25 and 50 affected leagues;
- all-scoring planning statistics.

### Conservative capacity formula

D1I uses:

```text
safe affected-league capacity
= floor(
    workers
    × refresh interval
    × 70% operating headroom
    ÷ measured queue-task p95 duration
  )
```

This is deliberately conservative:

- it uses p95 rather than the average;
- it reserves 30% headroom;
- it assumes the calculated number of leagues could all require work inside one near-live interval;
- it does not count affected-league filtering as guaranteed spare capacity;
- it never changes worker count automatically.

### Evidence levels

```text
Insufficient
  fewer than 30 live queue tasks or fewer than 3 sampled days

Preliminary
  at least 30 live queue tasks across at least 3 sampled days

Representative
  at least 100 live queue tasks across at least 3 sampled days
```

The Control Center can show a planning recommendation before Primary is eligible. The recommendation is informational until the complete launch gate passes.

## New Primary gates

Global Primary now additionally requires:

1. the automatic season watchdog heartbeat is no more than three minutes old;
2. watchdog status is healthy;
3. queue and canonical warning streaks are both zero;
4. capacity evidence is no more than two hours old;
5. at least 30 successful live queue-task samples exist;
6. those samples cover at least three UTC days;
7. queue-task non-error reliability is at least 99.5%;
8. successful-task p95 is no more than 20 seconds;
9. conservative affected-league capacity covers the full completed-Draft league target.

These gates are in addition to the existing requirements for:

- proven Canary mode;
- at least three successful queue tasks;
- exact canonical-versus-direct shadow parity;
- no active canonical-read experiment;
- complete schedule coverage;
- fresh dispatcher heartbeat;
- zero enqueue failures;
- zero stale recoveries;
- idle queue;
- valid environment-specific approval;
- the exact Primary confirmation phrase.

D1I does not make Production Primary automatically available. It makes it harder to enable Primary without evidence.

## Scoring Queue Control Center

The Control Center adds two cards.

### Automatic safety fallback

Displays:

- watchdog state;
- last successful heartbeat;
- queue blocking streak;
- canonical blocking streak;
- required two-strike threshold;
- number of automatic Shadow fallbacks;
- number of automatic canonical fallbacks;
- last automatic action and reason.

### Measured scoring capacity

Displays:

- evidence level;
- last evidence refresh;
- queue-task attempts, successes, errors, skips, reliability rate, and sampled days;
- successful-task average, p95, and maximum duration;
- conservative affected-league capacity;
- current worker count;
- estimated workers for 25 and 50 affected leagues;
- planning-only all-scoring sample context.

The interface explicitly states that RinkRat never changes worker limits automatically.

## Server-owned evidence

```text
appData/leagueAutomationSeasonWatchdog
appData/leagueAutomationCapacityEvidence
leagueAutomationConfigAudit/{requestId}
```

The watchdog record stores bounded status, streak, alert IDs, action, action reason, heartbeat, duration, and cumulative fallback counts. It does not store rosters, player IDs, scores, emails, invite codes, or private manager activity.

## Protected systems unchanged

D1I does not change:

- Production Scoring V4 values;
- legacy V3 reconstruction;
- Projection V11 calculation or hashes;
- six-game player-window ownership;
- seventh-game rollover;
- Draft, roster, waiver, IR, transaction, standings, or playoff authority;
- D1H direct-versus-canonical same-task verification;
- D1H direct fallback and canonical circuit breaker;
- Firestore Rules;
- Firestore indexes;
- TTL policies;
- App Check mode;
- queue worker concurrency;
- 24-task admission ceiling;
- four-league near-live Canary ceiling;
- one-league canonical authority ceiling;
- automatic Primary promotion.

## Verification

Use the pinned toolchain:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

nvm use 22.23.1
npm install -g npm@11.17.0

npm ci
npm --prefix functions ci

npm run test:documentation:run
npm run test:batchd1h:run
npm run test:batchd1i:run
npm run certify:preseason-scoring
npm run verify:batchd1i
npm run build:all
```

The focused D1I suite proves:

- two consecutive queue blockers are required before Shadow fallback;
- one queue blocker produces only a warning;
- canonical-only blockers disable canonical authority without disabling queued direct scoring;
- Shadow resets warning streaks and performs no extra fallback;
- p95/headroom capacity math;
- sparse, unreliable, or slow evidence keeps Primary locked;
- watchdog and capacity refresh schedules;
- revision-checked and audited server fallback;
- Control Center visibility;
- protected scoring, projection, Rules, and index hashes.

## Targeted deployment

After the complete gate passes:

```bash
firebase use nhl-fantasy-app-ab673

firebase deploy \
  --only "functions:monitorLeagueAutomationSeasonSafety,functions:refreshLeagueAutomationCapacityEvidence,functions:processLeagueAutomationTask,functions:getLeagueAutomationQueueControlCenter,functions:updateLeagueAutomationQueueConfig" \
  --project nhl-fantasy-app-ab673 \
  -m "D1I season launch guardrails and measured capacity"

firebase deploy \
  --only hosting:app \
  --project nhl-fantasy-app-ab673 \
  -m "D1I season safety and capacity controls"
```

When D1H and earlier scoring batches have not been deployed, use the cumulative selector included in the delivery package rather than the D1I-only selector.

D1I requires no Firestore Rule, index, TTL, or database migration deployment.

## Post-deployment proof

### Shadow observation

Keep Production in Shadow after deployment.

Confirm:

- watchdog heartbeat updates every minute;
- watchdog status is `observing` in Shadow;
- warning streaks remain zero;
- capacity evidence refreshes successfully;
- no automatic action changes the queue;
- direct/legacy scoring remains unchanged;
- Control Center shows no false blocking alert after the first healthy heartbeat.

### Canary proof

After one exact Internal Test Canary is deliberately enabled:

- watchdog becomes healthy when the queue/feed are healthy;
- one transient synthetic or observed warning increases a streak only to one;
- the next healthy check resets the streak;
- no automatic fallback occurs during healthy live scoring;
- the queue remains direct-source unless D1H canonical authority is separately enabled.

Do not deliberately disrupt production services merely to test automatic fallback. Exercise fallback behavior in the separate staging Firebase project or with the emulator-backed certification harness.

## Rollback

### Immediate operational rollback

The owner can always select:

```text
Scoring Queue Control Center
→ Return to Shadow
```

The watchdog never removes that manual control.

### Source rollback

Revert the D1I commit, run the D1H gate, and redeploy the reverted Control Center Functions and Hosting.

Delete the two new scheduled Functions after their exports are removed:

```bash
firebase functions:delete monitorLeagueAutomationSeasonSafety \
  --region us-central1 \
  --project nhl-fantasy-app-ab673 \
  --force

firebase functions:delete refreshLeagueAutomationCapacityEvidence \
  --region us-central1 \
  --project nhl-fantasy-app-ab673 \
  --force
```

Then redeploy the reverted D1H control Functions:

```bash
firebase deploy \
  --only "functions:processLeagueAutomationTask,functions:getLeagueAutomationQueueControlCenter,functions:updateLeagueAutomationQueueConfig" \
  --project nhl-fantasy-app-ab673 \
  -m "Rollback D1I season launch guardrails"

firebase deploy \
  --only hosting:app \
  --project nhl-fantasy-app-ab673 \
  -m "Rollback D1I season safety controls"
```

Do not change Firestore Rules, indexes, TTL policies, Production Scoring V4, Projection V11, or six-game authority during rollback.
