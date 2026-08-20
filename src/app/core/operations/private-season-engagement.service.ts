import { Injectable } from '@angular/core';
import { httpsCallable } from 'firebase/functions';

import { BUNDLED_RELEASE_MANIFEST } from '../../../environments/generated-release-manifest';
import { auth } from '../firebase-auth';
import { functions } from '../firebase-functions';
import type {
  PrivateSeasonEngagementCategory,
} from './private-season-health.models';
import type { PrivateSeasonBuildIdentity } from './private-season.models';

interface PrivateSeasonEngagementResponse {
  accepted: boolean;
  reason: string;
}

function currentBuild(): PrivateSeasonBuildIdentity {
  return {
    releaseLabel: BUNDLED_RELEASE_MANIFEST.releaseLabel,
    buildId: BUNDLED_RELEASE_MANIFEST.buildId,
    scoringRulesVersion: BUNDLED_RELEASE_MANIFEST.scoringRulesVersion,
    projectionVersion: BUNDLED_RELEASE_MANIFEST.projectionVersion,
  };
}

function engagementCategory(path: string): PrivateSeasonEngagementCategory {
  if (/\/draft(?:\/|$)/.test(path)) {
    return 'draft';
  }
  if (/\/cycles\/\d+(?:\/|$)/.test(path)) {
    return 'game-center';
  }
  if (/\/(?:team|players|decision-history)(?:\/|$)/.test(path)) {
    return 'roster';
  }
  if (/\/standings(?:\/|$)/.test(path)) {
    return 'standings';
  }
  if (/^\/leagues\/[^/]+\/?$/.test(path)) {
    return 'league-home';
  }
  return 'other';
}

@Injectable({ providedIn: 'root' })
export class PrivateSeasonEngagementService {
  private readonly recorded = new Set<string>();
  private readonly ignoredLeagues = new Set<string>();

  observeRoute(rawPath: string): void {
    const path = rawPath.split(/[?#]/)[0] || '/';
    const match = path.match(/^\/leagues\/([^/]+)(?:\/|$)/);
    if (!match?.[1]) {
      return;
    }

    const category = engagementCategory(path);
    // Game Center is recorded only after its live league data loads successfully.
    if (category === 'game-center') {
      return;
    }

    this.recordLeagueActivity(decodeURIComponent(match[1]), category);
  }

  recordLeagueActivity(
    leagueId: string,
    category: PrivateSeasonEngagementCategory,
  ): void {
    void this.recordActivity(leagueId, category);
  }

  private async recordActivity(
    leagueId: string,
    category: PrivateSeasonEngagementCategory,
  ): Promise<void> {
    const user = auth.currentUser;
    const build = currentBuild();
    if (!user || !user.emailVerified || build.buildId.endsWith('-local')) {
      return;
    }

    const leagueKey = `${user.uid}:${leagueId}`;
    if (this.ignoredLeagues.has(leagueKey)) {
      return;
    }

    const dateKey = new Date().toISOString().slice(0, 10);
    const recordKey = `${leagueKey}:${dateKey}:${category}`;
    if (this.recorded.has(recordKey)) {
      return;
    }
    this.recorded.add(recordKey);

    try {
      const callable = httpsCallable<
        {
          leagueId: string;
          category: PrivateSeasonEngagementCategory;
          build: PrivateSeasonBuildIdentity;
        },
        PrivateSeasonEngagementResponse
      >(functions, 'recordPrivateSeasonEngagement', { timeout: 25_000 });
      const response = await callable({ leagueId, category, build });
      if (!response.data.accepted && response.data.reason === 'not-tracked') {
        this.ignoredLeagues.add(leagueKey);
      }
    } catch {
      this.recorded.delete(recordKey);
    }
  }
}
