# RinkRat Fantasy — RC9 Deep Product, Architecture, and Security Audit

**Audit date:** August 6, 2026  
**Audited package:** `RinkRat_Batch_R1F_Draft_Queue_Turn_Handoff_Recovery.zip`  
**Scope:** Angular client, Firebase Hosting configuration, Cloud Functions, Firestore Security Rules, authentication flows, league lifecycle, draft, roster transactions, projections, live scoring, observability, release controls, and static public-site smoke checks.

## Executive verdict

RinkRat is a strong, unusually thoughtful fantasy-hockey beta. Its product design, asynchronous six-game architecture, server-authoritative competitive actions, mobile recovery, release safeguards, and regression testing are all well above the normal level for an independent beta.

**Controlled invite-beta score: 8.8/10**  
**Broader public-launch score today: 7.2/10**  
**Overall product/engineering score: 8.4/10**

The main remaining weakness is not the scoring engine or user interface. It is the trust boundary around league commissioners and browser-written league/projection documents. Several operations that should be server-authoritative are still permitted directly by Firestore rules.

## Scorecard

| Area | Rating | Summary |
|---|---:|---|
| Product concept and differentiation | 9.4/10 | Distinctive six-game asynchronous system with strong hockey identity. |
| Mobile UX and accessibility | 8.9/10 | Extensive phone-first work, focus handling, recovery, reduced-motion, and readable UI. |
| Competitive engine and data model | 9.0/10 | Immutable windows, ledgers, idempotency, server scoring, rollover, and playoffs are strong. |
| Reliability and recovery | 8.9/10 | Bounded waits, live-document reconciliation, stale-tab protection, and task leases are mature. |
| Testing and release discipline | 9.1/10 | Large regression suite, emulator rules tests, release manifests, health reporting, and launch gates. |
| Security against ordinary members | 8.8/10 | Core rosters, scores, drafts, waivers, and competition documents are browser read-only. |
| Security against a malicious commissioner | 6.2/10 | League rules, projections, membership, and availability overrides retain excessive browser authority. |
| Privacy and account protection | 7.8/10 | Good private/public profile split and deletion flow; App Check, password policy, and retention need work. |
| Controlled-beta scalability | 8.5/10 | Eight internal leagues are reasonable with monitoring. |
| Broad public scalability | 6.0/10 | Queue foundation exists, but NHL ingestion, listener cost, and concurrency need measured staging tests. |

## Highest-priority confirmed findings

### S1 — Commissioner can directly alter critical league configuration

**Severity:** High — competition integrity and availability  
**Evidence:** `firestore.rules:658-668`, especially `allow update: if isLeagueCommissioner(leagueId);`

The rule permits a commissioner to update the entire league document without restricting changed fields. The server scorer subsequently reads `scoringRules` and `scoringRulesVersion` from that document in `functions/src/league-automation.ts:1737-1757`, and uses `requiredGamesPerCycle` at `functions/src/league-automation.ts:2383-2408`.

A commissioner using the Firebase SDK or REST API directly—not the visible UI—can therefore attempt to change:

- scoring values;
- games required per matchup window;
- scoring-rules version;
- commissioner ID;
- invite code;
- team limit;
- matchup format;
- arbitrary additional fields.

This is the most important security issue because a commissioner is also a competitor and should not be trusted to rewrite the scoring contract after league creation.

**Recommended correction:**

1. Replace browser league creation/update with authenticated callable Functions.
2. Deny browser updates to critical league fields.
3. Allow only a strict field list for cosmetic settings such as name, logo, and palette.
4. Make scoring rules/version and matchup format immutable after creation—preferably hard-coded server-side to Scoring V3 for current leagues.
5. Lock team count and invite behavior after draft setup begins.
6. Add emulator tests proving a commissioner cannot change scoring, games-per-window, commissioner ID, or hidden fields.

### S2 — Projection snapshots are commissioner browser-writable and become the canonical draft pool

**Severity:** High — draft integrity  
**Evidence:** `firestore.rules:268-325`, `firestore.rules:776-796`, `src/app/core/projection/projection-snapshot.service.ts:482-607`, `functions/src/draft-automation.ts:308-420`, `functions/src/draft-authority.ts:997-1013`.

A commissioner can write projection metadata and asset chunks whenever the draft is not live. Chunk rules validate only the outer list size, not every asset's canonical NHL identity or values. The secure draft Function then treats the frozen projection snapshot as the canonical player/goalie pool.

A modified client could manipulate rankings and projections or inject malformed/fake draft assets before the draft starts.

**Recommended correction:**

