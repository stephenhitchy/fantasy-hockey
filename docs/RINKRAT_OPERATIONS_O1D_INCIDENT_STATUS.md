# Operations Batch O1D — Incident Command and Public Service Status

**Runtime release:** Release Candidate 55
**Competitive models:** Production Scoring V4 and Projection V11
**Deployment:** Ten targeted O1B–O1D Functions, then Hosting
**Authority:** Server-owned incident records with a separately sanitized public projection

## Purpose

O1D gives RinkRat a deliberate way to communicate an active service problem without editing scores, hiding uncertainty, or mixing private investigation evidence into a public message. The operating rule is **no silent score edits**: communicate impact and preserve evidence before any separately approved correction or rollback.

The batch adds:

- a public `/status` page;
- a platform-admin `/admin/incidents` command center;
- a compact application banner for active P0 and P1 incidents;
- explicit manager-action guidance;
- explicit live, delayed, stale-read-only, or unavailable competition-data status;
- a public incident timeline and recently resolved history;
- private operating notes that remain visible to the administrator, revision checks, and immutable change audits.

Known Issues and Service Status remain different:

- **Known Issues** contains confirmed product defects that may not be causing a current outage.
- **Service Status** communicates a current service incident and what managers should do now.

## Severity contract

| Severity | Meaning | Private-season response target |
|---|---|---|
| P0 | Competition integrity or confirmed competition truth risk | Acknowledge within 30 minutes during covered hours; update every 30–60 minutes |
| P1 | A manager cannot complete a core action | Acknowledge within two hours; provide a workaround or rollback the same day when possible |
| P2 | Serious degradation or confusing/stale presentation | Triage within one business day |
| P3 | Advisory or cosmetic problem | Batch with ordinary product work |

Only active P0 and P1 incidents create the compact application banner. P2 and P3 incidents remain available on the public status page without occupying every authenticated page.

## Public status states

The public page derives one overall state from active incidents:

```text
Operational
Minor issue
Degraded service
Major incident
```

The page shows:

- public title and summary;
- affected RinkRat components;
- incident status;
- manager action;
- competition impact;
- competition-data state;
- start, update, and next-update times;
- bounded public update history;
- recently resolved incidents.

## Competition-data clarity

Every incident explicitly classifies competition presentation as:

```text
Live authoritative data
Live data delayed
Saved or stale read-only presentation
Live data unavailable
```

When the state is not live, a public data message is required. This is intended to prevent a saved matchup, stale score, or delayed projection from being presented as authoritative live competition truth.

The incident system does not itself lock Drafts, roster actions, waivers, scoring, or infrastructure. The administrator publishes guidance such as:

```text
Do not start or continue a Draft
Pause roster actions
Pause waiver actions
Use RinkRat as read-only
Continue normally
```

Any actual competition freeze, rollback, or infrastructure-mode change remains a separate approved operation.

## Data model and privacy boundary

Private incident records are stored under:

```text
platformIncidents/{incidentId}
platformIncidents/{incidentId}/changes/{changeId}
```

Sanitized public projections are stored under:

```text
publicServiceIncidents/{incidentId}
```

The public projection excludes:

- private operating notes;
- private internal titles;
- administrator identity;
- audit reasons;
- root-cause evidence;
- rollback evidence;
- private league or manager details.

The public status Function reads only the sanitized public collection. Browser clients do not receive the private record and Firestore remains server-owned.

## Administrative authority

Creating or updating an incident requires:

- platform-administrator authority;
- verified and recent authentication;
- the exact deployed RC55 build;
- Scoring V4 and Projection V11 identity;
- the expected current revision;
- a public update;
- an audit reason of at least 12 characters.

P0 and P1 incidents also require a next-update time and clear manager guidance. Every P0 incident automatically requires a private post-incident review. Resolved incidents require a public resolution and become immutable. If the problem returns, a new incident must be created.

Each change audit stores the release, build, scoring version, projection version, actor, reason, public update, internal note, severity, status, impact, revision, and timestamp.

## Public caching and outage behavior

The public status page keeps a bounded local copy for up to 24 hours. If the status Function is temporarily unavailable, RinkRat may display that saved copy with an explicit stale warning and saved time. The browser validates the cached shape before using it; malformed local data fails closed. A stale P0/P1 global banner is also labeled as saved status rather than being presented as a confirmed live update.

The cached status is presentation only. It cannot become scoring, Draft, roster, waiver, or transaction authority.

The service worker does not cache Firebase callable responses as authority.

## Mobile behavior

O1D adds no modal, fuzzy backdrop, fixed command panel, or sticky status surface.

- The P0/P1 banner is an ordinary inline row below navigation.
- Public and admin cards stack vertically on narrow phones.
- Public updates use expandable inline details.
- Action controls retain practical touch targets.

## Protected systems

O1D does not change:

- Production Scoring V4;
- legacy Scoring V3 reconstruction;
- Projection V11 calculation;
- six-game roster-slot windows;
- seventh-game rollover;
- frozen projections;
- Draft, roster, waiver, transaction, standings, or scoring authority;
- Firestore Rules or indexes;
- TTL policies;
- App Check Monitor;
- exact-callable canary controls;
- scoring queue Shadow mode;
- shared NHL-cache Shadow mode.

## Verification

```bash
npm run verify:batcho1e
```

The focused suite verifies public-state derivation, severity priority, stale/read-only data language, public/private projection boundaries, exact-build authority, revision checks, routes, access guards, inline banner behavior, release identity, roadmap synchronization, and protected modes.

## Deployment

Deploy Functions before Hosting:

```bash
firebase deploy \
  --only functions:getPublicServiceStatus,functions:getServiceIncidentOperations,functions:createServiceIncident,functions:updateServiceIncident,functions:getPrivateSeasonControlCenter,functions:updatePrivateSeasonPlan,functions:recordPrivateSeasonGateDecision,functions:recordPrivateSeasonEngagement,functions:getPrivateSeasonHealthDashboard,functions:updatePrivateSeasonWeeklyHealth \
  --project=nhl-fantasy-app-ab673 \
  -m "Operations O1E tester research and RC55 authority"

firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Operations O1D Incident Status Release Candidate 55"
```

Because RC55 updates exact-build guards used by O1B, O1C, and O1D, deploy the maintained operations Functions with the O1E research Functions in the same maintenance window. The complete current targeted command appears in `docs/RINKRAT_OPERATIONS_O1E_TESTER_RESEARCH.md`.

## Smoke test

1. Open `/status` while signed out and confirm an operational state.
2. Sign in as platform administrator and open `/admin/incidents`.
3. Complete recent-authentication step-up.
4. Create a clearly labeled disposable **P3 private-season status workflow test** and confirm it appears publicly without a global banner.
5. Update its public timeline while it remains P3; confirm the public update appears and private notes remain private.
6. Set competition data to stale read-only and confirm the public page distinguishes it from live authority.
7. Resolve it with a public resolution; confirm it moves to recently resolved.
8. Confirm private notes and actor identity never appear on `/status`.
9. Confirm Known Issues remains a separate surface.
10. Use P0 or P1 only for a real incident; the automated regression suite verifies global-banner priority without creating a false production outage.
11. Confirm no league, score, Draft, roster, waiver, projection, or infrastructure setting changed.
