import { httpsCallable } from 'firebase/functions';

import { functions } from '../firebase-functions';

export const PLAYER_NOTE_MAX_CHARACTERS = 500;
export const PLAYER_NOTE_MAX_LINES = 8;
export const PLAYER_NOTE_MAX_ASSET_KEY_BYTES = 160;

export interface PlayerNoteResult {
  assetKey: string;
  note: string;
  updatedAt: Date | null;
  changed: boolean;
  maximumCount: number;
  maximumCharacters: number;
  maximumLines: number;
}

export interface PlayerNoteInput {
  assetKey: string;
  note: string;
}

function callableMessage(error: unknown, fallback: string): string {
  const candidate = error !== null && typeof error === 'object'
    ? error as { message?: unknown }
    : null;

  return typeof candidate?.message === 'string' && candidate.message.trim()
    ? candidate.message.trim().replace(/^Firebase:\s*/i, '')
    : fallback;
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

  return normalized.length <= PLAYER_NOTE_MAX_CHARACTERS &&
      normalized.split('\n').length <= PLAYER_NOTE_MAX_LINES
    ? normalized
    : null;
}

function normalizeResult(value: unknown): PlayerNoteResult {
  const source = value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  const assetKey = normalizePlayerNoteAssetKey(source['assetKey']) ?? '';
  const note = normalizePlayerNoteText(source['note']) ?? '';
  const updatedAtValue = typeof source['updatedAt'] === 'string'
    ? new Date(source['updatedAt'])
    : null;

  return {
    assetKey,
    note,
    updatedAt: updatedAtValue && Number.isFinite(updatedAtValue.getTime())
      ? updatedAtValue
      : null,
    changed: source['changed'] === true,
    maximumCount: Number.isInteger(source['maximumCount'])
      ? Math.max(1, Math.min(100, Number(source['maximumCount'])))
      : 100,
    maximumCharacters: PLAYER_NOTE_MAX_CHARACTERS,
    maximumLines: PLAYER_NOTE_MAX_LINES,
  };
}

const getPlayerNoteCallable = httpsCallable<
  { assetKey: string },
  PlayerNoteResult
>(functions, 'getPlayerNote', { timeout: 25_000 });

const setPlayerNoteCallable = httpsCallable<
  PlayerNoteInput,
  PlayerNoteResult
>(functions, 'setPlayerNote', { timeout: 25_000 });

export async function getPlayerNote(assetKeyValue: string): Promise<PlayerNoteResult> {
  const assetKey = normalizePlayerNoteAssetKey(assetKeyValue);

  if (!assetKey) {
    throw new Error('Choose a valid player.');
  }

  try {
    const response = await getPlayerNoteCallable({ assetKey });
    return normalizeResult(response.data);
  } catch (error) {
    throw new Error(callableMessage(error, 'Unable to load your player note right now.'));
  }
}

export async function setPlayerNote(input: PlayerNoteInput): Promise<PlayerNoteResult> {
  const assetKey = normalizePlayerNoteAssetKey(input.assetKey);
  const note = normalizePlayerNoteText(input.note);

  if (!assetKey || note === null) {
    throw new Error(
      `Player notes must use at most ${PLAYER_NOTE_MAX_CHARACTERS} characters and ${PLAYER_NOTE_MAX_LINES} lines.`,
    );
  }

  try {
    const response = await setPlayerNoteCallable({ assetKey, note });
    return normalizeResult(response.data);
  } catch (error) {
    throw new Error(callableMessage(error, 'Unable to save your player note right now.'));
  }
}
