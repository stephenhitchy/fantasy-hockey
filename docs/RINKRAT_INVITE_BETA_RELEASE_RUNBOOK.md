# RinkRat Invite-Beta Release Freeze and Rollback Runbook

**Batch:** B1C  
**Runtime release being frozen:** Release Candidate 28
**Purpose:** Turn the exact deployed beta build, Release Readiness evidence, production security posture, pinned toolchain, Git revision, and rollback order into one reviewable record before inviting the first observed cohort.

B1C remains the repository and release-operations tooling, and the tooling itself does not deploy or mutate production. This maintained runbook now targets the current Release Candidate 28 / Social Batch C1B runtime; Scoring V3 and Projection V11 remain unchanged.

## Approved toolchain

RinkRat pins:

```text
Node 22.23.1
npm 11.17.0
```

The npm notice shown after a command is informational. Do not install a new npm major version merely because npm advertises it. A package-manager major update belongs in a separate maintenance release with clean installs, builds, emulator tests, dependency audits, and rollback evidence.

Inspect the current shell:

```bash
npm run toolchain:inspect
```

Restore the approved versions when needed:

```bash
nvm use 22.23.1
npm install -g npm@11.17.0
node --version
npm --version
```

Expected:

```text
v22.23.1
11.17.0
```

## Firestore TTL procedure

The safe recurring procedure is:

1. Inspect the current production policies.
2. Apply the source-controlled baseline only when a policy is missing, creating, unhealthy, or a new collection has been added to the baseline.
3. Inspect again until every expected policy is `ACTIVE`.

Inspect:

```bash
npm run security:inspect-ttl -- --project=nhl-fantasy-app-ab673
```

Apply only when needed:

```bash
RINKRAT_APPLY_TTL_SECURITY=APPLY \
npm run security:apply-ttl-baseline -- \
  --project=nhl-fantasy-app-ab673
```

The apply command is idempotent: it creates only missing policies. It is safe to rerun, but it should not be treated as a required step after every ordinary Hosting or Functions deployment. The current source baseline expects 10 active policies.

## Current release verification

After manually replacing the project files:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1
npm install -g npm@11.17.0
npm ci
npm --prefix functions ci
npm run verify:batchc1b
```

Commit and push the verified RC28 source:

```bash
git status
git add .
git commit -m "Harden transaction and waiver privacy"
git push
```

Do not run the freeze command until Social Batch C1B has been deployed and the live manifest identifies Release Candidate 28. The freeze tooling itself never deploys or mutates production.

## C1B privacy-cutover prerequisite

RC28 cannot use an ordinary all-at-once deployment because RC27 reads the canonical transaction and waiver collections while final C1B Rules deny those reads. Before the final invite-beta preflight:

1. Deploy the verified complete Functions codebase only.
2. Run the guarded transaction-privacy backfill in dry-run mode.
3. Apply the backfill only with `RINKRAT_APPLY_TRANSACTION_PRIVACY=APPLY`.
4. Require the read-only privacy inspector to report zero issues.
5. Exercise one waiver claim and one adjudication in an Internal Test league and inspect again.
6. Audit and deploy the temporary dual-read transition Rules.
7. Verify RC27 still functions, then deploy Hosting RC28 only.
8. Prove RC28 against the projections and inspect again.
9. Deploy the default final privacy Rules only.

Do not deploy Hosting before the projection inspection passes. The transition bridge exists because a combined Rules/Hosting command is not an atomic browser cutover. After final privacy Rules are live, restore the transition Rules before any RC27 Hosting rollback. C1B adds no Firestore index or TTL policy. Full commands are maintained in `docs/RINKRAT_SOCIAL_C1B_TRANSACTION_PRIVACY.md`.

## Preflight

After the working tree is clean:

```bash
npm run beta:preflight
```

Preflight verifies:

- Node 22.23.1 and npm 11.17.0 are active.
- The B1C tooling commit is clean.
- The live domain serves Release Candidate 28, Scoring V3, and Projection V11.
- The live manifest contains one clean source revision that exists in local Git history.
- HSTS and CSP report-only are live on `rinkratfantasy.com`.
- App Check monitor configuration is enabled and production debug mode is off.
- The `app` Hosting target still maps to `cycle-puck`.
- All 10 production TTL policies are active.
- The runtime release label remains RC28.

## Produce the exact-build validation JSON

On the deployed Release Candidate 28 Release Readiness page:

1. Run the deterministic full-season simulator.
2. Complete every required automated and manual item.
3. Confirm the launch gate says **Ready for a small invite-beta cohort**.
4. Press **Copy Validation Report**.

On the Mac, save the clipboard into a temporary JSON file:

```bash
pbpaste > "$HOME/Downloads/rinkrat-rc28-validation.json"
```

Validate that it is JSON:

```bash
node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); console.log('Validation JSON is readable.');" \
  "$HOME/Downloads/rinkrat-rc28-validation.json"
