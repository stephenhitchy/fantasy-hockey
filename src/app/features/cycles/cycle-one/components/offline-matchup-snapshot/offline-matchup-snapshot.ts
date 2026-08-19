import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import {
  type OfflineMatchupPlayerSnapshot,
  type OfflineMatchupTeamSnapshot,
  type RinkRatOfflineMatchupSnapshot,
} from '../../../../../core/pwa/offline-matchup-snapshot.models';
import { getOfflineMatchupSnapshotAgeLabel } from '../../../../../core/pwa/offline-matchup-snapshot.util';

interface OfflineTeamPositionGroup {
  label: string;
  players: OfflineMatchupPlayerSnapshot[];
}

@Component({
  selector: 'app-offline-matchup-snapshot',
  standalone: true,
  templateUrl: './offline-matchup-snapshot.html',
  styleUrl: './offline-matchup-snapshot.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OfflineMatchupSnapshot {
  readonly snapshot = input.required<RinkRatOfflineMatchupSnapshot>();
  readonly browserOnline = input(false);
  readonly fallbackReason = input<'offline' | 'live-unavailable'>('offline');
  readonly reloadRequested = output<void>();

  readonly ageLabel = computed(() => getOfflineMatchupSnapshotAgeLabel(this.snapshot().savedAt));
  readonly teams = computed<OfflineMatchupTeamSnapshot[]>(() => {
    const snapshot = this.snapshot();
    return [snapshot.teamA, ...(snapshot.teamB ? [snapshot.teamB] : [])];
  });
  readonly statusLabel = computed(() =>
    this.snapshot().matchupStatus === 'complete' ? 'Final' : 'In progress',
  );

  fullSavedAtLabel(): string {
    const savedAt = new Date(this.snapshot().savedAt);

    return Number.isFinite(savedAt.getTime())
      ? savedAt.toLocaleString([], {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
      : 'Saved time unavailable';
  }

  points(value: number | null): string {
    if (value === null || !Number.isFinite(value)) {
      return '—';
    }

    return value.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
  }

  teamProgressPercent(team: OfflineMatchupTeamSnapshot): number {
    return team.gamesTotal > 0
      ? Math.min(100, Math.max(0, (team.gamesPlayed / team.gamesTotal) * 100))
      : 0;
  }

  groupsForTeam(teamIndex: number): OfflineTeamPositionGroup[] {
    return this.snapshot().positionGroups
      .map((group) => ({
        label: group.label,
        players: group.rows
          .map((row) => teamIndex === 0 ? row.teamAPlayer : row.teamBPlayer)
          .filter((player): player is OfflineMatchupPlayerSnapshot => Boolean(player)),
      }))
      .filter((group) => group.players.length > 0);
  }

  reloadLiveMatchup(): void {
    if (this.browserOnline()) {
      this.reloadRequested.emit();
    }
  }
}
