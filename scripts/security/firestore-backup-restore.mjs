#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assessBackupSchedules,
  databaseReady,
  deleteProtectionEnabled,
  latestReadyBackup,
  makeRestoreDrillDatabaseId,
  normalizeBackup,
  normalizeBackupSchedule,
  normalizeExpectedSchedule,
  parseBackupResourceName,
  pointInTimeRecoveryEnabled,
  requireDatabaseId,
  requireProjectId,
  requireRestoreDrillDatabaseId,
  stableJson,
} from './firestore-backup-restore.util.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultConfigPath = path.join(projectRoot, 'config/firestore-backup-baseline.json');
const reportDirectory = path.join(projectRoot, '.security-reports/firestore-recovery');
const gcloudCommand = process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud';

const confirmations = {
  apply: ['RINKRAT_APPLY_FIRESTORE_BACKUPS', 'APPLY'],
  pitr: ['RINKRAT_ENABLE_FIRESTORE_PITR', 'ENABLE'],
  restore: ['RINKRAT_RESTORE_FIRESTORE_DRILL', 'RESTORE'],
  delete: ['RINKRAT_DELETE_FIRESTORE_DRILL', 'DELETE'],
};

function parseArguments(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith('--') ? args.shift() : 'inspect';
  const options = new Map();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const raw = argument.slice(2);
    const separator = raw.indexOf('=');
    if (separator >= 0) {
      options.set(raw.slice(0, separator), raw.slice(separator + 1));
      continue;
    }
    const next = args[index + 1];
    if (next && !next.startsWith('--')) {
      options.set(raw, next);
      index += 1;
    } else {
      options.set(raw, true);
    }
  }

  return { command, options };
}

function optionString(options, key, fallback = '') {
  const value = options.get(key);
  if (value === true || value === undefined) return fallback;
  return String(value).trim();
}

function requireConfirmation(type) {
  const [name, value] = confirmations[type];
  if (process.env[name] !== value) {
    throw new Error(`${type} is a production-changing operation and requires ${name}=${value}.`);
  }
}

function runGcloud(args, { allowFailure = false, maxBuffer = 16 * 1024 * 1024 } = {}) {
  const result = spawnSync(gcloudCommand, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer,
  });

  if (result.error?.code === 'ENOENT') {
    throw new Error('gcloud is not installed or is not available on PATH. Install Google Cloud CLI and authenticate before running Firestore recovery tooling.');
  }

  if ((result.status ?? 1) !== 0 && !allowFailure) {
    throw new Error((result.stderr || result.stdout || 'gcloud command failed').trim());
  }

  return {
    ok: (result.status ?? 1) === 0,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim(),
    status: result.status ?? 1,
  };
}

function runJson(args, { allowNotFound = false, ...options } = {}) {
  const result = runGcloud(
    [...args, '--format=json'],
    { ...options, allowFailure: allowNotFound || options.allowFailure === true },
  );
  if (!result.ok) {
    const detail = `${result.stderr}
${result.stdout}`.trim();
    if (allowNotFound && /(?:not[_ -]?found|does not exist|was not found)/i.test(detail)) {
      return null;
    }
    throw new Error(detail || 'gcloud command failed');
  }
  if (!result.stdout) return null;
  return JSON.parse(result.stdout);
}

async function loadConfig(configPath) {
  const raw = JSON.parse(await readFile(configPath, 'utf8'));
  if (
    raw?.schemaVersion !== 1 ||
    !Array.isArray(raw?.schedules) ||
    raw.schedules.length === 0 ||
    typeof raw?.restoreDrill?.databasePrefix !== 'string'
  ) {
    throw new Error('Firestore backup baseline is missing the expected schema.');
  }
  return {
    ...raw,
    projectId: requireProjectId(raw.projectId),
    database: requireDatabaseId(raw.database),
    schedules: raw.schedules.map(normalizeExpectedSchedule),
  };
}

