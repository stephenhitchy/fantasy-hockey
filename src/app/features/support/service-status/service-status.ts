import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import type {
  PublicServiceIncident,
  ServiceIncidentComponent,
  ServiceIncidentDataState,
  ServiceIncidentSeverity,
  ServiceIncidentStatus,
  ServiceIncidentUserAction,
} from '../../../core/operations/service-status.models';
import { ServiceStatusService } from '../../../core/operations/service-status.service';
import {
  serviceIncidentComponentLabel,
  serviceIncidentCompetitiveImpactLabel,
  serviceIncidentDataStateLabel,
  serviceIncidentSeverityLabel,
  serviceIncidentStatusLabel,
  serviceIncidentUserActionLabel,
  serviceStatusLabel,
} from '../../../core/operations/service-status.util';

@Component({
  selector: 'app-service-status',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './service-status.html',
  styleUrl: './service-status.css',
})
export class ServiceStatusPage {
  private readonly statusService = inject(ServiceStatusService);

  readonly state = this.statusService.state;
  readonly loading = this.statusService.loading;
  readonly errorMessage = this.statusService.errorMessage;
  readonly snapshot = computed(() => this.state().snapshot);

  constructor() {
    void this.statusService.load(true);
  }

  refresh(): void {
    void this.statusService.load(true);
  }

  overallStatusLabel(): string {
    return serviceStatusLabel(this.snapshot()?.overallStatus ?? 'operational');
  }

  severityLabel(value: ServiceIncidentSeverity): string {
    return serviceIncidentSeverityLabel(value);
  }

  statusLabel(value: ServiceIncidentStatus): string {
    return serviceIncidentStatusLabel(value);
  }

  componentLabel(value: ServiceIncidentComponent): string {
    return serviceIncidentComponentLabel(value);
  }

  impactLabel(value: PublicServiceIncident['competitiveImpact']): string {
    return serviceIncidentCompetitiveImpactLabel(value);
  }

  dataStateLabel(value: ServiceIncidentDataState): string {
    return serviceIncidentDataStateLabel(value);
  }

  actionLabel(value: ServiceIncidentUserAction): string {
    return serviceIncidentUserActionLabel(value);
  }

  latestUpdate(incident: PublicServiceIncident): string {
    return incident.publicUpdates[0]?.message || incident.summary;
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
}
