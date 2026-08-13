# RinkRat Data Infrastructure Batch D1C

**Runtime client:** Release Candidate 26  
**Competitive models:** Production Scoring V3 · Projection V11  
**Deployment scope:** Cloud Functions plus one new Firestore TTL policy  
**Shared NHL cache mode:** Shadow observation only

## Purpose

D1C begins the shared NHL ingestion and cache work required before RinkRat can safely scale scoring, projection generation, historical replay, and manager-facing NHL data beyond a small invite beta.

Before D1C, each warm Cloud Functions instance kept its own process-local NHL response cache. That cache helps repeated calls inside one instance, but a cold start or a different instance can still request the same public NHL schedule, player log, boxscore, play-by-play report, roster, or statistics response again.

D1C adds one deterministic Firestore-backed Shadow cache. Successful server-owned NHL requests can now write a best-effort copy that other instances will eventually be able to reuse after a separate measured cutover. Observation covers the shared NHL service, the bounded public proxy's original upstream JSON, the global injury/roster refresh, and the direct roster-timing schedule lookup. The existing upstream request and process-local cache remain authoritative in this batch.

## Shadow safety contract

D1C deliberately sets:

```text
mode: shadow
authoritativeReadsEnabled: false
eligibleForAuthoritativeRead: false
automaticPromotion: false
```

Therefore:

- No score, Draft ranking, projection, transaction, or roster decision reads from the shared cache.
- A Firestore cache failure cannot fail the NHL request that already succeeded.
- Cache observation runs best effort and is never awaited by the competitive request path.
- Existing process-local caching, retries, and upstream responses remain unchanged.
- No browser is given direct access to the shared cache.
- No canary or Primary shared-cache mode exists yet.

This batch creates evidence and reusable storage. The shared copy is not authoritative, and this batch does not claim that large-scale NHL ingestion is complete.


## Observation sources

The Shadow observer is attached only after a successful upstream response:

- shared schedule, game, player-log, statistics, roster, and scoreboard requests in the core NHL service;
- the bounded public NHL proxy, using the original upstream JSON rather than any compacted browser response;
- the global ESPN injury and NHL roster refresh;
- the direct schedule lookup used to calculate roster-move timing.

All sources use the same canonical URL key and payload hash, so duplicate observations converge on one document. Importing the observer into the main Functions entrypoint also uses guarded single-app Firebase initialization, preventing a duplicate default Admin app.

## Observed route classes

The shared cache recognizes only approved public NHL or ESPN routes:

| Route class | Examples | Freshness marker | Maximum retention |
|---|---|---:|---:|
| Schedule | Team season schedule | 10 minutes | 14 days |
| Game boxscore | One NHL game | 2 minutes | 30 days |
| Game play-by-play | One NHL game | 2 minutes | 30 days |
| Player log | One player and season | 15 minutes | 7 days |
| NHL statistics | Skater or goalie reports | 5 minutes | 2 days |
| Team roster | Current or season roster | 15 minutes | 7 days |
| Scoreboard | Current NHL scoreboard | 20 seconds | 1 day |
| Injuries | Shared ESPN NHL injury feed | 15 minutes | 2 days |

Unknown hosts and unsupported routes are not stored.

## Deterministic identity and duplicate suppression

Every accepted URL is canonicalized before it becomes a cache identity:

1. Only approved origins are accepted.
2. Fragments are removed.
3. Query parameters are sorted.
4. The canonical URL is hashed with SHA-256.
5. The 64-character hash becomes the Firestore document ID.

The complete query string is not stored. RinkRat stores only the public route path and a one-way query hash.

The response is serialized as JSON and hashed. When the same payload is observed again:

- a second cache document is never created;
- an observation inside the 15-minute heartbeat window is suppressed entirely;
- an older unchanged entry receives only a bounded heartbeat update;
- a changed response replaces the payload and advances the change count.

## Payload limit and oversized responses

A Firestore document has a strict size ceiling. D1C therefore stores a payload only when its serialized JSON is no larger than:

```text
700 KiB
```

Larger responses are skipped and counted in health telemetry. They do not fail the original NHL request.

The later shared-ingestion phase must use Cloud Storage or deterministic chunking for oversized payloads before shared-cache reads can become authoritative. D1C intentionally does not hide this remaining requirement.

## Firestore records

### Shared cache

```text
nhlSharedDataCache/{sha256CanonicalUrl}
```

Each document includes:

