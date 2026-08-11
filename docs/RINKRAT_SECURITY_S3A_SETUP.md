# RinkRat Security S3A Setup Runbook

This runbook completes the console-owned parts of Security Batch S3A after the code is deployed.
The application intentionally begins in App Check monitor mode. Do not enable App Check enforcement
until legitimate traffic has been observed across every supported workflow.

## 1. Register the production web app in Firebase App Check

Firebase Console path:

```text
Build → App Check → Apps → RinkRat web app → Register
```

Choose the reCAPTCHA Enterprise provider and create or select a score-based public site key for the
production RinkRat domain. The site key is public client configuration; do not paste private service
credentials into the Angular project.

Production domains should include the exact hosts managers use, such as:

```text
rinkratfantasy.com
www.rinkratfantasy.com   (only when this host is intentionally supported)
```

For local development, use Firebase App Check's debug-token workflow. Do not weaken the production
reCAPTCHA key merely to accommodate localhost.

Official references:

- https://firebase.google.com/docs/app-check/web/recaptcha-enterprise-provider
- https://firebase.google.com/docs/app-check/web/debug-provider
- https://firebase.google.com/docs/app-check/monitor-metrics

## 2. Configure the public App Check site key

From the project root:

```bash
npm run security:configure-app-check -- --site-key="YOUR_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY"
```

Run the production configuration command **without** `--local-debug`. That keeps
`localDebugTokenEnabled: false` in the deployable client. The configured-state
verification accepts either the untouched disabled template or a correctly enabled
public site key; it no longer assumes the file must remain disabled after setup.

This updates:

```text
src/environments/app-check.config.ts
```

The client will request and automatically refresh App Check tokens, but enforcement remains a
separate Firebase Console decision.

For localhost debug-token discovery only:

```bash
npm run security:configure-app-check -- \
  --site-key="YOUR_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY" \
  --local-debug
```

After opening localhost, copy the debug token shown by Firebase and register only that token in the
Firebase App Check console. Never commit or share a registered debug token. Before
a production build, rerun the normal configuration command without `--local-debug`
to restore `localDebugTokenEnabled: false`.

To return the source to disabled mode:

```bash
npm run security:disable-app-check
```

## 3. Inspect Firebase Authentication security

The included server-side inspection script uses Application Default Credentials. Install the Google
Cloud CLI when necessary and authenticate the local machine:

```bash
gcloud auth application-default login
```

Then inspect the current project without changing it:

```bash
npm run security:inspect-auth -- --project=nhl-fantasy-app-ab673
```

The report shows:

- password-policy enforcement and length limits;
- email-enumeration protection;
- MFA project status.

## 4. Apply the RinkRat Authentication baseline

The mutating command requires an explicit environment confirmation:

```bash
RINKRAT_APPLY_AUTH_SECURITY=APPLY \
npm run security:apply-auth-baseline -- --project=nhl-fantasy-app-ab673
```

It applies:

```text
Password policy: ENFORCE
Minimum length: 12
Maximum length: 128
Force upgrade on sign-in: false
Improved email privacy / enumeration protection: enabled
```

Existing passwords are not silently replaced. The stronger policy is enforced when a manager creates
or changes a password. The RinkRat registration UI uses the same 12–128 character baseline.

The same settings may be configured manually in Firebase Console when local Google credentials are
not available.

Official references:

- https://firebase.google.com/docs/auth/password-policy
- https://firebase.google.com/docs/auth/admin/email-enumeration-protection
- https://firebase.google.com/docs/reference/admin/node/firebase-admin.auth.projectconfigmanager

## 5. Build and deploy S3A

Run the complete verification chain:

```bash
nvm use 22.23.1
npm ci
npm --prefix functions ci
npm run verify:batchs3a-2
```

Commit before the final build so the release manifest contains the clean Git revision:

```bash
git status
git add .
git commit -m "Add App Check monitoring and authentication hardening"
git push
npm run build:all
git status
```