1. Make projection snapshots browser read-only.
2. Add a server callable/task that generates and freezes Projection V11.
3. Validate every asset against a canonical server-owned NHL/player catalog.
4. Store a server authority marker and deterministic content hash on the snapshot.
5. Make the draft accept only a server-generated snapshot with the expected hash/version.

### S3 — League joining is client-side and does not atomically enforce capacity or league status

**Severity:** High — draft availability and league integrity  
**Evidence:** `src/app/core/league/league.service.ts:617-765`, `firestore.rules:152-179`, `functions/src/draft-authority.ts:1104-1113`.

The browser reads an invite and writes the member/team documents. The rule verifies that the invite exists and is active, but it does not enforce:

- current team count below `maxTeams`;
- draft still being in setup;
- season not started;
- invite expiry;
- simultaneous join races.

A late or concurrent join can exceed capacity or change the team set after draft order is saved. The draft authority correctly aborts when the current team set no longer matches the saved order, but that means one bad join can stop an otherwise healthy live draft.

**Recommended correction:**

1. Add a `joinLeague` callable using one Firestore transaction.
2. Check active invite, expiry, team capacity, draft/season status, and existing membership inside that transaction.
3. Create member, team, and roster server-side.
4. Deactivate or rotate the invite when the draft starts.
5. Add per-account and per-IP attempt limits and App Check.
6. Deny direct browser creation of member/team documents except through the Function.

### S4 — League creation is browser-direct and has no server quota

**Severity:** Medium–High — abuse and cost  
**Evidence:** `src/app/core/league/league.service.ts:347-433`, `firestore.rules:131-142`, `firestore.rules:658-660`.

Any authenticated account can create leagues, invites, membership, and team documents directly. There is no daily creation quota or maximum active leagues per user. The schema also does not use a strict `keys().hasOnly(...)` list.

**Recommended correction:** combine creation with the server-authoritative league lifecycle Function, require verified email, enforce an active-league quota, limit daily creation, and validate exact fields and sizes.

### S5 — App Check is disabled and no callable currently enforces it

**Severity:** Medium–High — automated abuse/cost  
**Evidence:** `src/environments/app-check.config.ts:1-14`; no `enforceAppCheck` occurrence in `functions/src`.

Authentication and rules still protect data, but a script can create/use Firebase accounts and call expensive authenticated operations without proving it came from the real RinkRat client.

**Recommended correction:** deploy App Check in monitor mode, validate legitimate browser traffic, then enforce it on Firestore and high-value callable Functions. Keep emulator/debug tokens restricted to development.

### S6 — Public NHL proxy can be abused for quota/cost

**Severity:** Medium  
**Evidence:** `functions/src/index.ts:48-82`, `functions/src/index.ts:1354-1455`.

The path allowlist is a strong SSRF defense, but the endpoint is still public, accepts arbitrary query strings on allowed Stats API paths, has no App Check/user/IP rate limit, and uses only process-local memory caching. A script can vary query strings to reduce cache effectiveness and consume Function/upstream capacity.

**Recommended correction:** whitelist query parameters and numeric limits per route, add shared cache/central NHL ingestion, verify an App Check or short-lived signed token where practical, and add rate limiting and usage alerts.

### S7 — Inconsistent Firestore document-ID validation in callable Functions

**Severity:** Medium — path confusion, exceptions, and cost abuse  
**Evidence:** strong validation exists in `functions/src/draft-authority.ts:104-112`, but several roster/scoring paths only trim or check non-empty values, including `functions/src/league-automation.ts:4411-4418`, `functions/src/roster-authority.ts:1246-1266`, `functions/src/roster-authority.ts:1298-1335`, and `functions/src/roster-moves.ts:502-533`.

IDs interpolated into Admin SDK paths should reject slashes and enforce one shared format. This becomes more important because several browser-writable documents currently allow extra fields.

**Recommended correction:** introduce one shared `requireFirestoreDocumentId()` helper and apply it to league IDs, owner IDs, slot IDs, asset keys, task IDs, and every path fragment before any Admin SDK reference is created.

## Medium-priority hardening

### Authentication policy

- Registration UI accepts six-character passwords (`src/app/features/auth/auth.ts:408-415`). Configure a Firebase password policy and update the UI to at least 10–12 characters.
- Core routes require authentication but not verified email (`src/app/core/guards/auth.guard.ts:11-30`). Require verification before creating/joining leagues or performing commissioner actions.
- Verify Firebase Email Enumeration Protection in the console. The UI currently has a specific “account already exists” message when Firebase returns that error.
- Add MFA or recent-login step-up for the platform-admin account when Identity Platform support is available.

### Commissioner availability overrides

