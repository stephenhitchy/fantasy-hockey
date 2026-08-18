export const PLAYER_NOTE_SCHEMA_VERSION = 1;
export const PLAYER_NOTE_MAX_COUNT = 100;
export const PLAYER_NOTE_MAX_CHARACTERS = 500;
export const PLAYER_NOTE_MAX_LINES = 8;
export const PLAYER_NOTE_MAX_ASSET_KEY_BYTES = 160;

export interface PlayerNoteRecord {
  assetKey: string;
  note: string;
  updatedAt: Date;
}

export interface PlayerNoteUpdate {
  records: PlayerNoteRecord[];
  record: PlayerNoteRecord | null;
  changed: boolean;
}

export function normalizePlayerNoteAssetKey(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  const byteLength = new TextEncoder().encode(normalized).length;

  return normalized.length >= 2 &&
      byteLength <= PLAYER_NOTE_MAX_ASSET_KEY_BYTES &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)
    ? normalized
    : null;
}

export function normalizePlayerNoteText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();

  if (!normalized) {
    return '';
  }

  const lineCount = normalized.split('\n').length;

  return normalized.length <= PLAYER_NOTE_MAX_CHARACTERS &&
      lineCount <= PLAYER_NOTE_MAX_LINES
    ? normalized
    : null;
}

function normalizeDate(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value;
  }

  if (
    value &&
    typeof value === 'object' &&
    'toDate' in value &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  ) {
    const date = (value as { toDate: () => Date }).toDate();
    return Number.isFinite(date.getTime()) ? date : null;
  }

  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  return null;
}

export function normalizePlayerNoteRecords(value: unknown): PlayerNoteRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const records: PlayerNoteRecord[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const source = entry as Record<string, unknown>;
    const assetKey = normalizePlayerNoteAssetKey(source['assetKey']);
    const note = normalizePlayerNoteText(source['note']);
    const updatedAt = normalizeDate(source['updatedAt']);

    if (!assetKey || !note || !updatedAt || seen.has(assetKey)) {
      continue;
    }

    seen.add(assetKey);
    records.push({ assetKey, note, updatedAt });

    if (records.length >= PLAYER_NOTE_MAX_COUNT) {
      break;
    }
  }

  return records.sort((left, right) =>
    right.updatedAt.getTime() - left.updatedAt.getTime() ||
    left.assetKey.localeCompare(right.assetKey),
  );
}

export function findPlayerNote(
  value: unknown,
  assetKeyValue: unknown,
): PlayerNoteRecord | null {
  const assetKey = normalizePlayerNoteAssetKey(assetKeyValue);

  if (!assetKey) {
    return null;
  }

  return normalizePlayerNoteRecords(value).find(
    (record) => record.assetKey === assetKey,
  ) ?? null;
}

export function updatePlayerNoteRecords(
  currentValue: unknown,
  assetKeyValue: unknown,
  noteValue: unknown,
  updatedAt: Date,
): PlayerNoteUpdate | null {
  const assetKey = normalizePlayerNoteAssetKey(assetKeyValue);
  const note = normalizePlayerNoteText(noteValue);

  if (!assetKey || note === null || !Number.isFinite(updatedAt.getTime())) {
    return null;
  }

  const records = normalizePlayerNoteRecords(currentValue);
  const existing = records.find((record) => record.assetKey === assetKey) ?? null;

  if (!note) {
    return existing
      ? {
        records: records.filter((record) => record.assetKey !== assetKey),
        record: null,
        changed: true,
      }
      : { records, record: null, changed: false };
  }

  if (existing?.note === note) {
    return { records, record: existing, changed: false };
  }

  if (!existing && records.length >= PLAYER_NOTE_MAX_COUNT) {
    return null;
  }

  const record: PlayerNoteRecord = { assetKey, note, updatedAt };
  return {
    records: [
      record,
      ...records.filter((candidate) => candidate.assetKey !== assetKey),
    ],
    record,
    changed: true,
  };
}
