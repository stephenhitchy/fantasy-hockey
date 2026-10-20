# RinkRat Computer Migration Handoff — 2026-10-20

This is a point-in-time portability record for continuing RinkRat on another
computer. It records Git topology and local-only operational state; it is not
evidence that a source branch is deployed or ready to release.

## Recommended starting point

Clone the repository, fetch every remote ref and tag, and begin from this
handoff branch:

```bash
git clone git@github.com:stephenhitchy/fantasy-hockey.git
cd fantasy-hockey
git fetch origin --prune --tags
git switch --track origin/codex/computer-migration-handoff-20261020
```

This branch is based on the current B2G product/UI/transaction line at
`1a8b74ff6cd3309489059e485ae98e3416fd044b`. Do not begin new work from
`origin/main` without first reviewing the topology below.

## Git state that was preserved

At migration time, every commit reachable from all 77 local branches was also
reachable from an `origin/*` ref. The important continuation refs are:

| Remote branch | Commit at migration | Purpose |
| --- | --- | --- |
| `codex/future-matchup-rosters` | `1a8b74ff` | Current B2G product/UI/transaction line and future-matchup roster planning |
| `codex/d1-24-live-integration` | `1c872b13` | D1A.2 live-scoring index-capacity hotfix plus guarded, non-Production Scoring V5 shootout candidate |
| `codex/migration-final-score-integrity-wip-20261020` | `41461e9a` | Final-input convergence and matchup-finalization hardening preserved from a dirty worktree |
| `codex/leaders-android-dashboard` | `286ab6dc` | Dedicated league-leaders icon line before the final-input work was separated |
| `codex/draft-night-usability-repair` | `a1c8bf06` | Draft-night usability and auto-draft bench policy |
| `codex/draft-projection-publication-hotfix` | `dd6cc5af` | Projection publication map-comparison hotfix |
| `codex/functions-security-release` | `412c3b8b` | Isolated Functions security-release source used by operator deployment logs |

The tag `beta-season-2026-v1` is present on GitHub at `23592ee8`.

### Important divergence

`origin/main` was still `cf74eddd44e5aa5ac4737ad541eee42c52161e74`
at migration time. `future-matchup-rosters` was 64 commits ahead and zero
behind that ref. `d1-24-live-integration` was two commits ahead and one behind
`main`; it diverged from the product line at `ce28fdf1`.

Do not merge either line casually. In particular:

- the D1A.2 change modifies `firestore.indexes.json` to exempt the large
  `liveScoring.result` map from automatic single-field indexing;
- Scoring V5 is implemented only as a guarded preseason candidate and is not
  the Production default;
- the B2G line contains later UI, transaction, injury, add/drop, and
  future-matchup roster work that is not part of the D1 branch.

Reconcile these histories in a dedicated integration branch with the inherited
verification gates and compatibility tests. Never infer Production state from
either branch.

## Preserved stash snapshots

The two former local stashes are exact stash-shaped Git commits on GitHub:

| Recovery-only remote branch | Commit | Contents |
| --- | --- | --- |
| `codex/archive-trade-hardening-wip-20261020` | `2ef73e20` | Trade/live-player-team-window hardening, including the formerly untracked regression test |
| `codex/archive-ff133-six-client-wip-20261020` | `d31a5c4c` | Six-client Draft rehearsal hardening and runbook/test updates |

These are archival refs, not merge-ready feature branches. To recover one with
its original staged, unstaged, and untracked layout, start from its first
parent and apply the stash-shaped commit:

```bash
git fetch origin --prune
git switch -c codex/recover-trade-hardening \
  'origin/codex/archive-trade-hardening-wip-20261020^1'
git stash apply --index origin/codex/archive-trade-hardening-wip-20261020
```

Use the same pattern for `codex/archive-ff133-six-client-wip-20261020`. Review
and test recovered work before committing it. Do not delete either archival
remote branch until its useful changes are deliberately integrated or rejected.

## Production and competitive boundaries

The latest source-controlled handoff on the B2G line records this last-known
state, which must be independently rechecked before release work:

- Production Hosting was observed on 2026-10-12 at source `cc393191`, Release
  Candidate 65.
- Production Scoring remains V4 and Projection remains V11.
- Direct NHL scoring remains the proven fallback.
- App Check remains Monitor and canonical authority was not expanded.
- Recent operator Function deployment logs identify source `412c3b8b`, which
  is divergent from the B2G Hosting line.
- ACTIVE Function inventory does not prove exact source provenance.

No Firebase deployment, production migration, production Firestore write,
queue-mode change, App Check change, or Scoring V5 activation was performed as
part of this computer migration.

### Open dependency-audit blocker