function describeDatabase(projectId, database, { allowMissing = false } = {}) {
  const result = runJson([
    'firestore', 'databases', 'describe',
    `--project=${projectId}`,
    `--database=${database}`,
  ], { allowNotFound: allowMissing });
  return result;
}

function listSchedules(projectId, database) {
  const result = runJson([
    'firestore', 'backups', 'schedules', 'list',
    `--project=${projectId}`,
    `--database=${database}`,
  ]);
  return Array.isArray(result) ? result.map(normalizeBackupSchedule) : [];
}

function listBackups(projectId) {
  const result = runJson([
    'firestore', 'backups', 'list',
    `--project=${projectId}`,
  ]);
  return Array.isArray(result) ? result.map(normalizeBackup) : [];
}

function formatDatabaseState(database) {
  return {
    deleteProtection: deleteProtectionEnabled(database) ? 'ENABLED' : 'DISABLED',
    pointInTimeRecovery: pointInTimeRecoveryEnabled(database) ? 'ENABLED' : 'DISABLED',
    state: String(database?.state ?? 'READY').toUpperCase(),
    location: String(database?.locationId ?? database?.location_id ?? 'unknown'),
    earliestVersionTime: String(database?.earliestVersionTime ?? database?.earliest_version_time ?? ''),
  };
}

function printInspection({ projectId, databaseId, database, assessments, config }) {
  const state = formatDatabaseState(database);
  console.log(`Firestore recovery baseline for ${projectId} / ${databaseId}:`);
  console.log(`- Database state: ${state.state}`);
  console.log(`- Location: ${state.location}`);
  console.log(`- Delete protection: ${state.deleteProtection}`);
  console.log(`- Point-in-time recovery: ${state.pointInTimeRecovery}${config.pointInTimeRecovery?.recommended ? ' · recommended' : ''}`);
  if (state.earliestVersionTime) console.log(`- Earliest retained version: ${state.earliestVersionTime}`);
  for (const entry of assessments) {
    const weekly = entry.expected.recurrence === 'weekly' ? ` · ${entry.expected.dayOfWeek} UTC` : '';
    console.log(`- ${entry.expected.key}: ${entry.status} · ${entry.expected.recurrence}${weekly} · retention ${entry.expected.retention}`);
  }
}

function databaseBackupReference(backup, projectId, databaseId) {
  const resource = parseBackupResourceName(backup.name);
  if (resource.projectId !== projectId) {
    throw new Error('Restore drills accept only backups belonging to the selected Google Cloud project.');
  }
  const backupDatabase = backup.database;
  if (
    backupDatabase &&
    backupDatabase !== databaseId &&
    !backupDatabase.endsWith(`/databases/${databaseId}`)
  ) {
    throw new Error('Selected backup does not belong to the configured source database.');
  }
  if (backup.state !== 'READY') throw new Error('Selected backup is not READY.');
  return resource;
}

function selectBackup(backups, options, projectId, databaseId) {
  const requested = optionString(options, 'backup');
  const backup = requested
    ? backups.find((entry) => entry.name === requested || entry.backupId === requested) ?? null
    : latestReadyBackup(backups, { projectId, database: databaseId });
  if (!backup) {
    throw new Error('No READY Firestore backup was found. Wait for a scheduled backup or pass --backup=FULL_RESOURCE_NAME.');
  }
  databaseBackupReference(backup, projectId, databaseId);
  return backup;
}

async function writeOperationRecord(name, payload) {
  await mkdir(reportDirectory, { recursive: true });
  const filePath = path.join(reportDirectory, name);
  await writeFile(filePath, stableJson(payload), 'utf8');
  return path.relative(projectRoot, filePath);
}

