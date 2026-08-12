# RinkRat Beta Operations and Live-Season Evidence Runbook

**Release:** Release Candidate 21 / Beta Operations Batch B1B  
**Purpose:** Give the first live-season beta one repeatable way to classify manager reports, publish sanitized known issues, measure operational health, and decide which product or scaling work should come next.

## Operating principle

RinkRat should fix competition-integrity failures before convenience or cosmetic work. The Beta Operations Center does not replace direct testing, Firebase logs, or Release Readiness. It connects those sources into one triage workflow while deliberately excluding raw fantasy data from the evidence collection.

## Severity definitions

| Severity | Use when | Target response |
|---|---|---|
| Competition integrity | Incorrect points, duplicated/missing Draft selections, wrong six-game ownership, transaction timing, standings, playoff result, or a manager gaining an unfair advantage | Investigate immediately; pause affected automation when continued processing could compound the result |
| Blocked action | Draft, roster, waiver, account, commissioner, or deletion action cannot complete | Same day during observed beta when reproducible |
| Serious usability | The workflow completes but managers cannot understand or reliably use it, especially on mobile | Triage within the current beta week |
| Cosmetic | Spacing, color, animation, or alignment that does not block use | Bundle into a later polish release |
| Idea | New feature or enhancement | Evaluate from frequency, retention value, six-game fit, security cost, and roadmap priority |

## Feedback statuses

- **New:** not yet reviewed.
- **Investigating:** reproducing, reading logs, or gathering more evidence.
- **Confirmed:** issue or need is understood; implementation decision may still be pending.
- **Fix in next release:** correction is prepared or committed for the next named build.
- **Resolved:** deployed and validated on the affected workflow.
- **Not reproducible:** available evidence did not reproduce the result; keep private notes explaining what was tested.
- **Deferred:** valid but intentionally postponed; record the reason and roadmap link.

## Daily beta routine

1. Open **Admin Center → Feedback Triage**.
2. Review Competition Integrity and Blocked Action reports first.
3. Link duplicates to the original report instead of closing them without context.
4. Add a private owner, reproduction result, and affected release.
5. Publish a sanitized Known Issue when managers benefit from seeing status.
6. Open **Live Evidence** and compare action p95, route p95, listener counts, scoring-worker duration, queue health, Draft health, browsers, devices, and builds.
7. Open Firebase logs only for the exact affected subsystem.
8. After a fix deploys, move the public issue to Monitoring before Resolved when live evidence is still limited.
9. Record the resolution release and validate the exact manager workflow.

## Public known-issue policy

A manager report is never published automatically. Only administrator-written fields are public:

- public title;
- public summary;
- sanitized severity;
- public status;
- affected release;
- resolution release;
- update and resolution timestamps.

Do not include manager names, emails, league names or IDs, player names from private rosters, scores, invite codes, screenshots containing private details, Firebase paths, or unverified root-cause claims.

## Evidence collected

### Client competitive-action evidence

For supported signed-in managers, RinkRat records:

- action type;
- success, error, uncertain, or cancelled outcome;
- duration;
- generalized route;
- device class;
- browser family;
- connection state;
- App Check client/server status;
- release and build identity;
- daily rotating manager hash.

The dashboard reports these as **manager-days**, not unique people across the whole window, because the privacy hash intentionally changes each UTC day. The detailed client evidence view uses the newest 1,000 samples in the selected window and clearly labels when that safety limit is reached.

### Route-readiness evidence

RinkRat samples generalized route-ready duration and active Firestore listener count. A route is sampled no more than once every ten minutes per session and no more than 24 times per session.

### Server scoring evidence

Each league-automation attempt contributes duration and outcome to one of 16 daily aggregate shards. The dashboard displays total, mean, histogram-based p95, maximum, success/error/skip totals, and trigger type.

## Evidence intentionally excluded

The evidence collections do not store raw manager IDs, raw league IDs, player IDs, matchup IDs, asset keys, roster contents, fantasy scores, invite codes, email addresses, raw IP addresses, raw Firestore documents, or complete browsing history.

Feedback reports may retain the submitting manager ID and optional follow-up email access because support follow-up and account deletion require it. That private support data is not copied into the operational evidence collections or the public known-issue collection.

