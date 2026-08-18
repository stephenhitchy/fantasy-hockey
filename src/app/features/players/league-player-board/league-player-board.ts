import {
  ChangeDetectionStrategy,
  Component,
  computed,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { onAuthStateChanged, type User } from 'firebase/auth';

import { auth } from '../../../core/firebase';
import {
  buildLeaguePlayerBoardRows,
  filterLeaguePlayerBoardRows,
  type LeaguePlayerBoardPositionFilter,
  type LeaguePlayerBoardRow,
  type LeaguePlayerBoardSortMode,
  type LeaguePlayerBoardStatusFilter,
} from '../../../core/player/league-player-board.util';
import {
  loadLeaguePlayerBoardBaseData,
  loadLeagueWaiverAssetKeysOnce,
  type LeaguePlayerBoardBaseData,
} from '../../../core/player/league-player-board.service';
import {
  getPlayerWatchlist,
  setPlayerWatchlistEntry,
} from '../../../core/player/player-watchlist.service';

const PAGE_SIZE = 50;

function waitForAuthUser(): Promise<User | null> {
  if (auth.currentUser) {
    return Promise.resolve(auth.currentUser);
  }

  return new Promise((resolve) => {
    const stop = onAuthStateChanged(auth, (user) => {
      stop();
      resolve(user);
    });
  });
}

@Component({
  selector: 'app-league-player-board',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './league-player-board.html',
  styleUrl: './league-player-board.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LeaguePlayerBoard {
  readonly leagueId = signal('');
  readonly baseData = signal<LeaguePlayerBoardBaseData | null>(null);
  readonly waiverAssetKeys = signal<ReadonlySet<string>>(new Set());
  readonly watchedAssetKeys = signal<ReadonlySet<string>>(new Set());
  readonly loading = signal(true);
  readonly refreshing = signal(false);
  readonly errorMessage = signal('');
  readonly watchErrorMessage = signal('');
  readonly watchSavingAssetKey = signal('');

  readonly searchTerm = signal('');
  readonly positionFilter = signal<LeaguePlayerBoardPositionFilter>('all');
  readonly statusFilter = signal<LeaguePlayerBoardStatusFilter>('all');
  readonly sortMode = signal<LeaguePlayerBoardSortMode>('season-points');
  readonly visibleLimit = signal(PAGE_SIZE);

  readonly league = computed(() => this.baseData()?.league ?? null);
  readonly snapshotMetadata = computed(() => this.baseData()?.snapshotMetadata ?? null);

  readonly allRows = computed<LeaguePlayerBoardRow[]>(() => {
    const baseData = this.baseData();
    if (!baseData) {
      return [];
    }

    return buildLeaguePlayerBoardRows({
      assets: baseData.assets,
      ownershipByAssetKey: baseData.ownershipByAssetKey,
      reservedAssetKeys: baseData.reservedAssetKeys,
      waiverAssetKeys: this.waiverAssetKeys(),
      watchedAssetKeys: this.watchedAssetKeys(),
    });
  });

  readonly filteredRows = computed(() => filterLeaguePlayerBoardRows(this.allRows(), {
    searchTerm: this.searchTerm(),
    position: this.positionFilter(),
    status: this.statusFilter(),
    sortMode: this.sortMode(),
  }));

  readonly visibleRows = computed(() => this.filteredRows().slice(0, this.visibleLimit()));
  readonly hiddenRowCount = computed(() =>
    Math.max(0, this.filteredRows().length - this.visibleRows().length),
  );
  readonly rosteredCount = computed(() =>
    this.allRows().filter((row) => row.status === 'rostered').length,
  );
  readonly availableCount = computed(() =>
    this.allRows().filter((row) => row.status === 'free-agent' || row.status === 'waivers').length,
  );
  readonly reservedCount = computed(() =>
    this.allRows().filter((row) => row.status === 'reserved').length,
  );
  readonly watchedCount = computed(() =>
    this.allRows().filter((row) => row.watched).length,
  );

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
  ) {
    void this.initialize();
  }

  updateSearch(value: string): void {
    this.searchTerm.set(value);
    this.resetVisibleLimit();
  }

  updatePosition(value: string): void {
    const allowed = new Set<LeaguePlayerBoardPositionFilter>(['all', 'LW', 'C', 'RW', 'D', 'G']);
    this.positionFilter.set(allowed.has(value as LeaguePlayerBoardPositionFilter)
      ? value as LeaguePlayerBoardPositionFilter
      : 'all');
    this.resetVisibleLimit();
  }

  updateStatus(value: string): void {
    const allowed = new Set<LeaguePlayerBoardStatusFilter>([
      'all',
      'available',
      'rostered',
      'waivers',
      'reserved',
      'watched',
    ]);
    this.statusFilter.set(allowed.has(value as LeaguePlayerBoardStatusFilter)
      ? value as LeaguePlayerBoardStatusFilter
      : 'all');
    this.resetVisibleLimit();
  }

  updateSort(value: string): void {
    const allowed = new Set<LeaguePlayerBoardSortMode>([
      'season-points',
      'next-six',
      'overall-rank',
      'position-rank',
      'rest-of-season',
      'reliability',
      'name',
    ]);
    this.sortMode.set(allowed.has(value as LeaguePlayerBoardSortMode)
      ? value as LeaguePlayerBoardSortMode
      : 'season-points');
    this.resetVisibleLimit();
  }

  showMore(): void {
    this.visibleLimit.update((current) => current + PAGE_SIZE);
  }

  async refresh(): Promise<void> {
    if (this.refreshing()) {
      return;
    }

    this.refreshing.set(true);
    try {
      await this.loadData(true);
    } finally {
      this.refreshing.set(false);
    }
  }

  async toggleWatch(row: LeaguePlayerBoardRow): Promise<void> {
    if (this.watchSavingAssetKey()) {
      return;
    }

    this.watchSavingAssetKey.set(row.assetKey);
    this.watchErrorMessage.set('');

    try {
      const result = await setPlayerWatchlistEntry({
        assetKey: row.assetKey,
        watched: !row.watched,
      });
      this.watchedAssetKeys.set(new Set(result.assetKeys));
    } catch (error) {
      this.watchErrorMessage.set(
        error instanceof Error ? error.message : 'Unable to update your watchlist.',
      );
    } finally {
      this.watchSavingAssetKey.set('');
    }
  }

  formatPoints(value: number | null, digits = 1): string {
    return value === null ? '—' : value.toFixed(digits).replace(/\.0+$/, '');
  }

  formatRank(rank: number | null, total: number): string {
    return rank === null || total <= 0 ? '—' : `#${rank} of ${total}`;
  }

  getStatusLabel(row: LeaguePlayerBoardRow): string {
    if (row.ownership) {
      const area = row.ownership.area === 'active'
        ? 'Active'
        : row.ownership.area === 'bench'
          ? 'Bench'
          : 'IR';
      return `${area} · ${row.ownership.teamName}`;
    }

    switch (row.status) {
      case 'waivers':
        return 'On waivers';
      case 'reserved':
        return 'Unavailable';
      default:
        return 'Free agent';
    }
  }

  getImageUrl(row: LeaguePlayerBoardRow): string | null {
    return row.headshotUrl ?? row.logoUrl;
  }

  getSnapshotLabel(): string {
    const metadata = this.snapshotMetadata();
    if (!metadata) {
      return 'Projection V11';
    }

    return `Matchup ${metadata.targetCycleNumber} · Projection V${metadata.projectionVersion}`;
  }

  private async initialize(): Promise<void> {
    const leagueId = this.route.snapshot.paramMap.get('leagueId')?.trim() ?? '';
    const user = await waitForAuthUser();

    if (!leagueId || !user) {
      await this.router.navigate(['/']);
      return;
    }

    this.leagueId.set(leagueId);
    await this.loadData();
    this.loading.set(false);
  }

  private async loadData(forceRefresh = false): Promise<void> {
    this.errorMessage.set('');

    try {
      const [baseData, watchlistResult, waiverAssetKeys] = await Promise.all([
        loadLeaguePlayerBoardBaseData(this.leagueId(), { forceRefresh }),
        getPlayerWatchlist().catch(() => ({
          assetKeys: [],
          maximumCount: 100,
          changed: false,
        })),
        loadLeagueWaiverAssetKeysOnce(this.leagueId()),
      ]);

      this.baseData.set(baseData);
      this.watchedAssetKeys.set(new Set(watchlistResult.assetKeys));
      this.waiverAssetKeys.set(waiverAssetKeys);
    } catch (error) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to load league players.',
      );
    }
  }

  private resetVisibleLimit(): void {
    this.visibleLimit.set(PAGE_SIZE);
  }
}