async function inspect(context) {
  const database = describeDatabase(context.projectId, context.databaseId);
  const schedules = listSchedules(context.projectId, context.databaseId);
  const assessments = assessBackupSchedules(schedules, context.config.schedules);
  printInspection({ ...context, database, assessments });

  const problems = [];
  if (!databaseReady(database)) problems.push('Database is not READY.');
  if (context.config.deleteProtectionRequired && !deleteProtectionEnabled(database)) {
    problems.push('Database delete protection is disabled.');
  }
  for (const entry of assessments) {
    if (entry.status !== 'ACTIVE') problems.push(`${entry.expected.key} backup schedule is ${entry.status.toLowerCase()}.`);
  }

  if (problems.length > 0) {
    console.error('Recovery baseline needs attention:');
    problems.forEach((problem) => console.error(`- ${problem}`));
    console.error('Apply with: RINKRAT_APPLY_FIRESTORE_BACKUPS=APPLY npm run security:backup:apply -- --project=nhl-fantasy-app-ab673');
    process.exitCode = 1;
    return;
  }
  if (context.config.pointInTimeRecovery?.recommended && !pointInTimeRecoveryEnabled(database)) {
    console.log('Advisory: PITR is not enabled. Scheduled backups are healthy; enable PITR separately only after reviewing its storage cost.');
  }
  console.log(`Firestore recovery baseline passed: ${assessments.length}/${context.config.schedules.length} schedules active and delete protection enabled.`);
}

async function apply(context) {
  requireConfirmation('apply');
  const database = describeDatabase(context.projectId, context.databaseId);
  const existing = listSchedules(context.projectId, context.databaseId);
  const assessments = assessBackupSchedules(existing, context.config.schedules);
  const conflicts = assessments.filter((entry) => entry.status === 'CONFLICTING_RECURRENCE');
  if (conflicts.length > 0) {
    const details = conflicts.map((entry) => {
      const currentDay = entry.actual?.dayOfWeek ? ` on ${entry.actual.dayOfWeek}` : '';
      const expectedDay = entry.expected.dayOfWeek ? ` on ${entry.expected.dayOfWeek}` : '';
      return `${entry.expected.recurrence}${currentDay} exists but the baseline requires ${entry.expected.recurrence}${expectedDay}`;
    });
    throw new Error(
      `Backup schedule recurrence conflict: ${details.join('; ')}. Firestore allows at most one daily and one weekly schedule, so S4A will not delete or replace a schedule automatically. Review the existing schedule, delete it deliberately if appropriate, and rerun the apply command.`,
    );
  }

  if (context.config.deleteProtectionRequired && !deleteProtectionEnabled(database)) {
    console.log('Enabling Firestore database delete protection…');
    runGcloud([
      'firestore', 'databases', 'update',
      `--project=${context.projectId}`,
      `--database=${context.databaseId}`,
      '--delete-protection',
      '--quiet',
    ]);
  } else {
    console.log('Database delete protection is already enabled.');
  }

  for (const entry of assessments) {
    const expected = entry.expected;
    if (entry.status === 'ACTIVE') {
      console.log(`${expected.key} backup schedule already matches the baseline.`);
      continue;
    }
    if (entry.status === 'DRIFTED') {
      console.log(`Updating ${expected.key} backup retention to ${expected.retention}…`);
      runGcloud([
        'firestore', 'backups', 'schedules', 'update',
        `--project=${context.projectId}`,
        `--database=${context.databaseId}`,
        `--backup-schedule=${entry.actual.id}`,
        `--retention=${expected.retention}`,
        '--quiet',
      ]);
      continue;
    }

    console.log(`Creating ${expected.key} backup schedule…`);
    const args = [
      'firestore', 'backups', 'schedules', 'create',
      `--project=${context.projectId}`,
      `--database=${context.databaseId}`,
      `--retention=${expected.retention}`,
      `--recurrence=${expected.recurrence}`,
    ];
    if (expected.recurrence === 'weekly') args.push(`--day-of-week=${expected.dayOfWeek}`);
    args.push('--quiet');
    runGcloud(args);
  }

  console.log('Backup baseline applied. Rerun security:backup:inspect to verify the final production state.');
}

