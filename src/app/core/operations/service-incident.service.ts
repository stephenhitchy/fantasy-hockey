import { Injectable } from '@angular/core';
import { httpsCallable } from 'firebase/functions';

import { BUNDLED_RELEASE_MANIFEST } from '../../../environments/generated-release-manifest';
import { functions } from '../firebase-functions';
import type {
  ServiceIncidentDraft,
  ServiceIncidentOperationsSnapshot,
  ServiceStatusBuildIdentity,
} from './service-status.models';

function currentBuild(): ServiceStatusBuildIdentity {
  return {
    releaseLabel: BUNDLED_RELEASE_MANIFEST.releaseLabel,
    buildId: BUNDLED_RELEASE_MANIFEST.buildId,
    scoringRulesVersion: BUNDLED_RELEASE_MANIFEST.scoringRulesVersion,
    projectionVersion: BUNDLED_RELEASE_MANIFEST.projectionVersion,
  };
}

@Injectable({ providedIn: 'root' })
export class ServiceIncidentService {
  async load(): Promise<ServiceIncidentOperationsSnapshot> {
    const callable = httpsCallable<
      { build: ServiceStatusBuildIdentity },
      ServiceIncidentOperationsSnapshot
    >(
      functions,
      'getServiceIncidentOperations',
      { timeout: 60_000 },
    );
    const response = await callable({ build: currentBuild() });
    return response.data;
  }

  async create(input: {
    incident: ServiceIncidentDraft;
    publicUpdate: string;
    internalNote: string;
    reason: string;
  }): Promise<ServiceIncidentOperationsSnapshot> {
    const callable = httpsCallable<
      typeof input & { build: ServiceStatusBuildIdentity },
      ServiceIncidentOperationsSnapshot
    >(
      functions,
      'createServiceIncident',
      { timeout: 60_000 },
    );
    const response = await callable({ ...input, build: currentBuild() });
    return response.data;
  }

  async update(input: {
    incidentId: string;
    expectedRevision: number;
    incident: ServiceIncidentDraft;
    publicUpdate: string;
    internalNote: string;
    reason: string;
  }): Promise<ServiceIncidentOperationsSnapshot> {
    const callable = httpsCallable<
      typeof input & { build: ServiceStatusBuildIdentity },
      ServiceIncidentOperationsSnapshot
    >(
      functions,
      'updateServiceIncident',
      { timeout: 60_000 },
    );
    const response = await callable({ ...input, build: currentBuild() });
    return response.data;
  }
}
