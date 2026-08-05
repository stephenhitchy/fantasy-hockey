import { Injectable, signal } from '@angular/core';
import { httpsCallable } from 'firebase/functions';

import { auth } from '../firebase-auth';
import { functions } from '../firebase-functions';

export type FeedbackAdminStatus =
  | 'new'
  | 'reviewing'
  | 'planned'
  | 'in-progress'
  | 'resolved'
  | 'not-planned';

export type ErrorAdminStatus = 'new' | 'investigating' | 'fixed' | 'ignored';

export interface PlatformAdminAccess {
  allowed: boolean;
  role: string;
}

export interface AdminFeedbackItem {
  feedbackId: string;
  category: string;
  message: string;
  route: string;
  leagueId: string | null;
  allowFollowUp: boolean;
  followUpEmail: string | null;
  status: FeedbackAdminStatus;
  adminNotes: string;
  userAgent: string;
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

interface UpdateFeedbackRequest {
  feedbackId: string;
  status: FeedbackAdminStatus;
  adminNotes: string;
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

  async updateFeedback(
    feedbackId: string,
    status: FeedbackAdminStatus,
    adminNotes: string,
  ): Promise<void> {
    const callable = httpsCallable<UpdateFeedbackRequest, { updated: boolean }>(
      functions,
      'updateAdminFeedback',
      { timeout: 35_000 },
    );
    await callable({ feedbackId, status, adminNotes });
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
