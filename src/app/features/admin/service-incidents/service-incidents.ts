import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { ServiceIncidentService } from '../../../core/operations/service-incident.service';
import { ServiceStatusService } from '../../../core/operations/service-status.service';
import type {
  ServiceIncidentAdminRecord,
  ServiceIncidentComponent,
  ServiceIncidentCompetitiveImpact,
  ServiceIncidentDataState,
  ServiceIncidentDraft,
  ServiceIncidentOperationsSnapshot,
  ServiceIncidentSeverity,
  ServiceIncidentStatus,
  ServiceIncidentUserAction,
} from '../../../core/operations/service-status.models';
import {
  emptyServiceIncidentDraft,
  serviceIncidentComponentLabel,
  serviceIncidentDataStateLabel,
  serviceIncidentResponseTarget,
  serviceIncidentSeverityLabel,
  serviceIncidentStatusLabel,
  serviceIncidentUserActionLabel,
} from '../../../core/operations/service-status.util';
import { AdminSessionStepUp } from '../../../shared/admin-session-step-up/admin-session-step-up';

@Component({
  selector: 'app-service-incidents',
  standalone: true,
  imports: [FormsModule, RouterLink, AdminSessionStepUp],
  templateUrl: './service-incidents.html',
  styleUrl: './service-incidents.css',
})
export class ServiceIncidents {
  readonly loading = signal(true);
  readonly refreshing = signal(false);
  readonly saving = signal(false);
  readonly snapshot = signal<ServiceIncidentOperationsSnapshot | null>(null);
  readonly errorMessage = signal('');
  readonly successMessage = signal('');
  readonly editingIncidentId = signal('');
  readonly activeIncidents = computed(() =>
    (this.snapshot()?.incidents ?? []).filter((incident) => incident.status !== 'resolved'),
  );
  readonly activeP0Count = computed(() =>
    this.activeIncidents().filter((incident) => incident.severity === 'p0').length,
  );
  readonly resolvedIncidents = computed(() =>
    (this.snapshot()?.incidents ?? []).filter((incident) => incident.status === 'resolved'),
  );

  draft: ServiceIncidentDraft = emptyServiceIncidentDraft();
  nextUpdateLocal = '';
  publicUpdate = '';
  internalNote = '';
  auditReason = '';

  readonly severityOptions: Array<{ value: ServiceIncidentSeverity; label: string }> = [
    { value: 'p0', label: 'P0 · Competition integrity' },
    { value: 'p1', label: 'P1 · Blocked action' },
    { value: 'p2', label: 'P2 · Serious degradation' },
    { value: 'p3', label: 'P3 · Advisory' },
  ];
  readonly statusOptions: Array<{ value: ServiceIncidentStatus; label: string }> = [
    { value: 'investigating', label: 'Investigating' },
    { value: 'identified', label: 'Cause identified' },
    { value: 'monitoring', label: 'Monitoring recovery' },
    { value: 'resolved', label: 'Resolved' },
  ];
  readonly impactOptions: Array<{
    value: ServiceIncidentCompetitiveImpact;
    label: string;
  }> = [
    { value: 'unknown', label: 'Impact unknown' },
    { value: 'none', label: 'No competitive impact' },
    { value: 'possible', label: 'Competitive impact possible' },
    { value: 'confirmed', label: 'Competitive impact confirmed' },
  ];
  readonly dataStateOptions: Array<{ value: ServiceIncidentDataState; label: string }> = [
    { value: 'live', label: 'Live authoritative data' },
    { value: 'delayed', label: 'Live data delayed' },
    { value: 'stale-read-only', label: 'Saved or stale read-only presentation' },
    { value: 'unavailable', label: 'Live data unavailable' },
  ];
  readonly actionOptions: Array<{ value: ServiceIncidentUserAction; label: string }> = [
    { value: 'continue', label: 'Continue using RinkRat normally' },
    { value: 'avoid-draft', label: 'Do not start or continue a Draft' },
    { value: 'avoid-roster-actions', label: 'Pause roster actions' },
    { value: 'avoid-waivers', label: 'Pause waiver actions' },
    { value: 'read-only', label: 'Use RinkRat as read-only' },
    { value: 'sign-out-retry', label: 'Sign out, then retry after reconnecting' },
    { value: 'other', label: 'Follow custom incident guidance' },
  ];
  readonly componentOptions: Array<{ value: ServiceIncidentComponent; label: string }> = [
    'accounts',
    'draft',
    'game-center',
    'scoring',
    'rosters',
    'waivers',
    'projections-data',
    'pwa',
    'support',
    'other',
  ].map((value) => ({ value: value as ServiceIncidentComponent, label: serviceIncidentComponentLabel(value as ServiceIncidentComponent) }));

  constructor(
    private readonly incidentService: ServiceIncidentService,
    private readonly publicStatusService: ServiceStatusService,
  ) {
    void this.load();
  }

