import { logger } from 'firebase-functions';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { db } from './shared/core/firebase';
import { requireFirestoreDocumentId } from './shared/security/firestore-document-id.util';
import {
  calculateTeamIdentityChallengeUnlocks,
  normalizeTeamIdentityUnlocks,
  type TeamIdentityUnlock,
} from './shared/core/user/team-identity-challenge.util';
import { TRUSTED_WEB_ORIGINS } from './web-security';

const FUNCTION_REGION = 'us-central1';
const MAX_LEAGUES_PER_RECONCILIATION = 32;

interface ReconcileTeamIdentityChallengesResult {
  unlocks: TeamIdentityUnlock[];
  newlyUnlocked: TeamIdentityUnlock[];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asSafeTeamCount(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 32
    ? value
    : 1;
}

export const reconcileTeamIdentityChallenges = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 45,
    memory: '256MiB',
    maxInstances: 40,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<ReconcileTeamIdentityChallengesResult> => {
    if (!request.auth?.uid) {
      throw new HttpsError('unauthenticated', 'You must be signed in to check challenges.');
    }

    const userId = requireFirestoreDocumentId(
      asString(request.auth.uid),
      'manager ID',
      { maxBytes: 128 },
    );

    const membershipSnapshot = await db
      .collectionGroup('members')
      .where('uid', '==', userId)
      .limit(MAX_LEAGUES_PER_RECONCILIATION + 1)
      .get();

    if (membershipSnapshot.size > MAX_LEAGUES_PER_RECONCILIATION) {
      throw new HttpsError(
        'resource-exhausted',
        'Your challenge history is larger than the supported league limit.',
      );
    }

    const membershipsByLeagueId = new Map<string, Record<string, unknown>>();
    const leagueRefs = membershipSnapshot.docs.flatMap((membershipDocument) => {
      const leagueRef = membershipDocument.ref.parent.parent;
      if (!leagueRef || leagueRef.parent.id !== 'leagues') {
        return [];
      }

      membershipsByLeagueId.set(
        leagueRef.id,
        membershipDocument.data() as Record<string, unknown>,
      );
      return [leagueRef];
    });
    const leagueSnapshots = leagueRefs.length > 0
      ? await db.getAll(...leagueRefs)
      : [];

    let commissionerLeagueCount = 0;
    let opponentCount = 0;

    for (const leagueSnapshot of leagueSnapshots) {
      if (!leagueSnapshot.exists) {
        continue;
      }

      const league = leagueSnapshot.data() as Record<string, unknown>;
      const membership = membershipsByLeagueId.get(leagueSnapshot.id) ?? {};
      const teamCount = asSafeTeamCount(league['teamCount']);

      opponentCount += Math.max(0, teamCount - 1);
      if (
        asString(membership['role']) === 'commissioner' ||
        asString(league['commissionerId']) === userId
      ) {
        commissionerLeagueCount += 1;
      }
    }

    const leagueCount = leagueSnapshots.filter((snapshot) => snapshot.exists).length;
    const userRef = db.doc(`users/${userId}`);
    const result = await db.runTransaction(async (transaction) => {
      const userSnapshot = await transaction.get(userRef);

      if (!userSnapshot.exists) {
        throw new HttpsError(
          'failed-precondition',
          'Your manager profile could not be found.',
        );
      }

      const existingUnlocks = normalizeTeamIdentityUnlocks(
        userSnapshot.data()?.['teamIdentityUnlocks'],
      );
      const unlocks = calculateTeamIdentityChallengeUnlocks({
        existingUnlocks,
        leagueCount,
        commissionerLeagueCount,
        opponentCount,
      });
      const newlyUnlocked = unlocks.filter((unlock) => !existingUnlocks.includes(unlock));

      if (newlyUnlocked.length > 0) {
        transaction.set(userRef, { teamIdentityUnlocks: unlocks }, { merge: true });
      }

      return { unlocks, newlyUnlocked };
    });

    if (result.newlyUnlocked.length > 0) {
      logger.info('Team identity challenge completed.', {
        userId,
        newlyUnlocked: result.newlyUnlocked,
      });
    }

    return result;
  },
);