Commissioners can directly set player availability/IR eligibility for their league (`firestore.rules:378-422`, `firestore.rules:821-829`). If this is intentional, add an immutable audit entry, mandatory reason, expiration, and visible notification. Otherwise, restrict it to a server workflow or platform admin.

### Strict Firestore schemas

Several browser-writable documents validate required fields but not `keys().hasOnly(...)`, including league creation, member creation, team creation, and invite updates. Add exact schemas and string/list/map size limits. Team logo strings should also have a maximum length.

### Browser security headers

`firebase.json` already includes `nosniff`, `DENY` framing, a strict referrer policy, and a restrictive Permissions Policy. It does not declare a CSP or HSTS header.

Add a CSP in report-only mode first, self-host the Google fonts or remove the inline `onload` attribute in `src/index.html`, then enforce CSP and Angular-compatible Trusted Types. Verify whether the live host already receives HSTS from Firebase; add it explicitly if it does not.

### Alternate `www` domain

The apex site responded, but the audit fetch of `https://www.rinkratfantasy.com` returned HTTP 502. Confirm the Firebase custom-domain mapping, certificate, DNS records, and intended redirect. Remove any stale DNS record if the `www` host is not going to be used.

### Data-retention enforcement

Feedback and client-error documents contain `expiresAt`, but an expiration field alone does not prove deletion is active. Verify Firestore TTL policies or scheduled cleanup for:

- `clientErrorReports.expiresAt`;
- `feedbackReports.expiresAt`;
- queue/task audit records where applicable.

### CI and dependency security

No GitHub Actions, Dependabot, or Renovate configuration was found. Add CI that performs:

- clean root and Functions installs;
- Angular and Functions builds;
- Firestore emulator rules tests;
- all focused/regression tests;
- production dependency audit;
- secret scan;
- security-header/CSP smoke test;
- release-manifest validation.

The audit environment could not reach a working npm advisory endpoint, so current third-party dependency CVEs were not verified.

## Strengths observed

- Catch-all Firestore deny rule.
- Private user profiles are owner-only; public profiles use a strict display-safe schema.
- Draft state, picks, rosters, transactions, waivers, cycle/matchup scores, historical replay, and playoffs are browser read-only/server-authoritative.
- Draft picks use transactions, exact pick identity, deterministic/idempotent submission IDs, and roster checks.
- Live scoring uses leases, immutable six-game windows, a shared game ledger, and idempotent snapshots.
- Historical replay is serialized across leagues.
- Stale tabs cannot begin competitive actions after a deployment.
- Most async operations have bounded waits and authoritative Firestore reconciliation.
- Platform queue controls have revision checks, audit history, typed confirmation, canary proof, and a separate production approval gate.
- No obvious private key or server secret was found in the source package.
- No obvious `innerHTML`, sanitizer bypass, `eval`, `new Function`, or generic proxy SSRF sink was found.
- The public Firebase API key in the browser config is expected for Firebase; authorization still depends on Rules, IAM, and App Check. The key should nevertheless remain API-restricted in Google Cloud.

## Recommended remediation sequence

### Security Batch S1 — before friend-created leagues expand

1. Server-authoritative league creation and joining.
2. Strict league/member/team/invite schemas.
3. Immutable server-owned scoring rules and commissioner ID.
4. Atomic team capacity and draft-status enforcement.
5. Email verification and league creation/join quotas.
6. Emulator tests for malicious commissioner and join-race cases.

### Security Batch S2 — draft and projection integrity

1. Server-generated Projection V11 snapshots.
2. Browser read-only projection collections.
3. Canonical asset validation and snapshot hash.
4. Draft acceptance only from server-authoritative frozen pool.

### Security Batch S3 — abuse resistance

1. App Check monitor deployment.
2. Enforce App Check after metrics are clean.
3. Shared ID/path validation.
4. NHL proxy query allowlists and rate limits.
5. Per-user/per-league cooldowns for expensive manual scoring/admin functions.

### Security Batch S4 — web/account hardening

1. Password policy and verified-email gates.
2. Email enumeration protection verification.
3. Platform-admin MFA/step-up.
4. CSP report-only, Trusted Types, self-hosted fonts, HSTS verification.
5. Fix or remove the `www` host.
6. Confirm Firestore TTL policies.
7. Add continuous dependency and secret scanning.

## Release recommendation

RinkRat is suitable for a controlled, observed invite beta with trusted commissioners, particularly after the successful six-team lifecycle test. It should not yet be opened to arbitrary public league creation or treated as hostile-commissioner safe.

The highest-value next code package is **Security Batch S1**, not another feature or visual redesign.
