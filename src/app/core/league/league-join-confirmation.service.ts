import { Injectable, signal } from '@angular/core';

export interface LeagueJoinConfirmation {
  leagueId: string;
}

@Injectable({ providedIn: 'root' })
export class LeagueJoinConfirmationService {
  private readonly confirmation = signal<LeagueJoinConfirmation | null>(null);

  readonly current = this.confirmation.asReadonly();

  confirm(leagueId: string): void {
    const normalizedLeagueId = leagueId.trim();

    if (!normalizedLeagueId) {
      return;
    }

    this.confirmation.set({ leagueId: normalizedLeagueId });
  }

  dismiss(): void {
    this.confirmation.set(null);
  }
}
