const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const DATABASE_ID_PATTERN = /^[a-z][a-z0-9-]{2,61}[a-z0-9]$/;
const UUID_LIKE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BACKUP_RESOURCE_PATTERN = /^projects\/([^/]+)\/locations\/([^/]+)\/backups\/([^/]+)$/;


function normalizeDayOfWeek(value) {
  const normalized = String(value ?? '').trim().toUpperCase();
  const aliases = {
    SUNDAY: 'SUN',
    MONDAY: 'MON',
    TUESDAY: 'TUE',
    WEDNESDAY: 'WED',
    THURSDAY: 'THU',
    FRIDAY: 'FRI',
    SATURDAY: 'SAT',
  };
  return aliases[normalized] ?? normalized;
}

export function requireProjectId(value) {
  const normalized = String(value ?? '').trim();
  if (!PROJECT_ID_PATTERN.test(normalized)) {
    throw new Error('Project ID must be a valid Google Cloud project identifier.');
  }
  return normalized;
}

export function requireDatabaseId(value) {
  const normalized = String(value ?? '').trim();
  if (normalized === '(default)') return normalized;
  if (!DATABASE_ID_PATTERN.test(normalized) || UUID_LIKE_PATTERN.test(normalized)) {
    throw new Error('Database ID must be 4-63 lowercase letters, numbers, or hyphens, begin with a letter, end with a letter or number, and not be UUID-like.');
  }
  return normalized;
}

export function requireRestoreDrillDatabaseId(value, prefix = 'restore-drill') {
  const databaseId = requireDatabaseId(value);
  const normalizedPrefix = String(prefix ?? '').trim().toLowerCase();
  if (databaseId === '(default)' || !databaseId.startsWith(`${normalizedPrefix}-`)) {
    throw new Error(`Restore drills must use a non-production database ID beginning with ${normalizedPrefix}-.`);
  }
  return databaseId;
}

export function parseDurationSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }

  const normalized = String(value ?? '').trim().toLowerCase();
  const match = normalized.match(/^(\d+)(s|m|h|d|w)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const multipliers = {
    s: 1,
    m: 60,
    h: 60 * 60,
    d: 24 * 60 * 60,
    w: 7 * 24 * 60 * 60,
  };
  return amount * multipliers[match[2]];
}

export function normalizeRetention(value) {
  const seconds = parseDurationSeconds(value);
  return seconds === null ? '' : `${seconds}s`;
}

export function scheduleResourceId(name) {
  const normalized = String(name ?? '').trim();
  return normalized.split('/').filter(Boolean).at(-1) ?? '';
}

function recurrenceFromSchedule(raw) {
  const daily = raw?.dailyRecurrence ?? raw?.daily_recurrence;
  if (daily !== undefined && daily !== null) {
    return { recurrence: 'daily', dayOfWeek: '' };
  }

  const weekly = raw?.weeklyRecurrence ?? raw?.weekly_recurrence;
  if (weekly !== undefined && weekly !== null) {
    const day = weekly?.day ?? weekly?.dayOfWeek ?? weekly?.day_of_week ?? raw?.day ?? raw?.dayOfWeek ?? raw?.day_of_week ?? '';
    return { recurrence: 'weekly', dayOfWeek: normalizeDayOfWeek(day) };
  }

  const recurrence = String(raw?.recurrence ?? '').trim().toLowerCase();
  return {
    recurrence,
    dayOfWeek: normalizeDayOfWeek(raw?.dayOfWeek ?? raw?.day_of_week ?? ''),
  };
}

export function normalizeBackupSchedule(raw) {
  const recurrence = recurrenceFromSchedule(raw);
  return {
    id: scheduleResourceId(raw?.name ?? raw?.id),
    name: String(raw?.name ?? ''),
    recurrence: recurrence.recurrence,
    dayOfWeek: recurrence.dayOfWeek,
    retention: normalizeRetention(raw?.retention),
    createTime: String(raw?.createTime ?? raw?.create_time ?? ''),
    updateTime: String(raw?.updateTime ?? raw?.update_time ?? ''),
  };
}

