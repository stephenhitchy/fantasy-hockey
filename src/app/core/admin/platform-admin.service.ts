import { Injectable, signal } from '@angular/core';
import { httpsCallable } from 'firebase/functions';

import { BUNDLED_RELEASE_MANIFEST } from '../../../environments/generated-release-manifest';

import type {
  BetaFeedbackCategory,
  BetaFeedbackStatus,
  BetaFeedbackTechnicalContext,
  BetaFeedbackTriageUpdate,
  BetaKnownIssueStatus,
  BetaOperationsOverview,
  BetaTriageSeverity,
} from '../beta-operations/beta-operations.models';
import { auth } from '../firebase-auth';
import { functions } from '../firebase-functions';

export type FeedbackAdminStatus = BetaFeedbackStatus;
export type ErrorAdminStatus = 'new' | 'investigating' | 'fixed' | 'ignored';

export interface PlatformAdminAccess {
  allowed: boolean;
  role: string;
}

export interface AdminFeedbackTechnicalContext
  extends Omit<BetaFeedbackTechnicalContext, 'releaseLabel' | 'buildId' | 'route' | 'appCheckClientStatus'> {
  recentAction: BetaFeedbackTechnicalContext['recentAction'];
}

export interface AdminFeedbackItem {
  feedbackId: string;
  category: BetaFeedbackCategory | string;
  severity: BetaTriageSeverity;
  summary: string;
  message: string;
  expectedResult: string;
  reproductionSteps: string;
  route: string;
  hasLeagueContext: boolean;
  leagueContextReference: string;
  allowFollowUp: boolean;
  followUpEmail: string | null;
  status: BetaFeedbackStatus;
  owner: string;
  duplicateOf: string;
  resolutionRelease: string;
  knownIssueId: string;
  knownIssueStatus: BetaKnownIssueStatus | '';
  publicTitle: string;
  publicSummary: string;
  adminNotes: string;
  reportedRelease: string;
  buildId: string;
  clientAppCheckStatus: string;
  serverAppCheckStatus: string;
  technicalContext: AdminFeedbackTechnicalContext;
  browser: string;
  createdAt: string | null;
  updatedAt: string | null;
  relatedErrorCount: number;
  relatedErrorCategories: string[];
}

export interface AdminBrowserCount {
  name: string;
  count: number;
}

export interface AdminErrorGroup {
  fingerprint: string;
  category: string;
  source: string;
  route: string;
  message: string;
  sampleStack: string;
  occurrenceCount: number;
  affectedUserCount: number;
  releases: string[];
  browsers: AdminBrowserCount[];
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  latestReportId: string;
  status: ErrorAdminStatus;
  adminNotes: string;
}

export interface AdminInboxSummary {
  newFeedbackCount: number;
  openFeedbackCount: number;
  integrityFeedbackCount: number;
  blockerFeedbackCount: number;
  totalFeedbackCount: number;
  unresolvedErrorCount: number;
  totalErrorGroupCount: number;
  capturedErrorCount: number;
}

export interface AdminInboxData {
  generatedAt: string;
  releaseLabel: string;
  feedback: AdminFeedbackItem[];
  errorGroups: AdminErrorGroup[];
  summary: AdminInboxSummary;
}

interface UpdateErrorRequest {
  fingerprint: string;
  status: ErrorAdminStatus;
  adminNotes: string;
}

@Injectable({ providedIn: 'root' })
export class PlatformAdminService {
  readonly accessLoaded = signal(false);
  readonly isAdmin = signal(false);
  readonly role = signal('');

  private accessPromise: Promise<boolean> | null = null;

  async refreshAccess(force = false): Promise<boolean> {
    if (!auth.currentUser) {
      this.accessLoaded.set(true);
      this.isAdmin.set(false);
      this.role.set('');
      return false;
    }

    if (!force && this.accessLoaded()) {
      return this.isAdmin();
    }

    if (!force && this.accessPromise) {
      return this.accessPromise;
    }

    this.accessPromise = this.loadAccess().finally(() => {
      this.accessPromise = null;
    });

    return this.accessPromise;
  }

  async loadInbox(): Promise<AdminInboxData> {
    const callable = httpsCallable<Record<string, never>, AdminInboxData>(
      functions,
      'getAdminInbox',
      { timeout: 65_000 },
    );
    const response = await callable({});
    return response.data;
  }

  async loadBetaOperations(windowDays = 14): Promise<BetaOperationsOverview> {
    const callable = httpsCallable<
      { windowDays: number; buildId: string },
      BetaOperationsOverview
    >(
      functions,
      'getBetaOperationsSnapshot',
      { timeout: 65_000 },
    );
    const response = await callable({
      windowDays,
      buildId: BUNDLED_RELEASE_MANIFEST.buildId,
    });
    return response.data;
  }

  async updateBetaFeedbackTriage(
    update: BetaFeedbackTriageUpdate,
  ): Promise<{ updated: boolean; knownIssuePublished: boolean }> {
    const callable = httpsCallable<
      BetaFeedbackTriageUpdate,
      { updated: boolean; knownIssuePublished: boolean }
    >(
      functions,
      'updateBetaFeedbackTriage',
      { timeout: 40_000 },
    );
    const response = await callable(update);
    return response.data;
  }

  async updateErrorReview(
    fingerprint: string,
    status: ErrorAdminStatus,
    adminNotes: string,
  ): Promise<void> {
    const callable = httpsCallable<UpdateErrorRequest, { updated: boolean }>(
      functions,
      'updateAdminErrorReview',
      { timeout: 35_000 },
    );
    await callable({ fingerprint, status, adminNotes });
  }

  private async loadAccess(): Promise<boolean> {
    try {
      const callable = httpsCallable<Record<string, never>, PlatformAdminAccess>(
        functions,
        'getPlatformAdminAccess',
        { timeout: 25_000 },
      );
      const response = await callable({});
      this.accessLoaded.set(true);
      this.isAdmin.set(response.data.allowed === true);
      this.role.set(response.data.role ?? '');
      return this.isAdmin();
    } catch (error: unknown) {
      console.warn('Unable to verify RinkRat platform-admin access.', error);
      this.accessLoaded.set(true);
      this.isAdmin.set(false);
      this.role.set('');
      return false;
    }
  }
}