```

The freeze tool independently requires the report to contain:

- the same build ID and source revision as the live manifest;
- a `ready` launch gate;
- every required automated check passed;
- every required manual workflow passed;
- zero attention or untested manual items;
- a passing full-season simulator.

## Rollback rehearsal

Before freezing, rehearse rather than improvise:

1. Copy the current scoring queue rollback configuration from Release Readiness.
2. Confirm the production scoring queue is in **Shadow**.
3. Confirm the live source revision exists locally:

```bash
git cat-file -e "$(curl -fsSL https://rinkratfantasy.com/release-manifest.json | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).sourceRevision")^{commit}"
```

4. Review the RC28 rollback selectors: Firestore Rules, complete Functions, and Hosting from the same known-good revision.
5. Confirm Firestore indexes are deployed only when an incident or known-good revision specifically requires them; C1B adds no index.
6. Confirm Release Readiness, action evidence, Function logs, and the known-issues workflow are available after rollback.

A rehearsal does not require intentionally breaking production or rolling back a healthy season. It requires proving that the exact source, commands, permissions, and decision order are understood and available.

## Freeze the invite-beta baseline

After GitHub Actions passes, Release Readiness is ready, the simulator passes, production queue mode is Shadow, and the rollback rehearsal is complete:

```bash
RINKRAT_FREEZE_INVITE_BETA=FREEZE \
npm run beta:freeze -- \
  --validation-report="$HOME/Downloads/rinkrat-rc28-validation.json" \
  --tag=rinkrat-rc28-invite-beta \
  --ci-passed \
  --rollback-rehearsed \
  --queue-shadow
```

The command creates ignored local records under:

```text
.beta-release/
```

It never deploys, creates a Git tag, changes queue mode, or writes competitive Firebase data.

Review the generated JSON and rollback Markdown, then create the annotated tag exactly as printed by the command. The tag deliberately points to the source revision recorded in the live RC28 manifest, not automatically to the newer B1C tooling commit.

Example:

```bash
git tag -a rinkrat-rc28-invite-beta LIVE_SOURCE_REVISION \
  -m "RinkRat RC28 invite beta baseline"
git push origin rinkrat-rc28-invite-beta
```

Verify the tag:

```bash
npm run beta:verify-tag -- --tag=rinkrat-rc28-invite-beta
```

Verify the complete frozen state while RC28 remains live:

```bash
npm run beta:verify-freeze -- --tag=rinkrat-rc28-invite-beta
```

Regenerate the rollback plan later without changing the record:

```bash
npm run beta:rollback-plan -- --tag=rinkrat-rc28-invite-beta
```

## After the freeze

Proceed with the roadmap’s observed invite-beta phase:

- begin with 2–4 leagues and approximately 10–30 managers;
- include beginners, experienced managers, iPhone, Android, and another commissioner;
- keep Scoring V3 and Projection V11 frozen except for objective bugs;
- keep queued scoring in Shadow until one ordinary live canary league is ready;
- use the Beta Operations Center to classify integrity, blocker, serious UX, cosmetic, and idea reports;
- use real evidence to choose the next major feature rather than resetting the release for speculative changes.

## npm major-version notices

When npm prints a notice such as:

```text
New major version of npm available
```

use this decision rule:

```text
Project packageManager pin unchanged → do not upgrade
Named dependency/toolchain maintenance batch → upgrade deliberately, regenerate lockfiles, run the complete suite, and preserve rollback
```

Never run `npm audit fix --force` or a package-manager major upgrade as part of ordinary release verification or an emergency rollback.
