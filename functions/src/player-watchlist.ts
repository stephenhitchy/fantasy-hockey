import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { db } from './shared/core/firebase';
import {
  normalizePlayerWatchlist,
  normalizePlayerWatchlistAssetKey,
  PLAYER_WATCHLIST_MAX_COUNT,
  PLAYER_WATCHLIST_SCHEMA_VERSION,
  updatePlayerWatchlist,
} from './shared/core/user/player-watchlist.util';
import {
  requireAuthenticatedUserId,
  requireVerifiedEmail,
} from './shared/security/auth-security.util';
import { TRUSTED_WEB_ORIGINS } from './web-security';

const FUNCTION_REGION = 'us-central1';
const CALLABLE_OPTIONS = {
  region: FUNCTION_REGION,
  timeoutSeconds: 20,
  memory: '256MiB' as const,
  maxInstances: 40,
  cors: TRUSTED_WEB_ORIGINS,
  invoker: 'public' as const,
};

interface PlayerWatchlistResult {
  assetKeys: string[];
  maximumCount: number;
  changed: boolean;
}

function watchlistRef(userId: string) {
  return db.doc(`managerWatchlists/${userId}`);
}

export const getPlayerWatchlist = onCall(
  CALLABLE_OPTIONS,
  async (request): Promise<PlayerWatchlistResult> => {
    const actionLabel = 'load your player watchlist';
    const userId = requireAuthenticatedUserId(request.auth, actionLabel);
    requireVerifiedEmail(request.auth, actionLabel);

    const snapshot = await watchlistRef(userId).get();
    const assetKeys = normalizePlayerWatchlist(snapshot.data()?.['assetKeys']);

    return {
      assetKeys,
      maximumCount: PLAYER_WATCHLIST_MAX_COUNT,
      changed: false,
    };
  },
);

export const setPlayerWatchlistEntry = onCall(
  CALLABLE_OPTIONS,
  async (request): Promise<PlayerWatchlistResult> => {
    const actionLabel = 'update your player watchlist';
    const userId = requireAuthenticatedUserId(request.auth, actionLabel);
    requireVerifiedEmail(request.auth, actionLabel);

    const data = request.data !== null && typeof request.data === 'object'
      ? request.data as Record<string, unknown>
      : {};
    const assetKey = normalizePlayerWatchlistAssetKey(data['assetKey']);
    const watched = data['watched'];

    if (!assetKey || typeof watched !== 'boolean') {
      throw new HttpsError('invalid-argument', 'Choose a valid player to update.');
    }

    const ref = watchlistRef(userId);
    const result = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const update = updatePlayerWatchlist(
        snapshot.data()?.['assetKeys'],
        assetKey,
        watched,
      );

      if (!update) {
        const current = normalizePlayerWatchlist(snapshot.data()?.['assetKeys']);
        if (watched && current.length >= PLAYER_WATCHLIST_MAX_COUNT) {
          throw new HttpsError(
            'resource-exhausted',
            `Your watchlist can hold up to ${PLAYER_WATCHLIST_MAX_COUNT} players.`,
          );
        }

        throw new HttpsError('invalid-argument', 'Choose a valid player to update.');
      }

      if (update.changed) {
        transaction.set(ref, {
          schemaVersion: PLAYER_WATCHLIST_SCHEMA_VERSION,
          ownerId: userId,
          assetKeys: update.assetKeys,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }

      return update;
    });

    if (result.changed) {
      logger.info('Player watchlist updated.', {
        watched,
        count: result.assetKeys.length,
      });
    }

    return {
      assetKeys: result.assetKeys,
      maximumCount: PLAYER_WATCHLIST_MAX_COUNT,
      changed: result.changed,
    };
  },
);
