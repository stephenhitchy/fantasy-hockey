import { Injectable } from '@angular/core';
import { httpsCallable } from 'firebase/functions';

import { BUNDLED_RELEASE_MANIFEST } from '../../../environments/generated-release-manifest';
import { functions } from '../firebase-functions';
import type {
  PrivateSeasonHealthSnapshot,
  PrivateSeasonWeeklyHealthRecord,
} from './private-season-health.models';
import type { PrivateSeasonBuildIdentity } from './private-season.models';

function currentBuild(): PrivateSeasonBuildIdentity {
  return {
    releaseLabel: BUNDLED_RELEASE_MANIFEST.releaseLabel,
    buildId: BUNDLED_RELEASE_MANIFEST.buildId,
    scoringRulesVersion: BUNDLED_RELEASE_MANIFEST.scoringRulesVersion,
    projectionVersion: BUNDLED_RELEASE_MANIFEST.projectionVersion,
  };
}

@Injectable({ providedIn: 'root' })
export class PrivateSeasonHealthService {
  async load(): Promise<PrivateSeasonHealthSnapshot> {
    const callable = httpsCallable<
      { build: PrivateSeasonBuildIdentity },
      PrivateSeasonHealthSnapshot
    >(functions, 'getPrivateSeasonHealthDashboard', { timeout: 95_000 });
    const response = await callable({ build: currentBuild() });
    return response.data;
  }

  async saveWeekly(input: {
    expectedRevision: number;
    record: PrivateSeasonWeeklyHealthRecord;
    reason: string;
  }): Promise<PrivateSeasonHealthSnapshot> {
    const callable = httpsCallable<
      {
        expectedRevision: number;
        record: PrivateSeasonWeeklyHealthRecord;
        reason: string;
        build: PrivateSeasonBuildIdentity;
      },
      PrivateSeasonHealthSnapshot
    >(functions, 'updatePrivateSeasonWeeklyHealth', { timeout: 95_000 });
    const response = await callable({ ...input, build: currentBuild() });
    return response.data;
  }
}