- route class;
- public path;
- one-way query hash;
- source surface;
- payload JSON;
- payload byte count;
- SHA-256 content hash;
- freshness timestamp;
- route-specific expiration timestamp;
- observation and change counts;
- explicit Shadow/non-authoritative markers.

### Health

```text
appData/nhlSharedDataCacheHealth
```

Health includes bounded aggregate counters such as:

- stored and changed payloads;
- unchanged observations suppressed;
- heartbeat updates;
- oversized or invalid JSON skips;
- unsupported routes;
- per-instance queue-pressure skips;
- write errors;
- route-class coverage.

The cache contains public NHL data only. It does not store manager IDs, league IDs, rosters, fantasy scores, invite codes, email addresses, IP addresses, or request bodies from competitive actions.

## Retention

D1C adds the tenth source-controlled TTL policy:

```text
nhlSharedDataCache.expiresAt
```

Each document receives a route-specific expiration date of one to thirty days. The daily cleanup worker also includes the collection as a fallback.

After replacing the project files, activate the missing policy once:

```bash
RINKRAT_APPLY_TTL_SECURITY=APPLY \
npm run security:apply-ttl-baseline -- \
  --project=nhl-fantasy-app-ab673
```

Then inspect until all ten policies are active:

```bash
npm run security:inspect-ttl -- \
  --project=nhl-fantasy-app-ab673
```

## Verification

```bash
npm run verify:batchd1c
```

Focused checks verify:

- deterministic canonical URL hashes;
- exact route allowlisting;
- JSON-only bounded payloads;
- Shadow and non-authoritative markers;
- transaction-based content deduplication;
- best-effort queue bounds;
- source-controlled policy synchronization;
- TTL and cleanup coverage;
- inspection and audit commands;
- Release Candidate 26, Scoring V3, and Projection V11 preservation.

## Deployment

D1C changes shared code used by scoring, projection, Draft preparation, historical replay, roster timing, and other server authorities. Deploy the complete Functions codebase:

```bash
firebase use nhl-fantasy-app-ab673

firebase deploy --only functions \
  -m "Data D1C shared NHL cache Shadow foundation"
```

Do not deploy Hosting for D1C. The browser remains on Release Candidate 26, so this Functions-only Shadow batch does not intentionally reset exact-build App Check evidence.

Do not deploy Firestore Rules. Browser clients do not read or write this collection.

The source-controlled TTL field override is already in `firestore.indexes.json`; use the guarded TTL command above rather than deleting existing field overrides.

## Production smoke test

After deployment:

1. Run one projection preparation or projection regeneration.
2. Run one shared scoring refresh or historical replay day.
3. Refresh shared injuries or open one approved NHL proxy-backed page.
4. Wait approximately one minute for best-effort health aggregation.
5. Inspect the production Shadow cache:

```bash
npm run data:inspect-nhl-shared-cache -- \
  --project=nhl-fantasy-app-ab673
```

Expected initial state:

```text
Mode: shadow
Authoritative reads: DISABLED
Entries incorrectly marked authoritative: 0
Stored or changed observations: greater than 0 after NHL work
Errors: 0 or investigated
```

Some route classes may remain empty until a workflow actually requests them. Oversized play-by-play or statistics responses may be counted and skipped; this is expected evidence for the later storage design.

## Promotion gates for a later batch

Do not enable shared-cache reads merely because documents exist. A future canary must prove all of the following:

1. Supported route coverage is representative.
2. Cached and direct upstream content hashes agree.
3. Freshness rules handle live versus final game data correctly.
4. Oversized payload storage is solved.
5. Stat corrections replace prior content safely.
6. A staging project passes scoring, projection, Draft, and replay comparisons.
7. Queue age, Firestore cost, contention, and failure recovery are measured.
8. One exact Internal Test league can return immediately to direct upstream reads.
9. Production Scoring V3 and Projection V11 results remain identical.

Only after those gates should S3.14, D1.8, D1.9, and SC1.11 move from foundation to a true shared-ingestion cutover.

## Rollback

D1C is Shadow-only, so competitive rollback is simple:

1. Redeploy the prior known-good Functions revision.
2. Leave `nhlSharedDataCache` records in place or let TTL remove them.
3. Confirm scoring, projection, Draft, and replay continue using direct upstream requests and process-local cache.
4. Do not delete or weaken production league data, Scoring V3, Projection V11, App Check, or the scoring queue configuration.

The shared cache is an optimization and evidence surface only in this batch.