Deploy Functions first, then Hosting:

```bash
firebase use nhl-fantasy-app-ab673
firebase deploy --only functions -m "Security S3A authentication and admin step-up"
firebase deploy --only hosting:app -m "Security S3A App Check monitor client"
```

No Firestore Rules or index deployment is required for S3A.

## 6. Validate monitor mode before enforcement

Use Release Readiness and complete all of the following on supported desktop and mobile browsers:

1. Sign in and sign out.
2. Register a disposable account.
3. Send password-reset and verification emails.
4. Create and join a league.
5. Save Draft settings.
6. Make manual, queued, and automatic Draft picks.
7. Open Game Center and Game Film.
8. Submit add/drop, waiver, bench, and Injured Reserve actions.
9. Use Support and feedback.
10. Delete a disposable league and disposable account.
11. Unlock protected platform-admin actions with the current password.
12. Review App Check metrics in Firebase Console.

Release Readiness should eventually report:

```text
App Check client status: valid
Server request status: valid
Password policy: ENFORCE, 12–128, capital required, number required, special character required
Email privacy: protected
```

Keep enforcement disabled while valid managers still appear as unverified or invalid.


## 7. Close the current 18/20 Release Readiness result

After App Check is valid end to end and email privacy is protected, the two remaining required
warnings are operational rather than new application defects.

### Apply the production password-policy baseline

```bash
gcloud auth application-default login
RINKRAT_APPLY_AUTH_SECURITY=APPLY \
npm run security:apply-auth-baseline -- --project=nhl-fantasy-app-ab673
```

Then confirm the result:

```bash
npm run security:inspect-auth -- --project=nhl-fantasy-app-ab673
```

Release Readiness should report `ENFORCE`, minimum `12`, maximum `128`, capital required, number required, special character required, lowercase optional, and force-upgrade off.
Existing managers may continue signing in with an older password; the stronger policy applies when a
password is created or changed.

### Replace a pre-S2B shared projection pointer

For a completed league that still displays a pre-S2B projection warning:

1. Use **Verify Projection Integrity** first.
2. If the existing snapshot cannot be sealed, leave the target set to the exact matchup shown by
   Release Readiness and use **Regenerate Projection**.
3. Wait for server generation to finish, then refresh the checks.

Regeneration creates a current server-authoritative, canonical-catalog-validated, root-hash-verified
Projection V11 snapshot for future roster windows. It does not rewrite completed Draft picks or
previous fantasy scoring.

The Shadow-mode queue notice is advisory. In Shadow, the legacy ten-minute scorer remains
production authority, so a large observation-only due age is not one of the required launch failures.

## 8. Enforcement is a later release

S3A does not set `enforceAppCheck: true` on Cloud Functions and does not enforce App Check for
Firestore. That is deliberate.

After monitor data is healthy, S3B/S3 enforcement work should begin with a small group of expensive
or competitive callables, observe errors, and only then expand. Firestore enforcement should be last.

## Recent-authentication protection added by S3A

The following high-impact actions now require a verified email and an authentication time no older
than 15 minutes:

- platform scoring-queue configuration changes;
- immediate canary scoring checks;
- historical replay advancement;
- league authority migration;
- projection integrity verification or restoration;
- Admin Center feedback/error mutations;
- permanent league deletion;
- permanent account deletion;
- forced commissioner injury refresh.

Release Readiness and Admin Center include an inline password step-up card. Read-only diagnostics
remain available without repeatedly entering a password. Firebase Authentication project-policy
inspection is restricted to platform administrators and caches the server result briefly to avoid
repeated Admin SDK configuration reads.


## Security S3B password-policy synchronization

The production baseline now intentionally requires 12–128 characters, one capital letter, one number, and one special character. Lowercase remains optional and force-upgrade remains disabled. The registration page calls Firebase `validatePassword()` so its checklist follows the live project policy rather than relying only on a duplicated regular expression. The local apply script preserves the same composition requirements.
