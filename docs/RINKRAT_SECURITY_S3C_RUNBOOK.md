# RinkRat Security S3C — CI, Browser Hardening, Retention, and Incident Runbook

**Release:** Release Candidate 20 / Security Batch S3C  
**Scope:** GitHub verification, controlled dependency updates, production dependency and secret audits, Content Security Policy report-only monitoring, HTTPS headers, and expiration of temporary security data.

## Operating principle

S3C turns security checks into repeatable project behavior. It does not make a pull request automatically safe, enforce Content Security Policy, or replace human review. The release deliberately observes CSP and App Check behavior before enforcement so a supported manager is not blocked by an unmeasured policy.

## GitHub Actions verification

The workflow is:

```text
.github/workflows/rinkrat-ci.yml
```

It runs for:

- Pull requests targeting `main`
- Pushes to `main`
- Manual workflow dispatches

The job uses:

- Node `22.23.1`
- Java `21` for Firebase emulators
- Firebase CLI `15.24.0`
- Clean root and Functions dependency installs
- The inherited Angular build, Functions build, emulator Rules tests, Draft authority tests, regressions, accessibility/design/mobile audits, and release-manifest checks
- Root and Functions production dependency audits
- Repository secret scanning
- Firebase Hosting CSP/HSTS configuration validation
- Temporary-data retention validation

The workflow has read-only repository permissions and contains no production deployment credential. It uploads `.security-reports/` for 14 days when reports exist.

Run the developer-friendly local chain with:

```bash
npm run verify:batchs3c
```

Local dependency auditing warns rather than fails when the npm advisory service is unreachable. Run the exact strict CI chain with:

```bash
npm run security:ci
```

The strict chain fails when advisory data cannot be obtained or when a high/critical production advisory is present.

### macOS hidden-file recovery

The complete project includes `.github`, `.nvmrc`, and `.gitignore` updates. Because Finder can omit dot-prefixed files during a manual project replacement, visible canonical copies also live under:

```text
config/repository-automation/
```

`npm run verify:batchs3c` automatically runs `security:sync-repository-automation` first. It restores missing hidden files, upgrades them only when the source-controlled automation version increases, and preserves later Dependabot edits after the current version is installed.

## Dependabot policy

The policy is:

```text
.github/dependabot.yml
```

It checks the browser application, Cloud Functions, and GitHub Actions weekly. Patch and minor updates are grouped to reduce pull-request noise. Major Angular, Firebase browser SDK, Firebase Admin, Firebase Functions, and TypeScript changes remain manually gated because they can affect compiler behavior, Firestore semantics, callable transport, or deployment compatibility.

Every dependency pull request must still pass `npm run security:ci`. Runtime dependency changes also require the relevant mobile Draft, roster, and six-team lifecycle smoke tests.

## Local security commands

```bash
npm run security:secret-scan
npm run security:dependency-audit
npm run security:headers:inspect
npm run security:verify-retention
npm run verify:batchs3c
```

The live production-header check is:

```bash
npm run security:headers:live
```

The local and CI dependency audits record results in:

```text
.security-reports/dependency-audit.json
```

Local mode warns when the npm advisory service is unreachable. CI uses strict mode and fails when advisory data cannot be obtained or when a high/critical production vulnerability is reported:

```bash
npm run security:dependency-audit:strict
```

## Secret response procedure

The custom scanner blocks common private-key, service-account, OAuth, GitHub, GitLab, Slack, AWS, Stripe, and App Check debug-token patterns. The public Firebase browser API key and public reCAPTCHA Enterprise site key are not private credentials.

When a real credential is found:

1. Treat it as exposed; do not merely delete the current file.
2. Revoke or rotate it at the provider.
3. Remove it from the current tree and inspect Git history, workflow artifacts, logs, and copied diagnostics.
4. Store the replacement in Secret Manager or the intended provider configuration surface.
5. Decide whether Git history must be rewritten. Coordinate before force-pushing a shared branch.
6. Run the complete security chain.
7. Record the incident, rotation, and affected release in the roadmap change log.
8. Add a scanner regression only when the leaked format was not already detected.

Never paste a private key, refresh token, service-account JSON, or registered App Check debug token into an issue, support message, or diagnostic report.

## Production dependency response

For a high or critical production advisory:

