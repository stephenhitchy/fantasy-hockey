import { Injectable } from '@angular/core';
import { httpsCallable } from 'firebase/functions';

import { BUNDLED_RELEASE_MANIFEST } from '../../../environments/generated-release-manifest';
import { functions } from '../firebase-functions';
import type { PrivateSeasonBuildIdentity } from './private-season.models';
import type {
  PrivateSeasonResearchAnswers,
  PrivateSeasonResearchDashboardSnapshot,
  PrivateSeasonResearchManagerSnapshot,
  PrivateSeasonResearchMilestone,
} from './private-season-research.models';

function currentBuild(): PrivateSeasonBuildIdentity {
  return {
    releaseLabel: BUNDLED_RELEASE_MANIFEST.releaseLabel,
    buildId: BUNDLED_RELEASE_MANIFEST.buildId,
    scoringRulesVersion: BUNDLED_RELEASE_MANIFEST.scoringRulesVersion,
    projectionVersion: BUNDLED_RELEASE_MANIFEST.projectionVersion,
  };
}

@Injectable({ providedIn: 'root' })
export class PrivateSeasonResearchService {
  async loadMine(): Promise<PrivateSeasonResearchManagerSnapshot> {
    const callable = httpsCallable<
      { build: PrivateSeasonBuildIdentity },
      PrivateSeasonResearchManagerSnapshot
    >(functions, 'getPrivateSeasonResearch', { timeout: 65_000 });
    const response = await callable({ build: currentBuild() });
    return response.data;
  }

  async submit(input: {
    leagueId: string;
    milestone: PrivateSeasonResearchMilestone;
    expectedRevision: number;
    answers: PrivateSeasonResearchAnswers;
  }): Promise<PrivateSeasonResearchManagerSnapshot> {
    const callable = httpsCallable<
      {
        leagueId: string;
        milestone: PrivateSeasonResearchMilestone;
        expectedRevision: number;
        answers: PrivateSeasonResearchAnswers;
        build: PrivateSeasonBuildIdentity;
      },
      PrivateSeasonResearchManagerSnapshot
    >(functions, 'submitPrivateSeasonResearch', { timeout: 65_000 });
    const response = await callable({ ...input, build: currentBuild() });
    return response.data;
  }

  async loadDashboard(): Promise<PrivateSeasonResearchDashboardSnapshot> {
    const callable = httpsCallable<
      { build: PrivateSeasonBuildIdentity },
      PrivateSeasonResearchDashboardSnapshot
    >(functions, 'getPrivateSeasonResearchDashboard', { timeout: 95_000 });
    const response = await callable({ build: currentBuild() });
    return response.data;
  }
}
