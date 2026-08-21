import { Injectable } from '@angular/core';
import { httpsCallable } from 'firebase/functions';

import { functions } from '../firebase-functions';
import { currentOperationsClientIdentity } from './operations-client-compatibility';
import type {
  PrivateSeasonHealthSnapshot,
  PrivateSeasonWeeklyHealthRecord,
} from './private-season-health.models';
import type { PrivateSeasonBuildIdentity } from './private-season.models';

function currentBuild(): PrivateSeasonBuildIdentity {
  return currentOperationsClientIdentity();
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
