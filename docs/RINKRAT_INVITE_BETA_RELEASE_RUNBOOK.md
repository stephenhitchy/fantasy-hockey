# RinkRat Invite-Beta Release Freeze and Rollback Runbook

**Batch:** B1C
**Runtime release being frozen:** Release Candidate 37
**Purpose:** Turn the exact deployed beta build, Release Readiness evidence, production security posture, pinned toolchain, Git revision, and rollback order into one reviewable record before inviting the first observed cohort.

B1C remains the repository and release-operations tooling, and the tooling itself does not deploy or mutate production. This maintained runbook now targets the current Release Candidate 37 / Social Batch C1K runtime; Scoring V3 and Projection V11 remain unchanged.

C1K adds server-reconciled team-identity challenges, a sixth Custom Identity scheme for every NHL team, and a top-right completion notice linking to the inline Account Settings editor. The release deploys two targeted Functions, Hosting, and a final Firestore Rules lock; it does not change indexes, TTL, App Check, scoring queue, or NHL-cache authority.

C1J advances the browser to RC36 and adds browser-generated matchup and championship share cards while retaining the complete C1I Round Recap and C1H emoji-only mobile picker. It adds no Function, migration, listener, Rule, index, or TTL policy.

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
npm run verify:batchc1k
```

Commit and push the verified RC36 source:

```bash
git status
git add .
git commit -m "Add matchup share cards"
git push
```

Do not run the freeze command until Social Batch C1K has been deployed and the live manifest identifies Release Candidate 37. The freeze tooling itself never deploys or mutates production.

## C1B privacy-cutover prerequisite

The C1B transaction and waiver privacy cutover must already be complete before RC36 invite-beta freeze evidence is accepted. Confirm that the live browser uses owner-private transaction and claim projections, claim-free public waiver projections, and the final privacy Rules. The guarded migration, inspection, transition bridge, final lock, and rollback order remain documented in `docs/RINKRAT_SOCIAL_C1B_TRANSACTION_PRIVACY.md`. C1J updates only RC36 Hosting. It renders the existing sanitized final locally and does not deploy or change Functions, Firestore Rules, indexes, TTL policies, App Check, scoring queue, or NHL-cache authority.

## Preflight

After the working tree is clean:

```bash
npm run beta:preflight
```

Preflight verifies:

- Node 22.23.1 and npm 11.17.0 are active.
- The B1C tooling commit is clean.
- The live domain serves Release Candidate 37, Scoring V3, and Projection V11.
- The live manifest contains one clean source revision that exists in local Git history.
- HSTS and CSP report-only are live on `rinkratfantasy.com`.
- App Check monitor configuration is enabled and production debug mode is off.
- The `app` Hosting target still maps to `cycle-puck`.
- All 10 production TTL policies are active.
- The runtime release label remains RC36.

## Produce the exact-build validation JSON

On the deployed Release Candidate 37 Release Readiness page:

1. Run the deterministic full-season simulator.
2. Complete every required automated and manual item.
3. Confirm the launch gate says **Ready for a small invite-beta cohort**.
4. Press **Copy Validation Report**.

On the Mac, save the clipboard into a temporary JSON file:

```bash
pbpaste > "$HOME/Downloads/rinkrat-rc37-validation.json"
```

Validate that it is JSON:

```bash
node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); console.log('Validation JSON is readable.');" \
  "$HOME/Downloads/rinkrat-rc37-validation.json"
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

4. Review the RC36 rollback selectors: Firestore Rules, complete Functions, and Hosting from the same known-good revision.
5. Confirm Firestore indexes are deployed only when an incident or known-good revision specifically requires them; C1B adds no index.
6. Confirm Release Readiness, action evidence, Function logs, and the known-issues workflow are available after rollback.

A rehearsal does not require intentionally breaking production or rolling back a healthy season. It requires proving that the exact source, commands, permissions, and decision order are understood and available.

## Freeze the invite-beta baseline

After GitHub Actions passes, Release Readiness is ready, the simulator passes, production queue mode is Shadow, and the rollback rehearsal is complete:

```bash
RINKRAT_FREEZE_INVITE_BETA=FREEZE \
npm run beta:freeze -- \
  --validation-report="$HOME/Downloads/rinkrat-rc37-validation.json" \
  --tag=rinkrat-rc37-invite-beta \
  --ci-passed \
  --rollback-rehearsed \
  --queue-shadow
```

The command creates ignored local records under:

```text
.beta-release/
```

It never deploys, creates a Git tag, changes queue mode, or writes competitive Firebase data.

Review the generated JSON and rollback Markdown, then create the annotated tag exactly as printed by the command. The tag deliberately points to the source revision recorded in the live RC36 manifest, not automatically to a newer release-tooling commit.

Example:

```bash
git tag -a rinkrat-rc37-invite-beta LIVE_SOURCE_REVISION \
  -m "RinkRat RC36 invite beta baseline"
git push origin rinkrat-rc37-invite-beta
```

Verify the tag:

```bash
npm run beta:verify-tag -- --tag=rinkrat-rc37-invite-beta
```

Verify the complete frozen state while RC36 remains live:

```bash
npm run beta:verify-freeze -- --tag=rinkrat-rc37-invite-beta
```

Regenerate the rollback plan later without changing the record:

```bash
npm run beta:rollback-plan -- --tag=rinkrat-rc37-invite-beta
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