On 2026-10-20, `npm run verify:batchb2g` completed its inherited product,
emulator, scoring, roster, and UI suites successfully, then failed at the final
`security:dependency-audit` step. The source-controlled browser-only exception
`angular-client-firestore-node-grpc-auth-context-2026-09-30` expired on
2026-10-14. The raw finding is high-severity `GHSA-m9gg-hp2v-232j` through the
Angular client's Firestore dependency graph (`firebase` 12.16.0,
`@firebase/firestore` 4.16.0, and `@grpc/grpc-js` 1.9.16 in the lockfile).
The patched gRPC releases are outside Firestore's declared `~1.9.0` range;
the latest reviewed Firebase releases retained that range, and the upstream
tracking issue remained open at
<https://github.com/firebase/firebase-js-sdk/issues/10400>. npm's suggested
`firebase` 9.14.0 change is a three-major-version downgrade, not a safe fix.

Treat the release gate as blocked until the advisory and current Firebase SDK
dependency graph are reviewed on a dedicated security branch. Do not simply
extend the exception or run an uncontrolled dependency update. Preserve the
existing reachability rationale and tests, choose the smallest supported fix,
then rerun the complete inherited gate.

The same audit reported 11 moderate Cloud Functions package entries. They did
not cause the high/critical release-gate failure. The `qs` findings appear to
have compatible transitive updates; the `uuid`/Firebase Admin chain points to
a Firebase Admin major update. Handle both as a separate tested lockfile and
runtime-compatibility review, not as part of computer migration.

## New-computer setup

Install Git/Xcode Command Line Tools and generate a new Ed25519 SSH key for the
new computer. Add only the public key to GitHub; do not copy or upload the old
private key. The migration computer used nvm 0.40.5, Firebase CLI 15.24.0,
Google Cloud SDK 579.0.0, and Java 21 for emulator workflows.

Use the required Node/npm toolchain and exact installs:

```bash
nvm install 22.23.1
nvm use 22.23.1
npm install --global npm@11.17.0
npm install --global firebase-tools@15.24.0
npm ci
npm --prefix functions ci
cp functions/.env.example functions/.env.nhl-fantasy-app-ab673
chmod 600 functions/.env.nhl-fantasy-app-ab673
```

The copied project-specific environment file is ignored by Git. The checked-in
example contains only non-secret runtime configuration. `RESEND_API_KEY` is a
Google Secret Manager secret and must never be placed in a repository or local
environment file.

Authenticate again on the new computer instead of copying token caches:

```bash
firebase login
firebase projects:list
gcloud auth login
gcloud auth application-default login
gcloud config set project nhl-fantasy-app-ab673
```

Verify access to both `nhl-fantasy-app-ab673` and the isolated staging project
`rinkrat-staging-d1nc-2026` before running their respective tooling. The
tracked `.firebaserc` retains project aliases and the Hosting target, but use an
explicit `--project` for release and operations commands. Verify the current
Git state, live Hosting manifest, and deployed resource evidence before any
release action. Stephen performs all Production deployments manually.

## Private artifacts that are intentionally not on GitHub

The following ignored evidence contains Production identifiers or exact
rollback document bodies and must not be committed:

- `.security-reports/firestore-recovery/` in the old primary checkout;
- `.security-reports/functions-audit-fix-dry-run.json` and
  `.security-reports/functions-audit-raw.json` in the old primary checkout;
- `.security-reports/orphan-schedule-cleanup/` in the old
  `roster-contract-recovery` checkout.

The tracked roadmap already records that the 2026-08-12 isolated Firestore
restore drill passed, was deleted, and left Production untouched. The private
orphan-schedule artifacts record two 2026-10-09 inspections of 44 schedules:
37 candidates and seven valid schedules, with queue mode `shadow` revision 1.
They contain exact mode-0600 rollback bodies and league paths. The two
Functions audit reports preserve a point-in-time Production inventory but are
not proof of current deployment provenance. Transfer these files and
directories only through encrypted/private storage if that operational
evidence must be retained. Do not upload the raw JSON to GitHub, email, chat,
or shared cloud storage.

Firebase CLI tokens, Google Cloud credentials, SSH private keys, browser
profiles, `node_modules`, build output, emulator caches, generated release
manifests, and debug logs are machine state, not repository state. Recreate or
reauthenticate them rather than copying them.

In particular, never copy or commit `~/.config/configstore/firebase-tools.json`,
the `~/.config/gcloud/` credential databases, `~/.ssh/id_ed25519`, Codex
authentication/session databases, browser profiles, an authenticated `.npmrc`,
any `functions/.env*` file other than the tracked example, service-account
JSON, private keys, App Check debug tokens, or Resend credentials. If old Codex
chat history or UI reference images are desired, move them through encrypted
whole-computer/private storage; they are not required to build or operate the
application and do not belong in this repository.

## First verification on the new computer

Before modifying or releasing anything:

```bash
git status --short
git branch --show-current
git log -1 --oneline
npm run toolchain:verify
npm run security:secret-scan
```

Then read `AGENTS.md`, `docs/RINKRAT_CODEX_HANDOFF.md`,
`docs/RINKRAT_CODEBASE_GUIDE.md`, and the closest feature document. Run the
newest inherited gate for the exact branch being continued. On the B2G line,
that is `npm run verify:batchb2g`, followed by `npm run build:all`,
`git diff --check`, and `npm run release:verify-clean-deploy-source` before a
release candidate is declared ready.