  async load(refresh = false): Promise<void> {
    refresh ? this.refreshing.set(true) : this.loading.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');

    try {
      this.snapshot.set(await this.incidentService.load());
      if (refresh) {
        this.successMessage.set('Incident operations refreshed.');
      }
    } catch (error: unknown) {
      this.errorMessage.set(this.friendlyError(error, 'Unable to load service incidents.'));
    } finally {
      this.loading.set(false);
      this.refreshing.set(false);
    }
  }

  startNewIncident(): void {
    this.editingIncidentId.set('');
    this.draft = emptyServiceIncidentDraft();
    this.nextUpdateLocal = '';
    this.publicUpdate = '';
    this.internalNote = '';
    this.auditReason = '';
    this.errorMessage.set('');
    this.successMessage.set('');
  }

  editIncident(incident: ServiceIncidentAdminRecord): void {
    this.editingIncidentId.set(incident.incidentId);
    this.draft = {
      severity: incident.severity,
      status: incident.status,
      affectedComponents: [...incident.affectedComponents],
      competitiveImpact: incident.competitiveImpact,
      dataState: incident.dataState,
      dataMessage: incident.dataMessage,
      userAction: incident.userAction,
      publicTitle: incident.publicTitle,
      publicSummary: incident.publicSummary,
      publicGuidance: incident.publicGuidance,
      internalTitle: incident.internalTitle,
      internalNotes: incident.internalNotes,
      nextUpdateAt: incident.nextUpdateAt,
      publicResolution: incident.publicResolution,
      postmortemRequired: incident.postmortemRequired,
    };
    this.nextUpdateLocal = this.toLocalDateTime(incident.nextUpdateAt);
    this.publicUpdate = '';
    this.internalNote = '';
    this.auditReason = '';
    this.errorMessage.set('');
    this.successMessage.set('');
  }

  toggleComponent(component: ServiceIncidentComponent, checked: boolean): void {
    const next = new Set(this.draft.affectedComponents);
    checked ? next.add(component) : next.delete(component);
    this.draft.affectedComponents = [...next];
  }

  componentChecked(component: ServiceIncidentComponent): boolean {
    return this.draft.affectedComponents.includes(component);
  }

  responseTarget(): string {
    return serviceIncidentResponseTarget(this.draft.severity);
  }

  ensurePostmortemForSeverity(): void {
    if (this.draft.severity === 'p0') {
      this.draft.postmortemRequired = true;
    }
  }

  selectedIncident(): ServiceIncidentAdminRecord | null {
    const incidentId = this.editingIncidentId();
    return this.snapshot()?.incidents.find((incident) => incident.incidentId === incidentId) ?? null;
  }

  async save(): Promise<void> {
    if (this.saving()) {
      return;
    }

    this.saving.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');

    const incident: ServiceIncidentDraft = {
      ...this.draft,
      affectedComponents: [...this.draft.affectedComponents],
      nextUpdateAt: this.draft.status === 'resolved'
        ? null
        : this.fromLocalDateTime(this.nextUpdateLocal),
      postmortemRequired: this.draft.severity === 'p0' || this.draft.postmortemRequired,
    };

    try {
      const selected = this.selectedIncident();
      const result = selected
        ? await this.incidentService.update({
            incidentId: selected.incidentId,
            expectedRevision: selected.revision,
            incident,
            publicUpdate: this.publicUpdate,
            internalNote: this.internalNote,
            reason: this.auditReason,
          })
        : await this.incidentService.create({
            incident,
            publicUpdate: this.publicUpdate,
            internalNote: this.internalNote,
            reason: this.auditReason,
          });

      this.snapshot.set(result);
      this.startNewIncident();
      this.successMessage.set(selected ? 'Incident update was published and audited.' : 'Incident was created and published.');
      void this.publicStatusService.load(true);
    } catch (error: unknown) {
      this.errorMessage.set(this.friendlyError(error, 'Unable to save the service incident.'));
    } finally {
      this.saving.set(false);
    }
  }

  severityLabel(value: ServiceIncidentSeverity): string {
    return serviceIncidentSeverityLabel(value);
  }

  statusLabel(value: ServiceIncidentStatus): string {
    return serviceIncidentStatusLabel(value);
  }

  dataStateLabel(value: ServiceIncidentDataState): string {
    return serviceIncidentDataStateLabel(value);
  }

  actionLabel(value: ServiceIncidentUserAction): string {
    return serviceIncidentUserActionLabel(value);
  }

  formatDateTime(value: string | null): string {
    if (!value) {
      return 'Not scheduled';
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? 'Not scheduled'
      : new Intl.DateTimeFormat('en-US', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        }).format(date);
  }

  private toLocalDateTime(value: string | null): string {
    if (!value) {
      return '';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
  }

  private fromLocalDateTime(value: string): string | null {
    if (!value) {
      return null;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  private friendlyError(error: unknown, fallback: string): string {
    if (!(error instanceof Error)) {
      return fallback;
    }
    return error.message || fallback;
  }
}
