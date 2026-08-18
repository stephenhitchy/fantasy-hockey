import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { onAuthStateChanged, type User } from 'firebase/auth';

import { auth } from '../../../core/firebase';
import {
  getOwnerTransactionsOnce,
  type FantasyTransaction,
} from '../../../core/draft/draft.service';
import {
  buildLeaguePlayerBoardRows,
  type LeaguePlayerBoardRow,
} from '../../../core/player/league-player-board.util';
import {
  loadLeaguePlayerBoardBaseData,
  loadLeagueWaiverAssetKeysOnce,
} from '../../../core/player/league-player-board.service';
import {
  buildManagerDecisionHistoryRows,
  type ManagerDecisionCurrentPlayer,
  type ManagerDecisionHistoryAsset,
  type ManagerDecisionHistoryRow,
} from '../../../core/transactions/manager-decision-history.util';

const DECISION_HISTORY_PAGE_SIZE = 20;

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
  selector: 'app-decision-history',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './decision-history.html',
  styleUrl: './decision-history.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DecisionHistory {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly leagueId = this.route.snapshot.paramMap.get('leagueId') ?? '';
  readonly leagueName = signal('RinkRat League');
  readonly loading = signal(true);
  readonly refreshing = signal(false);
  readonly errorMessage = signal('');
  readonly transactions = signal<FantasyTransaction[]>([]);
  readonly playerRows = signal<LeaguePlayerBoardRow[]>([]);
  readonly searchTerm = signal('');
  readonly visibleLimit = signal(DECISION_HISTORY_PAGE_SIZE);

  readonly historyRows = computed(() =>
    buildManagerDecisionHistoryRows(this.transactions(), this.playerRows()),
  );

  readonly filteredRows = computed(() => {
    const search = this.searchTerm().trim().toLocaleLowerCase();
    if (!search) {
      return this.historyRows();
    }

    return this.historyRows().filter((row) => [
      row.label,
      row.added.name,
      row.added.teamAbbreviation,
      row.dropped?.name ?? '',
      row.dropped?.teamAbbreviation ?? '',
      row.effectiveLabel ?? '',
      row.effectiveCycleNumber ? `matchup ${row.effectiveCycleNumber}` : '',
    ].join(' ').toLocaleLowerCase().includes(search));
  });

  readonly visibleRows = computed(() =>
    this.filteredRows().slice(0, this.visibleLimit()),
  );

  readonly hiddenCount = computed(() =>
    Math.max(0, this.filteredRows().length - this.visibleRows().length),
  );

  constructor() {
    void this.load();
  }

  updateSearch(value: string): void {
    this.searchTerm.set(value);
    this.visibleLimit.set(DECISION_HISTORY_PAGE_SIZE);
  }

  showMore(): void {
    this.visibleLimit.update((value) => value + DECISION_HISTORY_PAGE_SIZE);
  }

  async refresh(): Promise<void> {
    if (this.refreshing()) {
      return;
    }

    this.refreshing.set(true);
    try {
      await this.load(true);
    } finally {
      this.refreshing.set(false);
    }
  }

  getDecisionDate(row: ManagerDecisionHistoryRow): string {
    if (!row.occurredAt) {
      return 'Date unavailable';
    }

    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      year: row.occurredAt.getFullYear() === new Date().getFullYear()
        ? undefined
        : 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(row.occurredAt);
  }

  getEffectiveLabel(row: ManagerDecisionHistoryRow): string {
    if (row.effectiveCycleNumber) {
      return `Matchup ${row.effectiveCycleNumber}`;
    }

    return row.effectiveLabel || 'Timing unavailable';
  }

  getStatusLabel(asset: ManagerDecisionHistoryAsset): string {
    const current = asset.current;
    if (!current) {
      return 'Not in current player snapshot';
    }

    if (current.ownership) {
      const area = current.ownership.area === 'active'
        ? 'Active'
        : current.ownership.area === 'bench'
          ? 'Bench'
          : 'IR';
      return `${area} · ${current.ownership.teamName}`;
    }

    if (current.status === 'waivers') {
      return 'On waivers';
    }
    if (current.status === 'reserved') {
      return 'Unavailable';
    }

    return 'Free agent';
  }

  getImageUrl(asset: ManagerDecisionHistoryAsset): string | null {
    return asset.current?.headshotUrl || asset.current?.logoUrl || null;
  }

  formatPoints(value: number | null | undefined): string {
    return typeof value === 'number' && Number.isFinite(value)
      ? value.toFixed(1).replace(/\.0$/, '')
      : '—';
  }

  formatRank(row: ManagerDecisionCurrentPlayer | null): string {
    return row?.positionRank ? `#${row.positionRank}` : '—';
  }

  formatDifference(value: number | null): string {
    if (value === null) {
      return '—';
    }

    const rounded = Math.round(value * 10) / 10;
    return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1).replace(/\.0$/, '')}`;
  }

  differenceClass(value: number | null): string {
    if (value === null || Math.abs(value) < 0.05) {
      return 'decision-delta-neutral';
    }
    return value > 0 ? 'decision-delta-positive' : 'decision-delta-negative';
  }

  private async load(forceRefresh = false): Promise<void> {
    const user = await waitForAuthUser();
    if (!user || !this.leagueId) {
      await this.router.navigate(['/']);
      return;
    }

    if (!forceRefresh) {
      this.loading.set(true);
    }
    this.errorMessage.set('');

    try {
      const [baseData, waiverAssetKeys, transactions] = await Promise.all([
        loadLeaguePlayerBoardBaseData(this.leagueId, { forceRefresh }),
        loadLeagueWaiverAssetKeysOnce(this.leagueId),
        getOwnerTransactionsOnce(this.leagueId, user.uid, 75),
      ]);

      this.leagueName.set(baseData.league.name || 'RinkRat League');
      this.playerRows.set(buildLeaguePlayerBoardRows({
        assets: baseData.assets,
        ownershipByAssetKey: baseData.ownershipByAssetKey,
        waiverAssetKeys,
        reservedAssetKeys: baseData.reservedAssetKeys,
      }));
      this.transactions.set(transactions);
    } catch (error) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Decision history could not be loaded right now.',
      );
    } finally {
      this.loading.set(false);
    }
  }
}
