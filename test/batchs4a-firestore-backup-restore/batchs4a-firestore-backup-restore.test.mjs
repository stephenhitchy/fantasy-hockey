import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assessBackupSchedules,
  latestReadyBackup,
  makeRestoreDrillDatabaseId,
  normalizeBackupSchedule,
  normalizeExpectedSchedule,
  parseDurationSeconds,
  requireRestoreDrillDatabaseId,
  scheduleMatches,
  ttlFieldOverride,
} from '../../scripts/security/firestore-backup-restore.util.mjs';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

async function hash(relativePath) {
  return createHash('sha256').update(await readFile(new URL(relativePath, ROOT))).digest('hex');
}

test('S4A defines bounded daily and weekly native backup schedules plus guarded recovery controls', async () => {
  const baseline = JSON.parse(await read('config/firestore-backup-baseline.json'));
  assert.equal(baseline.schemaVersion, 1);
  assert.equal(baseline.database, '(default)');
  assert.equal(baseline.deleteProtectionRequired, true);
  assert.equal(baseline.pointInTimeRecovery.recommended, true);
  assert.equal(baseline.pointInTimeRecovery.applyByDefault, false);
  assert.deepEqual(
    baseline.schedules.map(({ recurrence, retention, dayOfWeek = '' }) => ({ recurrence, retention, dayOfWeek })),
    [
      { recurrence: 'daily', retention: '14d', dayOfWeek: '' },
      { recurrence: 'weekly', retention: '12w', dayOfWeek: 'SUN' },
    ],
  );
  baseline.schedules.forEach(normalizeExpectedSchedule);
  assert.equal(parseDurationSeconds('14w'), 14 * 7 * 24 * 60 * 60);
  assert.throws(
    () => normalizeExpectedSchedule({ recurrence: 'weekly', retention: '15w', dayOfWeek: 'SUN' }),
    /cannot exceed 14 weeks/,
  );
});

test('restore drills can never target the production database or an arbitrary named database', () => {
  assert.equal(
    requireRestoreDrillDatabaseId('restore-drill-20260812t021500z'),
    'restore-drill-20260812t021500z',
  );
  assert.throws(() => requireRestoreDrillDatabaseId('(default)'), /restore-drill/);
  assert.throws(() => requireRestoreDrillDatabaseId('production-copy'), /restore-drill/);
  assert.match(makeRestoreDrillDatabaseId('restore-drill', new Date('2026-08-12T02:15:00.000Z')), /^restore-drill-/);
});

test('backup schedule comparison accepts gcloud duration and recurrence representations', () => {
  const actualDaily = normalizeBackupSchedule({
    name: 'projects/p/databases/(default)/backupSchedules/daily-id',
    retention: '1209600s',
    dailyRecurrence: {},
  });
  const actualWeekly = normalizeBackupSchedule({
    name: 'projects/p/databases/(default)/backupSchedules/weekly-id',
    retention: '7257600s',
    weeklyRecurrence: { dayOfWeek: 'SUNDAY' },
  });
  assert.equal(scheduleMatches(actualDaily, { recurrence: 'daily', retention: '14d' }), true);
  assert.equal(
    scheduleMatches(actualWeekly, { recurrence: 'weekly', dayOfWeek: 'SUNDAY', retention: '12w' }),
    true,
  );

  assert.equal(
    scheduleMatches(
      {
        name: 'projects/test/databases/(default)/backupSchedules/weekly-new-cli-shape',
        weeklyRecurrence: { day: 'SUNDAY' },
        retention: '7257600s',
      },
      { recurrence: 'weekly', dayOfWeek: 'SUN', retention: '12w' },
    ),
    true,
  );
  assert.equal(
    scheduleMatches(
      { ...actualWeekly, weeklyRecurrence: { dayOfWeek: 'SUN' }, dayOfWeek: 'SUN' },
      { recurrence: 'weekly', dayOfWeek: 'SUN', retention: '12w' },
    ),
    true,
  );
});

test('a weekly schedule on the wrong day is surfaced as a recurrence conflict rather than duplicated', () => {
  const [assessment] = assessBackupSchedules(
    [{
      name: 'projects/p/databases/(default)/backupSchedules/weekly-id',
      retention: '7257600s',
      weeklyRecurrence: { dayOfWeek: 'MONDAY' },
    }],
    [{ recurrence: 'weekly', dayOfWeek: 'SUN', retention: '12w' }],
  );
  assert.equal(assessment.status, 'CONFLICTING_RECURRENCE');
  assert.equal(assessment.actual.dayOfWeek, 'MON');
  assert.equal(assessment.expected.dayOfWeek, 'SUN');
});

test('latest READY backup selection is bounded to the selected project and source database', () => {
  const backups = [
    {
      name: 'projects/nhl-fantasy-app-ab673/locations/nam5/backups/older',
      database: 'projects/nhl-fantasy-app-ab673/databases/(default)',
      state: 'READY',
      snapshotTime: '2026-08-10T00:00:00Z',
    },
    {
      name: 'projects/nhl-fantasy-app-ab673/locations/nam5/backups/newer',
      database: 'projects/nhl-fantasy-app-ab673/databases/(default)',
      state: 'READY',
      snapshotTime: '2026-08-11T00:00:00Z',
    },
    {
      name: 'projects/another-project/locations/nam5/backups/wrong-project',
      database: 'projects/another-project/databases/(default)',
      state: 'READY',
      snapshotTime: '2026-08-12T00:00:00Z',
    },
    {
      name: 'projects/nhl-fantasy-app-ab673/locations/nam5/backups/not-ready',
      database: 'projects/nhl-fantasy-app-ab673/databases/(default)',
      state: 'CREATING',
      snapshotTime: '2026-08-13T00:00:00Z',
    },
  ];
  const selected = latestReadyBackup(backups, {
    projectId: 'nhl-fantasy-app-ab673',
    database: '(default)',
  });
  assert.equal(selected.backupId, 'newer');
});

