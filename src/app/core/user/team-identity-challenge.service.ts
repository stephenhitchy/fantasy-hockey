import { Injectable, signal } from '@angular/core';
import { httpsCallable } from 'firebase/functions';

import { functions } from '../firebase-functions';
import {
  TEAM_IDENTITY_UNLOCK_DETAILS,
  type TeamIdentityUnlockRequirement,
} from '../../shared/pixel-theme/pixel-theme.data';

export type EarnedTeamIdentityUnlock = Exclude<TeamIdentityUnlockRequirement, 'default'>;

export interface TeamIdentityChallengeCompletion {
  unlockRequirement: EarnedTeamIdentityUnlock;
  challengeTitle: string;
  rewardLabel: string;
  description: string;
}

interface ReconcileTeamIdentityChallengesResponse {
  unlocks: EarnedTeamIdentityUnlock[];
  newlyUnlocked: EarnedTeamIdentityUnlock[];
}

const reconcileTeamIdentityChallengesCallable = httpsCallable<
  Record<string, never>,
  ReconcileTeamIdentityChallengesResponse
>(functions, 'reconcileTeamIdentityChallenges', { timeout: 35_000 });

const REFRESH_THROTTLE_MILLISECONDS = 60_000;
const COMPLETION_VISIBLE_MILLISECONDS = 10_000;

@Injectable({ providedIn: 'root' })
export class TeamIdentityChallengeService {
  readonly currentCompletion = signal<TeamIdentityChallengeCompletion | null>(null);

  private readonly pendingCompletions: TeamIdentityChallengeCompletion[] = [];
  private currentUserId = '';
  private lastRefreshAt = 0;
  private latestUnlocks: EarnedTeamIdentityUnlock[] = [];
  private refreshPromise: Promise<EarnedTeamIdentityUnlock[]> | null = null;
  private refreshGeneration = 0;
  private dismissTimer: number | null = null;

  async refresh(
    userId: string,
    options: { force?: boolean } = {},
  ): Promise<EarnedTeamIdentityUnlock[]> {
    const normalizedUserId = userId.trim();

    if (!normalizedUserId) {
      this.reset();
      return [];
    }

    if (normalizedUserId !== this.currentUserId) {
      this.reset();
      this.currentUserId = normalizedUserId;
    }

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    const now = Date.now();
    if (
      !options.force &&
      this.lastRefreshAt > 0 &&
      now - this.lastRefreshAt < REFRESH_THROTTLE_MILLISECONDS
    ) {
      return this.latestUnlocks;
    }

    this.lastRefreshAt = now;
    const refreshGeneration = this.refreshGeneration;
    let refreshPromise: Promise<EarnedTeamIdentityUnlock[]>;
    refreshPromise = this.performRefresh(normalizedUserId, refreshGeneration)
      .finally(() => {
        if (this.refreshPromise === refreshPromise) {
          this.refreshPromise = null;
        }
      });
    this.refreshPromise = refreshPromise;

    return refreshPromise;
  }

  dismissCurrent(): void {
    this.clearDismissTimer();
    this.currentCompletion.set(null);
    this.showNextCompletion();
  }

  reset(): void {
    this.refreshGeneration += 1;
    this.clearDismissTimer();
    this.pendingCompletions.length = 0;
    this.currentCompletion.set(null);
    this.currentUserId = '';
    this.lastRefreshAt = 0;
    this.latestUnlocks = [];
    this.refreshPromise = null;
  }

  private async performRefresh(
    expectedUserId: string,
    refreshGeneration: number,
  ): Promise<EarnedTeamIdentityUnlock[]> {
    try {
      const response = await reconcileTeamIdentityChallengesCallable({});

      if (
        expectedUserId !== this.currentUserId ||
        refreshGeneration !== this.refreshGeneration
      ) {
        return this.latestUnlocks;
      }

      const unlocks = this.normalizeUnlocks(response.data.unlocks);
      const newlyUnlocked = this.normalizeUnlocks(response.data.newlyUnlocked);

      this.latestUnlocks = unlocks;
      for (const unlockRequirement of newlyUnlocked) {
        const details = TEAM_IDENTITY_UNLOCK_DETAILS[unlockRequirement];
        this.pendingCompletions.push({
          unlockRequirement,
          challengeTitle: details.challengeTitle,
          rewardLabel: details.rewardLabel,
          description: details.description,
        });
      }
      this.showNextCompletion();
      return unlocks;
    } catch (error: unknown) {
      if (
        expectedUserId === this.currentUserId &&
        refreshGeneration === this.refreshGeneration
      ) {
        console.warn('Unable to reconcile team-identity challenges.', error);
      }
      return this.latestUnlocks;
    }
  }

  private normalizeUnlocks(value: unknown): EarnedTeamIdentityUnlock[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const order: EarnedTeamIdentityUnlock[] = [
      'first-line-change',
      'commissioner-mode',
      'league-explorer',
      'crowded-schedule',
      'identity-architect',
    ];
    const saved = new Set(value.filter((item): item is string => typeof item === 'string'));
    return order.filter((unlock) => saved.has(unlock));
  }

  private showNextCompletion(): void {
    if (this.currentCompletion() || this.pendingCompletions.length === 0) {
      return;
    }

    const completion = this.pendingCompletions.shift() ?? null;
    this.currentCompletion.set(completion);

    if (completion && typeof window !== 'undefined') {
      this.dismissTimer = window.setTimeout(() => {
        this.dismissTimer = null;
        this.currentCompletion.set(null);
        this.showNextCompletion();
      }, COMPLETION_VISIBLE_MILLISECONDS);
    }
  }

  private clearDismissTimer(): void {
    if (this.dismissTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(this.dismissTimer);
    }
    this.dismissTimer = null;
  }
}