async function enablePitr(context) {
  requireConfirmation('pitr');
  const database = describeDatabase(context.projectId, context.databaseId);
  if (pointInTimeRecoveryEnabled(database)) {
    console.log('Point-in-time recovery is already enabled.');
    return;
  }
  runGcloud([
    'firestore', 'databases', 'update',
    `--project=${context.projectId}`,
    `--database=${context.databaseId}`,
    '--enable-pitr',
    '--quiet',
  ]);
  console.log('Point-in-time recovery enablement completed. Firestore begins retaining extended history from this point forward.');
}

async function list(context) {
  const backups = listBackups(context.projectId)
    .filter((backup) => !backup.database || backup.database === context.databaseId || backup.database.endsWith(`/databases/${context.databaseId}`))
    .sort((left, right) => (Date.parse(right.snapshotTime || right.createTime) || 0) - (Date.parse(left.snapshotTime || left.createTime) || 0));
  if (backups.length === 0) {
    console.log('No Firestore backups are currently visible for the configured database.');
    return;
  }
  console.log(`Firestore backups for ${context.projectId} / ${context.databaseId}:`);
  for (const backup of backups) {
    console.log(`- ${backup.state || 'UNKNOWN'} · ${backup.snapshotTime || backup.createTime || 'time unavailable'} · ${backup.name}`);
  }
}

async function planRestore(context) {
  const backups = listBackups(context.projectId);
  const backup = selectBackup(backups, context.options, context.projectId, context.databaseId);
  const destination = requireRestoreDrillDatabaseId(
    optionString(context.options, 'destination') || makeRestoreDrillDatabaseId(context.config.restoreDrill.databasePrefix),
    context.config.restoreDrill.databasePrefix,
  );
  console.log('Safe Firestore restore-drill plan:');
  console.log(`- Source backup: ${backup.name}`);
  console.log(`- Destination database: ${destination}`);
  console.log('- Production database remains untouched.');
  console.log('Command:');
  console.log(`RINKRAT_RESTORE_FIRESTORE_DRILL=RESTORE npm run security:backup:restore-drill -- --project=${context.projectId} --backup="${backup.name}" --destination=${destination}`);
}

async function restoreDrill(context) {
  requireConfirmation('restore');
  const backups = listBackups(context.projectId);
  const backup = selectBackup(backups, context.options, context.projectId, context.databaseId);
  const destination = requireRestoreDrillDatabaseId(
    optionString(context.options, 'destination') || makeRestoreDrillDatabaseId(context.config.restoreDrill.databasePrefix),
    context.config.restoreDrill.databasePrefix,
  );
  const existing = describeDatabase(context.projectId, destination, { allowMissing: true });
  if (existing) throw new Error(`Destination database ${destination} already exists. Restore drills require a new database ID.`);

  const startedAt = new Date().toISOString();
  console.log(`Restoring ${backup.name} into non-production database ${destination}.`);
  console.log('The Google Cloud CLI waits for the restore operation to finish; keep this terminal open.');
  const output = runJson([
    'firestore', 'databases', 'restore',
    `--project=${context.projectId}`,
    `--source-backup=${backup.name}`,
    `--destination-database=${destination}`,
    '--quiet',
  ]);
  const completedAt = new Date().toISOString();
  const record = {
    schemaVersion: 1,
    action: 'restore-drill-completed',
    startedAt,
    completedAt,
    projectId: context.projectId,
    sourceDatabase: context.databaseId,
    sourceBackup: backup.name,
    sourceSnapshotTime: backup.snapshotTime,
    destinationDatabase: destination,
    restoredResource: output?.name ?? null,
  };
  const recordPath = await writeOperationRecord(`${destination}-restore-complete.json`, record);
  console.log(`Restore drill completed for ${destination}.`);
  console.log(`- Completion record: ${recordPath}`);
  console.log(`- Confirm status: npm run security:backup:status -- --project=${context.projectId} --destination=${destination}`);
  console.log(`- Verify data: npm run security:backup:verify-drill -- --project=${context.projectId} --destination=${destination}`);
}