test('all active TTL policies are source-controlled without deleting default expiration indexes', async () => {
  const baseline = JSON.parse(await read('config/firestore-ttl-baseline.json'));
  const indexes = JSON.parse(await read('firestore.indexes.json'));
  const overrides = new Map(indexes.fieldOverrides.map((entry) => [
    `${entry.collectionGroup}/${entry.fieldPath}`,
    entry,
  ]));

  assert.equal(baseline.policies.length, 10);
  for (const policy of baseline.policies) {
    const entry = overrides.get(`${policy.collectionGroup}/${baseline.field}`);
    assert.ok(entry, `${policy.collectionGroup}.${baseline.field} is missing`);
    assert.equal(entry.ttl, true);
    assert.deepEqual(entry.indexes, ttlFieldOverride(policy.collectionGroup, baseline.field).indexes);
  }

  const output = execFileSync(
    process.execPath,
    ['scripts/security/sync-ttl-index-config.mjs', '--check'],
    { cwd: new URL('.', ROOT), encoding: 'utf8' },
  );
  assert.match(output, /mirrors 10 TTL policies/);
});

test('operator commands require explicit confirmations and never automate an in-place production restore', async () => {
  const source = await read('scripts/security/firestore-backup-restore.mjs');
  const verifier = await read('scripts/security/firestore-restore-verify.cjs');
  assert.match(source, /RINKRAT_APPLY_FIRESTORE_BACKUPS/);
  assert.match(source, /RINKRAT_ENABLE_FIRESTORE_PITR/);
  assert.match(source, /RINKRAT_RESTORE_FIRESTORE_DRILL/);
  assert.match(source, /RINKRAT_DELETE_FIRESTORE_DRILL/);
  assert.match(source, /--delete-protection/);
  assert.match(source, /backups.*schedules.*create/s);
  assert.match(source, /databases.*restore/s);
  assert.doesNotMatch(source, /'--async'/, 'the supported Firestore restore command waits for completion');
  assert.match(source, /requireRestoreDrillDatabaseId/);
  assert.doesNotMatch(source, /databases', 'delete'.*\(default\)/s);
  assert.doesNotMatch(source, /firebase deploy/);
  assert.match(verifier, /maximumLeagueSamples/);
  assert.match(verifier, /sixGameContracts/);
  assert.match(verifier, /scoringV3Contracts/);
  assert.doesNotMatch(verifier, /console\.log\([^\n]*(league\.id|ownerId|uid)/);
});

test('S4A scripts, documentation, roadmap, and CI verification remain synchronized', async () => {
  const packageJson = JSON.parse(await read('package.json'));
  const readme = await read('README.md');
  const documentation = await read('docs/RINKRAT_PROJECT_DOCUMENTATION.md');
  const runbook = await read('docs/RINKRAT_FIRESTORE_BACKUP_RESTORE_RUNBOOK.md');
  const roadmapRoot = await read('RINKRAT_COMPETITIVE_ROADMAP.txt');
  const roadmapDocs = await read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt');

  assert.equal(packageJson.scripts['security:backup:inspect'], 'node scripts/security/firestore-backup-restore.mjs inspect');
  assert.match(packageJson.scripts['verify:batchs4a:core'], /verify:batchb1c:core/);
  assert.match(packageJson.scripts['verify:batchs4a:core'], /sync-ttl-index-config/);
  assert.match(packageJson.scripts['security:ci'], /verify:batch(?:s4a|b1d|s3d|s3e|s3e-1|s3e-1-1|s3f|d1a|d1a-1|d1b|d1c|c1a|c1b|c1c|c1d|c1e|c1f|c1g|c1h|c1i|c1j|c1k|c1l|c1m|a1a|a1b|a1c):core/);
  assert.match(readme, /verify:batchs4a/);
  assert.match(documentation, /Security Operations Batch S4A/);
  assert.match(runbook, /Never restore a backup directly over the live `\(default\)` database/);
  assert.equal(roadmapRoot, roadmapDocs);
  assert.match(roadmapRoot, /Version 1\.\d+(?:\.\d+)?/);
  assert.match(roadmapRoot, /S4\.11 .*TTL policy/i);
  assert.match(roadmapRoot, /LOG\.19 .*S4A/i);
});

test('S4A keeps its historical recovery baseline without blocking later named releases', async () => {
  const preserved = JSON.parse(await read('test/batchs4a-firestore-backup-restore/preserved-runtime-hashes.json'));
  assert.ok(Object.keys(preserved).length >= 5);
  for (const [relativePath, expectedHash] of Object.entries(preserved)) {
    assert.match(relativePath, /^(?:functions|src|firestore|firebase|config)/);
    assert.match(expectedHash, /^[a-f0-9]{64}$/);
  }
});