1. Identify the affected package, reachable code path, fixed version, and whether the browser app, Functions, or both are affected.
2. Prefer the smallest supported patch/minor update within the current framework major.
3. Run clean root and Functions installs.
4. Run `npm run security:ci`.
5. Run the six-team lifecycle and mobile Draft/roster smoke tests when runtime code changed.
6. Deploy Functions before Hosting when the server and browser must move together.
7. Keep the prior known-good release available for rollback.
8. Record the advisory, decision, version, test evidence, and release in the roadmap.

When no upstream fix exists, document the compensating control, affected surface, owner, and deadline. Do not silently suppress the advisory.

## CSP report-only rollout

Firebase Hosting sends `Content-Security-Policy-Report-Only`; it does not block a manager in RC20. The policy:

- Defaults resources to the same origin
- Blocks plugins and external framing
- Restricts form submission to RinkRat
- Allows only the currently required Firebase, Google Analytics, reCAPTCHA, Google Fonts, NHL, and ESPN origins
- Declares Angular/Firebase Trusted Types policy names for observation
- Reports to the same-origin endpoint `/security/csp-report`

The `collectCspReport` Function:

- Accepts POST reports only
- Rejects unsupported content types and payloads above 16 KiB
- Accepts document URLs only from known RinkRat hosts
- Removes query strings and fragments
- Redacts common league, user, team, matchup, and player path identifiers
- Never stores script samples, raw IP addresses, requester hashes, or user-agent strings
- Uses a short-lived in-memory requester hash only for per-instance rate limiting
- Groups duplicate reports by day and violation fingerprint
- Retains report documents for 30 days
- Returns HTTP 204 even when storage fails, preventing browser retry storms

After deployment, exercise:

- Registration, sign-in, reset-password, and App Check
- Dashboard and Game Center
- Draft Setup and Draft Room
- My Team, IR, waivers, and add/drop
- Projection Lab
- Support and feedback
- Mobile Safari and mobile Chrome

Review `cspViolationReports` and classify each recurring fingerprint as:

- Valid application dependency that needs an approved source
- Application bug or unsafe browser behavior that must be removed
- Browser extension/noise that should not expand the policy
- Expected local-development-only behavior

Do not move to enforced CSP until valid supported-browser violations are understood and cleared. `unsafe-inline` remains temporarily permitted for styles; self-hosted fonts and the final Angular CSP/Trusted Types enforcement are separate roadmap gates.

## Hosting headers

RC20 configures:

```text
Strict-Transport-Security: max-age=31536000
Cross-Origin-Opener-Policy: same-origin-allow-popups
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
X-Permitted-Cross-Domain-Policies: none
```

`same-origin-allow-popups` preserves Firebase Authentication popup compatibility. HSTS intentionally omits `includeSubDomains` until the `www` domain is deliberately fixed, redirected, or removed.

## Temporary data retention

The canonical inventory is:

```text
config/security-retention-policy.json
```

The optional Google Cloud TTL baseline is:

```text
config/firestore-ttl-baseline.json
```

| Collection | Retention | Cleanup owner |
|---|---:|---|
| `clientErrorReports` | 90 days | `cleanupExpiredSecurityData` |
| `feedbackReports` | 365 days | `cleanupExpiredSecurityData` |
| `projectionGenerationRequests` | 7 days | `cleanupExpiredSecurityData` |
| `leagueCreationRequests` | 30 days | `cleanupExpiredSecurityData` |
| `leagueJoinRequests` | 30 days | `cleanupExpiredSecurityData` |
| `cspViolationReports` | 30 days | `cleanupExpiredSecurityData` |
| `leagueAutomationTasks` | 7 days | `cleanupLeagueAutomationTaskHistory` |

The daily security worker runs at 04:35 UTC and writes privacy-limited health to:

```text
appData/securityOperations
```

Release Readiness treats the first missing run as an advisory. Healthy operation means:

```text
retentionCleanupStatus: success
retentionCleanupFailureCount: 0
last completion within 48 hours
```

Firestore TTL is optional redundancy rather than a replacement for the source-controlled inventory and readiness health. Inspect without mutation:

```bash
npm run security:inspect-ttl -- --project=nhl-fantasy-app-ab673
```

Enable missing TTL policies only after reviewing the list:

