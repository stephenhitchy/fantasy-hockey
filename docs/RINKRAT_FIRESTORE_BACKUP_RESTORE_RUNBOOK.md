# RinkRat Firestore Backup and Restore Runbook

## Purpose

This runbook establishes a repeatable disaster-recovery baseline for the production Firestore database without changing RinkRat's scoring, Draft, roster, transaction, or projection behavior.

The intended recovery layers are:

1. **Database delete protection** to prevent accidental database deletion.
2. **Daily scheduled backups** retained for 14 days.
3. **Weekly scheduled backups** retained for 12 weeks.
4. **Optional point-in-time recovery (PITR)** for recent minute-level recovery after cost review.
5. **Named-database restore drills** that never overwrite the production `(default)` database.
6. **Privacy-limited verification reports** proving that critical collections and competition contracts survived the restore.

The source-controlled baseline is:

```text
config/firestore-backup-baseline.json
```

The production TTL policy baseline is separately mirrored into:

```text
firestore.indexes.json
```

## Non-negotiable safety rules

- Never restore a backup directly over the live `(default)` database during a rehearsal.
- Never delete `(default)` as part of a drill.
- Every rehearsal database must begin with `restore-drill-`.
- A restore destination must not already exist.
- Keep database delete protection enabled on production.
- Do not enable PITR merely because the command exists; review storage cost first.
- Delete the named rehearsal database after evidence has been saved.
- Do not treat a successful restore command as proof until the data-verification step passes.

The S4A tooling enforces the database-name boundary and refuses to use `(default)` as a drill destination.

## Prerequisites

Use the project toolchain:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey

nvm use 22.23.1
npm install -g npm@11.17.0
```

Confirm Google Cloud CLI authentication and project selection:

```bash
gcloud auth list
gcloud config set project nhl-fantasy-app-ab673
gcloud auth application-default login
gcloud auth application-default set-quota-project nhl-fantasy-app-ab673
```

Install project dependencies before the verification step:

```bash
npm ci
npm --prefix functions ci
```

## 1. Inspect the production recovery baseline

Inspection is read-only:

```bash
npm run security:backup:inspect -- \
  --project=nhl-fantasy-app-ab673
```

The healthy baseline is:

```text
Database READY
Delete protection ENABLED
Daily schedule ACTIVE · 14d
Weekly SUN schedule ACTIVE · 12w
```

PITR may still appear as an advisory when it has not been enabled.

## 2. Apply missing backup schedules and delete protection

This command intentionally requires an explicit environment confirmation:

```bash
RINKRAT_APPLY_FIRESTORE_BACKUPS=APPLY \
npm run security:backup:apply -- \
  --project=nhl-fantasy-app-ab673
```

The command:

- enables delete protection when missing;
- creates the daily schedule when missing;
- creates the Sunday weekly schedule when missing;
- corrects retention drift on an existing matching schedule;
- does not remove unrelated schedules;
- refuses to replace a daily or weekly schedule whose recurrence conflicts with the baseline, because Firestore permits at most one of each;
- does not enable PITR automatically.

Inspect again afterward:

```bash
npm run security:backup:inspect -- \
  --project=nhl-fantasy-app-ab673
```

## 3. Optional: enable point-in-time recovery

PITR is a separate cost-bearing decision. When approved, enable it explicitly:

```bash
RINKRAT_ENABLE_FIRESTORE_PITR=ENABLE \
npm run security:backup:enable-pitr -- \
  --project=nhl-fantasy-app-ab673
```

Inspect the database again:

```bash
npm run security:backup:inspect -- \
  --project=nhl-fantasy-app-ab673
```

PITR history accumulates from the moment it is enabled; it does not instantly create seven days of historical versions.

## 4. List available backups

```bash
npm run security:backup:list -- \
  --project=nhl-fantasy-app-ab673
```

Wait until at least one backup reports `READY` before beginning a drill.

## 5. Preview a safe restore drill

The planner selects the newest READY backup unless an exact backup is supplied:

```bash
npm run security:backup:plan-restore -- \
  --project=nhl-fantasy-app-ab673
```

To select an exact backup:

```bash
npm run security:backup:plan-restore -- \
  --project=nhl-fantasy-app-ab673 \
  --backup="projects/nhl-fantasy-app-ab673/locations/LOCATION/backups/BACKUP_ID"
