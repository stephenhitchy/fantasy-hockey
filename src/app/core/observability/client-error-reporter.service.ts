import { Injectable } from '@angular/core';
import { APP_RUNTIME_CONFIG } from '../../../environments/app-runtime.config';
import { httpsCallable } from 'firebase/functions';

import { auth } from '../firebase-auth';
import { functions } from '../firebase-functions';
import { TelemetryService } from './telemetry.service';

interface ClientErrorReportRequest {
  message: string;
  stack: string;
  route: string;
  source: string;
  category: string;
  appVersion: string;
}

interface ClientErrorReportResponse {
  accepted: boolean;
  reportId: string;
}

const MAX_REPORTS_PER_SESSION = 8;
const DEDUPE_WINDOW_MILLISECONDS = 60_000;

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || 'Unknown application error';
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown application error';
  }
}

function errorStack(error: unknown): string {
  return error instanceof Error && error.stack ? error.stack : '';
}

function classifyError(message: string): string {
  const normalized = message.toLowerCase();

  if (normalized.includes('permission-denied') || normalized.includes('insufficient permissions')) {
    return 'permission';
  }

  if (normalized.includes('network') || normalized.includes('offline') || normalized.includes('failed to fetch')) {
    return 'network';
  }

  if (normalized.includes('deadline') || normalized.includes('timeout')) {
    return 'timeout';
  }

  if (normalized.includes('auth/')) {
    return 'authentication';
  }

  return 'application';
}

@Injectable({ providedIn: 'root' })
export class ClientErrorReporterService {
  private readonly recentSignatures = new Map<string, number>();
  private reportCount = 0;

  constructor(private readonly telemetry: TelemetryService) {}

  report(error: unknown, source = 'angular'): void {
    const message = errorMessage(error).slice(0, 500);
    const stack = errorStack(error).slice(0, 4_000);
    const route = this.telemetry.sanitizedCurrentRoute().slice(0, 300);
    const category = classifyError(message);

    console.error(error);
    this.telemetry.trackErrorCategory(category, source);

    if (!auth.currentUser || this.reportCount >= MAX_REPORTS_PER_SESSION) {
      return;
    }

    const signature = `${category}|${message}|${route}`.slice(0, 900);
    const now = Date.now();
    const previous = this.recentSignatures.get(signature) ?? 0;

    if (now - previous < DEDUPE_WINDOW_MILLISECONDS) {
      return;
    }

    this.recentSignatures.set(signature, now);
    this.reportCount += 1;

    const callable = httpsCallable<ClientErrorReportRequest, ClientErrorReportResponse>(
      functions,
      'reportClientError',
    );

    void callable({
      message,
      stack,
      route,
      source: source.slice(0, 60),
      category,
      appVersion: APP_RUNTIME_CONFIG.releaseLabel,
    }).catch((reportError: unknown) => {
      console.warn('Unable to submit the client error report.', reportError);
    });
  }
}