export function normalizeExpectedSchedule(raw) {
  const recurrence = String(raw?.recurrence ?? '').trim().toLowerCase();
  if (!['daily', 'weekly'].includes(recurrence)) {
    throw new Error('Backup schedule recurrence must be daily or weekly.');
  }
  const dayOfWeek = recurrence === 'weekly'
    ? normalizeDayOfWeek(raw?.dayOfWeek ?? '')
    : '';
  if (recurrence === 'weekly' && !['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].includes(dayOfWeek)) {
    throw new Error('Weekly backup schedules require a valid UTC day of week.');
  }
  const retention = normalizeRetention(raw?.retention);
  if (!retention) throw new Error('Backup schedule retention must use a duration such as 14d or 12w.');
  const maximum = 14 * 7 * 24 * 60 * 60;
  if ((parseDurationSeconds(retention) ?? 0) > maximum) {
    throw new Error('Firestore scheduled-backup retention cannot exceed 14 weeks.');
  }
  return {
    key: String(raw?.key ?? recurrence).trim(),
    recurrence,
    dayOfWeek,
    retention,
    reason: String(raw?.reason ?? '').trim(),
  };
}

export function scheduleIdentity(schedule) {
  const normalized = normalizeBackupSchedule(schedule);
  return normalized.recurrence === 'weekly'
    ? `weekly:${normalized.dayOfWeek}`
    : normalized.recurrence;
}

export function expectedScheduleIdentity(schedule) {
  const normalized = normalizeExpectedSchedule(schedule);
  return normalized.recurrence === 'weekly'
    ? `weekly:${normalized.dayOfWeek}`
    : normalized.recurrence;
}

export function scheduleMatches(actual, expected) {
  const normalizedActual = normalizeBackupSchedule(actual);
  const normalizedExpected = normalizeExpectedSchedule(expected);
  return (
    scheduleIdentity(normalizedActual) === expectedScheduleIdentity(normalizedExpected) &&
    normalizedActual.retention === normalizedExpected.retention
  );
}


export function assessBackupSchedules(actualSchedules, expectedSchedules) {
  const actual = (Array.isArray(actualSchedules) ? actualSchedules : []).map(normalizeBackupSchedule);
  return (Array.isArray(expectedSchedules) ? expectedSchedules : []).map((rawExpected) => {
    const expected = normalizeExpectedSchedule(rawExpected);
    const identity = expectedScheduleIdentity(expected);
    const exact = actual.find((entry) => scheduleIdentity(entry) === identity) ?? null;
    if (exact) {
      return {
        expected,
        actual: exact,
        status: scheduleMatches(exact, expected) ? 'ACTIVE' : 'DRIFTED',
      };
    }

    const recurrenceConflict = actual.find((entry) => entry.recurrence === expected.recurrence) ?? null;
    return {
      expected,
      actual: recurrenceConflict,
      status: recurrenceConflict ? 'CONFLICTING_RECURRENCE' : 'MISSING',
    };
  });
}

export function parseBackupResourceName(value) {
  const normalized = String(value ?? '').trim();
  const match = normalized.match(BACKUP_RESOURCE_PATTERN);
  if (!match) {
    throw new Error('Backup must use projects/PROJECT/locations/LOCATION/backups/BACKUP_ID format.');
  }
  return {
    name: normalized,
    projectId: match[1],
    location: match[2],
    backupId: match[3],
  };
}

export function normalizeBackup(raw) {
  const name = String(raw?.name ?? '').trim();
  let resource = null;
  try {
    resource = parseBackupResourceName(name);
  } catch {
    resource = null;
  }
  return {
    name,
    projectId: resource?.projectId ?? '',
    location: resource?.location ?? String(raw?.location ?? ''),
    backupId: resource?.backupId ?? scheduleResourceId(name),
    database: String(raw?.database ?? raw?.sourceDatabase ?? raw?.source_database ?? ''),
    state: String(raw?.state ?? '').trim().toUpperCase(),
    snapshotTime: String(raw?.snapshotTime ?? raw?.snapshot_time ?? ''),
    expireTime: String(raw?.expireTime ?? raw?.expire_time ?? ''),
    createTime: String(raw?.createTime ?? raw?.create_time ?? ''),
  };
}

export function latestReadyBackup(backups, { projectId = '', database = '' } = {}) {
  const normalized = (Array.isArray(backups) ? backups : [])
    .map(normalizeBackup)
    .filter((backup) => backup.state === 'READY')
    .filter((backup) => !projectId || backup.projectId === projectId)
    .filter((backup) => {
      if (!database) return true;
      return backup.database === database || backup.database.endsWith(`/databases/${database}`);
    })
    .sort((left, right) => {
      const leftTime = Date.parse(left.snapshotTime || left.createTime || '') || 0;
      const rightTime = Date.parse(right.snapshotTime || right.createTime || '') || 0;
      return rightTime - leftTime;
    });
  return normalized[0] ?? null;
}

export function deleteProtectionEnabled(database) {
  return String(database?.deleteProtectionState ?? database?.delete_protection_state ?? '').toUpperCase() === 'DELETE_PROTECTION_ENABLED';
}

export function pointInTimeRecoveryEnabled(database) {
  return String(database?.pointInTimeRecoveryEnablement ?? database?.point_in_time_recovery_enablement ?? '').toUpperCase() === 'POINT_IN_TIME_RECOVERY_ENABLED';
}

export function databaseReady(database) {
  const state = String(database?.state ?? 'READY').toUpperCase();
  return state === 'READY' || state === '';
}

export function makeRestoreDrillDatabaseId(prefix = 'restore-drill', date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'z').toLowerCase();
  return requireRestoreDrillDatabaseId(`${prefix}-${stamp}`, prefix);
}

export function ttlFieldOverride(collectionGroup, fieldPath = 'expiresAt') {
  return {
    collectionGroup: String(collectionGroup).trim(),
    fieldPath: String(fieldPath).trim(),
    ttl: true,
    indexes: [
      { order: 'ASCENDING', queryScope: 'COLLECTION_GROUP' },
      { order: 'DESCENDING', queryScope: 'COLLECTION_GROUP' },
      { arrayConfig: 'CONTAINS', queryScope: 'COLLECTION_GROUP' },
    ],
  };
}

export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
