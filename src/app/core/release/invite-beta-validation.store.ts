import { Injectable } from '@angular/core';

import {
  createInviteBetaValidationSession,
  InviteBetaValidationSession,
  normalizeInviteBetaValidationSession,
} from './invite-beta-validation.util';

const STORAGE_PREFIX = 'rinkrat:invite-beta-validation';

function storageKey(leagueId: string, releaseKey: string): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(releaseKey)}:${encodeURIComponent(leagueId)}`;
}

@Injectable({ providedIn: 'root' })
export class InviteBetaValidationStore {
  load(
    leagueId: string,
    releaseKey: string,
    releaseLabel: string,
  ): InviteBetaValidationSession {
    const fallback = createInviteBetaValidationSession(releaseKey, releaseLabel);

    if (typeof window === 'undefined') {
      return fallback;
    }

    try {
      const raw = window.localStorage.getItem(storageKey(leagueId, releaseKey));
      return raw
        ? normalizeInviteBetaValidationSession(
            JSON.parse(raw),
            releaseKey,
            releaseLabel,
          )
        : fallback;
    } catch {
      return fallback;
    }
  }

  save(
    leagueId: string,
    releaseKey: string,
    session: InviteBetaValidationSession,
  ): boolean {
    if (typeof window === 'undefined') {
      return false;
    }

    try {
      window.localStorage.setItem(
        storageKey(leagueId, releaseKey),
        JSON.stringify(session),
      );
      return true;
    } catch {
      return false;
    }
  }

  clear(leagueId: string, releaseKey: string): boolean {
    if (typeof window === 'undefined') {
      return false;
    }

    try {
      window.localStorage.removeItem(storageKey(leagueId, releaseKey));
      return true;
    } catch {
      return false;
    }
  }
}
