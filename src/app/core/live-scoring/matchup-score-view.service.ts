import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';

import { db } from '../firebase';

const SCORE_VIEW_SCHEMA_VERSION = 1;
const SCORE_VIEW_READ_TIMEOUT_MS = 3500;
const LOCAL_SCORE_VIEW_PREFIX = 'fantasy-hockey:matchup-score-view:v1';

export interface MatchupScoreViewState {
  schemaVersion: 1;
  userId: string;
  leagueId: string;
  cycleNumber: number;
  scores: Record<string, number>;
  observedAtIso?: string;
}

function getScoreViewDocumentId(leagueId: string, cycleNumber: number): string {
  return `${leagueId}__cycle-${cycleNumber}`;
}

function getScoreViewRef(userId: string, leagueId: string, cycleNumber: number) {
  return doc(
    db,
    'users',
    userId,
    'matchupScoreViews',
    getScoreViewDocumentId(leagueId, cycleNumber),
  );
}

function getLocalScoreViewKey(userId: string, leagueId: string, cycleNumber: number): string {
  return [LOCAL_SCORE_VIEW_PREFIX, userId, leagueId, cycleNumber].join(':');
}

function normalizeScores(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, score]) => typeof score === 'number' && Number.isFinite(score))
      .map(([assetKey, score]) => [assetKey, Number((score as number).toFixed(1))]),
  );
}

function normalizeState(
  value: unknown,
  userId: string,
  leagueId: string,
  cycleNumber: number,
): MatchupScoreViewState | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;

  if (
    record['userId'] !== userId ||
    record['leagueId'] !== leagueId ||
    record['cycleNumber'] !== cycleNumber
  ) {
    return null;
  }

  return {
    schemaVersion: SCORE_VIEW_SCHEMA_VERSION,
    userId,
    leagueId,
    cycleNumber,
    scores: normalizeScores(record['scores']),
    observedAtIso:
      typeof record['observedAtIso'] === 'string' ? record['observedAtIso'] : undefined,
  };
}

function readLocalState(
  userId: string,
  leagueId: string,
  cycleNumber: number,
): MatchupScoreViewState | null {
  if (typeof localStorage === 'undefined') {
    return null;
  }

  try {
    const raw = localStorage.getItem(getLocalScoreViewKey(userId, leagueId, cycleNumber));
    return raw ? normalizeState(JSON.parse(raw), userId, leagueId, cycleNumber) : null;
  } catch {
    return null;
  }
}

function writeLocalState(state: MatchupScoreViewState): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  try {
    localStorage.setItem(
      getLocalScoreViewKey(state.userId, state.leagueId, state.cycleNumber),
      JSON.stringify(state),
    );
  } catch {
    // Score-view persistence is a visual enhancement and must never block scoring.
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Score-view state read timed out.')), timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export async function getMatchupScoreViewState(
  userId: string,
  leagueId: string,
  cycleNumber: number,
): Promise<MatchupScoreViewState | null> {
  const localState = readLocalState(userId, leagueId, cycleNumber);

  try {
    const snapshot = await withTimeout(
      getDoc(getScoreViewRef(userId, leagueId, cycleNumber)),
      SCORE_VIEW_READ_TIMEOUT_MS,
    );

    if (!snapshot.exists()) {
      return localState;
    }

    const remoteState = normalizeState(snapshot.data(), userId, leagueId, cycleNumber);

    if (remoteState) {
      writeLocalState(remoteState);
      return remoteState;
    }
  } catch {
    // Offline, blocked, or slow reads fall back to the same-browser state.
  }

  return localState;
}

export async function saveMatchupScoreViewState(input: {
  userId: string;
  leagueId: string;
  cycleNumber: number;
  scores: Record<string, number>;
}): Promise<void> {
  const state: MatchupScoreViewState = {
    schemaVersion: SCORE_VIEW_SCHEMA_VERSION,
    userId: input.userId,
    leagueId: input.leagueId,
    cycleNumber: input.cycleNumber,
    scores: normalizeScores(input.scores),
    observedAtIso: new Date().toISOString(),
  };

  writeLocalState(state);

  await setDoc(
    getScoreViewRef(input.userId, input.leagueId, input.cycleNumber),
    {
      ...state,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}