async function status(context) {
  const destination = requireRestoreDrillDatabaseId(
    optionString(context.options, 'destination'),
    context.config.restoreDrill.databasePrefix,
  );
  const database = describeDatabase(context.projectId, destination, { allowMissing: true });
  if (!database) {
    console.log(`Restore-drill database ${destination} does not exist or is not yet visible.`);
    process.exitCode = 1;
    return;
  }
  const state = formatDatabaseState(database);
  console.log(`Restore-drill database ${destination}:`);
  console.log(`- State: ${state.state}`);
  console.log(`- Location: ${state.location}`);
  console.log(`- Delete protection: ${state.deleteProtection}`);
  console.log(`- Point-in-time recovery: ${state.pointInTimeRecovery}`);
  if (!databaseReady(database)) process.exitCode = 1;
}

async function verifyDrill(context) {
  const destination = requireRestoreDrillDatabaseId(
    optionString(context.options, 'destination'),
    context.config.restoreDrill.databasePrefix,
  );
  const database = describeDatabase(context.projectId, destination, { allowMissing: true });
  if (!database || !databaseReady(database)) {
    throw new Error(`Restore-drill database ${destination} is not READY yet.`);
  }
  const helper = path.resolve(projectRoot, 'scripts/security/firestore-restore-verify.cjs');
  const result = spawnSync(process.execPath, [
    helper,
    `--project=${context.projectId}`,
    `--source-database=${context.databaseId}`,
    `--destination-database=${destination}`,
    `--config=${context.configPath}`,
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if ((result.status ?? 1) !== 0) process.exitCode = result.status ?? 1;
}

async function deleteDrill(context) {
  requireConfirmation('delete');
  const destination = requireRestoreDrillDatabaseId(
    optionString(context.options, 'destination'),
    context.config.restoreDrill.databasePrefix,
  );
  const database = describeDatabase(context.projectId, destination, { allowMissing: true });
  if (!database) {
    console.log(`Restore-drill database ${destination} is already absent.`);
    return;
  }
  if (deleteProtectionEnabled(database)) {
    console.log(`Disabling delete protection on non-production restore drill ${destination}…`);
    runGcloud([
      'firestore', 'databases', 'update',
      `--project=${context.projectId}`,
      `--database=${destination}`,
      '--no-delete-protection',
      '--quiet',
    ]);
  }
  runGcloud([
    'firestore', 'databases', 'delete',
    `--project=${context.projectId}`,
    `--database=${destination}`,
    '--quiet',
  ]);
  const recordPath = await writeOperationRecord(`${destination}-delete.json`, {
    schemaVersion: 1,
    action: 'restore-drill-deleted',
    deletedAt: new Date().toISOString(),
    projectId: context.projectId,
    destinationDatabase: destination,
  });
  console.log(`Deleted non-production restore-drill database ${destination}.`);
  console.log(`- Operation record: ${recordPath}`);
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  const configPath = path.resolve(optionString(options, 'config', defaultConfigPath));
  const config = await loadConfig(configPath);
  const projectId = requireProjectId(optionString(options, 'project', config.projectId));
  const databaseId = requireDatabaseId(optionString(options, 'database', config.database));
  const context = { command, options, config, configPath, projectId, databaseId };

  const commands = {
    inspect,
    apply,
    'enable-pitr': enablePitr,
    list,
    'plan-restore': planRestore,
    'restore-drill': restoreDrill,
    status,
    'verify-drill': verifyDrill,
    'delete-drill': deleteDrill,
  };
  const handler = commands[command];
  if (!handler) {
    throw new Error(`Unknown command: ${command}. Supported commands: ${Object.keys(commands).join(', ')}.`);
  }
  await handler(context);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