```

The planner prints a destination similar to:

```text
restore-drill-20260812t021500z
```

Copy the exact destination it prints for the remaining commands.

## 6. Start the named-database restore drill

```bash
RINKRAT_RESTORE_FIRESTORE_DRILL=RESTORE \
npm run security:backup:restore-drill -- \
  --project=nhl-fantasy-app-ab673 \
  --backup="projects/nhl-fantasy-app-ab673/locations/LOCATION/backups/BACKUP_ID" \
  --destination=restore-drill-20260812t021500z
```

The Google Cloud CLI waits for the restore operation to finish. Keep the Terminal window open; large databases may take time. After Google Cloud reports success, a privacy-limited completion record is written beneath:

```text
.security-reports/firestore-recovery/
```

## 7. Confirm the restored database is READY

```bash
npm run security:backup:status -- \
  --project=nhl-fantasy-app-ab673 \
  --destination=restore-drill-20260812t021500z
```

The expected state is `READY`. This status command is also useful after an interrupted Terminal session or when checking a restore started outside the RinkRat helper.

## 8. Verify restored data and competition contracts

```bash
npm run security:backup:verify-drill -- \
  --project=nhl-fantasy-app-ab673 \
  --destination=restore-drill-20260812t021500z
```

The verifier compares privacy-limited totals and samples critical league contracts. It checks for:

- populated top-level collections;
- populated critical collection groups;
- duplicate sampled member identities;
- duplicate sampled team owners;
- preserved six-game contracts;
- preserved supported Scoring V4 or legacy V3 contracts;
- member/team/roster relationship summaries;
- selected `appData` sentinel documents.

Count differences may be advisory because production can change after the selected backup snapshot. Empty restored critical data, duplicate ownership signals, or lost six-game or supported versioned scoring contracts are failures.

The report is stored under:

```text
.security-reports/firestore-recovery/<destination>-verification.json
```

The report excludes raw league IDs, manager IDs, player names, roster contents, scores, and Firestore document bodies.

## 9. Delete the non-production drill database

Only after the verification report is saved:

```bash
RINKRAT_DELETE_FIRESTORE_DRILL=DELETE \
npm run security:backup:delete-drill -- \
  --project=nhl-fantasy-app-ab673 \
  --destination=restore-drill-20260812t021500z
```

The tool refuses to delete `(default)` or any database that does not begin with the configured drill prefix. If the restored database inherited delete protection, the tool disables protection only for that named drill before deletion.

## 10. Record the rehearsal

Record at minimum:

- drill date;
- operator;
- source backup resource;
- backup snapshot time;
- destination database ID;
- restore start and ready times;
- verification result and report hash;
- warnings investigated;
- drill database deletion time;
- any runbook corrections required.

Do not copy raw Firestore content into tickets or public reports.

## Source-controlled TTL overrides

S4A mirrors every production TTL policy into `firestore.indexes.json` using `fieldOverrides` and `ttl: true` while retaining default collection-group indexes for `expiresAt`.

Verify synchronization with:

```bash
npm run security:sync-ttl-index-config -- --check
```

When a future retention policy is added:

1. update `config/firestore-ttl-baseline.json`;
2. run `npm run security:sync-ttl-index-config`;
3. review `firestore.indexes.json`;
4. run the full verification chain;
5. apply the production TTL baseline;
6. deploy indexes only after reviewing the Firebase deletion prompt.

When the local and production baselines match, Firebase should no longer ask to delete the nine known TTL field overrides.

## Incident recovery versus rehearsal

A rehearsal always restores to a new `restore-drill-*` database. It does not route RinkRat traffic to that database.

An actual production incident may require a different recovery decision:

- surgically recover selected documents through PITR;
- restore a backup into a new database and validate it;
- plan application rerouting;
- or, in an extreme case, perform an in-place recovery with downtime.

An in-place restore can permanently replace the production database and is outside the automated S4A drill. Treat that as a high-severity incident requiring a second operator, written approval, a fresh backup/export, maintenance communication, and a separate rollback plan.

## Rollback of S4A repository changes

S4A does not deploy Angular, Functions, Firestore Rules, or competitive data.

To remove only the repository tooling:

1. revert the S4A commit;
2. keep already-created Google Cloud backup schedules unless a deliberate policy decision removes them;
3. do not delete production TTL overrides;
4. do not disable database delete protection merely to match older source;
5. evaluate PITR separately if it was enabled.

Cloud recovery configuration is operational state and should not be removed casually during an application rollback.
