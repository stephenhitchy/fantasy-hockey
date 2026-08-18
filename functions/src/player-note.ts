import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { db } from './shared/core/firebase';
import {
  findPlayerNote,
  normalizePlayerNoteAssetKey,
  normalizePlayerNoteText,
  PLAYER_NOTE_MAX_CHARACTERS,
  PLAYER_NOTE_MAX_COUNT,
  PLAYER_NOTE_MAX_LINES,
  PLAYER_NOTE_SCHEMA_VERSION,
  updatePlayerNoteRecords,
} from './shared/core/user/player-note.util';
import {
  requireAuthenticatedUserId,
  requireVerifiedEmail,
} from './shared/security/auth-security.util';
import { TRUSTED_WEB_ORIGINS } from './web-security';

const CALLABLE_OPTIONS = {
  region: 'us-central1',
  timeoutSeconds: 20,
  memory: '256MiB' as const,
  maxInstances: 40,
  cors: TRUSTED_WEB_ORIGINS,
  invoker: 'public' as const,
};

interface PlayerNoteResult {
  assetKey: string;
  note: string;
  updatedAt: string | null;
  changed: boolean;
  maximumCount: number;
  maximumCharacters: number;
  maximumLines: number;
}

function notesRef(userId: string) {
  return db.doc(`managerPlayerNotes/${userId}`);
}

function resultFor(
  assetKey: string,
  note: string,
  updatedAt: Date | null,
  changed: boolean,
): PlayerNoteResult {
  return {
    assetKey,
    note,
    updatedAt: updatedAt?.toISOString() ?? null,
    changed,
    maximumCount: PLAYER_NOTE_MAX_COUNT,
    maximumCharacters: PLAYER_NOTE_MAX_CHARACTERS,
    maximumLines: PLAYER_NOTE_MAX_LINES,
  };
}

export const getPlayerNote = onCall(
  CALLABLE_OPTIONS,
  async (request): Promise<PlayerNoteResult> => {
    const actionLabel = 'load your player note';
    const userId = requireAuthenticatedUserId(request.auth, actionLabel);
    requireVerifiedEmail(request.auth, actionLabel);

    const data = request.data !== null && typeof request.data === 'object'
      ? request.data as Record<string, unknown>
      : {};
    const assetKey = normalizePlayerNoteAssetKey(data['assetKey']);

    if (!assetKey) {
      throw new HttpsError('invalid-argument', 'Choose a valid player.');
    }

    const snapshot = await notesRef(userId).get();
    const record = findPlayerNote(snapshot.data()?.['records'], assetKey);

    return resultFor(
      assetKey,
      record?.note ?? '',
      record?.updatedAt ?? null,
      false,
    );
  },
);

export const setPlayerNote = onCall(
  CALLABLE_OPTIONS,
  async (request): Promise<PlayerNoteResult> => {
    const actionLabel = 'save your player note';
    const userId = requireAuthenticatedUserId(request.auth, actionLabel);
    requireVerifiedEmail(request.auth, actionLabel);

    const data = request.data !== null && typeof request.data === 'object'
      ? request.data as Record<string, unknown>
      : {};
    const assetKey = normalizePlayerNoteAssetKey(data['assetKey']);
    const note = normalizePlayerNoteText(data['note']);

    if (!assetKey || note === null) {
      throw new HttpsError(
        'invalid-argument',
        `Player notes must use at most ${PLAYER_NOTE_MAX_CHARACTERS} characters and ${PLAYER_NOTE_MAX_LINES} lines.`,
      );
    }

    const ref = notesRef(userId);
    const now = new Date();
    const result = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const update = updatePlayerNoteRecords(
        snapshot.data()?.['records'],
        assetKey,
        note,
        now,
      );

      if (!update) {
        throw new HttpsError(
          'resource-exhausted',
          `You can save notes for up to ${PLAYER_NOTE_MAX_COUNT} players.`,
        );
      }

      if (update.changed) {
        transaction.set(ref, {
          schemaVersion: PLAYER_NOTE_SCHEMA_VERSION,
          ownerId: userId,
          records: update.records.map((record) => ({
            assetKey: record.assetKey,
            note: record.note,
            updatedAt: Timestamp.fromDate(record.updatedAt),
          })),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }

      return update;
    });

    if (result.changed) {
      logger.info('Private player note updated.', {
        removed: !result.record,
        noteCount: result.records.length,
      });
    }

    return resultFor(
      assetKey,
      result.record?.note ?? '',
      result.record?.updatedAt ?? null,
      result.changed,
    );
  },
);