```bash
RINKRAT_APPLY_TTL_SECURITY=APPLY \
npm run security:apply-ttl-baseline -- \
  --project=nhl-fantasy-app-ab673
```

Re-run inspection until every expected policy reports `ACTIVE`.

## Incident severity and response

### Severity levels

- **SEV-1 — Competition integrity or broad account compromise:** incorrect/duplicate scores or Draft picks across leagues, unauthorized competitive writes, exposed production private key, widespread account takeover, destructive data loss, or service-wide outage during a live Draft/game window.
- **SEV-2 — Serious but contained:** one league cannot draft or score, a protected action is broadly unavailable, a high-risk vulnerability is reachable, a queue backlog cannot recover, or sensitive diagnostic data is exposed to an unauthorized user.
- **SEV-3 — Degraded experience:** recoverable latency, one browser workflow broken with a workaround, delayed notifications, non-sensitive telemetry failure, or a CSP violation that does not expose data.
- **SEV-4 — Minor:** cosmetic defect, isolated documentation mismatch, or low-risk maintenance issue.

### Immediate checklist

1. Record UTC start time, reporter, affected release/build ID, league scope, and observed symptoms.
2. Stop repeated user actions when duplication is possible; preserve authoritative documents and logs.
3. Determine whether the safest containment is Hosting rollback, Function rollback, queue return to Shadow, App Check/CSP enforcement rollback, key rotation, or feature disablement.
4. Preserve relevant Function logs, task IDs, audit records, release fingerprints, and privacy-limited diagnostics.
5. Communicate a clear status and workaround to affected managers without speculating.
6. Repair through an idempotent server path; never edit scores, windows, Draft picks, or transactions manually without a documented reconciliation plan.
7. Run focused regression plus the affected lifecycle test before restoring normal traffic.
8. Confirm backlog, listeners, leases, and pending operations return to a healthy state.
9. Close with an incident review.

### Post-incident review template

```text
Incident ID / severity:
UTC start and end:
Affected release/build:
Affected users/leagues:
Customer-visible impact:
Detection source:
Root cause:
Why safeguards did or did not catch it:
Containment action:
Data reconciliation performed:
Verification completed:
Permanent corrective actions, owners, and dates:
Roadmap/test/documentation updates:
```

## Deployment

Deploy the reporting and cleanup Functions before Hosting advertises the report endpoint:

```bash
firebase use nhl-fantasy-app-ab673

firebase deploy --only functions:collectCspReport,functions:cleanupExpiredSecurityData,functions:getSecurityControlReadiness \
  -m "Security S3C CSP reporting and retention"

firebase deploy --only hosting:app \
  -m "Security S3C CI and CSP report-only"
```

No Firestore Rules or index deployment is required. GitHub Actions and Dependabot activate when their files reach the repository default branch.

## Post-deployment validation

1. Reload RinkRat and open Release Readiness.
2. Confirm Browser hardening reports CSP monitoring and HSTS active.
3. Exercise the supported browser workflows above.
4. Confirm `cspViolationReports` contains no query strings, script samples, raw IP addresses, requester hashes, or user-agent strings.
5. Confirm `appData/securityOperations` records CSP aggregate counts after a report and retention health after the daily worker.
6. Run `npm run security:headers:live`.
7. Push a disposable branch or open a pull request and confirm the GitHub workflow passes.
8. Confirm Dependabot recognizes the root, Functions, and Actions dependency surfaces.
9. Keep CSP and App Check enforcement unchanged until their separate monitoring gates pass.

## Rollback

For a browser-only rollback, redeploy the approved B1A Hosting build. The CSP collector and retention worker may remain deployed safely.

For a full rollback:

1. Redeploy the prior Hosting release, removing the report-only header and rewrite.
2. Leave `cleanupExpiredSecurityData` deployed unless its logs identify it as the failure source.
3. Remove the new Functions only when they are implicated.
4. Do not manually delete retained audit or diagnostic documents during rollback.
5. Revert CI/Dependabot files independently through Git when the issue is repository automation rather than production behavior.


## Security owner and review cadence

Until a dedicated operations team exists, the RinkRat platform administrator is the default owner for security alerts, dependency emergencies, CSP triage, retention failures, and incident coordination. Review GitHub Actions and Dependabot after every pull request, inspect CSP and retention health at least weekly during beta, and perform a formal roadmap/security review before every broader cohort expansion.
