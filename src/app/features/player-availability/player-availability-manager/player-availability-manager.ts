import { Component, computed, signal } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { onAuthStateChanged, User } from 'firebase/auth';

import { auth } from '../../../core/firebase';

import { getLeagueById, League } from '../../../core/league/league.service';

import {
  clearCurrentNhlDraftSkaterCache,
  getCurrentNhlDraftSkaters,
} from '../../../core/nhl/nhl-api.service';

import { NHLPlayer } from '../../../core/player/player.models';

import {
  PlayerAvailability,
  PlayerAvailabilityDatabaseRecord,
  PlayerAvailabilityStatus,
  PlayerAvailabilitySyncResult,
  PlayerAvailabilitySyncState,
} from '../../../core/player/player-availability.models';

import {
  getPlayerAvailabilitySyncState,
  syncPlayerAvailabilityFromEspn,
} from '../../../core/player/player-availability-sync.service';

import {
  deletePlayerAvailabilityRecord,
  getPlayerAvailabilityDatabaseRecord,
  getPlayerAvailabilityForPlayer,
  getPlayerAvailabilityStatusClass,
  getPlayerAvailabilityStatusLabel,
  isPlayerAvailabilityManualRecord,
  isPlayerAvailabilitySyncedRecord,
  isPlayerIrEligible,
  playerAvailabilityDatabaseRecords,
  savePlayerAvailabilityRecord,
  startPlayerAvailabilityListenerForLeague,
} from '../../../core/player/player-availability.service';

interface AvailabilityStatusOption {
  value: PlayerAvailabilityStatus;
  label: string;
  description: string;
}

