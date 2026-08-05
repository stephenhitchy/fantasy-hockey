import { Injectable, signal } from '@angular/core';

import { ClientHealthService } from './client-health.service';
import {
  buildCompetitiveActionHealthSnapshot,
  COMPETITIVE_ACTION_MAX_RECORDS,
  normalizeCompetitiveActionRecords,
  type ActiveCompetitiveActionRecord,
  type CompetitiveActionHealthSnapshot,
  type CompetitiveActionKind,
  type CompetitiveActionOutcome,
  type CompetitiveActionRecord,
} from './competitive-action-health.util';
import { TelemetryService } from './telemetry.service';

const STORAGE_KEY = 'rinkrat:competitive-action-health:v1';

export interface CompetitiveActionHandle {
  readonly id: string;
  readonly action: CompetitiveActionKind;
  finish(outcome: CompetitiveActionOutcome): void;
}

function createActionId(action: CompetitiveActionKind): string {
  const suffix = Math.random().toString(36).slice(2, 9);
  return `${action}-${Date.now().toString(36)}-${suffix}`;
}

@Injectable({ providedIn: 'root' })
export class CompetitiveActionMonitorService {
  readonly activeCount = signal(0);

  private readonly activeActions = new Map<string, ActiveCompetitiveActionRecord>();
  private completedRecords: CompetitiveActionRecord[] = [];

  constructor(
    private readonly telemetry: TelemetryService,
    private readonly clientHealth: ClientHealthService,
  ) {
    this.completedRecords = this.readStoredRecords();
  }

  begin(action: CompetitiveActionKind): CompetitiveActionHandle {
    const id = createActionId(action);
    const startedAtMilliseconds = Date.now();
    const connection = this.clientHealth.getSnapshot();
    const active: ActiveCompetitiveActionRecord = {
      id,
      action,
      route: this.telemetry.sanitizedCurrentRoute(),
      startedAtMilliseconds,
      connectionType: connection.effectiveConnectionType,
      online: connection.online,
    };

    this.activeActions.set(id, active);
    this.activeCount.set(this.activeActions.size);
    let finished = false;

    return {
      id,
      action,
      finish: (outcome: CompetitiveActionOutcome): void => {
        if (finished) {
          return;
        }

        finished = true;
        this.finishAction(active, outcome);
      },
    };
  }

  getSnapshot(): CompetitiveActionHealthSnapshot {
    return buildCompetitiveActionHealthSnapshot(
      this.completedRecords,
      [...this.activeActions.values()],
    );
  }

  clearSessionHistory(): void {
    this.completedRecords = [];
    this.persistRecords();
  }

  private finishAction(
    active: ActiveCompetitiveActionRecord,
    outcome: CompetitiveActionOutcome,
  ): void {
    this.activeActions.delete(active.id);
    this.activeCount.set(this.activeActions.size);
    const finishedAtMilliseconds = Date.now();
    const record: CompetitiveActionRecord = {
      id: active.id,
      action: active.action,
      outcome,
      route: active.route,
      startedAt: new Date(active.startedAtMilliseconds).toISOString(),
      finishedAt: new Date(finishedAtMilliseconds).toISOString(),
      durationMilliseconds: Math.max(0, finishedAtMilliseconds - active.startedAtMilliseconds),
      connectionType: active.connectionType,
      online: active.online,
    };

    this.completedRecords = normalizeCompetitiveActionRecords([
      record,
      ...this.completedRecords,
    ]).slice(0, COMPETITIVE_ACTION_MAX_RECORDS);
    this.persistRecords();

    this.telemetry.track('competitive_action', {
      action: record.action,
      outcome: record.outcome,
      duration_ms: record.durationMilliseconds,
      connection_type: record.connectionType,
      started_online: record.online,
    });
  }

  private readStoredRecords(): CompetitiveActionRecord[] {
    if (typeof sessionStorage === 'undefined') {
      return [];
    }

    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? normalizeCompetitiveActionRecords(JSON.parse(raw)) : [];
    } catch {
      return [];
    }
  }

  private persistRecords(): void {
    if (typeof sessionStorage === 'undefined') {
      return;
    }

    try {
      if (this.completedRecords.length) {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(this.completedRecords));
      } else {
        sessionStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // Session storage may be unavailable in private or hardened browser modes.
    }
  }
}
