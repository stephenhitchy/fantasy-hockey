import { Injectable } from '@angular/core';
import { httpsCallable } from 'firebase/functions';

import { BUNDLED_RELEASE_MANIFEST } from '../../../environments/generated-release-manifest';
import { functions } from '../firebase-functions';
import type {
  PrivacyCenterSnapshot,
  PrivacyExportPackageResponse,
  PrivacyOperationsDashboard,
  PrivacyRequestAdminRecord,
  PrivacyRequestRecord,
  PrivacyRequestStatus,
  PrivacyRequestType,
} from './privacy-operations.models';

interface PrivacyBuildIdentity {
  releaseLabel: string;
  buildId: string;
  scoringRulesVersion: number;
  projectionVersion: number;
}

function currentBuild(): PrivacyBuildIdentity {
  return {
    releaseLabel: BUNDLED_RELEASE_MANIFEST.releaseLabel,
    buildId: BUNDLED_RELEASE_MANIFEST.buildId,
    scoringRulesVersion: BUNDLED_RELEASE_MANIFEST.scoringRulesVersion,
    projectionVersion: BUNDLED_RELEASE_MANIFEST.projectionVersion,
  };
}

@Injectable({ providedIn: 'root' })
export class PrivacyOperationsService {
  async loadMyCenter(): Promise<PrivacyCenterSnapshot> {
    const callable = httpsCallable<
      { build: PrivacyBuildIdentity },
      PrivacyCenterSnapshot
    >(functions, 'getMyPrivacyCenter', { timeout: 65_000 });
    const response = await callable({ build: currentBuild() });
    return response.data;
  }

  async createRequest(input: {
    requestType: PrivacyRequestType;
    subject: string;
    details: string;
  }): Promise<PrivacyRequestRecord> {
    const callable = httpsCallable<
      {
        action: 'create';
        requestType: PrivacyRequestType;
        subject: string;
        details: string;
        build: PrivacyBuildIdentity;
      },
      { updated: boolean; request: PrivacyRequestRecord }
    >(functions, 'manageMyPrivacyRequest', { timeout: 65_000 });
    const response = await callable({ action: 'create', ...input, build: currentBuild() });
    return response.data.request;
  }

  async respondToRequest(input: {
    requestId: string;
    expectedRevision: number;
    message: string;
  }): Promise<PrivacyRequestRecord> {
    const callable = httpsCallable<
      {
        action: 'respond';
        requestId: string;
        expectedRevision: number;
        message: string;
        build: PrivacyBuildIdentity;
      },
      { updated: boolean; request: PrivacyRequestRecord }
    >(functions, 'manageMyPrivacyRequest', { timeout: 65_000 });
    const response = await callable({ action: 'respond', ...input, build: currentBuild() });
    return response.data.request;
  }

  async cancelRequest(input: {
    requestId: string;
    expectedRevision: number;
  }): Promise<PrivacyRequestRecord> {
    const callable = httpsCallable<
      {
        action: 'cancel';
        requestId: string;
        expectedRevision: number;
        build: PrivacyBuildIdentity;
      },
      { updated: boolean; request: PrivacyRequestRecord }
    >(functions, 'manageMyPrivacyRequest', { timeout: 65_000 });
    const response = await callable({ action: 'cancel', ...input, build: currentBuild() });
    return response.data.request;
  }

  async prepareMyExport(): Promise<PrivacyExportPackageResponse> {
    const callable = httpsCallable<
      { build: PrivacyBuildIdentity },
      PrivacyExportPackageResponse
    >(functions, 'getMyPrivacyExport', { timeout: 140_000 });
    const response = await callable({ build: currentBuild() });
    return response.data;
  }

  async loadOperations(): Promise<PrivacyOperationsDashboard> {
    const callable = httpsCallable<
      { build: PrivacyBuildIdentity },
      PrivacyOperationsDashboard
    >(functions, 'getPrivacyRequestOperations', { timeout: 95_000 });
    const response = await callable({ build: currentBuild() });
    return response.data;
  }

  async updateOperation(input: {
    requestId: string;
    expectedRevision: number;
    status: PrivacyRequestStatus;
    publicResponse: string;
    adminNotes: string;
    auditReason: string;
  }): Promise<PrivacyRequestAdminRecord> {
    const callable = httpsCallable<
      {
        requestId: string;
        expectedRevision: number;
        status: PrivacyRequestStatus;
        publicResponse: string;
        adminNotes: string;
        auditReason: string;
        build: PrivacyBuildIdentity;
      },
      { updated: true; request: PrivacyRequestAdminRecord }
    >(functions, 'updatePrivacyRequestOperation', { timeout: 65_000 });
    const response = await callable({ ...input, build: currentBuild() });
    return response.data.request;
  }
}