function waitForAuthUser(): Promise<User | null> {
  if (auth.currentUser) {
    return Promise.resolve(auth.currentUser);
  }

  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

@Component({
  selector: 'app-player-availability-manager',
  imports: [FormsModule, RouterLink],
  templateUrl: './player-availability-manager.html',
  styleUrl: './player-availability-manager.css',
})
export class PlayerAvailabilityManager {
  leagueId = '';
  userId = '';

  league = signal<League | null>(null);
  players = signal<NHLPlayer[]>([]);

  loading = signal(true);
  playerPoolLoading = signal(false);
  saving = signal(false);
  syncing = signal(false);
  errorMessage = signal('');
  successMessage = signal('');
  syncErrorMessage = signal('');
  syncMessage = signal('');
  searchTerm = signal('');
  selectedPlayerId = signal<number | null>(null);
  syncState = signal<PlayerAvailabilitySyncState | null>(null);
  lastSyncResult = signal<PlayerAvailabilitySyncResult | null>(null);

  selectedStatus = signal<PlayerAvailabilityStatus>('active');
  selectedNote = signal('');

  readonly statusOptions: AvailabilityStatusOption[] = [
    {
      value: 'active',
      label: 'Active',
      description: 'Healthy and not eligible for IR.',
    },
    {
      value: 'day-to-day',
      label: 'Day-to-Day',
      description: 'Injured, but not eligible for IR under this league policy.',
    },
    {
      value: 'out',
      label: 'Out',
      description: 'Unavailable and eligible for IR.',
    },
    {
      value: 'injured-reserve',
      label: 'Injured Reserve',
      description: 'Official IR designation and eligible for IR.',
    },
    {
      value: 'long-term-injured-reserve',
      label: 'Long-Term IR',
      description: 'Official LTIR designation and eligible for IR.',
    },
    {
      value: 'suspended',
      label: 'Suspended',
      description: 'Unavailable, but not eligible for IR.',
    },
    {
      value: 'personal-leave',
      label: 'Personal Leave',
      description: 'Away from the team, but not eligible for IR.',
    },
    {
      value: 'unknown',
      label: 'Unknown',
      description: 'Status has not been verified and is not eligible for IR.',
    },
  ];

  readonly managedRecordCount = computed(() => playerAvailabilityDatabaseRecords().size);

  readonly syncedRecordCount = computed(
    () =>
      [...playerAvailabilityDatabaseRecords().values()].filter((record) => record.source === 'espn')
        .length,
  );

  readonly manualRecordCount = computed(
    () =>
      [...playerAvailabilityDatabaseRecords().values()].filter(
        (record) => record.source === 'commissioner',
      ).length,
  );

  readonly selectedPlayer = computed(() => {
    const selectedPlayerId = this.selectedPlayerId();

    if (selectedPlayerId === null) {
      return null;
    }

    return this.players().find((player) => player.id === selectedPlayerId) ?? null;
  });

  readonly selectedDatabaseRecord = computed(() => {
    const player = this.selectedPlayer();

    return player ? (playerAvailabilityDatabaseRecords().get(player.id) ?? null) : null;
  });

  readonly filteredPlayers = computed(() => {
    const search = this.searchTerm().trim().toLowerCase();

    return this.players()
      .filter((player) => {
        if (!search) {
          return true;
        }

        return [player.fullName, player.nhlTeamAbbreviation, player.position]
          .join(' ')
          .toLowerCase()
          .includes(search);
      })
      .sort((first, second) => {
        const firstRecord = playerAvailabilityDatabaseRecords().get(first.id);
        const secondRecord = playerAvailabilityDatabaseRecords().get(second.id);
        const firstPriority = this.getRecordSortPriority(firstRecord ?? null);
        const secondPriority = this.getRecordSortPriority(secondRecord ?? null);

        if (firstPriority !== secondPriority) {
          return secondPriority - firstPriority;
        }

        return first.fullName.localeCompare(second.fullName);
      })
      .slice(0, 150);
  });

  readonly selectedStatusIrEligible = computed(() => isPlayerIrEligible(this.selectedStatus()));

  constructor(
    private route: ActivatedRoute,
    private router: Router,
  ) {
    void this.loadPage();
  }

  async loadPage(): Promise<void> {
    const leagueId = this.route.snapshot.paramMap.get('leagueId');
    const user = await waitForAuthUser();

    if (!leagueId || !user) {
      await this.router.navigate(['/']);
      return;
    }

    this.leagueId = leagueId;
    this.userId = user.uid;

    try {
      const league = await getLeagueById(leagueId);

      if (!league) {
        this.errorMessage.set('League not found.');
        return;
      }

      if (league.commissionerId !== user.uid) {
        this.errorMessage.set('Only the league commissioner can manage player availability.');
        return;
      }

      this.league.set(league);
      startPlayerAvailabilityListenerForLeague(leagueId);
      await this.loadPlayers();
      await this.refreshSyncState();
      void this.syncEspnInjuries(false);
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to load the player availability manager.',
      );
    } finally {
      this.loading.set(false);
    }
  }

  async loadPlayers(forceRefresh: boolean = false): Promise<void> {
    this.playerPoolLoading.set(true);

    if (forceRefresh) {
      clearCurrentNhlDraftSkaterCache();
    }

    try {
      const players = await getCurrentNhlDraftSkaters();

      this.players.set(
        players.filter(
          (player, index, allPlayers) =>
            allPlayers.findIndex((candidate) => candidate.id === player.id) === index,
        ),
      );
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to load the NHL player pool.',
      );
    } finally {
      this.playerPoolLoading.set(false);
    }
  }

  async refreshSyncState(): Promise<void> {
    if (!this.leagueId) {
      return;
    }

    try {
      this.syncState.set(await getPlayerAvailabilitySyncState(this.leagueId));
    } catch (error: unknown) {
      this.syncErrorMessage.set(
        error instanceof Error ? error.message : 'Unable to load the latest injury-sync status.',
      );
    }
  }

  async syncEspnInjuries(force: boolean): Promise<void> {
    if (this.syncing() || this.playerPoolLoading() || this.players().length === 0) {
      return;
    }

    this.syncing.set(true);
    this.syncErrorMessage.set('');

    if (force) {
      this.syncMessage.set('');
      this.successMessage.set('');
    }

    try {
      const result = await syncPlayerAvailabilityFromEspn({
        leagueId: this.leagueId,
        players: this.players(),
        trigger: 'commissioner-browser',
      });

      this.lastSyncResult.set(result);
      this.syncMessage.set(result.message);
      await this.refreshSyncState();
    } catch (error: unknown) {
      this.syncErrorMessage.set(
        error instanceof Error ? error.message : 'Unable to sync ESPN NHL injury data.',
      );
      await this.refreshSyncState();
    } finally {
      this.syncing.set(false);
    }
  }

  setSearchTerm(value: string): void {
    this.searchTerm.set(value);
  }

  selectPlayer(player: NHLPlayer): void {
    this.errorMessage.set('');
    this.successMessage.set('');
    this.selectedPlayerId.set(player.id);

    const databaseRecord = getPlayerAvailabilityDatabaseRecord(player.id);
    const availability = getPlayerAvailabilityForPlayer(player);

    this.selectedStatus.set(databaseRecord?.status ?? availability.status);
    this.selectedNote.set(databaseRecord?.note ?? availability.note);
  }

  isPlayerSelected(player: NHLPlayer): boolean {
    return this.selectedPlayerId() === player.id;
  }

  isPlayerManaged(player: NHLPlayer): boolean {
    return playerAvailabilityDatabaseRecords().has(player.id);
  }

  isPlayerManualOverride(player: NHLPlayer): boolean {
    return isPlayerAvailabilityManualRecord(
      playerAvailabilityDatabaseRecords().get(player.id) ?? null,
    );
  }

  isPlayerSynced(player: NHLPlayer): boolean {
    return isPlayerAvailabilitySyncedRecord(
      playerAvailabilityDatabaseRecords().get(player.id) ?? null,
    );
  }

  getPlayerDatabaseRecord(player: NHLPlayer): PlayerAvailabilityDatabaseRecord | null {
    return playerAvailabilityDatabaseRecords().get(player.id) ?? null;
  }

  getPlayerRecordSourceLabel(player: NHLPlayer): string {
    const record = this.getPlayerDatabaseRecord(player);

    if (record?.source === 'commissioner') {
      return 'Manual';
    }

    if (record?.source === 'espn') {
      return 'ESPN';
    }

    return 'Fallback';
  }

  getPlayerRecordSourceClass(player: NHLPlayer): string {
    const record = this.getPlayerDatabaseRecord(player);

    if (record?.source === 'commissioner') {
      return 'source-manual';
    }

    if (record?.source === 'espn') {
      return 'source-synced';
    }

    return 'source-fallback';
  }

  getSelectedRecordSourceLabel(): string {
    const record = this.selectedDatabaseRecord();

    if (record?.source === 'commissioner') {
      return 'Commissioner override';
    }

    if (record?.source === 'espn') {
      return 'Automatic ESPN sync';
    }

    return 'Code fallback';
  }

  getSelectedExternalStatus(): string {
    return this.selectedDatabaseRecord()?.externalStatus ?? '';
  }

  getSelectedReturnDate(): string {
    return this.selectedDatabaseRecord()?.externalReturnDate ?? '';
  }

  getPlayerAvailability(player: NHLPlayer): PlayerAvailability {
    return getPlayerAvailabilityForPlayer(player);
  }

  getPlayerStatusClass(player: NHLPlayer): string {
    return getPlayerAvailabilityStatusClass(this.getPlayerAvailability(player).status);
  }

  getPlayerStatusLabel(player: NHLPlayer): string {
    return this.getPlayerAvailability(player).label;
  }

  getSelectedStatusClass(): string {
    return getPlayerAvailabilityStatusClass(this.selectedStatus());
  }

  getSelectedStatusLabel(): string {
    return getPlayerAvailabilityStatusLabel(this.selectedStatus());
  }

  getSelectedStatusDescription(): string {
    return (
      this.statusOptions.find((option) => option.value === this.selectedStatus())?.description ?? ''
    );
  }

  getPlayerLogoUrl(player: NHLPlayer): string | undefined {
    return player.teamLogoUrl;
  }

  getPlayerUpdatedLabel(player: NHLPlayer): string {
    const updatedAt = this.getPlayerAvailability(player).updatedAt;

    if (!updatedAt) {
      return 'No review date';
    }

    const date = new Date(updatedAt);

    if (Number.isNaN(date.getTime())) {
      return updatedAt;
    }

    return date.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }

  getLastSyncLabel(): string {
    const lastSuccessfulSyncAt = this.syncState()?.lastSuccessfulSyncAt;

    if (!lastSuccessfulSyncAt) {
      return 'Not synced yet';
    }

    const date = new Date(lastSuccessfulSyncAt);

    if (Number.isNaN(date.getTime())) {
      return lastSuccessfulSyncAt;
    }

    return date.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }

  async saveSelectedPlayer(): Promise<void> {
    const player = this.selectedPlayer();

    this.errorMessage.set('');
    this.successMessage.set('');

    if (!player) {
      this.errorMessage.set('Choose a player before saving.');
      return;
    }

    this.saving.set(true);

    try {
      await savePlayerAvailabilityRecord({
        leagueId: this.leagueId,
        player,
        status: this.selectedStatus(),
        note: this.selectedNote(),
      });

      this.successMessage.set(
        `${player.fullName} now has a commissioner override of ${getPlayerAvailabilityStatusLabel(this.selectedStatus())}. The shared daily report will preserve this choice.`,
      );
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to save this player status.',
      );
    } finally {
      this.saving.set(false);
    }
  }

  async clearSelectedDatabaseRecord(): Promise<void> {
    const player = this.selectedPlayer();
    const currentRecord = this.selectedDatabaseRecord();

    this.errorMessage.set('');
    this.successMessage.set('');

    if (!player) {
      this.errorMessage.set('Choose a player before clearing a record.');
      return;
    }

    if (!currentRecord) {
      this.errorMessage.set('This player does not currently have a Firestore availability record.');
      return;
    }

    if (currentRecord.source === 'espn') {
      this.errorMessage.set(
        'The ESPN report is shared across the entire app and cannot be deleted from one league. Save a commissioner override instead.',
      );
      return;
    }

    this.saving.set(true);

    try {
      await deletePlayerAvailabilityRecord({
        leagueId: this.leagueId,
        playerId: player.id,
      });

      const fallbackAvailability = getPlayerAvailabilityForPlayer(player);

      this.selectedStatus.set(fallbackAvailability.status);
      this.selectedNote.set(fallbackAvailability.note);
      this.successMessage.set(
        `${player.fullName}'s commissioner override was removed. The shared ESPN report now applies again.`,
      );
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to clear this player status.',
      );
    } finally {
      this.saving.set(false);
    }
  }

  private getRecordSortPriority(record: PlayerAvailabilityDatabaseRecord | null): number {
    if (record?.source === 'commissioner') {
      return 2;
    }

    if (record?.source === 'espn') {
      return 1;
    }

    return 0;
  }
}
