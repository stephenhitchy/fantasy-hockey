import { Injectable } from '@angular/core';
import { httpsCallable } from 'firebase/functions';

import { BUNDLED_RELEASE_MANIFEST } from '../../../environments/generated-release-manifest';
import { functions } from '../firebase-functions';
import type {
  PrivateSeasonBuildIdentity,
  PrivateSeasonControlCenterSnapshot,
  PrivateSeasonGateOutcome,
  PrivateSeasonPlan,
} from './private-season.models';

function currentBuild(): PrivateSeasonBuildIdentity {
  return {
    releaseLabel: BUNDLED_RELEASE_MANIFEST.releaseLabel,
    buildId: BUNDLED_RELEASE_MANIFEST.buildId,
    scoringRulesVersion: BUNDLED_RELEASE_MANIFEST.scoringRulesVersion,
    projectionVersion: BUNDLED_RELEASE_MANIFEST.projectionVersion,
  };
}

@Injectable({ providedIn: 'root' })
export class PrivateSeasonService {
  async load(): Promise<PrivateSeasonControlCenterSnapshot> {
    const callable = httpsCallable<
      { build: PrivateSeasonBuildIdentity },
      PrivateSeasonControlCenterSnapshot
    >(functions, 'getPrivateSeasonControlCenter', { timeout: 50_000 });
    const response = await callable({ build: currentBuild() });
    return response.data;
  }

  async save(input: {
    expectedRevision: number;
    plan: PrivateSeasonPlan;
    reason: string;
  }): Promise<PrivateSeasonControlCenterSnapshot> {
    const callable = httpsCallable<
      {
        expectedRevision: number;
        plan: PrivateSeasonPlan;
        reason: string;
        build: PrivateSeasonBuildIdentity;
      },
      PrivateSeasonControlCenterSnapshot
    >(functions, 'updatePrivateSeasonPlan', { timeout: 65_000 });
    const response = await callable({ ...input, build: currentBuild() });
    return response.data;
  }

  async recordDecision(input: {
    expectedRevision: number;
    outcome: PrivateSeasonGateOutcome;
    reason: string;
  }): Promise<PrivateSeasonControlCenterSnapshot> {
    const callable = httpsCallable<
      {
        expectedRevision: number;
        outcome: PrivateSeasonGateOutcome;
        reason: string;
        build: PrivateSeasonBuildIdentity;
      },
      PrivateSeasonControlCenterSnapshot
    >(functions, 'recordPrivateSeasonGateDecision', { timeout: 65_000 });
    const response = await callable({ ...input, build: currentBuild() });
    return response.data;
  }
}