## Retention

| Collection | Retention |
|---|---:|
| `betaEvidenceEvents` | 90 days |
| `betaOperationsDaily` | 180 days |
| `feedbackReports` | 365 days |
| `betaKnownIssues` | Until administrator removal or later archival policy |

Firestore TTL and the scheduled cleanup fallback protect the two temporary evidence collections.

## Interpreting measurements

### Competitive actions

Use p95 rather than only the average. One slow historical replay should not define Draft-pick expectations. Investigate when:

- a manual Draft pick repeatedly exceeds 10 seconds;
- next-turn handoff fails or exceeds the clock's practical tolerance;
- add/drop or lineup actions repeatedly exceed 20 seconds;
- uncertain or error outcomes increase;
- one browser/device category is materially worse.

### Route readiness and listeners

Investigate routes with:

- p95 ready time above roughly 2 seconds on normal connections;
- listener counts materially above the comparable league pages;
- rising listener counts after repeated navigation;
- one build showing a regression not present in the previous build.

### Server scoring

During the initial legacy-scorer beta, watch mean, p95, maximum, error count, and trigger distribution. For eight leagues with two concurrent legacy workers, an average above roughly 2.5 minutes per league threatens the ten-minute interval. Canary/Primary decisions still require queue age, retry, parity, and live score correctness—not duration alone.

### Scoring freshness

B1B measures scoring-worker duration now. Exact NHL-source-update-to-visible-RinkRat freshness requires a trusted NHL update timestamp during live-season ingestion. The dashboard states this limitation rather than presenting an invented number.

## Release decision rules

### Stop or roll back immediately

- incorrect fantasy points or duplicate scoring;
- missing/duplicate Draft selections;
- wrong six-game ownership or seventh-game rollover;
- transaction applied to the wrong matchup;
- permission bypass or cross-league data access;
- widespread blocked competitive actions;
- destructive action without authoritative confirmation.

### Fix in the next beta release

- reproducible mobile workflow blocker with a safe workaround;
- repeated long latency without data-integrity risk;
- confusing transaction or scoring explanation causing mistakes;
- browser-specific overlay/focus failure;
- support/reporting failure.

### Defer with evidence

- cosmetic preference;
- feature idea without repeated beta demand;
- customization that conflicts with RinkRat's six-game defaults;
- scale work that lacks measured bottleneck evidence.

## Deployment

```bash
firebase use nhl-fantasy-app-ab673
firebase deploy --only functions -m "Beta Operations B1B evidence and triage"
firebase deploy --only hosting:app -m "Beta Operations B1B center and known issues"
```

After deployment, apply the two new TTL policies:

```bash
RINKRAT_APPLY_TTL_SECURITY=APPLY \
npm run security:apply-ttl-baseline -- \
  --project=nhl-fantasy-app-ab673
```

No Firestore Rules or index deployment is required.

## Post-deployment validation

1. Submit one report in every category.
2. Confirm private technical context excludes raw fantasy data.
3. Triage a disposable report through every status.
4. Publish and then remove a sanitized Known Issue.
5. Confirm the public page never exposes the manager's private report text or email.
6. Complete Draft, roster, waiver, and replay actions and confirm evidence appears.
7. Navigate key routes and confirm route/listener samples appear.
8. Run one scoring refresh and confirm server scoring evidence appears.
9. Verify App Check valid/missing counts are plausible.
10. Confirm both new TTL policies become ACTIVE.
11. Complete Release Readiness and the full-season simulator for the exact build.

## Rollback

1. Redeploy the approved RC20 Hosting build.
2. Redeploy the approved RC20 Functions only if B1B Functions are the incident source.
3. Leave `betaEvidenceEvents`, `betaOperationsDaily`, and their TTL policies in place; they are isolated from competitive data and expire automatically.
4. Remove a public known issue manually only when it contains incorrect public wording.
5. Preserve private feedback and audit records during investigation.

## Next gate

B1B is the operational foundation for roadmap Phase B1. The next milestone is not another broad feature release: freeze a known-good build, finish the exact-build Release Readiness board and simulator, rehearse rollback, begin the observed beta cohort, and run one live Canary league when real NHL games start.
